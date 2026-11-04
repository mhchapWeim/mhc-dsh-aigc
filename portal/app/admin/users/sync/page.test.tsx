import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import Page from './page';
import * as api from '../../../lib/user-sync-api';
vi.mock('../../../lib/api-client', () => ({ hasBackend: true }));
vi.mock('../../../lib/user-sync-api', () => ({
  syncStatusNames: { Pending: '待发送', Sent: '已发送至 MQ', Failed: '发送失败' },
  getUserSyncConnection: vi.fn(), getUserSyncSummary: vi.fn(), getUserSyncBatches: vi.fn(), getUserSyncMessages: vi.fn(),
  startUserSnapshot: vi.fn(), retryUserSyncMessage: vi.fn(), userSyncConsumerInfo: vi.fn(() => '{"host":"nj304","queue":"service-1"}'),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getUserSyncConnection).mockResolvedValue({ enabled: false, host: 'nj304', port: 5672, virtualHost: '/aigc', useTls: false, exchange: 'aigc.identity.users', exchangeType: 'topic', bindingKey: 'aigc.user.*.v1', maximumAttempts: 10, schemaVersion: 1, consumers: [{ serviceName: '服务一', queue: 'service-1', userName: 'consumer' }] });
  vi.mocked(api.getUserSyncSummary).mockResolvedValue({ enabled: false, pending: 1, sent: 3, failed: 0, lastSentAt: null });
  vi.mocked(api.getUserSyncBatches).mockResolvedValue([]);
  vi.mocked(api.getUserSyncMessages).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
  vi.mocked(api.startUserSnapshot).mockResolvedValue({ id: 'batch-1', total: 4 });
});
it('requires confirmation to create a full snapshot and shows the queued count', async () => {
  render(<Page />);
  await waitFor(() => expect(screen.getByRole('button', { name: '全量同步' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '全量同步' }));
  expect(api.startUserSnapshot).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toHaveTextContent('含停用用户');
  fireEvent.click(screen.getByRole('button', { name: '确认生成并发送' }));
  await waitFor(() => expect(api.startUserSnapshot).toHaveBeenCalledWith(expect.any(String)));
  expect(await screen.findByText(/已生成 4 条用户快照/)).toBeVisible();
  expect(screen.getByText(/MQ 发送尚未启用/)).toBeVisible();
});
it('copies receiver connection information without requiring a producer credential', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<Page />);
  fireEvent.click(await screen.findByRole('button', { name: '复制 MQ 信息' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('{"host":"nj304","queue":"service-1"}'));
  expect(await screen.findByText(/已复制接收方 MQ 接入信息/)).toBeVisible();
});
it('shows sent details and retries only failed messages', async () => {
  vi.mocked(api.getUserSyncMessages).mockResolvedValue({ items: [{ id:'event-1',userId:'user-1',userName:'张三',employeeNo:'wh001',userVersion:2,batchId:null,eventType:'user.upsert',status:'Failed',attempts:10,consecutiveFailures:10,createdAt:'2026-11-02T01:00:00Z',sentAt:null,nextAttemptAt:'2026-11-02T01:01:00Z',lastError:'没有匹配队列' }], total:1,page:1,pageSize:10 });
  render(<Page />);
  fireEvent.click(await screen.findByRole('button', { name: '详情' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('没有匹配队列');
  expect(screen.getByRole('dialog')).toHaveTextContent('自动重试已达上限');
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name:'关闭' }));
  fireEvent.click(screen.getByRole('button', {name:'重试'}));
  await waitFor(()=>expect(api.retryUserSyncMessage).toHaveBeenCalledWith('event-1'));
});
it('clears stale records when refresh fails', async () => {
  render(<Page />);
  await screen.findByText('暂无匹配的发送记录');
  vi.mocked(api.getUserSyncSummary).mockRejectedValueOnce(new Error('API 不可用'));
  fireEvent.click(screen.getByRole('button',{name:'刷新'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('API 不可用');
  expect(screen.getByRole('button',{name:'全量同步'})).toBeDisabled();
});
