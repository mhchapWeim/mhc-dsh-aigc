/** Host-side quota admission and durable, idempotent actual-token settlement. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'

const usageSchema = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative() })
const pendingSchema = z.array(z.object({ id: z.string().uuid(), usage: usageSchema }))
const quotaSchema = z.object({ assigned: z.boolean(), remaining: z.number().nonnegative() })
type Pending = z.infer<typeof pendingSchema>[number]

/** Each adapter owns a settlement queue; production credentials make it survive a Host restart. */
export class ManagedTokenBilling {
  private memory: Pending[] = []
  private flushing: Promise<void> | undefined
  private readonly key = credentialKey('llm-managed-backend', 'billing-pending')
  constructor(private readonly ctx: Context, private readonly root: string,
    private readonly token: () => Promise<string>, private readonly request: typeof fetch) {}

  private async call(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const response = await this.request(`${this.root}/v1/billing/${path}`, {
      method, headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new LlmError(response.status === 402
      ? '本周外部模型 token 额度不足或未分配计费配方；可选择内部模型或联系管理员'
      : `外部模型计费服务不可用（HTTP ${response.status}），本次不继续请求`, response.status === 402 ? 'TOKEN_QUOTA_EXCEEDED' : 'BILLING_UNAVAILABLE')
    return await response.json()
  }
  private async pending(): Promise<Pending[]> {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) return this.memory
    const record = await credentials.readRecord(this.key)
    if (record === undefined) return []
    const result = pendingSchema.safeParse(record.kind === 'grant' ? record.payload : undefined)
    if (!result.success) throw new LlmError('计费用量待上报记录无效，请联系管理员', 'BILLING_UNAVAILABLE')
    return result.data
  }
  private async update(entry: Pending, remove = false): Promise<void> {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      this.memory = this.memory.filter(item => item.id !== entry.id)
      if (!remove) this.memory.push(entry)
      return
    }
    await credentials.modifyRecord(this.key, async record => {
      const parsed = record === undefined ? [] : pendingSchema.parse(record.kind === 'grant' ? record.payload : undefined)
      const next = parsed.filter(item => item.id !== entry.id)
      if (!remove) next.push(entry)
      return { kind: 'grant', payload: next }
    })
  }
  private async flush(): Promise<void> {
    if (this.flushing !== undefined) return this.flushing
    this.flushing = (async () => {
      for (const entry of await this.pending()) {
        await this.call(`reservations/${entry.id}`, 'PUT', entry.usage)
        await this.update(entry, true)
      }
    })()
    try { await this.flushing } finally { this.flushing = undefined }
  }
  private actual(usage: TokenUsage): Pending['usage'] {
    // inputTokens excludes cache hits; totalTokens, when supplied, is authoritative.
    return usageSchema.parse({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) })
  }

  async *stream(options: GenerateOptions, _multiplier: string | undefined, run: (options: GenerateOptions) => AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    options.signal?.throwIfAborted()
    await this.flush()
    const quota = quotaSchema.parse(await this.call('quota'))
    // Admit while settled balance is positive; record actual usage after completion.
    if (!quota.assigned || quota.remaining <= 0) throw new LlmError('本周外部模型 tok 额度已用完，请选择内部模型或联系管理员', 'TOKEN_QUOTA_EXCEEDED')
    const id = randomUUID()
    const result = await this.call('reservations', 'POST', { requestId: id, modelIdentifier: options.model, rawTokenBudget: 1 })
    if (typeof result !== 'object' || result === null || !('status' in result) || result.status !== 'Pending')
      throw new LlmError('计费额度预占失败', 'BILLING_UNAVAILABLE')
    let usage: TokenUsage | undefined
    let settled = false
    const settle = async (): Promise<void> => {
      if (settled || usage === undefined) return
      const entry = { id, usage: this.actual(usage) }
      await this.update(entry)
      await this.call(`reservations/${id}`, 'PUT', entry.usage)
      await this.update(entry, true)
      settled = true
    }
    try {
      for await (const chunk of run(options)) {
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish') await settle()
        yield chunk
      }
    } finally {
      if (usage !== undefined) await settle()
      else this.ctx.logger.warn('External model request %s has no actual usage; quota reservation retained for reconciliation', id)
    }
  }
}
