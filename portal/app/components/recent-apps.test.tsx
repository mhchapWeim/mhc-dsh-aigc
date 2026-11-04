import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PortalShell } from './portal-shell';
import * as api from '../lib/api-client';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('./platform-provider', () => ({ usePlatform: () => ({ currentUserId: 'user', users: [{ id: 'user', name: '李俊', employeeNo: 'wh00412' }], dispatch: vi.fn() }) }));
vi.mock('../lib/api-client', () => ({
  clearSession: vi.fn(),
  getRegisteredAppAccess: vi.fn(),
  getRecentCatalogApps: vi.fn(async () => []),
  getCatalogApps: vi.fn(async () => [{
    id: 'quality', name: '质量知识助手', nameEn: 'Quality Knowledge Assistant', description: '检索质量知识', descriptionEn: 'Search quality knowledge',
    category: '智慧服务', owner: '质量部', ownerEn: 'Quality', categoryColor: '#2465d0', accessUrl: 'https://example.com/quality', publishedAt: '2026-11-03', registered: false,
  }, {
    id: 'meeting', name: '会议纪要 Copilot', nameEn: 'Meeting Copilot', description: '生成会议纪要', descriptionEn: 'Write meeting notes',
    category: '智慧服务', owner: '质量部', ownerEn: 'Quality', categoryColor: '#2465d0', accessUrl: 'https://example.com/meeting', publishedAt: '2026-11-03', registered: false,
  }]),
}));

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

it('fills the recent strip from the account history rather than fixed entries', async () => {
  // The account opened the meeting app most recently, then the quality one.
  vi.mocked(api.getRecentCatalogApps).mockResolvedValue([
    { id: 'meeting', name: '会议纪要 Copilot', registered: false, lastUsedAt: '2026-11-04T05:00:00Z' },
    { id: 'quality', name: '质量知识助手', registered: false, lastUsedAt: '2026-11-03T09:00:00Z' },
  ]);
  render(<PortalShell />);
  const strip = await screen.findByRole('region', { name: '最近使用' });
  const labels = await waitFor(() => {
    const buttons = Array.from(strip.querySelectorAll('button')).map(node => node.textContent);
    expect(buttons).toHaveLength(2);
    return buttons;
  });
  // Server order is recency order; the strip must not re-sort or substitute entries.
  expect(labels).toEqual(['会议纪要 Copilot', '质量知识助手']);
  expect(api.getRecentCatalogApps).toHaveBeenCalledWith(6);
});

it('hides the recent strip instead of showing placeholder shortcuts when nothing was opened', async () => {
  vi.mocked(api.getRecentCatalogApps).mockResolvedValue([]);
  render(<PortalShell />);
  // The catalog still loads, so absence of the strip is a real empty state, not a pending render.
  await screen.findByRole('tab', { name: /智慧服务/ });
  expect(screen.queryByRole('region', { name: '最近使用' })).toBeNull();
});

it('keeps the catalog usable when the recency request fails', async () => {
  vi.mocked(api.getRecentCatalogApps).mockRejectedValue(new Error('network down'));
  render(<PortalShell />);
  await screen.findByRole('tab', { name: /智慧服务/ });
  expect(screen.queryByRole('region', { name: '最近使用' })).toBeNull();
  expect(screen.queryByText('应用目录加载失败')).toBeNull();
});

it('opens a recent entry directly and promotes it after launching a published app', async () => {
  // Seed with the other app so the promotion is observable: the strip starts as
  // [quality] and must end as [meeting] after launching the meeting app.
  vi.mocked(api.getRecentCatalogApps).mockResolvedValue([
    { id: 'quality', name: '质量知识助手', registered: false, lastUsedAt: '2026-11-03T09:00:00Z' },
  ]);
  const popup = { close: vi.fn(), location: { replace: vi.fn() }, opener: null };
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  const user = userEvent.setup();
  render(<PortalShell />);
  const strip = await screen.findByRole('region', { name: '最近使用' });
  // Launch a published app from the catalog; it is not recorded server-side, so the
  // strip learns about it locally.
  await user.click(await screen.findByRole('button', { name: '进入会议纪要 Copilot' }));
  await waitFor(() => expect(window.open).toHaveBeenCalledWith('https://example.com/meeting', '_blank', 'noopener,noreferrer'));
  await waitFor(() => expect(Array.from(strip.querySelectorAll('button')).map(node => node.textContent))
    .toEqual(['会议纪要 Copilot', '质量知识助手']));
});

it('does not promote a recent entry that is no longer in the visible catalog', async () => {
  vi.mocked(api.getRecentCatalogApps).mockResolvedValue([
    { id: 'revoked', name: '已撤权应用', registered: false, lastUsedAt: '2026-11-04T05:00:00Z' },
  ]);
  vi.spyOn(window, 'open').mockReturnValue({ close: vi.fn(), opener: null } as unknown as Window);
  const user = userEvent.setup();
  render(<PortalShell />);
  await screen.findByRole('tab', { name: /智慧服务/ });
  const strip = screen.queryByRole('region', { name: '最近使用' });
  if (strip !== null) await user.click(screen.getByRole('button', { name: '已撤权应用' }));
  // A withdrawn grant must not open anything even though the history mentions it.
  expect(window.open).not.toHaveBeenCalled();
});
