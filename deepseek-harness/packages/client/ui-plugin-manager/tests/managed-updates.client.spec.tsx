// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { ManagedUpdateNotice } from '../src/client/ManagedUpdateNotice.tsx'
import { ManagedUpdatesController } from '../src/client/managed-updates.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const updates = [{ packageName: 'dsh-plugin-internal-model', version: '1.0.9' }]
const t: ComponentProps<typeof ManagedUpdateNotice>['t'] = key => key in zh ? zh[key as keyof typeof zh] : key
const unused = () => { throw new Error('Notice does not read session state') }
const standard = { usePanelInfo: unused, useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused, useWorkspaces: unused, useResource: unused }

it('shows only restart-required updates and leaves a persistent reminder after dismissal', async () => {
  const useManagedUpdates: ComponentProps<typeof ManagedUpdateNotice>['useManagedUpdates'] = selector => selector({ updates })
  const { container } = render(<ManagedUpdateNotice {...standard} wide t={t} useManagedUpdates={useManagedUpdates} />)
  fireEvent.click(screen.getByRole('button', { name: zh.managedRestartTitle }))
  expect(screen.getByRole('dialog', { name: zh.managedRestartTitle }).textContent).toContain('1.0.9')
  expect(screen.getByText(zh.managedRestartDescription)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: zh.managedRestartLater }))
  expect(screen.queryByRole('dialog')).toBeNull()
  await expect(container.textContent).toMatchFileSnapshot('./expected/managed-update-notice.txt')
})

it('renders nothing when changes were hot-applied', () => {
  const useManagedUpdates: ComponentProps<typeof ManagedUpdateNotice>['useManagedUpdates'] = selector => selector({ updates: [] })
  const { container } = render(<ManagedUpdateNotice {...standard} wide t={t} useManagedUpdates={useManagedUpdates} />)
  expect(container.textContent).toBe('')
})

it('reconciles missed events and ignores stale responses and completions after disposal', async () => {
  const old = Promise.withResolvers<{ ok: true; value: typeof updates }>()
  const managedUpdates = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ ok: true, value: updates })
  const subject = new ManagedUpdatesController({ remote: { pluginManager: { managedUpdates } } } as never)
  const pending = subject.refresh()
  subject.accept(updates)
  old.resolve({ ok: true, value: [] })
  await pending
  expect(subject.store.getSnapshot().updates).toEqual(updates)
  subject.accept([])
  await subject.refresh()
  expect(subject.store.getSnapshot().updates).toEqual(updates)
  subject.dispose()
  subject.accept([])
  expect(subject.store.getSnapshot().updates).toEqual(updates)
})
