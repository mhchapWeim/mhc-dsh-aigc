// @vitest-environment jsdom
/** Repair and migration controls stay usable while signed out and require a preview before copying. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DataMigrationDialog } from '../src/client/DataMigrationDialog.tsx'
import type { DataMigrationActions } from '../src/client/DataMigrationDialog.tsx'
import type { WorkspaceDataStatus, WorkspaceMigrationValue } from '@deepseek-ai/dsh-api-workspace-controller/types'
import { zh } from '../src/client/locales.ts'
import { ManagedAccountMenu } from '../src/client/ManagedAccountMenu.tsx'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionId } from '@deepseek-ai/dsh-session/types'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const empty: WorkspaceDataStatus = { allowedRoot: 'D:\\wanzaiwork', workspaces: [], sessions: [], migrations: [] }
const plan: WorkspaceMigrationValue = {
  migrationId: 'd86bf5b7-3610-4b45-a2a2-25671ff8247f', backupPath: 'C:\\data\\migrations\\backup',
  targetPath: 'D:\\wanzaiwork', sessionCount: 1, fileCount: 0, warnings: [], completed: false, results: [],
}
function actions(): DataMigrationActions {
  return { status: vi.fn(async () => empty), preview: vi.fn(async () => plan), commit: vi.fn(async () => ({ ...plan, completed: true })),
    repair: vi.fn(async () => {}), remove: vi.fn(async () => {}), forgetMissing: vi.fn(async () => {}) }
}
it('renders the localized repair and migration controls', async () => {
  render(<DataMigrationDialog data={actions()} t={key => zh[key]} close={vi.fn()} />)
  await waitFor(() => expect(screen.getByLabelText(zh.dataTarget)).toHaveProperty('value', empty.allowedRoot))
  await expect(`${screen.getByRole('dialog').textContent}\n`).toMatchFileSnapshot('./expected/data-migration-zh.txt')
})
it('requires a backup preview, invalidates it when the destination changes, and confirms the saved plan', async () => {
  const data = actions()
  render(<DataMigrationDialog data={data} t={key => zh[key]} close={vi.fn()} />)
  await waitFor(() => expect(screen.getByLabelText(zh.dataTarget)).toHaveProperty('value', empty.allowedRoot))
  expect(screen.queryByRole('button', { name: zh.dataCommit })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.dataPreview }))
  fireEvent.click(await screen.findByRole('button', { name: zh.dataCommit }))
  await screen.findByText(zh.dataCompleted)
  expect(data.commit).toHaveBeenCalledWith(plan.migrationId)
  fireEvent.change(screen.getByLabelText(zh.dataTarget), { target: { value: 'D:\\wanzaiwork\\new' } })
  expect(screen.queryByText(zh.dataCompleted)).toBeNull()
})
it('keeps a failed migration available for retry', async () => {
  const data = actions()
  vi.mocked(data.commit).mockRejectedValueOnce(new Error('Target file conflicts'))
  render(<DataMigrationDialog data={data} t={key => zh[key]} close={vi.fn()} />)
  await waitFor(() => expect(screen.getByLabelText(zh.dataTarget)).toHaveProperty('value', empty.allowedRoot))
  fireEvent.click(screen.getByRole('button', { name: zh.dataPreview }))
  fireEvent.click(await screen.findByRole('button', { name: zh.dataCommit }))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: zh.dataCommit }))
  await screen.findByText(zh.dataCompleted)
  expect(data.commit).toHaveBeenCalledTimes(2)
})
it('offers local data repair without organization authentication', async () => {
  const data = actions()
  let openData: (() => void) | undefined
  window.__DSH_DATA_MIGRATION__ = { subscribe(listener) { openData = listener; return () => {} } }
  render(<ManagedAccountMenu {...({} as GlobalStandardProps)} wide openSettings={vi.fn()} openOnboarding={vi.fn()}
    status={vi.fn(async () => ({ enabled: true as const, user: null }))} login={vi.fn()} casStart={vi.fn()} casPoll={vi.fn()} logout={vi.fn()}
    data={data} t={key => zh[key]} />)
  await act(async () => { openData?.() })
  delete window.__DSH_DATA_MIGRATION__
  await screen.findByRole('dialog', { name: zh.dataTitle })
  expect(data.status).toHaveBeenCalled()
})

it('marks a completed migration and prevents repeating the same receipt', async () => {
  const data = actions()
  render(<DataMigrationDialog data={data} t={key => zh[key]} close={vi.fn()} />)
  await waitFor(() => expect(screen.getByLabelText(zh.dataTarget)).toHaveProperty('value', empty.allowedRoot))
  fireEvent.change(screen.getByLabelText(zh.dataResume), { target: { value: plan.migrationId } })
  fireEvent.click(screen.getByRole('button', { name: zh.dataRetry }))
  await screen.findByText(zh.dataResumeCompleted)
  expect(screen.getByRole('button', { name: zh.dataRetry })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: zh.dataRetry }))
  expect(data.commit).toHaveBeenCalledOnce()
  fireEvent.change(screen.getByLabelText(zh.dataResume), { target: { value: 'another-receipt' } })
  expect(screen.getByRole('button', { name: zh.dataRetry })).toHaveProperty('disabled', false)
})

it('selects all readable sessions and clears selection without selecting missing files', async () => {
  const data = actions()
  vi.mocked(data.status).mockResolvedValue({ ...empty, sessions: [
    { sessionId: SessionId('first'), status: 'ok' },
    { sessionId: SessionId('second'), status: 'ok' },
    { sessionId: SessionId('missing'), status: 'missing' },
    { sessionId: SessionId('archived'), status: 'ok', archived: true },
  ] })
  render(<DataMigrationDialog data={data} t={key => zh[key]} close={vi.fn()} />)
  await waitFor(() => expect(screen.getByLabelText(zh.dataTarget)).toHaveProperty('value', empty.allowedRoot))
  fireEvent.click(screen.getByText(zh.dataSelectAll))
  fireEvent.click(screen.getByRole('button', { name: zh.dataPreview }))
  await waitFor(() => expect(data.preview).toHaveBeenCalledWith(expect.objectContaining({ sessionIds: ['first', 'second'] })))
  fireEvent.click(screen.getByText(zh.dataSelectNone))
  expect(screen.getByText(zh.dataSelectAll)).toBeDefined()
})

it('shows progress while resuming and surfaces failure beside the retry controls', async () => {
  const data = actions()
  const pending = Promise.withResolvers<WorkspaceMigrationValue>()
  vi.mocked(data.commit).mockReturnValueOnce(pending.promise)
  render(<DataMigrationDialog data={data} t={key => zh[key]} close={vi.fn()} />)
  await waitFor(() => expect(screen.getByLabelText(zh.dataTarget)).toHaveProperty('value', empty.allowedRoot))
  fireEvent.change(screen.getByLabelText(zh.dataResume), { target: { value: plan.migrationId } })
  fireEvent.click(screen.getByRole('button', { name: zh.dataRetry }))
  expect(screen.queryByRole('button', { name: zh.dataRetry })).toBeNull()
  expect(screen.getAllByRole('button', { name: zh.dataBusy }).every(button => (button as HTMLButtonElement).disabled)).toBe(true)
  pending.reject(new Error('Receipt unavailable'))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Receipt unavailable')
  expect(screen.getByRole('button', { name: zh.dataRetry })).toHaveProperty('disabled', false)
})
