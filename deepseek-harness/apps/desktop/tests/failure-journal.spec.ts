import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, expect, it } from 'vitest'
import { FailureJournal, redactDiagnostic } from '../src/failure-journal.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function scratch() { const root = mkdtempSync(join(tmpdir(), 'bhss-failures-')); roots.push(root); return root }

it('retains seven calendar days, leaves other files alone and rotates bounded files', () => {
  const root = scratch()
  writeFileSync(join(root, 'failures-2026-10-02-0.jsonl'), '{}\n')
  writeFileSync(join(root, 'failures-2026-10-03-0.jsonl'), '{}\n')
  writeFileSync(join(root, 'foreign.log'), 'keep')
  const journal = new FailureJournal(root, '0.1.7-alpha.2.20261008.2', {
    now: () => new Date('2026-10-09T12:00:00Z'), fileBytes: 100,
  })
  journal.record({ category: 'llm', operation: 'chat', error: new Error('timeout') })
  journal.record({ category: 'llm', operation: 'chat', error: new Error('retry failed') })
  expect(readdirSync(root)).not.toContain('failures-2026-10-02-0.jsonl')
  expect(readdirSync(root)).toEqual(expect.arrayContaining(['failures-2026-10-03-0.jsonl', 'foreign.log',
    'failures-2026-10-09-0.jsonl', 'failures-2026-10-09-1.jsonl']))
})

it('preserves stack, identity and correlation while redacting credentials on disk and export', async () => {
  const root = scratch()
  const directory = join(root, 'logs')
  const journal = new FailureJournal(directory, '0.1.7-alpha.2.20261008.2')
  journal.record({ category: 'llm', operation: 'chat', username: 'wh00028', sessionId: 'session-1', operationId: 'op-1',
    error: new Error('Authorization: Bearer abc123 api_key=sk-secret password=hunter2 https://host/cb?ticket=abc'),
    context: ['request started'],
  })
  const content = readFileSync(join(directory, readdirSync(directory).find(name => name.endsWith('.jsonl'))!), 'utf8')
  for (const secret of ['abc123', 'sk-secret', 'hunter2', 'ticket=abc']) expect(content).not.toContain(secret)
  const event = JSON.parse(content)
  expect(event).toMatchObject({ username: 'wh00028', sessionId: 'session-1', operationId: 'op-1', appVersion: journal.version })
  expect(event.error).toContain('at ')
  const destination = join(root, 'diagnostics.jsonl.gz')
  await journal.export(destination)
  const exported = gunzipSync(readFileSync(destination)).toString('utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(exported[0]).toMatchObject({ type: 'diagnostic-manifest', retentionDays: 7 })
  expect(exported[1]).toEqual(event)
  await expect(journal.export(destination)).rejects.toMatchObject({ code: 'EEXIST' })
})

it('contains disk failures and rejects malformed Host records without breaking the application', () => {
  const root = scratch()
  const blocked = join(root, 'blocked')
  writeFileSync(blocked, 'not a directory')
  const journal = new FailureJournal(blocked, '1')
  expect(() => journal.record({ category: 'main', operation: 'failure', error: 'problem' })).not.toThrow()
  expect(journal.storageFailed).toBe(true)
  expect(() => journal.ingest('not JSON')).not.toThrow()
})

it('drops arbitrary Host fields and caps storage without deleting unrelated files', () => {
  const root = scratch()
  writeFileSync(join(root, 'keep.txt'), 'keep')
  const journal = new FailureJournal(root, '1', { maxBytes: 1000 })
  journal.ingest(JSON.stringify({ category: 'tool', operation: 'failed', error: 'bad', token: 'secret', prompt: 'private prompt' }))
  const path = join(root, readdirSync(root).find(name => name.endsWith('.jsonl'))!)
  expect(readFileSync(path, 'utf8')).not.toContain('private prompt')
  for (let index = 0; index < 10; index++) journal.record({ category: 'tool', operation: 'failed', error: 'x'.repeat(800) })
  expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('keep')
})

it('redacts private PEM keys, cookies, URL passwords and full-length backend tokens', () => {
  const text = 'Cookie: secret; https://user:password@host token=' + 'a'.repeat(64)
    + '\n-----BEGIN PRIVATE KEY-----\nsecret material\n-----END PRIVATE KEY-----'
  const clean = redactDiagnostic(text)
  for (const secret of ['secret material', 'user:password', 'a'.repeat(64), 'Cookie: secret']) expect(clean).not.toContain(secret)
})

it('keeps already formatted Host stack strings readable without another inspection layer', () => {
  const root = scratch()
  const journal = new FailureJournal(root, 'test')
  journal.ingest(JSON.stringify({ category: 'agent', operation: 'agent/error', error: 'LlmError: aborted\n    at step' }))
  const file = readdirSync(root).find(name => name.endsWith('.jsonl'))!
  const record = JSON.parse(readFileSync(join(root, file), 'utf8'))
  expect(record.error).toBe('LlmError: aborted\n    at step')
})
