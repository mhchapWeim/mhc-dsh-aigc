import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { type StreamChunk } from '@deepseek-ai/dsh-llm'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import * as PiAi from '../../llm-pi-ai/src/index.ts'
import * as Managed from '../src/index.ts'

it('applies per-user grants through real Loader services and keeps custom calls independent from platform billing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-custom-models-'))
  const ctx = new Context()
  let allowed = false
  let revision = 1
  let events: ReadableStreamDefaultController<Uint8Array> | undefined
  const calls: {url: string; init?: RequestInit}[] = []
  const userId = '10000000-0000-4000-8000-000000000001'
  const send = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const target = String(url)
    calls.push({url: target, ...init === undefined ? {} : {init}})
    if (target.includes('/v1/config/versions')) return Response.json({schemaVersion: 1, userId, revision})
    if (target.includes('/v1/config/snapshot')) return Response.json({schemaVersion: 1, userId, revision,
      offerId: '10000000-0000-4000-8000-000000000002', domains: ['models', 'billing', 'access'], capabilities: {allowCustomModels: allowed}, models: [],
      billing: {assigned: true, planName: 'plan', source: 'User', total: 1000, used: 0, reserved: 0, remaining: 1000, weekStart: '2026-11-01T16:00:00Z', resetsAt: '2026-11-08T16:00:00Z'}})
    if (target.includes('/v1/config/applied')) return new Response(null, {status: 204})
    if (target.endsWith('/v1/config/events')) return new Response(new ReadableStream({start(controller) {
      events = controller
      init?.signal?.addEventListener('abort', () => { try { controller.close() } catch { /* already closed */ } }, {once: true})
    }}), {headers: {'content-type': 'text/event-stream'}})
    if (target.endsWith('/v1/models')) return Response.json({connection: {api: 'openai-completions', baseURL: 'https://platform.test/v1', apiKey: 'platform-key'}, models: [{id: 'same-model', name: '同名模型', input: ['text']}]})
    if (target.endsWith('/v1/billing/quota')) return Response.json({assigned: true, total: 1000, used: 0, reserved: 0, remaining: 1000, resetsAt: '2026-11-08T16:00:00Z'})
    if (target.endsWith('/v1/billing/reservations')) return Response.json({id: 'r', status: 'Pending'})
    if (target.includes('/v1/billing/reservations/')) return Response.json({id: 'r', status: 'Settled'})
    expect(['https://custom.test/v1/chat/completions', 'https://platform.test/v1/chat/completions']).toContain(target)
    expect(new Headers(init?.headers).get('authorization')).toBe(target.includes('custom.test') ? 'Bearer personal-key' : 'Bearer platform-key')
    return new Response([
      `data: ${JSON.stringify({id: 'reply', choices: [{index: 0, delta: {role: 'assistant', content: target.includes('custom.test') ? '自定义直连成功' : '平台调用成功'}, finish_reason: null}]})}`,
      'data: {"id":"reply","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}',
      'data: [DONE]', '',
    ].join('\n\n'), {headers: {'content-type': 'text/event-stream'}})
  })
  try {
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-llm-managed-backend', Managed],
      ['@deepseek-ai/dsh-llm-pi-ai', PiAi],
      ['test-credentials', {apply: (scope: Context) => { new MemoryCredentials(scope, {CUSTOM_API_KEY: 'personal-key'}) }}],
    ])
    for (const name of modules.keys()) {
      const dir = join(root, 'node_modules', ...name.split('/')); await mkdir(dir, {recursive: true})
      await writeFile(join(dir, 'package.json'), JSON.stringify({name, version: '0.1.0', type: 'module'}))
    }
    const path = join(root, 'cordis.yml')
    await writeFile(path, `
- id: llm
  name: '@deepseek-ai/dsh-llm'
- id: credentials
  name: test-credentials
- id: managed
  name: '@deepseek-ai/dsh-llm-managed-backend'
  config:
    baseURL: http://aigc.test
    allowInsecureHTTP: true
    tokenKey: user-session
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      personal:
        displayName: Personal
        api: openai-completions
        baseURL: https://custom.test/v1
        apiKeyEnv: CUSTOM_API_KEY
        models:
          - id: same-model
            name: 同名模型
`)
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader); ctx.loader.builtins.include = Include
    ctx.loader.internal = {version: 'v2', async import(name: string) {
      if (!modules.has(name)) throw new Error(`Unexpected import ${name}`)
      return modules.get(name)
    }} as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({name: 'cordis:include', config: {path: pathToFileURL(path).href}}); await ctx.loader.await()
    for (const entry of ctx.loader.entries()) if (entry.fiber) await entry.fiber.await()
    await ctx.credentials.modifyRecord(credentialKey('llm-managed-backend', 'user-session'), async () => ({kind: 'api-key', key: 'test-session-token'}))
    await vi.waitFor(() => expect(ctx.managedBackend.configuration?.revision).toBe(1), {timeout: 5000})
    expect(ctx.llm.listProviders().map(x => x.id)).toEqual(['managed'])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
    expect(() => ctx.llm.assertConfigurationAccess('llm-pi-ai')).toThrow()
    await expect(ctx.llm.discoverModels('llm-pi-ai', {baseURL: 'https://custom.test/v1', api: 'openai-completions'})).rejects.toMatchObject({code: 'MODEL_UNAUTHORIZED'})
    await expect(ctx.llm.prepareCall({provider: 'personal', model: 'same-model'})).rejects.toMatchObject({code: 'MODEL_UNAUTHORIZED'})

    allowed = true; revision++
    events!.enqueue(new TextEncoder().encode('event: config.changed\ndata: {}\n\n'))
    await vi.waitFor(() => expect(ctx.llm.listProviders()).toContainEqual({id: 'personal', name: 'Personal', source: 'custom'}), {timeout: 5000})
    expect(ctx.llm.listConfigurableProviders().some(x => x.provider === 'personal')).toBe(true)
    const generate = async (provider: string) => {
      const prepared = await ctx.llm.prepareCall({provider, model: 'same-model'})
      const result: StreamChunk[] = []
      for await (const chunk of prepared.stream({...prepared.config, messages: []})) result.push(chunk)
      return result
    }
    calls.length = 0
    expect(await generate('personal')).toContainEqual(expect.objectContaining({type: 'text-delta', text: '自定义直连成功'}))
    expect(calls.filter(x => /\/v1\/(models|billing)/u.test(x.url))).toEqual([])
    expect(await generate('managed')).toContainEqual(expect.objectContaining({type: 'text-delta', text: '平台调用成功'}))
    expect(calls.some(x => x.url.endsWith('/v1/billing/reservations'))).toBe(true)
    calls.length = 0
    expect(await generate('personal')).toContainEqual(expect.objectContaining({type: 'text-delta', text: '自定义直连成功'}))
    expect(calls.filter(x => /\/v1\/(models|billing)/u.test(x.url))).toEqual([])

    const prepared = await ctx.llm.prepareCall({provider: 'personal', model: 'same-model'})
    allowed = false; revision++
    events!.enqueue(new TextEncoder().encode('event: config.changed\ndata: {}\n\n'))
    await vi.waitFor(() => expect(ctx.llm.listProviders().some(x => x.id === 'personal')).toBe(false), {timeout: 5000})
    expect(() => prepared.stream({...prepared.config, messages: []})).toThrow()
    expect(() => ctx.llm.stream({provider: 'personal', model: 'same-model', messages: []})).toThrow()
    expect((await ctx.credentials.resolve(credentialRef('CUSTOM_API_KEY')))?.value).toBe('personal-key')
  } finally {
    await ctx.fiber.dispose(); send.mockRestore(); await rm(root, {recursive: true, force: true})
  }
}, 20000)
