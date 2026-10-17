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
