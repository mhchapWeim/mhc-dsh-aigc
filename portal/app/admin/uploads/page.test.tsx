import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import DshUploadsPage from './page';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock('../../lib/api-client', () => ({
  getDshUploadBatches: getMock,
}));
beforeEach(() => { getMock.mockReset(); });

it('shows upload progress without an action column', async () => {
  getMock.mockResolvedValue({ items: [{ userId: 'user-1', sessionId: 'session-1', eventSeq: 3, createdAt: '2026-09-18T00:00:00Z', files: [
    { id: 'one', fileName: 'pending.txt', userName: '张敏', employeeNo: 'wh00136', computerName: 'PC-1', storedPath: 'C:/pending.txt', prompt: '分析', offset: 2, bytes: 4, status: 'Uploading', completed: false, createdAt: '2026-09-18T00:00:00Z' },
    { id: 'two', fileName: 'ready.pdf', userName: '张敏', employeeNo: 'wh00136', computerName: 'PC-1', storedPath: 'C:/ready.pdf', prompt: '分析', offset: 4, bytes: 4, status: 'Completed', completed: true, createdAt: '2026-09-18T00:00:00Z' },
  ] }], page: 1, pageSize: 10, total: 1 });
  render(<DshUploadsPage />);
  await screen.findByText('ready.pdf');
  expect(screen.queryByRole('button', { name: '下载pending.txt' })).not.toBeInTheDocument();
  expect(screen.getAllByText('上传中').length).toBeGreaterThan(0);
  expect(screen.getByRole('columnheader', { name: 'User Prompt' })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: '批次' })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: '用户' })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: '计算机' })).toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: '操作' })).not.toBeInTheDocument();
  const batchCell = screen.getByTitle('会话 session-1，事件 3').closest('th')!;
  expect(batchCell).toHaveAttribute('rowspan', '2');
  expect(batchCell.closest('tbody')).toContainElement(screen.getByText('ready.pdf'));
  expect(screen.getAllByRole('row')).toHaveLength(3);
  expect(within(batchCell).queryByText('同一次提问')).not.toBeInTheDocument();
  expect(within(batchCell).queryByText(/个文件|已完成/)).not.toBeInTheDocument();
  const pendingRow = screen.getByText('pending.txt').closest('tr')!;
  expect(within(pendingRow).getByRole('cell', { name: /张敏.*wh00136/ })).toBeInTheDocument();
  expect(within(pendingRow).getByRole('cell', { name: 'PC-1' })).toBeInTheDocument();
  expect(within(pendingRow).getByRole('progressbar', { name: 'pending.txt上传进度' })).toHaveAttribute('value', '50');
  expect(screen.getByRole('progressbar', { name: 'ready.pdf上传进度' })).toHaveAttribute('value', '100');
  await userEvent.click(screen.getByRole('button', { name: '查看ready.pdf的 User Prompt' }));
  expect(within(screen.getByRole('dialog')).getByText('分析')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
});

it('loads the selected page from the backend', async () => {
  getMock.mockImplementation(async (page: number) => ({
    items: [{ userId: 'user-1', sessionId: `session-${page}`, eventSeq: page, createdAt: '2026-09-18T00:00:00Z', files: [{ id: String(page), fileName: `page-${page}.txt`, userName: '测试', employeeNo: 'wh00028', computerName: 'PC', storedPath: 'C:/file', prompt: '问题', offset: 1, bytes: 1, status: 'Completed', completed: true, createdAt: '2026-09-18T00:00:00Z' }] }],
    page, pageSize: 10, total: 11,
  }));
  render(<DshUploadsPage />);
  await screen.findByText('page-1.txt');
  await userEvent.click(screen.getByRole('button', { name: '第 2 页' }));
  await screen.findByText('page-2.txt');
  expect(getMock).toHaveBeenCalledWith(2, 5, '', '');
});

it('keeps all review columns while hiding transfer progress for metadata records', async () => {
    getMock.mockResolvedValue({ total: 1, items: [{
    userId: 'u1', sessionId: 'session-1', eventSeq: 1, createdAt: '2026-10-23T00:00:00Z',
    files: ['Recorded', 'Completed'].map((status, index) => ({
      id: `file-${index}`, clientUploadId: `client-${index}`, sessionId: 'session-1', eventSeq: 1,
      fileName: index === 0 ? 'record.txt' : 'historical.txt', prompt: '审查记录', userName: '员工', employeeNo: 'w1',
      computerName: 'test-pc', storedPath: 'C:\\stored\\report.txt', bytes: 123, offset: index === 0 ? 0 : 123,
      completed: true, status, createdAt: '2026-10-23T00:00:00Z',
    })),
  }] });
  render(<DshUploadsPage />);
  const recorded = (await screen.findByText('record.txt')).closest('tr')!;
  expect(within(recorded).getByText('已记录')).toBeVisible();
  expect(within(recorded).queryByRole('button', { name: '下载record.txt' })).not.toBeInTheDocument();
  expect(within(recorded).queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '下载historical.txt' })).not.toBeInTheDocument();
  expect(screen.getAllByRole('columnheader').map(cell => cell.textContent)).toEqual([
    '批次', '文件', '用户', '计算机', 'User Prompt', '源路径', '进度', '状态', '创建时间',
  ]);
  expect(within(recorded).getByText('test-pc')).toBeVisible();
  expect(within(recorded).getByText('审查记录')).toBeVisible();
});
