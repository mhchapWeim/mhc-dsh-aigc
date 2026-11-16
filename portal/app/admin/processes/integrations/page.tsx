'use client';
import './integrations.css';
import { useCallback, useEffect, useState } from 'react';
import { Modal } from '../../../components/modal';
import { AntPagination } from '../../../components/ant-pagination';
import { getIntegrations, getInvocations, retryInvocation, saveIntegration, type IntegrationService, type Invocation } from '../../../lib/integrations';

const fresh = (): IntegrationService => ({ code: '', name: '', kind: 'Mq', isEnabled: false, connectionKey: '', operationsJson: '[{"code":"review.requested","resultEvent":"review.finished","protocol":"code-review-20261112"}]' });

export default function IntegrationManagementPage() {
  const [rows, setRows] = useState<IntegrationService[]>([]), [calls, setCalls] = useState<Invocation[]>([]);
  const [form, setForm] = useState<IntegrationService | null>(null), [editing, setEditing] = useState(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [page, setPage] = useState(1), [total, setTotal] = useState(0);
  const load = useCallback(async () => {
    setError(''); setBusy(true);
    try { const [services, invocations] = await Promise.all([getIntegrations(), getInvocations(page)]); setRows(services); setCalls(invocations.items); setTotal(invocations.total); }
    catch (e) { setRows([]); setCalls([]); setTotal(0); setError(e instanceof Error ? e.message : '加载失败'); }
    finally { setBusy(false); }
  }, [page]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!form) return; setBusy(true); setError('');
    try { await saveIntegration({ ...form, operations: JSON.parse(form.operationsJson) }); setForm(null); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setBusy(false); }
  };
  return <div className="admin-page page-enter">
    <div className="page-title"><div><h1>第三方服务</h1><p>维护代码平台与异步流程服务，连接凭据在服务端集中配置。</p></div><button type="button" className="primary-action" onClick={() => { setEditing(false); setForm(fresh()); }}>新增服务</button></div>
    <section className="admin-panel integration-fields"><p>Gitea：先登记 OAuth 应用，再配置 ClientId、ClientSecret、RedirectUri。MQ：配置独立账号、请求路由、结果队列及死信队列。</p><button type="button" className="secondary-action" disabled={busy} onClick={() => void load()}>刷新</button></section>
    {error && <p className="model-form-error" role="alert">{error}</p>}
    {busy && <p role="status">正在处理…</p>}
    <section className="admin-panel table-panel"><div className="table-meta">服务配置 · {rows.length} 项</div><div className="table-wrap"><table className="data-grid"><thead><tr><th>名称 / 标识</th><th>类型</th><th>连接引用</th><th>状态</th><th>操作</th></tr></thead><tbody>{rows.map(row => <tr key={row.code}><td>{row.name}<small>{row.code}</small></td><td>{row.kind}</td><td>{row.connectionKey}</td><td>{row.isEnabled ? '启用' : '停用'}</td><td><button type="button" className="secondary-action" onClick={() => { setEditing(true); setForm({ ...row }); }}>编辑</button></td></tr>)}</tbody></table></div>{!busy && !rows.length && <p className="empty-state">暂无服务，请新增配置。</p>}</section>
    <section className="admin-panel table-panel"><div className="table-meta">第三方调用记录 · {total} 项</div><div className="table-wrap"><table className="data-grid"><thead><tr><th>调用 / 节点</th><th>服务 / 操作</th><th>状态</th><th>发送重试</th><th>截止时间</th><th>操作</th></tr></thead><tbody>{calls.map(call => <tr key={call.id}><td>{call.nodeKey}<small>{call.id}</small></td><td>{call.serviceCode}<small>{call.operation}</small></td><td>{call.status}</td><td>{call.attempts}</td><td>{new Date(call.expiresAt).toLocaleString('zh-CN')}</td><td>{call.status === 'DeliveryFailed' && <button type="button" className="secondary-action" disabled={busy} onClick={async () => { setBusy(true); try { await retryInvocation(call.id); await load(); } catch (e) { setError(e instanceof Error ? e.message : '重试失败'); } finally { setBusy(false); } }}>重试投递</button>}</td></tr>)}</tbody></table></div><AntPagination ariaLabel="第三方调用分页" current={page} pageSize={20} total={total} onChange={setPage} /></section>
    {form && <Modal title={editing ? '编辑第三方服务' : '新增第三方服务'} onClose={() => { if (!busy) setForm(null); }}><form className="entity-form integration-fields" onSubmit={save}>
      <label><span>服务标识</span><input required disabled={editing} pattern="[a-z][a-z0-9-]{1,79}" value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} /></label>
      <label><span>服务名称</span><input required maxLength={150} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
      <label><span>服务类型</span><select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value as IntegrationService['kind'] })}><option value="Mq">MQ 异步服务</option><option value="Gitea">Gitea 代码平台</option></select></label>
      <label><span>服务端连接配置引用</span><input required placeholder="GiteaBosch / CodeAudit" value={form.connectionKey} onChange={e => setForm({ ...form, connectionKey: e.target.value })} /></label>
      {form.kind === 'Mq' && <label><span>操作与结果事件（JSON 数组）</span><textarea required rows={5} value={form.operationsJson} onChange={e => setForm({ ...form, operationsJson: e.target.value })} /></label>}
      <label><span><input type="checkbox" checked={form.isEnabled} onChange={e => setForm({ ...form, isEnabled: e.target.checked })} /> 启用服务</span></label>
      {error && <p role="alert" className="model-form-error">{error}</p>}
      <footer className="modal-actions"><button type="button" className="secondary-action" disabled={busy} onClick={() => setForm(null)}>取消</button><button type="submit" className="primary-action" disabled={busy}>保存</button></footer>
    </form></Modal>}
  </div>;
}
