import { selectDropdown } from '../../../test/select-dropdown';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import Page from './page';
import type { PlatformUser } from '../../lib/platform-state';

const mocks = vi.hoisted(() => ({ save: vi.fn(), options: vi.fn(), quotas: vi.fn(), users: [] as PlatformUser[] }));
vi.mock('../../components/platform-provider', () => ({ usePlatform: () => ({ users: mocks.users, departments: [], roles: [], notice: '', dispatch: mocks.save }) }));
vi.mock('../../lib/api-client', () => ({ hasBackend: true, getUserTokenQuotas: mocks.quotas, getUserAccessOptions: mocks.options,
  getBillingPlanOptions: () => Promise.resolve([
    { id: 'plan-1', name: '标准', weeklyTokens: 1_000_000, isEnabled: true },
  ]) }));
beforeEach(() => {
  mocks.users = [];
  mocks.quotas.mockReset().mockResolvedValue({});
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.options.mockReset().mockResolvedValue({ departments: [{ id: 'd1', name: '研发部' }], roles: [{ id: 'r1', name: '普通用户' }],
    plugins: [{ id: 'p1', name: '搜索插件', isEnabled: true, selected: false, inherited: false }],
    releases: [{ id: 'v1', name: '0.1.7 · win32/x64', isEnabled: true, selected: false, inherited: false }],
    mcps: [{ id: 'c1', name: '知识库 MCP', isEnabled: true, selected: false, inherited: false }],
    models: [{ id: 'm1', name: 'GLM Flash', isEnabled: true, selected: false, inherited: true }],
    virtualKeys: [{ id: 'k1', name: '研发套餐', isEnabled: true, selected: false, inherited: true }, { id: 'k2', name: '另一组', isEnabled: true, selected: false, inherited: false }] });
});

it('saves Key and resources without requiring a separate model selection', async () => {
  const user = userEvent.setup(); render(<Page />);
  await user.click(screen.getByRole('button', { name: '新增用户' }));
  await screen.findByRole('combobox', { name: '虚拟 Key 组' });
  expect(screen.queryByRole('combobox', { name: '模型选择' })).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: '部门' })).toHaveTextContent('未分配部门');
  fireEvent.click(screen.getByRole('combobox', { name: '虚拟 Key 组' }));
  expect(screen.getByRole('option', { name: '另一组' })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('searchbox', { name: '搜索虚拟 Key 组' }), { key: 'Escape' });
  await user.type(screen.getByRole('textbox', { name: /姓名/ }), '新员工');
  await user.type(screen.getByRole('textbox', { name: /工号/ }), 'wh00999');
  await user.type(screen.getByRole('textbox', { name: /企业邮箱/ }), 'new@example.test');
  for (const [label, option] of [['插件选择', '搜索插件'], ['版本选择', '0.1.7 · win32/x64'], ['MCP选择', '知识库 MCP']]) {
    await user.click(screen.getByRole('combobox', { name: label }));
    await user.click(screen.getByRole('option', { name: option }));
  }
  expect(screen.getByRole('checkbox', {name: /允许 DSH 自定义模型/})).not.toBeChecked();
  await user.click(screen.getByRole('checkbox', {name: /允许 DSH 自定义模型/}));
  selectDropdown(screen.getByRole('combobox', { name: '虚拟 Key 组' }), 'k1');
  await user.click(screen.getByRole('button', { name: '保存用户' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ type: 'save-user', user: expect.objectContaining({ allowCustomModels: true, department: '', pluginIds: ['p1'], releaseIds: ['v1'], mcpIds: ['c1'], virtualKeyIds: ['k1'], roleIds: ['r1'] }) }));
});

it('blocks saving when access options cannot load', async () => {
  mocks.options.mockRejectedValueOnce(new Error('授权选项读取失败'));
  render(<Page />); fireEvent.click(screen.getByRole('button', { name: '新增用户' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('授权选项读取失败');
  expect(screen.getByRole('button', { name: '保存用户' })).toBeDisabled();
  expect(mocks.save).not.toHaveBeenCalled();
});

it('updates inherited Key choices immediately when the draft role changes', async () => {
  mocks.options.mockResolvedValueOnce({ departments: [], roles: [{ id: 'r1', name: '普通用户' }, { id: 'r2', name: '研发角色' }], models: [],
    virtualKeys: [{ id: 'k1', name: '研发套餐', isEnabled: true, selected: false, inherited: false, roleIds: ['r2'], departmentIds: [] },
      { id: 'k2', name: '另一组', isEnabled: true, selected: false, inherited: false, roleIds: [], departmentIds: [] }] });
  const user = userEvent.setup(); render(<Page />);
  await user.click(screen.getByRole('button', { name: '新增用户' }));
  await screen.findByRole('combobox', { name: '虚拟 Key 组' });
  fireEvent.click(screen.getByRole('combobox', { name: '虚拟 Key 组' }));
  expect(screen.getByRole('option', { name: '另一组' })).toBeEnabled();
  fireEvent.keyDown(screen.getByRole('searchbox', { name: '搜索虚拟 Key 组' }), { key: 'Escape' });
  await user.click(screen.getByRole('combobox', { name: '角色' }));
  await user.click(screen.getByRole('option', { name: '研发角色' }));
  fireEvent.click(screen.getByRole('combobox', { name: '虚拟 Key 组' }));
  expect(screen.getByRole('option', { name: '另一组' })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('searchbox', { name: '搜索虚拟 Key 组' }), { key: 'Escape' });
  expect(screen.getByText('已通过部门、角色或分组归属：研发套餐')).toBeVisible();
  await user.click(screen.getByRole('combobox', { name: '角色' }));
  await user.click(screen.getByRole('option', { name: '普通用户' }));
  fireEvent.click(screen.getByRole('combobox', { name: '虚拟 Key 组' }));
  expect(screen.getByRole('option', { name: '另一组' })).toBeEnabled();
  fireEvent.keyDown(screen.getByRole('searchbox', { name: '搜索虚拟 Key 组' }), { key: 'Escape' });
});

it('loads existing resource selections for editing and saves removals', async () => {
  mocks.users = [{ id: 'existing', name: '现有员工', employeeNo: 'wh001', email: 'old@example.test', department: '', role: '普通用户', status: '启用', lastLogin: '尚未登录' }];
  const options = await mocks.options();
  for (const key of ['plugins', 'releases', 'mcps']) options[key][0].selected = true;
  mocks.options.mockResolvedValue(options);
  const user = userEvent.setup(); render(<Page />);
  await user.click(screen.getByRole('button', { name: '编辑现有员工' }));
  await waitFor(() => expect(screen.getByRole('combobox', { name: '插件选择' })).toHaveTextContent('搜索插件'));
  expect(mocks.options).toHaveBeenCalledWith('existing');
  for (const [label, option] of [['插件选择', '搜索插件'], ['版本选择', '0.1.7 · win32/x64'], ['MCP选择', '知识库 MCP']]) {
    await user.click(screen.getByRole('combobox', { name: label }));
    await user.click(screen.getByRole('option', { name: option }));
  }
  await user.click(screen.getByRole('button', { name: '保存用户' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ type: 'save-user', user: expect.objectContaining({ id: 'existing', pluginIds: [], releaseIds: [], mcpIds: [] }) }));
});

it('shows current cycle quota and retries a failed refresh', async () => {
  mocks.users = [{ id: 'u1', name: '张三', employeeNo: '001', email: 'test@example.com', department: '研发', role: '普通用户', status: '启用', lastLogin: '今天' }];
  const quota = { assigned: true, planName: '标准配方', source: 'Department', total: 1250, used: 300, remaining: 950, resetsAt: '2026-11-08T16:00:00Z' };
  mocks.quotas.mockResolvedValueOnce({ u1: quota }).mockRejectedValueOnce(new Error('网络错误')).mockResolvedValueOnce({ u1: { ...quota, used: 400, remaining: 850 } });
  render(<Page />);
  expect(await screen.findByText('1,250')).toBeVisible();
  expect(screen.getByText('300')).toBeVisible();
  expect(screen.getByText('950')).toBeVisible();
  expect(screen.getByText('标准配方 · 部门继承')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '刷新流量' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('网络错误');
  expect(screen.queryByText('950')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '刷新流量' }));
  expect(await screen.findByText('850')).toBeVisible();
  expect(mocks.quotas).toHaveBeenLastCalledWith(['u1']);
});

it('confirms user deletion and cancelling does not dispatch deletion', async () => {
  mocks.users = [{ id: 'u1', name: '张三', employeeNo: '001', email: 'test@example.com', department: '', role: '普通用户', status: '启用', lastLogin: '今天' }];
  const user = userEvent.setup(); render(<Page />);
  await user.click(screen.getByRole('button', { name: '删除张三' }));
  expect(mocks.save).not.toHaveBeenCalled();
  await user.click(await screen.findByRole('button', { name: /取\s*消/ }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '确认删除' })).not.toBeInTheDocument());
  expect(mocks.save).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '删除张三' }));
  await user.click(await screen.findByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ type: 'delete-user', id: 'u1' }));
});
