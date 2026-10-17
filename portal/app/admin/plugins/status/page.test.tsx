import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PluginStatusPage from './page';

const api = vi.hoisted(() => ({ getPlugins: vi.fn(), getPluginGrantOptions: vi.fn(), getPluginReports: vi.fn() }));
vi.mock('../../../lib/plugin-api', () => api);
beforeEach(() => {
  vi.clearAllMocks();
  api.getPlugins.mockResolvedValue([{ id: 'p1', name: '博查搜索' }]);
  api.getPluginGrantOptions.mockResolvedValue({ users: [{ id: 'u1', name: '测试用户' }] });
  api.getPluginReports.mockImplementation(async (page: number) => ({
    items: [{ userId: 'u1', deviceId: `device-${page}`, pluginId: 'p1', version: '1.0.0', revision: 1, status: 'RestartRequired', error: '', updatedAt: '2026-10-10T02:00:00Z' }],
    total: 21, page, pageSize: 20,
  }));
});

it('renders client reports separately and fetches each page from the server', async () => {
  const user = userEvent.setup(); render(<PluginStatusPage />);
  const table = await screen.findByRole('table', { name: '客户端插件状态表格' });
  expect(within(table).getByText('等待重启')).toBeInTheDocument();
  expect(within(table).getByText('测试用户')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '上传插件包' })).not.toBeInTheDocument();
  await user.click(within(screen.getByRole('navigation', { name: '插件状态分页' })).getByRole('button', { name: '下一页' }));
  expect(await screen.findByText('device-2')).toBeInTheDocument();
  expect(screen.queryByText('device-1')).not.toBeInTheDocument();
  expect(api.getPluginReports).toHaveBeenLastCalledWith(2, 20);
  await user.click(screen.getByRole('button', { name: '刷新' }));
  await waitFor(() => expect(api.getPluginReports).toHaveBeenCalledTimes(3));
  expect(api.getPluginReports).toHaveBeenLastCalledWith(2, 20);
});

it('shows empty reports and recovers from failed loading', async () => {
  api.getPluginReports.mockRejectedValueOnce(new Error('读取失败'));
  const user = userEvent.setup(); render(<PluginStatusPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('读取失败');
  api.getPluginReports.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  await user.click(screen.getByRole('button', { name: '刷新' }));
  expect(await screen.findByText('尚无客户端回报。')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(within(screen.getByRole('navigation')).getByRole('button', { name: '下一页' })).toBeDisabled();
});

it('explains the record limit when the running backend still returns legacy data', async () => {
  api.getPluginReports.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, legacyResponse: true });
  render(<PluginStatusPage />);
  expect(await screen.findByText(/当前后端仍返回旧版数据/)).toHaveTextContent('最近 500 条');
  expect(screen.getByRole('table')).toBeInTheDocument();
});
