import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import AuditsPage from './page';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../../lib/api-client', () => ({ getOperationAudits: mocks.list }));

it('shows actor names and uses the shared pagination controls', async () => {
  mocks.list.mockImplementation(async (page: number) => ({
    items: [{ id: `audit-${page}`, userId: '5356da7b-9a6e-41ff-9620-d3cdb084b3db',
      actorName: '姚伟明', action: 'web_search', entityType: 'DshTool', entityId: 'session:call',
      detailJson: '{}', actionLabel: '执行网页搜索', entityLabel: 'DSH 工具调用', detailLabel: '—',
      succeeded: true, createdAt: '2026-09-28T00:00:00Z' }],
    total: 11, page, pageSize: 10,
  }));
  const user = userEvent.setup();
  render(<AuditsPage />);
  expect(await screen.findByText('姚伟明')).toBeInTheDocument();
  expect(screen.queryByText('5356da7b')).not.toBeInTheDocument();
  expect(screen.getByText('执行网页搜索')).toBeInTheDocument();
  expect(screen.getByRole('navigation', { name: '审计记录分页' })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: '审计记录分页每页条数' })).toHaveValue('5');
  await user.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(mocks.list).toHaveBeenCalledWith(2, 5));
  expect(screen.getByRole('button', { name: '第 2 页' })).toHaveAttribute('aria-current', 'page');
});

it('shows a backend-version error instead of crashing on the old array response', async () => {
  mocks.list.mockResolvedValueOnce([]);
  render(<AuditsPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('审计接口格式不匹配');
  expect(screen.queryByText('暂无审计记录')).not.toBeInTheDocument();
});
