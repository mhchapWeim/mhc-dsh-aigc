import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://aigc.test');
  localStorage.setItem('aigc_hub_access_token', 'test-token');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear(); });

it.each([true, false])('downloads binary or legacy backups with the correct extension: %s', async binary => {
  const fetcher = vi.fn(async () => binary
    ? new Response('archive', { headers: { 'content-type': 'application/gzip' } })
    : Response.json({ payload: '{"version":1}', sha256: 'a'.repeat(64) }));
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:test'); static revokeObjectURL = vi.fn(); });
  let name = '';
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { name = this.download; });
  const { downloadDshBackup } = await import('./api-client');
  await downloadDshBackup('test-id');
  expect(name).toBe(`conversation-backup-test-id.${binary ? 'tar.gz' : 'json'}`);
  expect(fetcher).toHaveBeenCalledWith('https://aigc.test/api/dsh-backups/test-id/download', { headers: { Authorization: 'Bearer test-token' } });
});

it('expires the session when a backup download returns 401', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
  const { downloadDshBackup } = await import('./api-client');
  await expect(downloadDshBackup('id')).rejects.toThrow('登录状态已失效');
  expect(localStorage.getItem('aigc_hub_access_token')).toBeNull();
});
