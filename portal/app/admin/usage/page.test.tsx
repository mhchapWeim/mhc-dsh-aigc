import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import Page from './page';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../lib/api-client', () => ({ hasBackend: true, apiRequest: mocks.request }));
beforeEach(() => mocks.request.mockReset());
it('shows assigned quota, package reason and expiry', async () => {
  mocks.request.mockResolvedValue({ quota: { assigned: true, planName: '标准配方', source: 'Department', total: 1250, used: 300, remaining: 950, weekStart: '2026-11-01T16:00:00Z', resetsAt: '2026-11-08T16:00:00Z' }, extraTokens: 250, checkedAt: '2026-11-02T00:00:00Z', packages: { total: 1, items: [{ id: '1', tokens: 250, createdAt: '2026-11-02T00:00:00Z', expiresAt: '2026-11-08T16:00:00Z', reason: '项目临时增加' }] } });
  render(<Page />);
  expect(await screen.findByText('标准配方')).toBeVisible();
  expect(screen.getByText('来源：继承部门')).toBeVisible();
  expect(screen.getByText('950')).toBeVisible();
  expect(screen.getByText('项目临时增加')).toBeVisible();
  expect(screen.getByText('本周期有效')).toBeVisible();
});
it('allows retry after API failure and shows unassigned empty state', async () => {
  mocks.request.mockRejectedValueOnce(new Error('加载失败')).mockResolvedValue({ quota: { assigned: false, source: 'None', total: 0, used: 0, remaining: 0, weekStart: '2026-11-01T16:00:00Z', resetsAt: '2026-11-08T16:00:00Z' }, extraTokens: 0, checkedAt: '2026-11-02T00:00:00Z', packages: { total: 0, items: [] } });
  render(<Page />);
  expect(await screen.findByRole('alert')).toHaveTextContent('加载失败');
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect(await screen.findByText('尚未分配计费配方')).toBeVisible();
  expect(screen.getByText('暂无流量包发放记录')).toBeVisible();
});
