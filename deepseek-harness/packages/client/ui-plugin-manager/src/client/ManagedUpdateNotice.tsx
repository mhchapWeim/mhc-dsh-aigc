/** A persistent sidebar notice; successful hot application stays silent. */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconWarningOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ManagedUpdatesController } from './managed-updates.ts'
import css from './ManagedUpdateNotice.module.css'

export interface ManagedUpdateNoticeInjected {
  hooks: { managedUpdates: ManagedUpdatesController['store'] }
}

type Props = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'pluginManager'> & InjectFace<ManagedUpdateNoticeInjected>

/** Show staged versions without interrupting work or restarting the Host automatically. */
export function ManagedUpdateNotice({ wide, useManagedUpdates, t }: Props) {
  const updates = useManagedUpdates(state => state.updates)
  const [open, setOpen] = useState(false)
  if (updates.length === 0) return null
  return <>
    <button type="button" className={css.notice} title={t('managedRestartTitle')} aria-label={t('managedRestartTitle')}
      onClick={() => { setOpen(true) }}>
      <IconWarningOutlineRegular size={18} />
      {wide && <span>{t('managedRestartTitle')}</span>}
    </button>
    {open && <Modal open headless className={css.modal as string} onClose={() => { setOpen(false) }} title={t('managedRestartTitle')}>
      <div className={css.dialog}>
        <h2>{t('managedRestartTitle')}</h2>
        <p>{t('managedRestartDescription')}</p>
        <ul>{updates.map(update => <li key={update.packageName}><span>{update.packageName}</span><strong>{update.version}</strong></li>)}</ul>
        <Button variant="primary" onClick={() => { setOpen(false) }}>{t('managedRestartLater')}</Button>
      </div>
    </Modal>}
  </>
}
