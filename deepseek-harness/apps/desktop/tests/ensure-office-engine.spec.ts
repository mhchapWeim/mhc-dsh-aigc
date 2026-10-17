import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ensureOfficeEngine } from '../scripts/ensure-office-engine.ts'

const roots: string[] = []
const name = '@deepseek-ai/libreoffice-kit-win32-x64'
const manifest = { optionalDependencies: { [name]: '0.0.1' } }
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'office-engine-test-'))
  roots.push(root)
  return root
}
function install(root: string): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'prebuilds.json'), '{}')
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('keeps an already installed target without another download', async () => {
  const root = fixture()
  install(root)
  const run = vi.fn()
  await ensureOfficeEngine(root, manifest, 'win32-x64', run)
  expect(run).not.toHaveBeenCalled()
})
it('installs a skipped engine as a required dependency at the kit declared version', async () => {
  const root = fixture()
  const run = vi.fn(async () => install(root))
  await ensureOfficeEngine(root, manifest, 'win32-x64', run)
  expect(run).toHaveBeenCalledWith(['add', '--prod', '--save-exact', `${name}@0.0.1`])
})
it('stops on download failure instead of copying an incomplete runtime', async () => {
  await expect(ensureOfficeEngine(fixture(), manifest, 'win32-x64', async () => {
    throw new Error('registry unavailable')
  })).rejects.toThrow('registry unavailable')
})
it('rejects a successful install that still has no payload', async () => {
  await expect(ensureOfficeEngine(fixture(), manifest, 'win32-x64', async () => {}))
    .rejects.toThrow('still missing after installation')
})
it('rejects an engine not declared by the kit', async () => {
  await expect(ensureOfficeEngine(fixture(), {}, 'win32-x64', vi.fn()))
    .rejects.toThrow('does not declare')
})

