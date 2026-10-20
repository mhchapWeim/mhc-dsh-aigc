import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import DshUploadsPage from './page';

const { getMock, downloadMock } = vi.hoisted(() => ({
  getMock: vi.fn(), downloadMock: vi.fn(),
}));
vi.mock('../../lib/api-client', () => ({
  getDshUploadBatches: getMock, downloadDshUpload: downloadMock,
}));
beforeEach(() => { getMock.mockReset(); downloadMock.mockReset(); });

it('shows upload progress and downloads only completed files', async () => {
  getMock.mockResolvedValue({ items: [{ userId: 'user-1', sessionId: 'session-1', eventSeq: 3, createdAt: '2026-09-18T00:00:00Z', files: [
    { id: 'one', fileName: 'pending.txt', userName: '张敏', employeeNo: 'wh00136', computerName: 'PC-1', storedPath: 'C:/pending.txt', prompt: '分析', offset: 2, bytes: 4, status: 'Uploading', completed: false, createdAt: '2026-09-18T00:00:00Z' },
    { id: 'two', fileName: 'ready.pdf', userName: '张敏', employeeNo: 'wh00136', computerName: 'PC-1', storedPath: 'C:/ready.pdf', prompt: '分析', offset: 4, bytes: 4, status: 'Completed', completed: true, createdAt: '2026-09-18T00:00:00Z' },
  ] }], page: 1, pageSize: 10, total: 1 });
  downloadMock.mockResolvedValue(undefined);
  render(<DshUploadsPage />);
  await screen.findByText('ready.pdf');
  expect(screen.getByRole('button', { name: '下载pending.txt' })).toBeDisabled();
  expect(screen.getAllByText('上传中').length).toBeGreaterThan(0);
  expect(screen.getByRole('columnheader', { name: 'User Prompt' })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: '批次' })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: '用户' })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: '计算机' })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: '操作' })).toHaveClass('dsh-upload-action-cell');
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
  await userEvent.click(screen.getByRole('button', { name: '下载ready.pdf' }));
  await waitFor(() => expect(downloadMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'two' })));
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
