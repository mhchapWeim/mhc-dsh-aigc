import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import VirtualKeysPage from './page';

const api = vi.hoisted(() => ({
  getManagedVirtualKeys: vi.fn(), getVirtualKeyOrganizations: vi.fn(), getVirtualKeyGrantOptions: vi.fn(),
  getVirtualKeyModels: vi.fn(), getVirtualKeyPolicy: vi.fn(), updateVirtualKeyPolicy: vi.fn(),
  getVirtualKeyGrants: vi.fn(), createManagedVirtualKey: vi.fn(), saveVirtualKeyGrants: vi.fn(), setManagedVirtualKeyEnabled: vi.fn(),
}));
vi.mock('../../lib/api-client', () => api);
beforeEach(() => {
  vi.resetAllMocks();
  api.getManagedVirtualKeys.mockResolvedValue([{ id: 'key-1', alias: '研发 Key', isEnabled: true, createdAt: '2026-10-20T00:00:00Z' }]);
  api.getVirtualKeyOrganizations.mockResolvedValue([]);
  api.getVirtualKeyGrantOptions.mockResolvedValue({ users: [
    { id: 'occupied', name: '张三', employeeNo: 'w001', disabled: true, disabledReason: '已在“业务组”组（直接授权）' },
    { id: 'available', name: '李四', employeeNo: 'w002' },
  ], roles: [], departments: [] });
  api.getVirtualKeyModels.mockResolvedValue(['glm-5.3-flash', 'deepseek-flash']);
  api.getVirtualKeyPolicy.mockResolvedValue({ models: ['glm-5.3-flash'], allModels: false, maxBudget: 50,
    budgetDuration: '30d', rpmLimit: 10, tpmLimit: 20000, expires: '2030-01-01T00:00:00Z' });
  api.getVirtualKeyGrants.mockResolvedValue({ userIds: [], departmentIds: [], roleIds: [], organizationIds: [] });
  api.createManagedVirtualKey.mockResolvedValue({});
  api.updateVirtualKeyPolicy.mockResolvedValue({});
  api.saveVirtualKeyGrants.mockResolvedValue(undefined);
});

it('creates a key with the selected model and common plan parameters', async () => {
  const user = userEvent.setup(); render(<VirtualKeysPage />);
  await user.click(await screen.findByRole('button', { name: '创建 Key' }));
  await user.type(await screen.findByLabelText('别名'), '研发套餐');
  await user.click(screen.getByRole('checkbox', { name: 'glm-5.3-flash' }));
  await user.type(screen.getByLabelText('预算上限（美元）'), '0');
  await user.type(screen.getByLabelText('预算重置周期'), '30d');
  await user.type(screen.getByLabelText('每分钟请求数（RPM）'), '10');
  await user.type(screen.getByLabelText('每分钟 Token 数（TPM）'), '20000');
  await user.selectOptions(screen.getByLabelText('有效期'), 'duration');
  await user.type(screen.getByLabelText('有效时长'), '90d');
  await user.click(screen.getByRole('button', { name: '创建并同步' }));
  await waitFor(() => expect(api.createManagedVirtualKey).toHaveBeenCalledWith('研发套餐', '', {
    models: ['glm-5.3-flash'], allModels: false, maxBudget: 0, budgetDuration: '30d', rpmLimit: 10,
    tpmLimit: 20000, duration: '90d', clearExpiry: false,
  }));
});

it('loads current gateway values and keeps expiry unchanged when editing a limit', async () => {
  const user = userEvent.setup(); render(<VirtualKeysPage />);
  await user.click(await screen.findByRole('button', { name: /^套餐规则/ }));
  expect(await screen.findByLabelText('预算上限（美元）')).toHaveValue(50);
  expect(screen.getByLabelText('有效期')).toHaveValue('keep');
  await user.clear(screen.getByLabelText('每分钟请求数（RPM）'));
  await user.type(screen.getByLabelText('每分钟请求数（RPM）'), '20');
  await user.click(screen.getByRole('button', { name: '保存并同步' }));
  await waitFor(() => expect(api.updateVirtualKeyPolicy).toHaveBeenCalledWith('key-1', expect.objectContaining({
    models: ['glm-5.3-flash'], maxBudget: 50, budgetDuration: '30d', rpmLimit: 20, duration: null, clearExpiry: false,
  })));
});

it('disables occupied users, displays their group and excludes them from select-all', async () => {
  const user = userEvent.setup(); render(<VirtualKeysPage />);
  await user.click(await screen.findByRole('button', { name: /^授权/ }));
  expect(await screen.findByRole('checkbox', { name: /张三/ })).toBeDisabled();
  expect(screen.getByText('已在“业务组”组（直接授权）')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '全选' }));
  expect(screen.getByRole('checkbox', { name: /李四/ })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /张三/ })).not.toBeChecked();
  await user.click(screen.getByRole('button', { name: '保存授权' }));
  await waitFor(() => expect(api.saveVirtualKeyGrants).toHaveBeenCalledWith('key-1', {
    userIds: ['available'], departmentIds: [], roleIds: [], organizationIds: [],
  }));
  expect(api.getVirtualKeyGrantOptions).toHaveBeenCalledWith('key-1');
});

it('shows synchronization failures inside the open form without claiming success', async () => {
  api.updateVirtualKeyPolicy.mockRejectedValue(new Error('LiteLLM 同步失败'));
  const user = userEvent.setup(); render(<VirtualKeysPage />);
  await user.click(await screen.findByRole('button', { name: /^套餐规则/ }));
  await user.click(await screen.findByRole('button', { name: '保存并同步' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('LiteLLM 同步失败');
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(screen.queryByText('套餐规则已同步到 LiteLLM。')).not.toBeInTheDocument();
});

it('keeps conflicting existing selections removable and displays server conflict errors in the dialog', async () => {
  api.getVirtualKeyGrants.mockResolvedValue({ userIds: ['occupied'], departmentIds: [], roleIds: [], organizationIds: [] });
  api.saveVirtualKeyGrants.mockRejectedValue(new Error('张三已在业务组'));
  const user = userEvent.setup(); render(<VirtualKeysPage />);
  await user.click(await screen.findByRole('button', { name: /^授权/ }));
  expect(await screen.findByRole('checkbox', { name: /张三/ })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: '保存授权' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('张三已在业务组');
  await user.click(screen.getByRole('checkbox', { name: /张三/ }));
  expect(screen.getByRole('checkbox', { name: /张三/ })).not.toBeChecked();
});
