/**
 * Organization sign-in plugin, browser half. Authentication is selected
 * manually from the account menu; startup and Host reconnection never open
 * an authentication dialog or initiate a browser login.
 *
 * Export discipline: packages/client/AGENTS.md.
 */

import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the shell's SlotMap merge for the account launcher.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.remote merge (the `credentials` namespace).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ManagedAuthState } from '@deepseek-ai/dsh-api-settings-controller/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { ManagedAccountMenu } from './ManagedAccountMenu.tsx'
import type { ManagedSignInInjected } from './ManagedSignInDialog.tsx'
import { en, zh } from './locales.ts'
import type { ManagedAccountKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.managedAccount': ManagedAccountKey }
}

/** Services required by manual organization sign-in. */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'remote.workspace']

/**
 * Reject a refused Remote call so the dialog's catch renders one failure copy.
 * @param result - settled Remote result.
 * @returns the Host method's business value.
 */
function accepted<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw result.error
  return result.value
}

/**
 * Register the manual organization account menu.
 * @param ctx - client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('settings.managedAccount', { en, zh }), 'managed-account: dictionaries')
  const t = ctx.locale.bind('settings.managedAccount')
  const injected: ManagedSignInInjected = {
    t,
    data: {
      cloud: {
        async measure(ids) {
          return accepted(await ctx.remote.workspace.measureCloudBackup(ids === undefined ? {} : {
            sessionIds: ids.map(id => SessionId(id)),
          }))
        },
        async list(page) { return accepted(await ctx.remote.workspace.cloudBackups(page)) },
        async upload(ids) {
          const status = ids === undefined ? undefined : accepted(await ctx.remote.workspace.dataStatus())
          return accepted(await ctx.remote.workspace.uploadCloudBackup(ids === undefined ? {} : {
            sessionIds: status!.sessions.filter(item => ids.includes(item.sessionId)).map(item => item.sessionId),
          }))
        },
        async restore(id, targetPath) {
          const result = accepted(await ctx.remote.workspace.restoreCloudBackup({ id, targetPath }))
          await ctx.get('sessions')?.refresh()
          return result
        },
        async remove(id) { accepted(await ctx.remote.workspace.deleteCloudBackup(id)) },
      },
      async status() { return accepted(await ctx.remote.workspace.dataStatus()) },
      async preview(request) { return accepted(await ctx.remote.workspace.previewMigration(request)) },
      async commit(migrationId) {
        const result = accepted(await ctx.remote.workspace.commitMigration({ migrationId }))
        await ctx.get('sessions')?.refresh()
        return result
      },
      async repair(workspaceId) { accepted(await ctx.remote.workspace.repairDirectory({ workspaceId: workspaceId as WorkspaceId })) },
      async remove(workspaceId) { accepted(await ctx.remote.workspace.delete({ workspaceId: workspaceId as WorkspaceId })) },
      async forgetMissing() { accepted(await ctx.remote.workspace.forgetMissingSessions()) },
    },
    async status(): Promise<ManagedAuthState> {
      return accepted(await ctx.remote.credentials.managedStatus())
    },
    async login(username, password): Promise<ManagedAuthState> {
      return accepted(await ctx.remote.credentials.managedLogin(username, password))
    },
    async casStart() {
      return accepted(await ctx.remote.credentials.managedCasStart())
    },
    async casPoll(deviceCode): Promise<ManagedAuthState | null> {
      return accepted(await ctx.remote.credentials.managedCasPoll(deviceCode))
    },
    async logout(): Promise<string | null> {
      return accepted(await ctx.remote.credentials.managedLogout())
    },
  }
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({
    name: 'settings.launcher',
    locale: 'settings.managedAccount', inject: () => injected,
  }, ManagedAccountMenu))
}
