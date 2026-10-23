import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ModelManagementPage from './page';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  saveGrants: vi.fn(),
  models: vi.fn(),
  users: vi.fn(),
  grants: vi.fn(),
  sync: vi.fn(),
  searchSettings: vi.fn(),
  saveSearch: vi.fn(),
}));

vi.mock('../../lib/api-client', () => ({
  hasBackend: true,
  saveModelConfiguration: mocks.save,
  getModelConfigurations: mocks.models,
  getGrantOptions: mocks.users,
  getModelGrants: mocks.grants,
  saveModelGrants: mocks.saveGrants,
  syncLiteLlmModels: mocks.sync,
  getWebSearchSettings: mocks.searchSettings,
  saveWebSearchSettings: mocks.saveSearch,
}));

it('selects users visibly and saves their model grants', async () => {
  mocks.models.mockResolvedValue([{ id: 'model-1', name: 'GLM-5.3', providerKind: 'Online', modelIdentifier: 'zai-org/GLM-5.3', baseUrl: 'https://example.test', endpointPath: '/chat/completions', supportsTools: true, hasApiKey: true, isEnabled: true, isDefault: false }]);
  mocks.users.mockResolvedValue({ users: [{ id: 'user-1', name: '姚伟明', employeeNo: 'wh00028' }, { id: 'user-2', name: '新用户', employeeNo: 'wh01000' }],
    roles: [{ id: 'role-1', name: '研发', code: 'developer' }], departments: [{ id: 'dept-1', name: '研发部', code: 'rd' }] });
  mocks.grants.mockResolvedValue({ userIds: [], roleIds: [], departmentIds: [] });
  mocks.saveGrants.mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(<ModelManagementPage />);
  await user.click(await screen.findByRole('button', { name: '更多操作GLM-5.3' }));
  await user.click(screen.getByRole('button', { name: '授权GLM-5.3' }));
  expect(screen.getByRole('button', { name: '保存授权' })).toBeVisible();
  await user.click(screen.getByRole('tab', { name: /用户/  }));
  await user.type(screen.getByRole('searchbox', { name: '搜索授权用户' }), 'wh');
  const first = await screen.findByRole('checkbox', { name: /姚伟明.*wh00028/ });
  const second = screen.getByRole('checkbox', { name: /新用户.*wh01000/ });
  expect(first).not.toBeChecked();
  await user.click(first);
  await user.click(second);
  expect(first).toBeChecked();
  expect(second).toBeChecked();
  expect(first.closest('label')).toHaveClass('is-selected');
  expect(screen.getByText('2 项')).toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: /部门/  }));
  await user.click(screen.getByRole('tab', { name: /部门/ }));
  await user.type(screen.getByRole('searchbox', { name: '搜索授权部门' }), 'rd');
  await user.click(screen.getByRole('checkbox', { name: /研发部.*rd/ }));
  await user.click(screen.getByRole('button', { name: '保存授权' }));
  await waitFor(() => expect(mocks.saveGrants).toHaveBeenCalledWith('model-1',
    { userIds: ['user-1', 'user-2'], roleIds: [], departmentIds: ['dept-1'] }));
});

it('keeps parameters in the details drawer and explains each action', async () => {
  mocks.models.mockResolvedValue([{ id: 'model-1', name: 'DeepSeek', providerKind: 'LiteLLM',
    modelIdentifier: 'deepseek-v4-pro', baseUrl: 'http://localhost:4000/v1', endpointPath: '/chat/completions',
    supportsTools: true, hasApiKey: true, isEnabled: true, isDefault: false,
    liteLlmCapabilities: { mode: 'chat', supportedFeatures: ['supports_vision', 'supports_function_calling'],
      contextWindow: 128000, maxOutputTokens: 8192 } }]);
  const user = userEvent.setup();
  render(<ModelManagementPage />);
  expect(await screen.findByText('图片能力未确认')).toBeInTheDocument();
  expect(screen.getByText('工具调用')).toBeInTheDocument();
  expect(screen.queryByText('128,000')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'DeepSeek' }));
  const drawer = screen.getByRole('dialog', { name: '模型详情' });
  expect(within(drawer).getByText('128,000')).toBeInTheDocument();
  expect(within(drawer).getByText('8,192')).toBeInTheDocument();
  expect(within(drawer).getByText('http://localhost:4000/v1')).toBeInTheDocument();
  expect(within(drawer).getByText('图片能力未确认')).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'DeepSeek' })).toHaveFocus();
  expect(screen.queryByText('已配置密钥')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '测试DeepSeek' })).toHaveAttribute('title', expect.stringContaining('检查模型'));
  expect(screen.getByRole('button', { name: '编辑DeepSeek' })).toHaveAttribute('title', '编辑模型配置');
  await user.click(screen.getByRole('button', { name: '更多操作DeepSeek' }));
  expect(screen.getByRole('button', { name: '授权DeepSeek' })).toHaveAttribute('title', expect.stringContaining('设置可使用'));
  expect(screen.getByRole('button', { name: '删除DeepSeek' })).toHaveAttribute('title', '删除模型配置');
});

it('limits the list to three capabilities while retaining advanced and unknown metadata in details', async () => {
  mocks.models.mockResolvedValue([{ id: 'many', name: 'Many', providerKind: 'LiteLLM', modelIdentifier: 'many',
    baseUrl: 'https://example.test', endpointPath: '/chat/completions', isEnabled: false,
    imageInput: { state: 'unsupported', reason: '上游明确不支持图片' },
    liteLlmCapabilities: { mode: 'chat', supportedFeatures: ['supports_function_calling', 'supports_reasoning',
      'supports_prompt_caching', 'supports_parallel_function_calling', 'supports_custom_feature'], contextWindow: 1000000, maxOutputTokens: 393216 } }]);
  const user = userEvent.setup();
  render(<ModelManagementPage />);
  await screen.findByRole('button', { name: 'Many' });
  const row = screen.getByRole('button', { name: 'Many' }).closest('tr')!;
  expect(row.querySelectorAll('.model-capability-tag')).toHaveLength(3);
  expect(within(row).queryByText('提示词缓存')).not.toBeInTheDocument();
  await user.click(within(row).getByRole('button', { name: '查看Many全部能力' }));
  const drawer = screen.getByRole('dialog');
  expect(within(drawer).getByText('上游明确不支持图片')).toBeInTheDocument();
  expect(within(drawer).getByText('1,000,000')).toBeInTheDocument();
  await user.click(within(drawer).getByText('高级协议能力 · 3 项'));
  expect(within(drawer).getByText('提示词缓存')).toBeVisible();
  expect(within(drawer).getByText('custom feature')).toBeVisible();
});

it('updates enabled state through the existing API without replacing the saved key', async () => {
  mocks.models.mockResolvedValue([{ id: 'toggle', name: 'Toggle', providerKind: 'Online', modelIdentifier: 'toggle',
    baseUrl: 'https://example.test', endpointPath: '/chat/completions', isEnabled: true }]);
  mocks.save.mockResolvedValue({});
  const user = userEvent.setup();
  render(<ModelManagementPage />);
  await user.click(await screen.findByRole('button', { name: '更多操作Toggle' }));
  await user.click(screen.getByRole('button', { name: '停用Toggle' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith('toggle', expect.objectContaining({ isEnabled: false, apiKey: '' })));
});

it('saves DeepSeek search key and department, role, and user grants', async () => {
  mocks.models.mockResolvedValue([]);
  mocks.users.mockResolvedValue({
    users: [{ id: 'user-1', name: '姚伟明', employeeNo: 'wh00028' }],
    roles: [{ id: 'role-1', name: '研发', code: 'developer' }],
    departments: [{ id: 'dept-1', name: '研发部', code: 'rd' }],
  });
  mocks.searchSettings.mockResolvedValue({ isEnabled: false, hasApiKey: false,
    grants: { userIds: [], roleIds: [], departmentIds: [] } });
  mocks.saveSearch.mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(<ModelManagementPage />);
  await user.click(screen.getByRole('button', { name: 'DeepSeek 搜索' }));
  await user.type(await screen.findByLabelText(/DeepSeek API Key/), 'sk-test');
  await user.click(screen.getByRole('switch', { name: /启用网页搜索/ }));
  expect(screen.getByRole('button', { name: '保存配置' })).toBeVisible();
  await user.click(screen.getByRole('tab', { name: /部门/ }));
  await user.type(screen.getByRole('searchbox', { name: '搜索授权部门' }), 'rd');
  await user.click(screen.getByRole('checkbox', { name: /研发部.*rd/ }));
  await user.click(screen.getByRole('tab', { name: /角色/  }));
  await user.type(screen.getByRole('searchbox', { name: '搜索授权角色' }), 'developer');
  await user.click(screen.getByRole('checkbox', { name: /研发.*developer/ }));
  await user.click(screen.getByRole('tab', { name: /用户/  }));
  await user.type(screen.getByRole('searchbox', { name: '搜索授权用户' }), 'wh');
  await user.click(screen.getByRole('checkbox', { name: /姚伟明.*wh00028/ }));
  await user.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(mocks.saveSearch).toHaveBeenCalledWith({ apiKey: 'sk-test', isEnabled: true,
    grants: { userIds: ['user-1'], roleIds: ['role-1'], departmentIds: ['dept-1'] } }));
});

it('syncs the LiteLLM catalog and reports the import summary', async () => {
  mocks.models.mockResolvedValue([]);
  mocks.sync.mockResolvedValue({ discovered: 2, created: 2, updated: 0, disabled: 0 });
  const user = userEvent.setup();
  render(<ModelManagementPage />);

  await user.click(screen.getByRole('button', { name: '同步 LiteLLM' }));
  await user.click(screen.getByRole('button', { name: '开始同步' }));

  await waitFor(() => expect(mocks.sync).toHaveBeenCalledWith());
  expect(await screen.findByText('LiteLLM 同步完成：发现 2，新增 2，更新 0，停用 0')).toBeInTheDocument();
});

it('saves an explicit image capability override from model management', async () => {
  mocks.models.mockResolvedValue([{ id: 'vision', name: 'Vision', providerKind: 'Local', modelIdentifier: 'alias',
    baseUrl: 'http://gpu.test/v1', endpointPath: '/chat/completions', authType: 'None', temperature: 0.3,
    sortOrder: 0, imageInputMode: 'Auto', imageInput: { state: 'unknown', reason: '未披露' } }]);
  mocks.save.mockResolvedValue({});
  const user = userEvent.setup();
  render(<ModelManagementPage />);
  await user.click(await screen.findByRole('button', { name: '编辑Vision' }));
  await user.click(screen.getByRole('combobox', { name: '图片理解' }));
  await user.click(screen.getByRole('option', { name: '支持图片' }));
  await user.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith('vision', expect.objectContaining({ imageInputMode: 'Supported' })));
});
