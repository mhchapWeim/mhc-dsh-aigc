import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply } from '../src/index.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('rejects each delimited word and refreshes policy on the next submission', async () => {
  const ctx = new Context()
  Object.defineProperty(ctx, 'credentials', { value: {
    readRecord: async () => ({ kind: 'api-key', key: 'test-user-token' }),
  } })
  let words = ['外传、外发，外泄;泄露']
  const fetchPolicy = vi.fn(async () => Response.json({ words }))
  vi.stubGlobal('fetch', fetchPolicy)
  const fiber = await ctx.plugin({ apply: (scope: Context) => { apply(scope, { baseURL: 'http://localhost' }) } })
  const admission = async (text: string) => ctx.waterfall('api-session/prompt-admit', {
    sessionId: brandString<SessionId>('test-session'), content: [{ type: 'text', text }], signal: new AbortController().signal,
  }, async () => ({ kind: 'allow' as const }))
  try {
    for (const word of ['外传', '外发', '外泄', '泄露']) {
      expect(await admission(word)).toMatchObject({ kind: 'reject', code: 'SENSITIVE_CONTENT' })
    }
    expect(await admission('正常内容')).toEqual({ kind: 'allow' })
    words = ['新增规则']
    expect(await admission('新增规则')).toMatchObject({ kind: 'reject', code: 'SENSITIVE_CONTENT' })
    expect(fetchPolicy).toHaveBeenCalledTimes(6)
  } finally { await fiber.dispose() }
})

it('uses local policy for authorized custom models without a synchronous AIGC request', async () => {
  const ctx = new Context()
  Object.defineProperty(ctx, 'credentials', {value: {readRecord: async () => ({kind: 'api-key', key: 'token'})}})
  // The filter reads the route registry through the service store, so the fake
  // must be provided rather than merely defined as a property.
  ctx.provide('llm', {listProviders: () => [{id: 'personal', name: 'Personal', source: 'custom'},
    {id: 'managed', name: 'External'}]} as never)
  const fetchPolicy = vi.fn(async () => Response.json({words: ['禁止词']}))
  vi.stubGlobal('fetch', fetchPolicy)
  const fiber = await ctx.plugin({apply: (scope: Context) => {apply(scope, {baseURL: 'http://localhost'})}})
  const admission = (provider: string, text: string) => ctx.waterfall('api-session/prompt-admit', {
    sessionId: brandString<SessionId>('custom-session'), provider, content: [{type: 'text', text}], signal: new AbortController().signal,
  }, async () => ({kind: 'allow' as const}))
  try {
    expect(await admission('personal', '自己的模型')).toEqual({kind: 'allow'})
    expect(fetchPolicy).not.toHaveBeenCalled()
    expect(await admission('managed', '组织模型')).toEqual({kind: 'allow'})
    expect(fetchPolicy).toHaveBeenCalledTimes(1)
    expect(await admission('personal', '禁止词')).toMatchObject({kind: 'reject', code: 'SENSITIVE_CONTENT'})
    expect(fetchPolicy).toHaveBeenCalledTimes(1)
  } finally {await fiber.dispose()}
})
