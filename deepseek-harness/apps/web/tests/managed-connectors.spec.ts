// @vitest-environment jsdom
/** Built Client composition with local plugin management omitted, as in managed deployments. */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

it('shows authorized connectors while the local plugin manager surface is absent, then hides them on revocation', async () => {
  const remote = mountAssembledApp({ exclude: ['@deepseek-ai/dsh-client-ui-plugin-manager'] })
  const connector = { id: 'example', name: 'Production trace', description: 'Find product history', iconDataUrl: '', status: 'Ready' }
  remote.mock.unary('credentials/managedStatus', () => ok({ enabled: true, user: { id: 'test-user', username: 'tester' }, models: [], workspacePath: '/test' }))
  remote.mock.unary('pluginManager/connectors', () => ok([connector]))
  const entry = await screen.findByRole('button', { name: 'Connectors' }, { timeout: 15000 })
  expect(screen.queryByRole('button', { name: 'Plugins' })).toBeNull()
  fireEvent.click(entry)
  await screen.findByText('Production trace')
  expect(screen.getByText('Connected')).toBeTruthy()
  remote.mock.unary('pluginManager/connectors', () => ok([]))
  remote.mock.streams.push('$events', { type: 'emit', event: 'plugin-manager/connectors-updated', args: [[]] })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Connectors' })).toBeNull())
}, 30000)
