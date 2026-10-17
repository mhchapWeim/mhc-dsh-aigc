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
  restore(id: string, target: string): Promise<WorkspaceMigrationValue>
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
    if (scope === 'selected' && selected.length === 0) {
      setSize({ bytes: 0, limit: 24 * 1024 * 1024 }); setMeasuring(false); return
    }
    setMeasuring(true)
    const timer = setTimeout(() => {
      void cloud.measure?.(scope === 'all' ? undefined : selected).then((value) => {
        if (active) setSize(value)
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
    void cloud.list(page).then((value) => { if (active) setList(value) })
      .catch((cause: unknown) => { if (active) { setList(undefined); failure(cause) } })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [cloud, page, refresh])
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(''); setDetail(''); setMessage(''); setUploaded(undefined)
    try { await operation(); setRefresh(value => value + 1) }
    catch (cause) { failure(cause) }
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
    {busy && <p role="status">{t('dataBusy')}</p>}
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
    <details className={css.restoreSection}><summary>{t('cloudHistory')}{list === undefined ? '' : ` (${list.total})`}</summary>
      <div className={css.cloudOptions}>
        <label>{t('cloudTarget')}<Input disabled={busy} value={target} onChange={(event) => { setTarget(event.target.value) }} /></label>
        {list?.items.length === 0 && <p>{t('cloudEmpty')}</p>}
        <div className={css.rows}>{list?.items.map(item => <div className={css.row} key={item.id}>
          <div><strong>{new Date(item.createdAt).toLocaleString()}</strong>
            <span>{t(item.scope === 'all' ? 'cloudAll' : 'cloudSelected')} · {item.sessionCount} {t('cloudSessions')} · {(item.bytes / 1024 / 1024).toFixed(2)} {t('cloudSizeUnit')}</span></div>
          <Button disabled={busy || target.trim() === ''} onClick={() => {
            if (window.confirm(t('cloudRestoreConfirm'))) void run(async () => {
              const result = await cloud.restore(item.id, target.trim()); await restored(result)
              if (!result.completed) throw new Error('cloud-partial-restore')
              setMessage(t('cloudRestored'))
            })
          }}>{t('cloudRestore')}</Button>
          <Button disabled={busy} onClick={() => { if (window.confirm(t('cloudDeleteConfirm'))) void run(async () => { await cloud.remove(item.id) }) }}>{t('cloudDelete')}</Button>
        </div>)}</div>
        {list !== undefined && list.total > list.pageSize && <div className={css.toolbar}>
          <Button disabled={busy || page <= 1} onClick={() => { setPage(value => value - 1) }}>{t('cloudPrevious')}</Button>
          <span>{page} / {Math.max(1, Math.ceil(list.total / list.pageSize))}</span>
          <Button disabled={busy || page * list.pageSize >= list.total} onClick={() => { setPage(value => value + 1) }}>{t('cloudNext')}</Button>
        </div>}
      </div>
    </details>
    <details><summary>{t('cloudScope')}</summary><p>{t('cloudDescription')}</p></details>
  </section>
}
