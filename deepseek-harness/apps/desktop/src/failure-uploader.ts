/** Durable, account-scoped diagnostic delivery. Requests never run on the renderer. */
import { createReadStream } from 'node:fs'
import { readdir, readFile, writeFile, rename, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import type { ManagedDesktopSession } from './managed-distribution.ts'
import { redactDiagnostic } from './failure-journal.ts'

const OWNED = /^failures-\d{4}-\d{2}-\d{2}-\d+\.jsonl$/u
type Progress = Record<string, number>

/** Upload retained journal records in bounded batches, advancing only after durable server acknowledgement. */
export class FailureUploader {
  private session: ManagedDesktopSession | undefined
  private lifetime = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> | undefined
  private stopped = false
  private delay = 30_000
  private identity: { token: string; username: string } | undefined

  /** @param directory Existing redacted journal directory. @param request Private Electron network transport. */
  constructor(private readonly directory: string, private readonly request: typeof fetch = fetch) {}

  /** Replace credentials and abort previous-account requests, keeping separate durable cursors for each account. */
  setSession(value: ManagedDesktopSession | null): void {
    if (this.stopped || (value?.token === this.session?.token && value?.endpoint === this.session?.endpoint)) return
    this.lifetime.abort(); this.lifetime = new AbortController()
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined; this.session = value ?? undefined; this.identity = undefined; this.delay = 30_000
    if (value !== null) void (this.pending ?? Promise.resolve()).then(() => {
      if (this.session === value && !this.stopped) void this.poll()
    })
  }

  /** One non-overlapping upload round. Transport/storage failures retain records and back off without recursive logging. */
  poll(): Promise<void> {
    if (this.pending !== undefined) return this.pending
    if (this.stopped || this.session === undefined) return Promise.resolve()
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const session = this.session
    const signal = this.lifetime.signal
    this.pending = this.upload(session, signal).then(async more => {
      this.delay = more ? 1000 : 30_000
      if (!signal.aborted && this.session === session) await this.report(session, more ? 'draining' : 'idle')
    }).catch(async (error: unknown) => {
      this.delay = Math.min(this.delay * 2, 15 * 60_000)
      if (!signal.aborted && this.session === session) await this.report(session, 'retrying', error)
    }).finally(() => {
      this.pending = undefined
      if (!signal.aborted && !this.stopped && this.session === session) {
        this.timer = setTimeout(() => { this.timer = undefined; void this.poll() }, this.delay)
        this.timer.unref()
      }
    })
    return this.pending
  }

  private async report(session: ManagedDesktopSession, status: string, error?: unknown): Promise<void> {
    try {
      const path = join(this.directory, 'delivery-status.json')
      await writeFile(`${path}.tmp`, JSON.stringify({ status, backend: new URL(session.endpoint).origin,
        checkedAt: new Date().toISOString(), nextAttemptAt: new Date(Date.now() + this.delay).toISOString(),
        error: error === undefined ? null : redactDiagnostic(error instanceof Error ? error.message : String(error)).slice(0, 2000) }, null, 2), { mode: 0o600 })
      await rename(`${path}.tmp`, path)
    } catch (_statusUnavailable) { /* Upload status must not block delivery or recursively create failures. */ }
  }

  private async json(session: ManagedDesktopSession, path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const response = await this.request(`${session.endpoint.replace(/\/+$/u, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${session.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw new Error(`Diagnostic upload ${path} HTTP ${response.status}`)
    return response.json()
  }

  private async upload(session: ManagedDesktopSession, signal: AbortSignal): Promise<boolean> {
    if (this.identity?.token !== session.token) {
      const me = await this.json(session, '/v1/auth/me', signal) as { user?: { username?: unknown } }
      if (typeof me.user?.username !== 'string' || me.user.username.length === 0) throw new Error('Missing diagnostic account')
      this.identity = { token: session.token, username: me.user.username }
    }
    if (signal.aborted || this.session !== session) return false
    const username = this.identity.username
    const scope = createHash('sha256').update(`${session.endpoint}\n${username.toLowerCase()}`).digest('hex').slice(0, 32)
    const cursorPath = join(this.directory, `upload-${scope}.json`)
    let offsets: Progress = {}
    try {
      const saved: unknown = JSON.parse(await readFile(cursorPath, 'utf8'))
      if (typeof saved === 'object' && saved !== null) offsets = Object.fromEntries(Object.entries(saved)
        .filter(([name, offset]) => OWNED.test(name) && Number.isSafeInteger(offset) && Number(offset) >= 0))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const files = (await readdir(this.directory)).filter(name => OWNED.test(name)).sort((a, b) =>
      a.slice(0, 20).localeCompare(b.slice(0, 20)) || Number(a.match(/-(\d+)\.jsonl$/u)?.[1]) - Number(b.match(/-(\d+)\.jsonl$/u)?.[1]))
    offsets = Object.fromEntries(Object.entries(offsets).filter(([name]) => files.includes(name)))
    const events: Record<string, unknown>[] = []
    let scanned = 0
    let bytes = 0
    let more = false
    for (const name of files) {
      if (signal.aborted) return false
      const path = join(this.directory, name)
      let size: number
      try { size = (await stat(path)).size } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      let offset = offsets[name] ?? 0
      if (offset > size) offset = 0
      if (offset === size) continue
      // Journal appends whole lines synchronously; freeze size so a failure storm cannot extend this round.
      const stream = createReadStream(path, { start: offset, end: size - 1, signal })
      const lines = createInterface({ input: stream, crlfDelay: Infinity })
      let readError: unknown
      // readline does not forward input errors to its async iterator.
      stream.on('error', error => { readError = error; lines.close() })
      try {
        for await (const line of lines) {
          if (offset + Buffer.byteLength(line) + 1 > size) break // Wait for a complete newline-terminated record.
          let event: Record<string, unknown> | undefined
          try {
            const parsed: unknown = JSON.parse(line)
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) event = parsed as Record<string, unknown>
          } catch (_invalidLine) { /* Skip a torn local record after a hard process termination. */ }
          const eligible = event !== undefined && typeof event.eventId === 'string'
            && (event.username === null || event.username === undefined || (typeof event.username === 'string' && event.username.toLowerCase() === username.toLowerCase()))
          if (eligible && (events.length >= 20 || bytes + Buffer.byteLength(line) > 700_000)) { more = true; break }
          offset += Buffer.byteLength(line) + 1
          offsets[name] = offset
          scanned++
          if (eligible) { events.push(event!); bytes += Buffer.byteLength(line) }
          if (scanned >= 500) { more = true; break }
        }
      } finally { lines.close(); stream.destroy() }
      if (readError !== undefined) throw readError
      if (more) break
    }
    if (events.length > 0) {
      const receipt = await this.json(session, '/v1/desktop/diagnostics', signal, { events }) as { acceptedEventIds?: unknown }
      const accepted = receipt.acceptedEventIds
      if (!Array.isArray(accepted) || !events.every(event => accepted.includes(event.eventId)))
        throw new Error('Incomplete diagnostic receipt')
    }
    if (signal.aborted || this.session !== session) return false
    const temporary = `${cursorPath}.tmp`
    await writeFile(temporary, JSON.stringify(offsets), { mode: 0o600 })
    if (signal.aborted || this.session !== session) return false
    await rename(temporary, cursorPath)
    return more
  }

  /** Cancel and drain uploads on application shutdown. */
  async dispose(): Promise<void> {
    this.stopped = true; this.lifetime.abort()
    if (this.timer !== undefined) clearTimeout(this.timer)
    await this.pending
  }
}
