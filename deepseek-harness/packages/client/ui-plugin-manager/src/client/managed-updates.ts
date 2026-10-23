/** Restart notices survive page navigation and reconcile after carrier recovery. */
import type { Context } from '@deepseek-ai/cordis'
import type { ManagedPluginUpdate } from '@deepseek-ai/dsh-plugin-manager/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

export class ManagedUpdatesController {
  readonly store = createSnapshotStore<{ updates: readonly ManagedPluginUpdate[] }>({ updates: [] })
  private generation = 0
  private disposed = false
  constructor(private readonly ctx: Context) {}

  /** Adopt a Host event and fence an older snapshot response. */
  accept(updates: readonly ManagedPluginUpdate[]): void {
    if (this.disposed) return
    this.generation++
    this.store.set({ updates })
  }

  /** Reconcile the notice even if the Plugins page has never opened. */
  async refresh(): Promise<void> {
    const generation = ++this.generation
    try {
      const result = await this.ctx.remote.pluginManager.managedUpdates()
      if (!this.disposed && generation === this.generation && result.ok) this.store.set({ updates: result.value })
    } catch (error) { /* A disconnected or older Host must not clear an accepted restart notice. */ }
  }

  /** Stop late Remote completions after the owning Client plugin unloads. */
  dispose(): void { this.disposed = true; this.generation++ }
}
