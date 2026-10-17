import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import Page from './page';
import { getDshBackups, deleteDshBackup } from '../../lib/api-client';
vi.mock('../../lib/api-client', () => ({ getDshBackups: vi.fn(), deleteDshBackup: vi.fn(), downloadDshBackup: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const row = { id: 'one', userId: 'owner', userName: '测试用户', employeeNo: 'wh001', lastLoginAt: '2026-10-15T00:00:00Z', createdAt: '2026-10-15T01:00:00Z', bytes: 1024, sessionCount: 2, scope: 'all', sha256: 'a'.repeat(64), canDownload: false };
it('shows login time and backup metadata while hiding downloads for other owners', async () => {
  vi.mocked(getDshBackups).mockResolvedValue({ items: [row], total: 1, page: 1, pageSize: 20 });
  render(<Page />);
  await screen.findByText('测试用户');
  expect(screen.getByRole('columnheader', { name: '上次登录时间' })).toBeDefined();
  expect(screen.queryByRole('button', { name: '下载' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查看' }));
  expect(screen.getByRole('dialog')).toHaveTextContent(row.sha256);
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(deleteDshBackup).mockResolvedValue();
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  await waitFor(() => expect(deleteDshBackup).toHaveBeenCalledWith(row.id));
});
it('clears stale data and reports list failure', async () => {
  vi.mocked(getDshBackups).mockRejectedValue(new Error('服务不可用'));
  render(<Page />);
  expect(await screen.findByRole('alert')).toHaveTextContent('服务不可用');
  expect(screen.getByText('共 0 份备份')).toBeDefined();
});
