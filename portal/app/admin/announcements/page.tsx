'use client';

import { useEffect, useState } from 'react';
import { Bell, Plus, RefreshCw, Eye, Pencil, Send, Undo2 } from 'lucide-react';
import { usePageSize } from '../../components/use-page-size';
import { AntPagination } from '../../components/ant-pagination';
import { AnnouncementReceipts } from './announcement-receipts';
import { Modal } from '../../components/modal';
import { RecipientPicker, emptyAudience, emptyAudienceOptions } from '../components/recipient-picker';
import { getDesktopAnnouncements, getDesktopAudienceOptions, saveDesktopAnnouncement, setDesktopAnnouncementStatus,
  type DesktopAnnouncement, type DesktopAudienceOptions, type GrantSelection } from '../../lib/api-client';

const localDate = (date: string) => { const value = new Date(date); return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const formatDate = (date: string | null) => date ? new Date(date).toLocaleString('zh-CN') : '—';
const statusNames: Record<string, string> = { Draft: '草稿', Published: '已发布', Withdrawn: '已撤回' };
type Form = { id: string; title: string; body: string; important: boolean; startsAt: string; endsAt: string; } & GrantSelection;
const empty = (): Form => ({ id: '', title: '', body: '', important: false, startsAt: localDate(new Date().toISOString()), endsAt: '', ...emptyAudience() });

export default function AnnouncementPage() {
  const [items, setItems] = useState<DesktopAnnouncement[]>([]);
  const [options, setOptions] = useState<DesktopAudienceOptions>(emptyAudienceOptions);
  const [form, setForm] = useState<Form | null>(null);
  const [detail, setDetail] = useState<DesktopAnnouncement | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize();
  const filtered = items.filter(item => item.title.includes(query));
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)));
  const refresh = async () => { const [data, people] = await Promise.all([getDesktopAnnouncements(), getDesktopAudienceOptions('announcements')]); setItems(data); setOptions(people); };
  useEffect(() => { let active = true; Promise.all([getDesktopAnnouncements(), getDesktopAudienceOptions('announcements')]).then(([data, people]) => { if (active) { setItems(data); setOptions(people); } }).catch(error => { if (active) setNotice(error.message); }); return () => { active = false; }; }, []);
  const run = async (operation: () => Promise<void>) => { setBusy(true); setNotice(''); try { await operation(); await refresh(); } catch (error) { setNotice(error instanceof Error ? error.message : '操作失败'); } finally { setBusy(false); } };
  const save = (event: React.FormEvent) => { event.preventDefault(); if (!form) return; void run(async () => {
    if (form.userIds.length + form.roleIds.length + form.departmentIds.length === 0) throw new Error('请至少选择一位接收人员');
    await saveDesktopAnnouncement(form.id || null, { ...form, startsAt: new Date(form.startsAt).toISOString(), endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null });
    setForm(null); setNotice('公告草稿已保存，可在列表中发布');
  }); };
  return <div className="admin-page page-enter">
    <div className="page-title"><div><span className="section-kicker">CLIENT ANNOUNCEMENTS</span><h1>公告管理</h1><p>向指定人员的 DSH 客户端发布公告，跟踪送达、阅读与确认。</p></div><button className="primary-action" onClick={() => { setNotice(''); setForm(empty()); }}><Plus size={18} />新增公告</button></div>
    {notice && <div className="inline-notice" role="status">{notice}</div>}
    <section className="admin-panel table-panel">
      <div className="toolbar"><input aria-label="搜索公告" placeholder="搜索公告标题" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} /><button className="secondary-action" disabled={busy} onClick={() => void run(async () => {})}><RefreshCw size={16} />刷新</button></div>
      <div className="data-grid-wrap"><table className="data-grid announcement-table" aria-label="公告列表"><thead><tr><th>公告</th><th>状态</th><th>生效时间</th><th>接收 / 已读 / 确认</th><th>操作</th></tr></thead><tbody>{filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize).map(item => <tr key={item.id}>
        <td><strong>{item.important && <Bell size={14} />} {item.title}</strong></td><td>{statusNames[item.status]}{item.status === 'Published' && item.endsAt && new Date(item.endsAt) < new Date() ? ' · 已到期' : ''}</td><td>{formatDate(item.startsAt)}</td>
        <td>{item.recipients.length} / {item.recipients.filter(person => person.readAt).length} / {item.recipients.filter(person => person.confirmedAt).length}</td>
        <td><div className="row-actions"><button type="button" aria-label="详情与回执" title="详情与回执" onClick={() => setDetail(item)}><Eye size={16} /></button>{item.status === 'Draft' && <><button type="button" aria-label="编辑公告" title="编辑公告" disabled={busy} onClick={() => setForm({ ...item, startsAt: localDate(item.startsAt), endsAt: item.endsAt ? localDate(item.endsAt) : '', ...(item.audience ?? { ...emptyAudience(), userIds: item.recipients.map(person => person.userId) }) })}><Pencil size={16} /></button><button type="button" aria-label="发布公告" title="发布公告" disabled={busy} onClick={() => void run(() => setDesktopAnnouncementStatus(item.id, 'Published'))}><Send size={16} /></button></>}{item.status === 'Published' && <button type="button" className="danger-icon" aria-label="撤回公告" title="撤回公告" disabled={busy} onClick={() => void run(() => setDesktopAnnouncementStatus(item.id, 'Withdrawn'))}><Undo2 size={16} /></button>}</div></td>
      </tr>)}</tbody></table></div>{items.length === 0 && <div className="empty-state">暂无公告。新增草稿并选择接收人员后发布。</div>}
      <AntPagination onPageSizeChange={setPageSize} ariaLabel="公告列表分页" current={currentPage} total={filtered.length} pageSize={pageSize} onChange={setPage} />
    </section>
    {form && <Modal title={form.id ? '编辑公告草稿' : '新增公告'} onClose={() => { if (!busy) setForm(null); }}><form className="entity-form distribution-form" onSubmit={save}>
      <label>标题<input required maxLength={200} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></label>
      <label>正文<textarea required rows={6} maxLength={20000} value={form.body} onChange={event => setForm({ ...form, body: event.target.value })} /></label>
      <label className="distribution-important"><input type="checkbox" checked={form.important} onChange={event => setForm({ ...form, important: event.target.checked })} />重要公告（客户端弹窗提示）</label>
      <div className="form-grid"><label>生效时间<input required type="datetime-local" value={form.startsAt} onChange={event => setForm({ ...form, startsAt: event.target.value })} /></label>
      <label>到期时间（可选）<input type="datetime-local" value={form.endsAt} onChange={event => setForm({ ...form, endsAt: event.target.value })} /></label></div>
      <RecipientPicker options={options} value={form} onChange={audience => setForm({ ...form, ...audience })} />
      {notice && <p role="alert" className="form-error">{notice}</p>}<div className="modal-actions"><button type="button" className="secondary-action" disabled={busy} onClick={() => setForm(null)}>取消</button><button className="primary-action" disabled={busy}>{busy ? '保存中…' : '保存草稿'}</button></div>
    </form></Modal>}
    {detail && <Modal title={detail.title} onClose={() => setDetail(null)}><AnnouncementReceipts key={detail.id} announcement={detail} onClose={() => setDetail(null)} /></Modal>}
  </div>;
}
