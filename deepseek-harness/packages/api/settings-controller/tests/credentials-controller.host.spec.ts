import { installPersistentSession } from '../../../llm/llm-managed-backend/src/persistent-session.ts'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import CredentialsController from '../src/credentials.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import WorkspaceRegistry from '../../../workspace/workspace/src/index.ts'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

/** A store whose `describe` carries more than the view declares, as a foreign provider might. */
class LeakyCredentials extends MemoryCredentials {
  override describe(): Promise<CredentialInfo> {
    return Promise.resolve(
      { configured: true, source: 'memory', writable: true, value: 'sk-leaked' } as CredentialInfo,
    )
  }
}

/** A store whose write rejects with a bare string, the way some client libraries do. */
class LiteralRejectingCredentials extends MemoryCredentials {
  override async set(): Promise<void> {
    throw 'the store refused'
  }
}

/** A store whose provider-owned policy rejects an otherwise valid write. */
class RejectingCredentials extends MemoryCredentials {
  override set(): Promise<void> {
    return Promise.reject(new Error('a read-only source shadows this reference'))
  }
}

async function boot(
  seed: Record<string, string> = {},
  provider: typeof MemoryCredentials = MemoryCredentials,
): Promise<CredentialsController> {
  const ctx = new Context()
  await ctx.plugin(provider, seed)
  await ctx.plugin(CredentialsController)
  return ctx.credentialsController
}

describe('the credentials Remote namespace a configuration surface calls', () => {
  it('publishes the credentials namespace from its own service key', async () => {
    const controller = await boot()
    const binding = controller.typertRemote
    expect(binding.serviceKey).toBe('credentialsController')
    expect(binding.namespace).toBe('credentials')
    expect(remoteMethods(controller)).toEqual([
      { method: 'describe', invocation: { kind: 'direct' } },
      { method: 'set', invocation: { kind: 'direct' } },
      { method: 'unset', invocation: { kind: 'direct' } },
      { method: 'managedStatus', invocation: { kind: 'direct' } },
      { method: 'managedLogin', invocation: { kind: 'direct' } },
      { method: 'managedCasConfig', invocation: { kind: 'direct' } },
      { method: 'managedCasStart', invocation: { kind: 'direct' } },
      { method: 'managedCasPoll', invocation: { kind: 'direct' } },
      { method: 'managedLogout', invocation: { kind: 'direct' } },
    ])
  })

  it('reports the actionable configuration error while no credential provider is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(CredentialsController)
    for (const call of [
      () => ctx.credentialsController.describe(['DEEPSEEK_API_KEY']),
      () => ctx.credentialsController.set('DEEPSEEK_API_KEY', 'sk-live'),
      () => ctx.credentialsController.unset('DEEPSEEK_API_KEY'),
    ]) {
      const failure = await call().catch((error: unknown) => error)
      expect(remoteErrorOf(failure)).toMatchObject({
        code: 'gateway/internal',
        message: 'credentials service is absent: this deployment does not mount a credential provider (e.g. @deepseek-ai/dsh-credentials-local) in its composition',
        details: {},
      })
    }
  })

  it('describes a batch of references as one map, values excluded', async () => {
    const controller = await boot({ DEEPSEEK_API_KEY: 'sk-seeded' })
    const described = await controller.describe(['DEEPSEEK_API_KEY', 'OPENAI_API_KEY'])
    expect(described).toEqual({
      DEEPSEEK_API_KEY: { configured: true, source: 'memory', writable: true },
      OPENAI_API_KEY: { configured: false, writable: true },
    })
    expect(JSON.stringify(described)).not.toContain('sk-seeded')
  })

  it('reports an invalid reference as bad-request', async () => {
    const controller = await boot()
    for (const call of [
      () => controller.describe(['DEEPSEEK_API_KEY', 'not a var']),
      () => controller.set('not a var', 'sk-live'),
      () => controller.unset('not a var'),
    ]) {
      const failure = await call().catch((error: unknown) => error)
      expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/bad-request' })
    }
  })

  it('answers the largest batch it accepts and reports one reference more as bad-request', async () => {
    const controller = await boot()
    const accepted = Array.from({ length: 64 }, (_unused, index) => `REF_${String(index)}`)
    expect(Object.keys(await controller.describe(accepted))).toHaveLength(64)
    const failure = await controller.describe([...accepted, 'REF_64']).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/bad-request' })
  })

  it('answers only the fields the view declares, whatever a provider returns', async () => {
    const controller = await boot({}, LeakyCredentials)
    const described = await controller.describe(['DEEPSEEK_API_KEY'])
    expect(described.DEEPSEEK_API_KEY).toEqual({ configured: true, source: 'memory', writable: true })
    expect(JSON.stringify(described)).not.toContain('sk-leaked')
  })

  it('stores and removes through the same references the batch describes', async () => {
    const controller = await boot()
    await controller.set('DEEPSEEK_API_KEY', 'sk-live')
    expect(await controller.describe(['DEEPSEEK_API_KEY']))
      .toEqual({ DEEPSEEK_API_KEY: { configured: true, source: 'memory', writable: true } })
    await controller.unset('DEEPSEEK_API_KEY')
    expect(await controller.describe(['DEEPSEEK_API_KEY']))
      .toEqual({ DEEPSEEK_API_KEY: { configured: false, writable: true } })
  })

  it('reports a refused write as credential/rejected naming only the reference', async () => {
    const controller = await boot({}, RejectingCredentials)
    const failure = await controller.set('DEEPSEEK_API_KEY', 'sk-live').catch((error: unknown) => error)
    const { code, message, details } = remoteErrorOf(failure) ?? {}
    expect(code).toBe('credential/rejected')
    expect(message).toContain('read-only source')
    expect(details).toEqual({ ref: 'DEEPSEEK_API_KEY' })
  })

  it('reports an empty value as bad-request', async () => {
    const controller = await boot()
    const failure = await controller.set('DEEPSEEK_API_KEY', '').catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/bad-request' })
  })

  it('stringifies a refusal that is not an Error', async () => {
    const controller = await boot({}, LiteralRejectingCredentials)
    const failure = await controller.set('DEEPSEEK_API_KEY', 'sk-live').catch((error: unknown) => error)
    expect(remoteErrorOf(failure)?.message).toBe('the store refused')
  })
})

describe('managed login profile binding', () => {
  const endpoint = 'https://aigc.example.com'
  const oldId = '11111111-1111-4111-8111-111111111111'
  const newId = '22222222-2222-4222-8222-222222222222'
  const token = 'a'.repeat(64)
  const key = credentialKey('llm-managed-backend', 'device-user')

  async function fixture(boundUsername: string, internal = false, persistent = false, restricted = false) {
    const home = await mkdtemp(join(tmpdir(), 'dsh-managed-binding-'))
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials)
    ctx.provide('managedBackend', { endpoint })
    if (restricted) {
      await ctx.plugin(Storage)
      ctx.storage.backend.register('memory', new MemoryStorageBackend())
      const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
      ctx.storage.mount('domain', facility)
      ctx.provide('storageDomain', facility)
      ctx.provide('sessionPersistence', { list: async () => [] } as never)
      ctx.provide('sessions', { list: () => [] } as never)
      await ctx.plugin(WorkspaceRegistry, { allowedRoot: join(home, 'wanzaiwork') })
    } else ctx.provide('workspaceRegistry', {
      resolveByPath: async () => ({ id: 'workspace-1' }),
      create: async () => ({ id: 'workspace-1' }),
    } as never)
    await ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { id: oldId, username: boundUsername } }))
    const request: typeof fetch = async input => {
      const path = new URL(String(input)).pathname
      const data = path === '/v1/auth/login' || path.startsWith('/v1/auth/cas/device/')
        ? { access_token: token, user: { id: newId, username: 'wh00028' }, ...(persistent ? { refresh_token: 'b'.repeat(64), expires_at: '2099-01-01T00:00:00Z' } : {}) }
        : path === '/v1/auth/me' ? { user: { id: newId, username: 'wh00028' } }
          : { models: [], ...(internal ? { additionalModels: [{ id: '33333333-3333-4333-8333-333333333333', name: 'MiniMax', provider: 'managed-internal' }] } : {}) }
      return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (persistent) Object.assign(ctx.managedBackend, installPersistentSession(ctx, endpoint, credentialKey('llm-managed-backend', 'user-session'), request))
    return { ctx, home, controller: new CredentialsController(ctx, {}, { request, home: () => home }),
      dispose: async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) } }
  }

  it.each(['local', 'sso'] as const)('reuses the restricted root for %s login and status without creating an account directory', async source => {
    const test = await fixture('WH00028', false, false, true)
    try {
      const root = join(test.home, 'wanzaiwork')
      const initial = await test.ctx.workspaceRegistry.initializeDefault(async () => ({ path: root, title: 'Default workspace' }))
      const state = source === 'local' ? await test.controller.managedLogin('wh00028', 'password')
        : await test.controller.managedCasPoll('b'.repeat(64))
      expect(state).toMatchObject({ workspacePath: root })
      expect(state).toMatchObject({ workspaceId: initial!.id })
      if (state === null || !state.enabled || state.user === null) throw new Error('Expected managed login to be enabled')
      const repeated = await test.controller.managedStatus()
      expect(repeated).toMatchObject({ workspacePath: root, workspaceId: state.workspaceId })
      await expect(access(join(test.home, 'workspaces', 'bhss-wh00028-workspace'))).rejects.toThrow()
    } finally { await test.dispose() }
  })

  it.each(['local', 'sso'] as const)('creates the restricted root on first %s login and reuses it on recovery', async source => {
    const test = await fixture('WH00028', false, false, true)
    try {
      const state = source === 'local' ? await test.controller.managedLogin('wh00028', 'password')
        : await test.controller.managedCasPoll('b'.repeat(64))
      expect(state).toMatchObject({ workspacePath: join(test.home, 'wanzaiwork') })
      if (state === null || !state.enabled || state.user === null) throw new Error('Expected managed login to be enabled')
      expect(await test.controller.managedStatus()).toMatchObject({ workspaceId: state.workspaceId })
      await expect(access(join(test.home, 'workspaces'))).rejects.toThrow()
    } finally { await test.dispose() }
  })

  it.each(['local', 'sso'] as const)('persists the %s login and clears both tokens on manual logout', async source => {
    const test = await fixture('WH00028', false, true)
    try {
      if (source === 'local') await test.controller.managedLogin('wh00028', 'password')
      else await test.controller.managedCasPoll('b'.repeat(64))
      expect(await test.ctx.credentials.readRecord(credentialKey('llm-managed-backend', 'persistent-session'))).toMatchObject({
        kind: 'grant', payload: { access_token: token, refresh_token: 'b'.repeat(64) },
      })
      expect(await test.controller.managedStatus()).toMatchObject({ user: { username: 'wh00028' } })
      await test.controller.managedLogout()
      expect(await test.ctx.credentials.readRecord(credentialKey('llm-managed-backend', 'persistent-session'))).toBeUndefined()
      expect(await test.ctx.credentials.readRecord(credentialKey('llm-managed-backend', 'user-session'))).toBeUndefined()
      expect(await test.controller.managedStatus()).toEqual({ enabled: true, user: null })
    } finally { await test.dispose() }
  })

  it.each(['local', 'sso'] as const)('keeps %s authentication when the workspace path is blocked by a file', async source => {
    const test = await fixture('WH00028', false, true, true)
    try {
      await writeFile(join(test.home, 'wanzaiwork'), 'user owned file')
      const state = source === 'local' ? await test.controller.managedLogin('wh00028', 'password')
        : await test.controller.managedCasPoll('b'.repeat(64))
      expect(state).toMatchObject({ enabled: true, user: { username: 'wh00028' }, workspaceIssue: 'unavailable' })
      expect(await test.controller.managedStatus()).toMatchObject({ user: { username: 'wh00028' }, workspaceIssue: 'unavailable' })
      await rm(join(test.home, 'wanzaiwork'))
      expect(await test.controller.managedStatus()).toMatchObject({ user: { username: 'wh00028' }, workspaceId: expect.any(String) })
    } finally { await test.dispose() }
  })

  it('recreates a manually deleted workspace without losing SSO authentication', async () => {
    const test = await fixture('WH00028', false, true, true)
    try {
      const initial = await test.controller.managedCasPoll('b'.repeat(64))
      await rm(join(test.home, 'wanzaiwork'), { recursive: true })
      expect(await test.controller.managedStatus()).toMatchObject({ user: { username: 'wh00028' }, workspaceId: initial && initial.enabled && initial.user !== null ? initial.workspaceId : undefined })
    } finally { await test.dispose() }
  })

  it.each(['local', 'sso'] as const)('stress: %s login survives 200 workspace deletion and blocking-file cycles', async source => {
    const test = await fixture('WH00028', false, true, true)
    const root = join(test.home, 'wanzaiwork')
    try {
      for (let round = 0; round < 200; round++) {
        await rm(root, { recursive: true, force: true })
        const blocked = round % 3 === 0
        if (blocked) await writeFile(root, 'preserve this user file')
        const state = source === 'local' ? await test.controller.managedLogin('wh00028', 'password')
          : await test.controller.managedCasPoll('b'.repeat(64))
        expect(state, `login cycle ${round}`).toMatchObject({ enabled: true, user: { username: 'wh00028' } })
        expect(await test.controller.managedStatus(), `status cycle ${round}`).toMatchObject({ user: { username: 'wh00028' } })
        if (blocked) {
          expect(state).toMatchObject({ workspaceIssue: 'unavailable' })
          await rm(root)
          expect(await test.controller.managedStatus()).toMatchObject({ user: { username: 'wh00028' }, workspaceId: expect.any(String) })
        }
      }
      expect(test.ctx.workspaceRegistry.list()).toHaveLength(1)
    } finally { await test.dispose() }
  }, 60_000)

  it('stress: 100 concurrent SSO completions converge on one user and workspace', async () => {
    const test = await fixture('WH00028', false, true, true)
    try {
      const states = await Promise.all(Array.from({ length: 100 }, () => test.controller.managedCasPoll('b'.repeat(64))))
      for (const state of states) expect(state).toMatchObject({ user: { username: 'wh00028' }, workspaceId: expect.any(String) })
      expect(test.ctx.workspaceRegistry.list()).toHaveLength(1)
      expect(await test.controller.managedStatus()).toMatchObject({ user: { username: 'wh00028' } })
    } finally { await test.dispose() }
  }, 60_000)

  it('rebinds a fresh database id after the same employee proves their password', async () => {
    const test = await fixture('WH00028')
    try {
      const state = await test.controller.managedLogin('wh00028', 'password')
      expect(state.enabled && state.user?.id).toBe(newId)
      expect(await test.ctx.credentials.readRecord(key)).toMatchObject({
        kind: 'grant', payload: { id: newId, username: 'wh00028' },
      })
      expect(await test.controller.managedStatus()).toMatchObject({ user: { id: newId } })
    } finally { await test.dispose() }
  })

  it('includes local-only grants in the signed-in state without a LiteLLM model', async () => {
    const test = await fixture('WH00028', true)
    try {
      const state = await test.controller.managedLogin('wh00028', 'password')
      expect(state).toMatchObject({ models: [{ name: 'MiniMax', provider: 'managed-internal' }] })
    } finally { await test.dispose() }
  })

  it('keeps a different employee bound even after the backend authenticates the new account', async () => {
    const test = await fixture('wa00038')
    try {
      const failure = await test.controller.managedLogin('wh00028', 'password').catch((error: unknown) => error)
      expect(remoteErrorOf(failure)).toMatchObject({
        code: 'managed-auth/rejected', details: { reason: 'device-binding' },
      })
      expect(await test.ctx.credentials.readRecord(key)).toMatchObject({ payload: { id: oldId, username: 'wa00038' } })
    } finally { await test.dispose() }
  })
})
