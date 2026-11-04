import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { ManagedTokenBilling } from '../src/billing.ts'

const ROOT = 'https://models.example.test'
const PENDING = credentialKey('llm-managed-backend', 'billing-pending')
const QUOTA = {
  assigned: true, total: 1_000_000, used: 0, reserved: 0, remaining: 100_000,
  resetsAt: '2026-11-02T00:00:00Z', planName: 'Standard',
}

function billing(context: Context, request: typeof fetch): ManagedTokenBilling {
  return new ManagedTokenBilling(context, ROOT, async () => 'user-token', request)
}

function options(): GenerateOptions {
  return { provider: 'managed', model: 'team-large', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
}

/** Emit one usage chunk and one finish chunk, as a real provider stream does. */
async function* usageStream(usage: TokenUsage): AsyncGenerator<StreamChunk> {
  yield { type: 'text-delta', text: 'ok' } as StreamChunk
  yield { type: 'usage', usage } as StreamChunk
  yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
}

/** Reject the stream after claiming usage, exercising the settlement-on-error path. */
async function* failingStream(usage: TokenUsage): AsyncGenerator<StreamChunk> {
  yield { type: 'usage', usage } as StreamChunk
  throw new Error('upstream dropped')
}

function calls(request: ReturnType<typeof vi.fn>): { method: string; path: string; body: unknown }[] {
  return request.mock.calls.map(call => ({
    method: String((call[1] as RequestInit | undefined)?.method ?? 'GET'),
    path: new URL(String(call[0])).pathname,
    body: (call[1] as RequestInit | undefined)?.body === undefined
      ? undefined : JSON.parse(String((call[1] as RequestInit).body)),
  }))
}

describe('managed token billing', () => {
  it('reserves before streaming and settles the provider actual usage', async () => {
    const context = new Context()
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname
      if (path === '/v1/billing/quota') return Response.json(QUOTA)
      if (path === '/v1/billing/reservations') return Response.json({ id: 'r', status: 'Pending' })
      expect(init?.method).toBe('PUT')
      return Response.json({ id: 'r', status: 'Settled', chargedTokens: 1500 })
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of billing(context, request).stream(options(), '2x',
      () => usageStream({ inputTokens: 700, outputTokens: 800, totalTokens: 1500 }))) chunks.push(chunk)
    expect(chunks.map(chunk => chunk.type)).toEqual(['text-delta', 'usage', 'finish'])

    const recorded = calls(request)
    expect(recorded.slice(0, 2).map(call => `${call.method} ${call.path}`))
      .toEqual(['GET /v1/billing/quota', 'POST /v1/billing/reservations'])
    const reservation = recorded[1]?.body as { requestId: string; modelIdentifier: string; rawTokenBudget: number }
    expect(reservation.modelIdentifier).toBe('team-large')
    // Admission creates a request ledger without estimating or limiting the context.
    expect(reservation.rawTokenBudget).toBe(1)
    // Settlement addresses the client-generated request id, so a retry cannot double-charge.
    expect(`${recorded[2]?.method} ${recorded[2]?.path}`).toBe(`PUT /v1/billing/reservations/${reservation.requestId}`)
    expect(recorded[2]?.body).toEqual({ inputTokens: 700, outputTokens: 800, totalTokens: 1500 })
  })

  it('treats provider totalTokens as authoritative and includes cache traffic otherwise', async () => {
    const context = new Context()
    const settled: unknown[] = []
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname
      if (path === '/v1/billing/quota') return Response.json(QUOTA)
      if (path === '/v1/billing/reservations') return Response.json({ id: 'r', status: 'Pending' })
      settled.push(JSON.parse(String((init as RequestInit).body)))
      return Response.json({ id: 'r', status: 'Settled' })
    })
    for await (const _chunk of billing(context, request).stream(options(), undefined,
      () => usageStream({ inputTokens: 10, outputTokens: 20, totalTokens: 500, cacheReadTokens: 400, cacheWriteTokens: 70 }))) { /* drain */ }
    expect(settled[0]).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 500 })

    const fallback: unknown[] = []
    const empty = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname
      if (path === '/v1/billing/quota') return Response.json(QUOTA)
      if (path === '/v1/billing/reservations') return Response.json({ id: 'r', status: 'Pending' })
      fallback.push(JSON.parse(String((init as RequestInit).body)))
      return Response.json({ id: 'r', status: 'Settled' })
    })
    for await (const _chunk of billing(new Context(), empty).stream(options(), undefined,
      () => usageStream({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 400, cacheWriteTokens: 70 }))) { /* drain */ }
    expect(fallback[0]).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 500 })
  })

  it('refuses to call the provider only when the weekly balance is exhausted', async () => {
    const context = new Context()
    const request = vi.fn<typeof fetch>(async () => Response.json({ ...QUOTA, remaining: 0 }))
    const run = vi.fn<(options: GenerateOptions) => AsyncIterable<StreamChunk>>()
    await expect(async () => {
      for await (const _chunk of billing(context, request).stream(options(), undefined, run)) { /* drain */ }
    }).rejects.toMatchObject({ code: 'TOKEN_QUOTA_EXCEEDED' })
    expect(run).not.toHaveBeenCalled()
    expect(calls(request).map(call => call.path)).toEqual(['/v1/billing/quota'])
  })

  it('rejects an unassigned quota and a failed reservation without calling the provider', async () => {
    const run = vi.fn<(options: GenerateOptions) => AsyncIterable<StreamChunk>>()
    const unassigned = vi.fn<typeof fetch>(async () => Response.json({ ...QUOTA, assigned: false, total: 0, remaining: 0 }))
    await expect(async () => {
      for await (const _chunk of billing(new Context(), unassigned).stream(options(), undefined, run)) { /* drain */ }
    }).rejects.toMatchObject({ code: 'TOKEN_QUOTA_EXCEEDED' })

    const rejected = vi.fn<typeof fetch>(async url => new URL(String(url)).pathname === '/v1/billing/quota'
      ? Response.json(QUOTA) : Response.json({ message: '超额' }, { status: 402 }))
    await expect(async () => {
      for await (const _chunk of billing(new Context(), rejected).stream(options(), undefined, run)) { /* drain */ }
    }).rejects.toMatchObject({ code: 'TOKEN_QUOTA_EXCEEDED' })
    expect(run).not.toHaveBeenCalled()
  })

  it('surfaces a billing outage instead of dispatching an unmetered request', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('boom', { status: 503 }))
    const run = vi.fn<(options: GenerateOptions) => AsyncIterable<StreamChunk>>()
    await expect(async () => {
      for await (const _chunk of billing(new Context(), request).stream(options(), undefined, run)) { /* drain */ }
    }).rejects.toMatchObject({ code: 'BILLING_UNAVAILABLE' })
    expect(run).not.toHaveBeenCalled()
  })

  it('ignores display-only multiplier metadata when billing actual usage', async () => {
    const request = vi.fn<typeof fetch>(async (url) => new URL(String(url)).pathname.endsWith('/quota')
      ? Response.json(QUOTA) : Response.json({id: 'r', status: new URL(String(url)).pathname.endsWith('/reservations') ? 'Pending' : 'Settled'}))
    for await (const _chunk of billing(new Context(), request).stream(options(), '0x',
      () => usageStream({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }))) { /* drain */ }
    expect(calls(request).map(call => call.path)).toEqual(['/v1/billing/quota', '/v1/billing/reservations', expect.stringMatching(/^\/v1\/billing\/reservations\/[a-f0-9-]+$/u)])
    expect(calls(request)[2]?.body).toEqual({inputTokens: 1, outputTokens: 1, totalTokens: 2})
  })

  it('settles usage that arrived before the provider stream failed', async () => {
    const context = new Context()
    const settled: unknown[] = []
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname
      if (path === '/v1/billing/quota') return Response.json(QUOTA)
      if (path === '/v1/billing/reservations') return Response.json({ id: 'r', status: 'Pending' })
      settled.push(JSON.parse(String((init as RequestInit).body)))
      return Response.json({ id: 'r', status: 'Settled' })
    })
    await expect(async () => {
      for await (const _chunk of billing(context, request).stream(options(), undefined,
        () => failingStream({ inputTokens: 5, outputTokens: 5, totalTokens: 10 }))) { /* drain */ }
    }).rejects.toThrow(/upstream dropped/u)
    expect(settled).toEqual([{ inputTokens: 5, outputTokens: 5, totalTokens: 10 }])
  })

  it('keeps the reservation for reconciliation when the provider reports no usage', async () => {
    const context = new Context()
    const warn = vi.spyOn(context.logger, 'warn')
    const request = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname
      if (path === '/v1/billing/quota') return Response.json(QUOTA)
      if (path === '/v1/billing/reservations') return Response.json({ id: 'r', status: 'Pending' })
      return Response.json({ id: 'r', status: 'Settled' })
    })
    for await (const _chunk of billing(context, request).stream(options(), undefined,
      async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'text-delta', text: 'partial' } as StreamChunk
      })) { /* drain */ }
    expect(calls(request).map(call => call.path)).toEqual(['/v1/billing/quota', '/v1/billing/reservations'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('quota reservation retained'), expect.any(String))
  })

  it('replays a durable pending settlement before admitting the next request', async () => {
    const context = new Context()
    const credentials = new MemoryCredentials(context)
    const pendingId = '11111111-1111-4111-8111-111111111111'
    await credentials.modifyRecord(PENDING, async () => ({
      kind: 'grant' as const,
      payload: [{ id: pendingId, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }],
    }))
    const order: string[] = []
    const request = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname
      order.push(path)
      if (path === '/v1/billing/quota') return Response.json(QUOTA)
      if (path === '/v1/billing/reservations') return Response.json({ id: 'r', status: 'Pending' })
      return Response.json({ id: 'r', status: 'Settled' })
    })
    for await (const _chunk of billing(context, request).stream(options(), undefined,
      () => usageStream({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }))) { /* drain */ }
    // The stale settlement is flushed first, so a failed previous turn cannot leak unmetered usage.
    expect(order[0]).toBe(`/v1/billing/reservations/${pendingId}`)
    expect(order[1]).toBe('/v1/billing/quota')
    expect(await credentials.readRecord(PENDING))
      .toMatchObject({ kind: 'grant', payload: [] })
  })
})

it('allows a large context with one tok left and preserves the requested output limit', async () => {
  const request = vi.fn<typeof fetch>(async url => new URL(String(url)).pathname === '/v1/billing/quota'
    ? Response.json({ ...QUOTA, remaining: 1 }) : Response.json({ status: 'Pending' }))
  const input = { ...options(), system: 'context'.repeat(10000), maxTokens: 8192 }
  const run = vi.fn((_value: GenerateOptions) => usageStream({ inputTokens: 20000, outputTokens: 10, totalTokens: 20010 }))
  for await (const _chunk of billing(new Context(), request).stream(input, '2.5x', run)) { /* drain */ }
  expect(run).toHaveBeenCalledWith(input)
})
