/** Independent package through a real Loader, web registry, and credential provider. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { boot } from '@deepseek-ai/dsh-app-boot'
import WebRuntime from '@deepseek-ai/dsh-web'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import * as managedSearch from '../../../../../plugins/dsh-plugin-managed-search/src/index.js'

afterEach(() => vi.restoreAllMocks())

it('loads the independent search plugin, presents citation sources, and removes its provider on disposal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-search-'))
  let shutdown: (() => Promise<void>) | undefined
  try {
    const config = join(dir, 'cordis.yml')
    await writeFile(config, JSON.stringify([
      { id: 'web', name: 'cordis:web', config: { searchProvider: 'aigc-managed' } },
      { id: 'credentials', name: 'cordis:credentials', config: { path: join(dir, 'credentials.yaml'), watch: false } },
      { id: 'search', name: 'cordis:search', config: { requestTimeoutMs: 1000 } },
    ]))
    const ctx = await boot('test', config, [], ctx => {
      ctx.loader.builtins.web = WebRuntime
      ctx.loader.builtins.credentials = CredentialsLocal
      ctx.loader.builtins.search = managedSearch
      ctx.provide('managedBackend', { endpoint: 'https://aigc.example' })
    })
    shutdown = async () => { await ctx.fiber.dispose() }
    await ctx.credentials.modifyRecord(credentialKey('llm-managed-backend', 'user-session'), async () => ({ kind: 'api-key', key: 'user-token' }))
    const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ sources: [{ url: 'https://example.com', title: '来源', snippet: '搜索摘要' }], truncated: false }))
    expect(await ctx.web.search({ query: '中文问题', maxResults: 2 })).toMatchObject({ sources: [{ title: '来源', snippet: '搜索摘要' }] })
    expect(send.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer user-token' } })
    const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'search')
    await entry?.fiber?.dispose()
    await expect(ctx.web.search({ query: '中文问题' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
  } finally { await shutdown?.(); await rm(dir, { recursive: true, force: true }) }
})
