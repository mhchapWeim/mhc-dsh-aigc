'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ChartColumn, RefreshCw } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AntPagination } from '../../components/ant-pagination';
import { ModernSelect } from '../../components/modern-select';
import { usePageSize } from '../../components/use-page-size';
import { getClickReport, type ClickReport } from '../../lib/application-registry';
import '../billing/billing.css';
import './reports.css';

const periods = ['day', 'week', 'month', 'year'] as const;
const labels = ['日点击', '周点击', '月点击', '年点击'];
const number = (value: number) => value.toLocaleString('zh-CN');
const axis = (value: number) => value >= 10000 ? `${(value / 10000).toFixed(1)}万` : number(value);
const tooltip = (value: unknown) => [`${number(Number(value))} 次`, '真实点击'];

function Comparison({ title, description, data }: {title: string; description: string; data: {name: string; clicks: number}[]}) {
  return <section className="admin-panel billing-panel-body">
    <div className="billing-chart-head"><h2><ChartColumn size={17}/>{title}</h2><p>{description}</p></div>
    {!data.length ? <p className="billing-chart-empty">所选区间暂无应用数据</p> : <div className="billing-chart" role="img" aria-label={`${title}柱状对比图`}>
      <ResponsiveContainer width="100%" height={280} minWidth={0}>
        <BarChart layout="vertical" data={data} margin={{top: 8, right: 24, bottom: 0, left: 0}}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" horizontal={false}/>
          <XAxis type="number" allowDecimals={false} tickFormatter={axis} tick={{fontSize: 11}} tickLine={false} axisLine={false}/>
          <YAxis type="category" dataKey="name" width={100} tick={{fontSize: 11}} tickLine={false} axisLine={false} tickFormatter={(value: string) => value.length > 8 ? `${value.slice(0, 8)}…` : value}/>
          <Tooltip formatter={tooltip} cursor={{fill: 'var(--page)'}}/>
          <Bar dataKey="clicks" name="真实点击" fill="var(--blue-600)" radius={[0, 4, 4, 0]} maxBarSize={24} isAnimationActive={false}/>
        </BarChart>
      </ResponsiveContainer>
    </div>}
  </section>;
}

export default function ClickReportsPage() {
  const [report, setReport] = useState<ClickReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [applicationId, setApplicationId] = useState('');
  const [sort, setSort] = useState<typeof periods[number]>('day');
  const [page, setPage] = useState(1);
  const table = useRef<HTMLDivElement>(null);
  const [pageSize, setPageSize] = usePageSize(table, !loading);
  const requests = useRef({generation: 0});
  const [applications, setApplications] = useState<{id: string; name: string}[]>([]);
  const load = useCallback(async () => {
    const request = ++requests.current.generation;
    setLoading(true); setError('');
    try {
      const result = await getClickReport({from, to, applicationId});
      if (!Array.isArray(result.trend) || !Array.isArray(result.applications) || result.items.some(item => !Number.isFinite(item.rangeClicks)))
        throw new Error('点击报表接口尚未更新，请重启或更新后端服务后刷新');
      if (request === requests.current.generation) { setReport(result); setApplications(result.applications); setPage(1); }
    } catch (e) {
      if (request === requests.current.generation) { setReport(null); setError(e instanceof Error ? e.message : '点击报表加载失败'); }
    } finally { if (request === requests.current.generation) setLoading(false); }
  }, [from, to, applicationId]);
  useEffect(() => {
    const state = requests.current;
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); state.generation++; };
  }, [load]);

  const items = useMemo(() => report?.items ?? [], [report]);
  const filtered = useMemo(() => items.filter(x => `${x.name} ${x.category}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => b.clicks[sort] - a.clicks[sort] || a.name.localeCompare(b.name)), [items, search, sort]);
  const current = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)));
  const totals = periods.map(period => items.reduce((sum, x) => sum + x.clicks[period], 0));
  const rangeTotal = items.reduce((sum, x) => sum + x.rangeClicks, 0);
  const appBars = [...items].sort((a, b) => b.rangeClicks - a.rangeClicks).slice(0, 8).map(x => ({name: x.name, clicks: x.rangeClicks}));
  const categoryBars = Array.from(items.reduce((map, x) => map.set(x.category, (map.get(x.category) ?? 0) + x.rangeClicks), new Map<string, number>()), ([name, clicks]) => ({name, clicks}))
    .sort((a, b) => b.clicks - a.clicks).slice(0, 8);

  return <div className="admin-page page-enter billing-page click-report-page" aria-busy={loading}>
    <div className="page-title"><div><span className="section-kicker">APPLICATION ANALYTICS</span><h1>点击率报表</h1><p>查看真实进入趋势、应用与分类对比，以及当前自然周期的点击数量。</p></div>
      <button type="button" className="secondary-action" disabled={loading} onClick={() => void load()}><RefreshCw size={16}/>刷新</button></div>
    <section className="admin-panel billing-panel-body">
      <div className="billing-filters">
        <label>开始日期<input aria-label="点击开始日期" type="date" value={from} onChange={e => setFrom(e.target.value)}/></label>
        <label>结束日期（不含）<input aria-label="点击结束日期" type="date" value={to} onChange={e => setTo(e.target.value)}/></label>
        <div className="click-report-app-filter"><span>应用</span><ModernSelect ariaLabel="点击统计应用" value={applicationId} options={[{value: '', label: '全部注册应用'}, ...applications.map(x => ({value: x.id, label: x.name}))]} onChange={setApplicationId}/></div>
      </div>
      <p className="billing-hint">{report ? `图表区间：${report.from} 至 ${report.to}（不含），按北京时间统计。` : '默认最近 30 天，最长支持 366 天。'}同一用户 3 秒内重复点击合并，未授权点击不计数。</p>
    </section>
    {error && <p role="alert" className="model-form-error">{error}</p>}
    {loading ? <div className="empty-state" role="status">正在加载点击报表…</div> : report && <>
      <section className="billing-stats" aria-label="当前周期点击汇总">{periods.map((period, i) => <article key={period} className="billing-stat"><span className="billing-stat__label">{labels[i]}</span><strong>{number(totals[i])}</strong><small>{['今日', '本周（周一起）', '本月', '本年'][i]} · 当前展示数，含手工调整</small></article>)}</section>
      <section className="admin-panel billing-panel-body">
        <div className="billing-chart-head"><h2><Activity size={17}/>点击趋势</h2><p>所选区间共 {number(rangeTotal)} 次真实点击 · 不含手工调整</p></div>
        <div className="billing-chart" role="img" aria-label="按日真实点击趋势折线图">
          <ResponsiveContainer width="100%" height={260} minWidth={0}>
            <AreaChart data={report.trend} margin={{top: 12, right: 16, bottom: 0, left: 0}}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false}/>
              <XAxis dataKey="date" tickFormatter={(value: string) => value.slice(5)} tick={{fontSize: 11}} tickLine={false} axisLine={false} minTickGap={24}/>
              <YAxis allowDecimals={false} tickFormatter={axis} tick={{fontSize: 11}} tickLine={false} axisLine={false} width={50}/>
              <Tooltip formatter={tooltip}/>
              <Area type="linear" dataKey="clicks" name="真实点击" stroke="var(--blue-600)" strokeWidth={2} fill="var(--blue-600)" fillOpacity={0.08} dot={false} activeDot={{r: 4}} isAnimationActive={false}/>
            </AreaChart>
          </ResponsiveContainer>
        </div>
        {!rangeTotal && <p className="billing-hint">所选区间暂无真实点击，趋势按实际零值展示。</p>}
      </section>
      <div className="billing-chart-grid">
        <Comparison title="应用点击对比" description="Top 8 · 所选区间真实点击" data={appBars}/>
        <Comparison title="分类点击对比" description="Top 8 一级分类 · 所选区间真实点击" data={categoryBars}/>
      </div>
      <section className="admin-panel table-panel">
        <div className="toolbar click-report-toolbar"><label className="table-search"><input aria-label="搜索点击报表" type="search" value={search} placeholder="搜索应用名称或分类" onChange={e => {setSearch(e.target.value); setPage(1);}}/></label>
          <ModernSelect ariaLabel="点击报表排序" value={sort} options={periods.map((value, i) => ({value, label: `${labels[i]}排序`}))} onChange={value => {setSort(value as typeof sort); setPage(1);}}/>
        </div>
        <div className="table-meta"><span>共 {filtered.length} 个注册应用（含停用）</span><span>更新于 {new Date(report.generatedAt).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}</span></div>
        <div className="table-wrap" ref={table}><table className="data-grid" aria-label="应用点击统计"><thead><tr><th>应用名称</th><th>分类</th><th>状态</th><th>区间真实点击</th>{labels.map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{filtered.slice((current - 1) * pageSize, current * pageSize).map(item => <tr key={item.id}><td><strong>{item.name}</strong></td><td>{item.category}</td><td>{item.isEnabled ? '已启用' : '已停用'}</td><td>{number(item.rangeClicks)}</td>{periods.map(period => <td key={period}>{number(item.clicks[period])}</td>)}</tr>)}</tbody></table></div>
        {!filtered.length && <div className="empty-state">暂无匹配的注册应用</div>}
        <AntPagination ariaLabel="点击报表分页" current={current} total={filtered.length} pageSize={pageSize} onChange={setPage} onPageSizeChange={setPageSize}/>
      </section>
    </>}
  </div>;
}
