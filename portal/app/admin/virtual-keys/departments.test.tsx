import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import VirtualKeysPage from './page';
import * as api from '../../lib/api-client';

vi.mock('../../lib/api-client', () => ({
  getManagedVirtualKeys: vi.fn(async () => [{ id: 'key-1', alias: '研发 Key', isEnabled: true, createdAt: '2026-10-08T00:00:00Z' }]),
  getVirtualKeyOrganizations: vi.fn(async () => [{ id: 'legacy-1', name: '旧分组', userIds: ['user-1'] }]),
  getVirtualKeyGrantOptions: vi.fn(async () => ({ users: [{ id: 'user-1', name: '测试员工', employeeNo: 'wh00028' }], roles: [{ id: 'role-1', name: '研发角色', code: 'developer' }], departments: [{ id: 'dept-1', name: '研发部', code: 'rd' }] })),
  getVirtualKeyGrants: vi.fn(async () => ({ userIds: [], departmentIds: [], organizationIds: ['legacy-1'] })),
  saveVirtualKeyGrants: vi.fn(async () => {}),
}));

describe('virtual key department authorization', () => {
  it('uses existing departments and preserves legacy group users when saving the new scope', async () => {
    const user = userEvent.setup(); render(<VirtualKeysPage />);
    await user.click(await screen.findByRole('button', { name: /^授权/ }));
    expect(screen.queryByRole('tab', { name: /组织/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '部门管理' })).toHaveAttribute('href', '/admin/departments');
    await user.click(screen.getByRole('tab', { name: /角色/ }));
    await user.click(screen.getByRole('checkbox', { name: /研发角色/ }));
    await user.click(screen.getByRole('tab', { name: /部门/ }));
    await user.type(screen.getByRole('searchbox', { name: '搜索授权部门' }), '研发');
    await user.click(await screen.findByRole('checkbox', { name: /研发部/ }));
    await user.click(screen.getByRole('button', { name: '保存授权' }));
    await waitFor(() => expect(api.saveVirtualKeyGrants).toHaveBeenCalledWith('key-1', { userIds: ['user-1'], departmentIds: ['dept-1'], roleIds: ['role-1'], organizationIds: [] }));
  });
});
