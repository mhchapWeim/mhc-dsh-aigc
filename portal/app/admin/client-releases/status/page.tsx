'use client';

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { AntPagination } from '../../../components/ant-pagination';
import { usePageSize } from '../../../components/use-page-size';
import { getDesktopClients, type DesktopClientReport } from '../../../lib/api-client';
import '../../dsh-feedback/style.css';

const statuses: Record<string, string> = { Current: '当前版本', Available: '发现更新', Downloading: '下载中', Ready: '待重启', Installing: '安装中', Failed: '失败' };

export default function ClientVersionStatusPage() {
  const [clients, setClients] = useState<DesktopClientReport[]>([]);
  const [search, setSearch] = useState('');
  const [version, setVersion] = useState('');
  const [status, setStatus] = useState('');
  const [clientPage, setClientPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const versions = [...new Set(clients.map(client => client.version))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const keyword = search.trim().toLocaleLowerCase();
  const filteredClients = clients.filter(client =>
    (!keyword || [client.name, client.employeeNo, client.computerName, client.deviceId].some(value => value.toLocaleLowerCase().includes(keyword)))
    && (!version || client.version === version) && (!status || client.updateStatus === status));
  const currentClientPage = Math.min(clientPage, Math.max(1, Math.ceil(filteredClients.length / pageSize)));
  useEffect(() => {
    let active = true;
    getDesktopClients().then(data => { if (active) setClients(data); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '加载失败'); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  const refresh = async () => {
    setBusy(true); setError('');
    try { setClients(await getDesktopClients()); }
    catch (reason) { setClients([]); setError(reason instanceof Error ? reason.message : '加载失败'); }
    finally { setBusy(false); }
  };
  return <div className="admin-page page-enter release-management">
    <div className="page-title"><div><span className="section-kicker">DESKTOP VERSION STATUS</span><h1>版本状态</h1><p>按用户和设备 ID 展示最后一次上报。电脑名相同的不同设备 ID 会分别保留；版本与状态以上报时间为准。</p></div><button type="button" className="secondary-action" disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} />刷新</button></div>
    <div className="admin-panel feedback-filters">
      <label>搜索客户端<input type="search" placeholder="姓名、工号、电脑名或设备 ID" value={search} onChange={event => { setSearch(event.target.value); setClientPage(1); }} /></label>
      <label>当前版本<select value={version} onChange={event => { setVersion(event.target.value); setClientPage(1); }}><option value="">全部版本</option>{[...new Set([...versions, ...(version ? [version] : [])])].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>更新状态<select value={status} onChange={event => { setStatus(event.target.value); setClientPage(1); }}><option value="">全部状态</option>{[...new Set([...Object.keys(statuses), ...clients.map(client => client.updateStatus)])].map(value => <option key={value} value={value}>{statuses[value] || value}</option>)}</select></label>
      <button type="button" className="secondary-action" onClick={() => { setSearch(''); setVersion(''); setStatus(''); setClientPage(1); }}>重置</button>
    </div>
    {error && <div className="model-form-error" role="alert">{error}</div>}
    {busy ? <div className="empty-state" role="status">加载中…</div> : <>
    <section className="admin-panel table-panel"><div className="toolbar"><strong>客户端上报</strong><span>匹配 {filteredClients.length} 条 / 已加载 {clients.length} 条（最近 1000 条）</span></div><div className="data-grid-wrap"><table className="data-grid client-report-table" aria-label="客户端上报"><thead><tr><th>人员 / 电脑</th><th>当前版本</th><th>更新状态</th><th>目标版本</th><th>最近上报</th></tr></thead><tbody>{filteredClients.slice((currentClientPage - 1) * pageSize, currentClientPage * pageSize).map(client => <tr key={`${client.userId}/${client.deviceId}`}><td>{client.name}（{client.employeeNo}）<small className="distribution-subtext">{client.computerName || "未上报电脑名"}</small><small className="distribution-subtext">设备 ID：{client.deviceId}</small></td><td>{client.version}</td><td>{statuses[client.updateStatus] || client.updateStatus}<small className="distribution-subtext">{client.error}</small></td><td>{client.targetVersion || '—'}</td><td>{new Date(client.lastSeenAt).toLocaleString('zh-CN')}</td></tr>)}</tbody></table></div>{filteredClients.length === 0 && <div className="empty-state">{clients.length ? '没有符合筛选条件的客户端。' : '支持此功能的客户端登录后会自动上报。'}</div>}<AntPagination onPageSizeChange={setPageSize} ariaLabel="客户端上报分页" current={currentClientPage} total={filteredClients.length} pageSize={pageSize} onChange={setClientPage} /></section>
    </>}
  </div>;
}
