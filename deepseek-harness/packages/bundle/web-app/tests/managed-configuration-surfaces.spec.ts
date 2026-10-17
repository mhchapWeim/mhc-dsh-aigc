/** Managed deployments keep model choice but delegate model and plugin configuration to AIGC. */
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'

it('uses the work assistant identity instead of the harness opener', () => {
  const patches = loadOverlayPatches('assistant-identity', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
  const config = patches.find(patch => patch.id === 'system-prompt')?.config
  expect(config?.includeHarnessIdentity).toBe(false)
  expect(config?.personaPrefix).toContain('You are 弯崽工作助手,')
  expect(config?.personaPrefix).toContain('Earlier conversation messages using another name')
  expect(config?.personaSuffix).toBe('Your working directory is {{cwd}}.')
})

it('disables local model and plugin configuration only in managed mode', () => {
  const patches = loadOverlayPatches('managed-surfaces', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
  const rows = patches.flatMap(patch => patch.insert ?? [])
  for (const id of ['ui-settings-models', 'ui-plugin-manager', 'ui-settings-plugins', 'ui-settings-plugin-inventory']) {
    const row = rows.find(candidate => candidate.id === id)
    expect(row?.disabled).toEqual({ __jsExpr: 'process.env.DSH_MANAGED_BACKEND_URL !== undefined' })
  }
  for (const id of ['llm-pi-ai', 'llm-deepseek']) {
    const row = patches.find(candidate => candidate.id === id)
    expect(row?.disabled).toEqual({ __jsExpr: 'process.env.DSH_MANAGED_BACKEND_URL !== undefined' })
  }
  expect(rows.find(candidate => candidate.id === 'ui-model-selection')?.disabled).toBeUndefined()
  expect(rows.find(candidate => candidate.id === 'ui-managed-account')?.disabled)
    .toEqual({ __jsExpr: 'process.env.DSH_MANAGED_BACKEND_URL === undefined' })
})
