/** Local, bounded failure records and streaming diagnostic exports. */
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync, writeFileSync, createReadStream, createWriteStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

const OWNED_FILE = /^failures-\d{4}-\d{2}-\d{2}-\d+\.jsonl$/u
const DAY = 86_400_000

/** Remove credentials before data reaches either disk or an export. */
export function redactDiagnostic(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '[REDACTED PRIVATE KEY]')
    .replace(/\bBearer\s+[^\s"',;]+/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/gu, '[REDACTED KEY]')
    .replace(/\b[a-f0-9]{64}\b/giu, '[REDACTED TOKEN]')
    .replace(/((?:authorization|cookie|set-cookie|password|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret)\s*["']?\s*[:=]\s*["']?)[^\s"',;}&]+/giu, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[REDACTED]@')
    .replace(/([?&](?:code|ticket|key|token|password|secret)=)[^&#\s]+/giu, '$1[REDACTED]')
}

/** Explicit fields accepted from local collectors; request bodies and tool arguments are excluded. */
export interface FailureRecord {
  category: string
  operation: string
  error?: unknown
  username?: string | undefined
  sessionId?: string | undefined
  operationId?: string | undefined
  durationMs?: number | undefined
  status?: number | undefined
  context?: string[] | undefined
}

/** Seven-day local journal; storage failures never propagate into user operations. */
export class FailureJournal {
  private lastPrune = 0
  private shard = 0
  private date = ''
  private writeFailed = false
  private username: string | undefined
  readonly deviceId: string
  readonly retentionDays: number

  /** @param directory Dedicated diagnostics directory. @param version Installed app version. @param options Retention and byte bounds. */
  constructor(readonly directory: string, readonly version: string,
    private readonly options: { retentionDays?: number; maxBytes?: number; fileBytes?: number; now?: () => Date } = {}) {
    this.retentionDays = options.retentionDays ?? 7
    if (!Number.isInteger(this.retentionDays) || this.retentionDays < 1 || this.retentionDays > 365) {
      throw new Error('Diagnostic retention must be 1–365 days')
    }
    this.prune()
    let deviceId: string = randomUUID()
    try {
      const path = join(this.directory, 'device-id.txt')
      try {
        const stored = readFileSync(path, 'utf8').trim()
        if (/^[0-9a-f-]{36}$/iu.test(stored)) deviceId = stored
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        writeFileSync(path, deviceId + '\n', { mode: 0o600, flag: 'wx' })
      }
    } catch (_storageUnavailable) { this.writeFailed = true }
    this.deviceId = deviceId
  }

  /** @returns Whether the most recent storage operation failed. */
  get storageFailed(): boolean { return this.writeFailed }

  /** @param raw Bounded JSON from the private Host channel; unknown fields are discarded. */
  ingest(raw: string): void {
    try {
      const value: unknown = JSON.parse(raw)
      if (typeof value !== 'object' || value === null || !('category' in value) || typeof value.category !== 'string'
        || !('operation' in value) || typeof value.operation !== 'string') return
      if ('username' in value) this.username = typeof value.username === 'string' ? value.username : undefined
      if (value.category === 'identity') return
      this.record({ category: value.category, operation: value.operation,
        error: 'error' in value ? value.error : undefined,
        username: 'username' in value && typeof value.username === 'string' ? value.username : undefined,
        sessionId: 'sessionId' in value && typeof value.sessionId === 'string' ? value.sessionId : undefined,
        operationId: 'operationId' in value && typeof value.operationId === 'string' ? value.operationId : undefined,
        durationMs: 'durationMs' in value && typeof value.durationMs === 'number' ? value.durationMs : undefined,
        status: 'status' in value && typeof value.status === 'number' ? value.status : undefined,
        context: 'context' in value && Array.isArray(value.context)
          ? value.context.filter((line): line is string => typeof line === 'string') : undefined,
      })
    } catch (_invalidHostRecord) { /* The diagnostic channel cannot break the Host lifecycle. */ }
  }

  /** @param record Failure metadata, serialized and redacted before writing. */
  record(record: FailureRecord): void {
    try {
      const now = this.options.now?.() ?? new Date()
      if (now.getTime() - this.lastPrune >= 3_600_000) this.prune()
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      const date = now.toISOString().slice(0, 10)
      if (date !== this.date) { this.date = date; this.shard = 0 }
      let path = join(this.directory, `failures-${date}-${this.shard}.jsonl`)
      while (this.size(path) >= (this.options.fileBytes ?? 16 * 1024 * 1024)) {
        this.shard++
        path = join(this.directory, `failures-${date}-${this.shard}.jsonl`)
      }
      const error = typeof record.error === 'string' ? record.error : record.error instanceof Error
        ? inspect(record.error, { depth: 4, maxStringLength: 16_384, maxArrayLength: 10 })
        : inspect(record.error, { depth: 3, maxStringLength: 16_384, maxArrayLength: 10 })
      const clean = (value: string) => redactDiagnostic(value).slice(0, 24_000)
      const event = {
        schemaVersion: 1, eventId: randomUUID(), occurredAt: now.toISOString(), appVersion: this.version,
        pid: process.pid, deviceId: this.deviceId, platform: process.platform, arch: process.arch,
        category: clean(record.category), operation: clean(record.operation),
        username: record.username === undefined ? (this.username === undefined ? null : clean(this.username)) : clean(record.username),
        sessionId: record.sessionId === undefined ? undefined : clean(record.sessionId),
        operationId: record.operationId === undefined ? undefined : clean(record.operationId),
        durationMs: record.durationMs, status: record.status,
        error: clean(error), context: record.context?.slice(-20).map(line => clean(line).slice(0, 1024)),
      }
      appendFileSync(path, JSON.stringify(event) + '\n', { mode: 0o600, flush: true })
      this.writeFailed = false
      // Keep the total bound even when a failure storm stays inside one hour.
      this.prune()
    } catch (_storageUnavailable) {
      // Do not recurse through console.error or turn a diagnostic failure into an application failure.
      this.writeFailed = true
    }
  }

  private size(path: string): number {
    try { return statSync(path).size } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
  }

  /** Remove only owned files older than retention or beyond the byte cap. */
  prune(): void {
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      const now = this.options.now?.() ?? new Date()
      const files = readdirSync(this.directory).filter(name => OWNED_FILE.test(name))
        .map(name => ({ name, stat: statSync(join(this.directory, name)) }))
        .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.name.localeCompare(b.name))
      let total = files.reduce((sum, file) => sum + file.stat.size, 0)
      for (const file of files) {
        const day = new Date(file.name.slice(9, 19) + 'T00:00:00Z').getTime()
        const today = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z').getTime()
        if (day < today - (this.retentionDays - 1) * DAY || total > (this.options.maxBytes ?? 1024 ** 3)) {
          unlinkSync(join(this.directory, file.name))
          total -= file.stat.size
        }
      }
      this.lastPrune = now.getTime()
      this.writeFailed = false
    } catch (_storageUnavailable) { this.writeFailed = true }
  }

  /** @param destination New gzip JSONL diagnostic file selected by the user. @returns Completion after the output is closed. */
  async export(destination: string): Promise<void> {
    this.prune()
    if (this.storageFailed) throw new Error('Diagnostic log directory could not be read')
    const directory = this.directory
    const files = readdirSync(directory).filter(name => OWNED_FILE.test(name)).sort()
    const manifest = { type: 'diagnostic-manifest', schemaVersion: 1, appVersion: this.version, deviceId: this.deviceId,
      exportedAt: new Date().toISOString(), retentionDays: this.retentionDays, files,
      storageFailed: this.storageFailed }
    async function* records() {
      yield JSON.stringify(manifest) + '\n'
      for (const name of files) {
        // Freeze the file size so concurrent appends do not produce an unbounded export.
        const size = statSync(join(directory, name)).size
        if (size > 0) yield* createReadStream(join(directory, name), { end: size - 1 })
      }
    }
    const output = createWriteStream(destination, { mode: 0o600, flags: 'wx' })
    let created = false
    output.once('open', () => { created = true })
    try { await pipeline(Readable.from(records()), createGzip(), output) }
    catch (error) {
      if (created) {
        try { unlinkSync(destination) } catch (_cleanupUnavailable) { /* Preserve the original export failure. */ }
      }
      throw error
    }
  }
}
