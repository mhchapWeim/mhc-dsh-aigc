/** Authenticated organization policy reconciliation over the native plugin manager. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { authorizeManagedBundle, isManagedBundleAuthorized } from '@deepseek-ai/dsh-app-boot'
import { writeFileAtomic, WriterLockTimeoutError } from '@deepseek-ai/dsh-atomic-write'
import { managedVersionCompatible } from './managed-version.ts'
import type { PluginManager } from './index.ts'
import type { ManagedPluginUpdate, PluginInstallRequestId } from './types.ts'

const configuration = z.record(z.string(), z.record(z.string(), z.unknown()))
type WritePhase = 'replace' | 'activate' | 'deactivate'
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
  /** Delay before retrying a poll that could not take the profile write lock. */
  lockRetryMs: number
}

/** Install one cancellable, serial policy loop; no token is persisted in package files.
 * @param ctx Owner context with organization and credentials services.
 * @param manager Native profile package operations.
 * @param dir Application-owned profile directory.
 * @param options Polling and HTTP bounds.
 * @param run Execute only controller-owned mutations through the manager's guard.
 * @param replace Hold the profile write lock across deactivation and installation of a verified package.
 * @param validate Validate configs against the installed bundle's own rows.
 * @param publish Publish verified releases requiring restart, without secret configuration.
 */
export function installManagedPluginSync(ctx: Context, manager: PluginManager, dir: string, options: ManagedSyncOptions,
  run: <T>(operation: () => Promise<T>) => Promise<T>, replace: (operation: () => Promise<void>) => Promise<void>,
  validate: (name: string, config: Record<string, object>) => void,
  publish: (updates: readonly ManagedPluginUpdate[]) => void): void {
  ctx.inject(['managedBackend', 'credentials'], scope => {
    scope.effect(() => {
      const lifetime = new AbortController()
      const pendingRestart = new Set<string>()
      const notices = new Map<string, ManagedPluginUpdate>()
      const updateNotice = (name: string, version?: string): void => {
        const before = notices.get(name)?.version
        if (before === version) return
        if (version === undefined) notices.delete(name)
        else notices.set(name, { packageName: name, version })
        publish([...notices.values()].sort((a, b) => a.packageName.localeCompare(b.packageName)))
      }
      let activeInstall: PluginInstallRequestId | undefined
      const deferredWrites = new Map<string, { phase: WritePhase; since: number; attempts: number }>()
      const deferWrite = async (name: string, phase: WritePhase, error: WriterLockTimeoutError): Promise<void> => {
        const previous = deferredWrites.get(name)
        deferredWrites.set(name, { phase, since: previous?.since ?? performance.now(), attempts: (previous?.attempts ?? 0) + 1 })
        if (previous?.phase === phase) return
        // The owner can change between the failed acquisition and this read. Never log the raw record.
        const record = await readFile(error.lockPath, 'utf8').catch(() => undefined)
        const pid = record?.match(/^([1-9]\d{0,9})\n$/u)?.[1]
        scope.logger('managed-plugins').warn(
          `Profile write lock busy: plugin=${name} phase=${phase} observedOwnerPid=${pid ?? 'unknown'} retryMs=${options.lockRetryMs}`,
        )
      }
      const finishDeferredWrite = (name: string, outcome: string): void => {
        const previous = deferredWrites.get(name)
        if (previous === undefined) return
        deferredWrites.delete(name)
        scope.logger('managed-plugins').warn(
          `Deferred profile write finished: plugin=${name} phase=${previous.phase} attempts=${previous.attempts} elapsedMs=${Math.round(performance.now() - previous.since)} outcome=${outcome}`,
        )
      }
      const activated = new Map<string, string>()
      let wake = new AbortController()
      let identityChanged = false
      scope.on('credentials/record-updated', key => {
        if (key !== credentialKey('llm-managed-backend', 'user-session')) return
        identityChanged = true; wake.abort()
      })
      const stateFile = join(dir, '.aigc-plugin-state.json')
      let state: z.infer<typeof stateSchema> = { deviceId: randomUUID(), packages: {} }
      const persist = async (): Promise<void> => { await writeFileAtomic(stateFile, JSON.stringify(state), { mode: 0o600 }) }
      const disable = async (name: string): Promise<void> => {
        updateNotice(name)
        const priorActivation = activated.get(name)
        activated.delete(name)
        const wasAuthorized = isManagedBundleAuthorized(dir, name)
        authorizeManagedBundle(dir, name, false)
        const bundle = (await manager.listBundles()).find(item => item.name === name)
        if (bundle?.enabled) {
          let result: Awaited<ReturnType<PluginManager['setBundleEnabled']>>
          try {
            result = await run(() => manager.setBundleEnabled(name, false))
          } catch (error) {
            // The bundle is still enabled on disk, so withdrawing the
            // entitlement would unload a working plugin over a transient
            // failure. Restore the pre-call state and let the next poll retry.
            if (wasAuthorized) authorizeManagedBundle(dir, name, true)
            if (priorActivation !== undefined) activated.set(name, priorActivation)
            throw error
          }
          if (result.application === 'failed') throw new Error(result.error?.diagnostic ?? 'Managed plugin unload failed')
        }
      }
      const disableAll = async (): Promise<void> => {
        for (const name of Object.keys(state.packages)) {
          try { await disable(name) } catch (error) { scope.logger('managed-plugins').error(String(error)) }
        }
      }
      // A profile write lock that somebody else holds is an infrastructure
      // condition, not evidence about the plugin: reporting it as a failure
      // would withdraw an entitlement the policy still grants, and withdrawing
      // it de-authorizes the bundle for this whole process even though the
      // plugin is intact. Skips are therefore left unreported, so the next poll
      // retries them and the previous status stands meanwhile.
      const lockContended = (error: unknown): error is WriterLockTimeoutError => error instanceof WriterLockTimeoutError
      const task = (async () => {
        try { state = stateSchema.parse(JSON.parse(await readFile(stateFile, 'utf8'))) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await persist()
        while (!lifetime.signal.aborted) {
          let contended = false
          try {
            if (scope.managedBackend.accessToken !== undefined) await scope.managedBackend.accessToken().catch(error => {
              scope.logger('managed-plugins').warn(String(error))
            })
            const record = await scope.credentials.readRecord(credentialKey('llm-managed-backend', 'user-session'))
            if (record?.kind !== 'api-key') { await disableAll(); }
            else {
              const endpoint = scope.managedBackend.endpoint
              const request = async (stage: 'policy' | 'download' | 'report', path: string, init: RequestInit = {}): Promise<Response> => {
                if (!path.startsWith('/v1/plugins/') || path.includes('..')) throw new Error('Invalid managed plugin URL')
                const timeout = AbortSignal.timeout(options.requestTimeoutMs)
                const response = await fetch(`${endpoint}${path}`, { ...init, redirect: 'error',
                  headers: { authorization: `Bearer ${record.key}`, 'x-dsh-runtime-version': options.dshVersion, ...init.headers },
                  signal: AbortSignal.any([lifetime.signal, timeout]) })
                  .catch(() => { throw new Error(`Managed plugin ${stage} request failed (${timeout.aborted ? 'timeout' : 'transport'})`) })
                if (!response.ok) throw new Error(`Managed plugin ${stage} request failed (HTTP ${response.status})`)
                return response
              }
              const policy = policySchema.parse(await (await request('policy', '/v1/plugins/policy')).json())
              const names = new Set(policy.plugins.map(item => item.packageName))
              for (const name of Object.keys(state.packages)) {
                if (names.has(name)) continue
                try {
                  await disable(name)
                  finishDeferredWrite(name, 'Disabled')
                } catch (error) {
                  if (!lockContended(error)) throw error
                  contended = true
                  await deferWrite(name, 'deactivate', error)
                }
              }
              for (const plugin of policy.plugins) {
                let status = 'Disabled'; let error = ''; let actualVersion = ''; let skipped = false
                let phase: WritePhase = 'deactivate'
                try {
                  if (!plugin.enabled) { if (state.packages[plugin.packageName]) await disable(plugin.packageName) }
                  else if (!managedVersionCompatible(plugin.dshVersion, options.dshVersion)) { await disable(plugin.packageName); status = 'Incompatible' }
                  else {
                    let bundle = (await manager.listBundles()).find(item => item.name === plugin.packageName)
                    if (bundle?.version !== plugin.version || state.packages[plugin.packageName]?.sha256 !== plugin.sha256) {
                      if (!plugin.downloadPath || !plugin.sha256 || !plugin.size) throw new Error('Incomplete plugin release')
                      const response = await request('download', plugin.downloadPath).catch((downloadError: unknown) => {
                        if (!lifetime.signal.aborted) {
                          scope.logger('managed-plugins').warn(`Could not download managed plugin ${plugin.packageName}: ${String(downloadError)}`)
                        }
                        throw downloadError
                      })
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
                      phase = 'replace'
                      await replace(async () => {
                        lifetime.signal.throwIfAborted()
                        await disable(plugin.packageName)
                        lifetime.signal.throwIfAborted()
                        state.packages[plugin.packageName] = { sha256: '', configuration: {} }; await persist()
                        lifetime.signal.throwIfAborted()
                        const requestId = randomUUID() as PluginInstallRequestId
                        activeInstall = requestId
                        try {
                          const installed = await run(() => manager.installBundle(tarball, { enabled: false, requestId }))
                          lifetime.signal.throwIfAborted()
                          if (installed.application === 'failed') throw new Error(installed.error?.diagnostic ?? installed.packageResult?.output ?? 'Plugin installation failed')
                          if (installed.application === 'restart-required') pendingRestart.add(plugin.packageName)
                          state.packages[plugin.packageName]!.sha256 = plugin.sha256!
                        } finally { activeInstall = undefined }
                      })
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
                      phase = 'activate'
                      const alreadyAuthorized = isManagedBundleAuthorized(dir, plugin.packageName)
                      authorizeManagedBundle(dir, plugin.packageName, true)
                      let enabled: Awaited<ReturnType<PluginManager['setBundleEnabled']>>
                      try {
                        enabled = await run(() => manager.setBundleEnabled(plugin.packageName, true))
                      } catch (error) {
                        // Activation persisted nothing, so restoring the
                        // pre-call authorization keeps a transient lock from
                        // both removing the entitlement and de-authorizing.
                        if (!alreadyAuthorized) authorizeManagedBundle(dir, plugin.packageName, false)
                        throw error
                      }
                      if (enabled.application === 'failed') throw new Error(enabled.error?.diagnostic ?? 'Plugin activation failed')
                      status = enabled.application === 'restart-required' ? 'RestartRequired' : 'Active'
                      if (status === 'Active') activated.set(plugin.packageName, signature)
                    }
                    bundle = (await manager.listBundles()).find(item => item.name === plugin.packageName)
                    actualVersion = pendingRestart.has(plugin.packageName) ? '' : bundle?.version ?? ''
                  }
                } catch (failure) {
                  if (lifetime.signal.aborted) break
                  // A contended profile lock says nothing about the plugin, so
                  // it must not withdraw the entitlement or de-authorize the
                  // bundle; leaving the status unreported lets the next poll
                  // retry with the previous status standing. The account check
                  // below still runs, because a lock conflict is not permission
                  // to skip an identity change.
                  if (lockContended(failure)) {
                    contended = true
                    skipped = true
                    await deferWrite(plugin.packageName, phase, failure)
                  } else {
                    status = 'Failed'; error = failure instanceof Error ? failure.message : String(failure)
                    try { await disable(plugin.packageName) }
                    catch (cleanupError) {
                      if (!lockContended(cleanupError)) throw cleanupError
                      contended = true
                      skipped = true
                      await deferWrite(plugin.packageName, 'deactivate', cleanupError)
                    }
                  }
                }
                // A switched account must never receive a report authenticated as the previous one.
                const current = await scope.credentials.readRecord(credentialKey('llm-managed-backend', 'user-session'))
                if (current?.kind !== 'api-key' || current.key !== record.key) { await disableAll(); break }
                if (skipped) continue
                finishDeferredWrite(plugin.packageName, status)
                updateNotice(plugin.packageName, status === 'RestartRequired' ? plugin.version ?? undefined : undefined)
                try {
                  await request('report', '/v1/plugins/reports', { method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ deviceId: state.deviceId, pluginId: plugin.id, version: actualVersion,
                      revision: plugin.revision, status, error: error.slice(0, 2000) }) })
                } catch (reportError) {
                  if (lifetime.signal.aborted) break
                  scope.logger('managed-plugins').warn(`Could not report managed plugin ${plugin.packageName}: ${String(reportError)}`)
                }
              }
            }
          } catch (error) {
            // A lock held by another process is not a policy verdict: retry on
            // the next poll instead of withdrawing every managed entitlement.
            if (!lifetime.signal.aborted && !lockContended(error)) { await disableAll(); scope.logger('managed-plugins').warn(String(error)) }
            else if (!lifetime.signal.aborted) {
              scope.logger('managed-plugins').warn(`profile write lock busy; delaying policy reconciliation: ${String(error)}`)
            }
          }
          if (identityChanged) { identityChanged = false; wake = new AbortController(); continue }
          const nextPollMs = contended ? options.lockRetryMs : options.pollMs
          try { await setTimeout(nextPollMs, undefined, { signal: AbortSignal.any([lifetime.signal, wake.signal]) }) }
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
        publish([])
      }
    }, 'managed-plugins: policy synchronization')
  })
}
