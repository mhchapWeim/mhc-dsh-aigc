/** Validate the assembled application, including native Office conversion outside ASAR. */
import { join } from 'node:path'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'

const paths = resolveDesktopTargetBuildPaths()
const { values } = parseArgs({ options: { unsigned: { type: 'boolean', default: false }, application: { type: 'string' } }, allowPositionals: false })
const target = resolveDesktopBuildTarget()
const windows = target === 'win-x64'
if (values.unsigned && !windows) throw new Error('desktop smoke: unsigned artifacts require Windows')
const artifacts = values.unsigned ? paths.unsignedArtifacts : paths.artifacts
const application = values.application ?? (windows ? join(artifacts, 'win-unpacked')
  : join(artifacts, target === 'mac-arm64' ? 'mac-arm64' : 'mac', '弯崽工作伙伴.app', 'Contents')
)
const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version,
  resolveDesktopPackageTarget(target))
if (windows && !values.unsigned) await verifyWindowsCode(application)
// LibreOffice's Windows native runtime cannot reliably initialize from the very long
// electron-builder output path. Smoke the identical assembled files from a short path.
const shortRoot = windows && application.length > 100 ? await mkdtemp(join(tmpdir(), 'dsh-pkg-')) : undefined
try {
  const smokeApplication = shortRoot === undefined ? application : join(shortRoot, 'app')
  if (shortRoot !== undefined) await cp(application, smokeApplication, { recursive: true })
  const resources = join(smokeApplication, windows ? 'resources' : 'Resources')
  const executable = windows ? join(smokeApplication, 'bhssAiWork.exe') : join(smokeApplication, 'MacOS', '弯崽工作伙伴')
  await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), executable, join(resources, 'runtime'), descriptor)
} finally {
  if (shortRoot !== undefined) await rm(shortRoot, { recursive: true, force: true })
}
