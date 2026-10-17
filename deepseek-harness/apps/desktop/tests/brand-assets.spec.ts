import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'

it('keeps browser, welcome, and native icons on the same supplied Wanzai artwork', () => {
  const source = readFileSync(new URL('../../../packages/client/ui-primitives/src/bhss-mascot.svg', import.meta.url), 'utf8')
  for (const path of [
    '../../web/public/bhss-office-assistant.svg', '../../web/public/favicon.svg', '../../web/public/favicon-dark.svg',
    '../renderer/assets/welcome-brand.svg', '../resources/icon.svg', '../resources/icon-windows.svg', '../resources/icon-macos.svg',
  ]) expect(readFileSync(new URL(path, import.meta.url), 'utf8'), path).toBe(source)
  const embedded = source.match(/data:image\/png;base64,([^"']+)/)?.[1]
  expect(embedded).toBeTruthy()
  const raster = Buffer.from(embedded!, 'base64')
  const digest = createHash('sha256').update(raster).digest('hex')
  for (const path of ['../resources/icon.png', '../resources/icon-windows.png', '../resources/icon-macos.png']) {
    expect(createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex'), path).toBe(digest)
  }
})
