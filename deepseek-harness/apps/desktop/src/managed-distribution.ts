/** Organization-scoped announcement polling and update-feed selection in the Electron main process. */
import type { DesktopUpdateState } from './ipc.ts'

/** Private Host credentials, never exposed to a page or saved in update metadata. */
export interface ManagedDesktopSession { readonly endpoint: string; readonly token: string }

/** One backend-persisted announcement with receipt timestamps. */
export interface ManagedAnnouncement {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly important: boolean
  deliveredAt: string | null
  readAt: string | null
  confirmedAt: string | null
}

/** Updater source selected for the authenticated user. */
export interface ManagedUpdateSource {
  readonly url: string
  readonly requestHeaders: Record<string, string>
}

/** Desktop identity reported independently of renderer state. */
export interface ManagedDesktopIdentity {
  readonly deviceId: string
  readonly computerName: string
  readonly version: string
  readonly platform: string
  readonly arch: string
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid desktop backend response')
  return value as Record<string, unknown>
}

function timestamp(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid announcement receipt')
  return value
}

function announcements(value: unknown): ManagedAnnouncement[] {
  const { items } = object(value)
  if (!Array.isArray(items) || items.length > 100) throw new Error('Invalid announcement list')
  return items.map(item => {
    const row = object(item)
    if (typeof row.id !== 'string' || !/^[\da-f-]{36}$/iu.test(row.id)
      || typeof row.title !== 'string' || row.title.length > 200
      || typeof row.body !== 'string' || row.body.length > 20000 || typeof row.important !== 'boolean') throw new Error('Invalid announcement')
    return { id: row.id, title: row.title, body: row.body, important: row.important,
      deliveredAt: timestamp(row.deliveredAt), readAt: timestamp(row.readAt), confirmedAt: timestamp(row.confirmedAt) }
  })
}

/** Owns one authenticated session, aborting and draining its requests on logout or shutdown. */
export class ManagedDesktopDistribution {
  private session: ManagedDesktopSession | undefined
  private lifetime = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly requests = new Set<Promise<unknown>>()
  private pendingPoll: Promise<void> | undefined
  private readonly notified = new Set<string>()
  private current: ManagedAnnouncement[] = []
  private stopped = false

  /**
   * @param identity - Installed version and a stable per-profile device id.
   * @param state - Current updater state for delivery reports.
   * @param notify - Show one native notification without granting update installation.
   * @param changed - Refresh the tray's unread indicator.
   * @param request - Network transport owned by the Electron process.
   * @param intervalMs - Announcement polling interval.
   */
  constructor(private readonly identity: ManagedDesktopIdentity, private readonly state: () => DesktopUpdateState,
    private readonly notify: (item: ManagedAnnouncement) => void, private readonly changed: () => void,
    private readonly request: typeof fetch = fetch, private readonly intervalMs = 45_000) {}

  /** Effective announcements retained for the native notification center. */
  get items(): readonly ManagedAnnouncement[] { return this.current }
  /** Count of announcements not yet opened by the user. */
  get unread(): number { return this.current.filter(item => item.readAt === null).length }

  /**
   * Replace the private account session and discard the previous user's notifications.
   * @param value - New Host session, or null on sign-out.
   */
  setSession(value: ManagedDesktopSession | null): void {
    if (this.stopped || (value?.token === this.session?.token && value?.endpoint === this.session?.endpoint)) return
    this.lifetime.abort(); this.lifetime = new AbortController()
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.session = value ?? undefined; this.current = []; this.notified.clear(); this.changed()
    if (value !== null) {
      void (this.pendingPoll ?? Promise.resolve()).finally(() => {
        if (this.session === value && !this.stopped) void this.poll()
      })
    }
  }

  /** Fetch announcements immediately; repeated window activation joins an active poll. */
  poll(): Promise<void> {
    if (this.pendingPoll !== undefined) return this.pendingPoll
    const session = this.session
    if (session === undefined || this.stopped) return Promise.resolve()
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.pendingPoll = (async () => {
      try {
        const response = await this.send(session, '/v1/desktop/announcements')
        const items = announcements(await response.json())
        if (this.session !== session) return
        this.current = items; this.changed()
        for (const item of items) {
          if (this.session !== session) break
          if (item.deliveredAt === null && !this.notified.has(item.id)) { this.notify(item); this.notified.add(item.id) }
          if (item.deliveredAt === null) await this.receipt(item.id, 'Delivered')
        }
        if (this.identity.platform === 'win32') await this.check(session)
      } catch (error) {
        if (this.session === session && !this.lifetime.signal.aborted) console.warn('Desktop announcements unavailable:', String(error))
      } finally {
        this.pendingPoll = undefined
        if (this.session === session && !this.stopped) this.timer = setTimeout(() => { void this.poll() }, this.intervalMs)
      }
    })()
    return this.pendingPoll
  }

  /**
   * Resolve the current user's release immediately before the updater checks metadata.
   * @returns A private authenticated feed, or null when no release is assigned.
   */
  async updateSource(): Promise<ManagedUpdateSource | null> {
    const session = this.session
    if (session === undefined || this.stopped) return null
    const release = object(await this.check(session)).release
    if (this.session !== session) throw new Error('Desktop update account changed')
    if (release === null) return null
    const row = object(release)
    if (typeof row.id !== 'string' || !/^[\da-f-]{36}$/iu.test(row.id)
      || row.feedPath !== `/v1/desktop/updates/${row.id}/`) throw new Error('Invalid managed update source')
    return { url: `${session.endpoint}${row.feedPath}`, requestHeaders: { Authorization: `Bearer ${session.token}` } }
  }

  /**
   * Persist a receipt only for the currently authenticated recipient.
   * @param id - Announcement id present in the current notification center.
   * @param status - Display, open, or explicit confirmation acknowledgement.
   */
  async receipt(id: string, status: 'Delivered' | 'Read' | 'Confirmed'): Promise<void> {
    const session = this.session
    if (session === undefined || !this.current.some(item => item.id === id)) return
    await this.send(session, `/v1/desktop/announcements/${id}/receipt`, { status })
    if (this.session !== session) return
    const item = this.current.find(item => item.id === id)
    if (item === undefined) return
    item.deliveredAt ??= new Date().toISOString()
    if (status !== 'Delivered') item.readAt ??= new Date().toISOString()
    if (status === 'Confirmed') item.confirmedAt ??= new Date().toISOString()
    this.changed()
  }

  /** Abort polling and await all owned requests before application shutdown. */
  async dispose(): Promise<void> {
    this.stopped = true; this.session = undefined; this.lifetime.abort()
    if (this.timer !== undefined) clearTimeout(this.timer)
    await Promise.allSettled([this.pendingPoll, ...this.requests])
  }

  private async check(session: ManagedDesktopSession): Promise<unknown> {
    const state = this.state()
    const names: Record<DesktopUpdateState['phase'], string> = {
      idle: 'Current', checking: 'Current', available: 'Available', downloading: 'Downloading', verifying: 'Downloading',
      ready: 'Ready', installing: 'Installing', error: 'Failed',
    }
    const response = await this.send(session, '/v1/desktop/check', { ...this.identity,
      updateStatus: names[state.phase], targetVersion: 'version' in state ? state.version ?? '' : '',
      error: state.phase === 'error' ? state.message?.slice(0, 2000) ?? '' : '' })
    return response.json()
  }

  private send(session: ManagedDesktopSession, path: string, body?: object): Promise<Response> {
    const pending = this.request(`${session.endpoint}${path}`, { redirect: 'error',
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${session.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15000)]),
    }).then(response => { if (!response.ok) throw new Error(`Managed desktop backend HTTP ${response.status}`); return response })
    this.requests.add(pending)
    void pending.then(() => { this.requests.delete(pending) }, () => { this.requests.delete(pending) })
    return pending
  }
}
