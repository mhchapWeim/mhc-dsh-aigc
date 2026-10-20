import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { ManagedBackendAdapter } from '../src/index.ts'

const CATALOG = {
  connection: { api: 'openai-completions', baseURL: 'https://litellm.example.test/v1', apiKey: 'sk-user' },
  models: [{ id: 'team-small', name: 'Team Small', input: ['text', 'image'] }],
}

function adapter(request: typeof fetch): ManagedBackendAdapter {
  return new ManagedBackendAdapter(new Context(), 'https://models.example.test', async () => 'user-token', request)
}

describe('managed backend adapter', () => {
  it('preserves unknown image capability and rejects image dispatch with a configuration error', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ ...CATALOG,
      models: [{ id: 'team-small', name: 'Unknown', input: ['text'], imageInput: { state: 'unknown' } }],
    }))
    const managed = adapter(request)
    expect(await managed.resolveModel('managed', 'team-small')).toMatchObject({ imageInputState: 'unknown' })
    const prepared = await managed.prepareCall('managed', 'team-small')
    expect(prepared.model).toMatchObject({ imageInputState: 'unknown' })
    expect(() => prepared.stream({ provider: 'managed', model: 'team-small',
      messages: [{ role: 'user', content: [{ type: 'image' }] }] as never }))
      .toThrow(expect.objectContaining({ code: 'MODEL_IMAGE_CAPABILITY_UNKNOWN' }))
  })
  it('advertises only models returned for the token', async () => {
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer user-token')
      return Response.json(CATALOG)
    })
    expect(await adapter(request).listModels('managed')).toEqual([
      { provider: 'managed', id: 'team-small', name: 'Team Small', inputModalities: ['text', 'image'] },
    ])
  })

  it('rejects a model absent from the backend catalog before generation', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json(CATALOG))
    await expect(adapter(request).prepareCall('managed', 'other')).rejects.toMatchObject({ code: 'MODEL_UNAUTHORIZED' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('uses the backend token only for admission and sends the virtual key directly to LiteLLM', async () => {
    const ctx = new Context()
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{
      source: 'process', values: { DSH_DESKTOP_APP_VERSION: '0.1.7-alpha.2.20261008.2' },
    }]))
    const credentials = new MemoryCredentials(ctx)
    await credentials.modifyRecord(credentialKey('llm-managed-backend', 'device-user'), async () => ({
      kind: 'grant', payload: { id: 'user-1', username: 'wh00028' },
    }))
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer user-token')
      return Response.json(CATALOG)
    })
    let expectedUsername = 'wh00028'
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://litellm.example.test/v1/chat/completions')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-user')
      expect(new Headers(init?.headers).get('user-agent')).toBe(`${expectedUsername}/0.1.7-alpha.2.20261008.2`)
      return new Response([
        'data: {"id":"reply-1","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}',
        'data: {"id":"reply-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
        '',
      ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })
    })
    const chunks = []
    const managed = new ManagedBackendAdapter(ctx, 'https://models.example.test', async () => 'user-token', request)
    for await (const chunk of managed.stream({ provider: 'managed', model: 'team-small', messages: [] })) {
      chunks.push(chunk)
    }
    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text-delta', text: 'hello' }),
      expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }),
    ]))
    expect(request).toHaveBeenCalledTimes(1)
    const prepared = await managed.prepareCall('managed', 'team-small')
    await credentials.modifyRecord(credentialKey('llm-managed-backend', 'device-user'), async () => ({
      kind: 'grant', payload: { id: 'user-2', username: 'wa00038' },
    }))
    // The prepared call retains its admitted identity; the next call reads the updated login.
    for await (const _chunk of prepared.stream({ provider: 'managed', model: 'team-small', messages: [] })) { /* drain */ }
    expectedUsername = 'wa00038'
    for await (const _chunk of managed.stream({ provider: 'managed', model: 'team-small', messages: [] })) { /* drain */ }
    expect(upstream).toHaveBeenCalledTimes(3)
    upstream.mockRestore()
  })

  it('delegates durable image serialization to the existing pi-ai adapter', async () => {
    const ctx = new Context()
    const attachment = {
      attachmentId: 'image-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    }
    ctx.provide('attachments', {
      imageHostPath: () => undefined,
      readImageRequest: async () => ({
        variantId: 'variant-1', attachment, data: Uint8Array.of(1, 2, 3), mediaType: 'image/png',
        bytes: 3, width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: false,
      }),
    } as never)
    const request = vi.fn<typeof fetch>(async () => Response.json(CATALOG))
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = String(init?.body)
      expect(body).toContain('data:image/png;base64,AQID')
      return new Response([
        'data: {"id":"reply-2","choices":[{"index":0,"delta":{"role":"assistant","content":"seen"},"finish_reason":null}]}',
        'data: {"id":"reply-2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
        '',
      ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })
    })
    const direct = new ManagedBackendAdapter(ctx, 'https://models.example.test', async () => 'user-token', request)
    const chunks = []
    for await (const chunk of direct.stream({
      provider: 'managed', model: 'team-small',
      messages: [{ role: 'user', content: [{ type: 'image', attachment }] }] as never,
    })) chunks.push(chunk)
    expect(chunks).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text-delta', text: 'seen' })]))
    upstream.mockRestore()
  })

  it('reports the capacities the backend discloses and leaves the ones it omits absent', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({
      connection: { api: 'openai-completions', baseURL: 'https://litellm.example.test/v1', apiKey: 'sk-user' },
      models: [
        { id: 'team-large', name: 'Team Large', multiplier: '0.5×', contextWindow: 1_000_000, maxOutputTokens: 393_216 },
        { id: 'team-small', name: 'Team Small' },
      ],
    }))
    const models = adapter(request)
    expect((await models.listModels('managed'))[0]).toMatchObject({ name: 'Team Large', multiplier: '0.5×' })
    expect(await models.resolveModel('managed', 'team-large')).toMatchObject({
      context: { contextWindow: 1_000_000 }, defaultMaxTokens: 393_216, multiplier: '0.5×',
    })
    const undisclosed = await models.resolveModel('managed', 'team-small')
    expect(undisclosed).not.toHaveProperty('context')
    expect(undisclosed).not.toHaveProperty('defaultMaxTokens')
  })

  it('binds a disclosed context window into the pi-ai route the prepared call dispatches through', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({
      connection: { api: 'openai-completions', baseURL: 'https://litellm.example.test/v1', apiKey: 'sk-user' },
      models: [{ id: 'team-large', name: 'Team Large', contextWindow: 1_000_000, maxOutputTokens: 393_216 }],
    }))
    const prepared = await adapter(request).prepareCall('managed', 'team-large')
    expect(prepared.model).toMatchObject({
      id: 'team-large', context: { contextWindow: 1_000_000 }, defaultMaxTokens: 393_216,
    })
  })

  it('refuses a catalog entry whose capacity is not a positive integer', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({
      connection: { api: 'openai-completions', baseURL: 'https://litellm.example.test/v1', apiKey: 'sk-user' },
      models: [{ id: 'team-small', name: 'Team Small', contextWindow: 0 }],
    }))
    await expect(adapter(request).listModels('managed')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})
