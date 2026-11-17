/** Logged task-progress reminders over the existing token-usage fold. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { z as schema } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { tokenUsageProjectionDefinition } from './usage-projection.ts'

/** Advisory cadence, independent of provider quota enforcement. */
export interface Config {
  /** Remind after each positive number of model steps; omission disables this trigger. */
  everySteps?: number
  /** Remind after each positive number of reported token buckets in this turn, including cache reads. */
  everyTokens?: number
}

export const name = 'task-progress-policy'
export const inject = ['tokenMeter', 'sessionProjections']
export const Config: z<Config> = z.object({
  everySteps: z.number().step(1).min(1),
  everyTokens: z.number().step(1).min(1),
})

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'task-progress': {
      kind: 'task-progress'
      turn: number
      stepBucket: number
      tokenBucket: number
    } & ContextFormed
  }
}

const progressSchema = schema.object({
  turn: schema.number().int().nonnegative(),
  usage: tokenUsageProjectionDefinition.stateSchema,
  stepBucket: schema.number().int().nonnegative(),
  tokenBucket: schema.number().int().nonnegative(),
}).strict()
type ProgressState = schema.infer<typeof progressSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    taskProgress: ProgressState
  }
}

const progressProjection = {
  key: 'taskProgress',
  stateVersion: 1,
  stateSchema: progressSchema,
  init: (): ProgressState => ({ turn: 0, usage: tokenUsageProjectionDefinition.init(), stepBucket: 0, tokenBucket: 0 }),
  apply: (state, event) => {
    if (event.type === 'turn/start') {
      return { turn: event.data.turn, usage: tokenUsageProjectionDefinition.init(), stepBucket: 0, tokenBucket: 0 }
    }
    const usage = tokenUsageProjectionDefinition.apply(state.usage, event)
    if (event.type === 'user/message' && event.data.source.kind === 'task-progress'
      && event.data.source.turn === state.turn) {
      return { ...state, usage, stepBucket: Math.max(state.stepBucket, event.data.source.stepBucket),
        tokenBucket: Math.max(state.tokenBucket, event.data.source.tokenBucket) }
    }
    return usage === state.usage ? state : { ...state, usage }
  },
} satisfies ProjectionDefinition<'taskProgress', ProgressState>

/**
 * Inject replayable progress guidance at configured step or usage crossings.
 * @param ctx - Context with the token meter and agent event declarations.
 * @param config - Optional advisory cadence; omission disables both triggers.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  for (const value of [config.everySteps, config.everyTokens]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error('task-progress-policy: cadences must be positive safe integers')
    }
  }
  const progress = await ctx.sessionProjections.register(progressProjection)
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (config.everySteps === undefined && config.everyTokens === undefined) return decision
    const state = progress.stateOf(agent.session)
    if (state === undefined) throw new Error('task-progress-policy: missing taskProgress projection')
    if (state.turn !== turn) return decision
    const totals = state.usage.totals
    const tokens = totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens
    const stepBucket = config.everySteps === undefined ? 0 : Math.floor((step - 1) / config.everySteps)
    const tokenBucket = config.everyTokens === undefined ? 0 : Math.floor(tokens / config.everyTokens)
    if (stepBucket <= state.stepBucket && tokenBucket <= state.tokenBucket) return decision
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        source: { kind: 'task-progress', form: 'instructions', turn, stepBucket, tokenBucket },
        content: [{ type: 'text', text:
          `Task progress: ${step - 1} model steps completed in this turn; reported token buckets total ${tokens} `
          + `(uncached input ${totals.uncachedInputTokens}, cache reads ${totals.cacheReadTokens}, `
          + `cache writes ${totals.cacheWriteTokens}, output ${totals.outputTokens}). `
          + 'These are observed main-request buckets, not a complete billing statement or a hard budget. '
          + 'Review the requested deliverables and remaining checks. Reuse verified local results, batch necessary work, '
          + 'and repair only affected parts. If required checks pass, present the result and finish. '
          + 'Avoid optional extensions and repeated unchanged inspections. If work remains, continue the necessary steps '
          + 'and state material limits accurately; do not claim incomplete work is complete.',
        }],
      })],
    }
  })
}
