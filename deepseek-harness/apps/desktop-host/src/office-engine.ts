/** Resolve packaged Office engine manifests from their complete, unpacked resource directories. */
import { registerHooks, type ModuleHooks } from 'node:module'
import { realpathSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Locate the archive containing a packaged runtime.
 * @param runtimeDir - Prepared or ASAR-contained runtime directory.
 * @returns Parent archive path, or undefined for a prepared directory.
 */
export function runtimeArchivePath(runtimeDir: string): string | undefined {
  const parent = dirname(runtimeDir)
  return basename(parent) === 'app.asar' ? parent : undefined
}

/**
 * Load the kit API beside its physical engine so require.resolve sees unpacked files; other dependencies stay in ASAR.
 * Hooks apply only to this thread; worker threads must install their own resolver.
 * @param runtimeDir - Prepared or ASAR-contained dsh runtime directory.
 * @returns Installed resolver for the Host lifetime, or undefined for a non-ASAR runtime.
 */
export function installOfficeEngineResolution(runtimeDir: string): ModuleHooks | undefined {
  if (runtimeArchivePath(runtimeDir) === undefined) return undefined
  const root = realpathSync(runtimeDir)
  const archive = dirname(root)
  const source = pathToFileURL(join(root, 'node_modules', '@deepseek-ai', 'libreoffice-kit')).href
  const destination = pathToFileURL(join(`${archive}.unpacked`, relative(archive, root), 'node_modules', '@deepseek-ai', 'libreoffice-kit')).href
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      let resolved
      try { resolved = nextResolve(specifier, context) }
      catch (error) {
        if (!context.parentURL?.startsWith(`${destination}/`)) throw error
        resolved = nextResolve(specifier, { ...context, parentURL: `${source}${context.parentURL.slice(destination.length)}` })
      }
      const api = specifier === '@deepseek-ai/libreoffice-kit' || specifier === '@deepseek-ai/libreoffice-kit/package.json'
      const engine = /^@deepseek-ai\/libreoffice-kit-(?:darwin|win32|linux)-/u.test(specifier)
      if (!api && !engine) return resolved
      const canonical = pathToFileURL(realpathSync(fileURLToPath(resolved.url))).href
      if (!canonical.startsWith(`${source}${engine ? '-' : '/'}`)) {
        if (canonical.startsWith(pathToFileURL(archive + '/').href)) {
          throw new Error(`desktop Office engine resolved outside the runtime package directory: ${resolved.url}`)
        }
        return resolved
      }
      const physical = realpathSync(fileURLToPath(destination + canonical.slice(source.length)))
      return { ...resolved, url: pathToFileURL(physical).href }
    },
  })
}
