import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PortalShell } from './portal-shell';
import * as api from '../lib/api-client';

vi.mock('next/navigation', () => ({ useRouter: () => ({replace: vi.fn()}) }));
vi.mock('./platform-provider', () => ({usePlatform: () => ({currentUserId: 'user', users: [{id: 'user', name: '李俊', employeeNo: 'wh00412'}], dispatch: vi.fn()})}));
vi.mock('../lib/api-client', () => ({clearSession: vi.fn(), getRegisteredAppAccess: vi.fn(), getRecentCatalogApps: vi.fn(async () => []), getCatalogApps: vi.fn(async () => [{
  id: 'registered', name: '设备助手', nameEn: 'Device Assistant', description: '检索设备知识', descriptionEn: 'Find equipment knowledge', category: '智慧服务',
  owner: '质量部', ownerEn: 'Quality', categoryColor: '#2465d0', accessUrl: '', publishedAt: '2026-11-03', registered: true, subcategory: '设备知识', subcategoryId: 'child', clicks: {day: 2, week: 4, month: 6, year: 8}, totalClicks: 128,
}])}));

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); document.documentElement.removeAttribute('data-theme'); });

it('shows registered apps to users without a URL and denies opening when the server refuses access', async () => {
  vi.mocked(api.getRegisteredAppAccess).mockRejectedValueOnce(new Error('无权访问'));
  const popup = {close: vi.fn(), location: {replace: vi.fn()}, opener: null};
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  const user = userEvent.setup(); render(<PortalShell/>);
  await user.click(await screen.findByRole('link', {name: '进入设备助手'}));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('无权访问'));
  expect(window.open).not.toHaveBeenCalled();
  expect(popup.location.replace).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole('status')).toBeEmptyDOMElement(), {timeout: 4000});
});

it('uses stored English copy and navigates only after server authorization', async () => {
  localStorage.setItem('aigc-locale', 'en');
  vi.mocked(api.getRegisteredAppAccess).mockResolvedValueOnce({accessUrl: 'https://example.com/device'});
  const popup = {close: vi.fn(), location: {replace: vi.fn()}, opener: null};
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  const user = userEvent.setup(); render(<PortalShell/>);
  expect(await screen.findByText('Find equipment knowledge')).toBeInTheDocument();
  expect(screen.getByText('Quality')).toBeInTheDocument();
  await user.click(screen.getByRole('button', {name: 'Open Device Assistant'}));
  await waitFor(() => expect(window.open).toHaveBeenCalledWith('https://example.com/device', '_blank'));
});

it('filters by second-level category and displays authoritative launch counts', async () => {
  vi.mocked(api.getRegisteredAppAccess).mockResolvedValueOnce({accessUrl: 'https://example.com/device', counted: true, clicks: {day: 3, week: 5, month: 7, year: 9}, totalClicks: 129});
  vi.spyOn(window, 'open').mockReturnValue({opener: null} as Window);
  const user = userEvent.setup(); render(<PortalShell/>);
  await user.click(await screen.findByRole('button', {name: '智慧服务 / 设备知识'}));
  expect(screen.getByRole('button', {name: '智慧服务 / 设备知识'})).toHaveAttribute('aria-pressed', 'true');
  // The card carries one lifetime figure instead of the four reporting windows.
  expect(screen.getByLabelText('累计点击 128')).toBeVisible();
  expect(screen.queryByText('日点击')).toBeNull();
  await user.click(screen.getByRole('button', {name: '进入设备助手'}));
  await waitFor(() => expect(screen.getByLabelText('累计点击 129')).toBeVisible());
});

it('distinguishes same-named second-level categories by id and parent', async () => {
  const base = {nameEn: '', description: '说明', owner: '', categoryColor: '#2465d0', accessUrl: '', publishedAt: '2026-11-04', registered: true, subcategory: '通用'};
  vi.mocked(api.getCatalogApps).mockResolvedValueOnce([
    {...base, id: 'a', name: '设备应用', category: '智慧服务', subcategoryId: 'child-a'},
    {...base, id: 'b', name: '质量应用', category: '研发创新', subcategoryId: 'child-b'},
  ]);
  const user = userEvent.setup(); render(<PortalShell/>);
  await user.click(await screen.findByRole('button', {name: '智慧服务 / 通用'}));
  expect(screen.getByRole('heading', {name: '设备应用'})).toBeVisible();
  expect(screen.queryByRole('heading', {name: '质量应用'})).not.toBeInTheDocument();
});

it('browses continuously without pagination and searches across cards not yet shown', async () => {
  vi.mocked(api.getCatalogApps).mockResolvedValueOnce(Array.from({length: 30}, (_, index) => ({
    id: `batch-${index}`, name: `批量应用${index}`, description: '说明', category: '智慧服务', owner: '团队', categoryColor: '#2465d0', accessUrl: '', publishedAt: '2026-11-04', registered: true,
  })));
  const user = userEvent.setup(); render(<PortalShell/>);
  await screen.findByRole('heading', {name: '批量应用0'});
  expect(screen.getAllByRole('heading', {level: 3})).toHaveLength(12);
  expect(screen.queryByRole('navigation', {name: '应用目录分页'})).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', {name: '加载更多应用'}));
  expect(screen.getAllByRole('heading', {level: 3})).toHaveLength(24);
  await user.type(screen.getByRole('searchbox'), '批量应用29');
  expect(screen.getByRole('heading', {name: '批量应用29'})).toBeVisible();
  expect(screen.getAllByRole('heading', {level: 3})).toHaveLength(1);
  await user.clear(screen.getByRole('searchbox'));
  expect(screen.getAllByRole('heading', {level: 3})).toHaveLength(12);
});
