import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { configEvents, ManagedConfigReconciler } from '../src/config-sync.ts'

const endpoint = process.env['AIGC_CONFIG_SYNC_TEST_API']

it.skipIf(endpoint === undefined)('reconciles a real MQ-triggered SSE notification and exposes success and failure receipts in AIGC', async () => {
  const root = new URL(endpoint!)
  expect(['127.0.0.1', 'localhost']).toContain(root.hostname)
  expect(root.port).toBe('5081') // Dedicated test process and disposable database; never the user's port 5080.
  const login = async (desktop: boolean) => {
    const response = await fetch(`${root.origin}${desktop ? '/v1/auth/login' : '/api/auth/login'}`, {
      method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(desktop
        ? {username: 'wh00412', password: 'Bhss@123'} : {employeeNo: 'wh00028', password: 'Bhss@123'}),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, string>
    return body[desktop ? 'access_token' : 'accessToken']!
  }
  const [dsh, admin] = await Promise.all([login(true), login(false)])
  const deviceId = randomUUID()
  const apply = vi.fn(async () => {})
  const client = new ManagedConfigReconciler(root.origin, deviceId, 'config-sync-test', async () => dsh, apply)
  await client.reconcile(new AbortController().signal)
  const status = async () => {
    const response = await fetch(`${root.origin}/api/config-sync/devices?page=1&pageSize=100`, {headers: {authorization: `Bearer ${admin}`}})
    expect(response.status).toBe(200)
    return await response.json() as {mqConnected: boolean; items: Array<{deviceId: string; status: string; targetRevision: number; appliedRevision: number}>}
  }
  await vi.waitFor(async () => expect((await status()).mqConnected).toBe(true), {timeout: 15_000})
  const before = (await status()).items.find(x => x.deviceId === deviceId)!
  expect(before.status).toBe('Applied')
  const streamLifetime = new AbortController()
  const events = configEvents(await fetch(`${root.origin}/v1/config/events`, {headers: {authorization: `Bearer ${dsh}`}, signal: streamLifetime.signal}))
  try {
    expect((await events.next()).value).toBe('config.changed')
    const change = await fetch(`${root.origin}/api/billing/plans`, {method: 'POST', headers: {authorization: `Bearer ${admin}`, 'content-type': 'application/json'},
      body: JSON.stringify({name: `config-sync-e2e-${randomUUID()}`, weeklyTokens: 1200, isEnabled: true})})
    expect(change.status).toBe(200)
    expect((await status()).items.find(x => x.deviceId === deviceId)?.status).toBe('Pending')
    const received = (async () => { for await (const event of events) if (event === 'config.changed') return })()
    const timeout = setTimeout(() => streamLifetime.abort(), 8000)
    try { await received } finally { clearTimeout(timeout) }
    await client.reconcile(new AbortController().signal)
    const after = (await status()).items.find(x => x.deviceId === deviceId)!
    expect(after.status).toBe('Applied')
    expect(after.appliedRevision).toBe(after.targetRevision)
    expect(after.appliedRevision).toBeGreaterThan(before.appliedRevision)
    expect(apply).toHaveBeenCalledTimes(2)

    const failedDevice = randomUUID()
    const failed = new ManagedConfigReconciler(root.origin, failedDevice, 'config-sync-test', async () => dsh, async () => { throw new Error('apply failure') })
    await expect(failed.reconcile(new AbortController().signal)).rejects.toThrow('apply failure')
    expect((await status()).items.find(x => x.deviceId === failedDevice)?.status).toBe('Failed')
  } finally { streamLifetime.abort(); await events.return(undefined).catch(() => {}) }
}, 45_000)
