/** Host-owned configuration invalidation, reconciliation and applied receipts. */
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey, type CredentialKey, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { z } from 'zod'

const versionSchema = z.object({ schemaVersion: z.literal(1), userId: z.uuid(), revision: z.number().int().nonnegative().safe() })
const snapshotSchema = versionSchema.extend({
  capabilities: z.object({allowCustomModels: z.boolean()}).default({allowCustomModels: false}),
  offerId: z.uuid(), domains: z.array(z.enum(['models', 'billing', 'access'])),
  models: z.array(z.object({ id: z.uuid(), name: z.string(), providerKind: z.string(), modelIdentifier: z.string(), multiplier: z.string() })),
  billing: z.object({ assigned: z.boolean(), planName: z.string().nullable(), source: z.string(),
    total: z.number().nonnegative(), used: z.number().nonnegative(), reserved: z.number().nonnegative(),
    remaining: z.number(), weekStart: z.string(), resetsAt: z.string() }),
})

/** Validated per-user metadata; transport credentials never enter this snapshot. */
export type ManagedConfigSnapshot = z.infer<typeof snapshotSchema>

class ConfigSyncHttpError extends Error {
  constructor(readonly status: number) { super(`Config synchronization HTTP ${status}`) }
}

/** Single-flight refresh and acknowledgement owner, independent of SSE availability. */
export class ManagedConfigReconciler {
  private userId: string | undefined
  private applied = -1
  private pendingReceipt: ManagedConfigSnapshot | undefined
  private running: Promise<void> | undefined
  private dirty = false

  constructor(private readonly root: string, private readonly deviceId: string, private readonly clientVersion: string,
    private readonly token: () => Promise<string>, private readonly apply: (value: ManagedConfigSnapshot, signal: AbortSignal) => Promise<void>,
    private readonly request: typeof fetch = fetch) {}

  private async call(path: string, signal: AbortSignal, payload?: unknown): Promise<Response> {
    const response = await this.request(`${this.root}/v1/config/${path}`, {
      method: payload === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${await this.token()}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    })
    if (!response.ok) throw new ConfigSyncHttpError(response.status)
    return response
  }

  /** Re-read authoritative versions, apply complete data and retry any unacknowledged success. */
  reconcile(signal: AbortSignal): Promise<void> {
    this.dirty = true
    this.running ??= (async () => {
      while (this.dirty) { this.dirty = false; signal.throwIfAborted(); await this.refresh(signal) }
    })().finally(() => { this.running = undefined })
    return this.running
  }

  private report(snapshot: ManagedConfigSnapshot, status: 'Applied' | 'Failed', signal: AbortSignal) {
    return this.call('applied', signal, { deviceId: this.deviceId, deviceName: hostname(), clientVersion: this.clientVersion,
      revision: snapshot.revision, offerId: snapshot.offerId, status, errorCode: status === 'Failed' ? 'APPLY_FAILED' : '' })
  }

  private async refresh(signal: AbortSignal): Promise<void> {
    const identityToken = await this.token()
    const version = versionSchema.parse(await (await this.call('versions', signal)).json())
    signal.throwIfAborted()
    if (await this.token() !== identityToken) throw new Error('Configuration identity changed')
    if (version.userId !== this.userId) { this.userId = version.userId; this.applied = -1; this.pendingReceipt = undefined }
    if (version.revision !== this.applied) {
      let snapshot: ManagedConfigSnapshot
      try {
        snapshot = snapshotSchema.parse(await (await this.call(`snapshot?deviceId=${encodeURIComponent(this.deviceId)}`, signal)).json())
      } catch (error) {
        await this.call('applied', signal, { deviceId: this.deviceId, deviceName: hostname(), clientVersion: this.clientVersion,
          revision: version.revision, offerId: '00000000-0000-0000-0000-000000000000', status: 'Failed', errorCode: 'SNAPSHOT_FAILED' }).catch(() => {})
        throw error
      }
      if (snapshot.userId !== version.userId || snapshot.revision < version.revision) throw new Error('Configuration snapshot identity or version mismatch')
      const after = versionSchema.parse(await (await this.call('versions', signal)).json())
      if (after.userId !== snapshot.userId || after.revision !== snapshot.revision) throw new Error('Configuration changed while loading')
      signal.throwIfAborted()
      if (await this.token() !== identityToken) throw new Error('Configuration identity changed')
      try { await this.apply(snapshot, signal) }
      catch (error) { await this.report(snapshot, 'Failed', signal).catch(() => {}); throw error }
      signal.throwIfAborted()
      if (await this.token() !== identityToken) throw new Error('Configuration identity changed')
      this.applied = snapshot.revision; this.pendingReceipt = snapshot
    }
    if (this.pendingReceipt !== undefined) {
      try { await this.report(this.pendingReceipt, 'Applied', signal); this.pendingReceipt = undefined }
      catch (error) {
        if (error instanceof ConfigSyncHttpError && error.status === 409) { this.applied = -1; this.pendingReceipt = undefined }
        throw error
      }
    }
    await this.call('applied', signal, { deviceId: this.deviceId, deviceName: hostname(), clientVersion: this.clientVersion,
      revision: this.applied, offerId: '00000000-0000-0000-0000-000000000000', status: 'Heartbeat', errorCode: '' })
  }
}

/** Yield bounded SSE event names, including frames split across transport chunks. */
export async function* configEvents(response: Response): AsyncGenerator<string> {
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream') || response.body === null)
    throw new Error(`Config event stream unavailable (HTTP ${response.status})`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return
      buffer += decoder.decode(next.value, { stream: true })
      if (buffer.length > 65_536) throw new Error('Config event frame exceeds limit')
      buffer = buffer.replace(/\r\n/gu, '\n')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
        const event = frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim()
        if (event !== undefined) yield event
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Install one Host connection plus bounded polling; all activity is canceled on disposal or account replacement. */
export function installConfigSync(ctx: Context, root: string, token: () => Promise<string>, clientVersion: string,
  apply: (snapshot: ManagedConfigSnapshot, signal: AbortSignal) => Promise<void>, request: typeof fetch = fetch,
  identity: { tokenKey?: CredentialKey; tokenRef?: CredentialRef; reset?: () => void } = {}): void {
  ctx.effect(() => {
    const lifetime = new AbortController()
    let cycle = new AbortController()
    const renew = () => { cycle.abort(); cycle = new AbortController(); identity.reset?.() }
    const disposers = [ctx.on('credentials/record-updated', key => {
      if (key === identity.tokenKey || key === credentialKey('llm-managed-backend', 'persistent-session')) renew()
    }), ctx.on('credentials/reference-updated', ref => { if (ref === identity.tokenRef) renew() })]
    const work = (async () => {
      const deviceKey = credentialKey('llm-managed-backend', 'config-sync-device')
      let deviceId: string = randomUUID()
      await ctx.credentials.modifyRecord(deviceKey, async record => {
        const stored = z.object({ deviceId: z.uuid() }).safeParse(record?.kind === 'grant' ? record.payload : undefined)
        if (stored.success) deviceId = stored.data.deviceId
        return { kind: 'grant', payload: { deviceId } }
      })
      while (!lifetime.signal.aborted) {
        const signal = AbortSignal.any([lifetime.signal, cycle.signal])
        const reconciler = new ManagedConfigReconciler(root, deviceId, clientVersion, token, apply, request)
        const refresh = async () => {
          try { await reconciler.reconcile(signal) }
          catch { if (!signal.aborted) ctx.logger('managed-config').warn('Configuration refresh or receipt failed; retrying') }
        }
        const poll = (async () => {
          while (!signal.aborted) { await refresh(); await delay(30_000 + Math.floor(Math.random() * 5000), undefined, { signal }) }
        })().catch(() => {})
        const events = (async () => {
          let retry = 1000
          while (!signal.aborted) {
            try {
              const access = await token()
              const response = await request(`${root}/v1/config/events`, { headers: { authorization: `Bearer ${access}` },
                redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(70_000)]) })
              for await (const event of configEvents(response)) {
                if (event === 'auth.revoked') { identity.reset?.(); throw new Error('Organization session revoked') }
                if (event === 'config.changed') { await delay(200 + Math.floor(Math.random() * 300), undefined, { signal }); await refresh() }
                retry = 1000
              }
            } catch { /* Polling reconciles even when the deployment proxy buffers or rejects SSE. */ }
            await delay(retry + Math.floor(Math.random() * 500), undefined, { signal })
            retry = Math.min(30_000, retry * 2)
          }
        })().catch(() => {})
        await Promise.all([poll, events])
      }
    })().catch(() => { if (!lifetime.signal.aborted) ctx.logger('managed-config').warn('Configuration synchronization stopped') })
    return async () => { lifetime.abort(); cycle.abort(); disposers.forEach(dispose => dispose()); await work }
  }, 'managed-backend: configuration synchronization')
}
