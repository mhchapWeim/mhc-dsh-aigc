import { render, screen } from '@testing-library/react';
import { AppCard } from './app-card';
import type { PortalApp } from '../lib/types';

const base: PortalApp = {
  id: 'app', name: '设备助手', description: '检索设备知识', category: '智慧服务', owner: '质量部',
  tags: [], accessUrl: 'https://example.com/device', publishedAt: '2026-11-04', status: '运行中', accent: '#2465d0',
};

const renderCard = (overrides: Partial<PortalApp> = {}, locale: 'zh' | 'en' = 'zh') => render(
  <AppCard app={{ ...base, ...overrides }} index={0} favorite={false} locale={locale} onFavorite={vi.fn()} onOpen={vi.fn()} />);

it('shows one lifetime total in place of the four reporting windows', () => {
  renderCard({ clicks: { day: 2, week: 4, month: 6, year: 8 }, totalClicks: 128 });
  const total = screen.getByLabelText('累计点击 128');
  expect(total).toHaveTextContent('累计点击');
  expect(total).toHaveTextContent('128');
  // The per-period breakdown belongs to the click report, not the card.
  for (const label of ['日点击', '周点击', '月点击', '年点击']) expect(screen.queryByText(label)).toBeNull();
});

it('formats a large total with thousands separators', () => {
  renderCard({ totalClicks: 1234567 });
  expect(screen.getByLabelText('累计点击 1234567')).toHaveTextContent('1,234,567');
});

it('omits the total for an application that has never recorded a launch', () => {
  renderCard({});
  expect(screen.queryByText('累计点击')).toBeNull();
  // Zero is still a real recorded figure and must not be hidden.
  renderCard({ totalClicks: 0 });
  expect(screen.getByLabelText('累计点击 0')).toHaveTextContent('0');
});

it('localizes the total label', () => {
  renderCard({ totalClicks: 9 }, 'en');
  expect(screen.getByLabelText('Total clicks 9')).toHaveTextContent('Total');
});
