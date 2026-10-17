// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { CloudBackupPanel } from '../src/client/CloudBackupPanel.tsx'
import { zh } from '../src/client/locales.ts'
import type { CloudBackupActions } from '../src/client/CloudBackupPanel.tsx'
import type { WorkspaceMigrationValue } from '@deepseek-ai/dsh-api-workspace-controller/types'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const backup = { id: 'f95234b0-6b06-4564-8b9a-63767fe7d7e5', createdAt: '2026-10-15T00:00:00Z', bytes: 1024, sessionCount: 2, scope: 'selected', sha256: 'a'.repeat(64) }
const restored: WorkspaceMigrationValue = { migrationId: backup.id, targetPath: 'D:\\wanzaiwork', backupPath: 'C:\\backup', sessionCount: 2, fileCount: 0, completed: true, warnings: [], results: [] }
function fixture() {
  const cloud: CloudBackupActions = { list: vi.fn(async () => ({ items: [backup], total: 1, page: 1, pageSize: 20 })), upload: vi.fn(async () => backup), restore: vi.fn(async () => restored), remove: vi.fn(async () => {}) }
  const afterRestore = vi.fn(async () => {})
  render(<CloudBackupPanel cloud={cloud} t={key => zh[key]} selected={['session-one']} target="D:\wanzaiwork" setTarget={vi.fn()} restored={afterRestore} />)
  return { cloud, afterRestore }
}

it('uploads all history or the explicit selection and restores after confirmation', async () => {
  const { cloud, afterRestore } = fixture()
  await waitFor(() => expect(screen.getByRole('button', { name: zh.cloudUploadAll })).toHaveProperty('disabled', false))
  fireEvent.click(screen.getByRole('button', { name: zh.cloudUploadAll }))
  await screen.findByText(zh.cloudUploaded)
  expect(screen.getByText(zh.cloudUploadedAdvice)).toBeDefined()
  expect(cloud.upload).toHaveBeenLastCalledWith(undefined)
  fireEvent.click(screen.getByText(zh.cloudChoose))
  await waitFor(() => expect(screen.getByRole('button', { name: /上传选中的会话/ })).toHaveProperty('disabled', false))
  fireEvent.click(screen.getByRole('button', { name: /上传选中的会话/ }))
  await waitFor(() => expect(cloud.upload).toHaveBeenLastCalledWith(['session-one']))
  fireEvent.click(screen.getByText(new RegExp('^' + zh.cloudHistory)))
  vi.spyOn(window, 'confirm').mockReturnValue(false)
  await waitFor(() => expect(screen.getByRole('button', { name: zh.cloudRestore })).toHaveProperty('disabled', false))
  fireEvent.click(screen.getByRole('button', { name: zh.cloudRestore }))
  expect(cloud.restore).not.toHaveBeenCalled()
  vi.mocked(window.confirm).mockReturnValue(true)
  fireEvent.click(screen.getByRole('button', { name: zh.cloudRestore }))
  await screen.findByText(zh.cloudRestored)
  expect(cloud.restore).toHaveBeenCalledWith(backup.id, 'D:\\wanzaiwork')
  expect(afterRestore).toHaveBeenCalledWith(restored)
})

it('shows upload errors without reporting success', async () => {
  const { cloud } = fixture()
  vi.mocked(cloud.upload).mockRejectedValue(new Error('Backup is too large'))
  await waitFor(() => expect(screen.getByRole('button', { name: zh.cloudUploadAll })).toHaveProperty('disabled', false))
  fireEvent.click(screen.getByRole('button', { name: zh.cloudUploadAll }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', zh.cloudTooLarge)
  expect(screen.queryByText(zh.cloudUploaded)).toBeNull()
})

it('records the localized cloud backup controls and scope disclosure', async () => {
  const cloud: CloudBackupActions = { list: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })), upload: vi.fn(async () => backup), restore: vi.fn(async () => restored), remove: vi.fn(async () => {}) }
  const { container } = render(<CloudBackupPanel cloud={cloud} t={key => zh[key]} selected={[]} target="D:\wanzaiwork" setTarget={vi.fn()} restored={vi.fn(async () => {})} />)
  await screen.findByText(zh.cloudEmpty)
  await expect(`${container.textContent}\n`).toMatchFileSnapshot('./expected/cloud-backup-zh.txt')
})

it('keeps restore controls secondary and selects conversations by name without exposing ids', async () => {
  const id = 'session-23863f1a-44cb-4213-8caa-92acbfc85811'
  const cloud: CloudBackupActions = { list: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })), upload: vi.fn(async () => backup), restore: vi.fn(async () => restored), remove: vi.fn(async () => {}) }
  function Fixture() {
    const [selected, setSelected] = useState<string[]>([])
    return <CloudBackupPanel cloud={cloud} t={key => zh[key]} selected={selected} setSelected={setSelected}
      sessions={[{ sessionId: SessionId(id), title: '工业检测方案', status: 'ok' }]}
      target="D:\wanzaiwork" setTarget={vi.fn()} restored={vi.fn(async () => {})} />
  }
  const { container } = render(<Fixture />)
  await waitFor(() => expect(screen.getByRole('button', { name: zh.cloudUploadAll })).toHaveProperty('disabled', false))
  expect(container.querySelector('details')?.hasAttribute('open')).toBe(false)
  expect(container.textContent).not.toContain(id)
  fireEvent.click(screen.getByText(zh.cloudChoose))
  fireEvent.click(screen.getByRole('checkbox', { name: '工业检测方案' }))
  fireEvent.click(screen.getByRole('button', { name: /上传选中的会话/ }))
  await waitFor(() => expect(cloud.upload).toHaveBeenCalledWith([id]))
})

it('explains missing backup endpoints without showing raw protocol errors by default', async () => {
  const { cloud } = fixture()
  vi.mocked(cloud.upload).mockRejectedValue(new Error('Cloud backup HTTP 404'))
  await waitFor(() => expect(screen.getByRole('button', { name: zh.cloudUploadAll })).toHaveProperty('disabled', false))
  fireEvent.click(screen.getByRole('button', { name: zh.cloudUploadAll }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', zh.cloudUnavailable)
  expect(screen.queryByRole('status')).toBeNull()
})

it('recalculates actual selection size and blocks oversized uploads', async () => {
  const measure = vi.fn(async (ids?: readonly string[]) => ({ bytes: ids === undefined ? 25 * 1024 * 1024 : 1024, limit: 24 * 1024 * 1024 }))
  const cloud: CloudBackupActions = { measure, list: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })), upload: vi.fn(async () => backup), restore: vi.fn(async () => restored), remove: vi.fn(async () => {}) }
  render(<CloudBackupPanel cloud={cloud} t={key => zh[key]} selected={['one']} target="D:\\wanzaiwork" setTarget={vi.fn()} restored={vi.fn(async () => {})} />)
  await screen.findByText(/25.00 \/ 24 MiB/)
  expect(screen.getByRole('button', { name: zh.cloudUploadAll })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByText(zh.cloudChoose))
  await screen.findByText(/0.00 \/ 24 MiB/)
  await waitFor(() => expect(screen.getByRole('button', { name: zh.cloudUploadSelected })).toHaveProperty('disabled', false))
  expect(measure).toHaveBeenLastCalledWith(['one'])
})

it('preserves the real measurement error instead of claiming work is running', async () => {
  const cloud: CloudBackupActions = { measure: vi.fn(async () => { throw new Error('History file is missing') }), list: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })), upload: vi.fn(async () => backup), restore: vi.fn(async () => restored), remove: vi.fn(async () => {}) }
  render(<CloudBackupPanel cloud={cloud} t={key => zh[key]} selected={[]} target="D:\\wanzaiwork" setTarget={vi.fn()} restored={vi.fn(async () => {})} />)
  await screen.findByText(new RegExp(zh.cloudMeasureFailed))
  expect(screen.getByText('History file is missing')).toBeDefined()
  expect(screen.getByRole('button', { name: zh.cloudUploadAll })).toHaveProperty('disabled', true)
})
