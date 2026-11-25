import { apiRequest, type GrantOptions, type GrantSelection } from './api-client';

export type PluginVersion = { id: string; version: string; dshVersion: string; sha256: string; size: number; createdAt: string };
export type PluginPilotRelease = { versionId: string; userIds: string[] };
export type ManagedPlugin = { id: string; packageName: string; name: string; description: string; isEnabled: boolean;
  publishedVersionId: string | null; revision: number; configuration: Record<string, Record<string, unknown>>;
  hasServerSecret: boolean; grants: GrantSelection; versions: PluginVersion[]; pilotReleases?: PluginPilotRelease[] };
export type PluginReport = { userId: string; deviceId: string; pluginId: string; version: string; revision: number;
  status: string; error: string; updatedAt: string };
export const getPlugins = () => apiRequest<ManagedPlugin[]>('/api/plugins');
export const getPluginGrantOptions = () => apiRequest<GrantOptions>('/api/plugins/grant-options');
export type PluginReportPage = { items: PluginReport[]; total: number; page: number; pageSize: number; legacyResponse?: boolean };
export const getPluginReports = async (page = 1, pageSize = 5, search = ''): Promise<PluginReportPage> => {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (search.trim()) params.set('search', search.trim());
  const result = await apiRequest<unknown>(`/api/plugins/reports?${params.toString()}`);
  // Older running API instances return a capped array instead of a page.
  if (Array.isArray(result)) {
    const size = Math.min(100, Math.max(1, Math.floor(pageSize)));
    const current = Math.min(Math.max(1, Math.floor(page)), Math.max(1, Math.ceil(result.length / size)));
    return { items: result.slice((current - 1) * size, current * size), total: result.length, page: current, pageSize: size, legacyResponse: true };
  }
  if (!result || typeof result !== 'object' || !('items' in result) || !Array.isArray(result.items)
    || !('total' in result) || !Number.isInteger(result.total) || (result.total as number) < 0
    || !('page' in result) || !Number.isInteger(result.page) || (result.page as number) < 1
    || !('pageSize' in result) || !Number.isInteger(result.pageSize) || (result.pageSize as number) < 1)
    throw new Error('插件状态接口返回格式无效，请检查 AIGC 后端版本并重启后端服务。');
  return result as PluginReportPage;
};
export const publishPlugin = (plugin: ManagedPlugin, serverSecret: string) => apiRequest<void>(`/api/plugins/${plugin.id}/policy`, {
  method: 'PUT', body: JSON.stringify({ name: plugin.name, isEnabled: plugin.isEnabled, versionId: plugin.publishedVersionId,
    configuration: plugin.configuration, grants: plugin.grants, serverSecret, pilotReleases: plugin.pilotReleases }),
});
export const uploadPlugin = (file: File) => {
  const body = new FormData(); body.append('package', file);
  return apiRequest<{ pluginId: string; versionId: string }>('/api/plugins/upload', { method: 'POST', body });
};
