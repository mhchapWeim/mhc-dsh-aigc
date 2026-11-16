/**
 * Resolve where the Electron runtime archive comes from.
 *
 * GitHub release assets are frequently answered with a 504 by corporate gateways (the
 * failure that stalled packaging), and `@electron/get` never retries: the download
 * aborts and the whole packaging run is lost. This module keeps the default official
 * source, verifies every archive against the same SHASUMS256 digest Electron publishes,
 * and only redirects to a mirror when one is explicitly configured.
 */

/** A mirror that serves the same artefacts with the same checksums as the official release. */
export type ElectronMirror = { mirror: string; customDir: string }

/** Env var holding the mirror base, e.g. `https://registry.npmmirror.com/-/binary/electron/`. */
export const MIRROR_ENV = 'ELECTRON_MIRROR'

/** Env var overriding the version subdirectory a mirror expects (`44.0.0` by default). */
export const MIRROR_DIR_ENV = 'ELECTRON_MIRROR_CUSTOM_DIR'

/** Env var with the retry budget for a single archive; 1 disables retrying. */
export const RETRY_ENV = 'DSH_ELECTRON_DOWNLOAD_ATTEMPTS'

/** Retry attempts used when the environment does not override it. */
export const DEFAULT_ATTEMPTS = 3

/**
 * Read mirror settings from the environment.
 * @param env - Process environment to inspect.
 * @returns Mirror options for `@electron/get`, or undefined to keep the official source.
 */
export function resolveMirror(env: NodeJS.ProcessEnv = process.env): ElectronMirror | undefined {
  const mirror = env[MIRROR_ENV]?.trim()
  if (mirror === undefined || mirror === '') return undefined
  // Without a trailing slash `@electron/get` concatenates the path incorrectly.
  const base = mirror.endsWith('/') ? mirror : `${mirror}/`
  return { mirror: base, customDir: env[MIRROR_DIR_ENV]?.trim() || '' }
}

/**
 * Read the retry budget, clamped to a small sane range so a bad value cannot hang a build.
 * @param env - Process environment to inspect.
 * @returns Number of attempts, always at least one.
 */
export function resolveAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env[RETRY_ENV] ?? '', 10)
  if (!Number.isFinite(raw)) return DEFAULT_ATTEMPTS
  return Math.min(Math.max(raw, 1), 10)
}

/**
 * Retry an archive download, and sleep with backoff between attempts.
 *
 * Only transport failures are retried: `@electron/get` throws its own HTTPError for a bad
 * status, which a second attempt can plausibly fix, while a checksum mismatch means the
 * bytes are wrong and must surface immediately instead of silently succeeding later.
 * @param action - Download to attempt.
 * @param attempts - Total attempts allowed.
 * @param onRetry - Observer invoked with the attempt number and the failure.
 * @returns The action's result from the first successful attempt.
 */
export async function downloadWithRetry<T>(
  action: () => Promise<T>,
  attempts: number,
  onRetry: (attempt: number, error: unknown) => void,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action()
    } catch (error) {
      lastError = error
      // A corrupt archive will never pass on retry; fail fast rather than hammering the network.
      if (isChecksumMismatch(error)) throw error
      if (attempt === attempts) break
      onRetry(attempt, error)
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(2 ** (attempt - 1), 8) * 1000))
    }
  }
  throw lastError
}

/**
 * Recognise a checksum failure across `sumchecker`'s several error shapes.
 * @param error - Failure thrown by `@electron/get`.
 * @returns True when the archive bytes, not the connection, are wrong.
 */
function isChecksumMismatch(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /checksum|sha256|hash|integrity/iu.test(`${error.message} ${String(error.cause ?? '')}`)
}
