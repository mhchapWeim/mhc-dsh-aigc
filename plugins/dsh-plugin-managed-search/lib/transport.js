/** Validate the organization wire result before it reaches the model. */
export function parseSearchResult(value) {
  if (!value || !Array.isArray(value.sources) || typeof value.truncated !== 'boolean') throw new Error('Organization returned an invalid search result');
  return { sources: value.sources.map(source => {
    if (!source || typeof source.url !== 'string') throw new Error('Invalid search source');
    const url = new URL(source.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid search source URL');
    return { url: source.url, ...Object.fromEntries(['title', 'snippet', 'publishedAt'].filter(key => typeof source[key] === 'string').map(key => [key, source[key]])) };
  }), truncated: value.truncated };
}

/** One bounded credential-bearing request; redirects must never forward the token. */
export async function searchOrganization(endpoint, token, request, signal, timeoutMs, send = fetch) {
  const response = await send(`${endpoint}/v1/plugins/search`, {
    method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: request.query, maxResults: request.maxResults ?? 8 }),
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
  });
  if (!response.ok) {
    const error = new Error(response.status === 403 ? '管理员已停用网页搜索或当前用户未获授权' : `Organization search failed (HTTP ${response.status})`);
    error.code = response.status === 401 ? 'WEB_PROVIDER_CREDENTIAL_MISSING' : 'WEB_PROVIDER_ERROR';
    throw error;
  }
  return parseSearchResult(await response.json());
}
