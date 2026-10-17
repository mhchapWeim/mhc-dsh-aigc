import { afterEach, expect, it, vi } from 'vitest'
import { ManagedDesktopDistribution } from '../src/managed-distribution.ts'

const controllers: ManagedDesktopDistribution[] = []
afterEach(async () => { await Promise.all(controllers.splice(0).map(controller => controller.dispose())) })
const identity = { deviceId: 'test-device', computerName: 'test-pc', version: '1.0.0', platform: 'win32', arch: 'x64' }
const session = { endpoint: 'https://aigc.example', token: 'a'.repeat(64) }
const id = '00000000-0000-4000-8000-000000000001'

it('persists delivery and reading, suppresses duplicate notifications, and clears data on logout', async () => {
  const item = { id, title: '公告', body: '公告正文', important: false, deliveredAt: null as string | null, readAt: null as string | null, confirmedAt: null as string | null }
  const notify = vi.fn()
  const request = vi.fn<typeof fetch>(async (input, init) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${session.token}`)
    const url = String(input)
    if (url.endsWith('/announcements')) return Response.json({ items: [item] })
    if (url.endsWith('/receipt')) {
      const status = JSON.parse(String(init?.body)).status
      item.deliveredAt = new Date().toISOString()
      if (status === 'Read' || status === 'Confirmed') item.readAt = item.deliveredAt
      if (status === 'Confirmed') item.confirmedAt = item.deliveredAt
      return new Response(null, { status: 204 })
    }
    return Response.json({ release: null })
  })
  const controller = new ManagedDesktopDistribution(identity, () => ({ phase: 'idle' }), notify, () => {}, request)
  controllers.push(controller); controller.setSession(session)
  await controller.poll(); expect(notify).toHaveBeenCalledTimes(1); expect(controller.unread).toBe(1)
  await controller.poll(); expect(notify).toHaveBeenCalledTimes(1)
  await controller.receipt(id, 'Confirmed'); expect(controller.unread).toBe(0)
  controller.setSession(null); expect(controller.items).toEqual([]); expect(await controller.updateSource()).toBeNull()
})

it('uses only the selected release path with private authentication and rejects an external feed', async () => {
  let release: { id: string; feedPath: string } | null = { id, feedPath: `/v1/desktop/updates/${id}/` }
  const request = vi.fn<typeof fetch>(async input => String(input).endsWith('/announcements')
    ? Response.json({ items: [] }) : Response.json({ release }))
  const controller = new ManagedDesktopDistribution(identity, () => ({ phase: 'ready', version: '1.2.0' }), () => {}, () => {}, request)
  controllers.push(controller); controller.setSession(session); await controller.poll()
  expect(await controller.updateSource()).toEqual({ url: `${session.endpoint}/v1/desktop/updates/${id}/`, requestHeaders: { Authorization: `Bearer ${session.token}` } })
  release = { id, feedPath: 'https://untrusted.example/updates/' }
  await expect(controller.updateSource()).rejects.toThrow(/Invalid managed update/u)
  release = null; expect(await controller.updateSource()).toBeNull()
})

it('aborts an in-flight policy request and drains it during logout and disposal', async () => {
  const started = Promise.withResolvers<undefined>()
  let aborted = false
  const request: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true })
    started.resolve(undefined)
  })
  const controller = new ManagedDesktopDistribution(identity, () => ({ phase: 'idle' }), () => {}, () => {}, request)
  controllers.push(controller); controller.setSession(session); await started.promise
  controller.setSession(null); await controller.dispose(); expect(aborted).toBe(true); expect(controller.items).toEqual([])
})
