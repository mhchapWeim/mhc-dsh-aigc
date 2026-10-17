import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AuthGuard } from './auth-guard';
import { useEffect } from 'react';

const state = vi.hoisted(() => ({ path: '/admin/users', replace: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => state.path, useRouter: () => ({ replace: state.replace }) }));
vi.mock('../lib/api-client', () => ({ hasBackend: true }));
vi.mock('./platform-provider', () => ({ usePlatform: () => ({ currentUserId: '' }) }));
beforeEach(() => { localStorage.clear(); state.replace.mockClear(); state.path = '/admin/users'; window.history.replaceState({}, '', '/admin/users?query=test'); });

it('redirects anonymous users without rendering protected content and retains their destination', async () => {
  render(<AuthGuard><div>protected content</div></AuthGuard>);
  expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  await waitFor(() => expect(state.replace).toHaveBeenCalledWith('/login?returnTo=%2Fadmin%2Fusers%3Fquery%3Dtest'));
});

it('allows signed-in users and hides content when their session expires', async () => {
  localStorage.setItem('aigc_hub_access_token', 'test-token');
  render(<AuthGuard><div>protected content</div></AuthGuard>);
  expect(await screen.findByText('protected content')).toBeInTheDocument();
  localStorage.clear();
  fireEvent(window, new Event('aigc-session-expired'));
  expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  expect(state.replace).toHaveBeenCalled();
});

it('keeps the landing page and login page public', () => {
  state.path = '/login';
  render(<AuthGuard><div>login form</div></AuthGuard>);
  expect(screen.getByText('login form')).toBeInTheDocument();
  expect(state.replace).not.toHaveBeenCalled();
});

it('keeps the authenticated layout mounted while switching protected routes', async () => {
  localStorage.setItem('aigc_hub_access_token', 'test-token');
  const mounted = vi.fn();
  function LayoutProbe() {
    useEffect(() => { mounted(); }, []);
    return <div>persistent sidebar</div>;
  }
  const view = render(<AuthGuard><LayoutProbe /></AuthGuard>);
  await screen.findByText('persistent sidebar');
  state.path = '/admin/models';
  window.history.replaceState({}, '', '/admin/models');
  view.rerender(<AuthGuard><LayoutProbe /></AuthGuard>);
  expect(screen.getByText('persistent sidebar')).toBeInTheDocument();
  expect(screen.queryByText('正在验证登录状态…')).not.toBeInTheDocument();
  await waitFor(() => expect(mounted).toHaveBeenCalledTimes(1));
});
