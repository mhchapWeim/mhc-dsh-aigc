import { apiRequest, type BackendPage } from './api-client';
export type UserSyncState = { status: 'Pending' | 'Sent' | 'Failed'; sentAt: string | null; createdAt: string; lastError: string };
export type UserSyncMessage = UserSyncState & { id: string; userId: string; userName: string; employeeNo: string; userVersion: number; batchId: string | null; eventType: string; attempts: number; consecutiveFailures: number; nextAttemptAt: string };
export type UserSyncConnection = { enabled: boolean; host: string; port: number; virtualHost: string; useTls: boolean; exchange: string; exchangeType: string; bindingKey: string; maximumAttempts: number; schemaVersion: number; consumers: Array<{ serviceName: string; queue: string; userName: string }> };
export type UserSyncSummary = { enabled: boolean; pending: number; sent: number; failed: number; lastSentAt: string | null };
export type UserSyncBatch = { id: string; createdAt: string; total: number; sent: number; failed: number };
export const syncStatusNames = { Pending: '待发送', Sent: '已发送至 MQ', Failed: '发送失败' };
export async function getUserSyncConnection(): Promise<UserSyncConnection> {
  const connection = await apiRequest<UserSyncConnection>('/api/users/sync/connection');
  // Older API builds appended configured consumers to a default entry. Queue names identify receivers.
  return { ...connection, consumers: [...new Map(connection.consumers.map(consumer => [consumer.queue, consumer])).values()] };
}
export const getUserSyncSummary = () => apiRequest<UserSyncSummary>('/api/users/sync/summary');
export const getUserSyncBatches = () => apiRequest<UserSyncBatch[]>('/api/users/sync/batches');
export const getUserSyncMessages = (params: URLSearchParams) => apiRequest<BackendPage<UserSyncMessage>>(`/api/users/sync/messages?${params}`);
export const startUserSnapshot = (requestId: string) => apiRequest<{ id: string; total: number }>('/api/users/sync/snapshot', { method: 'POST', body: JSON.stringify({ requestId }) });
export const retryUserSyncMessage = (id: string) => apiRequest<void>(`/api/users/sync/messages/${id}/retry`, { method: 'POST' });
export function userSyncConsumerInfo(connection: UserSyncConnection, index: number): string {
  const consumer = connection.consumers[index];
  return JSON.stringify({ source: 'AIGC', protocol: connection.useTls ? 'amqps' : 'amqp', host: connection.host, port: connection.port,
    virtualHost: connection.virtualHost, exchange: connection.exchange, exchangeType: connection.exchangeType,
    bindingKey: connection.bindingKey, queue: consumer?.queue ?? '', userName: consumer?.userName ?? '',
    password: '消费账号密码请由 MQ 运维单独交付，不使用 AIGC 生产账号', schemaVersion: connection.schemaVersion,
    eventTypes: ['user.upsert', 'user.snapshot', 'user.deleted'], contentType: 'application/json',
    processing: '按 eventId 去重，按 user.id + userVersion 更新；较旧版本不得覆盖较新版本，成功落库后手动 ack。' }, null, 2);
}
