/** Authenticated organization-backend adapter; the backend owns model admission. */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { APP_IDENTITY, contentHasImage, LlmAdapter, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { authContextFrom, credentialStoreFrom, PiAiAdapter, resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-command-feedback'
import { installUploadSync, type UploadSyncConfig } from './upload-sync.ts'
import { installPersistentSession, type PersistentSessionTokens } from './persistent-session.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Active organization deployment; absent when this plugin is disabled. */
    managedBackend: {
      readonly endpoint: string
      authorizeProvider?: (provider: string) => () => void
      /** Resolve a valid access token, silently renewing persistent sessions. */
      accessToken?: () => Promise<string>
      /** Persist an interactive login's Host-only credentials. */
      storeSession?: (value: PersistentSessionTokens) => Promise<void>
      /** Remove local credentials and return the credential to revoke remotely. */
      clearSession?: () => Promise<string | undefined>
    }
  }
}

/** Deployment-owned endpoint and credential reference; neither is read from settings.yaml. */
export interface Config {
  /** HTTPS API root, or loopback HTTP for local development. */
  baseURL?: string
  /** Launch-environment variable naming the backend root. */
  baseURLEnv?: string
  /** Permit non-loopback HTTP for a temporary trusted-network deployment. */
  allowInsecureHTTP?: boolean
  /** Credential reference containing the backend-issued user token. */
  tokenEnv?: string
  /** Host-owned credential record used by interactive managed login. */
  tokenKey?: string
  /** Provider route registered in DSH; defaults to `managed`. */
  provider?: string
  /** Bound for one model catalog HTTP request, including response body; default 30000 ms. */
  catalogRequestTimeoutMs?: number
  /** Optional background sync of submitted chat files to the same backend. */
  uploadSync?: UploadSyncConfig
  /** Persistent-session renewal timing in milliseconds. */
  sessionTiming?: { renewBeforeMs: number; pollMs: number; requestTimeoutMs: number }
}

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  baseURLEnv: z.string(),
  allowInsecureHTTP: z.boolean().default(false),
  tokenEnv: z.string(),
  tokenKey: z.string(),
  provider: z.string().default('managed'),
  catalogRequestTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(30_000),
  sessionTiming: z.object({
    renewBeforeMs: z.number().step(1).min(1).max(2_147_483_647).default(300_000),
    pollMs: z.number().step(1).min(1).max(2_147_483_647).default(60_000),
    requestTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(10_000),
  }),
  uploadSync: z.object({ pollMs: z.number(), chunkBytes: z.number(), requestTimeoutMs: z.number() }),
})

interface BackendModel {
  multiplier?: string
  id: string
  name: string
  description?: string
  input?: ('text' | 'image')[]
  imageInput?: { state: 'supported' | 'unsupported' | 'unknown'; source: string; reason: string }
  /** Maximum combined request and response context the backend discloses for this model. */
  contextWindow?: number
  /** Maximum output tokens the backend discloses for this model. */
  maxOutputTokens?: number
}

interface BackendCatalog {
  models: BackendModel[]
  connection?: { api: string; baseURL: string; apiKey: string; expiresAt?: string }
}

function apiRoot(value: string, allowInsecureHTTP: boolean): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:'
      && !(url.protocol === 'http:' && (allowInsecureHTTP
        || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))) {
    throw new TypeError('managed backend baseURL must be HTTPS or loopback HTTP without credentials, query, or fragment')
  }
  return url.href.replace(/\/+$/u, '')
}

async function backendFailure(response: Response): Promise<LlmError> {
  const code = response.status === 401 ? 'AUTH'
    : response.status === 403 ? 'MODEL_UNAUTHORIZED'
      : response.status === 404 ? 'MODEL_UNAVAILABLE'
        : response.status === 429 ? 'RATE_LIMIT'
          : response.status >= 500 ? 'SERVER' : 'INVALID_REQUEST'
  let detail = ''
  let requestId = ''
  try {
    const body = await response.json() as { detail?: unknown; requestId?: unknown }
    if (typeof body.detail === 'string') detail = body.detail.trim()
    if (typeof body.requestId === 'string') requestId = body.requestId.trim()
  } catch (_invalidProblemResponse) {
    // The status still identifies the failure when a proxy returns HTML or an empty body.
  }
  const suffix = [detail, requestId === '' ? '' : `request ${requestId}`].filter(value => value !== '').join('; ')
  return new LlmError(`managed backend rejected the request (HTTP ${response.status})${suffix === '' ? '' : `: ${suffix}`}`, code, { status: response.status })
}

/** Whether an optional capacity field is absent, or a positive integer when the backend stated one. */
function isCapacity(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0)
}

/**
 * Attach the capacities the backend disclosed to one catalog entry. A field the
 * backend omitted stays absent so the adapter falls back to the route's own
 * configured default rather than presenting a fabricated capacity as fact.
 * @param info - the catalog entry as the LLM seam reports it.
 * @param source - the raw catalog entry, or undefined when the id is not in the catalog.
 * @returns the resolved entry, carrying `context` and `defaultMaxTokens` only when disclosed.
 */
function withCapacities(info: LlmModelInfo, source: BackendModel | undefined): LlmResolvedModelInfo {
  if (source === undefined) return info
  return {
    ...info,
    ...source.contextWindow === undefined ? {} : { context: { contextWindow: source.contextWindow } },
    ...source.maxOutputTokens === undefined ? {} : { defaultMaxTokens: source.maxOutputTokens },
  }
}

function modelList(value: unknown, provider: string): LlmModelInfo[] {
  if (typeof value !== 'object' || value === null || !('models' in value) || !Array.isArray(value.models)) {
    throw new LlmError('managed backend returned an invalid model catalog', 'MALFORMED_RESPONSE')
  }
  const ids = new Set<string>()
  return value.models.map((entry: unknown): LlmModelInfo => {
    if (typeof entry !== 'object' || entry === null || !('id' in entry) || typeof entry.id !== 'string'
      || entry.id.length === 0 || !('name' in entry) || typeof entry.name !== 'string' || entry.name.length === 0
      || ('multiplier' in entry && entry.multiplier !== undefined && (typeof entry.multiplier !== 'string' || entry.multiplier.length > 32))
      || ('description' in entry && entry.description !== undefined && typeof entry.description !== 'string')
      || ('contextWindow' in entry && !isCapacity(entry.contextWindow))
      || ('maxOutputTokens' in entry && !isCapacity(entry.maxOutputTokens))
      || ('input' in entry && entry.input !== undefined && (!Array.isArray(entry.input)
        || entry.input.length === 0 || entry.input.some(value => value !== 'text' && value !== 'image')))
      || ('imageInput' in entry && entry.imageInput !== undefined && (typeof entry.imageInput !== 'object'
        || entry.imageInput === null || !('state' in entry.imageInput)
        || !['supported', 'unsupported', 'unknown'].includes(String(entry.imageInput.state))))
      || ids.has(entry.id)) {
      throw new LlmError('managed backend returned an invalid model catalog', 'MALFORMED_RESPONSE')
    }
    ids.add(entry.id)
    const model = entry as BackendModel
    return { provider, id: model.id, name: model.name,
      ...model.multiplier === undefined ? {} : { multiplier: model.multiplier },
      ...model.imageInput === undefined ? {} : { imageInputState: model.imageInput.state },
      ...model.input === undefined ? {} : { inputModalities: [...model.input] },
      ...model.description === undefined ? {} : { description: model.description } }
  })
}

function catalogOf(value: unknown, provider: string): { catalog: BackendCatalog; models: LlmModelInfo[] } {
  const models = modelList(value, provider)
  const catalog = value as BackendCatalog
  if (models.length > 0 && (catalog.connection === undefined
    || typeof catalog.connection.api !== 'string' || catalog.connection.api.length === 0
    || typeof catalog.connection.baseURL !== 'string' || catalog.connection.baseURL.length === 0
    || typeof catalog.connection.apiKey !== 'string' || catalog.connection.apiKey.length === 0)) {
    throw new LlmError('managed backend returned incomplete direct model connection parameters', 'MALFORMED_RESPONSE')
  }
  for (const model of catalog.models) {
    if (model.input !== undefined && (!Array.isArray(model.input)
      || model.input.some(modality => modality !== 'text' && modality !== 'image'))) {
      throw new LlmError('managed backend returned invalid model modalities', 'MALFORMED_RESPONSE')
    }
  }
  return { catalog, models }
}

/** The backend validates the token and selected model on both catalog and generation requests. */
export class ManagedBackendAdapter extends LlmAdapter {
  constructor(
    private readonly ctx: Context,
    private readonly root: string,
    private readonly token: () => Promise<string>,
    private readonly request: typeof fetch = fetch,
    private readonly catalogRequestTimeoutMs = 30_000,
  ) { super() }

  override providerInfo(provider: string) { return { id: provider, name: 'Managed' } }

  override async listModels(provider: string): Promise<LlmModelInfo[]> {
    // An unsigned-in Host has no managed catalog yet; it is not a provider error.
    // resolveModel/prepareCall still require the token and fail closed.
    let token: string
    try { token = await this.token() }
    catch (error) {
      if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') return []
      throw error
    }
    return (await this.catalog(provider, token)).models
  }

  private async catalog(provider: string, token: string, signal?: AbortSignal) {
    let response: Response
    try {
      response = await this.request(`${this.root}/v1/models`, {
        headers: { authorization: `Bearer ${token}` }, redirect: 'error',
        signal: signal === undefined ? AbortSignal.timeout(this.catalogRequestTimeoutMs)
          : AbortSignal.any([signal, AbortSignal.timeout(this.catalogRequestTimeoutMs)]),
      })
    } catch (error) {
      if (signal?.aborted) throw new LlmError('managed backend model catalog request aborted', 'ABORTED', { cause: error })
      throw new LlmError('managed backend model catalog transport failed', 'TRANSPORT', { cause: error })
    }
    if (!response.ok) throw await backendFailure(response)
    let body: unknown
    try { body = await response.json() } catch (error) {
      throw new LlmError('managed backend returned an invalid model catalog', 'MALFORMED_RESPONSE', { cause: error })
    }
    return catalogOf(body, provider)
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    const { catalog, models } = await this.catalog(provider, await this.token(), signal)
    const allowed = models.find(candidate => candidate.id === model)
    if (allowed === undefined) throw new LlmError(`model "${model}" is not allowed by the managed backend`, 'MODEL_UNAUTHORIZED')
    return withCapacities(allowed, catalog.models.find(candidate => candidate.id === model))
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const { catalog, models } = await this.catalog(provider, await this.token(), signal)
    const allowed = models.find(candidate => candidate.id === model)
    if (allowed === undefined) throw new LlmError(`model "${model}" is not allowed by the managed backend`, 'MODEL_UNAUTHORIZED')
    const connection = catalog.connection as NonNullable<BackendCatalog['connection']>
    const selected = catalog.models.find(candidate => candidate.id === model)
    if (selected === undefined) throw new LlmError(`model "${model}" is not allowed by the managed backend`, 'MODEL_UNAUTHORIZED')
    // Login persists this binding before the active token; capture it per admitted call.
    const binding = await this.ctx.get('credentials')?.readRecord(credentialKey('llm-managed-backend', 'device-user'))
    const payload = binding?.kind === 'grant' ? binding.payload : undefined
    const username = typeof payload === 'object' && payload !== null
      && 'username' in payload && typeof payload.username === 'string' ? payload.username.trim() : ''
    // Encode account names so non-ASCII characters and separators remain safe in HTTP headers.
    const desktopVersion = launchEnvironmentOf(this.ctx).getFrom('DSH_DESKTOP_APP_VERSION', ['process'])?.value.trim()
    const version = desktopVersion || APP_IDENTITY.version
    const userAgent = username === '' ? undefined : `${encodeURIComponent(username)}/${encodeURIComponent(version)}`
    const profiles = resolveProfiles({ [provider]: {
      displayName: 'Managed', api: connection.api, baseURL: connection.baseURL,
      defaultInput: ['text'],
      models: [{
        id: selected.id, name: selected.name, input: selected.input ?? ['text'],
        ...selected.contextWindow === undefined ? {} : { contextWindow: selected.contextWindow },
        ...selected.maxOutputTokens === undefined ? {} : { maxTokens: selected.maxOutputTokens },
      }],
    } })
    const direct = new PiAiAdapter({
      onStreamFailure: value => { this.ctx.logger.warn('llm-request-diagnostic %s', JSON.stringify(value)) },
      ...userAgent === undefined ? {} : { userAgent },
      profiles: () => profiles,
      resolveApiKey: async () => connection.apiKey,
      auth: { credentials: credentialStoreFrom(this.ctx), authContext: authContextFrom(this.ctx) },
      resolveAttachments: () => this.ctx.get('attachments'),
      resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
        attachments, hostPath => this.ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
    })
    const prepared = await direct.prepareCall(provider, model, signal)
    signal?.throwIfAborted()
    return { model: { ...prepared.model, ...allowed }, stream: options => {
      if (allowed.imageInputState === 'unknown' && options.messages.some(message => contentHasImage(message.content)))
        throw new LlmError('图片能力尚未确认，请管理员在 AIGC 模型管理中配置图片理解能力', 'MODEL_IMAGE_CAPABILITY_UNKNOWN')
      return prepared.stream(options)
    } }
  }

  override async * stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const prepared = await this.prepareCall(options.provider, options.model, options.signal)
    yield* prepared.stream(options)
  }

}

export const name = 'llm-managed-backend'
export const inject = ['llm', 'credentials']

/** Register one backend-routed provider; missing credentials fail before every call. */
export function apply(ctx: Context, config: Config): void {
  const fromEnvironment = config.baseURLEnv === undefined
    ? undefined : launchEnvironmentOf(ctx).get(credentialRef(config.baseURLEnv))?.value
  const endpoint = config.baseURL ?? fromEnvironment
  if (endpoint === undefined || endpoint === '') {
    throw new TypeError('managed backend requires baseURL or a populated baseURLEnv at load')
  }
  const root = apiRoot(endpoint, config.allowInsecureHTTP ?? false)
  const provider = config.provider ?? 'managed'
  if (config.tokenEnv === undefined && config.tokenKey === undefined) {
    throw new TypeError('managed backend requires tokenEnv or tokenKey')
  }
  const ref = config.tokenEnv === undefined ? undefined : credentialRef(config.tokenEnv)
  const key = config.tokenKey === undefined ? undefined : credentialKey('llm-managed-backend', config.tokenKey)
  const session = key === undefined ? undefined : installPersistentSession(ctx, root, key, fetch, config.sessionTiming)
  const token = async (): Promise<string> => {
    if (session !== undefined) return session.accessToken()
    const record = key === undefined ? undefined : await ctx.credentials.readRecord(key)
    const managed = key === undefined && ref !== undefined ? await ctx.credentials.resolve(ref) : undefined
    const value = key === undefined
      ? managed?.value ?? (ref === undefined ? undefined : launchEnvironmentOf(ctx).get(ref)?.value)
      : record?.kind === 'api-key' ? record.key : undefined
    if (value === undefined || value.trim() === '') {
      throw new LlmError(`managed backend token ${String(key ?? ref)} is missing`, 'MISSING_CREDENTIAL')
    }
    return value.trim()
  }
  const providers = new Set([provider])
  ctx.provide('feedbackDelivery', { submit: async (session, entry) => {
    const sessionLog = session.snapshotEvents().map(event => JSON.stringify(event)).join('\n')
    if (sessionLog.length > 2_000_000) throw new Error('Session log exceeds feedback upload limit')
    const response = await fetch(`${root}/v1/feedback`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, ...entry, sessionLog }),
    })
    if (!response.ok) throw await backendFailure(response)
  } })
  ctx.provide('managedBackend', { endpoint: root, ...session, authorizeProvider: (id: string) => {
    if (providers.has(id)) throw new TypeError(`managed provider ${id} is already authorized`)
    providers.add(id)
    return () => { providers.delete(id) }
  } })
  ctx.on('llm/stream', (options, next) => {
    if (!providers.has(options.provider)) {
      throw new LlmError('organization mode permits only backend-granted models', 'MODEL_UNAUTHORIZED')
    }
    return next()
  })
  ctx.llm.registerAdapter([provider], new ManagedBackendAdapter(ctx, root, token, fetch, config.catalogRequestTimeoutMs))
  if (config.uploadSync !== undefined && Object.values(config.uploadSync).some(value => value !== undefined)) {
    installUploadSync(ctx, root, config.uploadSync)
  }
}
