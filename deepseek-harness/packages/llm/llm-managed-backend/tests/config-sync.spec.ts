import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configEvents, installConfigSync, ManagedConfigReconciler } from '../src/config-sync.ts'

const userId = '10000000-0000-4000-8000-000000000001'
const deviceId = '10000000-0000-4000-8000-000000000002'
const offerId = '10000000-0000-4000-8000-000000000003'
const snapshot = { schemaVersion: 1, userId, revision: 4, offerId, domains: ['models', 'billing', 'access'], models: [],
  billing: { assigned: false, planName: null, source: 'None', total: 0, used: 0, reserved: 0, remaining: 0,
    weekStart: '2026-11-01T16:00:00Z', resetsAt: '2026-11-08T16:00:00Z' } }
const signal = () => new AbortController().signal

function fixture(apply = vi.fn(async () => {})) {
  const reports: Array<Record<string, unknown>> = []
  let failReceipt = false
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).includes('/versions')) return Response.json({ schemaVersion: 1, userId, revision: 4 })
    if (String(url).includes('/snapshot')) return Response.json(snapshot)
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    reports.push(body)
    if (failReceipt && body.status === 'Applied') { failReceipt = false; throw new Error('receipt connection lost') }
    return new Response(null, { status: 204 })
  })
  const reconciler = new ManagedConfigReconciler('https://aigc.test', deviceId, 'test', async () => 'token', apply, request)
  return { reconciler, request, reports, apply, failNextReceipt: () => { failReceipt = true } }
}

describe('managed configuration reconciliation', () => {
  it('acknowledges only after successful application and sends later heartbeats without applying again', async () => {
    const f = fixture(vi.fn(async () => { expect(f.reports.some(x => x.status === 'Applied')).toBe(false) }))
    await f.reconciler.reconcile(signal())
    expect(f.reports.map(x => x.status)).toEqual(['Applied', 'Heartbeat'])
    expect(f.reports[0]).toMatchObject({revision: 4, offerId, deviceId})
    await f.reconciler.reconcile(signal())
    expect(f.apply).toHaveBeenCalledOnce()
    expect(f.reports.map(x => x.status)).toEqual(['Applied', 'Heartbeat', 'Heartbeat'])
  })
  it('retries a lost success receipt without applying the same configuration twice', async () => {
    const f = fixture(); f.failNextReceipt()
    await expect(f.reconciler.reconcile(signal())).rejects.toThrow('receipt connection lost')
    await f.reconciler.reconcile(signal())
    expect(f.apply).toHaveBeenCalledOnce()
    expect(f.reports.map(x => x.status)).toEqual(['Applied', 'Applied', 'Heartbeat'])
  })
  it('reports application failure and never acknowledges success', async () => {
    const f = fixture(vi.fn(async () => { throw new Error('apply failed') }))
    await expect(f.reconciler.reconcile(signal())).rejects.toThrow('apply failed')
    expect(f.reports).toHaveLength(1)
    expect(f.reports[0]).toMatchObject({ status: 'Failed', errorCode: 'APPLY_FAILED' })
  })
  it('rejects a snapshot from another user and does not acknowledge it', async () => {
    const f = fixture()
    f.request.mockImplementation(async url => String(url).includes('/snapshot')
      ? Response.json({...snapshot, userId: deviceId}) : Response.json({schemaVersion: 1, userId, revision: 4}))
    await expect(f.reconciler.reconcile(signal())).rejects.toThrow('identity or version mismatch')
    expect(f.apply).not.toHaveBeenCalled()
  })
  it('does not apply a snapshot overtaken by a newer committed version', async () => {
    const f = fixture(); let calls = 0
    f.request.mockImplementation(async url => String(url).includes('/snapshot') ? Response.json(snapshot)
      : Response.json({schemaVersion: 1, userId, revision: ++calls === 1 ? 4 : 5}))
    await expect(f.reconciler.reconcile(signal())).rejects.toThrow('changed while loading')
    expect(f.apply).not.toHaveBeenCalled()
  })
  it('contains snapshot errors in a failed receipt without including raw error messages', async () => {
    const f = fixture(); const real = f.request.getMockImplementation()!
    f.request.mockImplementation(async (url, init) => String(url).includes('/snapshot') ? new Response(null, {status: 503}) : real(url, init))
    await expect(f.reconciler.reconcile(signal())).rejects.toThrow('HTTP 503')
    expect(f.reports).toEqual([expect.objectContaining({status: 'Failed', errorCode: 'SNAPSHOT_FAILED'})])
    expect(f.apply).not.toHaveBeenCalled()
  })
  it('merges concurrent signals and checks again when a signal arrives during application', async () => {
    let release!: () => void
    const f = fixture(vi.fn(async () => new Promise<void>(resolve => { release = resolve })))
    const one = f.reconciler.reconcile(signal())
    await vi.waitFor(() => expect(f.apply).toHaveBeenCalledOnce())
    const two = f.reconciler.reconcile(signal())
    release(); await Promise.all([one, two])
    expect(f.apply).toHaveBeenCalledOnce()
    expect(f.reports.filter(x => x.status === 'Heartbeat')).toHaveLength(2)
  })
})

it('parses SSE split frames and rejects unbounded frames', async () => {
  const encoder = new TextEncoder()
  const response = new Response(new ReadableStream({start(controller) {
    for (const part of ['event: config.ch', 'anged\r', '\ndata: {}\r\n\r\n', 'event: heartbeat\ndata: {}\n\n']) controller.enqueue(encoder.encode(part))
    controller.close()
  }}), {headers: {'content-type': 'text/event-stream'}})
  const events: string[] = []
  for await (const event of configEvents(response)) events.push(event)
  expect(events).toEqual(['config.changed', 'heartbeat'])
  const oversized = configEvents(new Response('x'.repeat(65_537), {headers: {'content-type': 'text/event-stream'}}))
  await expect(oversized.next()).rejects.toThrow('exceeds limit')
})

it('disposes SSE and polling and retains one durable device identity across Host installations', async () => {
  const ctx = new Context(); await ctx.plugin(MemoryCredentials)
  let aborted = false
  const f = fixture()
  const routes = f.request.getMockImplementation()!
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (!String(url).endsWith('/events')) return routes(url, init)
    init?.signal?.addEventListener('abort', () => { aborted = true }, {once: true})
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true}))
  })
  try {
    installConfigSync(ctx, 'https://aigc.test', async () => 'token', 'test', async () => {}, request)
    await vi.waitFor(() => expect(request.mock.calls.some(([url]) => String(url).endsWith('/events'))).toBe(true))
    const record = await ctx.credentials.readRecord(credentialKey('llm-managed-backend', 'config-sync-device'))
    expect(record).toMatchObject({kind: 'grant', payload: {deviceId: expect.any(String)}})
    await ctx.fiber.dispose()
    expect(aborted).toBe(true)
    const count = request.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(request).toHaveBeenCalledTimes(count)
  } finally { await ctx.fiber.dispose() }
})
