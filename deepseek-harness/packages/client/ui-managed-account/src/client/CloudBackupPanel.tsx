import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CloudBackupListValue, CloudBackupValue, WorkspaceDataStatus, WorkspaceMigrationValue } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { ManagedAccountKey } from './locales.ts'
import css from './DataMigrationDialog.module.css'

export interface CloudBackupActions {
  measure?(ids?: readonly string[]): Promise<{ readonly bytes: number; readonly limit: number }>
  list(page: number): Promise<CloudBackupListValue>
  upload(ids?: readonly string[]): Promise<CloudBackupValue>
  restore(id: string, target: string, ids?: readonly string[]): Promise<WorkspaceMigrationValue>
  sessions?(id: string): Promise<readonly { readonly id: string; readonly title: string }[]>
  progress?(): Promise<{ readonly phase: string; readonly bytes: number; readonly total: number }>
  pause?(): Promise<void>
  remove(id: string): Promise<void>
}

/** One-click backup with optional named selection and secondary restore controls. */
export function CloudBackupPanel({
  cloud, t, selected, target, setTarget, restored, sessions = [], workspaces = [], setSelected, onBusyChange,
}: {
  cloud: CloudBackupActions
  t: (key: ManagedAccountKey) => string
  selected: readonly string[]
  target: string
  setTarget: (value: string) => void
  restored: (value: WorkspaceMigrationValue) => Promise<void>
  sessions?: WorkspaceDataStatus['sessions']
  workspaces?: WorkspaceDataStatus['workspaces']
  setSelected?: (ids: string[]) => void
  onBusyChange?: (busy: boolean) => void
}): ReactNode {
  const [list, setList] = useState<CloudBackupListValue>()
  const [page, setPage] = useState(1)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState('')
  const [message, setMessage] = useState('')
  const [uploaded, setUploaded] = useState<CloudBackupValue>()
  const [backupId, setBackupId] = useState('')
  const [restoreScope, setRestoreScope] = useState<'all' | 'selected'>('all')
  const [restoreSessions, setRestoreSessions] = useState<readonly { readonly id: string; readonly title: string }[]>([])
  const [restoreSelection, setRestoreSelection] = useState<string[]>([])
  const [restoreLoading, setRestoreLoading] = useState(false)
  const [progress, setProgress] = useState<{ readonly phase: string; readonly bytes: number; readonly total: number }>()
  const success = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (message !== '' && typeof success.current?.scrollIntoView === 'function') {
      success.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [message])
  const [search, setSearch] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [scope, setScope] = useState<'all' | 'selected'>('all')
  const [size, setSize] = useState<{ bytes: number; limit: number }>()
  const [measuring, setMeasuring] = useState(false)
  const [sizeError, setSizeError] = useState('')
  const selectionKey = JSON.stringify(scope === 'all' ? null : selected)
  const overLimit = size !== undefined && size.bytes > size.limit
  useEffect(() => {
    let active = true
    setSize(undefined); setSizeError('')
    if (cloud.measure === undefined) return
    setMeasuring(true)
    const timer = setTimeout(() => {
      void cloud.measure?.(scope === 'all' ? undefined : selected).then((value) => {
        if (active) setSize(scope === 'selected' && selected.length === 0 ? { ...value, bytes: 0 } : value)
      }).catch((cause: unknown) => { if (active) setSizeError(cause instanceof Error ? cause.message : String(cause)) })
        .finally(() => { if (active) setMeasuring(false) })
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [cloud, selectionKey, refresh])
  const visible = sessions.filter(item => item.status === 'ok'
    && (workspace === '' || item.cwd === workspace)
    && (item.title ?? t('cloudUntitled')).toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const failure = (cause: unknown): void => {
    const raw = cause instanceof Error ? cause.message : String(cause)
    const key: ManagedAccountKey = /cloud-partial-restore/.test(raw) ? 'cloudPartial'
      : /HTTP 404/.test(raw) ? 'cloudUnavailable'
        : /HTTP 401|Sign in/.test(raw) ? 'cloudLoginRequired'
          : /HTTP 403/.test(raw) ? 'cloudForbidden'
            : /HTTP 413|exceeds|too large/i.test(raw) ? 'cloudTooLarge'
              : /Session is running/.test(raw) ? 'cloudActive'
                : /No Sessions selected/.test(raw) ? 'cloudNoSessions' : 'cloudFailed'
    setError(t(key)); setDetail(raw)
  }
  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])
  useEffect(() => {
    let active = true
    setBusy(true); setError(''); setDetail('')
    void cloud.list(page).then((value) => { if (active) { setList(value); setBackupId(current => value.items.some(item => item.id === current) ? current : value.items[0]?.id ?? '') } })
      .catch((cause: unknown) => { if (active) { setList(undefined); failure(cause) } })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [cloud, page, refresh])
  useEffect(() => {
    let active = true
    setRestoreSelection([]); setRestoreSessions([]); setRestoreLoading(false)
    if (restoreScope !== 'selected' || backupId === '' || cloud.sessions === undefined) return
    setRestoreLoading(true)
    void cloud.sessions(backupId).then(value => { if (active) setRestoreSessions(value) })
      .catch(cause => { if (active) failure(cause) }).finally(() => { if (active) setRestoreLoading(false) })
    return () => { active = false }
  }, [cloud, backupId, restoreScope])
  useEffect(() => {
    if (!busy || cloud.progress === undefined) return
    let active = true
    const timer = setInterval(() => { void cloud.progress?.().then(value => { if (active) setProgress(value) }).catch(() => { /* The operation reports its own error. */ }) }, 500)
    return () => { active = false; clearInterval(timer) }
  }, [cloud, busy])
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(''); setDetail(''); setMessage(''); setUploaded(undefined)
    try { await operation(); setRefresh(value => value + 1) }
    catch (cause) { if (cause instanceof Error && cause.message.includes('backup paused')) setMessage(t('cloudPaused')); else failure(cause) }
    finally { setBusy(false) }
  }
  const upload = (ids?: readonly string[]): void => { void run(async () => {
    const value = await cloud.upload(ids)
    setUploaded(value); setMessage(t('cloudUploaded')); setPage(1)
  }) }
  return <section className={css.cloud} aria-busy={busy}>
    <div className={css.backupHeading}><h3>{t('cloudUploadHeading')}</h3>
      <Button disabled={busy} onClick={() => { setRefresh(value => value + 1) }}>{t('dataRefresh')}</Button></div>
    <div className={css.scopeCards}>
      <label className={css.scopeCard}><input type="radio" disabled={busy} name="backup-scope" checked={scope === 'all'}
        onChange={() => { setScope('all') }} /><span><strong>{t('cloudAll')}</strong><small>{sessions.length} {t('cloudSessions')}</small></span></label>
      <label className={css.scopeCard}><input type="radio" disabled={busy} name="backup-scope" checked={scope === 'selected'}
        onChange={() => { setScope('selected') }} /><span><strong>{t('cloudChoose')}</strong><small>{selected.length} {t('cloudSessions')}</small></span></label>
    </div>
    {busy && <div role="status"><p>{progress === undefined ? t('dataBusy') : `${t('cloudTransferring')} ${progress.total > 0 ? `${Math.floor(progress.bytes / progress.total * 100)}%` : ''}`}</p>
      {progress !== undefined && progress.total > 0 && <progress aria-label={t('cloudTransferring')} max={progress.total} value={progress.bytes} />}
      {cloud.pause !== undefined && <Button onClick={() => { void cloud.pause?.() }}>{t('cloudPause')}</Button>}</div>}
    {error !== '' && <div><p role="alert" className={css.error}>{error}</p>
      <details><summary>{t('cloudErrorDetails')}</summary><p>{detail}</p></details></div>}
    {page === 1 && list?.items[0] !== undefined && <p>{t('cloudLatest')}: {new Date(list.items[0].createdAt).toLocaleString()}</p>}
    {scope === 'selected' && <div>
      <div className={css.cloudOptions}>
        <label>{t('cloudSearch')}<Input disabled={busy} value={search} onChange={(event) => { setSearch(event.target.value) }} /></label>
        <label>{t('dataSource')}<select disabled={busy} value={workspace}
          onChange={(event) => { setWorkspace(event.target.value) }}>
          <option value="">{t('dataAllSessions')}</option>
          {workspaces.map(item => <option key={item.workspaceId} value={item.path}>{item.title}</option>)}
        </select></label>
        {setSelected !== undefined && <Button disabled={busy || visible.length === 0} onClick={() => {
          const ids: string[] = visible.map(item => item.sessionId)
          const next = ids.every(id => selected.includes(id))
            ? selected.filter(id => !ids.includes(id)) : [...new Set([...selected, ...ids])]
          setSelected(next)
        }}>{t('dataSelectAll')}</Button>}
        <div className={css.sessions}>{visible.map(item => <label key={item.sessionId} className={css.check}>
          <input type="checkbox" disabled={busy || setSelected === undefined} checked={selected.includes(item.sessionId)} onChange={(event) => {
            setSelected?.(event.target.checked ? [...selected, item.sessionId] : selected.filter(id => id !== item.sessionId))
          }} />
          <span><strong>{item.title || t('cloudUntitled')}</strong>
            {item.createdAt !== undefined && <small>{new Date(item.createdAt).toLocaleString()}</small>}</span>
        </label>)}</div>
      </div>
    </div>}
    {message !== '' && <div ref={success} className={css.success} role="status" aria-live="polite" aria-atomic="true">
      <strong>{message}</strong>
      {uploaded !== undefined && <p>{uploaded.sessionCount} {t('cloudSessions')} · {
        (uploaded.bytes / 1024 / 1024).toFixed(2)} {t('cloudSizeUnit')} · {new Date(uploaded.createdAt).toLocaleString()}</p>}
      {uploaded !== undefined && <p>{t('cloudUploadedAdvice')}</p>}
    </div>}
    <div className={css.backupSummary}>
      <div aria-live="polite"><strong>{scope === 'all' ? sessions.length : selected.length} {t('cloudSessions')}</strong>
        <p>{t('cloudPayloadSize')}: {measuring ? t('cloudCalculating') : sizeError ? t('cloudMeasureFailed')
          : size === undefined ? '—' : `${(size.bytes / 1024 / 1024).toFixed(2)} / ${(size.limit / 1024 / 1024).toFixed(0)} ${t('cloudSizeUnit')}`}</p>
        {size !== undefined && <progress max={size.limit} value={Math.min(size.bytes, size.limit)} />}
        {size !== undefined && <p>{t(overLimit ? 'cloudOverBy' : 'cloudRemaining')}: {
          (Math.abs(size.limit - size.bytes) / 1024 / 1024).toFixed(2)} {t('cloudSizeUnit')}</p>}
        {sizeError !== '' && <details><summary>{t('cloudErrorDetails')}</summary><p>{sizeError}</p></details>}
        {overLimit && <p className={css.error}>{t('cloudTooLarge')}</p>}
      </div>
      <Button variant="primary" disabled={busy || measuring || overLimit || (scope === 'selected' && selected.length === 0)
        || (cloud.measure !== undefined && (size === undefined || sizeError !== ''))}
      onClick={() => { upload(scope === 'all' ? undefined : selected) }}>{t(scope === 'all' ? 'cloudUploadAll' : 'cloudUploadSelected')}</Button>
    </div>
    <section className={css.restoreSection}><h3>{t('cloudRestoreHeading')}{list === undefined ? '' : ` (${list.total})`}</h3>
      <div className={css.cloudOptions}>
        {list !== undefined && list.items.length > 0 && <label>{t('cloudSnapshot')}<select disabled={busy} value={backupId} onChange={event => { setBackupId(event.target.value) }}>
          {list.items.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.sessionCount} {t('cloudSessions')} · {(item.bytes / 1024 / 1024).toFixed(2)} {t('cloudSizeUnit')}</option>)}
        </select></label>}
        <label>{t('cloudTarget')}<Input disabled={busy} value={target} onChange={(event) => { setTarget(event.target.value) }} /></label>
        {list?.items.length === 0 && <p>{t('cloudEmpty')}</p>}
        <div className={css.scopeCards}>
          <label className={css.scopeCard}><input type="radio" name="restore-scope" disabled={busy} checked={restoreScope === 'all'} onChange={() => { setRestoreScope('all') }} />{t('cloudRestoreAll')}</label>
          <label className={css.scopeCard}><input type="radio" name="restore-scope" disabled={busy || cloud.sessions === undefined} checked={restoreScope === 'selected'} onChange={() => { setRestoreScope('selected') }} />{t('cloudRestoreSelected')}</label>
        </div>
        {restoreLoading && <p role="status">{t('dataBusy')}</p>}
        {restoreScope === 'selected' && <div className={css.sessions}>{restoreSessions.map(item => <label className={css.check} key={item.id}>
          <input type="checkbox" disabled={busy} checked={restoreSelection.includes(item.id)} onChange={event => { setRestoreSelection(ids => event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id)) }} />
          <span>{item.title || t('cloudUntitled')}</span></label>)}</div>}
        <Button variant="primary" disabled={busy || restoreLoading || backupId === '' || target.trim() === '' || (restoreScope === 'selected' && restoreSelection.length === 0)} onClick={() => {
          void run(async () => { const result = await cloud.restore(backupId, target.trim(), restoreScope === 'all' ? undefined : restoreSelection); await restored(result)
            if (!result.completed) throw new Error('cloud-partial-restore'); setMessage(t('cloudRestored')) })
        }}>{t('cloudRestore')}</Button>
        {list !== undefined && list.total > list.pageSize && <div className={css.toolbar}>
          <Button disabled={busy || page <= 1} onClick={() => { setPage(value => value - 1) }}>{t('cloudPrevious')}</Button>
          <span>{page} / {Math.max(1, Math.ceil(list.total / list.pageSize))}</span>
          <Button disabled={busy || page * list.pageSize >= list.total} onClick={() => { setPage(value => value + 1) }}>{t('cloudNext')}</Button>
        </div>}
      </div>
    </section>
  </section>
}
