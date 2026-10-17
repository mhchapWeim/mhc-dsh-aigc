/** Account credentials stay in the Host; the browser receives metadata only. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm-managed-backend'
import { z } from 'zod'
import type { WorkspaceDataMigration } from './data-migration.ts'
import type { CloudBackupListValue, CloudBackupRestoreRequest, CloudBackupUploadRequest, CloudBackupValue, WorkspaceMigrationValue } from './types.ts'

const row = z.object({ id: z.uuid(), createdAt: z.string(), bytes: z.number().nonnegative(), sessionCount: z.number().int().positive(), scope: z.enum(['all', 'selected']), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
const maxBytes = 24 * 1024 * 1024

export class CloudBackup {
  constructor(private readonly ctx: Context, private readonly migration: WorkspaceDataMigration, private readonly timeoutMs: number) {}

  async list(page: number): Promise<CloudBackupListValue> {
    const response = await this.request(`?page=${z.number().int().positive().parse(page)}`)
    return z.object({ items: z.array(row), total: z.number(), page: z.number(), pageSize: z.number() }).parse(await response.json())
  }

  async upload(input: CloudBackupUploadRequest): Promise<CloudBackupValue> {
    const payload = await this.migration.exportSessions(input.sessionIds)
    if (Buffer.byteLength(payload) > maxBytes) throw new Error('Backup exceeds 24 MiB; select fewer Sessions')
    return row.parse(await (await this.request('', { method: 'POST', body: JSON.stringify({ payload,
      sha256: createHash('sha256').update(payload).digest('hex'), scope: input.sessionIds === undefined ? 'all' : 'selected' }) })).json())
  }

  /** Measure persisted UTF-8 history and encoded attachments without upload restrictions. */
  async measure(input: CloudBackupUploadRequest): Promise<{ readonly bytes: number; readonly limit: number }> {
    return { bytes: await this.migration.measureSessions(input.sessionIds), limit: maxBytes }
  }

  async restore(input: CloudBackupRestoreRequest): Promise<WorkspaceMigrationValue> {
    const id = z.uuid().parse(input.id)
    const response = await this.request(`/${id}`)
    const value = z.object({ payload: z.string().max(maxBytes), sha256: z.string() }).parse(await response.json())
    if (Buffer.byteLength(value.payload) > maxBytes || createHash('sha256').update(value.payload).digest('hex') !== value.sha256) throw new Error('Cloud backup checksum mismatch')
    const plan = await this.migration.importSessions(value.payload, input.targetPath)
    return this.migration.commit(plan.migrationId)
  }

  async remove(id: string): Promise<void> { await this.request(`/${z.uuid().parse(id)}`, { method: 'DELETE' }) }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const backend = this.ctx.get('managedBackend')
    if (backend?.accessToken === undefined) throw new Error('Sign in to AIGC before using cloud backups')
    const token = await backend.accessToken()
    const response = await fetch(`${backend.endpoint.replace(/\/$/, '')}/v1/backups${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw new Error(`Cloud backup HTTP ${response.status}`)
    return response
  }
}
