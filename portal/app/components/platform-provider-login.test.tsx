import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlatformProvider, usePlatform } from './platform-provider';

const mocks = vi.hoisted(() => ({ users: vi.fn() }));
vi.mock('../lib/api-client', () => ({
  hasBackend: true,
  getUsers: mocks.users,
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
