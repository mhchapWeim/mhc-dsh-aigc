/** Data repair is available even when organization authentication or a historical cwd is unavailable. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceDataStatus, WorkspaceMigrationRequest, WorkspaceMigrationValue } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { ManagedAccountKey } from './locales.ts'
import css from './DataMigrationDialog.module.css'
import { CloudBackupPanel } from './CloudBackupPanel.tsx'
import type { CloudBackupActions } from './CloudBackupPanel.tsx'

/** Host operations owned by the Workspace Remote service. */
export interface DataMigrationActions {
  cloud?: CloudBackupActions
  status(): Promise<WorkspaceDataStatus>
  preview(request: WorkspaceMigrationRequest): Promise<WorkspaceMigrationValue>
  commit(migrationId: string): Promise<WorkspaceMigrationValue>
  repair(workspaceId: string): Promise<void>
  remove(workspaceId: string): Promise<void>
  forgetMissing(): Promise<void>
}

/** Preview, confirm, and resume copy migrations without moving raw Session files by hand. */
export function DataMigrationDialog({ data, t, close }: {
  data: DataMigrationActions; t: (key: ManagedAccountKey) => string; close(): void
}): ReactNode {
  const [status, setStatus] = useState<WorkspaceDataStatus>()
  const [source, setSource] = useState('')
  const [history, setHistory] = useState('')
  const [target, setTarget] = useState('')
  const [copyFiles, setCopyFiles] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [plan, setPlan] = useState<WorkspaceMigrationValue>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [resume, setResume] = useState('')
  const feedback = useRef<HTMLDivElement>(null)
  const resumeCompleted = plan?.completed === true && plan.migrationId === resume.trim()
  const sourcePath = status?.workspaces.find(workspace => workspace.workspaceId === source)?.path
  const visibleSessions = status?.sessions.filter(session => !session.archived && (sourcePath === undefined || session.cwd === sourcePath)) ?? []
  const selectable = visibleSessions.filter(session => session.status === 'ok').map(session => session.sessionId)
  const allSelected = selectable.length > 0 && selectable.every(id => selected.includes(id))
  useEffect(() => {
    if (plan !== undefined || error !== '') feedback.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [plan, error])
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError('')
    try { await operation() } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const refresh = async (): Promise<void> => { setStatus(await data.status()) }
  useEffect(() => {
    let active = true
    void data.status().then((value) => {
      if (!active) return
      setStatus(value); setTarget(value.allowedRoot ?? '')
    }).catch((failure) => { if (active) setError(failure instanceof Error ? failure.message : String(failure)) })
    return () => { active = false }
  }, [data])
  const changed = (): void => { setPlan(undefined) }
  const preview = (): Promise<void> => run(async () => {
    const sourceId = status?.workspaces.find(workspace => workspace.workspaceId === source)?.workspaceId
    const selectedIds = status?.sessions.filter(session => selected.includes(session.sessionId)).map(session => session.sessionId) ?? []
    const request: WorkspaceMigrationRequest = {
      targetPath: target.trim(), copyFiles,
      ...(history.trim() === '' ? {} : { historyPath: history.trim() }),
      ...(sourceId === undefined || history.trim() !== '' ? {} : { sourceWorkspaceId: sourceId }),
      ...(selectedIds.length === 0 || history.trim() !== '' ? {} : { sessionIds: selectedIds }),
    }
    setPlan(await data.preview(request))
  })
  const commit = (id: string): Promise<void> => run(async () => {
    const result = await data.commit(id)
    setPlan(result); setResume(id); await refresh()
  })
  return <Modal open headless className={css.dialog as string} title={t('dataTitle')} onClose={busy ? () => {} : close}>
    <div className={css.root}>
      <h2>{t(data.cloud === undefined ? 'dataTitle' : 'cloudTitle')}</h2>
      <p>{t(data.cloud === undefined ? 'dataDescription' : 'cloudIntro')}</p>
      <div className={css.toolbar}>
        {data.cloud === undefined && <Button disabled={busy} onClick={() => { void run(refresh) }}>{t('dataRefresh')}</Button>}
        <Button disabled={busy} onClick={close}>{t('close')}</Button>
      </div>
      {data.cloud !== undefined && <CloudBackupPanel cloud={data.cloud} t={t} sessions={status?.sessions ?? []} workspaces={status?.workspaces ?? []} setSelected={setSelected} onBusyChange={setBusy} selected={selected} target={target} setTarget={setTarget} restored={async (result) => { setPlan(result); setResume(result.migrationId); await refresh() }} />}
      <details open={data.cloud === undefined}><summary>{t('dataLocalTools')}</summary>
        {data.cloud !== undefined && <p>{t('dataDescription')}</p>}
        <div className={css.rows}>
          {status?.workspaces.map(workspace => <div className={css.row} key={workspace.workspaceId}>
            <div><strong>{workspace.title}</strong><code>{workspace.path}</code>
              <span>{t(workspace.status === 'ok' ? 'dataAvailable' : 'dataMissingDirectory')}</span></div>
            {workspace.status !== 'ok' && <Button disabled={busy} onClick={() => { void run(async () => { await data.repair(workspace.workspaceId); await refresh() }) }}>{t('dataRepairDirectory')}</Button>}
            <Button disabled={busy} onClick={() => {
              if (window.confirm(t('dataRemoveConfirm'))) void run(async () => { await data.remove(workspace.workspaceId); await refresh() })
            }}>{t('dataRemoveRecord')}</Button>
          </div>)}
        </div>
        <label>{t('dataSource')}<select disabled={busy} value={source} onChange={(event) => {
          setSource(event.target.value); setSelected([]); setCopyFiles(false); changed()
        }}><option value="">{t('dataAllSessions')}</option>
          {status?.workspaces.map(workspace => <option value={workspace.workspaceId} key={workspace.workspaceId}>{workspace.title} — {workspace.path}</option>)}
        </select></label>
        <label>{t('dataHistoryPath')}<Input disabled={busy} value={history} onChange={(event) => { setHistory(event.target.value); changed() }} /></label>
        <label>{t('dataTarget')}<Input disabled={busy} value={target} onChange={(event) => { setTarget(event.target.value); changed() }} /></label>
        <label className={css.check}><input type="checkbox" checked={copyFiles} disabled={busy || (source === '' && history.trim() === '')}
          onChange={(event) => { setCopyFiles(event.target.checked); changed() }} />{t('dataCopyFiles')}</label>
        <details><summary>{t('dataSessions')}</summary>
          <p>{t('dataSessionSelection')}</p>
          <Button disabled={busy || history.trim() !== '' || selectable.length === 0} onClick={() => { setSelected(allSelected ? [] : selectable); changed() }}>{t(allSelected ? 'dataSelectNone' : 'dataSelectAll')}</Button>
          <div className={css.sessions}>{visibleSessions.map(session => <label key={session.sessionId} className={css.check}>
            <input type="checkbox" disabled={busy || session.status !== 'ok' || history.trim() !== ''} checked={selected.includes(session.sessionId)}
              onChange={(event) => { setSelected(ids => event.target.checked ? [...ids, session.sessionId] : ids.filter(id => id !== session.sessionId)); changed() }} />
            <span>{session.title || t('cloudUntitled')}</span><span>{t(session.status === 'ok' ? 'dataAvailable' : 'dataMissingSession')}</span>
          </label>)}</div>
          <Button disabled={busy} onClick={() => {
            if (window.confirm(t('dataForgetConfirm'))) void run(async () => { await data.forgetMissing(); await refresh() })
          }}>{t('dataForgetMissing')}</Button>
        </details>
        <Button variant="primary" disabled={busy || target.trim() === ''} onClick={() => { void preview() }}>{t(busy ? 'dataBusy' : 'dataPreview')}</Button>
        <div ref={feedback} aria-live="polite">
          {error !== '' && <p role="alert" className={css.error}>{error}</p>}
          {plan !== undefined && <section className={css.receipt}>
            <strong>{t(plan.completed ? 'dataCompleted' : 'dataPreviewReady')}</strong>
            <p>{t('dataCounts')}: {plan.sessionCount} / {plan.fileCount}</p>
            <p>{t('dataBackup')}: <code>{plan.backupPath}</code></p>
            <p>{t('dataTarget')}: <code>{plan.targetPath}</code></p>
            <p>{t('dataMigrationId')}: <code>{plan.migrationId}</code></p>
            {plan.warnings.map((warning, index) => <p role="status" key={index}>{warning}</p>)}
            {plan.results.filter(result => result.error !== undefined).map(result => <p role="alert" key={result.sourceId}>{result.sourceId}: {result.error}</p>)}
            <Button disabled={busy} onClick={() => { void commit(plan.migrationId) }}>{t(plan.completed ? 'dataSync' : 'dataCommit')}</Button>
          </section>}
        </div>
        <label>{t('dataResume')}<Input disabled={busy} value={resume} onChange={(event) => { setResume(event.target.value) }} /></label>
        <Button disabled={busy || resume.trim() === '' || resumeCompleted} onClick={() => { void commit(resume.trim()) }}>{t(busy ? 'dataBusy' : 'dataRetry')}</Button>
        {resumeCompleted && <p role="status">{t('dataResumeCompleted')}</p>}
        {status?.migrations.filter(item => !item.completed).map(item => <div className={css.row} key={item.migrationId}>
          <code>{item.targetPath} · {item.migrationId}</code>
          <Button disabled={busy} onClick={() => { setPlan(item); setResume(item.migrationId) }}>{t('dataPreviewReady')}</Button>
        </div>)}
      </details>
    </div>
  </Modal>
}
