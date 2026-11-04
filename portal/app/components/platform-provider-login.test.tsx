import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlatformProvider, usePlatform } from './platform-provider';

const mocks = vi.hoisted(() => ({ users: vi.fn(), saveUser: vi.fn() }));
vi.mock('../lib/api-client', () => ({
  hasBackend: true,
  getUsers: mocks.users,
  saveUser: mocks.saveUser,
  getDepartments: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 100, total: 0 }),
  getRoles: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 100, total: 0 }),
  getCategories: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 100, total: 0 }),
  getPermissions: vi.fn().mockResolvedValue([]),
}));

function LoginProbe() {
  const { currentUserId, users, notice, dispatch } = usePlatform();
  return <>
    <button type="button" onClick={() => {
      localStorage.setItem('aigc_hub_access_token', 'token');
      localStorage.setItem('aigc_hub_user', JSON.stringify({ id: 'user-1', employeeNo: 'wh00028', name: '姚伟明', roles: ['平台管理员'], permissions: ['user.manage'] }));
      void dispatch({ type: 'login', employeeNo: 'wh00028' });
    }}>后端登录成功</button>
    <button type="button" onClick={() => { void dispatch({ type: 'save-user', user: { id: 'user-1', name: '姚伟明', employeeNo: 'wh00028', email: 'a@b.test', department: '', role: '普通用户', status: '启用', lastLogin: '刚刚' } }); }}>保存用户</button>
    <span>{currentUserId}</span>
    <span>{users.map(user => user.name).join(',')}</span>
    <span>{notice}</span>
  </>;
}

it('loads backend users after login instead of rejecting an empty local list', async () => {
  localStorage.clear();
  mocks.users.mockResolvedValue({ items: [{ id: 'user-1', employeeNo: 'wh00028', name: '姚伟明', email: 'admin@example.test', department: '数字化办公室', roles: [{ name: '平台管理员' }], isEnabled: true }], page: 1, pageSize: 100, total: 1 });
  const user = userEvent.setup();
  render(<PlatformProvider><LoginProbe /></PlatformProvider>);
  await user.click(screen.getByRole('button', { name: '后端登录成功' }));
  expect(await screen.findByText('user-1')).toBeInTheDocument();
  expect(screen.getByText('姚伟明')).toBeInTheDocument();
  expect(screen.queryByText('账号不存在或已停用')).not.toBeInTheDocument();
  localStorage.clear();
});

it('confirms a save with one sentence and retires the notice on its own', async () => {
  localStorage.clear();
  mocks.users.mockResolvedValue({ items: [{ id: 'user-1', employeeNo: 'wh00028', name: '姚伟明', email: 'admin@example.test', department: '数字化办公室', roles: [{ name: '平台管理员' }], isEnabled: true }], page: 1, pageSize: 100, total: 1 });
  mocks.saveUser.mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(<PlatformProvider><LoginProbe /></PlatformProvider>);
  await user.click(screen.getByRole('button', { name: '后端登录成功' }));
  await user.click(await screen.findByRole('button', { name: '保存用户' }));
  // The confirmation names the outcome, not the storage engine behind it.
  expect(await screen.findByText('保存成功')).toBeInTheDocument();
  expect(screen.queryByText(/PostgreSQL/u)).not.toBeInTheDocument();
  // A floating notice that never leaves covers the admin surface, so it retires itself.
  await waitFor(() => expect(screen.queryByText('保存成功')).not.toBeInTheDocument(), { timeout: 6000 });
  localStorage.clear();
});
