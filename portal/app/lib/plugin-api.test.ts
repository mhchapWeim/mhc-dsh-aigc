import { beforeEach, expect, it, vi } from 'vitest';
import { getPluginReports } from './plugin-api';

const request = vi.hoisted(() => vi.fn());
vi.mock('./api-client', () => ({ apiRequest: request }));
beforeEach(() => { request.mockReset(); });

it('preserves server pagination', async () => {
  const page = { items: [], total: 50, page: 3, pageSize: 20 };
  request.mockResolvedValue(page);
  expect(await getPluginReports(3)).toEqual(page);
  expect(request).toHaveBeenCalledWith('/api/plugins/reports?page=3&pageSize=20');
});

it('paginates legacy arrays instead of passing an undefined items property to the page', async () => {
  const reports = Array.from({ length: 25 }, (_, index) => ({ deviceId: `device-${index}` }));
  request.mockResolvedValue(reports);
  expect(await getPluginReports(1)).toEqual({ items: reports.slice(0, 20), total: 25, page: 1, pageSize: 20, legacyResponse: true });
  expect(await getPluginReports(2)).toEqual({ items: reports.slice(20), total: 25, page: 2, pageSize: 20, legacyResponse: true });
  expect((await getPluginReports(999)).page).toBe(2);
});

it('handles empty legacy results', async () => {
  request.mockResolvedValue([]);
  expect(await getPluginReports()).toEqual({ items: [], total: 0, page: 1, pageSize: 20, legacyResponse: true });
});

it.each([null, {}, { items: null }, { items: [], total: '1', page: 1, pageSize: 20 }])('rejects invalid responses through the existing error state: %j', async result => {
  request.mockResolvedValue(result);
  await expect(getPluginReports()).rejects.toThrow('插件状态接口返回格式无效');
});
