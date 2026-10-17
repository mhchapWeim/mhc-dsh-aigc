/** Stage a validated signed Windows update for offline transfer to the internal pilot feed. */
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createDesktopUploadPlan } from './desktop-upload-plan.ts'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'

const { values } = parseArgs({
  options: { out: { type: 'string' } },
  allowPositionals: false,
})
if (!values.out || !isAbsolute(values.out)) {
  throw new Error('pilot stage: --out must be a new absolute directory')
}

const environment = loadDesktopPackageEnvironment('win32')
if (environment.DSH_DESKTOP_AUTO_UPDATE_ENV !== 'test'
  || environment.DOWNLOAD_TEST_ORIGIN !== 'https://aigcbackend.boschhuayu-steering.com') {
  throw new Error('pilot stage: .env.windows must select the internal HTTPS test origin')
}

// The existing upload validator requires a bucket name, but this command does not
// contact COS or use any cloud credential. All artifacts are copied locally.
const plan = await createDesktopUploadPlan('win-x64', {
  environment: { ...environment, DOWNLOAD_TEST_COS_BUCKET: 'internal-pilot-staging' },
})
const destination = resolve(values.out)
await mkdir(destination)
for (const artifact of plan.artifacts) {
  const group = artifact.channelMetadata ? 'metadata-last' : 'payload-first'
  const target = join(destination, group, artifact.key)
  await mkdir(resolve(target, '..'), { recursive: true })
  if (artifact.contents === undefined) await copyFile(artifact.path, target)
  else await writeFile(target, artifact.contents, { flag: 'wx' })
}
console.log(`Staged ${plan.version} for ${plan.publicUrl}`)
console.log(`Upload ${join(destination, 'payload-first')} before ${join(destination, 'metadata-last')}.`)
