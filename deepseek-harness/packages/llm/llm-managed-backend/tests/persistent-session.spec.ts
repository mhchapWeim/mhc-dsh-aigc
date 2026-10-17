import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { installPersistentSession } from '../src/persistent-session.ts'
import { Config } from '../src/index.ts'

const accessKey = credentialKey('llm-managed-backend', 'user-session')
const refreshKey = credentialKey('llm-managed-backend', 'persistent-session')
const expired = { access_token: 'a'.repeat(64), refresh_token: 'b'.repeat(64), expires_at: '2020-01-01T00:00:00Z' }
const renewed = { ...expired, access_token: 'c'.repeat(64), expires_at: '2099-01-01T00:00:00Z' }

async function fixture(request: typeof fetch) {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  const session = installPersistentSession(ctx, 'https://aigc.test', accessKey, request)
  return { ctx, session }
}

describe('persistent organization login', () => {
  it('defaults omitted timing fields and rejects unusable timer values at configuration load', () => {
    expect(Config(JSON.parse('{"sessionTiming":{"pollMs":120000}}')).sessionTiming).toEqual({
      renewBeforeMs: 300_000, pollMs: 120_000, requestTimeoutMs: 10_000,
    })
    for (const value of [0, -1, 1.5, 2_147_483_648]) {
      expect(() => Config({ sessionTiming: { renewBeforeMs: 300_000, pollMs: 60_000, requestTimeoutMs: value } })).toThrow()
    }
  })

  it('renews with timing resolved by the plugin configuration when timing is omitted', async () => {
    const config = Config({ baseURL: 'https://aigc.test', tokenKey: 'user-session' })
    expect(config.sessionTiming).toEqual({ renewBeforeMs: 300_000, pollMs: 60_000, requestTimeoutMs: 10_000 })
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials)
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return Response.json(renewed)
    })
    try {
      const session = installPersistentSession(ctx, 'https://aigc.test', accessKey, request, config.sessionTiming)
      await session.storeSession(expired)
      expect(await session.accessToken()).toBe(renewed.access_token)
    } finally { await ctx.fiber.dispose() }
  })

  it('renews expired sessions once for concurrent callers and stores the new access token', async () => {
    const request = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe('https://aigc.test/v1/auth/refresh')
      expect(init?.redirect).toBe('error')
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${expired.refresh_token}`)
      return Response.json(renewed)
    })
    const { ctx, session } = await fixture(request)
    try {
      await session.storeSession(expired)
      expect(await Promise.all([session.accessToken(), session.accessToken()])).toEqual([renewed.access_token, renewed.access_token])
      expect(request).toHaveBeenCalledOnce()
      expect(await ctx.credentials.readRecord(accessKey)).toEqual({ kind: 'api-key', key: renewed.access_token })
    } finally { await ctx.fiber.dispose() }
  })

  it('preserves the persistent grant on network failure and retries successfully', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(Response.json(renewed))
    const { ctx, session } = await fixture(request)
    try {
      await session.storeSession(expired)
      await expect(session.accessToken()).rejects.toThrow('offline')
      expect(await ctx.credentials.readRecord(refreshKey)).toMatchObject({ payload: expired })
      expect(await session.accessToken()).toBe(renewed.access_token)
    } finally { await ctx.fiber.dispose() }
  })

  it('removes revoked sessions and never restores a login after concurrent manual sign-out', async () => {
    const gate = Promise.withResolvers<Response>()
    const request = vi.fn<typeof fetch>(() => gate.promise)
    const { ctx, session } = await fixture(request)
    try {
      await session.storeSession(expired)
      const pending = session.accessToken()
      const rejected = expect(pending).rejects.toThrow('Organization session changed')
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
      expect(await session.clearSession()).toBe(expired.refresh_token)
      gate.resolve(Response.json(renewed))
      await rejected
      expect(await ctx.credentials.readRecord(refreshKey)).toBeUndefined()
      expect(await ctx.credentials.readRecord(accessKey)).toBeUndefined()
      request.mockResolvedValueOnce(new Response('', { status: 401 }))
      await session.storeSession(expired)
      await expect(session.accessToken()).rejects.toMatchObject({ code: 'AUTH' })
      expect(await ctx.credentials.readRecord(refreshKey)).toBeUndefined()
    } finally { gate.resolve(Response.json(renewed)); await ctx.fiber.dispose() }
  })

  it('recovers the active token mirror from the durable grant after restart', async () => {
    const request = vi.fn<typeof fetch>()
    const { ctx, session } = await fixture(request)
    try {
      await ctx.credentials.modifyRecord(refreshKey, async () => ({ kind: 'grant', payload: renewed }))
      expect(await session.accessToken()).toBe(renewed.access_token)
      expect(await ctx.credentials.readRecord(accessKey)).toMatchObject({ key: renewed.access_token })
      expect(request).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })
})


it('restores the durable login from disk in a new Host and stays signed out after manual logout', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-persistent-restart-'))
  const request = vi.fn<typeof fetch>(async () => Response.json(renewed))
  const boot = async () => {
    const ctx = new Context()
    await ctx.plugin(LocalCredentials, { path: join(home, 'credentials.yaml'), dshHome: home, watch: false })
    return { ctx, session: installPersistentSession(ctx, 'https://aigc.test', accessKey, request) }
  }
  let active: Context | undefined
  try {
    const first = await boot(); active = first.ctx
    await first.session.storeSession(expired)
    await first.ctx.fiber.dispose(); active = undefined
    const reopened = await boot(); active = reopened.ctx
    expect(await reopened.session.accessToken()).toBe(renewed.access_token)
    expect(await reopened.session.clearSession()).toBe(expired.refresh_token)
    await reopened.ctx.fiber.dispose(); active = undefined
    const afterLogout = await boot(); active = afterLogout.ctx
    await expect(afterLogout.session.accessToken()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(request).toHaveBeenCalledOnce()
  } finally { await active?.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})
