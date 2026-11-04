import { expect, it, vi } from 'vitest';
import { getUserSyncConnection, userSyncConsumerInfo } from './user-sync-api';
import { apiRequest } from './api-client';
vi.mock('./api-client', () => ({ apiRequest: vi.fn() }));
it('shows each queue once when an older API returns the default receiver twice', async () => {
  const consumer = { serviceName: '接收服务一', queue: 'aigc.users.service-1', userName: 'consumer-1' };
  vi.mocked(apiRequest).mockResolvedValue({ host: 'nj304', consumers: [consumer, { ...consumer }] });
  const connection = await getUserSyncConnection();
  expect(connection.consumers).toEqual([consumer]);
  expect(userSyncConsumerInfo(connection, 0)).toContain('consumer-1');
});
it('retains separate services and their copied account information', async () => {
  const a = { serviceName: 'A', queue: 'aigc.users.a', userName: 'consumer-a' };
  const b = { serviceName: 'B', queue: 'aigc.users.b', userName: 'consumer-b' };
  vi.mocked(apiRequest).mockResolvedValue({ host: 'nj304', consumers: [a, a, b] });
  const connection = await getUserSyncConnection();
  expect(connection.consumers).toEqual([a, b]);
  expect(userSyncConsumerInfo(connection, 1)).toContain('consumer-b');
});
