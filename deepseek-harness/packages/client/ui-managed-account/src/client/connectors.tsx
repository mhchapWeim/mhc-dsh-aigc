/** Organization connectors are display-only: authorization is controlled by AIGC. */
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ManagedMcpConnector } from '@deepseek-ai/dsh-plugin-manager/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ConnectorCards } from './ConnectorCards.tsx'

interface ConnectorInjected {
  hooks: {
    connectors: SnapshotStore<{items: readonly ManagedMcpConnector[]}>
    connectorLocale: HostObservable<{active: string}>
  }
}

function Cards({useConnectors, useConnectorLocale}: InjectFace<ConnectorInjected>): ReactNode {
  const items = useConnectors(state => state.items)
  const english = useConnectorLocale(state => state.active === 'en')
  return <ConnectorCards items={items} english={english}/>
}

const panel = 'connectors' as MainPanelId
function ConnectorIcon({size}:PropsRuntime<'sidebar.panellist'>):ReactNode {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden><path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/></svg>
}

/** Register cards and conditionally expose the sidebar entry from the Host catalog.
 * @param ctx Browser context with the organization Remote carrier.
 */
export function installConnectors(ctx:Context):void {
  const store = createSnapshotStore<{items:readonly ManagedMcpConnector[]}>({items:[]})
  let disposed=false; let generation=0
  let removeEntry:(()=>void)|undefined
  const accept = (items:readonly ManagedMcpConnector[]):void => {
    if (disposed) return
    generation++; store.set({items})
    if (items.length>0 && !removeEntry) removeEntry=ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({
      name:'sidebar.panellist',id:panel,order:1,label:()=>ctx.locale.getSnapshot().active === 'en' ? 'Connectors' : '连接器',
    },ConnectorIcon))
    else if (items.length===0 && removeEntry) {removeEntry();removeEntry=undefined}
  }
  const refresh = async ():Promise<void> => {
    const current=++generation
    try {
      const result=await ctx.remote.pluginManager.connectors()
      if (!disposed && current===generation && result.ok) accept(result.value)
    } catch (error) {if (!disposed && current===generation) accept([])}
  }
  const locale: HostObservable<{active: string}> = {
    getSnapshot: () => ctx.locale.getSnapshot(),
    subscribe: listener => ctx.locale.subscribe(listener),
  }
  ctx.slots.inject('main',()=>ctx.slots.register({
    name:'main',key:panel,inject:()=>({hooks:{connectors:store,connectorLocale:locale}}),
  },Cards))
  ctx.remote.$on('plugin-manager/connectors-updated',accept)
  ctx.remote.$on('credentials/record-updated',key=>{
    if (key !== 'llm-managed-backend/user-session') return
    accept([]);void refresh()
  })
  ctx.on('connection/reset',()=>{accept([]);void refresh()})
  const timer=setInterval(()=>{void refresh()},5000)
  ctx.effect(()=>()=>{disposed=true;generation++;clearInterval(timer);removeEntry?.()},'ui-connectors.catalog')
  void refresh()
}

