import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { FailureJournal } from '../src/failure-journal.ts'
import { FailureUploader } from '../src/failure-uploader.ts'

const directories: string[] = []
const uploaders: FailureUploader[] = []
afterEach(async () => {
  await Promise.all(uploaders.splice(0).map(uploader => uploader.dispose()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
async function journal() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-upload-')); directories.push(directory)
  return { directory, journal: new FailureJournal(directory, '0.1.7-alpha.2.20261008.2') }
}
function make(directory: string, request: typeof fetch) {
  const uploader = new FailureUploader(directory, request); uploaders.push(uploader); return uploader
}
const session = { endpoint: 'https://aigc.example.test', token: 'private-token' }

it('retries failed delivery after restart and never advances until every event is acknowledged', async () => {
  const { directory, journal: log } = await journal()
  log.record({ category: 'llm', operation: 'managed', username: 'employee-a', error: 'Bearer sk-sensitive' })
  let fail = true
  const sent: object[][] = []
  const request = vi.fn<typeof fetch>(async (input, init) => {
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer private-token' })
    expect(init?.redirect).toBe('error')
    if (String(input).endsWith('/auth/me')) {
      expect(String(input)).toBe('https://aigc.example.test/v1/auth/me')
      return Response.json({ user: { username: 'employee-a' } })
    }
    expect(String(input)).toBe('https://aigc.example.test/v1/desktop/diagnostics')
    const events = JSON.parse(String(init?.body)).events as { eventId: string }[]; sent.push(events)
    if (fail) return Response.json({ acceptedEventIds: [] })
    return Response.json({ acceptedEventIds: events.map(event => event.eventId) })
  })
  const first = make(directory, request); first.setSession(session)
  await first.poll()
  expect((await readdir(directory)).filter(name => name.startsWith('upload-'))).toHaveLength(0)
  expect(JSON.parse(await readFile(join(directory, 'delivery-status.json'), 'utf8'))).toMatchObject({ status: 'retrying', error: 'Incomplete diagnostic receipt' })
  await first.dispose(); fail = false
  const second = make(directory, request); second.setSession(session); await second.poll()
  expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0])
  expect(JSON.stringify(sent)).not.toContain('sk-sensitive')
  await second.poll(); expect(sent).toHaveLength(2)
  expect(JSON.parse(await readFile(join(directory, 'delivery-status.json'), 'utf8'))).toMatchObject({ status: 'idle', backend: session.endpoint, error: null })
  const cursor = (await readdir(directory)).find(name => /^upload-.*\.json$/u.test(name))!
  expect(await readFile(join(directory, cursor), 'utf8')).not.toContain('private-token')
})

it('keeps account cursors separate and bounds each upload to twenty events', async () => {
  const { directory, journal: log } = await journal()
  for (let i = 0; i < 23; i++) log.record({ category: 'tool', operation: 'read', username: 'employee-a', error: 'missing' })
  log.record({ category: 'tool', operation: 'write', username: 'employee-b', error: 'denied' })
  const received: { username: string; count: number }[] = []
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const token = new Headers(init?.headers).get('Authorization')
    if (token === null) throw new Error('Expected authenticated diagnostic request')
    const username = token.endsWith('token-b') ? 'employee-b' : 'employee-a'
    if (String(input).endsWith('/auth/me')) return Response.json({ user: { username } })
    const events = JSON.parse(String(init?.body)).events as { eventId: string; username: string }[]
    expect(events.every(event => event.username === username)).toBe(true)
    received.push({ username, count: events.length })
    return Response.json({ acceptedEventIds: events.map(event => event.eventId) })
  })
  const uploader = make(directory, request); uploader.setSession(session); await uploader.poll(); await uploader.poll()
  uploader.setSession({ ...session, token: 'token-b' }); await uploader.poll()
  expect(received).toEqual([{ username: 'employee-a', count: 20 }, { username: 'employee-a', count: 3 }, { username: 'employee-b', count: 1 }])
})

it('aborts an in-flight request on sign-out without advancing the durable cursor', async () => {
  const { directory, journal: log } = await journal()
  log.record({ category: 'main', operation: 'upload', error: 'offline' })
  let aborted = false
  const request = vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).endsWith('/auth/me')) return Response.json({ user: { username: 'employee-a' } })
    return new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true }) })
  })
  const uploader = make(directory, request); uploader.setSession(session)
  const round = uploader.poll()
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  uploader.setSession(null); await round
  expect(aborted).toBe(true)
  expect((await readdir(directory)).some(name => name.startsWith('upload-'))).toBe(false)
})
