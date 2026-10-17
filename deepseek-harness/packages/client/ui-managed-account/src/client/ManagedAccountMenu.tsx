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
    <Menu open={menuOpen} side="top" portal autoFocus className={css.anchor}
      anchor={<button type="button" className={css.trigger} data-collapsed={!props.wide}
        aria-label={username ?? props.t(unreachable ? 'unreachable' : 'signedOut')}
        aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => { setMenuOpen(open => !open) }}>
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
