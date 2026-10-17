/** Publishes organization credentials only over the private Electron child channel. */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout } from 'node:timers/promises'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm-managed-backend'

/**
 * Follow login/logout without forwarding the backend token to a renderer.
 * @param ctx - Host context with managed-backend and credential providers.
 * @param publish - Private IPC delivery to the owning Electron process.
 */
export function installManagedSessionPublisher(ctx: Context, publish: (session: { endpoint: string; token: string } | null) => void): void {
  ctx.inject(['credentials', 'managedBackend'], scope => {
    scope.effect(() => {
      const lifetime = new AbortController()
      let previous = ''
      const pending = (async () => {
        try {
          while (!lifetime.signal.aborted) {
            try {
              const record = await scope.credentials.readRecord(credentialKey('llm-managed-backend', 'user-session'))
              if (lifetime.signal.aborted) break
              const token = scope.managedBackend.accessToken === undefined
                ? record?.kind === 'api-key' ? record.key : undefined
                : await scope.managedBackend.accessToken().catch(() => undefined)
              const next = token ?? ''
              if (next !== previous) { previous = next; publish(token ? { endpoint: scope.managedBackend.endpoint, token } : null) }
            } catch (error) {
              if (!lifetime.signal.aborted) {
                previous = ''; publish(null)
                scope.logger('desktop-managed').warn(String(error))
              }
            }
            await setTimeout(5000, undefined, { signal: lifetime.signal })
          }
        } catch (error) {
          if (!lifetime.signal.aborted) scope.logger('desktop-managed').warn(String(error))
        } finally { publish(null) }
      })()
      return async () => { lifetime.abort(); await pending }
    })
  })
}
