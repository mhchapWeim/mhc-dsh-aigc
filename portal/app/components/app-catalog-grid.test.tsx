import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppCatalogGrid } from './app-catalog-grid';
import type { PortalApp } from '../lib/types';

const apps: PortalApp[] = Array.from({length: 30}, (_, index) => ({id: String(index), name: `应用${index}`, description: '说明', category: '智慧服务', owner: '团队', tags: [], accessUrl: '', registered: true, publishedAt: '', status: '运行中', accent: '#2465d0'}));
afterEach(() => vi.unstubAllGlobals());

it('appends cards near the bottom, keeps existing cards, and stops when all are visible', () => {
  const callbacks: IntersectionObserverCallback[] = [];
  const disconnect = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
    observe = vi.fn(); disconnect = disconnect;
  });
  const view = render(<AppCatalogGrid apps={apps} locale="zh" favorites={[]} onFavorite={vi.fn()} onOpen={vi.fn()}/>);
  const first = screen.getByRole('heading', {name: '应用0'});
  expect(screen.getAllByRole('heading', {level: 3})).toHaveLength(12);
  act(() => callbacks.at(-1)!([{isIntersecting: true}] as IntersectionObserverEntry[], {} as IntersectionObserver));
  expect(screen.getAllByRole('heading', {level: 3})).toHaveLength(24);
  expect(screen.getByRole('heading', {name: '应用0'})).toBe(first);
  act(() => callbacks.at(-1)!([{isIntersecting: true}] as IntersectionObserverEntry[], {} as IntersectionObserver));
  expect(screen.getAllByRole('heading', {level: 3})).toHaveLength(30);
  expect(screen.getByText('已展示全部 30 个应用')).toBeVisible();
  expect(screen.queryByRole('button', {name: '加载更多应用'})).not.toBeInTheDocument();
  view.unmount(); expect(disconnect).toHaveBeenCalled();
});

it('supports keyboard-accessible loading without an observer and resets for a new filter', async () => {
  vi.stubGlobal('IntersectionObserver', undefined);
  const user = userEvent.setup();
  const props = {apps, locale: 'zh' as const, favorites: [], onFavorite: vi.fn(), onOpen: vi.fn()};
  const view = render(<AppCatalogGrid key="all" {...props}/>);
  await user.click(screen.getByRole('button', {name: '加载更多应用'}));
  expect(screen.getAllByRole('heading', {level: 3})).toHaveLength(24);
  view.rerender(<AppCatalogGrid key="filtered" {...props}/>);
  expect(screen.getAllByRole('heading', {level: 3})).toHaveLength(12);
  expect(screen.queryByRole('navigation', {name: '应用目录分页'})).not.toBeInTheDocument();
});
