/** Bounded, escalating process shutdown for the long-lived CLI surfaces. */

/** Maximum grace allowed for the application tree to dispose before process exit. */
export const PROCESS_SHUTDOWN_TIMEOUT_MS = 5_000

/** Process-exit controller shared by normal completion and Unix signal handlers. */
export interface ProcessShutdown {
  /** Start or join disposal. Explicit options report cleanup failure and force a nonzero exit; the first call owns them. */
  shutdown(code: number, options?: ShutdownOptions): Promise<void>
  /** Start graceful disposal followed by exit, or force exit when shutdown is already running. */
  interrupt(code: number): void
}

/** The first shutdown request owns the deadline and failure reporting. */
export interface ShutdownOptions {
  timeoutMs: number
  onFailure?: (failure: { reason: 'timeout' | 'dispose-error'; error?: unknown }) => void
}

/**
 * Create one process-exit controller around an application disposer.
 * @param dispose - Whole-application teardown that resolves at quiescence.
 * @param forceExit - Function that exits the process immediately, replaceable by tests.
 * @param complete - Function that records the natural completion code, replaceable by tests.
 * @param timeoutMs - Grace before forced exit, replaceable by tests.
 * @returns A controller whose normal calls coalesce and whose repeated signal call escalates.
 */
export function createProcessShutdown(
  dispose: () => Promise<void>,
  forceExit: (code: number) => void = (code) => { process.exit(code) },
  complete: (code: number) => void = (code) => { process.exitCode = code },
  timeoutMs = PROCESS_SHUTDOWN_TIMEOUT_MS,
): ProcessShutdown {
  let pending: Promise<void> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let completed = false
  let forceExited = false

  const clearExitTimeout = (): void => {
    /* v8 ignore else -- shutdown() arms the timer before any asynchronous exit path can run. */
    if (timeout !== undefined) clearTimeout(timeout)
  }

  const forceExitOnce = (code: number): void => {
    if (forceExited) return
    forceExited = true
    clearExitTimeout()
    forceExit(code)
  }

  const completeOnce = (code: number): void => {
    if (completed || forceExited) return
    completed = true
    clearExitTimeout()
    complete(code)
  }

  const start = (code: number, forceAfterDispose: boolean, options?: ShutdownOptions): Promise<void> => {
    if (pending !== undefined) return pending
    const fail = (reason: 'timeout' | 'dispose-error', error?: unknown): void => {
      if (forceExited || completed) return
      try { options?.onFailure?.({ reason, error }) }
      catch { /* Failure reporting cannot prevent process termination. */ }
      finally { forceExitOnce(options === undefined ? code : code || 1) }
    }
    timeout = setTimeout(() => { fail('timeout') }, options?.timeoutMs ?? timeoutMs)
    pending = Promise.resolve().then(dispose).then(
      () => {
        if (forceAfterDispose) forceExitOnce(code)
        else completeOnce(code)
      },
      (error: unknown) => { fail('dispose-error', error) },
    )
    return pending
  }

  return {
    shutdown(code, options) {
      return start(code, false, options)
    },
    interrupt(code) {
      if (pending !== undefined) {
        forceExitOnce(code)
        return
      }
      void start(code, true)
    },
  }
}
