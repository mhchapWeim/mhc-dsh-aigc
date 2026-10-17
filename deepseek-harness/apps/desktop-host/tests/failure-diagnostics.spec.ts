import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { installFailureDiagnostics } from '../src/failure-diagnostics.ts'

it('captures Host errors including circular error details and withdraws the exporter on disposal', async () => {
  const ctx = new Context()
  const records: string[] = []
  installFailureDiagnostics(ctx, record => { records.push(record) })
  await ctx.plugin(() => {})
  const circular: { message: string; self?: object } = { message: 'bad' }
  circular.self = circular
  ctx.logger('upload').error('upload failed', circular)
  expect(records.map(record => JSON.parse(record))).toEqual(expect.arrayContaining([
    expect.objectContaining({ category: 'host-log', operation: 'upload' }),
  ]))
  const before = records.length
  await ctx.fiber.dispose()
  ctx.logger('upload').error('late failure')
  expect(records).toHaveLength(before)
})

it('preserves model recovery delegation and records a failed tool with its name', async () => {
  const ctx = new Context()
  const records: string[] = []
  installFailureDiagnostics(ctx, record => { records.push(record) })
  await ctx.plugin(() => {})
  try {
    const session = { id: 'session-1' } as never
    ctx.emit('session/event', session, { type: 'tool/call', data: {
      name: 'read_file', callId: 'call-1', turn: 1, step: 1, arguments: '{"secret":"must-not-be-recorded"}',
    } } as never)
    ctx.emit('session/event', session, { type: 'tool/result', data: {
      turn: 1, step: 1, message: { toolCallId: 'call-1', isError: true, content: [{ type: 'text', text: 'File not found' }] },
      error: { name: 'Error', code: 'ENOENT', reason: 'File not found' },
    } } as never)
    const result = await ctx.waterfall('agent/request-error', {
      agent: { id: 'agent-1', session: { id: 'session-1' } }, turn: 1, step: 1, provider: 'managed',
      failure: { code: 'TIMEOUT', message: 'timeout' }, signal: new AbortController().signal,
    } as never, async () => ({ kind: 'retry' as const }))
    expect(result).toEqual({ kind: 'retry' })
    const parsed = records.map(record => JSON.parse(record))
    expect(parsed).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'tool', operation: 'read_file', sessionId: 'session-1', operationId: 'call-1' }),
      expect.objectContaining({ category: 'llm', operation: 'managed', operationId: 'agent-1:1:1' }),
    ]))
    expect(records.join('')).not.toContain('must-not-be-recorded')
  } finally { await ctx.fiber.dispose() }
})
