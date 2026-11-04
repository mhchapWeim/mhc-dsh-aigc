'use client';

import { SearchableSelect } from '../../../components/modern-select';
import { Search, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { apiRequest, hasBackend } from '../../../lib/api-client';
import { Modal } from '../../../components/modal';
import { AntPagination } from '../../../components/ant-pagination';
import '../billing.css';
import { TokenAmountInput } from '../token-amount-input';

type Package = { id: string; userName: string; employeeNo: string; tokens: number; createdAt: string; expiresAt: string; createdBy: string | null; reason: string };
type User = { id: string; name: string; employeeNo: string };
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
export default function IncrementPackagesPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [items, setItems] = useState<Package[]>([]);
  const [total, setTotal] = useState(0);
  const [checkedAt, setCheckedAt] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [keyword, setKeyword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  const [userId, setUserId] = useState('');
  const [selectedUser, setSelectedUser] = useState('');
  useEffect(() => { setSelectedUser(new URLSearchParams(window.location.search).get('userId') ?? ''); }, []);
  const [tokens, setTokens] = useState(1000000);
  const [reason, setReason] = useState('');
  const load = useCallback(async () => {
    if (!hasBackend) { setError('请先配置 API，增量包不使用模拟数据。'); return; }
    setBusy(true); setError('');
    try {
      const [directory, records] = await Promise.all([
        apiRequest<{ users: User[] }>('/api/billing'),
        apiRequest<{ items: Package[]; total: number }>(`/api/billing/packages?page=${page}&pageSize=${pageSize}&keyword=${encodeURIComponent(keyword)}${selectedUser ? `&userId=${encodeURIComponent(selectedUser)}` : ''}`),
      ]);
      setUsers(directory.users); setItems(records.items); setTotal(records.total); setCheckedAt(Date.now());
    } catch (e) { setItems([]); setTotal(0); setError(e instanceof Error ? e.message : '加载失败'); }
    finally { setBusy(false); }
  }, [page, pageSize, keyword, selectedUser]);
  useEffect(() => { const timer = setTimeout(() => { void load(); }, 200); return () => clearTimeout(timer); }, [load]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      await apiRequest('/api/billing/packages', { method: 'POST', body: JSON.stringify({ userId, tokens, reason }) });
      setEditing(false); setNotice('增量包已发放，原配方和重置时间保持不变。'); await load();
    } catch (e) { setError(e instanceof Error ? e.message : '发放失败'); }
    finally { setBusy(false); }
  }
  return <div className="admin-page page-enter billing-page">
    <div className="page-title"><div><h1>增量包管理</h1><p>为个人增加本周期 token，可用于个人配方或继承的部门配方。每周一北京时间 00:00 到期，未用完的增量不结转。</p></div>
      <button type="button" className="primary-action" disabled={busy || !users.length} onClick={() => { setUserId(selectedUser); setTokens(1000000); setReason(''); setError(''); setEditing(true); }}>增加流量</button></div>
    {error && <p role="alert" className="model-form-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <section className="admin-panel table-panel">
      <div className="toolbar"><label>用户<SearchableSelect aria-label="筛选用户" value={selectedUser} onChange={e => { setSelectedUser(e.target.value); setPage(1); }}><option value="">全部用户</option>{users.map(x => <option key={x.id} value={x.id}>{x.name}（{x.employeeNo}）</option>)}</SearchableSelect></label><label className="table-search"><Search size={18} /><input type="search" aria-label="查询记录" maxLength={200} value={keyword} placeholder="搜索姓名、工号或发放原因" onChange={e => { setKeyword(e.target.value); setPage(1); }} /></label>
        <button type="button" className="secondary-action" disabled={busy} onClick={() => void load()}><RefreshCw size={16} />刷新</button></div>
      <div className="table-wrap"><table className="data-grid" aria-label="增量包记录"><thead><tr><th>用户</th><th>增加 token</th><th>发放时间（北京时间）</th><th>到期时间（北京时间）</th><th>状态</th><th>原因</th><th>发放人 ID</th></tr></thead>
        <tbody>{items.map(x => <tr key={x.id}><td>{x.userName}<small>{x.employeeNo}</small></td><td>{x.tokens.toLocaleString('zh-CN')}</td><td>{date(x.createdAt)}</td><td>{date(x.expiresAt)}</td><td>{new Date(x.expiresAt).getTime() > checkedAt ? '本周期有效' : '已到期'}</td><td className="billing-package-reason">{x.reason}</td><td>{x.createdBy ?? '—'}</td></tr>)}</tbody></table></div>
      {busy && <p className="empty-state" role="status">正在处理…</p>}
      {!busy && !items.length && <p className="empty-state">暂无增量包记录</p>}
      <AntPagination ariaLabel="增量包记录分页" current={page} total={total} pageSize={pageSize} onChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1); }} />
    </section>
    {editing && <Modal className="billing-plan-modal" title="增加流量" onClose={() => { if (!busy) setEditing(false); }}><form className="entity-form" onSubmit={save}>
      <div className="billing-plan-body" tabIndex={0} aria-label="增量包配置">
        {error && <p role="alert" className="model-form-error">{error}</p>}
        <label>用户<SearchableSelect aria-label="用户" required value={userId} disabled={busy} onChange={e => setUserId(e.target.value)}><option value="">请选择用户</option>{users.map(x => <option key={x.id} value={x.id}>{x.name}（{x.employeeNo}）</option>)}</SearchableSelect></label>
        <TokenAmountInput label="增加 token" disabled={busy} value={tokens} onChange={setTokens} />
        <label>发放原因<textarea required maxLength={500} disabled={busy} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <p className="billing-hint">立即生效，不改变原配方和重置时间。下次重置时自动失效，发放记录永久保留。</p>
      </div><footer className="modal-actions"><button type="button" disabled={busy} onClick={() => setEditing(false)}>取消</button><button type="submit" className="primary-action" disabled={busy}>确认发放</button></footer>
    </form></Modal>}
  </div>;
}
