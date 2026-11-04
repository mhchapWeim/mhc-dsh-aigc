'use client';

import { SearchableSelect } from '../../../components/modern-select';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, RefreshCw, Copy, Send } from 'lucide-react';
import { hasBackend } from '../../../lib/api-client';
import { getUserSyncConnection, getUserSyncSummary, getUserSyncBatches, getUserSyncMessages, startUserSnapshot, retryUserSyncMessage, userSyncConsumerInfo, syncStatusNames,
  type UserSyncConnection, type UserSyncSummary, type UserSyncBatch, type UserSyncMessage } from '../../../lib/user-sync-api';
import { AntPagination } from '../../../components/ant-pagination';
import { Modal } from '../../../components/modal';
import '../user-sync.css';
const date = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';
const events: Record<string, string> = { 'user.snapshot': '全量快照', 'user.upsert': '新增 / 变更', 'user.deleted': '删除' };

export default function UserSyncPage() {
  const [connection, setConnection] = useState<UserSyncConnection | null>(null);
  const [summary, setSummary] = useState<UserSyncSummary | null>(null);
  const [batches, setBatches] = useState<UserSyncBatch[]>([]);
  const [items, setItems] = useState<UserSyncMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('');
  const [batchId, setBatchId] = useState('');
  const [consumer, setConsumer] = useState(0);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [detail, setDetail] = useState<UserSyncMessage | null>(null);
  const snapshotId = useRef<string | null>(null);
  const revision = useRef(0);
  const invalidate = useCallback(() => { revision.current++; }, []);
  const load = useCallback(async () => {
    const current = ++revision.current;
    if (!hasBackend) { setError('请先配置 API，用户同步不使用模拟数据。'); setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), keyword, status, ...(batchId ? { batchId } : {}) });
      const [info, counts, jobs, records] = await Promise.all([getUserSyncConnection(), getUserSyncSummary(), getUserSyncBatches(), getUserSyncMessages(params)]);
      if (revision.current !== current) return;
      setConnection(info); setSummary(counts); setBatches(jobs); setItems(records.items); setTotal(records.total); setError('');
    } catch (e) {
      if (revision.current !== current) return;
      setSummary(null); setItems([]); setTotal(0); setConnection(null); setBatches([]);
      setError(e instanceof Error ? e.message : '用户同步信息加载失败');
    } finally { if (revision.current === current) setLoading(false); }
  }, [page, pageSize, keyword, status, batchId]);
  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 200);
    const interval = setInterval(() => { void load(); }, 5000);
    return () => { clearTimeout(timer); clearInterval(interval); invalidate(); };
  }, [load, invalidate]);
  async function snapshot() {
    if (working || !snapshotId.current) return;
    setWorking(true); setError(''); setNotice('');
    try {
      const job = await startUserSnapshot(snapshotId.current);
      setConfirm(false); snapshotId.current = null; setPage(1); setStatus(''); setBatchId(job.id);
      setNotice(`已生成 ${job.total} 条用户快照，后台将发送到 MQ；包含停用用户。`); await load();
    } catch (e) { setError(e instanceof Error ? e.message : '创建快照失败，可使用同一请求编号重试'); }
    finally { setWorking(false); }
  }
  async function retry(id: string) {
    setWorking(true); setError(''); setNotice('');
    try { await retryUserSyncMessage(id); setNotice('消息已重新加入待发送队列'); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : '重试失败'); }
    finally { setWorking(false); }
  }
  async function copy() {
    if (!connection) return;
    try { await navigator.clipboard.writeText(userSyncConsumerInfo(connection, consumer)); setNotice('已复制接收方 MQ 接入信息，不包含生产账号密码'); }
    catch { setError('复制失败，请从下方接入信息中手动复制'); }
  }
  return <div className="admin-page page-enter user-sync-page">
    <div className="page-title"><div><h1>用户同步</h1><p>AIGC 是用户数据源。新增、修改、部门变更和启停自动发送；此处仅确认 MQ 接收，不代表接收方已处理。</p></div>
      <div className="user-page-actions"><a className="secondary-action" href="/admin/users">返回用户管理</a><button type="button" className="primary-action" disabled={working || !connection} onClick={() => { snapshotId.current = crypto.randomUUID(); setError(''); setConfirm(true); }}><Send size={16} />全量同步</button></div></div>
    {error && <p role="alert" className="model-form-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {connection && !connection.enabled && <p className="inline-notice">自动采集已启用，MQ 发送尚未启用。消息保留在数据库；配置 nj304 连接并启用后后台会自动发送。</p>}
    <section className="user-sync-stats" aria-label="发送统计">
      <article className="admin-panel"><span>待发送</span><strong>{summary?.pending ?? '—'}</strong></article>
      <article className="admin-panel"><span>已发送至 MQ</span><strong>{summary?.sent ?? '—'}</strong></article>
      <article className="admin-panel"><span>发送失败</span><strong>{summary?.failed ?? '—'}</strong></article>
      <article className="admin-panel"><span>最近发送（北京时间）</span><p>{date(summary?.lastSentAt ?? null)}</p></article>
    </section>
    <section className="admin-panel user-sync-connection"><h2>接收方接入信息</h2>
      <p>每个服务独立消费自己的持久化队列。全量快照广播到所有已绑定队列，新增接收方前须先配置队列与绑定。</p>
      {connection && <><div className="user-sync-controls"><label>接收服务<SearchableSelect aria-label="接收服务" value={consumer} onChange={e => setConsumer(Number(e.target.value))}>{connection.consumers.map((x, i) => <option key={x.queue} value={i}>{x.serviceName} · {x.queue}</option>)}</SearchableSelect></label>
        <button type="button" className="secondary-action" disabled={!connection.consumers.length} onClick={() => void copy()}><Copy size={16} />复制 MQ 信息</button></div>
        <details><summary>查看接入配置与消费约定</summary><pre tabIndex={0} aria-label="MQ 接入配置">{userSyncConsumerInfo(connection, consumer)}</pre><p>同一用户按 userVersion 保留最高版本；相同版本的快照可忽略。user.deleted 为删除标记。消息不包含密码、密码哈希或 Token。</p></details></>}
    </section>
    <section className="admin-panel user-sync-batches"><h2>最近全量同步</h2>{batches.length ? <ul>{batches.map(x => <li key={x.id}><button type="button" className="secondary-action" onClick={() => { setBatchId(x.id); setPage(1); }}>{date(x.createdAt)}</button><span>已发送 {x.sent} / {x.total}，待发送 {x.total - x.sent - x.failed}，失败 {x.failed}</span></li>)}</ul> : <p>暂无全量任务</p>}</section>
    <section className="admin-panel table-panel">
      <div className="toolbar"><label className="table-search"><Search size={18} /><input type="search" maxLength={100} aria-label="查询同步记录" placeholder="搜索姓名或工号" value={keyword} onChange={e => { setKeyword(e.target.value); setPage(1); }} /></label>
        <div className="user-sync-controls"><label>发送状态<SearchableSelect aria-label="发送状态" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="">全部状态</option>{Object.entries(syncStatusNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</SearchableSelect></label>
          {batchId && <button type="button" className="secondary-action" onClick={() => { setBatchId(''); setPage(1); }}>清除批次筛选</button>}
          <button type="button" className="secondary-action" disabled={loading || working} onClick={() => void load()}><RefreshCw size={16} />刷新</button></div></div>
      <div className="table-meta"><span>{batchId ? `当前批次：${batchId}` : '全部增量与全量消息'}</span><span>每 5 秒刷新</span></div>
      <div className="table-wrap"><table className="data-grid" aria-label="用户同步记录"><thead><tr><th>用户</th><th>类型 / 数据版本</th><th>状态</th><th>发送时间（北京时间）</th><th>尝试次数</th><th>操作</th></tr></thead>
        <tbody>{items.map(x => <tr key={x.id}><td>{x.userName}<small className="distribution-subtext">{x.employeeNo}</small></td><td>{events[x.eventType] ?? x.eventType}<small className="distribution-subtext">v{x.userVersion}</small></td><td>{syncStatusNames[x.status]}</td><td>{date(x.sentAt)}</td><td>{x.attempts}</td><td><div className="user-page-actions"><button type="button" className="secondary-action" onClick={() => setDetail(x)}>详情</button>{x.status === 'Failed' && <button type="button" className="secondary-action" disabled={working} onClick={() => void retry(x.id)}>重试</button>}</div></td></tr>)}</tbody></table></div>
      {loading && <p role="status" className="empty-state">正在读取同步记录…</p>}{!loading && !items.length && <p className="empty-state">暂无匹配的发送记录</p>}
      <AntPagination ariaLabel="用户同步记录分页" current={page} total={total} pageSize={pageSize} onChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1); }} />
    </section>
    {confirm && <Modal title="确认全量同步" onClose={() => { if (!working) setConfirm(false); }}><div className="entity-form"><p>将全部用户（含停用用户）生成快照，发送到所有已绑定的接收队列。不会修改用户资料，也不会等待接收方处理。</p>{error && <p role="alert" className="model-form-error">{error}</p>}<footer className="modal-actions"><button type="button" disabled={working} onClick={() => setConfirm(false)}>取消</button><button type="button" className="primary-action" disabled={working} onClick={() => void snapshot()}>{working ? '正在生成…' : '确认生成并发送'}</button></footer></div></Modal>}
    {detail && <Modal className="user-sync-detail-modal" title="发送记录详情" onClose={() => setDetail(null)}><div className="user-sync-detail-body" tabIndex={0} aria-label="发送记录详情正文"><dl><dt>事件 ID</dt><dd>{detail.id}</dd><dt>用户 ID</dt><dd>{detail.userId}</dd><dt>数据版本</dt><dd>{detail.userVersion}</dd><dt>创建时间</dt><dd>{date(detail.createdAt)}</dd><dt>发送状态</dt><dd>{syncStatusNames[detail.status]}</dd><dt>发送时间</dt><dd>{date(detail.sentAt)}</dd><dt>尝试次数</dt><dd>{detail.attempts}</dd><dt>失败原因</dt><dd>{detail.lastError || '—'}</dd><dt>后续重试</dt><dd>{detail.status !== 'Failed' ? '—' : detail.consecutiveFailures >= (connection?.maximumAttempts ?? 10) ? '自动重试已达上限，请检查配置后手动重试' : date(detail.nextAttemptAt)}</dd></dl></div><footer className="modal-actions"><button type="button" className="secondary-action" onClick={() => setDetail(null)}>关闭</button></footer></Modal>}
  </div>;
}
