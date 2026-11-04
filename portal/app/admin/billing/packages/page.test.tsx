import { selectDropdown } from '../../../../test/select-dropdown';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import Page from './page';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../../lib/api-client', () => ({ hasBackend: true, apiRequest: mocks.request }));
beforeEach(() => {
  mocks.request.mockReset().mockImplementation(async (path: string) => path === '/api/billing'
    ? { users: [{ id: 'u1', name: '张三', employeeNo: 'wh001' }] }
    : { items: [], total: 0 });
});
it('issues an increment package', async () => {
  render(<Page />);
  await waitFor(() => expect(screen.getByRole('button', { name: '增加流量' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '增加流量' }));
  fireEvent.click(screen.getByRole('button', { name: '增加增加 token' }));
  expect(screen.getByRole('spinbutton', { name: '增加 token' })).toHaveValue(1000001);
  fireEvent.click(screen.getByRole('button', { name: '减少增加 token' }));
  expect(screen.getByRole('spinbutton', { name: '增加 token' })).toHaveValue(1000000);
  selectDropdown(screen.getByRole('combobox', { name: '用户' }), 'u1');
  fireEvent.change(screen.getByRole('spinbutton', { name: '增加 token' }), { target: { value: '2000000' } });
  fireEvent.change(screen.getByRole('textbox', { name: '发放原因' }), { target: { value: '项目追加' } });
  fireEvent.click(screen.getByRole('button', { name: '确认发放' }));
  await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('/api/billing/packages', {
    method: 'POST', body: JSON.stringify({ userId: 'u1', tokens: 2000000, reason: '项目追加' }),
  }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('增量包已发放'));
});
it('keeps a failed issuance open', async () => {
  render(<Page />);
  await waitFor(() => expect(screen.getByRole('button', { name: '增加流量' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '增加流量' }));
  mocks.request.mockRejectedValueOnce(new Error('请先绑定计费配方'));
  fireEvent.submit(screen.getByRole('button', { name: '确认发放' }).closest('form')!);
  await waitFor(() => expect(screen.getAllByRole('alert')[0]).toHaveTextContent('请先绑定计费配方'));
  expect(screen.getByRole('button', { name: '确认发放' })).toBeEnabled();
});
it('shows empty history and searches records', async () => {
  render(<Page />);
  expect(await screen.findByText('暂无增量包记录')).toBeVisible();
  fireEvent.change(screen.getByRole('searchbox', { name: '查询记录' }), { target: { value: 'wh001' } });
  await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('/api/billing/packages?page=1&pageSize=10&keyword=wh001'));
});
