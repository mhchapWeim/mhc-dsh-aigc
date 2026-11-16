import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as Policy from '@deepseek-ai/dsh-token-meter/progress-policy'

describe('task progress policy through Loader', () => {
  it('logs one reminder at each cadence, survives replay, resets each turn and disposes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-progress-'))
    const ctx = new Context()
    try {
      const file = join(root, 'cordis.yml')
      await writeFile(file, [
        "- name: '@deepseek-ai/dsh-session-projection'",
        "- name: '@deepseek-ai/dsh-token-meter'",
        "- name: '@deepseek-ai/dsh-token-meter/progress-policy'",
        '  config:', '    everySteps: 2', '    everyTokens: 100', '',
      ].join('\n'))
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      const modules = new Map<string, unknown>([
        ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
        ['@deepseek-ai/dsh-token-meter', TokenMeter],
        ['@deepseek-ai/dsh-token-meter/progress-policy', Policy],
      ])
      const internal: ModuleLoaderV2 = {
        loadCache: new Map(),
        version: 'v2', async import(name: string) {
          if (!modules.has(name)) throw new Error(`Unexpected plugin ${name}`)
          return modules.get(name)
        },
        register(): never { throw new Error('Unexpected module hook registration') },
        getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
        resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
        load(): never { throw new Error('Unexpected module load') },
      }
      ctx.loader.internal = internal
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
      await ctx.loader.await()
      const session = Session.create(SessionId('progress'))
      session.append('turn/start', { turn: 1 })
      session.append('assistant/message', {
        turn: 1, step: 1, stream: [],
        message: createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: { provider: 'test', model: 'test' } }),
        usage: { inputTokens: 10, cacheReadTokens: 100, outputTokens: 5, totalTokens: 115 },
      }, { surfaceOp: 'append' })
      const compose = async (current: Session, turn: number, step: number) => {
        const agent = { session: current } as Agent
        return agentEvents(ctx, agent).waterfall('agent/pre-step', {
          messages: [], turn, step, signal: new AbortController().signal,
        }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
      }
      const first = await compose(session, 1, 2)
      expect(first.kind).toBe('enter')
      if (first.kind !== 'enter') throw new Error('Expected entry')
      expect(first.messages).toHaveLength(1)
      const block = first.messages[0]?.content[0]
      expect(block?.type).toBe('text')
      if (block?.type !== 'text') throw new Error('Expected progress text')
      expect(block.text).toContain('total 115')
      expect(block.text).toMatchInlineSnapshot('"Task progress: 1 model steps completed in this turn; reported token buckets total 115 (uncached input 10, cache reads 100, cache writes 0, output 5). These are observed main-request buckets, not a complete billing statement or a hard budget. Review the requested deliverables and remaining checks. Reuse verified local results, batch necessary work, and repair only affected parts. If required checks pass, present the result and finish. Avoid optional extensions and repeated unchanged inspections. If work remains, continue the necessary steps and state material limits accurately; do not claim incomplete work is complete."')
      for (const message of first.messages) session.append('user/message', message, { surfaceOp: 'append' })
      expect(await compose(session, 1, 2)).toMatchObject({ messages: [] })
      const replay = Session.create(SessionId('progress-replay'), session.snapshotEvents())
      expect(await compose(replay, 1, 2)).toMatchObject({ messages: [] })
      expect(await compose(session, 1, 3)).toMatchObject({ messages: [expect.anything()] })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      session.append('turn/start', { turn: 2 })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      expect(await compose(session, 2, 1)).toMatchObject({ messages: [] })
      const entry = [...ctx.loader.entries()].find(value => value.options.name.endsWith('/progress-policy'))
      await entry?.fiber?.dispose()
      expect(await compose(session, 2, 3)).toMatchObject({ messages: [] })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects an invalid cadence %s', async (everySteps) => {
    const ctx = new Context()
    try {
      expect(() => { Policy.apply(ctx, { everySteps }) }).toThrow('positive safe integers')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
