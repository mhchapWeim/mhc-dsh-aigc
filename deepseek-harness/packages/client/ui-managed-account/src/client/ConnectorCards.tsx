/** Display-only organization connector catalog. */
import { useState, type ReactNode } from 'react'
import type { ManagedMcpConnector } from '@deepseek-ai/dsh-plugin-manager/types'
import css from './Connectors.module.css'

/** Render authorized services without client activation controls.
 * @param props Current account catalog and selected display language.
 * @returns Searchable connector cards with expandable descriptions.
 */
export function ConnectorCards({items,english}: {items:readonly ManagedMcpConnector[];english:boolean}):ReactNode {
    const [search,setSearch]=useState(''); const [detail,setDetail]=useState<string|null>(null)
    const filtered=items.filter(item=>`${item.name} ${item.description}`.toLowerCase().includes(search.toLowerCase()))
    return <section className={css.page}>
      <header className={css.header}><div><h1>{english?'Connectors':'连接器'}</h1><p>{english?'Authorized by your organization. Available directly in chat.':'由组织统一授权，在聊天中直接使用。'}</p></div>
      <label className={css.search}><span>{english?'Search connectors':'搜索连接器'}</span><input value={search} onChange={event=>setSearch(event.target.value)} /></label></header>
      <div className={css.grid}>{filtered.map(item=><button type="button" className={css.card} key={item.id} onClick={()=>setDetail(detail===item.id ? null : item.id)} aria-expanded={detail===item.id}>
        {item.iconDataUrl ? <img src={item.iconDataUrl} alt=""/>:<span className={css.fallback}>↗</span>}
        <div className={css.copy}><h2>{item.name}</h2><p className={detail===item.id ? css.expanded : css.description}>{item.description}</p>
        <span className={css.state} data-ready={item.status==='Ready'}>{item.status==='Ready' ? (english?'Connected':'已连接') : item.status==='Unavailable' ? (english?'Unavailable':'暂不可用') : (english?'Connecting':'正在连接')}</span></div>
      </button>)}</div>
      {filtered.length===0 && <p role="status">{english?'No connectors available.':'暂无可用的连接器。'}</p>}
    </section>

}
