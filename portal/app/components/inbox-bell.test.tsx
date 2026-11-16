import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InboxBell } from './inbox-bell';
import * as api from '../lib/api-client';

vi.mock('next/link', () => ({ default: (props: React.ComponentProps<'a'>) => <a {...props} /> }));
vi.mock('../lib/api-client', () => ({
  hasBackend: true,
  getInboxUnread: vi.fn(),
  getInboxMessages: vi.fn(),
  markInboxRead: vi.fn(),
  markInboxAllRead: vi.fn(),
}));

const message = (id: string, overrides: Partial<api.InboxMessage> = {}): api.InboxMessage => ({
  id, title: `消息 ${id}`, content: `内容 ${id}`, link: '/admin/reviews', isRead: false,
  createdAt: '2026-11-09T04:00:00Z', ...overrides,
});

beforeEach(() => { localStorage.setItem('aigc_hub_access_token', 'token'); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); localStorage.clear(); vi.restoreAllMocks(); });

it('does not fire a banner for messages that were already waiting at mount', async () => {
  const waiting = [message('old-1'), message('old-2')];
  vi.mocked(api.getInboxMessages).mockResolvedValue({ items: waiting, page: 1, pageSize: 20, total: 2, unreadCount: 2 });
  vi.mocked(api.getInboxUnread).mockResolvedValue({ unread: 2, latest: waiting[0] });
  render(<InboxBell />);

  // The badge reports the backlog, but the screen stays quiet: a reviewer should
  // not be hit by a stack of banners for work that has been pending for days.
  await waitFor(() => expect(screen.getByRole('button', { name: '通知' })).toHaveTextContent('2'));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('raises a prominent banner for a newly arrived task and retires it after five seconds', async () => {
  // The poll and the banner lifetime are both timers, so the whole test owns the clock.
  vi.useFakeTimers();
  const first = [message('seen', { isRead: true })];
  vi.mocked(api.getInboxMessages).mockResolvedValue({ items: first, page: 1, pageSize: 20, total: 1, unreadCount: 0 });
  vi.mocked(api.getInboxUnread).mockResolvedValue({ unread: 0, latest: null });
  const view = render(<InboxBell />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(api.getInboxMessages).toHaveBeenCalledTimes(1);

  const arrived = message('fresh', { title: '新的应用发布申请：设备助手' });
  vi.mocked(api.getInboxMessages).mockResolvedValue({ items: [arrived, ...first], page: 1, pageSize: 20, total: 2, unreadCount: 1 });
  vi.mocked(api.getInboxUnread).mockResolvedValue({ unread: 1, latest: arrived });

  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const banner = screen.getByRole('alert');
  expect(banner).toHaveTextContent('新的应用发布申请：设备助手');
  expect(banner.querySelector('.inbox-popup__timer')).not.toBeNull();

  await act(async () => { await vi.advanceTimersByTimeAsync(5_400); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.queryByRole('alert')).toBeNull();
  view.unmount();
  vi.useRealTimers();
});

it('opens the panel, shows real messages and marks everything read', async () => {
  const unread = [message('a'), message('b')];
  vi.mocked(api.getInboxMessages).mockResolvedValue({ items: unread, page: 1, pageSize: 20, total: 2, unreadCount: 2 });
  vi.mocked(api.getInboxUnread).mockResolvedValue({ unread: 2, latest: unread[0] });
  const user = userEvent.setup();
  render(<InboxBell />);
  await waitFor(() => expect(screen.getByRole('button', { name: '通知' })).toHaveTextContent('2'));

  await user.click(screen.getByRole('button', { name: '通知' }));
  const panel = screen.getByRole('dialog', { name: '站内信' });
  expect(panel).toHaveTextContent('消息 a');
  expect(panel).toHaveTextContent('2 条未读消息');

  await user.click(screen.getByRole('button', { name: '全部标记已读' }));
  expect(api.markInboxAllRead).toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole('dialog', { name: '站内信' })).toHaveTextContent('暂无未读消息'));
});

it('navigates to the task when a message carries a link', async () => {
  const unread = [message('task')];
  vi.mocked(api.getInboxMessages).mockResolvedValue({ items: unread, page: 1, pageSize: 20, total: 1, unreadCount: 1 });
  vi.mocked(api.getInboxUnread).mockResolvedValue({ unread: 1, latest: unread[0] });
  const user = userEvent.setup();
  render(<InboxBell />);
  await user.click(screen.getByRole('button', { name: '通知' }));
  const item = await screen.findByRole('link', { name: /消息 task/ });
  expect(item).toHaveAttribute('href', '/admin/reviews');
  await user.click(item);
  expect(api.markInboxRead).toHaveBeenCalledWith('task');
});
