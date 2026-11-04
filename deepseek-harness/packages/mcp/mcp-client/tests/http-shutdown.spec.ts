/** Diagnose shutdown while a real SDK HTTP negotiation is awaiting its server. */
import { once } from 'node:events'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mountManagedMcp } from '../src/index.ts'

it.each(['mount', 'host'])('quiesces %s shutdown while a managed MCP HTTP probe receives no response', async target => {
  const requested = Promise.withResolvers<void>()
  const server = createServer(() => { requested.resolve() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No TCP address')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const connection = mountManagedMcp(ctx, {
    transport: 'streamable-http', serverName: 'shutdown-probe',
    url: `http://127.0.0.1:${address.port}/mcp`, headers: {},
    toolCallTimeoutMs: 60_000, failOnStartupError: false,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await requested.promise
    const deadline = new Promise<string>(resolve => { timer = setTimeout(() => resolve('still waiting'), 2000) })
    const closing = target === 'host' ? ctx.fiber.dispose() : connection.dispose()
    expect(await Promise.race([closing.then(() => 'closed'), deadline])).toBe('closed')
  } finally {
    clearTimeout(timer)
    server.closeAllConnections()
    await new Promise<void>(resolve => { server.close(() => resolve()) })
    await ctx.fiber.dispose()
  }
}, 15_000)
