/** Authenticated organization policy reconciliation over the native plugin manager. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { authorizeManagedBundle } from '@deepseek-ai/dsh-app-boot'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { managedVersionCompatible } from './managed-version.ts'
import type { PluginManager } from './index.ts'
import type { PluginInstallRequestId } from './types.ts'

const configuration = z.record(z.string(), z.record(z.string(), z.unknown()))
const packageState = z.object({ sha256: z.string(), configuration })
const stateSchema = z.object({ deviceId: z.string(), packages: z.record(z.string(), packageState) })
const policySchema = z.object({ userId: z.string().uuid(), plugins: z.array(z.object({
  id: z.string().uuid(), packageName: z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
  revision: z.number().int(), enabled: z.boolean(), version: z.string().nullable(), dshVersion: z.string().nullable(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), size: z.number().int().positive().max(32 * 1024 * 1024).nullable(),
  downloadPath: z.string().nullable(), configuration,
})) })

/** Deployment-varying bounds for organization synchronization. */
export interface ManagedSyncOptions {
  pollMs: number
  requestTimeoutMs: number
  dshVersion: string
}

/** Install one cancellable, serial policy loop; no token is persisted in package files.
 * @param ctx Owner context with organization and credentials services.
 * @param manager Native profile package operations.
 * @param dir Application-owned profile directory.
 * @param options Polling and HTTP bounds.
 * @param run Execute only controller-owned mutations through the manager's guard.
 * @param validate Validate configs against the installed bundle's own rows.
 */
export function installManagedPluginSync(ctx: Context, manager: PluginManager, dir: string, options: ManagedSyncOptions,
  run: <T>(operation: () => Promise<T>) => Promise<T>, validate: (name: string, config: Record<string, object>) => void): void {
  ctx.inject(['managedBackend', 'credentials'], scope => {
    scope.effect(() => {
      const lifetime = new AbortController()
      const pendingRestart = new Set<string>()
      let activeInstall: PluginInstallRequestId | undefined
      const activated = new Map<string, string>()
      let wake = new AbortController()
      let identityChanged = false
      scope.on('credentials/record-updated', () => { identityChanged = true; wake.abort() })
      const stateFile = join(dir, '.aigc-plugin-state.json')
      let state: z.infer<typeof stateSchema> = { deviceId: randomUUID(), packages: {} }
      const persist = async (): Promise<void> => { await writeFileAtomic(stateFile, JSON.stringify(state), { mode: 0o600 }) }
      const disable = async (name: string): Promise<void> => {
        activated.delete(name)
        authorizeManagedBundle(dir, name, false)
        const bundle = (await manager.listBundles()).find(item => item.name === name)
        if (bundle?.enabled) {
          const result = await run(() => manager.setBundleEnabled(name, false))
          if (result.application === 'failed') throw new Error(result.error?.diagnostic ?? 'Managed plugin unload failed')
        }
      }
      const disableAll = async (): Promise<void> => {
        for (const name of Object.keys(state.packages)) {
          try { await disable(name) } catch (error) { scope.logger('managed-plugins').error(String(error)) }
        }
      }
      const task = (async () => {
        try { state = stateSchema.parse(JSON.parse(await readFile(stateFile, 'utf8'))) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await persist()
        while (!lifetime.signal.aborted) {
          try {
            if (scope.managedBackend.accessToken !== undefined) await scope.managedBackend.accessToken().catch(error => {
              scope.logger('managed-plugins').warn(String(error))
            })
            const record = await scope.credentials.readRecord(credentialKey('llm-managed-backend', 'user-session'))
            if (record?.kind !== 'api-key') { await disableAll(); }
            else {
              const endpoint = scope.managedBackend.endpoint
              const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
                if (!path.startsWith('/v1/plugins/') || path.includes('..')) throw new Error('Invalid managed plugin URL')
                const response = await fetch(`${endpoint}${path}`, { ...init, redirect: 'error',
                  headers: { authorization: `Bearer ${record.key}`, ...init.headers },
                  signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(options.requestTimeoutMs)]) })
                if (!response.ok) throw new Error(`Plugin control request failed (HTTP ${response.status})`)
                return response
              }
              const policy = policySchema.parse(await (await request('/v1/plugins/policy')).json())
              const names = new Set(policy.plugins.filter(item => item.enabled).map(item => item.packageName))
              for (const name of Object.keys(state.packages)) if (!names.has(name)) await disable(name)
              for (const plugin of policy.plugins) {
                let status = 'Disabled'; let error = ''; let actualVersion = ''
                try {
                  if (!plugin.enabled) { if (state.packages[plugin.packageName]) await disable(plugin.packageName) }
                  else if (!managedVersionCompatible(plugin.dshVersion, options.dshVersion)) { await disable(plugin.packageName); status = 'Incompatible' }
                  else {
                    let bundle = (await manager.listBundles()).find(item => item.name === plugin.packageName)
                    if (bundle?.version !== plugin.version || state.packages[plugin.packageName]?.sha256 !== plugin.sha256) {
                      if (!plugin.downloadPath || !plugin.sha256 || !plugin.size) throw new Error('Incomplete plugin release')
                      const response = await request(plugin.downloadPath)
                      const reader = response.body?.getReader()
                      if (!reader) throw new Error('Empty plugin download')
                      const chunks: Uint8Array[] = []; let length = 0
                      try {
                        while (true) {
                          const next = await reader.read(); if (next.done) break
                          length += next.value.byteLength
                          if (length > plugin.size) throw new Error('Plugin package exceeds declared size')
                          chunks.push(next.value)
                        }
                      } finally { await reader.cancel() }
                      const bytes = Buffer.concat(chunks)
                      if (bytes.length !== plugin.size || createHash('sha256').update(bytes).digest('hex') !== plugin.sha256) throw new Error('Plugin checksum mismatch')
                      const cache = join(dir, '.aigc-packages'); await mkdir(cache, { recursive: true })
                      const tarball = join(cache, `${plugin.sha256}.tgz`)
                      await writeFile(tarball, bytes, { mode: 0o600 })
                      await disable(plugin.packageName)
                      state.packages[plugin.packageName] = { sha256: '', configuration: {} }; await persist()
                      activeInstall = randomUUID() as PluginInstallRequestId
                      const installed = await run(() => manager.installBundle(tarball, { enabled: false, requestId: activeInstall! }))
                      activeInstall = undefined
                      if (installed.application === 'failed') throw new Error(installed.error?.diagnostic ?? installed.packageResult?.output ?? 'Plugin installation failed')
                      if (installed.application === 'restart-required') pendingRestart.add(plugin.packageName)
                      state.packages[plugin.packageName]!.sha256 = plugin.sha256
                    }
                    validate(plugin.packageName, plugin.configuration)
                    state.packages[plugin.packageName] = { sha256: plugin.sha256!, configuration: plugin.configuration }
                    await persist()
                    const currentIdentity = await scope.credentials.readRecord(credentialKey('llm-managed-backend', 'user-session'))
                    if (currentIdentity?.kind !== 'api-key' || currentIdentity.key !== record.key) throw new Error('Organization account changed during plugin synchronization')
                    const signature = `${policy.userId}/${plugin.revision}/${plugin.sha256}`
                    if (pendingRestart.has(plugin.packageName)) status = 'RestartRequired'
                    else if (activated.get(plugin.packageName) === signature) status = 'Active'
                    else {
                      authorizeManagedBundle(dir, plugin.packageName, true)
                      const enabled = await run(() => manager.setBundleEnabled(plugin.packageName, true))
                      if (enabled.application === 'failed') throw new Error(enabled.error?.diagnostic ?? 'Plugin activation failed')
                      status = enabled.application === 'restart-required' ? 'RestartRequired' : 'Active'
                      if (status === 'Active') activated.set(plugin.packageName, signature)
                    }
                    bundle = (await manager.listBundles()).find(item => item.name === plugin.packageName)
                    actualVersion = pendingRestart.has(plugin.packageName) ? '' : bundle?.version ?? ''
                  }
                } catch (failure) {
                  status = 'Failed'; error = failure instanceof Error ? failure.message : String(failure)
                  await disable(plugin.packageName)
                }
                // A switched account must never receive a report authenticated as the previous one.
                const current = await scope.credentials.readRecord(credentialKey('llm-managed-backend', 'user-session'))
                if (current?.kind !== 'api-key' || current.key !== record.key) { await disableAll(); break }
                await request('/v1/plugins/reports', { method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ deviceId: state.deviceId, pluginId: plugin.id, version: actualVersion,
                    revision: plugin.revision, status, error: error.slice(0, 2000) }) })
              }
            }
          } catch (error) {
            if (!lifetime.signal.aborted) { await disableAll(); scope.logger('managed-plugins').warn(String(error)) }
          }
          if (identityChanged) { identityChanged = false; wake = new AbortController(); continue }
          try { await setTimeout(options.pollMs, undefined, { signal: AbortSignal.any([lifetime.signal, wake.signal]) }) }
          catch (error) {
            if (lifetime.signal.aborted) break
            if (!wake.signal.aborted) throw error
          }
          identityChanged = false; wake = new AbortController()
        }
      })().catch(error => { if (!lifetime.signal.aborted) scope.logger('managed-plugins').error(String(error)) })
      return async () => {
        lifetime.abort()
        if (activeInstall !== undefined) await manager.cancelInstall(activeInstall)
        await task
      }
    }, 'managed-plugins: policy synchronization')
  })
}
