import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import Page from './page';
const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock('../../components/platform-provider', () => ({ usePlatform: () => ({
  departments: [{ id: 'empty', name: '空部门', manager: '', description: '', enabled: true }, { id: 'used', name: '有成员部门', manager: '', description: '', enabled: true }],
  users: [{ id: 'u1', department: '有成员部门' }], dispatch: mocks.dispatch, notice: '',
}) }));
vi.mock('../../lib/api-client', () => ({ hasBackend: false, getBillingPlanOptions: vi.fn() }));
beforeEach(() => mocks.dispatch.mockReset().mockResolvedValue(undefined));
it('blocks populated departments and confirms empty department deletion', async () => {
  const user = userEvent.setup(); render(<Page />);
  const blocked = screen.getByRole('button', { name: '删除有成员部门' });
  expect(blocked).toBeDisabled();
  expect(blocked).toHaveAccessibleDescription('部门仍有 1 位用户，请先转移用户后再删除');
  await user.hover(blocked.parentElement!);
  expect(await screen.findByRole('tooltip')).toHaveTextContent('部门仍有 1 位用户，请先转移用户后再删除');
  await user.click(screen.getByRole('button', { name: '删除空部门' }));
  expect(mocks.dispatch).not.toHaveBeenCalled();
  await user.click(await screen.findByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'delete-department', id: 'empty' }));
});
