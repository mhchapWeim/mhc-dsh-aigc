'use client';

import { useEffect, useState } from 'react';
import { usePageSize } from '../../components/use-page-size';
import { AntPagination } from '../../components/ant-pagination';
import { getOperationAudits, type OperationAuditRow } from '../../lib/api-client';

export default function AuditsPage() {
  const [pageSize, setPageSize] = usePageSize();
  const [rows, setRows] = useState<OperationAuditRow[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getOperationAudits(page, pageSize).then((result) => {
      if (!active) return;
      if (!Array.isArray(result.items)) throw new Error('审计接口格式不匹配，请更新 AIGC API 服务。');
      setRows(result.items);
      setTotal(result.total);
      setError('');
      setLoading(false);
    }).catch((cause) => {
      if (!active) return;
      setRows([]);
      setTotal(0);
      setError(cause instanceof Error ? cause.message : '审计记录加载失败');
      setLoading(false);
    });
    return () => { active = false; };
  }, [page, pageSize]);

  return <div className="admin-page page-enter">
    <div className="page-title"><div><span className="section-kicker">AUDIT TRAIL</span><h1>操作审计</h1><p>记录 AIGC 管理操作与工具执行结果。密钥和完整工具输出不会写入审计详情。</p></div></div>
    {error && <div className="model-form-error" role="alert">{error}</div>}
    <section className="admin-panel table-panel audit-table-panel" aria-busy={loading}>
      <div className="table-meta"><span>共 {total} 条审计记录</span><span>最近操作优先</span></div>
      <div className="audit-table-wrap"><table className="data-grid audit-table"><thead><tr><th scope="col">时间</th><th scope="col">操作者</th><th scope="col">操作</th><th scope="col">对象</th><th scope="col">结果</th><th scope="col">详情</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}>
        <td><time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString('zh-CN')}</time></td>
        <td><strong className="audit-actor">{row.actorName}</strong></td><td>{row.actionLabel}</td>
        <td>{row.entityLabel}</td>
        <td><span className={`status-pill ${row.succeeded ? 'is-enabled' : 'is-disabled'}`}><i />{row.succeeded ? '成功' : '失败'}</span></td>
        <td><span className="audit-detail" title={row.detailLabel}>{row.detailLabel}</span></td>
      </tr>)}</tbody></table>
        {loading && <div className="empty-state" role="status">正在加载审计记录…</div>}
        {!loading && rows.length === 0 && !error && <div className="empty-state"><strong>暂无审计记录</strong></div>}
      </div>
      <AntPagination onPageSizeChange={setPageSize} ariaLabel="审计记录分页" current={page} total={total} pageSize={pageSize} onChange={(next) => { setLoading(true); setPage(next); }} />
    </section>
  </div>;
}
