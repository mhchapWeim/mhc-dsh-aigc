'use client';

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { AntPagination } from '../../../components/ant-pagination';
import { getPlugins, getPluginGrantOptions, getPluginReports, type PluginReportPage } from '../../../lib/plugin-api';
import '../plugins.css';

const statuses: Record<string, string> = { Active: '已生效', Disabled: '已停用', RestartRequired: '等待重启', Incompatible: '版本不兼容', Failed: '失败' };
const pageSize = 20;

export default function PluginStatusPage() {
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<PluginReportPage>({ items: [], total: 0, page: 1, pageSize });
  const [pluginNames, setPluginNames] = useState<Record<string, string>>({});
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void Promise.all([getPluginReports(page, pageSize), getPlugins(), getPluginGrantOptions()]).then(([reports, plugins, options]) => {
      if (!active) return;
      setResult(reports);
      setPluginNames(Object.fromEntries(plugins.map(plugin => [plugin.id, plugin.name])));
      setUserNames(Object.fromEntries(options.users.map(user => [user.id, user.name])));
    }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, refresh]);
  return <div className="plugin-market">
    <div className="page-title"><div><span className="section-kicker">DSH PLUGIN STATUS</span><h1>插件状态</h1><p>查看客户端上报的实际运行状态。离线客户端以最后上报时间为准。</p></div>
      <button type="button" className="secondary-action" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} />刷新</button></div>
    {error && <div role="alert" className="model-form-error">{error}</div>}
    {!loading && !error && result.legacyResponse && <p role="status" className="plugin-notice">当前后端仍返回旧版数据，已在页面内分页，最多展示最近 500 条。请更新并重启 AIGC 后端以启用完整分页。</p>}
    <section className="admin-panel plugin-status-panel" aria-label="客户端插件状态" aria-busy={loading}>
      {loading ? <p role="status">正在读取客户端状态…</p> : error ? <p>读取失败，请刷新重试。</p> : <>
        <div className="plugin-table-scroll"><table className="plugin-status-table" aria-label="客户端插件状态表格"><thead><tr>
          <th scope="col">插件</th><th scope="col">设备 / 用户</th><th scope="col">版本</th><th scope="col">状态</th><th scope="col">策略版本</th><th scope="col">最近上报</th><th scope="col">诊断</th>
        </tr></thead><tbody>{result.items.map(report => <tr key={`${report.userId}/${report.deviceId}/${report.pluginId}`}>
          <td>{pluginNames[report.pluginId] ?? report.pluginId}</td><td>{report.deviceId}<small>{userNames[report.userId] ?? report.userId}</small></td>
          <td>{report.version || '—'}</td><td>{statuses[report.status] ?? report.status}</td><td>{report.revision}</td>
          <td>{new Date(report.updatedAt).toLocaleString()}</td><td>{report.error || '—'}</td>
        </tr>)}</tbody></table></div>
        {result.items.length === 0 && <p className="table-empty">尚无客户端回报。</p>}
        <AntPagination ariaLabel="插件状态分页" current={result.page} pageSize={result.pageSize} total={result.total} onChange={setPage} />
      </>}
    </section>
  </div>;
}
