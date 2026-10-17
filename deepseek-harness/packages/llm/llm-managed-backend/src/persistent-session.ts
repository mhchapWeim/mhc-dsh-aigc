/** Host-owned persistent session storage and single-flight access renewal. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey, type CredentialKey } from '@deepseek-ai/dsh-credentials'
import { z } from 'zod'
import { LlmError } from '@deepseek-ai/dsh-llm'

const sessionSchema = z.object({
  access_token: z.string().regex(/^[0-9a-f]{64}$/u),
  refresh_token: z.string().regex(/^[0-9a-f]{64}$/u),
  expires_at: z.iso.datetime({ offset: true }),
})

/** Tokens returned by the organization's login and refresh endpoints; never sent to the renderer. */
export type PersistentSessionTokens = z.infer<typeof sessionSchema>

/**
 * Coordinate durable login and renewal with sign-out and plugin disposal.
 * @param ctx - Host credential owner.
 * @param endpoint - validated organization API root.
 * @param tokenKey - active access-token record.
 * @param request - bounded credential-bearing transport.
 * @param timing - deployment-owned renewal margin, polling interval, and timeout.
 * @returns Host-only session operations.
 */
export function installPersistentSession(ctx: Context, endpoint: string, tokenKey: CredentialKey, request: typeof fetch = fetch, timing = { renewBeforeMs: 300_000, pollMs: 60_000, requestTimeoutMs: 10_000 }) {
  for (const value of [timing.renewBeforeMs, timing.pollMs, timing.requestTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Persistent session timing must be positive integers')
  }
  const refreshKey = credentialKey('llm-managed-backend', 'persistent-session')
  let generation = 0
  let pending: Promise<string> | undefined
  const lifetime = new AbortController()

  async function stored() {
    const record = await ctx.credentials.readRecord(refreshKey)
    if (record === undefined) return undefined
    const result = sessionSchema.safeParse(record.kind === 'grant' ? record.payload : undefined)
    if (!result.success) throw new Error('Invalid stored organization session')
    return result.data
  }

  async function save(value: PersistentSessionTokens, expectedGeneration: number) {
    await ctx.credentials.modifyRecord(refreshKey, async () => {
      if (expectedGeneration !== generation || lifetime.signal.aborted) throw new Error('Organization session changed')
      return { kind: 'grant', payload: value }
    })
    await ctx.credentials.modifyRecord(tokenKey, async () => {
      if (expectedGeneration !== generation || lifetime.signal.aborted) throw new Error('Organization session changed')
      return { kind: 'api-key', key: value.access_token }
    })
  }

  async function clear() {
    generation++
    const grant = await ctx.credentials.readRecord(refreshKey)
    const parsed = sessionSchema.safeParse(grant?.kind === 'grant' ? grant.payload : undefined)
    const session = parsed.success ? parsed.data : undefined
    const record = await ctx.credentials.readRecord(tokenKey)
    await ctx.credentials.deleteRecord(refreshKey)
    await ctx.credentials.deleteRecord(tokenKey)
    return session?.refresh_token ?? (record?.kind === 'api-key' ? record.key : undefined)
  }

  async function resolve(): Promise<string> {
    const expectedGeneration = generation
    const session = await stored()
    if (session === undefined) {
      const record = await ctx.credentials.readRecord(tokenKey)
      if (record?.kind !== 'api-key' || !record.key) throw new LlmError('Organization login required', 'MISSING_CREDENTIAL')
      return record.key
    }
    if (Date.parse(session.expires_at) > Date.now() + timing.renewBeforeMs) {
      // Repair the access-token mirror after an interrupted disk write.
      const record = await ctx.credentials.readRecord(tokenKey)
      if (record?.kind !== 'api-key' || record.key !== session.access_token) await save(session, expectedGeneration)
      return session.access_token
    }
    const response = await request(`${endpoint}/v1/auth/refresh`, {
      method: 'POST', redirect: 'error',
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(timing.requestTimeoutMs)]),
      headers: { authorization: `Bearer ${session.refresh_token}` },
    })
    if (expectedGeneration !== generation) throw new Error('Organization session changed')
    if (response.status === 401) {
      await clear()
      throw new LlmError('Organization session was revoked', 'AUTH')
    }
    if (!response.ok) throw new Error(`Organization renewal failed (HTTP ${response.status})`)
    const renewed = sessionSchema.parse(await response.json())
    await save(renewed, expectedGeneration)
    return renewed.access_token
  }

  function accessToken(): Promise<string> {
    if (lifetime.signal.aborted) return Promise.reject(new Error('Organization session disposed'))
    if (pending !== undefined) return pending
    pending = resolve().finally(() => { pending = undefined })
    return pending
  }

  ctx.effect(() => {
    const renew = async () => {
      try { if (await stored()) await accessToken() }
      catch (error) { if (!lifetime.signal.aborted) ctx.logger('managed-session').warn(String(error)) }
    }
    let background: Promise<void> | undefined
    const start = () => { background ??= renew().finally(() => { background = undefined }) }
    const timer = setInterval(start, timing.pollMs)
    start()
    return async () => { clearInterval(timer); lifetime.abort(); await background; await pending?.catch(() => {}) }
  })

  return {
    accessToken,
    storeSession: async (value: PersistentSessionTokens) => { generation++; await save(sessionSchema.parse(value), generation) },
    clearSession: clear,
  }
}
