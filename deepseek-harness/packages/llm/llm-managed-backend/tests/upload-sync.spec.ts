import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { UploadSync } from '../src/upload-sync.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each([true, false])('reports queued file metadata without opening or uploading content (acknowledged: %s)', async completed => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-metadata-sync-'))
  roots.push(home)
  const path = join(home, 'managed-upload-sync', 'state.json')
  await mkdir(join(home, 'managed-upload-sync'))
  await writeFile(path, JSON.stringify({ version: 1, active: true, deviceId: 'device-1', cursor: {}, pending: [{
    id: 'task-1', sessionId: 'session-1', eventSeq: 1, prompt: 'inspect', deviceId: 'device-1',
    computerName: 'test-host', storedPath: 'C:\\stored\\report.txt',
    file: { attachmentId: 'sha256:missing-local-content', name: 'report.txt', bytes: 123 }, userId: 'user-1',
  }] }))
  const ctx = new Context()
  const credentials = new MemoryCredentials(ctx)
  await credentials.modifyRecord(credentialKey('llm-managed-backend', 'device-user'), async () => ({ kind: 'grant', payload: { id: 'user-1' } }))
  await credentials.modifyRecord(credentialKey('llm-managed-backend', 'user-session'), async () => ({ kind: 'api-key', key: 'token-1' }))
  const readFileStream = vi.fn(() => { throw new Error('File content must not be opened') })
  Object.defineProperty(ctx, 'sessionPersistence', { value: { list: async () => [] } })
  Object.defineProperty(ctx, 'attachments', { value: { readFileStream } })
  const request = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe('https://organization.test/v1/uploads')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token-1')
    expect(JSON.parse(String(init?.body))).toEqual({
      userId: 'user-1', clientUploadId: 'task-1', sessionId: 'session-1', eventSeq: 1, prompt: 'inspect',
      deviceId: 'device-1', computerName: 'test-host', storedPath: 'C:\\stored\\report.txt', fileName: 'report.txt', bytes: 123,
    })
    return Response.json({ completed, offset: 0, bytes: 123 })
  })
  const worker = new UploadSync(ctx, 'https://organization.test', { pollMs: 1000, chunkBytes: 4, requestTimeoutMs: 1000 }, { home, request })
  await worker.start()
  await worker.stop()
  const state = JSON.parse(await readFile(path, 'utf8'))
  expect(state.pending).toHaveLength(completed ? 0 : 1)
  if (!completed) expect(state.pending[0].lastError).toContain('update the organization backend')
  expect(readFileStream).not.toHaveBeenCalled()
  expect(request).toHaveBeenCalledTimes(1)
})
