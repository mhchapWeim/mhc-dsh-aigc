import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AnnouncementReceipts } from './announcement-receipts';

it('shows the complete body and all receipt columns with ten recipients per page', async () => {
  const close = vi.fn();
  render(<AnnouncementReceipts onClose={close} announcement={{
    id: 'announcement-1', title: '版本更新', body: '版本更新\n第一项\n第二项\n最后一项', important: true, status: 'Published',
    startsAt: '2026-10-08T03:00:00Z', endsAt: null, createdAt: '2026-10-08T02:00:00Z', audience: { userIds: [], roleIds: [], departmentIds: [] },
    recipients: Array.from({ length: 11 }, (_, index) => ({ userId: `user-${index}`, name: `员工${index}`, employeeNo: `w${index}`,
      deliveredAt: '2026-10-08T03:01:00Z', readAt: '2026-10-08T03:02:00Z', confirmedAt: '2026-10-08T03:03:00Z' })),
  }} />);
  const user = userEvent.setup();
  expect(screen.getByText(/最后一项/)).toHaveTextContent('版本更新 第一项 第二项 最后一项');
  expect(screen.getByText('长期有效')).toBeVisible();
  const table = screen.getByRole('table', { name: '公告接收回执' });
  expect(within(table).getAllByRole('columnheader')).toHaveLength(4);
  expect(within(table).getByRole('columnheader', { name: '确认时间' })).toBeVisible();
  expect(within(table).getAllByRole('row')).toHaveLength(11);
  await user.click(within(screen.getByRole('navigation', { name: '公告回执分页' })).getByRole('button', { name: '下一页' }));
  expect(within(table).getAllByRole('row')).toHaveLength(2);
  expect(within(table).getByText('员工10')).toBeVisible();
  expect(within(table).queryByText('员工0')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '关闭' }));
  expect(close).toHaveBeenCalledOnce();
});
