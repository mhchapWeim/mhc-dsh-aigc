import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PluginsPage from './page';

const api = vi.hoisted(() => ({ getPlugins: vi.fn(), getPluginGrantOptions: vi.fn(), getPluginReports: vi.fn(), publishPlugin: vi.fn(), uploadPlugin: vi.fn() }));
vi.mock('../../lib/plugin-api', () => api);
beforeEach(() => {
  vi.clearAllMocks();
  api.getPlugins.mockResolvedValue([{ id: 'p1', packageName: '@bhss/dsh-plugin-managed-search', name: '博查搜索', description: '托管网页搜索', isEnabled: false,
    publishedVersionId: null, revision: 1, configuration: {}, hasServerSecret: false,
    grants: { userIds: ['u1'], roleIds: [], departmentIds: [] }, versions: [{ id: 'v1', version: '1.0.0', dshVersion: '0.1.7-alpha.2', sha256: 'abc', size: 100 }] }]);
  api.getPluginGrantOptions.mockResolvedValue({ users: [{ id: 'u1', name: '测试用户', employeeNo: 'wh001' }], roles: [], departments: [] });
  api.getPluginReports.mockResolvedValue([{ userId: 'u1', deviceId: 'device', pluginId: 'p1', version: '1.0.0', revision: 1, status: 'RestartRequired', error: '', updatedAt: '2026-10-10T02:00:00Z' }]);
  api.publishPlugin.mockResolvedValue(undefined); api.uploadPlugin.mockResolvedValue({ pluginId: 'p1', versionId: 'v1' });
});

it('publishes the selected version, grants and server-only secret', async () => {
  const user = userEvent.setup(); render(<PluginsPage />);
  expect(await screen.findByRole('heading', { name: '插件管理' })).toBeInTheDocument();
  expect(screen.queryByText('等待重启')).not.toBeInTheDocument();
  expect(api.getPluginReports).not.toHaveBeenCalled();
  await user.click(await screen.findByRole('button', { name: '配置与发布' }));
  await user.selectOptions(screen.getByLabelText('发布版本'), 'v1');
  await user.click(screen.getByLabelText('启用插件'));
  await user.type(screen.getByLabelText('博查 API Key（仅服务端保存）'), 'server-key');
  await user.click(screen.getByRole('button', { name: '保存并发布' }));
  await waitFor(() => expect(api.publishPlugin).toHaveBeenCalledWith(expect.objectContaining({ isEnabled: true, publishedVersionId: 'v1', grants: { userIds: ['u1'], roleIds: [], departmentIds: [] } }), 'server-key'));
  expect(await screen.findByRole('status')).toHaveTextContent('策略已发布');
});

it('rejects malformed configuration without publishing', async () => {
  const user = userEvent.setup(); render(<PluginsPage />);
  await user.click(await screen.findByRole('button', { name: '配置与发布' }));
  const config = screen.getByLabelText('插件配置（JSON）'); await user.clear(config); await user.type(config, 'null');
  await user.click(screen.getByRole('button', { name: '保存并发布' }));
  await waitFor(() => expect(screen.getAllByRole('alert')[0]).toHaveTextContent('JSON 映射'));
  expect(api.publishPlugin).not.toHaveBeenCalled();
});

it('shows user, role and department scope and publishes their combined selection', async () => {
  api.getPluginGrantOptions.mockResolvedValue({ users: [{ id: 'u1', name: '测试用户', employeeNo: 'wh001' }],
    roles: [{ id: 'r1', name: '研发角色', code: 'dev' }], departments: [{ id: 'd1', name: '研发部门', code: 'rd' }] });
  const user = userEvent.setup(); render(<PluginsPage />);
  await user.click(await screen.findByRole('button', { name: '配置与发布' }));
  expect(screen.getByRole('checkbox', { name: /测试用户/ })).toBeChecked();
  await user.click(screen.getByRole('tab', { name: /角色/ }));
  await user.click(screen.getByRole('checkbox', { name: /研发角色/ }));
  await user.click(screen.getByRole('tab', { name: /部门/ }));
  await user.click(screen.getByRole('checkbox', { name: /研发部门/ }));
  await user.click(screen.getByRole('button', { name: '保存并发布' }));
  await waitFor(() => expect(api.publishPlugin).toHaveBeenCalledWith(expect.objectContaining({
    grants: { userIds: ['u1'], roleIds: ['r1'], departmentIds: ['d1'] },
  }), ''));
});

it('uploads a package and refreshes the version catalog', async () => {
  const user = userEvent.setup(); render(<PluginsPage />);
  await screen.findByRole('button', { name: '配置与发布' });
  const file = new File(['package'], 'plugin.tgz', { type: 'application/gzip' });
  await user.upload(screen.getByLabelText('上传插件包'), file);
  await waitFor(() => expect(api.uploadPlugin).toHaveBeenCalledWith(file));
  expect(await screen.findByRole('status')).toHaveTextContent('版本已上传');
});

it('paginates plugins independently from client status', async () => {
  const template = (await api.getPlugins())[0];
  api.getPlugins.mockResolvedValue(Array.from({ length: 11 }, (_, index) => ({ ...template, id: `p-${index}`, name: `插件 ${index + 1}` })));
  const user = userEvent.setup(); render(<PluginsPage />);
  await screen.findByRole('heading', { name: '插件 1' });
  expect(screen.getAllByRole('button', { name: '配置与发布' })).toHaveLength(5);
  expect(screen.queryByRole('heading', { name: '插件 11' })).not.toBeInTheDocument();
  await user.click(within(screen.getByRole('navigation', { name: '插件管理分页' })).getByRole('button', { name: '第 3 页' }));
  expect(screen.getByRole('heading', { name: '插件 11' })).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: '配置与发布' })).toHaveLength(1);
});
