import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules(); vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://aigc.test');
  localStorage.setItem('aigc_hub_access_token', 'test-token');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear(); });

it('uses authenticated POST clicks on internal HTTP browsers without randomUUID', async () => {
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  vi.stubGlobal('crypto', {getRandomValues});
  const fetcher = vi.fn(async () => Response.json({accessUrl: 'https://app.test', counted: true, clicks: {day: 1, week: 1, month: 1, year: 1}}));
  vi.stubGlobal('fetch', fetcher);
  const { getRegisteredAppAccess } = await import('./api-client');
  await getRegisteredAppAccess('app');
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://aigc.test/api/catalog/registered-apps/app/access');
  expect(init.method).toBe('POST');
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token');
  expect(JSON.parse(String(init.body)).visitId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

it.each([
  ['https://cas-sso.aigcplatform.boschhuayu-steering.com', '/.aigc/launch', 'https://cas-sso.aigcplatform.boschhuayu-steering.com/.aigc/launch'],
  ['https://aigc.test', undefined, 'https://aigc.test/cas-sso'],
])('posts the ticket to the requested gateway endpoint at %s', async (gatewayOrigin, launchPath, action) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ gatewayOrigin, launchPath, slug: 'cas-sso', ticket: 'test-ticket' })));
  const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) {
    expect(this.action).toBe(action);
    expect(this.method).toBe('post');
    expect(this.rel).toBe('noopener');
    expect(new FormData(this).get('ticket')).toBe('test-ticket');
  });
  const { submitPublishedLaunch } = await import('./api-client');
  await submitPublishedLaunch('app');
  expect(submit).toHaveBeenCalledOnce();
  expect(document.querySelector('form')).toBeNull();
});
