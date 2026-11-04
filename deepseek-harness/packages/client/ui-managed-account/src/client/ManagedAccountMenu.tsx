/** Organization identity in the Desktop account launcher's existing sidebar position. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconSettingsOutlineMedium, IconUserOutlineMedium, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ManagedAuthState } from '@deepseek-ai/dsh-api-settings-controller/types'
import { ManagedSignInDialog } from './ManagedSignInDialog.tsx'
import type { ManagedSignInInjected } from './ManagedSignInDialog.tsx'
import css from './ManagedAccountMenu.module.css'
import { DataMigrationDialog } from './DataMigrationDialog.tsx'

type Props = PropsRuntime<'settings.launcher'> & InjectFace<ManagedSignInInjected>

declare global {
  interface Window {
    __DSH_DATA_MIGRATION__?: { subscribe(listener: () => void): () => void }
    __DSH_AIGC_AUTHENTICATION__?: { subscribe(listener: () => void): () => void }
  }
}

/** Keep settings and organization sign-in available through one account menu. */
export function ManagedAccountMenu(props: Props): ReactNode {
  const [state, setState] = useState<ManagedAuthState>({ enabled: true, user: null })
  const [menuOpen, setMenuOpen] = useState(false)
  const [quotaOpen, setQuotaOpen] = useState(false)
  const [authentication, setAuthentication] = useState<'aigc' | 'sso' | null>(null)
  useEffect(() => window.__DSH_AIGC_AUTHENTICATION__?.subscribe(() => { setAuthentication('aigc') }), [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [unreachable, setUnreachable] = useState(false)
  const [dataOpen, setDataOpen] = useState(false)
  useEffect(() => window.__DSH_DATA_MIGRATION__?.subscribe(() => { setDataOpen(true) }), [])
  const statusGeneration = useRef(0)
  const refresh = useCallback(() => {
    const current = ++statusGeneration.current
    void props.status().then(value => { if (current === statusGeneration.current) { setState(value); setUnreachable(false) } }).catch(() => { if (current === statusGeneration.current) setUnreachable(true) })
  }, [props.status])
  useEffect(() => props.subscribeConfigUpdates?.(refresh), [props.subscribeConfigUpdates, refresh])
  const closeAuthentication = useCallback(() => {
    setAuthentication(null)
    refresh()
  }, [refresh])
  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => { statusGeneration.current++; window.removeEventListener('focus', refresh) }
  }, [refresh])
  const username = state.enabled ? state.user?.username : undefined
  const billing = state.enabled && state.user !== null ? state.billing : undefined
  const remaining = billing === undefined ? 0 : Math.max(0, billing.total - billing.used)
  const remainingPercent = billing !== undefined && billing.total > 0 ? Math.min(100, remaining / billing.total * 100) : 0
  useEffect(() => {
    if (username === undefined) return
    const timer = window.setInterval(refresh, 15_000)
    return () => { window.clearInterval(timer) }
  }, [refresh, username])

  const signOut = async (): Promise<void> => {
    statusGeneration.current++
    setBusy(true)
    setError(false)
    try {
      const url = await props.logout()
      setState({ enabled: true, user: null })
      setMenuOpen(false)
      if (url !== null) window.open(url, '_blank', 'noopener,noreferrer')
    } catch { setError(true) }
    finally { setBusy(false) }
  }

  return <div className={css.root}>
    <div className={css.accountRow}>
    <Menu open={menuOpen} side="top" portal autoFocus className={css.anchor}
      anchor={<button type="button" className={css.trigger} data-collapsed={!props.wide}
        aria-label={username ?? props.t(unreachable ? 'unreachable' : 'signedOut')}
        aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => { setQuotaOpen(false); setMenuOpen(open => !open) }}>
        <span className={css.avatar}><IconUserOutlineMedium size={18} /></span>
        {props.wide && <span className={css.label}>{username ?? props.t(unreachable ? 'unreachable' : 'signedOut')}</span>}

      </button>}
      items={[
        { id: 'settings', label: props.t('settings'), icon: <IconSettingsOutlineMedium size={16} /> },
        ...(username === undefined
          ? [
              { id: 'sso', label: props.t('signInWithSso'), icon: <IconUserOutlineMedium size={16} /> },
            ]
          : [{ id: 'signout', label: props.t('signOut'), icon: <IconUserOutlineMedium size={16} />, disabled: busy }]),
      ]}
      onClose={() => { setMenuOpen(false) }}
      onSelect={id => {
        setMenuOpen(false)
        if (id === 'settings') props.openSettings()
        else if (id === 'sso') setAuthentication('sso')
        else void signOut()
      }} />
        {props.wide && billing !== undefined && <Menu open={quotaOpen} side="top" portal align="end" onClose={() => { setQuotaOpen(false) }} anchor={<button type="button" className={css.quota} aria-label={props.t('quotaDetails')} aria-haspopup="menu" aria-expanded={quotaOpen} onClick={() => { setMenuOpen(false); setQuotaOpen(open => !open) }}>
          {billing.assigned && <svg className={css.ring} viewBox="0 0 36 36" role="meter"
            aria-label={props.t('quotaRemaining')} aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={remainingPercent} aria-valuetext={`${remaining.toLocaleString()} tok`}>
            <circle className={css.ringTrack} cx="18" cy="18" r="14" fill="none" strokeWidth="3" />
            <circle cx="18" cy="18" r="14" fill="none" stroke="currentColor" strokeWidth="3"
              pathLength="100" strokeDasharray={`${remainingPercent} 100`} transform="rotate(-90 18 18)" />
          </svg>}
          <span className={css.quotaNumbers}>{billing.assigned
            ? `${props.t('quotaRemaining')} ${Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(remaining)} tok`
            : props.t('quotaUnassigned')}</span>
        </button>}>
      <section className={css.quotaCard} aria-label={props.t('quotaDetails')}>
        <p className={css.quotaSource}>{props.t('quotaSource')} · {billing.planName ?? props.t('quotaUnassigned')}</p>
        <div className={css.quotaRow}><span>{props.t('quotaWeekly')}</span><strong className={css.quotaGreen}>{props.t('quotaRemaining')} {Math.floor(remainingPercent)}%</strong></div>
        <div className={css.quotaRow}><span>{props.t('quotaRemaining')}</span><strong>{remaining.toLocaleString()} tok</strong></div>
        <div className={css.quotaRow}><span>{props.t('quotaUsed')}</span><span>{billing.used.toLocaleString()} / {billing.total.toLocaleString()} tok</span></div>
        {billing.reserved > 0 && <div className={css.quotaRow}><span>{props.t('quotaReserved')}</span><span>{billing.reserved.toLocaleString()} tok</span></div>}
        <p className={css.quotaReset}>{props.t('quotaResets')} · {new Date(billing.resetsAt).toLocaleString()}</p>
      </section>
    </Menu>}
    </div>
    {authentication !== null && <ManagedSignInDialog {...props} mode={authentication}
      stepId="managed-account-menu" openSection={() => {}} complete={closeAuthentication} />}
    {dataOpen && props.data !== undefined && <DataMigrationDialog data={props.data} t={props.t} close={() => { setDataOpen(false); refresh() }} />}
    {unreachable && <span className={css.notice} role="status">{props.t('unreachable')}</span>}
    {error && <span className={css.error} role="alert">{props.t('signOutFailed')}</span>}
    {state.enabled && state.user !== null && state.workspaceIssue !== undefined &&
      <span className={css.notice} role="status">{props.t('workspaceRepair')}</span>}
    {state.enabled && state.user !== null && state.models.length === 0 &&
      <span className={css.notice} role="status">{props.t('noModels')}</span>}
  </div>
}
