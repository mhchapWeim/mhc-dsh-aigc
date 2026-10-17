/**
 * Host owner of the `credentials` Remote namespace: the reference half of
 * `ctx.credentials` as a browser configuration page reads and writes it.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/credentials.ts
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-llm-managed-backend'
import type {} from '@deepseek-ai/dsh-tools'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'
import type { ManagedAuthState, ManagedCasConfig, ManagedCasDeviceLogin } from './types.ts'

/**
 * Fan-out bound on one remote `describe` batch. A settings page asks about the
 * references its own rows name, so this is far above any real page and still
 * keeps one authenticated request from starting unbounded provider work.
 */
const MAX_DESCRIBE_REFS = 64

const credentialRefSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
const describeRequestSchema = z.object({
  refs: z.array(credentialRefSchema).max(MAX_DESCRIBE_REFS),
})
const setRequestSchema = z.object({ ref: credentialRefSchema, value: z.string().min(1) })
const unsetRequestSchema = z.object({ ref: credentialRefSchema })

/**
 * Records the interactive login owns. `user-session` holds the bearer token the
 * backend issued, `device-user` binds this OS profile to one organization user
 * so a second account cannot inherit the first one's Workspace, and
 * `login-source` remembers which of the two entry points signed in — only a CAS
 * session owes the backend a browser sign-out.
 */
const managedTokenKey = credentialKey('llm-managed-backend', 'user-session')
const managedDeviceUserKey = credentialKey('llm-managed-backend', 'device-user')
const managedLoginSourceKey = credentialKey('llm-managed-backend', 'login-source')

const managedLoginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
})
const managedUserSchema = z.object({ id: z.uuid(), username: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u) })
const managedModelSchema = z.object({ id: z.string().min(1), name: z.string().min(1) })
const managedModelsSchema = z.object({
  models: z.array(managedModelSchema),
  additionalModels: z.array(managedModelSchema.extend({ provider: z.literal('managed-internal') })).default([]),
})
const managedSessionSchema = z.object({ access_token: z.string().regex(/^[0-9a-f]{64}$/u), refresh_token: z.string().regex(/^[0-9a-f]{64}$/u).optional(), expires_at: z.iso.datetime({ offset: true }).optional() })
const managedLoginResponseSchema = managedSessionSchema.extend({ user: managedUserSchema })
const managedCasConfigSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), login_url: z.url(), logout_url: z.url(), service: z.url() }),
])
const managedCasDeviceSchema = z.object({
  browser_url: z.url(),
  device_code: z.string().regex(/^[0-9a-f]{64}$/u),
  interval: z.number().int().min(1).max(10),
})

/** A fresh backend login may rebind an old database id only for the same employee account. */
function sameManagedUser(binding: unknown, user: z.infer<typeof managedUserSchema>): boolean {
  const bound = z.object({ id: z.uuid(), username: managedUserSchema.shape.username }).safeParse(binding)
  return bound.success && bound.data.username.toLowerCase() === user.username.toLowerCase()
}

/** The endpoint the managed backend adapter published, or `undefined` when it is not mounted. */
function managedEndpoint(ctx: Context): string | undefined {
  return ctx.get('managedBackend')?.endpoint
}

/**
 * Send one backend request under a bounded timeout. Every transport failure
 * becomes the same refusal a surface already handles, so a backend that is
 * down is reported as a backend problem rather than an unhandled rejection.
 * @param request - the fetch implementation this Host injected.
 * @param url - backend root, already validated by the adapter.
 * @param path - absolute backend path.
 * @param token - bearer token for an authenticated call.
 * @param credentials - login body; its presence is what makes this a POST.
 * @returns the backend's raw response, including non-2xx statuses.
 * @throws RemoteError when the backend cannot be reached at all.
 */
async function managedRequest(
  request: typeof fetch,
  url: string,
  path: string,
  token?: string,
  credentials?: { username: string; password: string },
): Promise<Response> {
  try {
    return await request(`${url}${path}`, {
      method: credentials === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: {
        ...token === undefined ? {} : { authorization: `Bearer ${token}` },
        ...credentials === undefined ? {} : { 'content-type': 'application/json' },
      },
      ...credentials === undefined ? {} : { body: JSON.stringify(credentials) },
    })
  } catch (error) {
    throw new RemoteError('managed-auth/rejected', 'cannot reach the managed backend', { reason: 'backend' }, { cause: error })
  }
}

/** Parse the domain constraints that are more specific than generated TypeScript codecs. */
function parseRequest<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new RemoteError('gateway/bad-request', `invalid payload for ${method}`, { issues: parsed.error.issues })
  }
  return parsed.data
}

/**
 * Copy exactly the fields {@link CredentialInfo} declares. The Gateway returns
 * a business result without decoding it, so a provider whose `describe` carried
 * extra enumerable properties would otherwise serialize them to the caller.
 * @param info - the provider's answer for one reference.
 * @returns the same facts with nothing else attached.
 */
function projectCredentialInfo(info: CredentialInfo): CredentialInfo {
  return {
    configured: info.configured,
    ...info.source === undefined ? {} : { source: info.source },
    writable: info.writable,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `credentials` Remote namespace. */
    credentialsController: CredentialsController
  }
}

/**
 * Host service backing the generated `ctx.remote.credentials` namespace. It
 * carries every wire obligation the credential seam itself does not: the batch
 * fan-out bound, the field-by-field view projection, the reference-grammar
 * guard, and the refusal mapping. Secret values cross in one direction only —
 * no method here returns one.
 */
export class CredentialsController extends TypertRemoteService {
  private readonly request: typeof fetch
  private readonly home: () => string
  /**
   * @param ctx - Host context where a credential provider may be mounted.
   * @param _config - the composition entry's config; this service reads none.
   * @param internals - test seams for the backend transport and the DSH home.
   */
  constructor(ctx: Context, _config: unknown = {}, internals: { request?: typeof fetch; home?: () => string } = {}) {
    super(ctx, 'credentialsController', { namespace: 'credentials' })
    this.request = internals.request ?? fetch
    this.home = internals.home ?? resolveDshHome
    ctx.on('tools/result', (exec, result) => {
      // Tool results are already durable in the Session log. Mirror only metadata to AIGC;
      // neither arguments nor tool output may leave the client through this audit path.
      if (exec.agent === undefined) return
      void this.writeToolAudit(exec.agent.session.id, exec.callId, exec.name,
        !result.isError, result.isError ? result.error.info?.code : undefined)
        .catch(error => ctx.logger.warn(`DSH tool audit delivery failed: ${String(error)}`))
    })
  }

  private async writeToolAudit(sessionId: string, callId: string, toolName: string,
    succeeded: boolean, errorCode?: string): Promise<void> {
    const endpoint = managedEndpoint(this.ctx)
    if (endpoint === undefined) return
    const record = await this.provider().readRecord(managedTokenKey)
    if (record?.kind !== 'api-key' || record.key === undefined) return
    const response = await this.request(`${endpoint}/v1/tool-audits`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${record.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, callId, toolName, succeeded, errorCode }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  }

  /**
   * Describe several references for one configuration surface. Batched because
   * a settings page describes every reference its rows name at once, and one
   * round trip keeps those rows from settling separately.
   * @param refs - reference names, at most {@link MAX_DESCRIBE_REFS}; a name outside the grammar
   *   rejects the whole call as `gateway/bad-request`.
   * @returns one view per requested name, keyed by that name.
   * @throws RemoteError when the request is invalid or no credential provider is mounted.
   */
  @Remote
  async describe(refs: string[]): Promise<Record<string, CredentialInfo>> {
    const request = parseRequest('credentials.describe', describeRequestSchema, { refs })
    const branded = request.refs.map(ref => [ref, credentialRef(ref)] as const)
    const credentials = this.provider()
    const entries = await Promise.all(branded.map(async ([ref, key]) =>
      [ref, projectCredentialInfo(await credentials.describe(key))] as const))
    return Object.fromEntries(entries)
  }

  /**
   * Store one value from a configuration surface. The value crosses the wire in
   * this direction only: no read path returns it.
   * @param ref - reference name to store under.
   * @param value - the non-empty secret value.
   * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
   */
  @Remote
  async set(ref: string, value: string): Promise<void> {
    const request = parseRequest('credentials.set', setRequestSchema, { ref, value })
    const branded = credentialRef(request.ref)
    const credentials = this.provider()
    await this.write(request.ref, () => credentials.set(branded, request.value))
  }

  /**
   * Remove one reference from a configuration surface.
   * @param ref - reference name to remove.
   * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
   */
  @Remote
  async unset(ref: string): Promise<void> {
    const request = parseRequest('credentials.unset', unsetRequestSchema, { ref })
    const branded = credentialRef(request.ref)
    const credentials = this.provider()
    await this.write(request.ref, () => credentials.unset(branded))
  }

  /**
   * Report the current organization login without sending its bearer token to
   * the caller.
   * @returns disabled without a mounted backend, `user: null` before sign-in,
   *   otherwise the identity, granted models, and user Workspace.
   * @throws RemoteError when the backend rejects the stored token's identity lookup.
   */
  @Remote
  async managedStatus(): Promise<ManagedAuthState> {
    const endpoint = managedEndpoint(this.ctx)
    if (endpoint === undefined) return { enabled: false }
    const record = await this.provider().readRecord(managedTokenKey)
    const backend = this.ctx.get('managedBackend')
    let token = record?.kind === 'api-key' ? record.key : undefined
    if (backend?.accessToken !== undefined) {
      try { token = await backend.accessToken() }
      catch (error) {
        if (error instanceof Error && 'code' in error && (error.code === 'AUTH' || error.code === 'MISSING_CREDENTIAL')) return { enabled: true, user: null }
        throw error
      }
    }
    if (token === undefined) return { enabled: true, user: null }
    return this.managedIdentity(endpoint, token)
  }

  /**
   * Exchange an organization password for a Host-owned backend token.
   * @param username - organization employee number.
   * @param password - organization account password.
   * @returns the authenticated state, whose granted models also become the default selection.
   * @throws RemoteError when the payload is invalid, the credentials are refused, or the backend fails.
   */
  @Remote
  async managedLogin(username: string, password: string): Promise<ManagedAuthState> {
    const endpoint = managedEndpoint(this.ctx)
    if (endpoint === undefined) return { enabled: false }
    const input = parseRequest('credentials.managedLogin', managedLoginSchema, { username, password })
    const response = await managedRequest(this.request, endpoint, '/v1/auth/login', undefined, input)
    if (response.status === 401) {
      throw new RemoteError('managed-auth/rejected', 'invalid username or password', { reason: 'credentials' })
    }
    if (!response.ok) {
      throw new RemoteError('managed-auth/rejected', `managed backend login failed (HTTP ${response.status})`, { reason: 'backend' })
    }
    const parsed = managedLoginResponseSchema.safeParse(await response.json())
    if (!parsed.success) {
      throw new RemoteError('managed-auth/rejected', 'managed backend returned an invalid login response', { reason: 'backend' })
    }
    return this.acceptManagedToken(endpoint, parsed.data.access_token, 'local', parsed.data)
  }

  /**
   * Read the backend's BHSS CAS entry point and the exact callback service it expects.
   * @returns the CAS URLs, or disabled when the backend serves no CAS configuration.
   * @throws RemoteError when the backend fails or answers with an unusable configuration.
   */
  @Remote
  async managedCasConfig(): Promise<ManagedCasConfig> {
    const endpoint = managedEndpoint(this.ctx)
    if (endpoint === undefined) return { enabled: false }
    const response = await managedRequest(this.request, endpoint, '/v1/auth/cas/config')
    if (!response.ok) {
      throw new RemoteError('managed-auth/rejected', `managed backend CAS configuration failed (HTTP ${response.status})`, { reason: 'backend' })
    }
    const parsed = managedCasConfigSchema.safeParse(await response.json())
    if (!parsed.success) {
      throw new RemoteError('managed-auth/rejected', 'managed backend returned an invalid CAS configuration', { reason: 'backend' })
    }
    return parsed.data.enabled
      ? { enabled: true, loginUrl: parsed.data.login_url, logoutUrl: parsed.data.logout_url, service: parsed.data.service }
      : { enabled: false }
  }

  /**
   * Open one short-lived CAS login the caller completes in the system browser.
   * @returns the page to open and the handle to poll.
   * @throws RemoteError when no backend is mounted, it is unreachable, or it answers unusably.
   */
  @Remote
  async managedCasStart(): Promise<ManagedCasDeviceLogin> {
    const endpoint = managedEndpoint(this.ctx)
    if (endpoint === undefined) {
      throw new RemoteError('managed-auth/rejected', 'managed backend is not configured', { reason: 'backend' })
    }
    let response: Response
    try {
      response = await this.request(`${endpoint}/v1/auth/cas/device`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      throw new RemoteError('managed-auth/rejected', 'cannot reach the managed backend', { reason: 'backend' }, { cause: error })
    }
    if (!response.ok) {
      throw new RemoteError('managed-auth/rejected', `managed backend CAS start failed (HTTP ${response.status})`, { reason: 'backend' })
    }
    const parsed = managedCasDeviceSchema.safeParse(await response.json())
    if (!parsed.success) {
      throw new RemoteError('managed-auth/rejected', 'managed backend returned an invalid CAS device login', { reason: 'backend' })
    }
    return {
      browserUrl: parsed.data.browser_url,
      deviceCode: parsed.data.device_code,
      intervalSeconds: parsed.data.interval,
    }
  }

  /**
   * Poll once for a browser login the user may have finished.
   * @param deviceCode - the handle returned by {@link managedCasStart}.
   * @returns the authenticated state, or `null` while the browser is still authenticating.
   * @throws RemoteError when the handle is malformed, expired, or the backend fails.
   */
  @Remote
  async managedCasPoll(deviceCode: string): Promise<ManagedAuthState | null> {
    const endpoint = managedEndpoint(this.ctx)
    if (endpoint === undefined || !/^[0-9a-f]{64}$/u.test(deviceCode)) {
      throw new RemoteError('managed-auth/rejected', 'invalid CAS device login', { reason: 'credentials' })
    }
    const response = await managedRequest(this.request, endpoint, `/v1/auth/cas/device/${deviceCode}`)
    if (response.status === 202) return null
    if (response.status === 404) {
      throw new RemoteError('managed-auth/rejected', 'CAS device login expired', { reason: 'credentials' })
    }
    if (!response.ok) {
      throw new RemoteError('managed-auth/rejected', `managed backend CAS polling failed (HTTP ${response.status})`, { reason: 'backend' })
    }
    const parsed = managedSessionSchema.safeParse(await response.json())
    if (!parsed.success) {
      throw new RemoteError('managed-auth/rejected', 'managed backend returned an invalid CAS device result', { reason: 'backend' })
    }
    return this.acceptManagedToken(endpoint, parsed.data.access_token, 'sso', parsed.data)
  }

  /**
   * Revoke the backend token and drop the Host's local copy. The local removal
   * always happens, so an unreachable backend cannot leave a signed-in profile
   * behind; a CAS session additionally returns the browser sign-out URL.
   * @returns the CAS logout URL for an SSO session, otherwise `null`.
   */
  @Remote
  async managedLogout(): Promise<string | null> {
    const record = await this.provider().readRecord(managedTokenKey)
    const sourceRecord = await this.provider().readRecord(managedLoginSourceKey)
    const backend = this.ctx.get('managedBackend')
    const revokeToken = backend?.clearSession === undefined
      ? record?.kind === 'api-key' ? record.key : undefined
      : await backend.clearSession()
    await this.provider().deleteRecord(managedTokenKey)
    await this.provider().deleteRecord(managedLoginSourceKey)
    const endpoint = managedEndpoint(this.ctx)
    if (endpoint === undefined || revokeToken === undefined) return null
    try {
      await this.request(`${endpoint}/v1/auth/logout`, {
        method: 'POST', headers: { authorization: `Bearer ${revokeToken}` },
        redirect: 'error', signal: AbortSignal.timeout(10_000),
      })
    } catch (_unreachableBackend) {
      // Local sign-out succeeds even when the remote revocation endpoint is unavailable.
    }
    const source = z.object({ source: z.enum(['local', 'sso']) })
      .safeParse(sourceRecord?.kind === 'grant' ? sourceRecord.payload : undefined)
    if (!source.success || source.data.source !== 'sso') return null
    try {
      const config = await this.managedCasConfig()
      return config.enabled ? config.logoutUrl : null
    } catch (_casUnavailable) {
      // The local token is already removed; a failed CAS logout lookup must not restore the session.
      return null
    }
  }

  /**
   * Verify an issued token, bind this OS profile to its user, and store it.
   * @param endpoint - the mounted backend root.
   * @param token - the backend-issued bearer token.
   * @param source - which entry point produced the token.
   * @returns the verified state, whose first granted model becomes the default selection.
   * @throws RemoteError when the token is refused or this profile belongs to another user.
   */
  private async acceptManagedToken(endpoint: string, token: string, source: 'local' | 'sso', tokens?: z.infer<typeof managedSessionSchema>): Promise<ManagedAuthState> {
    const state = await this.managedIdentity(endpoint, token, true)
    if (!state.enabled || state.user === null) {
      throw new RemoteError('managed-auth/rejected', 'managed backend rejected the issued token', { reason: 'backend' })
    }
    await this.provider().modifyRecord(managedDeviceUserKey, async current => {
      if (current === undefined) return {
        kind: 'grant', payload: { id: state.user.id, username: state.user.username },
      }
      const payload = current.kind === 'grant' ? current.payload : undefined
      const bound = z.object({ id: z.uuid() }).safeParse(payload)
      if (bound.success && bound.data.id === state.user.id) return undefined
      if (sameManagedUser(payload, state.user)) {
        return { kind: 'grant', payload: { id: state.user.id, username: state.user.username } }
      }
      throw new RemoteError('managed-auth/rejected', 'this Windows profile belongs to another organization user', { reason: 'device-binding' })
    })
    const backend = this.ctx.get('managedBackend')
    if (tokens?.refresh_token !== undefined && tokens.expires_at !== undefined && backend?.storeSession !== undefined) {
      await backend.storeSession({ access_token: token, refresh_token: tokens.refresh_token, expires_at: tokens.expires_at })
    } else {
      await this.provider().modifyRecord(managedTokenKey, async () => ({ kind: 'api-key', key: token }))
    }
    await this.provider().modifyRecord(managedLoginSourceKey, async () => ({ kind: 'grant', payload: { source } }))
    if (state.models.length > 0) {
      try {
        await this.ctx.get('agentDefaultModel')?.saveSelection({ provider: state.models[0]!.provider ?? 'managed', model: state.models[0]!.id })
      } catch (error) {
        this.ctx.logger.warn('Managed login saved; default model selection needs repair: %s', String(error))
      }
    }
    return state
  }

  /**
   * Resolve the identity, granted catalog, and user Workspace behind one token.
   * A token the backend no longer accepts is dropped here, so a revoked session
   * settles into the signed-out state instead of failing every later call.
   * @param endpoint - the mounted backend root.
   * @param token - the bearer token to verify.
   * @returns the authenticated state.
   * @throws RemoteError when the backend fails, the profile is bound to another user, or the Workspace cannot be registered.
   */
  private async managedIdentity(endpoint: string, token: string, allowSameUserRebind = false): Promise<ManagedAuthState> {
    const response = await managedRequest(this.request, endpoint, '/v1/auth/me', token)
    if (response.status === 401) {
      await this.ctx.get('managedBackend')?.clearSession?.()
      await this.provider().deleteRecord(managedTokenKey)
      return { enabled: true, user: null }
    }
    if (!response.ok) {
      throw new RemoteError('managed-auth/rejected', `managed backend identity failed (HTTP ${response.status})`, { reason: 'backend' })
    }
    const identity = z.object({ user: managedUserSchema }).safeParse(await response.json())
    if (!identity.success) {
      throw new RemoteError('managed-auth/rejected', 'managed backend returned an invalid user', { reason: 'backend' })
    }
    const binding = await this.provider().readRecord(managedDeviceUserKey)
    if (binding !== undefined) {
      const bound = z.object({ id: z.uuid() }).safeParse(binding.kind === 'grant' ? binding.payload : undefined)
      if (!bound.success || bound.data.id !== identity.data.user.id) {
        // A newly authenticated login can replace a stale database id for
        // the same employee account; a passive status check cannot.
        if (!(allowSameUserRebind && sameManagedUser(binding.kind === 'grant' ? binding.payload : undefined, identity.data.user))) {
          await this.ctx.get('managedBackend')?.clearSession?.()
          await this.provider().deleteRecord(managedTokenKey)
          throw new RemoteError('managed-auth/rejected', 'this Windows profile belongs to another organization user', { reason: 'device-binding' })
        }
      }
    }
    const catalog = await managedRequest(this.request, endpoint, '/v1/models', token)
    if (!catalog.ok) {
      throw new RemoteError('managed-auth/rejected', `managed backend model catalog failed (HTTP ${catalog.status})`, { reason: 'backend' })
    }
    const models = managedModelsSchema.safeParse(await catalog.json())
    if (!models.success) {
      throw new RemoteError('managed-auth/rejected', 'managed backend returned an invalid model catalog', { reason: 'backend' })
    }
    const username = identity.data.user.username
    try {
      const registry = this.ctx.get('workspaceRegistry')
      if (registry === undefined) throw new Error('Workspace registry is unavailable')
      const path = registry.allowedRoot ?? join(this.home(), 'workspaces', `bhss-${username}-workspace`)
      if (registry.allowedRoot !== undefined) await registry.prepareDirectory(path)
      else await mkdir(path, { recursive: true })
      if (registry.allowedRoot !== undefined) await registry.assertAllowedDirectory(path)
      const workspace = await registry.resolveByPath(path) ?? await registry.create(path)
      return {
        enabled: true, user: identity.data.user, models: [...models.data.models, ...models.data.additionalModels],
        workspaceId: workspace.id, workspacePath: path,
      }
    } catch (error) {
      this.ctx.logger.warn('Managed identity accepted; local Workspace needs repair: %s', String(error))
      return {
        enabled: true, user: identity.data.user, models: [...models.data.models, ...models.data.additionalModels],
        workspacePath: this.ctx.get('workspaceRegistry')?.allowedRoot ?? join(this.home(), 'workspaces', `bhss-${username}-workspace`),
        workspaceIssue: 'unavailable',
      }
    }
  }

  /** Resolve the optional provider or report how to supply it. */
  private provider(): CredentialProvider {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'credentials service is absent: this deployment does not mount a credential provider (e.g. @deepseek-ai/dsh-credentials-local) in its composition',
        {},
      )
    }
    return credentials
  }

  /**
   * Run one remote write and report every refusal as `credential/rejected`
   * carrying the seam's own message: a read-only source shadowing the reference
   * is what a configuration surface must show verbatim. Callers brand the
   * reference before entering, so a name outside the grammar never reaches this
   * path and fails the same way it does on the read side. The details name only
   * the reference, so no failure path can carry the value back out.
   */
  private async write(ref: string, write: () => Promise<void>): Promise<void> {
    try {
      await write()
    } catch (error: unknown) {
      throw new RemoteError(
        'credential/rejected',
        error instanceof Error ? error.message : String(error),
        { ref },
        { cause: error },
      )
    }
  }
}

export default CredentialsController
