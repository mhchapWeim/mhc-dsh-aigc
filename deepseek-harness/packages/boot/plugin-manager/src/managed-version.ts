/** Match a plugin API baseline independently of a desktop publishing suffix. */
const buildSuffix = /^20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\.[1-9]\d*$/u

/**
 * Accept an exact runtime or its documented date/sequence desktop builds.
 * @param required Plugin-declared DSH API version, never a version range.
 * @param installed Installation manifest version, independent of Electron's feed version.
 * @returns Whether the same baseline is present; other prereleases remain incompatible.
 */
export function managedVersionCompatible(required: string | null, installed: string): boolean {
  if (required === null) return false
  if (required === installed) return true
  const prefix = required.includes('-') ? `${required}.` : `${required}-test.`
  return installed.startsWith(prefix) && buildSuffix.test(installed.slice(prefix.length))
}
