import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import * as ManagedBackend from '../src/index.ts'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import * as InternalModel from '../../../../../plugins/dsh-plugin-internal-model/src/index.js'

it('mounts and withdraws the managed provider through a Loader composition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-composition-'))
  const ctx = new Context()
  try {
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: llm',
      "  name: '@deepseek-ai/dsh-llm'",
      '- id: credentials',
      "  name: 'test-credentials'",
      '- id: managed',
      "  name: '@deepseek-ai/dsh-llm-managed-backend'",
      '  config:',
      '    baseURL: http://models.example.test',
      '    allowInsecureHTTP: true',
      '    tokenKey: user-session',
      '- id: internal',
      "  name: '@bhss/dsh-plugin-internal-model'",
      '  config:',
      '    contextWindow: 16384',
      '',
    ].join('\n'))
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['test-credentials', { apply: (scope: Context) => { new MemoryCredentials(scope) } }],
      ['@deepseek-ai/dsh-llm-managed-backend', ManagedBackend],
      ['@bhss/dsh-plugin-internal-model', InternalModel],
    ])
    for (const packageName of modules.keys()) {
      const packageDir = join(root, 'node_modules', ...packageName.split('/'))
      await mkdir(packageDir, { recursive: true })
      await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({ name: packageName, version: '0.1.0', type: 'module' })}\n`)
    }
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled))
      .toEqual([])
    const llm = ctx.llm
    await [...ctx.loader.entries()].find(entry => entry.options.id === 'credentials')!.fiber!.await()
    await [...ctx.loader.entries()].find(entry => entry.options.id === 'managed')!.fiber!.await()
    expect(llm.listProviders().map(provider => provider.id)).toEqual(['managed', 'managed-internal'])
    expect(ctx.get('managedBackend')?.endpoint).toBe('http://models.example.test')
    expect(ctx.managedBackend.accessToken).toBeTypeOf('function')
    expect(ctx.managedBackend.storeSession).toBeTypeOf('function')
    expect(ctx.managedBackend.clearSession).toBeTypeOf('function')
    expect(await llm.listModels('managed')).toEqual([])
    await expect(llm.resolveModelInfo('managed', 'team-small')).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    await ctx.credentials.modifyRecord(credentialKey('llm-managed-backend', 'user-session'), async () => ({ kind: 'api-key', key: 'user-session-token' }))
    const id = '11111111-1111-1111-1111-111111111111'
    let connectionCalls = 0
    let revoked = false
    const send = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const target = String(url)
      if (target.startsWith('http://models.example.test/')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer user-session-token')
        expect(init?.redirect).toBe('error')
        if (target.endsWith('/v1/feedback')) {
          const body = JSON.parse(String(init?.body))
          expect(body).toMatchObject({ sessionId: 'feedback-session', text: 'remark', category: 'other' })
          expect(body.sessionLog).toContain('feedback/record')
          return revoked ? new Response('', { status: 401 }) : Response.json({ id: 'stored' })
        }
        if (revoked) return new Response('', { status: 403 })
        if (target.endsWith('/connection')) {
          connectionCalls++
          return Response.json({ modelIdentifier: 'MiniMax', baseURL: 'https://internal.example/v1', apiKey: 'test-internal-key',
            authType: 'Bearer', apiKeyHeader: 'X-API-Key', supportsTools: true, temperature: 0.3, maxTokens: 1024, timeoutSeconds: 30 })
        }
        return Response.json({ models: [{ id, name: '内部 MiniMax' }] })
      }
      expect(target).toBe('https://internal.example/v1/chat/completions')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-internal-key')
      const body = JSON.parse(String(init?.body)) as { model: string; temperature: number }
      expect(body.model).toBe('MiniMax')
      expect(body.temperature).toBe(0.3)
      return new Response([
        'data: {"id":"reply","choices":[{"index":0,"delta":{"role":"assistant","content":"内网直连成功"},"finish_reason":null}]}',
        'data: {"id":"reply","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]', '',
      ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })
    })
    try {
      const feedbackSession = Session.create(SessionId('feedback-session'))
      feedbackSession.append('feedback/record', { text: 'earlier remark' })
      await ctx.feedbackDelivery.submit(feedbackSession, { text: 'remark', category: 'other' })
      revoked = true
      await expect(ctx.feedbackDelivery.submit(feedbackSession, { text: 'remark', category: 'other' })).rejects.toMatchObject({ code: 'AUTH' })
      revoked = false
      expect(await llm.listModels('managed-internal')).toMatchObject([{ id, name: '内部 MiniMax' }])
      expect(connectionCalls).toBe(0)
      const chunks: StreamChunk[] = []
      for await (const chunk of llm.stream({ provider: 'managed-internal', model: id, messages: [] })) chunks.push(chunk)
      expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: '内网直连成功' }))
      expect(connectionCalls).toBe(1)
      revoked = true
      await expect(ctx.llm.prepareCall({ provider: 'managed-internal', model: id })).rejects.toMatchObject({ code: 'MODEL_UNAUTHORIZED' })
      await [...ctx.loader.entries()].find(entry => entry.options.id === 'internal')!.fiber!.dispose()
      expect(llm.listProviders().map(provider => provider.id)).toEqual(['managed'])
      expect(() => llm.stream({ provider: 'managed-internal', model: id, messages: [] })).toThrow()
      await ctx.managedBackend.clearSession!()
      await ctx.credentials.modifyRecord(credentialKey('llm-managed-backend', 'user-session'), async () => ({ kind: 'api-key', key: 'user-session-token' }))
      revoked = false
      const reloaded = await ctx.plugin(InternalModel, { contextWindow: 16384 })
      expect(await llm.listModels('managed-internal')).toMatchObject([{ id, name: '内部 MiniMax' }])
      const afterLogin: StreamChunk[] = []
      for await (const chunk of llm.stream({ provider: 'managed-internal', model: id, messages: [] })) afterLogin.push(chunk)
      expect(afterLogin).toContainEqual(expect.objectContaining({ type: 'text-delta', text: '内网直连成功' }))
      await reloaded.dispose()
    } finally { send.mockRestore() }
    let directCalls = 0
    llm.registerAdapter(['ordinary'], new class extends LlmAdapter {
      async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        directCalls++
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    expect(() => llm.stream({ provider: 'ordinary', model: 'local', messages: [] }))
      .toThrow('organization mode permits only backend-granted models')
    expect(directCalls).toBe(0)
    await [...ctx.loader.entries()].find(entry => entry.options.id === 'managed')!.fiber!.dispose()
    expect(ctx.get('managedBackend')).toBeUndefined()
    expect(ctx.get('feedbackDelivery')).toBeUndefined()
    for await (const _chunk of llm.stream({ provider: 'ordinary', model: 'local', messages: [] })) { /* drain */ }
    expect(directCalls).toBe(1)
    await ctx.fiber.dispose()
    expect(llm.listProviders()).toEqual([])
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
