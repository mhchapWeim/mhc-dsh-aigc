'use client';

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Edit3, Plus, Search, ShieldAlert, Trash2 } from 'lucide-react';
import { usePageSize } from '../../components/use-page-size';
import { AntPagination } from '../../components/ant-pagination';
import { Modal } from '../../components/modal';
import {
  type BackendSensitiveWord,
  deleteSensitiveWord,
  getSensitiveWords,
  hasBackend,
  saveSensitiveWord,
} from '../../lib/api-client';

type WordForm = { id: string; term: string; isEnabled: boolean };
const emptyForm = (): WordForm => ({ id: '', term: '', isEnabled: true });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

export default function SensitiveWordManagementPage() {
  const [pageSize, setPageSize] = usePageSize();
  const [items, setItems] = useState<BackendSensitiveWord[]>([]);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<WordForm | null>(null);
  const [loading, setLoading] = useState(hasBackend);
  const [busyId, setBusyId] = useState('');
  const [notice, setNotice] = useState('');
  const [formError, setFormError] = useState('');

  const refresh = async () => {
    if (!hasBackend) return;
    setItems(await getSensitiveWords());
  };

  useEffect(() => {
    if (!hasBackend) return;
    getSensitiveWords().then(setItems).catch((error) => {
      setNotice(error instanceof Error ? error.message : '敏感词加载失败');
    }).finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => items.filter((item) =>
    !query.trim() || item.term.toLowerCase().includes(query.trim().toLowerCase())), [items, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    setFormError('');
    setBusyId(editing.id || 'new');
    try {
      await saveSensitiveWord(editing.id || null, { term: editing.term, isEnabled: editing.isEnabled });
      setEditing(null);
      setNotice(editing.id ? '敏感词已更新' : '敏感词已添加');
      await refresh();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '保存失败');
    } finally { setBusyId(''); }
  };

  const toggle = async (item: BackendSensitiveWord) => {
    setBusyId(item.id);
    try {
      await saveSensitiveWord(item.id, { term: item.term, isEnabled: !item.isEnabled });
      setNotice(item.isEnabled ? '敏感词已停用' : '敏感词已启用');
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '状态更新失败');
    } finally { setBusyId(''); }
  };

  const remove = async (item: BackendSensitiveWord) => {
    if (!window.confirm(`确定删除敏感词“${item.term}”吗？`)) return;
    setBusyId(item.id);
    try {
      await deleteSensitiveWord(item.id);
      setNotice('敏感词已删除');
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '删除失败');
    } finally { setBusyId(''); }
  };

  return <div className="admin-page page-enter">
    <div className="page-title">
      <div><span className="section-kicker">CONTENT POLICY</span><h1>敏感词管理</h1><p>配置 DSH 输入阶段的拦截规则。启用后的规则会自动同步到已登录客户端。</p></div>
      <button className="primary-action" type="button" onClick={() => { setFormError(''); setEditing(emptyForm()); }}><Plus size={18} />新增敏感词</button>
    </div>
    {notice && <div className="inline-notice" role="status"><CheckCircle2 size={16} />{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>×</button></div>}
    <section className="admin-panel table-panel sensitive-word-panel">
      <div className="toolbar">
        <label className="table-search"><Search size={18} /><input type="search" aria-label="搜索敏感词" placeholder="搜索敏感词" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /></label>
      </div>
      <div className="table-meta"><span>共 {filtered.length} 条规则</span><span>匹配时忽略英文大小写与全角差异</span></div>
      <div className="data-grid-wrap">
        <table className="data-grid sensitive-word-table" aria-label="敏感词数据表格">
          <thead><tr><th>敏感词</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead>
          <tbody>{visible.map((item) => <tr key={item.id}>
            <td><strong className="sensitive-term">{item.term}</strong></td>
            <td><button className={`status-pill status-toggle ${item.isEnabled ? 'is-enabled' : 'is-disabled'}`} type="button" role="switch" aria-checked={item.isEnabled} aria-label={`${item.isEnabled ? '停用' : '启用'}${item.term}`} disabled={busyId === item.id} onClick={() => void toggle(item)}><i />{item.isEnabled ? '已启用' : '已停用'}</button></td>
            <td><span className="table-subtext sensitive-word-date">{dateFormat.format(new Date(item.updatedAt))}</span></td>
            <td><div className="table-actions"><button className="icon-button" type="button" aria-label={`编辑${item.term}`} disabled={busyId === item.id} onClick={() => { setFormError(''); setEditing({ id: item.id, term: item.term, isEnabled: item.isEnabled }); }}><Edit3 size={16} /></button><button className="icon-button danger" type="button" aria-label={`删除${item.term}`} disabled={busyId === item.id} onClick={() => void remove(item)}><Trash2 size={16} /></button></div></td>
          </tr>)}</tbody>
        </table>
        {!loading && visible.length === 0 && <div className="empty-state"><ShieldAlert size={28} /><strong>{query ? '没有匹配的敏感词' : '尚未配置敏感词'}</strong><span>{query ? '请调整搜索条件。' : '新增规则后，DSH 会在发送模型请求前拦截命中内容。'}</span></div>}
        {loading && <div className="empty-state" role="status"><ShieldAlert size={28} /><strong>正在加载规则</strong></div>}
      </div>
      <AntPagination onPageSizeChange={setPageSize} ariaLabel="敏感词分页" current={currentPage} total={filtered.length} pageSize={pageSize} onChange={setPage} />
    </section>
    {editing && <Modal title={editing.id ? '编辑敏感词' : '新增敏感词'} onClose={() => setEditing(null)}>
      <form className="entity-form sensitive-word-form" onSubmit={save}>
        <p>命中规则后，用户输入不会写入会话，也不会发送到模型服务。</p>
        {formError && <div className="model-form-error" role="alert">{formError}</div>}
        <label>敏感词 *<input required autoFocus maxLength={200} value={editing.term} onChange={(event) => setEditing({ ...editing, term: event.target.value })} placeholder="输入需要拦截的词语" /><small>支持中文、英文和数字；多个词可用逗号、顿号或分号分隔，总计最多 200 个字符。</small></label>
        <button type="button" className={`notification-setting ${editing.isEnabled ? 'is-on' : ''}`} role="switch" aria-checked={editing.isEnabled} onClick={() => setEditing({ ...editing, isEnabled: !editing.isEnabled })}><span><ShieldAlert size={15} />保存后立即启用</span><i /></button>
        <div className="modal-actions"><button className="secondary-action" type="button" onClick={() => setEditing(null)}>取消</button><button className="primary-action" type="submit" disabled={busyId !== ''}>{busyId ? '保存中…' : '保存规则'}</button></div>
      </form>
    </Modal>}
  </div>;
}
