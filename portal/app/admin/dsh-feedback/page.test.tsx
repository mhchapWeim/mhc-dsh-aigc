import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import Page from './page';
import * as api from '../../lib/api-client';

const row = { id: 'f1', sessionId: 'session-1', category: 'other', text: '反馈内容', createdAt: '2026-10-12T01:00:00Z', userName: '测试用户', employeeNo: 'wh00412' };
vi.mock('../../lib/api-client', () => ({ getDshFeedback: vi.fn(), getDshFeedbackDetail: vi.fn() }));
beforeEach(() => {
  vi.mocked(api.getDshFeedback).mockReset().mockResolvedValue({ items: [row], total: 1, page: 1, pageSize: 20 });
  vi.mocked(api.getDshFeedbackDetail).mockReset().mockResolvedValue({ ...row, sessionLog: 'conversation log' });
});
it('shows feedback, filters by category and opens its session log', async () => {
  render(<Page />);
  await screen.findByText('反馈内容');
  fireEvent.change(screen.getByLabelText('反馈分类'), { target: { value: 'other' } });
  await waitFor(() => expect(api.getDshFeedback).toHaveBeenLastCalledWith('', 'other', 1, 5));
  fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
  await screen.findByText('conversation log');
  expect(api.getDshFeedbackDetail).toHaveBeenCalledWith('f1');
  fireEvent.click(screen.getByLabelText('关闭弹窗'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('reports a backend error and recovers on refresh', async () => {
  vi.mocked(api.getDshFeedback).mockRejectedValueOnce(new Error('无权限'));
  render(<Page />);
  expect(await screen.findByRole('alert')).toHaveTextContent('无权限');
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await screen.findByText('反馈内容');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('uses shared pagination and resets the page when searching or resetting filters', async () => {
  vi.mocked(api.getDshFeedback).mockResolvedValue({ items: [row], total: 41, page: 1, pageSize: 20 });
  render(<Page />);
  await screen.findByText('反馈内容');
  fireEvent.click(screen.getByRole('button', { name: '第 2 页' }));
  await waitFor(() => expect(api.getDshFeedback).toHaveBeenLastCalledWith('', '', 2, 5));
  fireEvent.change(screen.getByLabelText('搜索反馈'), { target: { value: '工号' } });
  await waitFor(() => expect(api.getDshFeedback).toHaveBeenLastCalledWith('工号', '', 1, 5));
  fireEvent.change(screen.getByLabelText('反馈分类'), { target: { value: 'other' } });
  await waitFor(() => expect(api.getDshFeedback).toHaveBeenLastCalledWith('工号', 'other', 1, 5));
  fireEvent.click(screen.getByRole('button', { name: '重置' }));
  await waitFor(() => expect(api.getDshFeedback).toHaveBeenLastCalledWith('', '', 1, 5));
});
