/** Make the selected Office payload mandatory when pnpm skipped its optional download. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Require the kit's declared engine before copying the runtime. */
export async function ensureOfficeEngine(
  modules: string,
  manifest: { optionalDependencies?: Record<string, string> },
  engine: string,
  runPnpm: (args: readonly string[]) => Promise<void>,
): Promise<void> {
  const name = `@deepseek-ai/libreoffice-kit-${engine}`
  const payload = join(modules, name, 'prebuilds.json')
  if (existsSync(payload)) return
  const version = manifest.optionalDependencies?.[name]
  if (!version) throw new Error(`desktop runtime: LibreOffice kit does not declare ${name}`)
  console.warn(`desktop runtime: optional LibreOffice download was skipped; installing required ${name}@${version}`)
  await runPnpm(['add', '--prod', '--save-exact', `${name}@${version}`])
  if (!existsSync(payload)) {
    throw new Error(`desktop runtime: required LibreOffice engine ${engine} is still missing after installation`)
  }
}
