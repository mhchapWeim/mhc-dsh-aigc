/** Launch desktop development against the local AIGC API. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('dev:desktop:aigc must be started with pnpm run dev:desktop:aigc')
const home = join(process.cwd(), 'apps', 'desktop', '.desktop-build', 'development', 'home-aigc')
const env = {
  ...process.env,
  DSH_MANAGED_BACKEND_INSECURE_HTTP: '1',
  DSH_MANAGED_BACKEND_URL: 'http://localhost:5080',
  DSH_HOME: home,
}

function run(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [pnpm, ...args], {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`dev:desktop:aigc: pnpm ${args.join(' ')} exited with ${String(code ?? 1)}`))
    })
  })
}

console.log(`dev:desktop:aigc DSH_MANAGED_BACKEND_URL=${env.DSH_MANAGED_BACKEND_URL}`)
console.log(`dev:desktop:aigc DSH_HOME=${home}`)
const bundles = join(process.cwd(), 'packages', 'util', 'official-bundles', 'lib', 'index.js')
if (!existsSync(bundles)) {
  console.log('dev:desktop:aigc building workspace artifacts')
  await run(['run', 'build:artifacts'])
}
await run(['--filter', '@deepseek-ai/dsh-desktop', 'run', 'dev'])
