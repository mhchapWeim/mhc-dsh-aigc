/** Keep lifecycle observations alive after the plugin tree withdraws its log exporter. */
import { FiberState, type Context, type Fiber } from '@deepseek-ai/cordis'

/**
 * Snapshot fiber identities before disposal removes them from the registry.
 * Reports contain lifecycle metadata only, never plugin config or credentials.
 * @param ctx Running profile root.
 * @param write Synchronous shell-owned diagnostic sink, available during teardown.
 * @returns Reporter to call before forced exit and dispose after successful teardown.
 */
export function watchShutdown(ctx: Context, write: (line: string) => void): {
  report(reason: string): void
  dispose(): void
} {
  const started = Date.now()
  const fibers = new Set<Fiber>([ctx.fiber])
  for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) fibers.add(fiber)
  const entries = [...fibers].map(fiber => ({
    fiber,
    name: (fiber.runtime?.name ?? (fiber === ctx.fiber ? 'profile-root' : 'anonymous')).slice(0, 160),
    uid: fiber.uid,
    // These are candidates, not a claim that each individual effect is blocked.
    effectsBeforeShutdown: fiber.getEffects().map(effect => effect.label.slice(0, 160)).slice(0, 12),
  }))
  const state = (fiber: Fiber): string => {
    switch (fiber.state) {
      case FiberState.LOADING: return 'loading'
      case FiberState.UNLOADING: return 'unloading'
      case FiberState.DISPOSED: return 'disposed'
      case FiberState.ACTIVE: return 'active'
      case FiberState.FAILED: return 'failed'
      default: return 'pending'
    }
  }
  const report = (reason: string): void => {
    const pending = entries.filter(({ fiber }) => fiber.inertia !== undefined || fiber.state !== FiberState.DISPOSED)
    write(`desktop shutdown progress: ${JSON.stringify({ reason, elapsedMs: Date.now() - started,
      pendingCount: pending.length, truncated: pending.length > 100,
      pending: pending.slice(0, 100).map(({ fiber, ...entry }) => ({ ...entry,
        state: state(fiber), lifecyclePending: fiber.inertia !== undefined })),
    })}\n`)
  }
  // These timers must not prolong an otherwise completed shutdown.
  const timers = [5000, 25000].map(delay => {
    const timer = setTimeout(() => { report('still-stopping') }, delay)
    timer.unref()
    return timer
  })
  return { report, dispose() { for (const timer of timers) clearTimeout(timer) } }
}
