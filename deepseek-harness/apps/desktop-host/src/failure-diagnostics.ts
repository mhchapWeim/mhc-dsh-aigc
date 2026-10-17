/** Desktop Host failure collectors; only metadata crosses the private Electron channel. */
import { Logger, type Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { inspect } from 'node:util'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-client-connection'

/** @param ctx Running Host. @param publish Private shell delivery, never a renderer or backend. */
export function installFailureDiagnostics(ctx: Context, publish: (record: string) => void): void {
  let username: string | undefined
  let stopped = false
  const context: string[] = []
  const tools = new Map<string, { name: string; started: number }>()
  const remember = (value: string): void => {
    context.push(`${new Date().toISOString()} ${value}`.slice(0, 1024))
    if (context.length > 20) context.shift()
  }
  const send = (fields: object): void => {
    const error = 'error' in fields
      ? (typeof fields.error === 'string' ? fields.error : inspect(fields.error, {
          depth: 3, maxStringLength: 16_384, maxArrayLength: 10,
        })).slice(0, 24_000) : undefined
    if (stopped) return
    const record = { ...fields, error, username: username?.slice(0, 256) ?? null, context: [...context] }
    let encoded = JSON.stringify(record)
    if (encoded.length > 60_000) encoded = JSON.stringify({ ...record, error: error?.slice(0, 12_000), context: [] })
    if (encoded.length <= 60_000) publish(encoded)
  }
  ctx.effect(() => () => { stopped = true })
  ctx.inject(['credentials'], scope => {
    let revision = 0
    const refresh = async (): Promise<void> => {
      const current = ++revision
      try {
        const session = await scope.credentials.readRecord(credentialKey('llm-managed-backend', 'user-session'))
        const user = await scope.credentials.readRecord(credentialKey('llm-managed-backend', 'device-user'))
        if (current !== revision || stopped) return
        const payload = user?.kind === 'grant' ? user.payload : undefined
        username = session?.kind === 'api-key' && typeof payload === 'object' && payload !== null
          && 'username' in payload && typeof payload.username === 'string' ? payload.username : undefined
        send({ category: 'identity', operation: 'login-state' })
      } catch (_credentialUnavailable) {
        if (current === revision && !stopped) {
          username = undefined
          send({ category: 'identity', operation: 'login-state' })
        }
      }
    }
    scope.on('credentials/record-updated', () => { void refresh() })
    void refresh()
  })
  ctx.logger.exporter({ colors: false, levels: { default: 2 }, export(message) {
    const line = Logger.format({ colors: false, maxLength: 16_384, export: () => {},
      formatters: { o: value => inspect(value, { depth: 3, maxStringLength: 16_384, maxArrayLength: 10 }),
        O: value => inspect(value, { depth: 3, maxStringLength: 16_384, maxArrayLength: 10 }) } }, message)
    if (message.type === 'error' || message.type === 'warn') {
      send({ category: 'host-log', operation: message.name, error: line })
    } else remember(`${message.name}: ${message.type}`)
  } })
  ctx.on('agent/error', ({ agent, turn, step, error }) => {
    send({ category: 'agent', operation: 'agent/error', sessionId: agent.session.id,
      operationId: `${agent.id}:${turn}:${step}`, error: inspect(error, { depth: 3, maxStringLength: 16_384 }) })
  })
  ctx.on('agent/request-error', (payload, next) => {
    send({ category: 'llm', operation: payload.provider, sessionId: payload.agent.session.id,
      operationId: `${payload.agent.id}:${payload.turn}:${payload.step}`, error: payload.failure })
    return next()
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/call') {
      if (tools.size >= 1000) tools.delete(tools.keys().next().value!)
      tools.set(`${session.id}:${event.data.callId}`, { name: event.data.name, started: Date.now() })
      remember(`session=${session.id} tool started: ${event.data.name}`)
    }
    if (event.type !== 'tool/result') return
    const key = `${session.id}:${event.data.message.toolCallId}`
    const tool = tools.get(key)
    tools.delete(key)
    if (event.type === 'tool/result' && event.data.message.isError) {
      send({ category: 'tool', operation: tool?.name ?? 'tool/result', sessionId: session.id,
        operationId: String(event.data.message.toolCallId),
        durationMs: tool === undefined ? undefined : Date.now() - tool.started,
        error: event.data.error ?? inspect(event.data.message.content, { depth: 3, maxStringLength: 16_384 }) })
    }
  })
  ctx.on('connection/request', async (request, response, next) => {
    const started = Date.now()
    const operation = `${request.method ?? 'HTTP'} ${(request.url ?? '').split('?')[0]}`
    remember(`request started: ${operation}`)
    let recorded = false
    const failed = (error?: unknown): void => {
      if (recorded) return
      recorded = true
      send({ category: 'http', operation, status: response.statusCode, durationMs: Date.now() - started,
        error: error === undefined ? `HTTP ${response.statusCode}` : inspect(error, { depth: 3, maxStringLength: 16_384 }) })
    }
    const finish = (): void => { if (response.statusCode >= 400) failed() }
    response.once('finish', finish)
    try { await next() } catch (error) { failed(error); throw error }
  })
}
