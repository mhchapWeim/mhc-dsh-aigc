/** Host-owned resumable transfers through AIGC; never connects to MinIO directly. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, open, stat, rename, unlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm-managed-backend'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { z } from 'zod'
import { fileHash, manifestSchema, packArchive, restoreBinaryObjects, unpackArchive } from './cloud-archive.ts'
import type { WorkspaceDataMigration } from './data-migration.ts'
import type { CloudBackupListValue, CloudBackupRestoreRequest, CloudBackupUploadRequest, CloudBackupValue, WorkspaceMigrationValue } from './types.ts'

const row = z.object({ id: z.uuid(), createdAt: z.string(), bytes: z.number().nonnegative(), sessionCount: z.number().int().positive(), scope: z.enum(['all', 'selected']), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
const limits = z.object({ userId: z.uuid(), maximumBytes: z.number().int().positive(), partBytes: z.number().int().min(5 * 1024 * 1024).max(16 * 1024 * 1024) })
const transfer = z.object({ id: z.uuid(), state: z.enum(['uploading', 'completing', 'complete', 'legacy']), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  partBytes: z.number().int().positive().optional(), manifest: manifestSchema.optional(), parts: z.array(z.object({ number: z.number().int().positive(), bytes: z.number().int().positive(), eTag: z.string() })).optional() })
const saved = z.object({ folder: z.uuid(), id: z.uuid(), bytes: z.number().int().positive(), sha256: z.string(), manifest: manifestSchema })
async function optionalFile(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error }
}
async function atomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
  await rename(temporary, path)
}
export class CloudBackup {
  private progress = { phase: 'idle', bytes: 0, total: 0 }
  private controller: AbortController | undefined
  constructor(private readonly ctx: Context, private readonly migration: WorkspaceDataMigration, private readonly timeoutMs: number, private readonly home: () => string = resolveDshHome) {}
  /** Report bounded-transfer progress without exposing credentials or file contents. */
  status(): { readonly phase: string; readonly bytes: number; readonly total: number } { return this.progress }
  /** Retain completed parts and the fixed snapshot when pausing network operations. */
  pause(): void { this.controller?.abort() }
  async list(page: number): Promise<CloudBackupListValue> {
    return z.object({ items: z.array(row), total: z.number(), page: z.number(), pageSize: z.number() }).parse(await (await this.request(`?page=${z.number().int().positive().parse(page)}`)).json())
  }
  private async account() {
    const value = limits.parse(await (await this.request('/limits', {}, true)).json())
    const endpoint = this.ctx.get('managedBackend')?.endpoint ?? ''
    const root = join(this.home(), 'cloud-transfers', createHash('sha256').update(`${endpoint}/${value.userId}`).digest('hex'))
    return { ...value, root }
  }
  private async exclusive<T>(phase: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.controller !== undefined) throw new Error('Cloud backup operation is already running')
    const controller = new AbortController()
    this.controller = controller
    this.progress = { phase, bytes: 0, total: 0 }
    try { const result = await operation(controller.signal); this.progress = { ...this.progress, phase: 'complete' }; return result }
    catch (error) { this.progress = { ...this.progress, phase: controller.signal.aborted ? 'paused' : 'failed' }; if (controller.signal.aborted) throw new Error('Cloud backup paused; retry to resume'); throw error }
    finally { this.controller = undefined }
  }
  async upload(input: CloudBackupUploadRequest): Promise<CloudBackupValue> {
    return this.exclusive('snapshot', async signal => {
      const account = await this.account()
      await mkdir(account.root, { recursive: true, mode: 0o700 })
      const selection = createHash('sha256').update(JSON.stringify(input.sessionIds === undefined ? 'all' : [...new Set(input.sessionIds)].sort())).digest('hex')
      const pointer = join(account.root, `${selection}.json`)
      const previous = await optionalFile(pointer)
      let state = previous === undefined ? undefined : saved.parse(JSON.parse(previous))
      if (state !== undefined) {
        let remote: z.infer<typeof transfer> | undefined
        try { remote = transfer.parse(await (await this.request(`/${state.id}`, {}, true, signal)).json()) }
        catch (error) {
          if (!(error instanceof Error) || !/HTTP (404|410)$/.test(error.message)) throw error
          await unlink(pointer)
          await rm(join(account.root, state.folder), { recursive: true, force: true })
          state = undefined
        }
        if (remote?.state === 'complete' && state !== undefined) {
          const value = row.parse(await (await this.request(`/${state.id}/complete`, { method: 'POST' }, true, signal)).json())
          await unlink(pointer)
          await rm(join(account.root, state.folder), { recursive: true, force: true })
          return value
        }
      }
      if (state === undefined) {
        const folder = randomUUID()
        const path = join(account.root, folder)
        const manifest = await this.migration.exportCloudSnapshot(path, account.maximumBytes, input.sessionIds)
        signal.throwIfAborted()
        const archive = await packArchive(path, manifest)
        if (archive.bytes > account.maximumBytes) throw new Error('Backup exceeds capacity limit')
        const started = z.object({ id: z.uuid() }).parse(await (await this.request('', { method: 'POST', body: JSON.stringify({ ...archive, manifest, scope: input.sessionIds === undefined ? 'all' : 'selected' }) }, true, signal)).json())
        state = { folder, id: started.id, ...archive, manifest }
        await atomic(pointer, state)
      }
      const archivePath = join(account.root, state.folder, 'snapshot.tar.gz')
      if ((await stat(archivePath)).size !== state.bytes || await fileHash(archivePath) !== state.sha256) throw new Error('Local snapshot checksum mismatch')
      const remote = transfer.parse(await (await this.request(`/${state.id}`, {}, true, signal)).json())
      const partBytes = remote.partBytes ?? account.partBytes
      if (partBytes < 5 * 1024 * 1024 || partBytes > 16 * 1024 * 1024 || remote.bytes !== state.bytes || remote.sha256 !== state.sha256) throw new Error('Cloud transfer identity mismatch')
      const count = Math.ceil(state.bytes / partBytes)
      const uploaded = new Map(remote.parts?.map(part => [part.number, part.bytes]))
      this.progress = { phase: 'uploading', bytes: remote.state === 'completing' ? state.bytes : [...uploaded.values()].reduce((a, b) => a + b, 0), total: state.bytes }
      if (remote.state === 'uploading') {
        const handle = await open(archivePath, 'r')
        try {
          for (let number = 1; number <= count; number++) {
            signal.throwIfAborted()
            const bytes = Math.min(partBytes, state.bytes - (number - 1) * partBytes)
            if (uploaded.get(number) === bytes) continue
            const buffer = Buffer.alloc(bytes)
            let position = 0
            while (position < bytes) {
              const read = await handle.read(buffer, position, bytes - position, (number - 1) * partBytes + position)
              if (read.bytesRead === 0) throw new Error('Local snapshot is incomplete')
              position += read.bytesRead
            }
            await this.request(`/${state.id}/parts/${number}`, { method: 'PUT', body: buffer, headers: { 'content-type': 'application/octet-stream' } }, true, signal)
            this.progress = { ...this.progress, bytes: this.progress.bytes + bytes }
          }
        } finally { await handle.close() }
      }
      this.progress = { ...this.progress, phase: 'verifying' }
      const value = row.parse(await (await this.request(`/${state.id}/complete`, { method: 'POST' }, true, signal)).json())
      await unlink(pointer)
      await rm(join(account.root, state.folder), { recursive: true, force: true })
      return value
    })
  }
  async measure(input: CloudBackupUploadRequest): Promise<{ readonly bytes: number; readonly limit: number }> {
    const account = await this.account()
    return { bytes: await this.migration.measureSessions(input.sessionIds, true), limit: account.maximumBytes }
  }
  /** Enumerate session names for selective restoration. */
  async sessions(id: string): Promise<readonly { readonly id: string; readonly title: string }[]> {
    const value = transfer.parse(await (await this.request(`/${z.uuid().parse(id)}`, {}, true)).json())
    if (value.state === 'legacy') {
      const payload = await this.legacy(id)
      const data = z.object({ sessions: z.array(z.object({ header: z.object({ id: z.string() }) })) }).parse(JSON.parse(payload))
      return data.sessions.map(item => ({ id: item.header.id, title: item.header.id }))
    }
    if (value.state !== 'complete' || value.manifest === undefined) throw new Error('Backup has not completed')
    return value.manifest.sessions.map(({ id, title }) => ({ id, title }))
  }
  async restore(input: CloudBackupRestoreRequest): Promise<WorkspaceMigrationValue> {
    return this.exclusive('downloading', async signal => {
      const id = z.uuid().parse(input.id)
      const remote = transfer.parse(await (await this.request(`/${id}`, {}, true, signal)).json())
      if (remote.state === 'legacy') {
        const parsed = JSON.parse(await this.legacy(id)) as { sessions: { header: { id: string } }[] }
        if (input.sessionIds !== undefined) parsed.sessions = parsed.sessions.filter(item => input.sessionIds?.includes(item.header.id))
        if (parsed.sessions.length === 0) throw new Error('No Sessions selected')
        const plan = await this.migration.importSessions(JSON.stringify(parsed), input.targetPath)
        return this.migration.commit(plan.migrationId)
      }
      const manifest = remote.manifest
      if (remote.state !== 'complete' || manifest === undefined) throw new Error('Backup has not completed')
      const selected = input.sessionIds === undefined ? manifest.sessions : manifest.sessions.filter(item => input.sessionIds?.includes(item.id))
      if (selected.length === 0 || (input.sessionIds !== undefined && new Set(input.sessionIds).size !== selected.length)) throw new Error('No Sessions selected or invalid selection')
      const account = await this.account()
      const folder = join(account.root, id)
      if (remote.bytes > account.maximumBytes || [...manifest.sessions, ...manifest.objects].reduce((sum, item) => sum + item.bytes, 0) > account.maximumBytes) throw new Error('Backup exceeds capacity limit')
      await mkdir(folder, { recursive: true, mode: 0o700 })
      const path = join(folder, 'snapshot.tar.gz')
      let offset = 0
      try { offset = (await stat(path)).size } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      const handle = await open(path, offset === 0 ? 'w+' : 'r+')
      try {
        if (offset !== remote.bytes) { offset = Math.floor(Math.min(offset, remote.bytes) / account.partBytes) * account.partBytes; await handle.truncate(offset) }
        this.progress = { phase: 'downloading', bytes: offset, total: remote.bytes }
        while (offset < remote.bytes) {
          signal.throwIfAborted()
          const end = Math.min(offset + account.partBytes, remote.bytes) - 1
          const response = await this.request(`/${id}/download`, { headers: { Range: `bytes=${offset}-${end}` } }, true, signal)
          if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${offset}-${end}/${remote.bytes}`) throw new Error('Invalid backup download range')
          const data = new Uint8Array(await response.arrayBuffer())
          if (data.length !== end - offset + 1) throw new Error('Incomplete backup download part')
          let written = 0
          while (written < data.length) {
            const result = await handle.write(data, written, data.length - written, offset + written)
            if (result.bytesWritten === 0) throw new Error('Unable to write backup download')
            written += result.bytesWritten
          }
          offset += data.length
          this.progress = { ...this.progress, bytes: offset }
        }
      } finally { await handle.close() }
      if (await fileHash(path) !== remote.sha256) { await unlink(path); throw new Error('Cloud backup checksum mismatch; retry download') }
      this.progress = { ...this.progress, phase: 'restoring' }
      await unpackArchive(folder, manifest, account.maximumBytes)
      const receiptPath = join(folder, `restore-${createHash('sha256').update(input.targetPath).digest('hex')}.json`)
      const previous = await optionalFile(receiptPath)
      const receipts = z.record(z.string(), z.string()).parse(previous === undefined ? {} : JSON.parse(previous))
      const values: WorkspaceMigrationValue[] = []
      for (const item of selected) {
        signal.throwIfAborted()
        let migrationId = receipts[item.id]
        if (migrationId === undefined) {
          const payload: unknown = JSON.parse(await readFile(join(folder, 'extracted', item.file), 'utf8'))
          const session = await restoreBinaryObjects(this.ctx, payload, folder, manifest)
          const plan = await this.migration.importSessions(JSON.stringify({ version: 1, targetPath: '', sessions: [session] }), input.targetPath, true)
          migrationId = plan.migrationId
          receipts[item.id] = migrationId
          await atomic(receiptPath, receipts)
        }
        values.push(await this.migration.commit(migrationId))
      }
      return { ...values[0]!, completed: values.every(item => item.completed), sessionCount: values.reduce((sum, item) => sum + item.sessionCount, 0),
        results: values.flatMap(item => item.results), warnings: values.flatMap(item => item.warnings) }
    })
  }
  private async legacy(id: string): Promise<string> {
    const value = z.object({ payload: z.string(), sha256: z.string() }).parse(await (await this.request(`/${id}`)).json())
    if (Buffer.byteLength(value.payload) > 24 * 1024 * 1024 || createHash('sha256').update(value.payload).digest('hex') !== value.sha256) throw new Error('Cloud backup checksum mismatch')
    return value.payload
  }
  async remove(id: string): Promise<void> {
    const value = transfer.parse(await (await this.request(`/${z.uuid().parse(id)}`, {}, true)).json())
    await this.request(`/${id}`, { method: 'DELETE' }, value.state !== 'legacy')
  }
  private async request(path: string, init: RequestInit = {}, modern = false, signal?: AbortSignal): Promise<Response> {
    const backend = this.ctx.get('managedBackend')
    if (backend?.accessToken === undefined) throw new Error('Sign in to AIGC before using cloud backups')
    const token = await backend.accessToken()
    const response = await fetch(`${backend.endpoint.replace(/\/$/, '')}/v1/${modern ? 'backup-transfers' : 'backups'}${path}`, {
      ...init, redirect: 'error', signal: signal === undefined ? AbortSignal.timeout(this.timeoutMs) : AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      headers: { 'content-type': 'application/json', ...init.headers, authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw new Error(`Cloud backup HTTP ${response.status}`)
    return response
  }
}
