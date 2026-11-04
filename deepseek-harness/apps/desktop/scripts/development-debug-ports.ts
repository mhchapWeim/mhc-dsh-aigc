/** Resolve available loopback inspector ports for a development launch. */
import { createServer } from 'node:net'

async function probe(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('desktop development: inspector address unavailable')))
        return
      }
      server.close(error => { if (error) reject(error); else resolve(address.port) })
    })
  })
}

/**
 * Keep available defaults; choose an OS-assigned port when a default is occupied.
 * Explicit environment overrides fail clearly rather than silently changing debugger configuration.
 * @param environment - launcher environment containing optional port overrides.
 * @returns distinct main, renderer and Host ports, checked before Electron starts.
 */
export async function developmentDebugPorts(environment: NodeJS.ProcessEnv): Promise<{ mainPort: number; rendererPort: number; hostPort: number }> {
  const selected = new Set<number>()
  async function select(name: string, fallback: number): Promise<number> {
    const value = environment[name]
    const explicit = value !== undefined && value !== ''
    const wanted = explicit ? Number(value) : fallback
    if (!Number.isSafeInteger(wanted) || wanted < 1 || wanted > 65535)
      throw new Error(`desktop development: ${name} must be an integer from 1 through 65535`)
    let port: number
    try {
      if (selected.has(wanted)) throw Object.assign(new Error('duplicate inspector port'), { code: 'EADDRINUSE' })
      port = await probe(wanted)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') throw error
      if (explicit) throw new Error(`desktop development: ${name}=${wanted} is already in use; close the old development instance or choose another port`, { cause: error })
      do { port = await probe(0) } while (selected.has(port))
    }
    selected.add(port)
    return port
  }
  const mainPort = await select('DSH_DESKTOP_MAIN_INSPECT_PORT', 9229)
  const rendererPort = await select('DSH_DESKTOP_RENDERER_DEBUG_PORT', 9222)
  const hostPort = await select('DSH_DESKTOP_HOST_INSPECT_PORT', 9230)
  return { mainPort, rendererPort, hostPort }
}
