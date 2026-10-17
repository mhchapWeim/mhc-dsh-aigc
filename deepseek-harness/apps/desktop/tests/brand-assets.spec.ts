import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('keeps browser, welcome, portal, and native icons on the supplied bubble artwork', () => {
  const source = readFileSync(new URL('../../../packages/client/ui-primitives/src/mascot.svg', import.meta.url), 'utf8')
  for (const path of [
    '../../web/public/office-assistant.svg', '../../web/public/favicon.svg', '../../web/public/favicon-dark.svg',
    '../renderer/assets/welcome-brand.svg', '../resources/icon.svg', '../resources/icon-windows.svg', '../resources/icon-macos.svg',
    '../../../../portal/public/wanzai.svg',
  ]) expect(readFileSync(new URL(path, import.meta.url), 'utf8'), path).toBe(source)
  expect(source).toContain('viewBox="0 0 1432 1606"')
  expect(source).toContain('data:image/png;base64,')
  const png = readFileSync(new URL('../resources/icon.png', import.meta.url))
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  expect(png.readUInt32BE(16)).toBe(512)
  expect(png.readUInt32BE(20)).toBe(512)
  for (const path of ['../resources/icon-windows.png', '../resources/icon-macos.png']) {
    expect(readFileSync(new URL(path, import.meta.url)), path).toEqual(png)
  }
})
