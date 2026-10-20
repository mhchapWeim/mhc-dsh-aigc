import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import Page from './page';
import * as api from '../../lib/api-client';

const row = { id: 'row-1', eventId: 'event-1', deviceId: 'device-1', appVersion: '0.1.7-alpha.2.20261008.2', category: 'tool', operation: 'read_file',
  sessionId: 'session-1', occurredAt: '2026-10-09T04:00:00Z', receivedAt: '2026-10-09T04:01:00Z', username: 'wh00028', displayName: '测试员工' };
vi.mock('../../lib/api-client', () => ({ getDshFailures: vi.fn(), getDshFailure: vi.fn(), downloadDshFailure: vi.fn() }));
beforeEach(() => {
  vi.mocked(api.getDshFailures).mockReset().mockResolvedValue({ items: [row], page: 1, pageSize: 20, total: 1, retentionDays: 7 });
  vi.mocked(api.getDshFailure).mockReset().mockResolvedValue({ ...row, schemaVersion: 1, operationId: 'call-1', error: 'ENOENT: File not found', context: ['tool started: read_file'] });
  vi.mocked(api.downloadDshFailure).mockReset().mockResolvedValue();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});

it('filters by user and version, opens associated error details, and downloads the selected record', async () => {
  render(<Page />); await screen.findByText('测试员工');
  fireEvent.change(screen.getByLabelText('用户'), { target: { value: 'wh00028' } });
  fireEvent.change(screen.getByLabelText('版本'), { target: { value: '20261008.2' } });
  fireEvent.click(screen.getByRole('button', { name: '查询' }));
  await waitFor(() => expect(api.getDshFailures).toHaveBeenLastCalledWith(expect.objectContaining({ user: 'wh00028', version: '20261008.2' }), 1, 5));
  fireEvent.click(screen.getByRole('button', { name: '查看' }));
  await screen.findByText('ENOENT: File not found'); expect(screen.getByText('call-1')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '下载诊断日志' }));
  await waitFor(() => expect(api.downloadDshFailure).toHaveBeenCalledWith('row-1'));
});

it('shows backend failure and recovers through refresh', async () => {
  vi.mocked(api.getDshFailures).mockRejectedValueOnce(new Error('当前账号没有权限'));
  render(<Page />); expect(await screen.findByRole('alert')).toHaveTextContent('当前账号没有权限');
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await screen.findByText('测试员工'); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('shows unauthenticated installer failures and filters by the installer category', async () => {
  vi.mocked(api.getDshFailures).mockResolvedValue({ items: [{ ...row, category: 'installer', operation: 'preflight', username: '', displayName: '安装器（未登录）' }], page: 1, pageSize: 20, total: 1, retentionDays: 7 });
  render(<Page />);
  await screen.findByText('安装器（未登录）');
  expect(screen.getByText('安装前检查')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('错误类型'), { target: { value: 'installer' } });
  fireEvent.click(screen.getByRole('button', { name: '查询' }));
  await waitFor(() => expect(api.getDshFailures).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'installer' }), 1, 5));
});
