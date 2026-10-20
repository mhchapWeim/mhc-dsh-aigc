'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileClock, RefreshCw, Search } from 'lucide-react';
import { usePageSize } from '../../components/use-page-size';
import { AntPagination } from '../../components/ant-pagination';
import { Modal } from '../../components/modal';
import { BackendDshUpload, BackendDshUploadBatch, downloadDshUpload, getDshUploadBatches } from '../../lib/api-client';

const labels: Record<BackendDshUpload['status'], string> = {
  Pending: '等待上传', Uploading: '上传中', Finalizing: '等待校验', Completed: '已完成',
};
const formatBytes = (bytes: number) => bytes >= 1024 * 1024
  ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
const progressPercent = (item: BackendDshUpload) => item.bytes > 0
  ? Math.min(100, Math.max(0, Math.round(item.offset / item.bytes * 100)))
  : item.completed ? 100 : 0;

export default function DshUploadsPage() {
  const [pageSize, setPageSize] = usePageSize();
  const [items, setItems] = useState<BackendDshUploadBatch[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<{ title: string; value: string } | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => { setSearchTerm(query); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    try {
      const result = await getDshUploadBatches(page, pageSize, searchTerm, status);
      if (currentRequest !== requestId.current) return;
      setItems(result.items);
      setTotal(result.total);
      setError('');
      if (page > 1 && result.total > 0 && (page - 1) * pageSize >= result.total)
        setPage(Math.max(1, Math.ceil(result.total / pageSize)));
    } catch (cause) {
      if (currentRequest === requestId.current)
        setError(cause instanceof Error ? cause.message : '上传任务加载失败');
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [page, searchTerm, status, pageSize]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => { window.clearInterval(timer); requestId.current++; };
  }, [refresh]);

  const download = async (item: BackendDshUpload) => {
    setBusyId(item.id);
    try { await downloadDshUpload(item); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '下载失败，请重试'); }
    finally { setBusyId(null); }
  };

  return <div className="admin-page page-enter">
    <div className="page-title"><div><span className="section-kicker">DSH FILE TRANSFERS</span><h1>附件审查</h1><p>查看 DSH 静默同步的文件、传输进度，并下载已完成的原始文件。</p></div><button className="secondary-action" type="button" onClick={() => void refresh()}><RefreshCw size={17} />刷新</button></div>
    {error && <div className="model-form-error" role="alert">{error} <button type="button" onClick={() => void refresh()}>重试</button></div>}
    <section className="admin-panel table-panel dsh-upload-panel">
      <div className="toolbar"><label className="table-search"><Search size={18} /><input type="search" maxLength={200} aria-label="搜索上传任务" placeholder="搜索文件、用户或计算机" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="toolbar-filters"><select aria-label="上传状态筛选" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">全部状态</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></div>
      <div className="table-meta"><span>共 {total} 个批次{(searchTerm || status) && ' · 匹配批次展示全部文件'}</span><span>每 10 秒自动刷新</span></div>
      <div className="dsh-upload-table-wrap">
        <table className="data-grid dsh-upload-table">
          <colgroup><col className="dsh-col-batch" /><col className="dsh-col-file" /><col className="dsh-col-user" /><col className="dsh-col-computer" /><col className="dsh-col-prompt" /><col className="dsh-col-path" /><col className="dsh-col-progress" /><col className="dsh-col-status" /><col className="dsh-col-time" /><col className="dsh-col-action" /></colgroup>
          <thead><tr><th>批次</th><th>文件</th><th>用户</th><th>计算机</th><th>User Prompt</th><th>源路径</th><th>进度</th><th>状态</th><th>创建时间</th><th className="dsh-upload-action-cell">操作</th></tr></thead>
          {items.map((batch) => {
            return <tbody key={`${batch.userId}:${batch.sessionId}:${batch.eventSeq}`} className="dsh-upload-batch">
              {batch.files.map((item, index) => {
                const percent = progressPercent(item);
                return <tr key={item.id}>
              {index === 0 && <th scope="rowgroup" rowSpan={batch.files.length} className="dsh-upload-batch-cell">
                <span className="dsh-upload-batch-id" title={`会话 ${batch.sessionId}，事件 ${batch.eventSeq}`}>#{batch.sessionId.slice(0, 10)}-{batch.eventSeq}</span>
              </th>}
              <td><strong className="dsh-upload-ellipsis" title={item.fileName}>{item.fileName}</strong></td>
              <td><strong className="dsh-upload-ellipsis" title={item.userName}>{item.userName}</strong><small className="dsh-upload-ellipsis" title={item.employeeNo}>{item.employeeNo}</small></td>
              <td><span className="dsh-upload-ellipsis" title={item.computerName}>{item.computerName}</span></td>
              <td><button className="dsh-upload-text-button" type="button" onClick={() => setDetail({ title: 'User Prompt', value: item.prompt || '—' })} aria-label={`查看${item.fileName}的 User Prompt`}>{item.prompt || '—'}</button></td>
              <td><button className="dsh-upload-text-button" type="button" onClick={() => setDetail({ title: '源路径', value: item.storedPath })} aria-label={`查看${item.fileName}的完整源路径`}>{item.storedPath}</button></td>
              <td><div className="dsh-upload-progress-label"><span>{percent}%</span><small title={`${formatBytes(item.offset)} / ${formatBytes(item.bytes)}`}>{formatBytes(item.offset)} / {formatBytes(item.bytes)}</small></div><progress className={`dsh-upload-progress-bar${item.completed ? ' is-complete' : ''}`} value={percent} max={100} aria-label={`${item.fileName}上传进度`} /></td>
              <td><span className={`status-pill ${item.completed ? 'is-enabled' : 'is-disabled'}`}><i />{labels[item.status]}</span></td>
              <td >{new Date(item.createdAt).toLocaleString('zh-CN')}</td>
              <td className="dsh-upload-action-cell"><button className="secondary-action" type="button" disabled={!item.completed || busyId === item.id} onClick={() => void download(item)} aria-label={`下载${item.fileName}`}><Download size={16} />{busyId === item.id ? '下载中' : '下载'}</button></td>
                </tr>;
              })}
            </tbody>;
          })}
        </table>
        {!loading && !items.length && <div className="empty-state"><FileClock size={28} /><strong>暂无上传批次</strong><span>DSH 产生文件同步任务后会显示在这里。</span></div>}
        {loading && <div className="empty-state" role="status">正在加载上传任务…</div>}
      </div>
      <AntPagination onPageSizeChange={setPageSize} ariaLabel="DSH 上传任务分页" current={page} pageSize={pageSize} total={total} onChange={setPage} />
    </section>
    {detail && <Modal title={detail.title} onClose={() => setDetail(null)}><div className="dsh-upload-detail">{detail.value}</div></Modal>}
  </div>;
}
