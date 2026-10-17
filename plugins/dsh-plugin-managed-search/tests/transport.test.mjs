import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchResult, searchOrganization } from '../src/transport.js';

test('keeps real citation fields and rejects malformed sources', () => {
  assert.deepEqual(parseSearchResult({ sources: [{ url: 'https://example.com', title: 'Example', snippet: 'Text' }], truncated: false }), { sources: [{ url: 'https://example.com', title: 'Example', snippet: 'Text' }], truncated: false });
  assert.throws(() => parseSearchResult({ sources: [{ url: 'javascript:alert(1)' }], truncated: false }));
});
test('forwards the user token and result bound while refusing redirects', async () => {
  const result = await searchOrganization('https://aigc.example', 'user-token', { query: '中文搜索', maxResults: 3 }, undefined, 1000, async (url, options) => {
    assert.equal(url, 'https://aigc.example/v1/plugins/search'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer user-token');
    assert.deepEqual(JSON.parse(options.body), { query: '中文搜索', maxResults: 3 });
    return Response.json({ sources: [], truncated: false });
  });
  assert.equal(result.sources.length, 0);
});
test('disabled search never falls back to another vendor', async () => {
  await assert.rejects(searchOrganization('https://aigc.example', 'token', { query: 'x' }, undefined, 1000,
    async () => new Response('', { status: 403 })), /未获授权/);
});
