import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import Page from './page';

const mocks = vi.hoisted(() => ({ save: vi.fn(), options: vi.fn() }));
vi.mock('../../components/platform-provider', () => ({ usePlatform: () => ({ users: [], departments: [], roles: [], notice: '', dispatch: mocks.save }) }));
vi.mock('../../lib/api-client', () => ({ hasBackend: true, getUserAccessOptions: mocks.options }));
beforeEach(() => {
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.options.mockReset().mockResolvedValue({ departments: [{ id: 'd1', name: '研发部' }], roles: [{ id: 'r1', name: '普通用户' }],
    models: [{ id: 'm1', name: 'GLM Flash', isEnabled: true, selected: false, inherited: true }],
    virtualKeys: [{ id: 'k1', name: '研发套餐', isEnabled: true, selected: false, inherited: true }, { id: 'k2', name: '另一组', isEnabled: true, selected: false, inherited: false }] });
});

it('starts without a department and saves model and Key selection together with the user', async () => {
  const user = userEvent.setup(); render(<Page />);
  await user.click(screen.getByRole('button', { name: '新增用户' }));
  await screen.findByRole('combobox', { name: '模型选择' });
  expect(screen.getByRole('combobox', { name: '部门' })).toHaveTextContent('未分配部门');
  expect(screen.getByRole('option', { name: '另一组' })).toBeDisabled();
  await user.type(screen.getByRole('textbox', { name: /姓名/ }), '新员工');
  await user.type(screen.getByRole('textbox', { name: /工号/ }), 'wh00999');
  await user.type(screen.getByRole('textbox', { name: /企业邮箱/ }), 'new@example.test');
  await user.click(screen.getByRole('combobox', { name: '模型选择' }));
  await user.click(screen.getByRole('option', { name: /GLM Flash/ }));
  await user.selectOptions(screen.getByRole('combobox', { name: '虚拟 Key 组' }), 'k1');
  await user.click(screen.getByRole('button', { name: '保存用户' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ type: 'save-user', user: expect.objectContaining({ department: '', modelIds: ['m1'], virtualKeyIds: ['k1'], roleIds: ['r1'] }) }));
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
  expect(screen.getByRole('option', { name: '另一组' })).toBeEnabled();
  await user.click(screen.getByRole('combobox', { name: '角色' }));
  await user.click(screen.getByRole('option', { name: '研发角色' }));
  expect(screen.getByRole('option', { name: '另一组' })).toBeDisabled();
  expect(screen.getByText('已通过部门、角色或分组归属：研发套餐')).toBeVisible();
  await user.click(screen.getByRole('combobox', { name: '角色' }));
  await user.click(screen.getByRole('option', { name: '普通用户' }));
  expect(screen.getByRole('option', { name: '另一组' })).toBeEnabled();
});
