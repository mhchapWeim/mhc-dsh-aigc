import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Page from './page';
import * as api from '../../lib/application-registry';

vi.mock('../../lib/application-registry', () => ({getClickReport: vi.fn(async () => ({generatedAt: '2026-11-04T00:00:00Z', periods: {}, from: '2026-10-06', to: '2026-11-05', trend: [{date: '2026-11-04', clicks: 3}], applications: [{id: 'a', name: '设备助手'}, {id: 'b', name: '质量助手'}], items: [
  {id: 'a', name: '设备助手', category: '知识问答', isEnabled: true, rangeClicks: 2, clicks: {day: 5, week: 15, month: 25, year: 35}},
  {id: 'b', name: '质量助手', category: '质量', isEnabled: false, rangeClicks: 1, clicks: {day: 8, week: 18, month: 28, year: 38}},
]}))}));

it('shows period counts, includes disabled apps, and filters by name', async () => {
  const user = userEvent.setup(); render(<Page/>);
  expect(await screen.findByText('设备助手')).toBeVisible();
  expect(screen.getByRole('img', {name: '按日真实点击趋势折线图'})).toBeVisible();
  expect(screen.getByRole('img', {name: '应用点击对比柱状对比图'})).toBeVisible();
  expect(screen.getByRole('img', {name: '分类点击对比柱状对比图'})).toBeVisible();
  expect(screen.getByText('已停用')).toBeVisible();
  expect(screen.getByText('35')).toBeVisible();
  await user.type(screen.getByRole('searchbox', {name: '搜索点击报表'}), '设备');
  expect(screen.getByRole('table', {name: '应用点击统计'})).not.toHaveTextContent('质量助手');
  expect(screen.getByText('共 1 个注册应用（含停用）')).toBeVisible();
});

it('clears outdated data when refreshing fails', async () => {
  const user = userEvent.setup(); render(<Page/>);
  await screen.findByText('设备助手');
  vi.mocked(api.getClickReport).mockRejectedValueOnce(new Error('报表不可用'));
  await user.click(screen.getByRole('button', {name: '刷新'}));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('报表不可用'));
  expect(screen.queryByRole('table', {name: '应用点击统计'})).not.toBeInTheDocument();
  expect(screen.queryByRole('img', {name: '按日真实点击趋势折线图'})).not.toBeInTheDocument();
});

it('requests real trend data for the selected date range and application', async () => {
  const user = userEvent.setup(); render(<Page/>);
  await screen.findByRole('table', {name: '应用点击统计'});
  fireEvent.change(screen.getByLabelText('点击开始日期'), {target: {value: '2026-11-01'}});
  fireEvent.change(screen.getByLabelText('点击结束日期'), {target: {value: '2026-11-05'}});
  await waitFor(() => expect(api.getClickReport).toHaveBeenLastCalledWith({from: '2026-11-01', to: '2026-11-05', applicationId: ''}));
  await user.click(screen.getByRole('combobox', {name: '点击统计应用'}));
  await user.click(screen.getByRole('option', {name: '设备助手'}));
  await waitFor(() => expect(api.getClickReport).toHaveBeenLastCalledWith({from: '2026-11-01', to: '2026-11-05', applicationId: 'a'}));
});
