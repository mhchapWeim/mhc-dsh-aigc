/** Crash-recoverable synchronization of submitted chat files to the organization backend. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { z } from 'zod'

/** Deployment-owned transfer budget; the server refuses chunks above four MiB. */
export interface UploadSyncConfig {
  readonly pollMs: number
  readonly chunkBytes: number
  readonly requestTimeoutMs: number
}

const taskSchema = z.object({
  id: z.string(), sessionId: z.string(), eventSeq: z.number().int().nonnegative(), prompt: z.string(),
  deviceId: z.string(), computerName: z.string(), storedPath: z.string(),
  file: z.object({ attachmentId: z.string(), name: z.string(), bytes: z.number().int().nonnegative() }),
  userId: z.string().nullable(), lastError: z.string().optional(),
})
const stateSchema = z.object({ version: z.literal(1), active: z.boolean(), deviceId: z.string(),
  cursor: z.record(z.string(), z.number().int().nonnegative()), pending: z.array(taskSchema) })
const responseSchema = z.object({ offset: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), completed: z.boolean() })
type State = z.infer<typeof stateSchema>
type Task = State['pending'][number]

function submittedFiles(event: SessionEvent): { prompt: string; files: FileAttachmentRef[] } | undefined {
  if (event.type !== 'user/message' || event.data.source.kind !== 'user') return undefined
  const files = event.data.content.filter(part => part.type === 'file').map(part => part.attachment)
  if (files.length === 0) return undefined
  return { prompt: event.data.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), files }
}

/** Reconstruct eligible file tasks from stored user messages and persist transfer progress. */
export class UploadSync {
  private state: State | undefined
  private inFlight: Promise<void> | undefined
  private stopped = false
  private readonly path: string
  private readonly requestHttp: typeof fetch
  private readonly computerName: () => string

  constructor(private readonly ctx: Context, private readonly endpoint: string, private readonly config: UploadSyncConfig,
    internals: { home?: string; request?: typeof fetch; computerName?: () => string } = {}) {
    const home = internals.home ?? resolveDshHome(launchEnvironmentOf(ctx).get('DSH_HOME')?.value)
    this.path = join(home, 'managed-upload-sync', 'state.json')
    this.requestHttp = internals.request ?? fetch
    this.computerName = internals.computerName ?? hostname
  }

  async start(): Promise<void> {
    const previous = await readFile(this.path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (previous === undefined) {
      const cursor: Record<string, number> = {}
      for (const snapshot of await this.ctx.sessionPersistence.list()) {
        await using handle = await this.ctx.sessionPersistence.open(snapshot.header.id, 'read')
        cursor[String(snapshot.header.id)] = (await handle.read()).events.length
      }
      this.state = { version: 1, active: true, deviceId: randomUUID(), cursor, pending: [] }
    } else {
      this.state = stateSchema.parse(JSON.parse(previous))
      if (!this.state.active) {
        for (const snapshot of await this.ctx.sessionPersistence.list()) {
          await using handle = await this.ctx.sessionPersistence.open(snapshot.header.id, 'read')
          this.state.cursor[String(snapshot.header.id)] = (await handle.read()).events.length
        }
        this.state.active = true
      }
    }
    await this.save()
    await this.tick()
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.inFlight
    if (this.state === undefined) return
    await this.scan()
    this.state.active = false
    await this.save()
  }

  tick(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight
    if (this.stopped || this.state === undefined) return Promise.resolve()
    this.inFlight = this.run().finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  private async run(): Promise<void> {
    await this.scan()
    for (const task of [...this.state!.pending]) {
      if (this.stopped) break
      try {
        const token = await this.token()
        if (token === undefined) break
        const bound = await this.ctx.credentials.readRecord(credentialKey('llm-managed-backend', 'device-user'))
        const owner = z.object({ id: z.string() }).safeParse(bound?.kind === 'grant' ? bound.payload : undefined)
        if (!owner.success || (task.userId !== null && task.userId !== owner.data.id)) break
        if (task.userId === null) { task.userId = owner.data.id; await this.save() }
        await this.transfer(task, token)
        this.state!.pending = this.state!.pending.filter(item => item.id !== task.id)
        await this.save()
      } catch (error) {
        task.lastError = error instanceof Error ? error.message : String(error)
        await this.save()
        this.ctx.logger.warn(`managed-upload-sync: ${task.id}: ${task.lastError}`)
        break
      }
    }
  }

  private async scan(): Promise<void> {
    const state = this.state!
    const binding = await this.ctx.credentials.readRecord(credentialKey('llm-managed-backend', 'device-user'))
    const bound = z.object({ id: z.string() }).safeParse(binding?.kind === 'grant' ? binding.payload : undefined)
    const userId = bound.success ? bound.data.id : null
    for (const snapshot of await this.ctx.sessionPersistence.list()) {
      const sessionId = String(snapshot.header.id)
      await using handle = await this.ctx.sessionPersistence.open(snapshot.header.id, 'read')
      const from = state.cursor[sessionId] ?? Number(handle.inheritedEventCount)
      const events = (await handle.read(from)).events
      for (const event of events) {
        const submission = submittedFiles(event)
        if (submission !== undefined) for (const [index, file] of submission.files.entries()) {
          const id = createHash('sha256').update(`${sessionId}:${event.seq}:${index}:${file.attachmentId}`).digest('hex')
          if (!state.pending.some(task => task.id === id)) state.pending.push({ id, sessionId,
            eventSeq: Number(event.seq), prompt: submission.prompt, deviceId: state.deviceId,
            computerName: this.computerName(), storedPath: this.ctx.attachments.fileHostPath(file) ?? '', file, userId })
        }
        state.cursor[sessionId] = Number(event.seq) + 1
      }
      if (events.length > 0) await this.save()
    }
  }

  private async token(): Promise<string | undefined> {
    const backend = this.ctx.get('managedBackend')
    if (backend?.accessToken !== undefined) return backend.accessToken()
    const record = await this.ctx.credentials.readRecord(credentialKey('llm-managed-backend', 'user-session'))
    return record?.kind === 'api-key' ? record.key : undefined
  }

  private async transfer(task: Task, token: string): Promise<void> {
    const ref = task.file as FileAttachmentRef
    const digest = String(ref.attachmentId).replace(/^sha256:/u, '')
    const base = `${this.endpoint}/v1/uploads/${encodeURIComponent(task.id)}`
    const response = await this.request(`${this.endpoint}/v1/uploads`, token, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: task.userId,
        clientUploadId: task.id, sessionId: task.sessionId, eventSeq: task.eventSeq, prompt: task.prompt,
        deviceId: task.deviceId, computerName: task.computerName, storedPath: task.storedPath,
        fileName: ref.name, bytes: ref.bytes, sha256: digest }) })
    let status = responseSchema.parse(await response.json())
    if (status.completed) return
    if (status.bytes !== ref.bytes || status.offset > ref.bytes) throw new Error('backend upload offset is invalid')
    const resumeOffset = status.offset
    let skipped = 0
    let buffer = Buffer.alloc(0)
    for await (const chunk of this.ctx.attachments.readFileStream(ref)) {
      let bytes = Buffer.from(chunk)
      if (skipped < resumeOffset) { const count = Math.min(bytes.length, resumeOffset - skipped); skipped += count; bytes = bytes.subarray(count) }
      buffer = Buffer.concat([buffer, bytes])
      while (buffer.length >= this.config.chunkBytes) {
        const part = buffer.subarray(0, this.config.chunkBytes)
        status = await this.sendChunk(base, token, status.offset, part)
        buffer = buffer.subarray(part.length)
      }
    }
    if (buffer.length > 0) status = await this.sendChunk(base, token, status.offset, buffer)
    if (status.offset !== ref.bytes) throw new Error('backend did not acknowledge the complete file')
    await this.request(`${base}/complete`, token, { method: 'POST' })
  }

  private async sendChunk(base: string, token: string, offset: number, bytes: Buffer) {
    const response = await this.request(`${base}/chunk?offset=${offset}`, token, { method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': createHash('sha256').update(bytes).digest('hex') },
      body: Uint8Array.from(bytes).buffer })
    const status = responseSchema.parse(await response.json())
    if (status.offset !== offset + bytes.length) throw new Error('backend chunk offset mismatch')
    return status
  }

  private async request(url: string, token: string, init: RequestInit): Promise<Response> {
    const response = await this.requestHttp(url, { ...init, redirect: 'error',
      signal: AbortSignal.timeout(this.config.requestTimeoutMs), headers: { ...init.headers, authorization: `Bearer ${token}` } })
    if (!response.ok) throw new Error(`backend upload HTTP ${response.status}`)
    return response
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(this.state), { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, this.path)
  }
}

/** Install a retrying transfer worker only while the managed model plugin is mounted. */
export function installUploadSync(ctx: Context, endpoint: string, config: UploadSyncConfig): void {
  if (!Number.isInteger(config.pollMs) || config.pollMs < 1_000 || !Number.isInteger(config.chunkBytes)
    || config.chunkBytes < 1 || config.chunkBytes > 4 * 1024 * 1024
    || !Number.isInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1_000) {
    throw new TypeError('invalid managed upload synchronization configuration')
  }
  ctx.inject(['sessionPersistence', 'attachments', 'credentials', 'sessions'], ready => {
    const worker = new UploadSync(ready, endpoint, config)
    let started = false
    const start = worker.start().then(() => { started = true }).catch(error => { ready.logger.error(`managed-upload-sync: startup failed: ${String(error)}`) })
    ready.on('session/event', () => { if (started) void worker.tick().catch(error => { ready.logger.error(`managed-upload-sync: scan failed: ${String(error)}`) }) })
    ready.effect(() => {
      const timer = setInterval(() => { void worker.tick().catch(error => { ready.logger.error(`managed-upload-sync: retry failed: ${String(error)}`) }) }, config.pollMs)
      timer.unref()
      return async () => { clearInterval(timer); await start; await worker.stop() }
    }, 'managed-upload-sync: worker')
  })
}
