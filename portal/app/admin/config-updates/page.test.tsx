import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConfigUpdatesPage from './page';
import * as api from '../../lib/config-sync-api';

vi.mock('../../lib/config-sync-api', () => ({getConfigSyncDevices: vi.fn(async () => ({
  revision: 8, mqEnabled: true, mqConnected: true, pendingEvents: 0, mqErrorCode: '', page: 1, pageSize: 5, total: 1,
  summary: {applied: 1, pending: 0, failed: 0, offline: 0, unreported: 0},
  items: [{userId: 'u', employeeNo: 'wh00412', userName: '李俊', deviceId: 'device', deviceName: '设备甲', clientVersion: '0.1.7',
    targetRevision: 8, appliedRevision: 8, attemptedRevision: 8, status: 'Applied', errorCode: '', lastSeenAt: '2026-11-03T00:00:00Z', appliedAt: '2026-11-03T00:00:00Z'}],
}))}));

it('shows device receipts separately from MQ delivery and filters user status', async () => {
  const user = userEvent.setup(); render(<ConfigUpdatesPage/>);
  expect(await screen.findByText('设备甲')).toBeVisible();
  expect(screen.getByText('MQ 已连接', {exact: false})).toBeVisible();
  expect(screen.getByText('v8 / v8')).toBeVisible();
  await user.click(screen.getByRole('combobox', {name: '配置更新状态筛选'}));
  await user.click(screen.getByRole('option', {name: '更新失败'}));
  await waitFor(() => expect(api.getConfigSyncDevices).toHaveBeenLastCalledWith(1, 5, '', 'Failed'));
});

it('displays a fetch failure and clears obsolete receipts', async () => {
  vi.mocked(api.getConfigSyncDevices).mockRejectedValueOnce(new Error('状态接口不可用'));
  render(<ConfigUpdatesPage/>);
  expect(await screen.findByRole('alert')).toHaveTextContent('状态接口不可用');
  expect(screen.queryByText('设备甲')).not.toBeInTheDocument();
});
