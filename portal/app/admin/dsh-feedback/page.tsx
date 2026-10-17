"use client";

import { useEffect, useState } from "react";
import { getDshFeedback, getDshFeedbackDetail, type DshFeedbackRow } from "../../lib/api-client";

import { AntPagination } from "../../components/ant-pagination";
import "./style.css";
import { Modal } from "../../components/modal";

const categories: Record<string, string> = { "task-result": "任务结果", "instruction-following": "指令理解与遵循", "product-interaction": "产品功能与交互", "service-stability": "稳定性和速度", "resource-cost": "资源使用与费用", "security-privacy-permission": "安全隐私与权限", other: "其他" };

export default function DshFeedbackPage() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [rows, setRows] = useState<DshFeedbackRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DshFeedbackRow | null>(null);
  const [detailError, setDetailError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    getDshFeedback(search, category, page).then(result => { if (active) { setRows(result.items); setTotal(result.total); setError(""); } })
      .catch(cause => { if (active) { setRows([]); setTotal(0); setError(cause instanceof Error ? cause.message : "加载失败"); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [search, category, page, refresh]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setDetail(null); setDetailError("");
    getDshFeedbackDetail(selected).then(result => { if (active) setDetail(result); })
      .catch(cause => { if (active) setDetailError(cause instanceof Error ? cause.message : "详情加载失败"); });
    return () => { active = false; };
  }, [selected]);
  return <div className="admin-page page-enter">
    <div className="page-title"><div><span className="section-kicker">DSH FEEDBACK</span><h1>用户反馈</h1><p>查看 DSH 用户提交的反馈内容及会话日志。</p></div><button className="secondary-action" disabled={loading} onClick={() => setRefresh(value => value + 1)}>刷新</button></div>
    <div className="admin-panel feedback-filters">
      <label>搜索反馈<input aria-label="搜索反馈" placeholder="搜索内容、姓名或工号" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} /></label>
      <label>反馈分类<select aria-label="反馈分类" value={category} onChange={event => { setCategory(event.target.value); setPage(1); }}><option value="">全部分类</option>{Object.entries(categories).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <button type="button" className="secondary-action" onClick={() => { setSearch(''); setCategory(''); setPage(1); }}>重置</button>
    </div>
    {error && <div className="model-form-error" role="alert">{error}</div>}
    <section className="admin-panel table-panel" aria-busy={loading}>
      <div className="table-meta"><span>共 {total} 条反馈</span><span>提交时间倒序</span></div>
      <div className="feedback-table"><table className="data-grid"><thead><tr><th>提交时间</th><th>用户</th><th>分类</th><th>反馈内容</th><th>操作</th></tr></thead><tbody>
        {rows.map(row => <tr key={row.id}><td><time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString('zh-CN')}</time></td><td>{row.userName}<br /><small>{row.employeeNo}</small></td><td><span className="feedback-category">{categories[row.category] ?? row.category}</span></td><td><div className="feedback-excerpt">{row.text || "未填写详情"}</div></td><td><button className="secondary-action" onClick={() => setSelected(row.id)}>查看详情</button></td></tr>)}
      </tbody></table></div>
      {loading && <div className="empty-state" role="status">正在加载用户反馈…</div>}
      {!loading && !rows.length && !error && <div className="empty-state"><strong>暂无匹配的用户反馈</strong></div>}
      <AntPagination ariaLabel="用户反馈分页" current={page} total={total} pageSize={20} onChange={setPage} />
    </section>
    {selected && <Modal title="反馈详情" className="feedback-dialog" onClose={() => setSelected(null)}>
      <div className="feedback-dialog-body" tabIndex={0} aria-label="反馈详情内容">
        {detailError && <div className="model-form-error" role="alert">{detailError}</div>}
        {detail ? <>
          <dl className="feedback-metadata">{[['用户', `${detail.userName}（${detail.employeeNo}）`], ['反馈分类', categories[detail.category] ?? detail.category], ['提交时间', new Date(detail.createdAt).toLocaleString('zh-CN')], ['会话', detail.sessionId]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          <h3>反馈内容</h3><div className="feedback-text">{detail.text || "未填写详情"}</div>
          <h3>会话日志</h3><pre className="feedback-log">{detail.sessionLog || "无日志"}</pre>
        </> : !detailError && <p role="status">正在加载详情…</p>}
      </div>
      <footer className="feedback-dialog-footer"><button className="secondary-action" onClick={() => setSelected(null)}>关闭</button></footer>
    </Modal>}
  </div>;
}
