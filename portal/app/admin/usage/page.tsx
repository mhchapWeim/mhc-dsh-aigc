'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiRequest, hasBackend } from '../../lib/api-client';
import { AntPagination } from '../../components/ant-pagination';
import './usage.css';

type Usage = {
  quota: { assigned: boolean; planName: string | null; source: string; total: number; used: number; remaining: number; weekStart: string; resetsAt: string };
  extraTokens: number; checkedAt: string;
  packages: { items: { id: string; tokens: number; createdAt: string; expiresAt: string; reason: string }[]; total: number };
};
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
export default function MyUsagePage() {
  const [data, setData] = useState<Usage | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setBusy(true); setError(''); setData(null);
    try {
      if (!hasBackend) throw new Error('请先配置 API，登录后查看真实用量。');
      setData(await apiRequest<Usage>(`/api/billing/me?page=${page}&pageSize=${pageSize}`));
    } catch (e) { setError(e instanceof Error ? e.message : '用量加载失败'); }
    finally { setBusy(false); }
  }, [page, pageSize]);
  useEffect(() => { void load(); }, [load]);
  const quota = data?.quota;
  return <div className="admin-page page-enter my-usage">
    <div className="page-title"><div><h1>我的用量</h1><p>查看分配给你的计费配方、流量包和本周 Token 用量。</p></div><button type="button" className="secondary-action" disabled={busy} onClick={() => void load()}>刷新</button></div>
    {busy && <p className="empty-state" role="status">正在加载用量…</p>}
    {error && <p className="model-form-error" role="alert">{error}</p>}
    {data && quota && <>
      <section className="admin-panel usage-plan" aria-label="当前计费配方"><h2>{quota.planName ?? '尚未分配计费配方'}</h2><p>来源：{quota.source === 'User' ? '个人分配' : quota.source === 'Department' ? '继承部门' : '未分配'}</p>
        {!quota.assigned && <p role="status">当前没有生效的计费配方，请联系管理员。流量包需配合有效配方使用。</p>}
        <p>本周周期：{date(quota.weekStart)} 至 {date(quota.resetsAt)}（北京时间）</p>
        <p>每周一 00:00 重置，增量包同时到期，未使用额度不结转。</p></section>
      <section className="usage-stats" aria-label="本周额度">{[
        ['本周总额度', quota.total], ['已结算用量', quota.used], ['剩余额度', quota.remaining], ['本周获赠增量', data.extraTokens],
      ].map(([label, value]) => <div className="admin-panel usage-stat" key={label}><span>{label}</span><strong>{Number(value).toLocaleString('zh-CN')}</strong><small>Token</small></div>)}</section>
      <p>用量按模型倍率结算后扣减，进行中的请求可能尚未计入。数据查询时间：{date(data.checkedAt)}（北京时间）。总额度已包含生效的增量包。</p>
      <section className="admin-panel table-panel"><div className="table-meta"><h2>我的流量包</h2><span>共 {data.packages.total} 条发放记录</span></div>
        <div className="table-wrap"><table className="data-grid" aria-label="我的流量包"><thead><tr><th>增加 Token</th><th>发放时间（北京时间）</th><th>到期时间（北京时间）</th><th>状态</th><th>发放原因</th></tr></thead><tbody>{data.packages.items.map(item => <tr key={item.id}><td>{item.tokens.toLocaleString('zh-CN')}</td><td>{date(item.createdAt)}</td><td>{date(item.expiresAt)}</td><td>{new Date(item.expiresAt) <= new Date(data.checkedAt) ? '已到期' : quota.assigned ? '本周期有效' : '等待有效配方'}</td><td className="usage-reason">{item.reason}</td></tr>)}</tbody></table></div>
        {!data.packages.items.length && <p className="empty-state">暂无流量包发放记录</p>}
        <AntPagination ariaLabel="我的流量包分页" current={page} pageSize={pageSize} total={data.packages.total} onChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1); }} />
      </section>
    </>}
  </div>;
}
