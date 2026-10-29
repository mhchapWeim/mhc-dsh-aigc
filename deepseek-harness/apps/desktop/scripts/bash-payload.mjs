/**
 * Build-time assembly of the dsh-ops bash payload into the desktop package.
 *
 * The Windows bash runtime the dsh-ops plugin uses is a 163 MB distribution
 * the plugin market cannot carry (its upload limit is 32 MB). This module
 * copies the verified ZIP into the installer via extraResources so the
 * desktop app can extract it into the dsh-ops provisioned shell store at
 * first launch — no manual unzip on any user machine.
 *
 * Supply-chain posture: the ZIP is only bundled after its SHA-256 matches the
 * pinned digest in this module, and the manifest published beside it carries
 * the digest the runtime verifier re-checks before extraction. A payload that
 * fails verification fails the build instead of shipping.
 *
 * Everything here is synchronous on purpose: the electron-builder config
 * factory that consumes it is a synchronous function with many synchronous
 * callers (including tests that assert synchronous throws), and build-time
 * local-file I/O of ~160 MB is exactly the workload sync reads handle fine.
 *
 * Enabled by the DSH_DESKTOP_BASH_PAYLOAD environment variable naming the
 * payload ZIP; unset (or platform not win32) bundles nothing, so existing
 * release flows are unchanged.
 *
 * @module desktop/scripts/bash-payload
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'

/** The payload archive name inside resources, matched by the runtime verifier. */
export const BASH_PAYLOAD_ARCHIVE = 'bash-win32-x64.zip'

/** The manifest published beside the archive, matched by the runtime verifier. */
export const BASH_PAYLOAD_MANIFEST = 'bash-payload.json'

/**
 * The single source of truth for the pinned bash payload this distribution
 * carries. Mirrors the dsh-ops plugin's SHELL_UPSTREAM_PINS entry for win32
 * x64: the digest is checked at build time (this module) and again at first
 * launch (the runtime verifier), so a tampered archive can never reach the
 * extraction step.
 */
export const BASH_PAYLOAD_PIN = Object.freeze({
  kind: 'bash',
  platform: 'win32',
  arch: 'x64',
  /** Git for Windows PortableGit release the payload was cut from. */
  version: '2.56.0.2',
  /** SHA-256 of the archive exactly as distributed. */
  sha256: '32cbc0cc3dc1eab5eb8b35c42130d27e6b1244911c4a3161070d99bed1a312ed',
  bytes: 163_443_180,
  /** SHA-256 of bin/bash.exe inside the archive, re-checked after extraction. */
  executableSha256: '6cc575e9112efe6253b6a6999c12aa0240cb3f511aeda3480ae026edc0dc5280',
  /** Root directory inside the archive; extracted to become the version directory. */
  archiveRoot: 'bash-win32-x64',
  /** Path of the executable relative to the archive root. */
  executableRelativePath: 'bin/bash.exe',
})

/**
 * The SHA-256 of one file, streamed so a 163 MB archive is never held in
 * memory (the same shape the dsh-ops provisioner uses).
 * @param {string} file - the file to hash.
 * @returns {string} the lowercase hex digest.
 */
export function sha256File(file) {
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(1024 * 1024)
  const handle = fs.openSync(file, 'r')
  try {
    for (;;) {
      const read = fs.readSync(handle, chunk, 0, chunk.length, null)
      if (read === 0) break
      hash.update(chunk.subarray(0, read))
    }
  } finally {
    fs.closeSync(handle)
  }
  return hash.digest('hex')
}

/**
 * Verify one file's size and SHA-256 against the pin.
 * @param {string} file - the archive to verify.
 * @throws {Error} when the file is missing, the size differs, or the digest differs.
 */
export function verifyBashPayloadArchive(file) {
  let info
  try {
    info = fs.statSync(file)
  } catch {
    throw new Error(`bash payload: archive not found: ${file}`)
  }
  if (!info.isFile()) throw new Error(`bash payload: not a file: ${file}`)
  if (info.size !== BASH_PAYLOAD_PIN.bytes) {
    throw new Error(`bash payload: size mismatch for ${file}: expected ${BASH_PAYLOAD_PIN.bytes} bytes, got ${info.size}`)
  }
  const digest = sha256File(file)
  if (digest !== BASH_PAYLOAD_PIN.sha256) {
    throw new Error(`bash payload: sha256 mismatch for ${file}: expected ${BASH_PAYLOAD_PIN.sha256}, got ${digest}`)
  }
}

/**
 * Resolve the bash payload extraResources entries for one build.
 *
 * Verifies the archive against the pin, then stages the archive plus a
 * generated manifest into the staging directory. The returned entries place
 * both under `resources/bash-payload/`, which is exactly where the runtime
 * verifier looks in the installed app.
 *
 * @param {NodeJS.ProcessEnv} env - packaging environment; only
 *   DSH_DESKTOP_BASH_PAYLOAD is read.
 * @param {string} platform - the resolved target platform (must be win32 to bundle).
 * @param {string} stagingDirectory - directory to stage the archive and manifest into.
 * @returns {{ from: string, to: string }[]} extraResources entries; empty when not bundling.
 * @throws {Error} when the variable names a file that fails verification.
 */
export function bashPayloadExtraResources(env, platform, stagingDirectory) {
  const configured = env.DSH_DESKTOP_BASH_PAYLOAD
  // Bundle only for Windows targets and only when a payload was supplied.
  if (configured === undefined || configured.trim() === '' || platform !== 'win32') return []
  const archive = configured.trim()
  verifyBashPayloadArchive(archive)
  const stage = join(stagingDirectory, 'bash-payload')
  fs.mkdirSync(stage, { recursive: true })
  const stagedArchive = join(stage, BASH_PAYLOAD_ARCHIVE)
  fs.copyFileSync(archive, stagedArchive)
  const manifest = {
    schemaVersion: 1,
    kind: BASH_PAYLOAD_PIN.kind,
    platform: BASH_PAYLOAD_PIN.platform,
    arch: BASH_PAYLOAD_PIN.arch,
    version: BASH_PAYLOAD_PIN.version,
    archive: BASH_PAYLOAD_ARCHIVE,
    archiveSha256: BASH_PAYLOAD_PIN.sha256,
    archiveBytes: BASH_PAYLOAD_PIN.bytes,
    archiveRoot: BASH_PAYLOAD_PIN.archiveRoot,
    executableRelativePath: BASH_PAYLOAD_PIN.executableRelativePath,
    executableSha256: BASH_PAYLOAD_PIN.executableSha256,
    /** Which dsh-ops plugin package this payload was built against. */
    pluginPackage: 'dsh-ops',
    notes: 'extracted into $DSH_HOME/dsh-ops/shells/bash/<version> at first launch by the desktop app',
  }
  fs.writeFileSync(join(stage, BASH_PAYLOAD_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  return [
    { from: stagedArchive, to: `bash-payload/${BASH_PAYLOAD_ARCHIVE}` },
    { from: join(stage, BASH_PAYLOAD_MANIFEST), to: `bash-payload/${BASH_PAYLOAD_MANIFEST}` },
  ]
}
