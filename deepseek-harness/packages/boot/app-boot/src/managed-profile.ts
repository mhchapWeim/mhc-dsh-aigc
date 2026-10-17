/** Process-local authorization for bundles installed by the organization controller. */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

const authorized = new Set<string>()
const key = (dir: string, name: string): string => `${resolve(dir)}\0${name}`

/** Authorize a bundle only after a fresh authenticated organization policy.
 * @param dir Profile directory.
 * @param name Bundle package name.
 * @param enabled Whether the current identity may load the bundle.
 */
export function authorizeManagedBundle(dir: string, name: string, enabled: boolean): void {
  if (enabled) authorized.add(key(dir, name))
  else authorized.delete(key(dir, name))
}

/** Whether an organization-owned bundle may contribute to this process.
 * @param dir Profile directory.
 * @param name Bundle package name.
 * @returns True for ordinary bundles, or freshly authorized managed bundles.
 */
export function managedBundleAllowed(dir: string, name: string): boolean {
  const file = join(dir, '.aigc-plugin-state.json')
  if (!existsSync(file)) return true
  const state = JSON.parse(readFileSync(file, 'utf8')) as { packages: Record<string, object> }
  return !Object.hasOwn(state.packages, name) || authorized.has(key(dir, name))
}

/** Read config overrides for the freshly authorized managed bundles.
 * @param dir Profile directory.
 * @returns Literal row config patches, never executable YAML.
 */
export function managedConfigurationPatches(dir: string): PatchOptions[] {
  const file = join(dir, '.aigc-plugin-state.json')
  if (!existsSync(file)) return []
  const state = JSON.parse(readFileSync(file, 'utf8')) as { packages: Record<string, { configuration?: Record<string, object> }> }
  return Object.entries(state.packages).flatMap(([name, record]) => authorized.has(key(dir, name))
    ? Object.entries(record.configuration ?? {}).map(([id, config]) => ({ id, config })) : [])
}
