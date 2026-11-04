import { createServer } from 'node:net'
import { expect, it } from 'vitest'
import { developmentDebugPorts } from '../scripts/development-debug-ports.ts'

it('rejects invalid and duplicate explicit debugger ports', async () => {
  await expect(developmentDebugPorts({ DSH_DESKTOP_MAIN_INSPECT_PORT: 'bad' })).rejects.toThrow('integer')
  const ports = await developmentDebugPorts({})
  await expect(developmentDebugPorts({ DSH_DESKTOP_MAIN_INSPECT_PORT: String(ports.mainPort), DSH_DESKTOP_RENDERER_DEBUG_PORT: String(ports.mainPort) })).rejects.toThrow('already in use')
})

it('chooses another default port without disturbing an existing listener', async () => {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no listener')
  try {
    await expect(developmentDebugPorts({ DSH_DESKTOP_MAIN_INSPECT_PORT: String(address.port) })).rejects.toThrow('already in use')
    const ports = await developmentDebugPorts({})
    expect(new Set(Object.values(ports)).size).toBe(3)
    expect(server.listening).toBe(true)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
