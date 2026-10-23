import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build, type UserConfig } from 'tsdown'
import { preProcessFile } from 'typescript'
import { expect, it } from 'vitest'

it('bundles main-process helpers that the installer excludes as development dependencies', async () => {
  const output = await mkdtemp(join(tmpdir(), 'dsh-main-bundle-'))
  try {
    const configPath = new URL('../tsdown.config.ts', import.meta.url).href
    const { default: configs } = await import(configPath) as { default: UserConfig[] }
    await build({
      ...configs[0],
      config: false,
      entry: { main: resolve(import.meta.dirname, '../src/main.ts') },
      outDir: output,
      onSuccess: () => {},
    })
    const main = await readFile(join(output, 'main.js'), 'utf8')
    const imports = preProcessFile(main).importedFiles.map(file => file.fileName)
    expect(imports).not.toContain('@deepseek-ai/dsh-home-paths')
    expect(imports).not.toContain('@deepseek-ai/dsh-deepseek-account')
    expect(imports).toContain('electron')
  } finally {
    await rm(output, { recursive: true, force: true })
  }
}, 60_000)
