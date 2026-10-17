/**
 * Organization sign-in step. The deployment's managed backend decides whether
 * this step runs at all: an ordinary install, and an already signed-in user,
 * complete it without rendering anything. A signed-out user starts enterprise
 * authentication by default. The account menu explicitly selects the AIGC
 * credential form when requested. A dismissed step is a skip, not a signed-in state.
 *
 * The card reuses the shipped sign-in dialog's visual language (see
 * {@link css}) so the two account surfaces stay one family.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Button, IconCloseOutlineRegular, IconLoadingOutlineRegular, Input, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ManagedAuthState, ManagedCasDeviceLogin } from '@deepseek-ai/dsh-api-settings-controller/types'
import type { ManagedAccountKey } from './locales.ts'
import css from './ManagedSignInDialog.module.css'
import type { DataMigrationActions } from './DataMigrationDialog.tsx'

/** How long one CAS attempt stays open before the form offers a fresh start. */
const SSO_DEADLINE_MS = 5 * 60 * 1000

function loginFailure(error: unknown, fallback: ManagedAccountKey): ManagedAccountKey {
  const details = typeof error === 'object' && error !== null && 'details' in error ? error.details : undefined
  const reason = typeof details === 'object' && details !== null && 'reason' in details ? details.reason : undefined
  return reason === 'device-binding' ? 'deviceBound' : reason === 'workspace' ? 'workspaceRepair'
    : reason === 'credentials' ? (fallback === 'ssoFailed' ? 'ssoFailed' : 'failed') : fallback
}

/** Registration-side dependencies of {@link ManagedSignInDialog}. */
export interface ManagedSignInInjected {
  /** Local repair remains available while signed out. */
  data?: DataMigrationActions
  /** Enterprise authentication by default; the account menu can explicitly select AIGC credentials. */
  mode?: 'aigc' | 'sso'
  /** Read the managed backend's sign-in state. */
  status: () => Promise<ManagedAuthState>
  /** Sign in with organization credentials. */
  login: (username: string, password: string) => Promise<ManagedAuthState>
  /** Begin the CAS browser flow. */
  casStart: () => Promise<ManagedCasDeviceLogin>
  /** Poll one CAS attempt; null while the platform has not confirmed it. */
  casPoll: (deviceCode: string) => Promise<ManagedAuthState | null>
  /** Remove the stored organization session and return an optional CAS logout URL. */
  logout: () => Promise<string | null>
  /** Feature copy. */
  t: (key: ManagedAccountKey) => string
}

/** Slot owner props plus the feature's injected dependencies. */
export type ManagedSignInDialogProps =
  PropsRuntime<'settings.onboarding'> & InjectFace<ManagedSignInInjected>

/**
 * Collect the organization credentials or drive the CAS browser flow while the
 * managed backend reports no signed-in user.
 * @param props - settings-shell owner state and managed-account dependencies.
 * @returns the sign-in card, or null while the initial state read is in flight.
 */
export function ManagedSignInDialog(props: ManagedSignInDialogProps): ReactNode {
  const { complete, status, login, casStart, casPoll, t, mode = 'sso' } = props
  const [phase, setPhase] = useState<'checking' | 'form' | 'sso'>('checking')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<ManagedAccountKey | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const formId = useId()
  // One generation per CAS attempt: cancelling, unmounting, or starting over
  // retires the older poll loop instead of letting it complete the step.
  const generation = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current += 1 }
  }, [])

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setFailed(null)
    void login(username.trim(), password).then(state => {
      if (!mounted.current) return
      if (!state.enabled || state.user === null) { setFailed('signInFailed'); return }
      complete()
    }).catch((error: unknown) => {
      if (!mounted.current) return
      const details = typeof error === 'object' && error !== null && 'code' in error
        && error.code === 'managed-auth/rejected' && 'details' in error ? error.details : undefined
      const reason = typeof details === 'object' && details !== null && 'reason' in details ? details.reason : undefined
      setFailed(reason === 'credentials' ? 'failed' : reason === 'device-binding' ? 'deviceBound' : 'signInFailed')
    })
      .finally(() => {
        if (!mounted.current) return
        setBusy(false)
        setPassword('')
      })
  }

  const startSso = useCallback((): void => {
    const mine = generation.current + 1
    generation.current = mine
    setBusy(true)
    setFailed(null)
    setPhase('sso')
    void casStart().then(async attempt => {
      if (!mounted.current || generation.current !== mine) return
      window.open(attempt.browserUrl, '_blank', 'noopener,noreferrer')
      setPhase('sso')
      setBusy(false)
      const deadline = Date.now() + SSO_DEADLINE_MS
      while (mounted.current && generation.current === mine && Date.now() < deadline) {
        await new Promise(resolve => { window.setTimeout(resolve, attempt.intervalSeconds * 1000) })
        if (!mounted.current || generation.current !== mine) return
        let state: ManagedAuthState | null
        try { state = await casPoll(attempt.deviceCode) }
        catch (error) {
          const details = typeof error === 'object' && error !== null && 'details' in error ? error.details : undefined
          const reason = typeof details === 'object' && details !== null && 'reason' in details ? details.reason : undefined
          if (reason === 'backend' || (error instanceof TypeError)) continue
          throw error
        }
        if (!mounted.current || generation.current !== mine) return
        if (state === null) continue
        if (!state.enabled || state.user === null) throw new Error('the CAS attempt returned no user')
        complete()
        return
      }
      if (!mounted.current || generation.current !== mine) return
      setFailed('ssoFailed')
      setPhase('form')
    }).catch((error: unknown) => {
      if (!mounted.current || generation.current !== mine) return
      setFailed(loginFailure(error, 'ssoFailed'))
      setPhase('form')
      setBusy(false)
    })
  }, [casStart, casPoll, complete])

  useEffect(() => {
    let active = true
    void status().then(state => {
      if (!active || !mounted.current) return
      // No managed backend, or a session already accepted: nothing to ask for.
      if (!state.enabled || state.user !== null) { complete(); return }
      if (mode === 'sso') startSso()
      else setPhase('form')
    }).catch(() => {
      if (!active || !mounted.current) return
      setFailed('unreachable')
      setPhase('form')
    })
    return () => { active = false }
  }, [complete, status, mode, startSso])

  const cancelSso = (): void => {
    generation.current += 1
    complete()
  }

  if (phase === 'checking') return null
  const waiting = phase === 'sso'
  const sso = mode === 'sso'
  const title = t(sso ? 'signInWithSso' : 'title')
  return <Modal open headless title={title} onClose={cancelSso} className={css.dialog as string}>
    <div className={css.content}>
      <div className={css.header}>
        <h2 className={css.title}>{title}</h2>
        <button type="button" className={css.close} aria-label={t('close')} onClick={cancelSso}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>
      <p className={css.description}>{t(sso ? (busy ? 'ssoStarting' : 'ssoWaiting') : 'description')}</p>
      {!sso && (
        <form id={formId} className={css.form} onSubmit={submit}>
          <label className={css.field}>
            <span className={css.label}>{t('username')}</span>
            <Input className={css.input as string} value={username} autoComplete="username" autoFocus
              onChange={event => { setUsername(event.target.value) }} />
          </label>
          <label className={css.field}>
            <span className={css.label}>{t('password')}</span>
            <Input className={css.input as string} type="password" value={password} autoComplete="current-password"
              onChange={event => { setPassword(event.target.value) }} />
          </label>
        </form>
      )}
      {failed !== null && <p className={css.error} role="alert">{t(failed)}</p>}
    </div>
    <div className={css.actions}>
      {sso ? <>
        <Button variant="outline" className={css.secondaryButton} onClick={cancelSso}>{t('ssoCancel')}</Button>
        {!waiting && <Button variant="primary" className={css.primaryButton} disabled={busy} onClick={startSso}>{t('ssoRetry')}</Button>}
      </> : <Button variant="primary" type="submit" form={formId} className={css.primaryButton}
        disabled={busy || waiting || username.trim() === '' || password === ''}>
        {busy ? <IconLoadingOutlineRegular className={css.spinner} /> : t('signIn')}
      </Button>}
    </div>
  </Modal>
}
