/** Backend-managed sensitive-word policy for prompt admission and Agent execution. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import OpenCC from 'opencc-js/t2cn'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { SessionPromptAdmissionDecision } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-llm-managed-backend'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

export const name = 'sensitive-word-filter'
export const inject = ['credentials']

/** Deployment endpoint, cache interval, request timeout, and outage behavior. */
export interface Config {
  baseURL?: string
  baseURLEnv?: string
  allowInsecureHTTP?: boolean
  tokenKey?: string
  refreshMs?: number
  requestTimeoutMs?: number
  failureMode?: 'closed' | 'open'
}

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  baseURLEnv: z.string(),
  allowInsecureHTTP: z.boolean().default(false),
  tokenKey: z.string().default('user-session'),
  refreshMs: z.number().default(60_000),
  requestTimeoutMs: z.number().default(10_000),
  failureMode: z.union(['closed', 'open']).default('closed'),
})

type Verdict = 'clear' | 'match' | 'unavailable'
interface SensitiveWordRule { readonly literal: string; readonly separated: RegExp | undefined }

const toSimplifiedChinese = OpenCC.Converter({ from: 't', to: 'cn' })
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' })
const SEPARATOR = String.raw`[\p{P}\p{Z}\s]{0,3}`
const HAS_SEPARATOR = /[\p{P}\p{Z}\s]/u

function apiRoot(value: string, allowInsecureHTTP: boolean): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && (allowInsecureHTTP
      || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))) {
    throw new TypeError('sensitive-word-filter baseURL must be HTTPS or loopback HTTP without credentials, query, or fragment')
  }
  return url.href.replace(/\/+$/u, '')
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`sensitive-word-filter ${name} must be a positive integer`)
  return value
}

function normalize(value: string): string {
  return toSimplifiedChinese(value.normalize('NFKC')).replace(/\p{Cf}/gu, '').toLocaleLowerCase('und')
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }

function rule(literal: string): SensitiveWordRule {
  const characters = Array.from(graphemes.segment(literal), item => item.segment)
  return { literal, separated: characters.length > 1 && !HAS_SEPARATOR.test(literal)
    ? new RegExp(characters.map(escapeRegExp).join(SEPARATOR), 'u') : undefined }
}

function catalog(value: unknown): readonly SensitiveWordRule[] {
  if (typeof value !== 'object' || value === null || !('words' in value) || !Array.isArray(value.words)
    || value.words.length > 10_000
    || value.words.some(word => typeof word !== 'string' || word.trim().length === 0 || word.length > 200)) {
    throw new TypeError('sensitive word backend returned an invalid catalog')
  }
  const words = value.words.flatMap(word => (word as string).split(/[,，、;；\r\n]+/u))
    .map(word => word.trim()).filter(word => word.length > 0).map(normalize)
  if (words.some(word => word.length === 0)) throw new TypeError('sensitive word backend returned an invalid catalog')
  return [...new Set(words)].map(rule)
}

function promptText(content: readonly { readonly type: string; readonly text?: string }[]): string {
  return content.flatMap(part => part.type === 'text' && part.text !== undefined ? [part.text] : []).join('\n')
}

class SensitiveWordCatalog {
  private rules: readonly SensitiveWordRule[] | undefined
  private refreshAfter = 0
  private pending: Promise<readonly SensitiveWordRule[]> | undefined

  constructor(private readonly ctx: Context, private readonly root: string, private readonly tokenKey: string,
    private readonly refreshMs: number, private readonly requestTimeoutMs: number) {}

  async inspect(text: string, signal: AbortSignal, refresh = false): Promise<Verdict> {
    if (text.trim() === '') return 'clear'
    let rules = this.rules
    if (refresh || rules === undefined || Date.now() >= this.refreshAfter) {
      try { rules = await this.refresh() } catch (error) {
        this.ctx.logger.warn(`sensitive-word-filter: catalog refresh failed: ${String(error)}`)
        rules = this.rules
      }
    }
    signal.throwIfAborted()
    if (rules === undefined) return 'unavailable'
    const candidate = normalize(text)
    return rules.some(item => candidate.includes(item.literal) || item.separated?.test(candidate)) ? 'match' : 'clear'
  }

  private refresh(): Promise<readonly SensitiveWordRule[]> {
    this.pending ??= this.fetch().finally(() => { this.pending = undefined })
    return this.pending
  }

  private async fetch(): Promise<readonly SensitiveWordRule[]> {
    const record = await this.ctx.credentials.readRecord(credentialKey('llm-managed-backend', this.tokenKey))
    const backend = this.ctx.get('managedBackend')
    const token = this.tokenKey === 'user-session' && backend?.accessToken !== undefined
      ? await backend.accessToken() : record?.kind === 'api-key' ? record.key?.trim() : undefined
    if (token === undefined || token === '') throw new Error('managed user token is missing')
    const response = await fetch(`${this.root}/v1/sensitive-words`, {
      headers: { authorization: `Bearer ${token}` }, redirect: 'error',
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    if (!response.ok) throw new Error(`backend returned HTTP ${response.status}`)
    const rules = catalog(await response.json())
    this.rules = rules
    this.refreshAfter = Date.now() + this.refreshMs
    return rules
  }
}

/** Install immediate prompt admission and Agent pre-step enforcement. */
export function apply(ctx: Context, config: Config): void {
  const endpoint = config.baseURL
    ?? (config.baseURLEnv === undefined ? undefined : launchEnvironmentOf(ctx).get(config.baseURLEnv)?.value)
  if (endpoint === undefined || endpoint.trim() === '') throw new TypeError('sensitive-word-filter requires baseURL or a populated baseURLEnv')
  const tokenKey = config.tokenKey ?? 'user-session'
  if (tokenKey.trim() === '') throw new TypeError('sensitive-word-filter tokenKey must not be empty')
  const failureMode = config.failureMode ?? 'closed'
  const rules = new SensitiveWordCatalog(ctx, apiRoot(endpoint, config.allowInsecureHTTP ?? false), tokenKey,
    positiveInteger('refreshMs', config.refreshMs ?? 60_000),
    positiveInteger('requestTimeoutMs', config.requestTimeoutMs ?? 10_000))
  const decide = (text: string, signal: AbortSignal): Promise<Verdict> => rules.inspect(text, signal)

  ctx.on('api-session/prompt-admit', async (admission, next): Promise<SessionPromptAdmissionDecision> => {
    const verdict = await rules.inspect(promptText(admission.content), admission.signal, true)
    if (verdict === 'match') return { kind: 'reject', code: 'SENSITIVE_CONTENT', message: '输入内容包含不允许的词语，请修改后重试。' }
    if (verdict === 'unavailable' && failureMode === 'closed') return { kind: 'reject', code: 'POLICY_UNAVAILABLE', message: '内容安全策略暂不可用，请稍后重试。' }
    return next()
  })

  ctx.on('agent/pre-step', async ({ messages, signal }, next): Promise<PreStepDecision> => {
    const text = messages.filter(message => message.source.kind === 'user').flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const verdict = await decide(text, signal)
    if (verdict === 'match' || (verdict === 'unavailable' && failureMode === 'closed')) return { kind: 'reject' }
    return next()
  })
}
