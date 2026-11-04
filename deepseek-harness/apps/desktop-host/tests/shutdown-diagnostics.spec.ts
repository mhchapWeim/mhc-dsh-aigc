import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { watchShutdown } from '../src/shutdown-diagnostics.ts'

afterEach(() => { vi.useRealTimers() })

it('retains a blocked plugin identity after registry removal, excluding completed siblings and config', async () => {
  vi.useFakeTimers()
  const ctx = new Context()
  const release = Promise.withResolvers<void>()
  await ctx.plugin({ name: 'blocked-connection', apply(inner: Context, _config: { token: string }) {
    inner.effect(() => () => release.promise, 'connection.close')
  } }, { token: 'secret-must-not-appear' })
  await ctx.plugin({ name: 'finished-plugin', apply() {} })
  const lines: string[] = []
  const watcher = watchShutdown(ctx, line => { lines.push(line) })
  const stopping = ctx.fiber.dispose()
  try {
    await vi.advanceTimersByTimeAsync(5000)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('blocked-connection')
    expect(lines[0]).toContain('connection.close')
    expect(lines[0]).toContain('unloading')
    expect(lines[0]).not.toContain('finished-plugin')
    expect(lines[0]).not.toContain('secret-must-not-appear')
    expect([...ctx.registry.values()]).toHaveLength(0)
    watcher.report('timeout')
    expect(lines[1]).toContain('timeout')
  } finally {
    release.resolve()
    await stopping
    watcher.dispose()
  }
  const count = lines.length
  await vi.advanceTimersByTimeAsync(30000)
  expect(lines).toHaveLength(count)
})
