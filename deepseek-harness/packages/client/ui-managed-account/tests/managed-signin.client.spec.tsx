// @vitest-environment jsdom
/** Organization sign-in step: gate behavior, credential submission, and the CAS browser flow. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ManagedAuthState, ManagedCasDeviceLogin } from '@deepseek-ai/dsh-api-settings-controller/types'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { ManagedSignInDialog } from '../src/client/ManagedSignInDialog.tsx'
import type { ManagedSignInInjected } from '../src/client/ManagedSignInDialog.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const signedOut: ManagedAuthState = { enabled: true, user: null }
const signedIn: ManagedAuthState = {
  enabled: true,
  user: { id: 'ff3b890d-f68f-4658-81b5-d9ca6e2c5f88', username: 'wh00028' },
  models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
  workspaceId: 'ws-1',
  workspacePath: 'C:\\workspaces\\bhss-wh00028-workspace',
}
const attempt: ManagedCasDeviceLogin = {
  browserUrl: 'https://sso.example.com/cas/login?service=example',
  deviceCode: 'a'.repeat(64),
  intervalSeconds: 2,
}

/** Render the step with one injected face; every callback is a spy by default. */
function mount(overrides: Partial<ManagedSignInInjected> = {}, copy: typeof en | typeof zh = en, mode: 'aigc' | 'sso' = 'aigc') {
  const complete = vi.fn()
  const injected: ManagedSignInInjected = {
    status: vi.fn(async () => signedOut),
    login: vi.fn(async () => signedIn),
    casStart: vi.fn(async () => attempt),
    casPoll: vi.fn(async () => null),
    logout: vi.fn(async () => null),
    t: key => copy[key],
    ...overrides,
  }
  render(<ManagedSignInDialog {...({} as GlobalStandardProps)} stepId="managed-account"
    complete={complete} openSection={vi.fn()} mode={mode} {...injected} />)
  return { complete, injected }
}

it('completes without rendering where the deployment has no managed backend', async () => {
  const { complete } = mount({ status: vi.fn(async () => ({ enabled: false }) as ManagedAuthState) })
  await waitFor(() => { expect(complete).toHaveBeenCalledOnce() })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('completes without rendering when a session is already stored', async () => {
  const { complete } = mount({ status: vi.fn(async () => signedIn) })
  await waitFor(() => { expect(complete).toHaveBeenCalledOnce() })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('stress: recovers from 50 transient CAS polling failures without opening new browser attempts', async () => {
  vi.useFakeTimers()
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  let count = 0
  const casPoll = vi.fn(async () => {
    if (++count <= 50) throw { code: 'managed-auth/rejected', details: { reason: 'backend' } }
    return signedIn
  })
  const { complete } = mount({ casPoll }, en, 'sso')
  await act(async () => { await vi.advanceTimersByTimeAsync(104_000) })
  expect(complete).toHaveBeenCalledOnce()
  expect(casPoll).toHaveBeenCalledTimes(51)
  expect(open).toHaveBeenCalledOnce()
})

it.each([en, zh])('asks for credentials while no session is stored', async copy => {
  mount({}, copy)
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toContain(copy.title)
  expect(dialog.textContent).toContain(copy.description)
  expect(screen.getByLabelText(copy.username)).toBeTruthy()
  expect(screen.getByLabelText(copy.password)).toBeTruthy()
  expect(screen.queryByRole('button', { name: copy.signInWithSso })).toBeNull()
})

it.each([en, zh])('renders the shipped copy', async copy => {
  mount({}, copy)
  const dialog = await screen.findByRole('dialog')
  await expect(`${dialog.textContent}\n`).toMatchFileSnapshot(`./expected/signin-${copy === en ? 'en' : 'zh'}.txt`)
})

it('signs in with the trimmed credentials and completes', async () => {
  const login = vi.fn(async () => signedIn)
  const { complete } = mount({ login })
  await screen.findByRole('dialog')
  fireEvent.change(screen.getByLabelText(en.username), { target: { value: '  wh00028  ' } })
  fireEvent.change(screen.getByLabelText(en.password), { target: { value: 'Bhss@123' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.signIn })) })
  expect(login).toHaveBeenCalledExactlyOnceWith('wh00028', 'Bhss@123')
  expect(complete).toHaveBeenCalledOnce()
})

it('completes sign-in even when no model has been granted', async () => {
  const { complete } = mount({ login: vi.fn(async () => ({ ...signedIn, models: [] })) })
  await screen.findByRole('dialog')
  fireEvent.change(screen.getByLabelText(en.username), { target: { value: 'wa00038' } })
  fireEvent.change(screen.getByLabelText(en.password), { target: { value: 'Bhss@123' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.signIn })) })
  expect(complete).toHaveBeenCalledOnce()
})

it('does not blame credentials for a post-authentication failure', async () => {
  const { complete } = mount({ login: vi.fn(async () => { throw new Error('model catalog unavailable') }) })
  await screen.findByRole('dialog')
  fireEvent.change(screen.getByLabelText(en.username), { target: { value: 'wa00038' } })
  fireEvent.change(screen.getByLabelText(en.password), { target: { value: 'Bhss@123' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.signIn })) })
  expect(screen.getByRole('alert').textContent).toBe(en.signInFailed)
  expect(complete).not.toHaveBeenCalled()
})

it('keeps the form and reports a rejected credential', async () => {
  const { complete } = mount({ login: vi.fn(async () => { throw {
    code: 'managed-auth/rejected', details: { reason: 'credentials' },
  } }) })
  await screen.findByRole('dialog')
  fireEvent.change(screen.getByLabelText(en.username), { target: { value: 'wh00028' } })
  fireEvent.change(screen.getByLabelText(en.password), { target: { value: 'wrong' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.signIn })) })
  expect((await screen.findByRole('alert')).textContent).toBe(en.failed)
  expect(complete).not.toHaveBeenCalled()
  expect(screen.getByLabelText(en.username)).toBeTruthy()
})

it('does not blame the password when a successful backend login finds a different profile binding', async () => {
  mount({ login: vi.fn(async () => { throw {
    code: 'managed-auth/rejected', details: { reason: 'device-binding' },
  } }) }, zh)
  await screen.findByRole('dialog')
  fireEvent.change(screen.getByLabelText(zh.username), { target: { value: 'wh00028' } })
  fireEvent.change(screen.getByLabelText(zh.password), { target: { value: 'Bhss@123' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.signIn })) })
  expect(screen.getByRole('alert').textContent).toBe(zh.deviceBound)
})

it('does not blame the password when the backend accepted login but rejects its new token', async () => {
  mount({ login: vi.fn(async () => signedOut) })
  await screen.findByRole('dialog')
  fireEvent.change(screen.getByLabelText(en.username), { target: { value: 'wh00028' } })
  fireEvent.change(screen.getByLabelText(en.password), { target: { value: 'Bhss@123' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.signIn })) })
  expect(screen.getByRole('alert').textContent).toBe(en.signInFailed)
})

it('reports an unreachable backend with its own copy', async () => {
  const { complete } = mount({ status: vi.fn(async () => { throw new Error('backend down') }) })
  expect((await screen.findByRole('alert')).textContent).toBe(en.unreachable)
  expect(complete).not.toHaveBeenCalled()
})

it('opens the browser and completes once the platform confirms the attempt', async () => {
  vi.useFakeTimers()
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  const casPoll = vi.fn(async () => signedIn)
  const { complete } = mount({ casPoll }, en, 'sso')
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(open).toHaveBeenCalledExactlyOnceWith(attempt.browserUrl, '_blank', 'noopener,noreferrer')
  expect(screen.getByRole('dialog').textContent).toContain(en.ssoWaiting)
  await act(async () => { await vi.advanceTimersByTimeAsync(attempt.intervalSeconds * 1000) })
  expect(casPoll).toHaveBeenCalledExactlyOnceWith(attempt.deviceCode)
  expect(complete).toHaveBeenCalledOnce()
})

it('retires the poll loop when the user cancels the attempt', async () => {
  vi.useFakeTimers()
  vi.spyOn(window, 'open').mockReturnValue(null)
  const casPoll = vi.fn(async () => signedIn)
  const { complete } = mount({ casPoll }, en, 'sso')
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  fireEvent.click(screen.getByRole('button', { name: en.ssoCancel }))
  await act(async () => { await vi.advanceTimersByTimeAsync(attempt.intervalSeconds * 1000) })
  expect(casPoll).not.toHaveBeenCalled()
  expect(complete).toHaveBeenCalledOnce()
  expect(screen.queryByLabelText(en.username)).toBeNull()
})

it('offers SSO retry after a failed start without exposing the password form', async () => {
  vi.spyOn(window, 'open').mockReturnValue(null)
  const casStart = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(attempt)
  mount({ casStart }, zh, 'sso')
  expect((await screen.findByRole('alert')).textContent).toBe(zh.ssoFailed)
  expect(screen.queryByLabelText(zh.username)).toBeNull()
  expect(screen.queryByRole('button', { name: zh.signIn })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.ssoRetry }))
  await waitFor(() => { expect(window.open).toHaveBeenCalledOnce() })
  expect(casStart).toHaveBeenCalledTimes(2)
})

it('ignores an in-flight SSO result after cancellation', async () => {
  vi.useFakeTimers()
  vi.spyOn(window, 'open').mockReturnValue(null)
  let resolvePoll!: (state: ManagedAuthState) => void
  const casPoll = vi.fn(() => new Promise<ManagedAuthState>(resolve => { resolvePoll = resolve }))
  const { complete } = mount({ casPoll }, en, 'sso')
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(casPoll).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: en.ssoCancel }))
  await act(async () => { resolvePoll(signedIn) })
  expect(complete).toHaveBeenCalledOnce()
})

it('reports an attempt the platform never confirms', async () => {
  vi.useFakeTimers()
  vi.spyOn(window, 'open').mockReturnValue(null)
  const { complete } = mount({ casPoll: vi.fn(async () => null) }, en, 'sso')
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  // The poll loop reschedules itself, so the deadline only arrives if the
  // clock advances one poll interval at a time.
  const step = attempt.intervalSeconds * 1000
  for (let elapsed = 0; elapsed < 5 * 60 * 1000; elapsed += step) {
    await act(async () => { await vi.advanceTimersByTimeAsync(step) })
  }
  expect(screen.getByRole('alert').textContent).toBe(en.ssoFailed)
  expect(complete).not.toHaveBeenCalled()
}, 30_000)

it('uses enterprise authentication when explicitly mounting its dialog without a mode', async () => {
  vi.useFakeTimers()
  vi.spyOn(window, 'open').mockReturnValue(null)
  const casStart = vi.fn(async () => attempt)
  const login = vi.fn()
  render(<ManagedSignInDialog {...({} as GlobalStandardProps)} stepId="managed-account"
    complete={vi.fn()} openSection={vi.fn()} status={vi.fn(async () => signedOut)}
    login={login} casStart={casStart} casPoll={vi.fn(async () => null)} logout={vi.fn()}
    t={key => zh[key]} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(screen.getByRole('dialog', { name: '企业用户认证' })).toBeDefined()
  expect(casStart).toHaveBeenCalledOnce()
  expect(screen.queryByLabelText(zh.password)).toBeNull()
  expect(login).not.toHaveBeenCalled()
})
