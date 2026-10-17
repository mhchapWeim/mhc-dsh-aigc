import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LoginPage from './local/page';
import AutoLoginPage from './page';
import { safeLoginReturnTo } from '../lib/login-return';

const mocks = vi.hoisted(() => {
  const replace = vi.fn();
  return { dispatch: vi.fn(async () => {}), replace, router: { replace }, config: vi.fn(), complete: vi.fn(), login: vi.fn(), save: vi.fn(), redirect: vi.fn() };
});
vi.mock('../components/platform-provider', () => ({ usePlatform: () => ({ dispatch: mocks.dispatch, notice: '', users: [] }) }));
vi.mock('next/navigation', () => ({ useRouter: () => mocks.router }));
vi.mock('../lib/api-client', () => ({
  hasBackend: true, getPortalSsoConfig: mocks.config, completePortalSso: mocks.complete,
  loginBackend: mocks.login, saveSession: mocks.save,
  redirectPortalSso: mocks.redirect,
  portalSsoStartUrl: (path: string) => `/api/auth/sso/start?${new URLSearchParams({ returnTo: path })}`,
}));
const session = { accessToken: 'jwt-token', expiresAt: '2099-01-01T00:00:00Z', user: { id: 'user-1', employeeNo: 'wh00028', name: '测试用户', roles: [], permissions: ['portal.view'] } };
beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/login');
  mocks.config.mockResolvedValue({ enabled: true });
  mocks.complete.mockResolvedValue(session);
  mocks.login.mockResolvedValue(session);
});

it('offers 企业 SSO alongside the existing password login', async () => {
  window.history.replaceState({}, '', '/login?returnTo=%2Fadmin%2Fmodels');
  render(<LoginPage />);
  expect(await screen.findByRole('link', { name: '使用 企业 SSO 登录' })).toHaveAttribute('href', '/api/auth/sso/start?returnTo=%2Fadmin%2Fmodels');
  expect(screen.getByLabelText('企业工号')).toBeInTheDocument();
  expect(screen.getByLabelText('密码')).toBeInTheDocument();
});

it('automatically redirects the default login route to 企业 SSO once', async () => {
  window.history.replaceState({}, '', '/login?returnTo=%2Fadmin%2Fmodels');
  render(<StrictMode><AutoLoginPage /></StrictMode>);
  await waitFor(() => expect(mocks.redirect).toHaveBeenCalledWith('/admin/models'));
  expect(mocks.redirect).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText('密码')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: '使用工号密码登录' })).toHaveAttribute('href', '/login/local?returnTo=%2Fadmin%2Fmodels');
});

it.each(['query', 'session'] as const)('stays signed out after explicit logout using %s state', async (kind) => {
  if (kind === 'query') window.history.replaceState({}, '', '/login?sso=logged-out');
  else window.sessionStorage.setItem('aigc-explicit-logout', '1');
  render(<StrictMode><AutoLoginPage /></StrictMode>);
  await screen.findByText('已退出中台登录。再次进入请点击 企业 SSO 登录。');
  await screen.findByRole('link', { name: '使用 企业 SSO 登录' });
  expect(mocks.redirect).not.toHaveBeenCalled();
  expect(mocks.complete).not.toHaveBeenCalled();
});

it('does not automatically redirect the local login route', async () => {
  window.history.replaceState({}, '', '/login/local');
  render(<LoginPage />);
  await screen.findByRole('link', { name: '使用 企业 SSO 登录' });
  expect(mocks.redirect).not.toHaveBeenCalled();
  expect(screen.getByLabelText('密码')).toBeInTheDocument();
});

it('completes the default SSO callback without starting another SSO flow', async () => {
  window.history.replaceState({}, '', '/login?sso=complete&returnTo=%2Fapps');
  render(<AutoLoginPage />);
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/apps'));
  expect(mocks.redirect).not.toHaveBeenCalled();
  expect(mocks.complete).toHaveBeenCalledOnce();
});

it('keeps an explicit local login link when default SSO is unavailable', async () => {
  mocks.config.mockRejectedValue(new Error('offline'));
  render(<AutoLoginPage />);
  expect(await screen.findByRole('status')).toHaveTextContent('企业 SSO 服务暂时不可用');
  expect(screen.getByRole('link', { name: '使用工号密码登录' })).toHaveAttribute('href', '/login/local?returnTo=%2F');
  expect(mocks.redirect).not.toHaveBeenCalled();
});

it('completes one SSO exchange under React StrictMode and returns to the protected page', async () => {
  window.history.replaceState({}, '', '/login?sso=complete&returnTo=%2Fadmin%2Fmodels');
  render(<StrictMode><LoginPage /></StrictMode>);
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/admin/models'));
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(mocks.save).toHaveBeenCalledWith(session);
  expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'login', employeeNo: 'wh00028' });
});

it('keeps password login usable when SSO configuration is unavailable', async () => {
  mocks.config.mockRejectedValue(new Error('offline'));
  render(<LoginPage />);
  fireEvent.change(screen.getByLabelText('企业工号'), { target: { value: 'wh00028' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password' } });
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/'));
  expect(mocks.login).toHaveBeenCalledWith('wh00028', 'password');
});

it('shows callback failure without saving credentials or looping back to SSO', async () => {
  window.history.replaceState({}, '', '/login?sso=failed');
  render(<LoginPage />);
  expect(await screen.findByRole('status')).toHaveTextContent('企业 SSO 登录失败');
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});

it('allows a new login after an expired completion result', async () => {
  window.history.replaceState({}, '', '/login?sso=complete');
  mocks.complete.mockRejectedValue(new Error('SSO 登录结果已过期，请重试'));
  render(<LoginPage />);
  await screen.findByText('SSO 登录结果已过期，请重试');
  await waitFor(() => expect(screen.getByRole('button', { name: '登录' })).toBeEnabled());
  expect(mocks.save).not.toHaveBeenCalled();
});

it.each(['//evil.example', '/\\evil.example', '/%2f%2fevil.example', '/\t/evil.example', '/login', '/%'])('rejects unsafe return destinations: %s', input => {
  expect(safeLoginReturnTo(input)).toBe('/');
});
