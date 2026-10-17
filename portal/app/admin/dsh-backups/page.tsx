"use client";

import { useEffect, useState } from 'react';
import { getDshBackups, deleteDshBackup, downloadDshBackup, type DshBackupRow } from '../../lib/api-client';
import { AntPagination } from '../../components/ant-pagination';
import { Modal } from '../../components/modal';
import './style.css';

const time = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN') : '暂无记录';
export default function DshBackupsPage() {
  const [rows, setRows] = useState<DshBackupRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<DshBackupRow | null>(null);
  const reload = (update?: () => void) => {
    setLoading(true); setError(''); update?.(); setRefresh(value => value + 1);
  };
  useEffect(() => {
    let active = true;
    getDshBackups(page, search).then(value => { if (active) { setRows(value.items); setTotal(value.total); } })
      .catch(cause => { if (active) { setRows([]); setTotal(0); setError(cause instanceof Error ? cause.message : '加载失败'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, search, refresh]);
  async function run(operation: () => Promise<void>) {
    setBusy(true); setError('');
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setBusy(false); }
  }
  return <div className="admin-page page-enter">
    <div className="page-title"><div><h1>客户端备份</h1><p>普通用户管理自己的备份，平台管理员可查看和删除全部备份。下载仅限本人。</p></div>
      <button type="button" className="secondary-action" disabled={loading || busy} onClick={() => reload()}>刷新</button></div>
    <div className="admin-panel backup-filters"><label>搜索用户<input aria-label="搜索用户" value={search} onChange={event => { reload(() => { setSearch(event.target.value); setPage(1); }); }} placeholder="姓名或工号" /></label>
      <button type="button" className="secondary-action" onClick={() => { reload(() => { setSearch(''); setPage(1); }); }}>重置</button></div>
    {error && <p className="model-form-error" role="alert">{error}</p>}
    <section className="admin-panel table-panel" aria-busy={loading || busy}>
      <div className="table-meta"><span>共 {total} 份备份</span><span>备份时间倒序</span></div>
      <div className="backup-table"><table className="data-grid"><thead><tr><th>所属用户</th><th>上次登录时间</th><th>备份时间</th><th>上传范围</th><th>会话数</th><th>大小</th><th>操作</th></tr></thead><tbody>
        {rows.map(row => <tr key={row.id}><td>{row.userName}<br /><small>{row.employeeNo}</small></td><td>{time(row.lastLoginAt)}</td><td>{time(row.createdAt)}</td><td>{row.scope === 'all' ? '全部历史' : '选中历史'}</td><td>{row.sessionCount}</td><td>{(row.bytes / 1024 / 1024).toFixed(2)} MiB</td>
          <td><div className="backup-actions"><button type="button" className="secondary-action" onClick={() => setDetail(row)}>查看</button>
            {row.canDownload && <button type="button" className="secondary-action" disabled={busy} onClick={() => { void run(() => downloadDshBackup(row.id)); }}>下载</button>}
            <button type="button" className="secondary-action" disabled={busy} onClick={() => {
              if (window.confirm('永久删除这份云端备份？客户端已有数据会保留。')) void run(async () => {
                await deleteDshBackup(row.id); reload(() => setPage(1));
              });
            }}>删除</button></div></td></tr>)}
      </tbody></table></div>
      {loading && <p className="empty-state" role="status">正在加载备份…</p>}
      {!loading && rows.length === 0 && !error && <p className="empty-state">暂无备份</p>}
      <AntPagination ariaLabel="客户端备份分页" current={page} total={total} pageSize={20} onChange={value => { reload(() => setPage(value)); }} />
    </section>
    {detail && <Modal title="备份详情" className="backup-dialog" onClose={() => setDetail(null)}>
      <div className="backup-dialog-body" tabIndex={0} aria-label="备份详情内容"><dl>
        {([['所属用户', `${detail.userName}（${detail.employeeNo}）`], ['上次登录时间', time(detail.lastLoginAt)], ['备份时间', time(detail.createdAt)], ['备份编号', detail.id], ['上传范围', detail.scope === 'all' ? '全部历史' : '选中历史'], ['会话数', String(detail.sessionCount)], ['SHA-256', detail.sha256]]).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl><p>备份包含会话历史，不包含项目文件、登录凭证或本机设置。登录时间取账号最近一次成功登录记录。</p></div>
      <footer><button type="button" className="secondary-action" onClick={() => setDetail(null)}>关闭</button></footer>
    </Modal>}
  </div>;
}
