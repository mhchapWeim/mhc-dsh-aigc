import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { Config, InternalModelAdapter } from '../../../../../plugins/dsh-plugin-internal-model/src/index.js'

afterEach(() => vi.restoreAllMocks())
const id = '11111111-1111-1111-1111-111111111111'
async function setup(generationTimeoutSeconds?: number, streamIdleTimeoutSeconds?: number) {
  const ctx = new Context()
  const credentials = new MemoryCredentials(ctx)
  ctx.provide('managedBackend', { endpoint: 'https://aigc.example' })
  await credentials.modifyRecord(credentialKey('llm-managed-backend', 'user-session'), async () => ({ kind: 'api-key', key: 'session-token' }))
  return { ctx, adapter: new InternalModelAdapter(ctx, { ...(streamIdleTimeoutSeconds === undefined ? {} : { streamIdleTimeoutSeconds }), ...(generationTimeoutSeconds === undefined ? {} : { generationTimeoutSeconds }), requestTimeoutMs: 1000, contextWindow: 16384, maxOutputTokens: 1024 }) }
}

it.each(['Bearer', 'Header', 'None'])('streams tool calls with %s auth without forwarding the AIGC session', async authType => {
  const { ctx, adapter } = await setup()
  const send = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).startsWith('https://aigc.example/')) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer session-token')
      if (String(url).endsWith('/connection')) return Response.json({ modelIdentifier: 'MiniMax', baseURL: 'https://gpu.example/v1',
        apiKey: authType === 'None' ? '' : 'internal-secret', authType, apiKeyHeader: 'X-API-Key', supportsTools: true,
        temperature: 0.3, maxTokens: 512, timeoutSeconds: 30 })
      return Response.json({ models: [{ id, name: 'MiniMax 内网' }] })
    }
    expect(String(url)).toBe('https://gpu.example/v1/chat/completions')
    expect(init?.redirect).toBe('error')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe(authType === 'Bearer' ? 'Bearer internal-secret' : null)
    expect(headers.get('x-api-key')).toBe(authType === 'Header' ? 'internal-secret' : null)
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'MiniMax', stream: true, tools: [{ type: 'function', function: { name: 'lookup' } }] })
    return new Response([
      'data: {"id":"r","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"query\\":\\"test\\"}"}}]},"finish_reason":null}]}',
      'data: {"id":"r","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]', '',
    ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })
  })
  try {
    const prepared = await adapter.prepareCall('managed-internal', id)
    expect(prepared.model.id).toBe(id)
    const chunks: StreamChunk[] = []
    for await (const chunk of prepared.stream({ provider: 'managed-internal', model: id, messages: [],
      tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } }],
    })) chunks.push(chunk)
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'finish', reason: { kind: 'tool-calls' } }))
    expect(chunks).toContainEqual(expect.objectContaining({ block: expect.objectContaining({ type: 'tool-call', name: 'lookup', arguments: '{"query":"test"}' }) }))
    expect(send).toHaveBeenCalledTimes(3)
  } finally { await ctx.fiber.dispose() }
})

it('rejects invalid connection metadata and canceled admission without sending upstream', async () => {
  const { ctx, adapter } = await setup()
  try {
    const send = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => Response.json(String(url).endsWith('/connection')
      ? { modelIdentifier: 'MiniMax', baseURL: 'file:///secret' } : { models: [{ id, name: 'MiniMax' }] }))
    await expect(adapter.prepareCall('managed-internal', id)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect(send).toHaveBeenCalledTimes(2)
    send.mockImplementation(async (_url, init) => {
      init?.signal?.throwIfAborted()
      throw new Error('unexpected')
    })
    const abort = new AbortController(); abort.abort()
    await expect(adapter.prepareCall('managed-internal', id, abort.signal)).rejects.toMatchObject({ code: 'ABORTED' })
  } finally { await ctx.fiber.dispose() }
})

it('does not reuse credentials from a prepared call for the next admission', async () => {
  const { ctx, adapter } = await setup()
  try {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 403 }))
    await expect(adapter.prepareCall('managed-internal', id)).rejects.toBeInstanceOf(LlmError)
    expect(await adapter.listModels()).toEqual([])
  } finally { await ctx.fiber.dispose() }
})

it.each([512, null])('exposes internal capacity and output budget to compaction (server max=%s)', async maxTokens => {
  const { ctx, adapter } = await setup()
  new LlmRuntime(ctx)
  ctx.llm.registerAdapter(['managed-internal'], adapter)
  const send = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => Response.json(String(url).endsWith('/connection')
    ? { modelIdentifier: 'MiniMax', baseURL: 'https://gpu.example/v1', apiKey: '', authType: 'None', apiKeyHeader: 'X-API-Key', supportsTools: true, temperature: 0.3, timeoutSeconds: 30, maxTokens }
    : { models: [{ id, name: 'MiniMax' }] }))
  try {
    const info = await ctx.llm.resolveModelInfo('managed-internal', id)
    expect(info).toMatchObject({ provider: 'managed-internal', id,
      context: { contextWindow: 16384 }, defaultMaxTokens: maxTokens ?? 1024 })
    const prepared = await adapter.prepareCall('managed-internal', id)
    expect(prepared.model.context).toEqual(info.context)
    expect(prepared.model.defaultMaxTokens).toBe(info.defaultMaxTokens)
    expect(send).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(info)).not.toContain('apiKey')
  } finally { await ctx.fiber.dispose() }
})

it.each(['Bearer', 'Header', 'None'])('discovers exact-model vLLM capacity with %s auth', async authType => {
  const { ctx } = await setup()
  const adapter = new InternalModelAdapter(ctx, { requestTimeoutMs: 1000, maxOutputTokens: 1024 })
  const send = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).startsWith('https://aigc.example/')) return Response.json(String(url).endsWith('/connection')
      ? { modelIdentifier: 'MiniMax', baseURL: 'https://gpu.example/v1/', apiKey: authType === 'None' ? '' : 'gpu-secret', authType, apiKeyHeader: 'X-GPU-Key', supportsTools: true, temperature: 0.3, timeoutSeconds: 30 }
      : { models: [{ id, name: 'MiniMax' }] })
    expect(String(url)).toBe('https://gpu.example/v1/models')
    expect(init?.redirect).toBe('error')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe(authType === 'Bearer' ? 'Bearer gpu-secret' : null)
    expect(headers.get('x-gpu-key')).toBe(authType === 'Header' ? 'gpu-secret' : null)
    expect(JSON.stringify([...headers])).not.toContain('session-token')
    return Response.json({ data: [{ id: 'other', max_model_len: 999999 }, { id: 'MiniMax', max_model_len: 65536 }] })
  })
  try {
    expect(Config({}).contextWindow).toBeUndefined()
    const info = await adapter.resolveModel('managed-internal', id)
    expect(info.context?.contextWindow).toBe(65536)
    const prepared = await adapter.prepareCall('managed-internal', id)
    expect(prepared.model.context).toEqual(info.context)
    expect(send).toHaveBeenCalledTimes(6)
  } finally { await ctx.fiber.dispose() }
})

it.each([
  { data: [{ id: 'MiniMax' }] },
  { data: [{ id: 'other', max_model_len: 65536 }] },
  { data: [{ id: 'MiniMax', max_model_len: '65536' }] },
  { data: [{ id: 'MiniMax', max_model_len: -1 }] },
  { data: [{ id: 'MiniMax', max_model_len: 65536 }, { id: 'MiniMax', max_model_len: 32768 }] },
])('requires explicit capacity when discovery metadata is unusable: %j', async metadata => {
  const { ctx } = await setup()
  const adapter = new InternalModelAdapter(ctx, { requestTimeoutMs: 1000, maxOutputTokens: 1024 })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => Response.json(String(url).startsWith('https://gpu.example/') ? metadata
    : String(url).endsWith('/connection')
      ? { modelIdentifier: 'MiniMax', baseURL: 'https://gpu.example/v1', apiKey: '', authType: 'None', apiKeyHeader: 'X-API-Key', supportsTools: true, temperature: 0.3, timeoutSeconds: 30 }
      : { models: [{ id, name: 'MiniMax' }] }))
  try {
    await expect(adapter.prepareCall('managed-internal', id)).rejects.toMatchObject({ code: 'INVALID_MODEL_CONTEXT', message: expect.stringContaining('contextWindow') })
  } finally { await ctx.fiber.dispose() }
})

it.each(['http', 'oversized', 'timeout', 'caller'])('bounds discovery and preserves cancellation: %s', async mode => {
  const { ctx } = await setup()
  const adapter = new InternalModelAdapter(ctx, { requestTimeoutMs: 1000, maxOutputTokens: 1024 })
  const abort = new AbortController()
  const cancel = vi.fn()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).startsWith('https://aigc.example/')) return Response.json(String(url).endsWith('/connection')
      ? { modelIdentifier: 'MiniMax', baseURL: 'https://gpu.example/v1', apiKey: '', authType: 'None', apiKeyHeader: 'X-API-Key', supportsTools: true, temperature: 0.3, timeoutSeconds: 30 }
      : { models: [{ id, name: 'MiniMax' }] })
    if (mode === 'http') return new Response('', { status: 404 })
    if (mode === 'oversized') return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)) }, cancel,
    }))
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      if (mode === 'caller') abort.abort()
    })
  })
  try {
    await expect(adapter.resolveModel('managed-internal', id, abort.signal)).rejects.toMatchObject({
      code: mode === 'caller' ? 'ABORTED' : 'INVALID_MODEL_CONTEXT',
    })
    if (mode === 'oversized') expect(cancel).toHaveBeenCalledTimes(1)
  } finally { await ctx.fiber.dispose() }
})

it.each([undefined, 2])('uses effective total deadline %s even while SSE keeps arriving', async override => {
  const { ctx, adapter } = await setup(override)
  const warn = vi.spyOn(ctx.logger, 'warn')
  let deltas = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).startsWith('https://aigc.example/')) return Response.json(String(url).endsWith('/connection')
      ? { modelIdentifier: 'MiniMax', baseURL: 'https://gpu.example/v1', apiKey: '', authType: 'None', apiKeyHeader: 'X-API-Key', supportsTools: true, temperature: 0.3, timeoutSeconds: 1 }
      : { models: [{ id, name: 'MiniMax' }] })
    let timer: ReturnType<typeof setInterval>
    const body = new ReadableStream({
      start(controller) {
        const send = () => { deltas++; controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}\n\n')) }
        send(); timer = setInterval(send, 40)
        init?.signal?.addEventListener('abort', () => { clearInterval(timer); controller.error(init.signal?.reason) }, { once: true })
      },
      cancel() { clearInterval(timer) },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  })
  try {
    const prepared = await adapter.prepareCall('managed-internal', id)
    const chunks: StreamChunk[] = []
    for await (const chunk of prepared.stream({ provider: 'managed-internal', model: id, messages: [] })) chunks.push(chunk)
    expect(deltas).toBeGreaterThan(5)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'TIMEOUT' } } })
    const diagnostic = warn.mock.calls.find(call => String(call[0]).startsWith('internal-model-request-diagnostic'))
    expect(JSON.parse(String(diagnostic?.[1]))).toMatchObject({ timeoutSeconds: override ?? 1, routeDeadlineAborted: true,
      callerAborted: false, cancellationSource: 'internal-route-total-deadline' })
    expect(JSON.parse(String(diagnostic?.[1])).elapsedMs).toBeGreaterThanOrEqual((override ?? 1) * 1000 - 100)
    expect(warn.mock.calls.some(call => String(call[0]).startsWith('llm-request-diagnostic'))).toBe(true)
  } finally { await ctx.fiber.dispose() }
})

it('validates generation timeout independently of admission timeout', () => {
  expect(Config({}).generationTimeoutSeconds).toBeUndefined()
  expect(Config({ generationTimeoutSeconds: 3600 }).generationTimeoutSeconds).toBe(3600)
  expect(Config({ generationTimeoutSeconds: 300 }).requestTimeoutMs).toBe(15000)
  expect(Config({ generationTimeoutSeconds: 0 }).generationTimeoutSeconds).toBe(0)
  expect(Config({}).streamIdleTimeoutSeconds).toBe(300)
  for (const value of [-1, 1.5, 3601])
    expect(() => Config({ generationTimeoutSeconds: value })).toThrow()
  for (const value of [0, -1, 1.5, 3601])
    expect(() => Config({ streamIdleTimeoutSeconds: value })).toThrow()
  expect(() => Reflect.apply(Config, undefined, [{ generationTimeoutSeconds: '300' }])).toThrow()
})

it.each([false, true])('disables total deadline while preserving idle protection (stall=%s)', async stall => {
  const { ctx, adapter } = await setup(0, 1)
  const warn = vi.spyOn(ctx.logger, 'warn')
  let sent = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).startsWith('https://aigc.example/')) return Response.json(String(url).endsWith('/connection')
      ? { modelIdentifier: 'MiniMax', baseURL: 'https://gpu.example/v1', apiKey: '', authType: 'None', apiKeyHeader: 'X-API-Key', supportsTools: true, temperature: 0.3, timeoutSeconds: 1 }
      : { models: [{ id, name: 'MiniMax' }] })
    let timer: ReturnType<typeof setInterval> | undefined
    const body = new ReadableStream({
      start(controller) {
        const emit = (value: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`))
        emit({ choices: [{ index: 0, delta: { reasoning_content: 'private-thought' }, finish_reason: null }] })
        if (!stall) timer = setInterval(() => {
          sent++
          emit({ choices: [{ index: 0, delta: { content: 'private-text' }, finish_reason: null }] })
          if (sent === 15) {
            clearInterval(timer)
            emit({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 } })
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close()
          }
        }, 100)
        init?.signal?.addEventListener('abort', () => { clearInterval(timer); controller.error(init.signal?.reason) }, { once: true })
      },
      cancel() { clearInterval(timer) },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  })
  try {
    const prepared = await adapter.prepareCall('managed-internal', id)
    const run = async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of prepared.stream({ provider: 'managed-internal', model: id, messages: [] })) chunks.push(chunk)
      return chunks
    }
    if (stall) await expect(run()).rejects.toMatchObject({ code: 'TIMEOUT' })
    else expect((await run()).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const record = warn.mock.calls.find(call => String(call[0]).startsWith('internal-model-request-diagnostic'))
    const diagnostic = JSON.parse(String(record?.[1]))
    expect(diagnostic).toMatchObject({ timeoutSeconds: 0, streamIdleTimeoutSeconds: 1, routeDeadlineAborted: false,
      cancellationSource: stall ? 'stream-idle-timeout' : null })
    expect(diagnostic.firstContentMs).toEqual(expect.any(Number))
    expect(diagnostic.contentEvents.reasoning).toBeGreaterThan(0)
    if (!stall) {
      expect(diagnostic.elapsedMs).toBeGreaterThan(1300)
      expect(diagnostic.contentEvents.text).toBe(15)
      expect(diagnostic.failureCode).toBeNull()
    } else expect(diagnostic.lastContentAgoMs).toBeGreaterThanOrEqual(900)
    expect(String(record?.[1])).not.toContain('private-')
  } finally { await ctx.fiber.dispose() }
})

it.each([undefined, 0])('preserves caller cancellation with total timeout %s', async total => {
  const { ctx, adapter } = await setup(total)
  const warn = vi.spyOn(ctx.logger, 'warn')
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => Response.json(String(url).endsWith('/connection')
    ? { modelIdentifier: 'MiniMax', baseURL: 'https://gpu.example/v1', apiKey: '', authType: 'None', apiKeyHeader: 'X-API-Key', supportsTools: true, temperature: 0.3, timeoutSeconds: 30 }
    : { models: [{ id, name: 'MiniMax' }] }))
  try {
    const prepared = await adapter.prepareCall('managed-internal', id)
    const abort = new AbortController(); abort.abort({ kind: 'disposed' })
    const chunks: StreamChunk[] = []
    for await (const chunk of prepared.stream({ provider: 'managed-internal', model: id, messages: [], signal: abort.signal })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } })
    const diagnostic = warn.mock.calls.find(call => String(call[0]).startsWith('internal-model-request-diagnostic'))
    expect(JSON.parse(String(diagnostic?.[1]))).toMatchObject({ callerAborted: true, routeDeadlineAborted: false, cancellationSource: 'caller' })
  } finally { await ctx.fiber.dispose() }
})
