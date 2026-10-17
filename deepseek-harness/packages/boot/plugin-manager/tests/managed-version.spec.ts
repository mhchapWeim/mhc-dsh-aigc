import { expect, it } from 'vitest'
import { managedVersionCompatible } from '../src/managed-version.ts'

it.each([
  ['0.1.7-alpha.2', '0.1.7-alpha.2', true],
  ['0.1.7-alpha.2', '0.1.7-alpha.2.20261010.1', true],
  ['0.1.7-alpha.2', '0.1.7-alpha.2.20261011.12', true],
  ['0.1.7', '0.1.7-test.20261010.1', true],
  ['0.1.7-alpha.2', '0.1.7-alpha.3.20261010.1', false],
  ['0.1.7-alpha.2', '0.1.8-alpha.2.20261010.1', false],
  ['0.1.7-alpha.2', '0.1.7-alpha.20.20261010.1', false],
  ['0.1.7-alpha.2', '0.1.7-alpha.2.custom', false],
  ['0.1.7-alpha.2', '0.1.7-alpha.2.20261310.1', false],
  ['0.1.7-alpha.2', '0.1.7-alpha.2.20261010.0', false],
  ['0.1.7-alpha.2.20261010.1', '0.1.7-alpha.2.20261011.1', false],
  [null, '0.1.7-alpha.2', false],
] as const)('matches declared baseline %s against installation %s: %s', (required, installed, compatible) => {
  expect(managedVersionCompatible(required, installed)).toBe(compatible)
})
