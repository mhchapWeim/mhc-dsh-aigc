/** Copy migrations with durable backups, verified files, and retryable receipts. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { assertContiguous, materializeCreateHeader, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-title'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'
import { exportObjects, importObjects, measureObjects } from './portable-attachments.ts'
import { exportBinaryObjects, type CloudManifest } from './cloud-archive.ts'
import type { WorkspaceDataStatus, WorkspaceMigrationRequest, WorkspaceMigrationValue } from './types.ts'

const requestSchema = z.object({
  targetPath: z.string().min(1), sourceWorkspaceId: z.string().optional(),
  sessionIds: z.array(z.string()).optional(), historyPath: z.string().optional(), copyFiles: z.boolean(), archiveOriginals: z.boolean().optional(),
})
const backupSchema = z.object({
  version: z.literal(1), targetPath: z.string(),
  sessions: z.array(z.object({
    header: z.object({ version: z.literal(SESSION_FORMAT_VERSION), id: z.string().min(1).transform(SessionId),
      createdAt: z.number().int().nonnegative(), cwd: z.string().optional(), isSeeded: z.boolean(),
      parentSession: z.string().transform(SessionId).optional(), agentPreset: z.string().optional(),
      origin: z.literal('subagent').optional(), delegationDepth: z.number().int().nonnegative().optional() }),
    events: z.array(z.object({ type: z.string(), seq: z.number().int().nonnegative(), time: z.number(), data: z.unknown() }).passthrough()),
    inheritedEventCount: z.number().int().nonnegative(),
  })),
})
const receiptSchema = z.object({
  archiveOriginals: z.boolean().optional(),
  migrationId: z.uuid(), backupPath: z.string(), targetPath: z.string(), sessionCount: z.number(), fileCount: z.number(),
  warnings: z.array(z.string()), completed: z.boolean(),
  results: z.array(z.object({ sourceId: z.string(), targetId: z.string(), error: z.string().optional() })),
})
interface SessionBackup { header: SessionHeader; events: readonly SessionEvent[]; inheritedEventCount: number }
interface FileEntry { path: string; hash: string; size: number; kind: 'file' | 'directory' }

/** Host-owned migration queue. Source logs, credentials, and original directories are never rewritten. */
export class WorkspaceDataMigration {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly ctx: Context, private readonly home: () => string = resolveDshHome) {}

  /** Inspect persisted Sessions independently; one missing artifact does not hide other records. */
  async status(): Promise<WorkspaceDataStatus> {
    const registry = this.ctx.workspaceRegistry
    const workspaces = await Promise.all(registry.list().map(async workspace => ({
      workspaceId: workspace.id, path: workspace.path, title: workspace.title, sessionIds: workspace.sessionIds,
      createdAt: workspace.createdAt, updatedAt: workspace.updatedAt, status: await workspace.status(),
    })))
    const persistence = this.ctx.get('sessionPersistence')
    const snapshots = persistence === undefined ? [] : await persistence.list()
    const ids = new Set([...snapshots.map(item => item.header.id), ...registry.accountedSessionIds()])
    const sessions: WorkspaceDataStatus['sessions'][number][] = []
    for (const sessionId of ids) {
      try {
        const snapshot = await persistence?.stat(sessionId)
        let title: string | undefined
        if (snapshot !== undefined) {
          const cache = this.ctx.get('sessionProjectionCache')
          const block = cache?.cachedSnapshot(snapshot.header) ?? cache?.cachedPredecessorTitle(snapshot.header)
          title = block?.values.title ?? undefined
          if (title === undefined && persistence !== undefined) {
            const saved = await readSession(persistence, sessionId)
            for (const event of saved.events) {
              if (event.type === 'session/title') {
                title = event.data.title
              }
            }
            if (title === undefined) {
              for (const event of saved.events) {
                if (event.type !== 'user/message') continue
                const text = event.data.content.filter(part => part.type === 'text').map(part => part.text).join(' ').trim()
                if (text !== '') { title = text.slice(0, 80); break }
              }
            }
          }
        }
        sessions.push({ sessionId, ...(title === undefined ? {} : { title }), ...(snapshot === undefined ? {} : { createdAt: snapshot.header.createdAt }), ...(registry.archivedSessionIds.includes(sessionId) ? { archived: true } : {}), ...(snapshot?.header.cwd === undefined ? {} : { cwd: snapshot.header.cwd }), status: snapshot === undefined ? 'missing' : 'ok' })
      } catch (_unreadableSession) { sessions.push({ sessionId, status: 'unreadable' }) }
    }
    const migrations: WorkspaceMigrationValue[] = []
    const root = join(this.home(), 'migrations')
    if (await exists(root)) {
      for (const id of (await readdir(root)).sort()) {
        if (!z.uuid().safeParse(id).success) continue
        try {
          const receipt = receiptSchema.parse(JSON.parse(await readFile(join(root, id, 'receipt.json'), 'utf8')))
          migrations.push({ ...receipt, results: receipt.results.map(item => ({ sourceId: SessionId(item.sourceId), targetId: SessionId(item.targetId), ...(item.error === undefined ? {} : { error: item.error }) })) })
        } catch (error) { this.ctx.logger.warn('Migration receipt unavailable: %s: %s', id, message(error)) }
      }
    }
    return { ...(registry.allowedRoot === undefined ? {} : { allowedRoot: registry.allowedRoot }), workspaces, sessions, migrations }
  }

  /** Save a backup and a plan without publishing target data. */
  preview(input: WorkspaceMigrationRequest): Promise<WorkspaceMigrationValue> {
    return this.enqueue(async () => {
      const request = requestSchema.parse(input)
      const targetPath = resolve(request.targetPath)
      if (!isAbsolute(request.targetPath)) throw new Error('Target directory must be absolute')
      await this.ctx.workspaceRegistry.checkDirectoryTarget(targetPath)
      const source = request.sourceWorkspaceId === undefined ? undefined : this.ctx.workspaceRegistry.get(WorkspaceId(request.sourceWorkspaceId))
      if (request.sourceWorkspaceId !== undefined && source === undefined) throw new Error('Source Workspace no longer exists; refresh the data list')
      if (request.copyFiles && source === undefined && request.historyPath === undefined) throw new Error('Copying files requires a source Workspace or a migration backup')
      if (request.copyFiles && source !== undefined && (inside(source.path, targetPath) || inside(targetPath, source.path))) {
        throw new Error('Source and target directories must not contain each other')
      }
      const migrationId = randomUUID()
      const backupPath = this.directory(migrationId)
      await mkdir(backupPath, { recursive: true, mode: 0o700 })
      const warnings: string[] = []
      const sessions: SessionBackup[] = []
      let persistence = this.ctx.get('sessionPersistence')
      let importContext: Context | undefined
      let restoreFiles: string | undefined
      try {
        if (request.historyPath !== undefined) {
          if (!isAbsolute(request.historyPath)) throw new Error('History directory must be absolute')
          const original = resolve(request.historyPath)
          if (inside(original, backupPath)) throw new Error('History source cannot contain the migration backup directory')
          const archive = join(original, 'sessions.json')
          if (await exists(archive)) {
            sessions.push(...await this.readBackup(archive))
            if (request.copyFiles) {
              restoreFiles = join(original, 'files')
              if (!await exists(restoreFiles)) throw new Error('This backup contains no workspace files')
            }
            persistence = undefined
          } else {
            if (request.copyFiles) throw new Error('An old sessions root contains history only; choose a registered Workspace to copy files')
            // Historical format migrations run against a copy, never the user's source.
            const copied = join(backupPath, 'original-history')
            const originalFiles = await inventory(original)
            await cp(original, copied, { recursive: true, errorOnExist: true, force: false })
            importContext = new Context()
            const compressed = originalFiles.some(file => file.path.endsWith('.jsonl.zst'))
            await importContext.plugin(JsonlSessionPersistence, { root: copied, compression: compressed ? 'zstd' : 'none' })
            persistence = importContext.sessionPersistence
          }
        }
        if (persistence !== undefined) {
          if (request.historyPath === undefined) await persistence.flush()
          const selected = request.sessionIds?.map(SessionId)
            ?? (source === undefined ? (await persistence.list()).map(item => item.header.id)
              : this.ctx.workspaceRegistry.accountedSessionIds(source.id))
          for (const id of new Set(selected)) {
            if (request.historyPath === undefined && request.sessionIds === undefined && this.ctx.workspaceRegistry.archivedSessionIds.includes(id)) continue
            try {
              if (request.historyPath === undefined) await this.assertInactive(id)
              sessions.push(await readSession(persistence, id))
            } catch (error) { warnings.push(`${id}: ${message(error)}`) }
          }
        }
      } finally { await importContext?.fiber.dispose() }
      if (sessions.length === 0 && !request.copyFiles) throw new Error('No readable Sessions selected; originals have been retained')
      await atomicJson(join(backupPath, 'sessions.json'), { version: 1, targetPath, sessions })
      await writeFile(join(backupPath, 'sessions.sha256'), await digest(join(backupPath, 'sessions.json')), { mode: 0o600 })
      let files: FileEntry[] = []
      if (request.copyFiles && (source !== undefined || restoreFiles !== undefined)) {
        try {
          const from = restoreFiles ?? source!.path
          const before = await inventory(from)
          if (restoreFiles !== undefined) {
            const expected = JSON.parse(await readFile(join(dirname(restoreFiles), 'files.json'), 'utf8'))
            if (JSON.stringify(before) !== JSON.stringify(expected)) throw new Error('Workspace backup checksum mismatch')
          }
          const staged = join(backupPath, 'files')
          await cp(from, staged, { recursive: true, errorOnExist: true, force: false })
          files = await inventory(staged)
          if (JSON.stringify(before) !== JSON.stringify(files)) throw new Error('Source files changed while backing up; preview again')
          await atomicJson(join(backupPath, 'files.json'), files)
        } catch (error) { throw new Error(`Workspace backup failed; source was retained: ${message(error)}`) }
      }
      const receipt: WorkspaceMigrationValue = {
        ...(request.archiveOriginals === undefined ? {} : { archiveOriginals: request.archiveOriginals }),
        migrationId, backupPath, targetPath, sessionCount: sessions.length, fileCount: files.filter(file => file.kind === 'file').length, warnings, completed: false,
        results: sessions.map(item => ({ sourceId: item.header.id, targetId: SessionId(`session-${randomUUID()}`) })),
      }
      await atomicJson(join(backupPath, 'receipt.json'), receipt)
      return receipt
    })
  }

  /** Resume exactly the same target ids after an interrupted migration. */
  commit(migrationId: string): Promise<WorkspaceMigrationValue> {
    return this.enqueue(async () => {
      const backupPath = this.directory(migrationId)
      const parsed = receiptSchema.parse(JSON.parse(await readFile(join(backupPath, 'receipt.json'), 'utf8')))
      if (parsed.migrationId !== migrationId || resolve(parsed.backupPath) !== resolve(backupPath)) throw new Error('Migration receipt identity mismatch')
      if (parsed.completed) {
        for (const item of parsed.results) {
          const target = await readSession(this.requirePersistence(), SessionId(item.targetId))
          await this.ctx.get('sessionProjectionCache')?.writeCold(target.header, SessionLogOffset(target.inheritedEventCount), target.events)
          if (parsed.archiveOriginals !== false && await this.requirePersistence().stat(SessionId(item.sourceId)) !== undefined) await this.ctx.workspaceRegistry.archiveSession(SessionId(item.sourceId))
        }
        return {
        ...parsed, results: parsed.results.map(item => ({ sourceId: SessionId(item.sourceId), targetId: SessionId(item.targetId), ...(item.error === undefined ? {} : { error: item.error }) })),
        }
      }
      const sessions = await this.readBackup(join(backupPath, 'sessions.json'))
      if (sessions.length !== parsed.results.length) throw new Error('Migration backup and receipt disagree')
      await this.ctx.workspaceRegistry.prepareDirectory(parsed.targetPath)
      const workspace = await this.ctx.workspaceRegistry.create(parsed.targetPath)
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence === undefined) throw new Error('Session storage is unavailable; backup retained')
      if (await exists(join(backupPath, 'files.json'))) {
        const files = z.array(z.object({ path: z.string(), hash: z.string(), size: z.number(), kind: z.enum(['file', 'directory']) }))
          .parse(JSON.parse(await readFile(join(backupPath, 'files.json'), 'utf8')))
        for (const file of files) {
          const target = resolve(parsed.targetPath, file.path)
          if (!inside(parsed.targetPath, target) || target === resolve(parsed.targetPath)) throw new Error('Invalid backup file path')
          if (file.kind === 'directory') { await this.ctx.workspaceRegistry.prepareDirectory(target); continue }
          const source = resolve(backupPath, 'files', file.path)
          if (!inside(join(backupPath, 'files'), source)) throw new Error('Invalid backup source path')
          if (await digest(source) !== file.hash) throw new Error(`Backup checksum mismatch: ${file.path}`)
          await this.ctx.workspaceRegistry.prepareDirectory(dirname(target))
          if (await exists(target)) {
            if ((await lstat(target)).isSymbolicLink() || await digest(target) !== file.hash) throw new Error(`Target file conflicts; nothing overwritten: ${file.path}`)
          } else await cp(source, target, { errorOnExist: true, force: false })
          if (await digest(target) !== file.hash) throw new Error(`Target verification failed: ${file.path}`)
        }
      }
      const results: { sourceId: SessionId; targetId: SessionId; error?: string }[] = []
      for (const [index, saved] of sessions.entries()) {
        const targetId = SessionId(parsed.results[index]!.targetId)
        try {
          const seed = saved.events.length === 0 ? [] : buildForkSeed(saved.events, SessionSeq(saved.events.length - 1))
          const header: SessionHeader = {
            version: saved.header.version, id: targetId, createdAt: saved.header.createdAt, cwd: workspace.path,
            isSeeded: seed.length > 0, parentSession: saved.header.id,
            ...(saved.header.agentPreset === undefined ? {} : { agentPreset: saved.header.agentPreset }),
          }
          const existing = await persistence.stat(targetId)
          if (existing === undefined) {
            await using handle = await persistence.create(header, { inheritedEventCount: SessionLogOffset(saved.events.length) })
            await handle.append(seed)
            await handle.flush()
          } else {
            const partial = await readSession(persistence, targetId)
            if (partial.header.cwd !== workspace.path || partial.header.parentSession !== saved.header.id
              || JSON.stringify(partial.events) !== JSON.stringify(seed.slice(0, partial.events.length))) throw new Error('Target Session changed; restore from backup into a new migration')
            if (partial.events.length < seed.length) {
              await this.assertInactive(targetId)
              await using handle = await persistence.open(targetId, 'write')
              await handle.append(seed.slice(partial.events.length)); await handle.flush()
            }
          }
          const written = await readSession(persistence, targetId)
          if (written.header.cwd !== workspace.path || written.header.parentSession !== saved.header.id
            || JSON.stringify(written.events) !== JSON.stringify(seed)) throw new Error('Target Session differs from the migration backup')
          await this.ctx.get('sessionProjectionCache')?.writeCold(written.header, SessionLogOffset(written.inheritedEventCount), written.events)
          await workspace.attachSession(targetId)
          if (parsed.archiveOriginals !== false && await persistence.stat(saved.header.id) !== undefined) await this.ctx.workspaceRegistry.archiveSession(saved.header.id)
          results.push({ sourceId: saved.header.id, targetId })
        } catch (error) { results.push({ sourceId: saved.header.id, targetId, error: message(error) }) }
        await atomicJson(join(backupPath, 'receipt.json'), { ...parsed, results: [...results, ...parsed.results.slice(index + 1)], completed: false })
      }
      const value: WorkspaceMigrationValue = {
        ...parsed, backupPath, results, completed: results.every(item => item.error === undefined),
      }
      await atomicJson(join(backupPath, 'receipt.json'), value)
      return value
    })
  }

  private requirePersistence(): SessionPersistence {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('Session storage is not available; restart the client and retry')
    return persistence
  }

  private directory(id: string): string { return join(this.home(), 'migrations', z.uuid().parse(id)) }

  /** Export a consistent snapshot; active or unreadable selections fail without a partial upload. */
  exportSessions(ids?: readonly SessionId[]): Promise<string> {
    return this.enqueue(async () => {
      await this.requirePersistence().flush()
      const selected = ids ?? (await this.requirePersistence().list()).map(item => item.header.id)
      if (selected.length === 0) throw new Error('No Sessions selected')
      const sessions: SessionBackup[] = []
      for (const id of new Set(selected)) {
        await this.assertInactive(id)
        sessions.push(await readSession(this.requirePersistence(), id))
      }
      return JSON.stringify({ version: 1, targetPath: '', sessions, objects: await exportObjects(this.ctx, sessions) })
    })
  }

  /** Measure persisted history and encoded attachment sizes without building an upload. */
  measureSessions(ids?: readonly SessionId[], binary = false): Promise<number> {
    return this.enqueue(async () => {
      const persistence = this.requirePersistence()
      await persistence.flush()
      const selected = ids ?? (await persistence.list()).map(item => item.header.id)
      const sessions: SessionBackup[] = []
      for (const id of new Set(selected)) sessions.push(await readSession(persistence, id))
      const envelope = JSON.stringify({ version: 1, targetPath: '', sessions, objects: [] })
      return Buffer.byteLength(envelope) - 2 + measureObjects(sessions, binary)
    })
  }

  /** Validate downloaded history before creating a local migration receipt. */
  async importSessions(payload: string, targetPath: string, storedObjects = false): Promise<WorkspaceMigrationValue> {
    if (!isAbsolute(targetPath)) throw new Error('Target directory must be absolute')
    await this.ctx.workspaceRegistry.checkDirectoryTarget(resolve(targetPath))
    backupSchema.parse(JSON.parse(payload))
    if (!storedObjects) payload = await importObjects(this.ctx, payload)
    const staging = join(this.home(), 'cloud-downloads', randomUUID())
    await mkdir(staging, { recursive: true, mode: 0o700 })
    await writeFile(join(staging, 'sessions.json'), payload, { mode: 0o600 })
    await writeFile(join(staging, 'sessions.sha256'), createHash('sha256').update(payload).digest('hex'), { mode: 0o600 })
    return this.preview({ targetPath, historyPath: staging, copyFiles: false, archiveOriginals: false })
  }
  private async assertInactive(sessionId: SessionId): Promise<void> {
    const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    if (activity.length > 0) throw new Error('Session is running; stop its work before migration')
  }

  /** Freeze selected histories into separate files and content-addressed binary objects. */
  exportCloudSnapshot(folder: string, maximumBytes: number, ids?: readonly SessionId[]): Promise<CloudManifest> {
    return this.enqueue(async () => {
      const persistence = this.requirePersistence()
      await persistence.flush()
      const selected = [...new Set(ids ?? (await persistence.list()).map(item => item.header.id))]
      if (selected.length === 0) throw new Error('No Sessions selected')
      const manifest: CloudManifest = { version: 2, sessions: [], objects: [] }
      await mkdir(join(folder, 'sessions'), { recursive: true, mode: 0o700 })
      await mkdir(join(folder, 'objects'), { recursive: true, mode: 0o700 })
      let bytes = 0
      for (const id of selected) {
        await this.assertInactive(id)
        const session = await readSession(persistence, id)
        const payload = JSON.stringify(session)
        const length = Buffer.byteLength(payload)
        bytes += length
        if (bytes + manifest.objects.reduce((sum, item) => sum + item.bytes, 0) > maximumBytes) throw new Error('Backup exceeds capacity limit')
        const file = `sessions/${createHash('sha256').update(id).digest('hex')}.json`
        await writeFile(join(folder, file), payload, { mode: 0o600 })
        const title = session.events.filter(event => event.type === 'session/title').at(-1)
        manifest.sessions.push({ id, file, bytes: length, sha256: createHash('sha256').update(payload).digest('hex'), title: title?.type === 'session/title' ? title.data.title.slice(0, 512) : String(id) })
        await exportBinaryObjects(this.ctx, session, folder, manifest, maximumBytes - bytes)
      }
      return manifest
    })
  }
  private async readBackup(path: string): Promise<SessionBackup[]> {
    const checksum = join(dirname(path), 'sessions.sha256')
    if (await exists(checksum) && (await readFile(checksum, 'utf8')).trim() !== await digest(path)) throw new Error('Session backup checksum mismatch')
    const backup = backupSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    return backup.sessions.map(item => {
      const header = materializeCreateHeader({
        version: item.header.version, id: item.header.id, createdAt: item.header.createdAt, isSeeded: item.header.isSeeded,
        ...(item.header.cwd === undefined ? {} : { cwd: item.header.cwd }),
        ...(item.header.parentSession === undefined ? {} : { parentSession: item.header.parentSession }),
        ...(item.header.agentPreset === undefined ? {} : { agentPreset: item.header.agentPreset }),
        ...(item.header.origin === undefined ? {} : { origin: item.header.origin }),
        ...(item.header.delegationDepth === undefined ? {} : { delegationDepth: item.header.delegationDepth }),
      })
      // Parser boundary: the persistence validator checks envelopes, sequence, and event JSON.
      const events = validateStoredEvents(header, item.events as SessionEvent[])
      assertContiguous(header.id, events, 0)
      return { header, events, inheritedEventCount: item.inheritedEventCount }
    })
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

async function readSession(persistence: SessionPersistence, id: SessionId): Promise<SessionBackup> {
  await using handle = await persistence.open(id, 'read')
  const { events } = await handle.read()
  return { header: handle.header, events, inheritedEventCount: handle.inheritedEventCount }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function inside(root: string, path: string): boolean {
  const suffix = relative(resolve(root), resolve(path))
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}
async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function inventory(root: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = []
  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) throw new Error(`Linked files and directories must be migrated separately: ${path}`)
    if (metadata.isDirectory()) {
      if (path !== root) entries.push({ path: relative(root, path), hash: '', size: 0, kind: 'directory' })
      for (const child of (await readdir(path)).sort()) await visit(join(path, child))
    } else if (metadata.isFile()) entries.push({ path: relative(root, path), hash: await digest(path), size: metadata.size, kind: 'file' })
    else throw new Error(`Unsupported file type: ${path}`)
  }
  await visit(root)
  return entries
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync() }
  finally { await file.close() }
  await rename(temporary, path)
}
