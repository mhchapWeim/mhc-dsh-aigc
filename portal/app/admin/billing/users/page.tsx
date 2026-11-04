'use client';

import { SearchableSelect } from '../../../components/modern-select';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Download, UsersRound, Building2, Bot, Activity } from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import { apiRequest, hasBackend } from '../../../lib/api-client';
import { AntPagination } from '../../../components/ant-pagination';
import { Modal } from '../../../components/modal';
import '../billing.css';

type Row = {
  userId?: string; employeeNo?: string; userName?: string; departmentName?: string;
  modelName?: string; modelIdentifier?: string;
  inputTokens?: number; outputTokens?: number; totalTokens: number; chargedTokens: number; requests: number;
};
type Point = { date: string; totalTokens: number; chargedTokens: number; requests: number };
type Report = {
  from: string; to: string; trend: Point[];
  byUser: Row[]; byDepartment: Row[]; byModel: Row[]; totals: Row;
  pending: Array<{ id: string; userName: string; modelName: string; reservedTokens: number; createdAt: string }>;
};
const num = (value: number | undefined) => (value ?? 0).toLocaleString('zh-CN');
const axis = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M`
  : value >= 1_000 ? `${(value / 1_000).toFixed(0)}K` : String(value);
const COLORS = { total: '#2f6fed', charged: '#e0713d', requests: '#5a9e6f' };
const PAGE = 10;

export default function BillingUsersPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [group, setGroup] = useState<'byUser' | 'byDepartment' | 'byModel'>('byUser');
  const [departmentId, setDepartmentId] = useState('');
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [release, setRelease] = useState<{ id: string; reason: string } | null>(null);
  const [directory, setDirectory] = useState<{ users: Array<{ id: string; name: string; employeeNo: string; departmentId: string | null }>; departments: Array<{ id: string; name: string }> } | null>(null);

  const load = useCallback(async () => {
    if (!hasBackend) { setError('请先配置 API，用度数据不使用本地模拟记录。'); return; }
    setBusy(true); setError('');
    try {
      const query = new URLSearchParams();
      if (from) query.set('from', new Date(from + 'T00:00:00+08:00').toISOString());
      if (to) query.set('to', new Date(to + 'T00:00:00+08:00').toISOString());
      if (departmentId) query.set('departmentId', departmentId);
      if (userId) query.set('userId', userId);
      const [usage, dir] = await Promise.all([
        apiRequest<Report>('/api/billing/report?' + query),
        apiRequest<{ users: Array<{ id: string; name: string; employeeNo: string; departmentId: string | null }>; departments: Array<{ id: string; name: string }> }>('/api/billing'),
      ]);
      setReport(usage); setDirectory({ users: dir.users, departments: dir.departments }); setPage(1);
    } catch (e) { setReport(null); setError(e instanceof Error ? e.message : '用度报表加载失败'); }
    finally { setBusy(false); }
  }, [from, to, departmentId, userId]);
  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => report?.[group] ?? [], [report, group]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE));
  const currentPage = Math.min(page, pageCount);
  const visible = rows.slice((currentPage - 1) * PAGE, currentPage * PAGE);
  const trend = report?.trend ?? [];
  const departmentBars = useMemo(() => [...(report?.byDepartment ?? [])]
    .sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 8)
    .map(x => ({ name: x.departmentName || '未分配部门', 原始: x.totalTokens, 计费: x.chargedTokens })), [report]);
  const modelBars = useMemo(() => [...(report?.byModel ?? [])]
    .sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 8)
    .map(x => ({ name: x.modelIdentifier || x.modelName || '未知模型', 原始: x.totalTokens, 计费: x.chargedTokens })), [report]);

  const csv = () => {
    const quote = (v: unknown) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const lines = [['部门', '姓名', '工号', '模型', '原始token', '计费token', '请求数'],
      ...rows.map(x => [x.departmentName, x.userName, x.employeeNo, x.modelName, x.totalTokens, x.chargedTokens, x.requests])];
    const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.map(x => x.map(quote).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'token-usage.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const releasePending = async (event: React.FormEvent) => {
    event.preventDefault(); if (!release) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await apiRequest(`/api/billing/pending/${release.id}/release`, { method: 'POST', body: JSON.stringify({ reason: release.reason }) });
      setRelease(null); setNotice('已释放预占，额度已返还本周剩余。'); await load();
    } catch (e) { setError(e instanceof Error ? e.message : '释放失败'); }
    finally { setBusy(false); }
  };

  const activeUsers = report?.byUser.length ?? 0;

  return <div className="admin-page page-enter billing-page">
    <div className="page-title"><div><span className="section-kicker">TOKEN USAGE</span><h1>计费报表</h1>
      <p>外部模型按实际 token 用量计入周配额，倍率仅作展示；内部模型不计费。</p></div>
      <button className="secondary-action" disabled={busy} onClick={() => void load()}><RefreshCw size={16} />刷新</button></div>
    {error && <p role="alert" className="model-form-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}

    <section className="admin-panel billing-panel-body"><div className="billing-filters">
      <label>开始日期<input aria-label="开始日期" type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label>结束日期（不含）<input aria-label="结束日期" type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
      <label>部门<SearchableSelect aria-label="部门筛选" value={departmentId} onChange={e => { setDepartmentId(e.target.value); setUserId(''); }}>
        <option value="">全部部门</option>{directory?.departments.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</SearchableSelect></label>
      <label>个人<SearchableSelect aria-label="个人筛选" value={userId} onChange={e => setUserId(e.target.value)}>
        <option value="">全部人员</option>{directory?.users.filter(x => !departmentId || x.departmentId === departmentId)
          .map(x => <option key={x.id} value={x.id}>{x.name} · {x.employeeNo}</option>)}</SearchableSelect></label>
    </div>{!from && !to && <p className="billing-hint">未选日期时默认展示本周（周一 00:00 起）。</p>}</section>

    <section className="billing-stats" aria-label="用量汇总">
      <article className="billing-stat"><span className="billing-stat__label">原始 token</span>
        <strong>{num(report?.totals.totalTokens)}</strong><small>上游实际输入 + 输出</small></article>
      <article className="billing-stat"><span className="billing-stat__label">计费 token</span>
        <strong>{num(report?.totals.chargedTokens)}</strong><small>按实际用量计费，历史结算保留原值</small></article>
      <article className="billing-stat"><span className="billing-stat__label">请求数</span>
        <strong>{num(report?.totals.requests)}</strong><small>已结算</small></article>
      <article className="billing-stat"><span className="billing-stat__label">活跃用户</span>
        <strong>{num(activeUsers)}</strong><small>本期有用量</small></article>
    </section>

    <section className="admin-panel billing-panel-body">
      <div className="billing-chart-head"><h2><Activity size={17} />用量趋势</h2><p>按日聚合，原始与计费 token 双线对照。</p></div>
      {trend.length === 0
        ? <p className="billing-chart-empty">所选区间暂无已结算用量</p>
        : <div className="billing-chart" role="img" aria-label="按日 token 用量趋势折线图">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={trend} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="billingTotal" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLORS.total} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={COLORS.total} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--dsw-alias-border-subtle, #e6e8ee)" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
                tickFormatter={(value: string) => value.slice(5)} />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={axis} width={46} />
              <Tooltip formatter={(value, name) => [`${num(Number(value))} token`, String(name)]}
                labelFormatter={label => String(label)} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="totalTokens" name="原始 token" stroke={COLORS.total}
                strokeWidth={2} fill="url(#billingTotal)" dot={false} activeDot={{ r: 4 }} />
              <Area type="monotone" dataKey="chargedTokens" name="计费 token" stroke={COLORS.charged}
                strokeWidth={2} fillOpacity={0} strokeDasharray="4 3" dot={false} activeDot={{ r: 4 }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>}
    </section>

    <div className="billing-chart-grid">
      <section className="admin-panel billing-panel-body">
        <div className="billing-chart-head"><h2><Building2 size={17} />部门用量</h2><p>Top 8，按原始 token 排序。</p></div>
        {departmentBars.length === 0 ? <p className="billing-chart-empty">暂无数据</p>
          : <div className="billing-chart" role="img" aria-label="部门 token 用量柱状图">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={departmentBars} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--dsw-alias-border-subtle, #e6e8ee)" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval={0} height={38} />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={axis} width={46} />
                <Tooltip formatter={(value, name) => [`${num(Number(value))} token`, String(name)]} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="原始" fill={COLORS.total} radius={[4, 4, 0, 0]} maxBarSize={38} />
                <Bar dataKey="计费" fill={COLORS.charged} radius={[4, 4, 0, 0]} maxBarSize={38} />
              </BarChart>
            </ResponsiveContainer>
          </div>}
      </section>
      <section className="admin-panel billing-panel-body">
        <div className="billing-chart-head"><h2><Bot size={17} />模型用量</h2><p>Top 8 外部模型。</p></div>
        {modelBars.length === 0 ? <p className="billing-chart-empty">暂无数据</p>
          : <div className="billing-chart" role="img" aria-label="模型 token 用量柱状图">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={modelBars} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--dsw-alias-border-subtle, #e6e8ee)" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval={0} height={38} />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={axis} width={46} />
                <Tooltip formatter={(value, name) => [`${num(Number(value))} token`, String(name)]} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="原始" fill={COLORS.requests} radius={[4, 4, 0, 0]} maxBarSize={38} />
                <Bar dataKey="计费" fill={COLORS.charged} radius={[4, 4, 0, 0]} maxBarSize={38} />
              </BarChart>
            </ResponsiveContainer>
          </div>}
      </section>
    </div>

    <section className="admin-panel table-panel">
      <div className="toolbar">
        <div className="billing-tabs" role="tablist" aria-label="汇总维度">
          {([['byUser', '按个人'], ['byDepartment', '按部门'], ['byModel', '按模型']] as const).map(([id, label]) =>
            <button key={id} role="tab" aria-selected={group === id} onClick={() => { setGroup(id); setPage(1); }}>{label}</button>)}
        </div>
        <button className="secondary-action" disabled={!rows.length} onClick={csv}><Download size={16} />导出 CSV</button>
      </div>
      <div className="table-wrap"><table className="data-grid" aria-label="Token用度报表">
        <thead><tr><th>部门 / 模型</th><th>姓名 / 标识</th><th>输入</th><th>输出</th><th>原始 token</th><th>计费 token</th><th>请求数</th></tr></thead>
        <tbody>{visible.map((x, i) => <tr key={`${x.userId ?? x.modelIdentifier ?? x.departmentName}-${i}`}>
          <td>{x.modelName ?? x.departmentName ?? '—'}</td>
          <td>{x.userName ?? x.modelIdentifier ?? '—'}</td>
          <td>{num(x.inputTokens)}</td><td>{num(x.outputTokens)}</td>
          <td>{num(x.totalTokens)}</td><td>{num(x.chargedTokens)}</td><td>{num(x.requests)}</td></tr>)}</tbody>
      </table></div>
      {!visible.length && !busy && <p className="empty-state">暂无已结算用量</p>}
      <AntPagination ariaLabel="用度报表分页" current={currentPage} total={rows.length} pageSize={PAGE} onChange={setPage} />
    </section>

    {!!report?.pending.length && <section className="admin-panel billing-panel-body">
      <div className="billing-chart-head"><h2>待核对预占</h2>
        <p>请求未返回实际用量时保留预占，避免漏扣。请先核对 LiteLLM 上游记录，再释放。</p></div>
      <div className="billing-pending-list">{report.pending.map(x => <div key={x.id} className="billing-pending">
        <span>{x.userName} · {x.modelName} · {num(x.reservedTokens)} token · {new Date(x.createdAt).toLocaleString()}</span>
        <button className="secondary-action" onClick={() => setRelease({ id: x.id, reason: '' })}>核对后释放</button></div>)}</div>
    </section>}

    {release && <Modal title="释放待核对预占" onClose={() => setRelease(null)}>
      <form className="entity-form" onSubmit={releasePending}>
        <label>核对结果及释放原因<textarea required maxLength={200} value={release.reason}
          onChange={e => setRelease({ ...release, reason: e.target.value })} /></label>
        <footer className="modal-actions"><button type="button" onClick={() => setRelease(null)}>取消</button>
          <button className="primary-action" disabled={busy}>确认释放</button></footer>
      </form>
    </Modal>}
  </div>;
}
