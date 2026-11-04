'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { AntPagination } from '../../components/ant-pagination';
import { ModernSelect } from '../../components/modern-select';
import { usePageSize } from '../../components/use-page-size';
import { getConfigSyncDevices, type ConfigSyncPage } from '../../lib/config-sync-api';
import './updates.css';

const labels = {Applied: '客户端已应用', Pending: '待更新', Failed: '更新失败', Offline: '离线', Unreported: '未上报'};
const errors: Record<string, string> = {SNAPSHOT_FAILED: '读取授权配置或计费配方失败', APPLY_FAILED: '应用配置或刷新模型目录失败'};
const date = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN') : '—';

export default function ConfigUpdatesPage() {
  const [data, setData] = useState<ConfigSyncPage | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const cancelPending = useCallback(() => { generation.current++; }, []);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try { const value = await getConfigSyncDevices(page, pageSize, search, status);
      if (current === generation.current) { setData(value); setError(''); } }
    catch (e) { if (current === generation.current) { setData(null); setError(e instanceof Error ? e.message : '读取更新状态失败'); } }
    finally { if (current === generation.current) setLoading(false); }
  }, [page, pageSize, search, status]);
  useEffect(() => {
    const start = window.setTimeout(() => { void load(); }, 200);
    const timer = window.setInterval(() => { void load(); }, 10_000);
    return () => { cancelPending(); window.clearTimeout(start); window.clearInterval(timer); };
  }, [load, cancelPending]);
  return <div className="admin-page page-enter config-updates-page">
    <div className="page-title"><div><h1>配置更新状态</h1><p>查看模型、倍率和计费配置在各用户设备上的应用回执，每 10 秒刷新。</p></div><button className="secondary-action" disabled={loading} onClick={() => void load()}><RefreshCw size={16}/>刷新</button></div>
    {data && <>
      <div className="config-update-summary" aria-label="配置更新概览">
        <section className="admin-panel"><span>目标配置版本</span><strong>v{data.revision}</strong></section>
        <section className="admin-panel"><span>客户端已应用</span><strong>{data.summary.applied}</strong></section>
        <section className="admin-panel"><span>待更新 / 失败</span><strong>{data.summary.pending} / {data.summary.failed}</strong></section>
        <section className="admin-panel"><span>离线 / 未上报</span><strong>{data.summary.offline} / {data.summary.unreported}</strong></section>
      </div>
      <p className="config-update-transport">{data.mqConnected ? 'MQ 已连接' : data.mqEnabled ? `MQ 连接中或异常${data.mqErrorCode ? `（${data.mqErrorCode}）` : ''}` : 'MQ 未启用，使用数据库版本补偿通知'} · MQ 待发送事件 {data.pendingEvents} 条</p>
    </>}
    <section className="admin-panel config-update-filters">
      <label><span>用户姓名 / 工号</span><input type="search" aria-label="搜索更新用户" value={search} onChange={e => {setSearch(e.target.value); setPage(1);}}/></label>
      <div className="form-field"><span>更新状态</span><ModernSelect ariaLabel="配置更新状态筛选" value={status} options={[{value: '', label: '全部状态'}, ...Object.entries(labels).map(([value, label]) => ({value, label}))]} onChange={value => {setStatus(value); setPage(1);}}/></div>
    </section>
    <section className="admin-panel table-panel">
      <div className="table-meta">“客户端已应用”表示 DSH Host 已校验并应用配置后回执；MQ 发出消息不代表更新成功。超过 90 秒未收到心跳显示离线。</div>
      {error ? <div role="alert" className="model-form-error">{error}</div> : !data ? <div role="status" className="empty-state">正在读取更新状态…</div> : <>
        <div className="config-update-table"><table className="data-grid" aria-label="客户端配置更新状态"><thead><tr><th>用户</th><th>设备 / 客户端版本</th><th>更新状态</th><th>目标 / 已应用版本</th><th>最后应答</th><th>应用成功时间</th><th>失败原因</th></tr></thead><tbody>{data.items.map(item => <tr key={`${item.userId}/${item.deviceId || 'none'}`}>
          <td><strong>{item.userName}</strong><small>{item.employeeNo}</small></td><td>{item.deviceName || '—'}<small>{item.clientVersion || (item.deviceId ? '未知版本' : '未登录或客户端不支持回执')}</small></td>
          <td><span className={`config-update-state is-${item.status.toLowerCase()}`}>{labels[item.status]}</span></td>
          <td>v{item.targetRevision} / {item.appliedRevision >= 0 ? `v${item.appliedRevision}` : '未应用'}</td><td>{date(item.lastSeenAt)}</td><td>{date(item.appliedAt)}</td><td>{errors[item.errorCode] || item.errorCode || '—'}</td>
        </tr>)}</tbody></table></div>
        {!data.items.length && <div className="empty-state">暂无匹配的用户或设备</div>}
      </>}
      <AntPagination ariaLabel="配置更新状态分页" current={page} pageSize={pageSize} total={data?.total || 0} onChange={setPage} onPageSizeChange={setPageSize}/>
    </section>
  </div>;
}
