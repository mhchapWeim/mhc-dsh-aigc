import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { PasswordChangeForm } from './password-change-form';
const api = vi.hoisted(() => ({ self: vi.fn(), admin: vi.fn() }));
vi.mock('../lib/api-client', () => ({ changeMyPassword: api.self, resetUserPassword: api.admin }));
beforeEach(() => { api.self.mockReset().mockResolvedValue(undefined); api.admin.mockReset().mockResolvedValue(undefined); });

it('validates confirmation, changes the current user password and clears password inputs', async () => {
  render(<PasswordChangeForm />);
  fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'old-password' } });
  fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'new-password' } });
  fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'mismatched' } });
  fireEvent.click(screen.getByRole('button', { name: '保存密码' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('两次输入'); expect(api.self).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'new-password' } });
  fireEvent.click(screen.getByRole('button', { name: '保存密码' }));
  await waitFor(() => expect(api.self).toHaveBeenCalledWith('old-password', 'new-password'));
  expect(await screen.findByRole('status')).toHaveTextContent('密码已修改');
  expect(screen.getByLabelText('新密码')).toHaveValue('');
});

it('lets administrators reset the selected user and displays backend failures', async () => {
  api.admin.mockRejectedValueOnce(new Error('当前账号没有权限'));
  render(<PasswordChangeForm userId="user-2" />);
  expect(screen.queryByLabelText('当前密码')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'reset-password' } });
  fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'reset-password' } });
  fireEvent.click(screen.getByRole('button', { name: '保存密码' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('当前账号没有权限');
  expect(api.admin).toHaveBeenCalledWith('user-2', 'reset-password'); expect(api.self).not.toHaveBeenCalled();
});
