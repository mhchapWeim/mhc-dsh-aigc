/** Real JSONL storage migration, missing-file repair, and repeatable recovery. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import SessionStore, { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '../../../session/session-projection/src/index.ts'
import SessionProjectionCache from '../../../session/session-projection-cache/src/index.ts'
import { titleProjectionDefinition } from '../../../session/session-title/src/index.ts'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { WorkspaceDataMigration } from '../src/data-migration.ts'
import { CloudBackup } from '../src/cloud-backup.ts'
import LocalAttachmentStore from '../../../attachment/attachment-local/src/index.ts'
import { exportObjects, importObjects, measureObjects } from '../src/portable-attachments.ts'
import WorkspaceController from '../src/index.ts'
import { oneTurnLog } from '../../../session/session-persistence/tests/contract.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function fixture(looseLogs = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-data-migration-'))
  const ctx = new Context()
  cleanup.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const allowedRoot = join(root, 'work')
  const sourcePath = join(allowedRoot, 'old')
  await mkdir(sourcePath, { recursive: true })
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  if (looseLogs) {
    const project = join(root, 'sessions', 'manually-copied')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'unexpected.jsonl'), 'malformed manually copied log')
    await writeFile(join(project, 'unexpected.jsonl.zstd'), 'malformed compressed log')
  }
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility); ctx.provide('storageDomain', facility)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(titleProjectionDefinition)
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
  await ctx.plugin(WorkspaceRegistry, { allowedRoot })
  const source = await ctx.workspaceRegistry.create(sourcePath)
  const id = SessionId('old-history')
  {
    await using handle = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id, createdAt: 1, cwd: sourcePath, isSeeded: false })
    await handle.append(oneTurnLog()); await handle.flush()
  }
  await source.attachSession(id)
  const data = new WorkspaceDataMigration(ctx, () => join(root, 'home'))
  const targetPath = join(allowedRoot, 'new')
  return { ctx, data, root, source, sourcePath, id, targetPath }
}

it('exports selected history and restores copies without archiving existing Sessions', async () => {
  const test = await fixture()
  const payload = await test.data.exportSessions([test.id])
  expect(JSON.parse(payload).sessions).toHaveLength(1)
  const plan = await test.data.importSessions(payload, test.targetPath)
  const result = await test.data.commit(plan.migrationId)
  expect(result.completed).toBe(true)
  expect(test.ctx.workspaceRegistry.archivedSessionIds).not.toContain(test.id)
  expect(await test.ctx.sessionPersistence.stat(result.results[0]!.targetId)).toBeDefined()
  await test.data.commit(plan.migrationId)
  expect(test.ctx.workspaceRegistry.archivedSessionIds).not.toContain(test.id)
  await expect(test.data.exportSessions([])).rejects.toThrow('No Sessions selected')
})

it('carries referenced files across attachment stores and refuses altered binary data', async () => {
  const test = await fixture()
  await test.ctx.plugin(LocalAttachmentStore, { dshHome: join(test.root, 'old-device') })
  const file = await test.ctx.attachments.saveFile({ data: Buffer.from('attachment content'), name: 'test.txt' })
  const image = await test.ctx.attachments.saveImage({ data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64'), mediaType: 'image/png' })
  const sessions = [{ events: [{ data: { content: [{ type: 'file', attachment: file }, { type: 'image', attachment: image }] } }] }]
  const objects = await exportObjects(test.ctx, sessions)
  expect(measureObjects(sessions)).toBe(Buffer.byteLength(JSON.stringify(objects)))
  const next = new Context()
  cleanup.push(() => next.fiber.dispose())
  await next.plugin(LocalAttachmentStore, { dshHome: join(test.root, 'new-device') })
  const payload = JSON.stringify({ version: 1, sessions, objects })
  await importObjects(next, payload)
  expect((await next.attachments.readImage(image)).data).toEqual((await test.ctx.attachments.readImage(image)).data)
  const chunks: Uint8Array[] = []
  for await (const chunk of next.attachments.readFileStream(file)) chunks.push(chunk)
  expect(Buffer.concat(chunks).toString()).toBe('attachment content')
  const tampered = JSON.stringify({ version: 1, sessions, objects: [{ ...objects[0], data: Buffer.from('altered contents!!').toString('base64') }] })
  await expect(importObjects(next, tampered)).rejects.toThrow(/encoding|checksum/)
  await expect(importObjects(next, JSON.stringify({ version: 1, sessions, objects: [] }))).rejects.toThrow('missing an attachment')
})

it('uses the renewed Host credential and refuses corrupt cloud payloads before restore', async () => {
  const test = await fixture()
  const cloud = new CloudBackup(test.ctx, test.data, 120_000)
  await expect(cloud.list(1)).rejects.toThrow('Sign in')
  test.ctx.provide('managedBackend', { endpoint: 'https://aigc.example', accessToken: async () => 'host-token' })
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ payload: '{}', sha256: 'bad' })))
  await expect(cloud.restore({ id: 'f95234b0-6b06-4564-8b9a-63767fe7d7e5', targetPath: test.targetPath })).rejects.toThrow('checksum')
  expect(request).toHaveBeenCalledWith('https://aigc.example/v1/backups/f95234b0-6b06-4564-8b9a-63767fe7d7e5', expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ authorization: 'Bearer host-token' }) }))
  expect((await test.ctx.sessionPersistence.list())).toHaveLength(1)
})

it('uploads through the scoped WorkspaceController using the managed origin and persistence store', async () => {
  const test = await fixture()
  test.ctx.provide('managedBackend', { endpoint: 'https://aigc.example', accessToken: async () => 'host-token' })
  await test.ctx.plugin(TypertRegistry)
  await test.ctx.plugin(WorkspaceController)
  const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const input = JSON.parse(String(init?.body)) as { payload: string; sha256: string; scope: string }
    expect(JSON.parse(input.payload).sessions).toHaveLength(1)
    return new Response(JSON.stringify({ id: 'f95234b0-6b06-4564-8b9a-63767fe7d7e5', createdAt: new Date().toISOString(),
      bytes: Buffer.byteLength(input.payload), sessionCount: 1, scope: input.scope, sha256: input.sha256 }))
  })
  const result = await test.ctx.workspaceController.uploadCloudBackup({})
  expect(result.sessionCount).toBe(1)
  expect(request).toHaveBeenCalledWith('https://aigc.example/v1/backups', expect.objectContaining({ method: 'POST' }))
})

it('lists a saved conversation name instead of requiring users to identify a session id', async () => {
  const test = await fixture()
  await using handle = await test.ctx.sessionPersistence.open(test.id, 'write')
  await handle.append([{ type: 'session/title', seq: SessionSeq(oneTurnLog().length), time: 2,
    data: { title: '设备检测方案讨论', messageSeqs: [], source: { kind: 'user' } } }])
  await handle.flush()
  const status = await test.data.status()
  expect(status.sessions.find(item => item.sessionId === test.id)?.title).toBe('设备检测方案讨论')
})

it('starts the workspace controller and creates workspaces beside malformed loose logs', async () => {
  const test = await fixture(true)
  await test.ctx.plugin(TypertRegistry)
  await test.ctx.plugin(WorkspaceController)
  expect(test.ctx.get('workspaceController')).toBeDefined()
  await mkdir(test.targetPath, { recursive: true })
  const created = await test.ctx.workspaceController.create({ path: test.targetPath })
  expect(created.created).toBe(true)
  expect((await test.ctx.workspaceController.create({ path: test.targetPath })).created).toBe(false)
  expect((await test.ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id)).toContain(test.id)
  expect(await readFile(join(test.root, 'sessions', 'manually-copied', 'unexpected.jsonl'), 'utf8'))
    .toBe('malformed manually copied log')
})

it('copies an old Session to a new cwd even after its original directory is deleted', async () => {
  const test = await fixture()
  {
    await using handle = await test.ctx.sessionPersistence.open(test.id, 'write')
    await handle.append([{ type: 'session/title', seq: SessionSeq(oneTurnLog().length), time: 2, data: { title: '原来的会话名称', messageSeqs: [], source: { kind: 'user' } } }])
    await handle.flush()
  }
  await rm(test.sourcePath, { recursive: true })
  const preview = await test.data.preview({ targetPath: test.targetPath, sourceWorkspaceId: test.source.id, copyFiles: false })
  expect(preview.sessionCount).toBe(1)
  const result = await test.data.commit(preview.migrationId)
  expect(result.completed).toBe(true)
  const targetId = result.results[0]!.targetId
  expect(await test.ctx.sessionPersistence.stat(targetId)).toMatchObject({ header: { cwd: test.targetPath, parentSession: test.id } })
  expect(await test.ctx.sessionPersistence.stat(test.id)).toBeDefined()
  expect(test.ctx.workspaceRegistry.archivedSessionIds).toContain(test.id)
  expect(test.ctx.workspaceRegistry.archivedSessionIds).not.toContain(targetId)
  const snapshot = await test.ctx.sessionPersistence.stat(targetId)
  expect(test.ctx.sessionProjectionCache.cachedSnapshot(snapshot!.header)?.values.title).toBe('原来的会话名称')
  expect(test.ctx.sessions.get(targetId)).toBeUndefined()
  await test.data.commit(preview.migrationId)
  expect((await test.ctx.sessionPersistence.list()).length).toBe(2)
})

it('preserves conflicting target files and resumes the same plan after the conflict is removed', async () => {
  const test = await fixture()
  await writeFile(join(test.sourcePath, 'document.txt'), 'original')
  const preview = await test.data.preview({ targetPath: test.targetPath, sourceWorkspaceId: test.source.id, copyFiles: true })
  await mkdir(test.targetPath)
  await writeFile(join(test.targetPath, 'document.txt'), 'target-owned')
  await expect(test.data.commit(preview.migrationId)).rejects.toThrow(/conflicts/)
  expect(await readFile(join(test.targetPath, 'document.txt'), 'utf8')).toBe('target-owned')
  await rm(join(test.targetPath, 'document.txt'))
  expect((await test.data.commit(preview.migrationId)).completed).toBe(true)
  expect(await readFile(join(test.targetPath, 'document.txt'), 'utf8')).toBe('original')
})

it('reports a failed Session copy and retries without creating duplicate target ids', async () => {
  const test = await fixture()
  const preview = await test.data.preview({ targetPath: test.targetPath, copyFiles: false })
  vi.spyOn(test.ctx.sessionPersistence, 'create').mockRejectedValueOnce(new Error('disk unavailable'))
  const failed = await test.data.commit(preview.migrationId)
  expect(failed.completed).toBe(false)
  expect(failed.results[0]!.error).toContain('disk unavailable')
  expect(test.ctx.workspaceRegistry.archivedSessionIds).not.toContain(test.id)
  const recovered = await test.data.commit(preview.migrationId)
  expect(recovered.completed).toBe(true)
  expect(recovered.results[0]!.targetId).toBe(failed.results[0]!.targetId)
})

it('restores a saved Session backup into a different directory', async () => {
  const test = await fixture()
  const first = await test.data.preview({ targetPath: test.targetPath, copyFiles: false })
  const restored = await test.data.preview({ targetPath: join(test.targetPath, 'restored'), historyPath: first.backupPath, copyFiles: false })
  expect((await test.data.commit(restored.migrationId)).completed).toBe(true)
})

it('imports a moved old sessions root without modifying the source history', async () => {
  const test = await fixture()
  const preview = await test.data.preview({ targetPath: test.targetPath, historyPath: join(test.root, 'sessions'), copyFiles: false })
  expect(preview.sessionCount).toBe(1)
  expect((await test.data.commit(preview.migrationId)).completed).toBe(true)
  expect(await test.ctx.sessionPersistence.stat(test.id)).toBeDefined()
})

it('cleans definitely missing Session references while keeping the workspace registration', async () => {
  const test = await fixture()
  await rm(join(test.root, 'sessions'), { recursive: true })
  const status = await test.data.status()
  expect(status.sessions).toContainEqual({ sessionId: test.id, status: 'missing' })
  expect(await test.ctx.workspaceRegistry.forgetMissingSessions()).toBe(1)
  expect(test.ctx.workspaceRegistry.get(test.source.id)).toBeDefined()
  expect(test.ctx.workspaceRegistry.accountedSessionIds()).toEqual([])
})

it('rejects out-of-root destinations before creating them', async () => {
  const test = await fixture()
  await expect(test.data.preview({ targetPath: join(test.root, 'outside'), copyFiles: false })).rejects.toThrow(/inside/)
})

it('restores workspace files and empty directories from a backup after the source is deleted', async () => {
  const test = await fixture()
  await writeFile(join(test.sourcePath, 'keep.txt'), 'saved content')
  await mkdir(join(test.sourcePath, 'empty'))
  const saved = await test.data.preview({ targetPath: test.targetPath, sourceWorkspaceId: test.source.id, copyFiles: true })
  await rm(test.sourcePath, { recursive: true })
  const restored = await test.data.preview({ targetPath: test.targetPath, historyPath: saved.backupPath, copyFiles: true })
  expect((await test.data.commit(restored.migrationId)).completed).toBe(true)
  expect(await readFile(join(test.targetPath, 'keep.txt'), 'utf8')).toBe('saved content')
  expect((await test.data.status()).migrations).toHaveLength(2)
})

it('refuses a modified backup and retains the original Session', async () => {
  const test = await fixture()
  const saved = await test.data.preview({ targetPath: test.targetPath, copyFiles: false })
  await writeFile(join(saved.backupPath, 'sessions.json'), '{}')
  await expect(test.data.commit(saved.migrationId)).rejects.toThrow(/checksum/)
  expect(await test.ctx.sessionPersistence.stat(test.id)).toBeDefined()
})

it('loads the Workspace data API through cordis.yml and repairs a missing registered directory', async () => {
  const test = await fixture()
  await rm(test.sourcePath, { recursive: true })
  const configPath = join(test.root, 'cordis.yml')
  await writeFile(configPath, '- id: typert\n  name: cordis:test-typert\n- id: workspace-api\n  name: cordis:test-workspace-api\n')
  test.ctx.baseUrl = `${pathToFileURL(test.root).href}/`
  await test.ctx.plugin(Loader)
  test.ctx.loader.builtins.include = Include
  test.ctx.loader.builtins['test-typert'] = TypertRegistry
  test.ctx.loader.builtins['test-workspace-api'] = WorkspaceController
  await test.ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await test.ctx.loader.await()
  const entry = [...test.ctx.loader.entries()].find(candidate => candidate.options.id === 'workspace-api')!
  await entry.fiber!.await()
  const status = await test.ctx.workspaceController.dataStatus()
  expect(status.workspaces.find(workspace => workspace.workspaceId === test.source.id)?.status).toBe('missing-dir')
  await test.ctx.workspaceController.repairDirectory({ workspaceId: test.source.id })
  expect((await test.ctx.workspaceController.dataStatus()).workspaces[0]!.status).toBe('ok')
  await entry.fiber!.dispose()
  expect(test.ctx.get('workspaceController')).toBeUndefined()
})

it('stress: 30 migrations with injected disk failures resume and retain every original', async () => {
  const test = await fixture()
  for (let round = 0; round < 30; round++) {
    const targetPath = join(test.targetPath, `copy-${round}`)
    const plan = await test.data.preview({ targetPath, sourceWorkspaceId: test.source.id, sessionIds: [test.id], copyFiles: false })
    if (round % 2 === 0) {
      const fail = vi.spyOn(test.ctx.sessionPersistence, 'create').mockRejectedValueOnce(new Error('simulated disk write failure'))
      expect((await test.data.commit(plan.migrationId)).completed).toBe(false)
      fail.mockRestore()
    }
    const result = await test.data.commit(plan.migrationId)
    expect(result.completed, `migration ${round}`).toBe(true)
    expect(result.results[0]!.targetId).toBe(plan.results[0]!.targetId)
    expect(await test.ctx.sessionPersistence.stat(test.id)).toBeDefined()
    const resumed = new WorkspaceDataMigration(test.ctx, () => join(test.root, 'home'))
    expect((await resumed.commit(plan.migrationId)).completed).toBe(true)
  }
  expect((await test.ctx.sessionPersistence.list()).length).toBe(31)
}, 60_000)

it('measures the exact serialized backup bytes locally without a cloud request', async () => {
  const test = await fixture()
  const cloud = new CloudBackup(test.ctx, test.data, 120_000)
  const request = vi.spyOn(globalThis, 'fetch')
  const payload = await test.data.exportSessions([test.id])
  expect(await cloud.measure({ sessionIds: [test.id] })).toEqual({ bytes: Buffer.byteLength(payload), limit: 24 * 1024 * 1024 })
  expect(request).not.toHaveBeenCalled()
})

it('counts oversized encoded attachments without reading or rejecting them', () => {
  const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, name: '中文图片.png', bytes: 30 * 1024 * 1024 }
  expect(measureObjects([{ file: ref }, { repeated: ref }])).toBe(
    Buffer.byteLength(JSON.stringify([{ ref, data: '' }])) + 40 * 1024 * 1024,
  )
})

it('measures persisted history while work is running but still blocks upload', async () => {
  const test = await fixture()
  vi.spyOn(test.ctx, 'waterfall').mockResolvedValue([{ kind: 'running' }] as never)
  const cloud = new CloudBackup(test.ctx, test.data, 120_000)
  expect((await cloud.measure({ sessionIds: [test.id] })).bytes).toBeGreaterThan(0)
  await expect(cloud.upload({ sessionIds: [test.id] })).rejects.toThrow('Session is running')
})
