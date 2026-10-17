// @vitest-environment jsdom
/** The managed deployment has one account launcher in the shipped settings position. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ManagedSignInInjected } from '../src/client/ManagedSignInDialog.tsx'
import { ManagedAccountMenu } from '../src/client/ManagedAccountMenu.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

it('keeps the signed-in identity during a temporary backend outage and recovers on focus', async () => {
  const identity = { enabled: true as const, user: { id: 'user-1', username: 'wh00028' }, models: [], workspaceId: 'w', workspacePath: 'C:\\workspace' }
  const status = vi.fn().mockResolvedValueOnce(identity).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(identity)
  const injected: ManagedSignInInjected = { status, login: vi.fn(), casStart: vi.fn(), casPoll: vi.fn(), logout: vi.fn(), t: key => zh[key] }
  render(<ManagedAccountMenu {...({} as GlobalStandardProps)} wide openSettings={vi.fn()} openOnboarding={vi.fn()} {...injected} />)
  await screen.findByRole('button', { name: 'wh00028' })
  fireEvent(window, new Event('focus'))
  await screen.findByText(zh.unreachable)
  expect(screen.getByRole('button', { name: 'wh00028' })).toBeTruthy()
  fireEvent(window, new Event('focus'))
  await waitFor(() => expect(screen.queryByText(zh.unreachable)).toBeNull())
})

it('opens AIGC authentication from the application menu and keeps enterprise authentication in the account menu', async () => {
  let openAigc: (() => void) | undefined
  const dispose = vi.fn()
  window.__DSH_AIGC_AUTHENTICATION__ = { subscribe(listener) { openAigc = listener; return dispose } }
  const casStart = vi.fn()
  const injected: ManagedSignInInjected = {
    status: vi.fn(async () => ({ enabled: true as const, user: null })), login: vi.fn(), casStart,
    casPoll: vi.fn(), logout: vi.fn(), t: key => zh[key],
  }
  render(<ManagedAccountMenu {...({} as GlobalStandardProps)} wide openSettings={vi.fn()} openOnboarding={vi.fn()} {...injected} />)
  fireEvent.click(screen.getByRole('button', { name: zh.signedOut }))
  expect(screen.getByRole('menuitem', { name: '企业用户认证' })).toBeTruthy()
  expect(screen.queryByRole('menuitem', { name: 'AIGC认证' })).toBeNull()
  await act(async () => { openAigc?.() })
  delete window.__DSH_AIGC_AUTHENTICATION__
  await screen.findByRole('dialog', { name: 'AIGC认证' })
  expect(screen.getByLabelText(zh.username)).toBeTruthy()
  expect(screen.getByLabelText(zh.password)).toBeTruthy()
  expect(screen.queryByRole('button', { name: '企业用户认证' })).toBeNull()
  expect(casStart).not.toHaveBeenCalled()
})

it('starts SSO directly from the outer menu without displaying credential inputs', async () => {
  vi.useFakeTimers()
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  const casStart = vi.fn(async () => ({ browserUrl: 'https://sso.example.test/login', deviceCode: 'test-device', intervalSeconds: 2 }))
  let signedIn = false
  const injected: ManagedSignInInjected = {
    status: vi.fn(async () => signedIn ? { enabled: true as const, user: { id: 'user-1', username: 'wh00028' }, models: [], workspaceId: 'ws', workspacePath: 'C:/ws' }
      : { enabled: true as const, user: null }),
    login: vi.fn(), casStart, casPoll: vi.fn(async () => {
      signedIn = true
      return { enabled: true as const, user: { id: 'user-1', username: 'wh00028' }, models: [], workspaceId: 'ws', workspacePath: 'C:/ws' }
    }), logout: vi.fn(), t: key => zh[key],
  }
  render(<ManagedAccountMenu {...({} as GlobalStandardProps)} wide openSettings={vi.fn()} openOnboarding={vi.fn()} {...injected} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  fireEvent.click(screen.getByRole('button', { name: zh.signedOut }))
  fireEvent.click(screen.getByRole('menuitem', { name: '企业用户认证' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(casStart).toHaveBeenCalledOnce()
  expect(open).toHaveBeenCalledExactlyOnceWith('https://sso.example.test/login', '_blank', 'noopener,noreferrer')
  expect(screen.queryByLabelText(zh.username)).toBeNull()
  expect(screen.queryByLabelText(zh.password)).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(screen.getByRole('button', { name: 'wh00028' })).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(injected.login).not.toHaveBeenCalled()
})

it('shows the organization user in the original account position and signs out there', async () => {
  vi.spyOn(window, 'open').mockReturnValue(null)
  const logout = vi.fn(async () => null)
  const openSettings = vi.fn()
  const injected: ManagedSignInInjected = {
    status: vi.fn(async () => ({ enabled: true as const, user: { id: 'user-1', username: 'wh00028' },
      models: [], workspaceId: 'workspace-1', workspacePath: 'C:\\workspace' })),
    login: vi.fn(), casStart: vi.fn(), casPoll: vi.fn(), logout,
    t: key => zh[key],
  }
  render(<ManagedAccountMenu {...({} as GlobalStandardProps)} wide openSettings={openSettings}
    openOnboarding={vi.fn()} {...injected} />)
  const launcher = await screen.findByRole('button', { name: 'wh00028' })
  expect(screen.getByRole('status').textContent).toBe(zh.noModels)
  fireEvent.click(launcher)
  fireEvent.click(screen.getByRole('menuitem', { name: zh.settings }))
  expect(openSettings).toHaveBeenCalledOnce()
  fireEvent.click(launcher)
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: zh.signOut })) })
  expect(logout).toHaveBeenCalledOnce()
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.signedOut })).toBeTruthy() })
})

it('opens data migration from the desktop application menu and removes the account entry', async () => {
  let openData: (() => void) | undefined
  const dispose = vi.fn()
  window.__DSH_DATA_MIGRATION__ = { subscribe(listener) { openData = listener; return dispose } }
  const injected: ManagedSignInInjected = {
    status: vi.fn(async () => ({ enabled: true as const, user: null })), login: vi.fn(), casStart: vi.fn(),
    casPoll: vi.fn(), logout: vi.fn(), t: key => zh[key],
    data: { status: vi.fn(async () => ({ workspaces: [], sessions: [], migrations: [] })), preview: vi.fn(), commit: vi.fn(), repair: vi.fn(), remove: vi.fn(), forgetMissing: vi.fn() },
  }
  try {
    const view = render(<ManagedAccountMenu {...({} as GlobalStandardProps)} wide openSettings={vi.fn()} openOnboarding={vi.fn()} {...injected} />)
    fireEvent.click(screen.getByRole('button', { name: zh.signedOut }))
    expect(screen.queryByRole('menuitem', { name: zh.dataTitle })).toBeNull()
    await act(async () => { openData?.() })
    expect(screen.getByRole('dialog', { name: zh.dataTitle })).toBeDefined()
    view.unmount()
    expect(dispose).toHaveBeenCalledOnce()
  } finally { delete window.__DSH_DATA_MIGRATION__ }
})

it('does not start authentication on mount, focus refresh, or remount', async () => {
  const injected: ManagedSignInInjected = {
    status: vi.fn(async () => ({ enabled: true as const, user: null })), login: vi.fn(),
    casStart: vi.fn(), casPoll: vi.fn(), logout: vi.fn(), t: key => zh[key],
  }
  const props = { ...({} as GlobalStandardProps), wide: true, openSettings: vi.fn(), openOnboarding: vi.fn(), ...injected }
  const first = render(<ManagedAccountMenu {...props} />)
  await waitFor(() => expect(injected.status).toHaveBeenCalledOnce())
  fireEvent(window, new Event('focus'))
  await waitFor(() => expect(injected.status).toHaveBeenCalledTimes(2))
  first.unmount()
  render(<ManagedAccountMenu {...props} />)
  await waitFor(() => expect(injected.status).toHaveBeenCalledTimes(3))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(injected.casStart).not.toHaveBeenCalled()
  expect(injected.login).not.toHaveBeenCalled()
})
