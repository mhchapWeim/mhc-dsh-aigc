/**
 * First-launch extraction of the bundled dsh-ops bash payload into the
 * plugin's provisioned shell store.
 *
 * The Windows installer carries the 163 MSYS payload under
 * `resources/bash-payload/` (assembled by `scripts/bash-payload.mjs` at build
 * time). At startup — before the host backend is spawned, so the dsh-ops
 * plugin's shell ladder sees the copy on its first resolution — this module
 * unpacks it into `$DSH_HOME/dsh-ops/shells/bash/<version>/`, the exact
 * location `provisionedShell()` in the plugin scans. The user never extracts
 * anything by hand, and the AIGC `bashPath` configuration becomes optional.
 *
 * Verification posture, matching the build-time pin end to end:
 * 1. the bundled manifest must match the digests this build was pinned to;
 * 2. the bundled archive must hash to the manifest's digest;
 * 3. after extraction, `bin/bash.exe` must hash to the pinned executable
 *    digest before the version directory is published.
 *
 * Failure is non-fatal by design: a payload problem disables the plugin's
 * bash rung (the plugin degrades to `available: false` with a remedy message)
 * but never blocks the desktop app from starting. Every outcome is logged so
 * an ops report can answer "why is bash missing" from the log directory.
 *
 * @module desktop/src/bash-payload
 */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { join } from 'node:path'

/** Where the payload lives inside the installed app (extraResources root). */
const BASH_PAYLOAD_DIRECTORY = 'bash-payload'

/** The manifest file name the build-time assembler publishes. */
const MANIFEST_FILE = 'bash-payload.json'

/** The receipt file the dsh-ops provisioner writes; mirrored here. */
const RECEIPT_FILE = '.provisioned.json'

/** Receipt schema version, matching the dsh-ops provisioner's shape. */
const RECEIPT_SCHEMA_VERSION = 1

interface BashPayloadManifest {
  readonly schemaVersion: number
  readonly kind: string
  readonly platform: string
  readonly arch: string
  readonly version: string
  readonly archive: string
  readonly archiveSha256: string
  readonly archiveBytes: number
  readonly archiveRoot: string
  readonly executableRelativePath: string
  readonly executableSha256: string
  readonly pluginPackage: string
}

/** One run's outcome, for logs and diagnostics. */
export interface BashPayloadResult {
  readonly outcome: 'ready' | 'installed' | 'absent' | 'failed'
  readonly version?: string
  readonly target?: string
  readonly reason?: string
}

/**
 * SHA-256 of one file, streamed so a 163 MB archive is never held in memory.
 */
async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  const { createReadStream } = await import('node:fs')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Read and validate the bundled payload manifest.
 * @returns the manifest, or undefined with a reason when absent/invalid.
 */
async function readManifest(resourcesRoot: string): Promise<{ manifest?: BashPayloadManifest; reason?: string }> {
  const manifestPath = join(resourcesRoot, BASH_PAYLOAD_DIRECTORY, MANIFEST_FILE)
  let raw: string
  try {
    raw = await fs.readFile(manifestPath, 'utf8')
  } catch {
    return { reason: `manifest not found at ${manifestPath}` }
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    return { reason: `manifest is not valid JSON: ${String(error)}` }
  }
  if (value === null || typeof value !== 'object') return { reason: 'manifest is not an object' }
  const candidate = value as Record<string, unknown>
  const fields: Array<keyof BashPayloadManifest> = [
    'schemaVersion', 'kind', 'platform', 'arch', 'version', 'archive',
    'archiveSha256', 'archiveBytes', 'archiveRoot', 'executableRelativePath', 'executableSha256',
  ]
  for (const field of fields) {
    if (candidate[field] === undefined) return { reason: `manifest field ${String(field)} is missing` }
  }
  const manifest = candidate as unknown as BashPayloadManifest
  if (manifest.schemaVersion !== 1) return { reason: `manifest schemaVersion ${manifest.schemaVersion} is not supported` }
  if (manifest.platform !== 'win32' || manifest.arch !== process.arch) {
    return { reason: `manifest targets ${manifest.platform}-${manifest.arch}, this host is win32-${process.arch}` }
  }
  if (manifest.kind !== 'bash') return { reason: `manifest kind ${manifest.kind} is not bash` }
  if (!/^[0-9a-f]{64}$/u.test(manifest.archiveSha256) || !/^[0-9a-f]{64}$/u.test(manifest.executableSha256)) {
    return { reason: 'manifest digests are not 64 lowercase hex characters' }
  }
  if (manifest.archiveRoot.includes('..') || manifest.executableRelativePath.includes('..')) {
    return { reason: 'manifest paths must stay inside the version directory' }
  }
  return { manifest }
}

/**
 * Extract the archive's single root directory into the target version
 * directory, using Windows' own bsdtar (System32\tar.exe) so no dependency is
 * added and zip-capable extraction is guaranteed on every supported Windows.
 */
async function extractArchive(archive: string, archiveRoot: string, target: string): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
  const tar = join(systemRoot, 'System32', 'tar.exe')
  if (!existsSync(tar)) throw new Error(`no bsdtar at ${tar}`)
  await fs.mkdir(target, { recursive: true })
  const extraction = await new Promise<{ code: number | null; stderr: string }>(resolve => {
    const child = spawn(tar, ['-xf', archive, '-C', target], { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('close', code => resolve({ code, stderr }))
    child.on('error', error => resolve({ code: -1, stderr: String(error) }))
  })
  if (extraction.code !== 0) {
    throw new Error(`bsdtar exited with code ${extraction.code}: ${extraction.stderr.trim().split('\n').slice(-3).join(' | ')}`)
  }
  if (!existsSync(join(target, archiveRoot))) {
    throw new Error(`extraction produced no ${archiveRoot} directory under ${target}`)
  }
}

/**
 * Ensure the bundled bash payload is extracted into the dsh-ops provisioned
 * shell store.
 *
 * Idempotent: an existing receipt whose digests match the manifest short-circuits
 * the work, so steady-state startup pays one small-file read. A mismatched or
 * corrupt store is replaced, not trusted.
 *
 * @param resourcesRoot - `process.resourcesPath` in the packaged app.
 * @param dshHome - the resolved DSH home (`~/.dsh` by default).
 * @param log - sink for informational logging.
 * @returns the outcome and, when installed, the version and target path.
 */
export async function ensureBashPayload(
  resourcesRoot: string,
  dshHome: string,
  log: (message: string) => void = () => undefined,
): Promise<BashPayloadResult> {
  // A payload directory that is absent simply means this build bundles none.
  const payloadRoot = join(resourcesRoot, BASH_PAYLOAD_DIRECTORY)
  const manifestRead = await readManifest(resourcesRoot)
  if (manifestRead.manifest === undefined) {
    if (!existsSync(payloadRoot)) return { outcome: 'absent' }
    return { outcome: 'failed', reason: manifestRead.reason ?? 'Bash payload manifest is unavailable' }
  }
  const manifest = manifestRead.manifest
  const store = join(dshHome, 'dsh-ops', 'shells', 'bash', manifest.version)
  const receiptFile = join(store, RECEIPT_FILE)
  // After publication the archive's root directory IS the version directory,
  // so the executable sits directly at <store>/<executableRelativePath>.
  const executable = join(store, manifest.executableRelativePath)

  // Idempotence: a receipt that matches the manifest and an executable that is
  // still present means the payload is already in place. The receipt uses the
  // plugin provisioner's field names (`sha256` for the archive digest), so the
  // comparison reads exactly what the write below produces.
  try {
    const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8')) as Record<string, unknown>
    if (receipt.sha256 === manifest.archiveSha256
      && receipt.executableSha256 === manifest.executableSha256
      && existsSync(executable)) {
      return { outcome: 'ready', version: manifest.version, target: executable }
    }
    log(`bash payload: receipt at ${receiptFile} does not match the bundled manifest; reinstalling`)
  } catch {
    // No receipt yet — first launch (or a legacy manual install without one).
  }

  const archive = join(payloadRoot, manifest.archive)
  let archiveStat
  try {
    archiveStat = await fs.stat(archive)
  } catch {
    return { outcome: 'failed', reason: `bundled archive not found at ${archive}` }
  }
  if (archiveStat.size !== manifest.archiveBytes) {
    return { outcome: 'failed', reason: `bundled archive size ${archiveStat.size} does not match manifest ${manifest.archiveBytes}` }
  }
  const archiveDigest = await sha256File(archive)
  if (archiveDigest !== manifest.archiveSha256) {
    return { outcome: 'failed', reason: `bundled archive sha256 ${archiveDigest} does not match manifest ${manifest.archiveSha256}` }
  }

  // Extract into a stage directory beside the store, verify, then publish by
  // rename — a partial or failed extraction never becomes the store itself.
  const stageRoot = join(dshHome, 'dsh-ops', 'shells', '.bash-payload-stage')
  await fs.rm(stageRoot, { recursive: true, force: true })
  const stage = join(stageRoot, manifest.version)
  try {
    await extractArchive(archive, manifest.archiveRoot, stage)
    const stagedExecutable = join(stage, manifest.archiveRoot, manifest.executableRelativePath)
    const executableDigest = await sha256File(stagedExecutable)
    if (executableDigest !== manifest.executableSha256) {
      return { outcome: 'failed', reason: `extracted bash.exe sha256 ${executableDigest} does not match manifest ${manifest.executableSha256}` }
    }
    // Remove any previous version directory so the store holds exactly the
    // version this manifest names (the provisioner's own stale-removal policy).
    const versionParent = join(dshHome, 'dsh-ops', 'shells', 'bash')
    await fs.mkdir(versionParent, { recursive: true })
    for (const entry of await fs.readdir(versionParent)) {
      if (entry === manifest.version) continue
      await fs.rm(join(versionParent, entry), { recursive: true, force: true })
      log(`bash payload: removed previous version directory ${entry}`)
    }
    // Windows raises EPERM when rename's destination exists, even after rmSync
    // settles: the directory's metadata can still be held by the scanner that
    // observed the deletion. Retry the rename briefly before giving up — the
    // payload store is only ever written here, so contention is transient.
    await fs.rm(store, { recursive: true, force: true })
    const renamed = join(stage, manifest.archiveRoot)
    let renameError: unknown
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await fs.rename(renamed, store)
        renameError = undefined
        break
      } catch (error) {
        renameError = error
        await new Promise(resolve => setTimeout(resolve, 100 + attempt * 100))
      }
    }
    if (renameError !== undefined) throw renameError
    const receipt = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      name: manifest.kind,
      version: manifest.version,
      releaseTag: null,
      upstreamRepo: null,
      url: null,
      assetFile: manifest.archive,
      bytes: manifest.archiveBytes,
      sha256: manifest.archiveSha256,
      extractor: 'zip',
      extractTo: '.',
      executable: manifest.executableRelativePath,
      executableSha256: manifest.executableSha256,
      provisionedBy: 'desktop bash-payload',
      provisionedAt: new Date().toISOString(),
      dshHome,
    }
    await fs.writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`)
    return { outcome: 'installed', version: manifest.version, target: executable }
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}
