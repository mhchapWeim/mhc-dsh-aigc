'use client';
import { DeleteButton } from '../../../components/delete-button';
import { useDeleteConfirm } from '../../../components/delete-confirm';
import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Pencil, UsersRound, Building2, Trash2 } from 'lucide-react';
import { apiRequest, hasBackend } from '../../../lib/api-client';
import { ModernMultiSelect } from '../../../components/modern-multi-select';
import { Modal } from '../../../components/modal';
import { AntPagination } from '../../../components/ant-pagination';
import '../billing.css';
import { TokenAmountInput } from '../token-amount-input';

type Plan = { id: string; name: string; weeklyTokens: number; isEnabled: boolean };
type Assignment = { subjectType: string; subjectId: string; planId: string };
type Directory = {
  plans: Plan[]; assignments: Assignment[];
  users: Array<{ id: string; name: string; employeeNo: string; departmentId: string | null }>;
  departments: Array<{ id: string; name: string }>;
};
const num = (value: number | undefined) => (value ?? 0).toLocaleString('zh-CN');

export default function BillingPlansPage() {
  const { confirmDelete, deleteConfirmHolder } = useDeleteConfirm();
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [userIds, setUserIds] = useState<string[]>([]);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<Plan | null>(null);

  const load = useCallback(async () => {
    if (!hasBackend) { setError('请先配置 API，计费数据不使用本地模拟记录。'); return; }
    setBusy(true); setError('');
    try { setDirectory(await apiRequest<Directory>('/api/billing')); }
    catch (e) { setDirectory(null); setError(e instanceof Error ? e.message : '计费配方加载失败'); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await apiRequest('/api/billing/plans' + (editing.id ? '/' + editing.id : ''),
        { method: editing.id ? 'PUT' : 'POST', body: JSON.stringify({ ...editing, userIds, departmentIds }) });
      setEditing(null); setNotice('已保存。配方额度调整不会清空本周已用量。');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setBusy(false); }
  };

  const boundDepartments = directory?.assignments.filter(x => x.subjectType === 'Department').length ?? 0;
  const boundUsers = directory?.assignments.filter(x => x.subjectType === 'User').length ?? 0;

  const plans = directory?.plans ?? [];
  const currentPage = Math.min(page, Math.max(1, Math.ceil(plans.length / pageSize)));
  const visiblePlans = plans.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return <div className="admin-page page-enter billing-page">{deleteConfirmHolder}
    <div className="page-title"><div><span className="section-kicker">TOKEN BILLING</span><h1>计费配方</h1>
      <p>按周发放外部模型 token 额度。配方分配到部门或个人后，成员按周一 00:00（北京时间）重置。</p></div>
      <button className="secondary-action" disabled={busy} onClick={() => void load()}><RefreshCw size={16} />刷新</button></div>
    {error && <p role="alert" className="model-form-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {busy && <p role="status">正在处理…</p>}

    <section className="billing-stats" aria-label="配方使用概况">
      <article className="billing-stat"><span className="billing-stat__label">配方数量</span>
        <strong>{num(directory?.plans.length)}</strong><small>{directory?.plans.filter(x => x.isEnabled).length ?? 0} 个启用</small></article>
      <article className="billing-stat"><span className="billing-stat__label">已绑定部门</span>
        <strong>{num(boundDepartments)}</strong><small>成员自动继承</small></article>
      <article className="billing-stat"><span className="billing-stat__label">已绑定个人</span>
        <strong>{num(boundUsers)}</strong><small>个人登记优先于部门</small></article>
    </section>

    <section className="admin-panel table-panel">
      <div className="toolbar"><h2>配方列表</h2>
        <button className="primary-action" disabled={busy} onClick={() => { setUserIds([]); setDepartmentIds([]); setEditing({ id: '', name: '', weeklyTokens: 1000000, isEnabled: true }); }}>
          <Plus size={16} />新增配方</button></div>
      <div className="table-wrap"><table className="data-grid" aria-label="计费配方">
        <thead><tr><th>配方</th><th>每人每周 token</th><th>状态</th><th>绑定部门</th><th>绑定个人</th><th>操作</th></tr></thead>
        <tbody>{visiblePlans.map(plan => {
          const departments = directory!.assignments.filter(x => x.subjectType === 'Department' && x.planId === plan.id).length;
          const people = directory!.assignments.filter(x => x.subjectType === 'User' && x.planId === plan.id).length;
          return <tr key={plan.id}><td><strong>{plan.name}</strong></td><td>{num(plan.weeklyTokens)}</td>
            <td><span className={`state-badge ${plan.isEnabled ? 'is-enabled' : 'is-disabled'}`}>{plan.isEnabled ? '启用' : '停用'}</span></td>
            <td>{departments ? <span className="billing-bound"><Building2 size={14} />{departments} 个</span> : '—'}</td>
            <td>{people ? <span className="billing-bound"><UsersRound size={14} />{people} 人</span> : '—'}</td>
            <td><button className="secondary-action" onClick={() => { setUserIds(directory!.assignments.filter(x => x.planId === plan.id && x.subjectType === 'User').map(x => x.subjectId)); setDepartmentIds(directory!.assignments.filter(x => x.planId === plan.id && x.subjectType === 'Department').map(x => x.subjectId)); setEditing({ ...plan }); }}><Pencil size={14} />编辑</button> <DeleteButton type="button" className="secondary-action" title={departments + people > 0 ? '正在使用，请先解除个人和部门绑定' : '删除配方'} disabled={busy} blockedReason={departments + people > 0 ? `配方仍绑定 ${departments} 个部门、${people} 位用户，请先解除绑定` : undefined} aria-label={`删除配方 ${plan.name}`} onClick={() => void confirmDelete(`删除配方“${plan.name}”？历史计费记录将保留。`, async () => { setBusy(true); try { await apiRequest(`/api/billing/plans/${plan.id}`, { method: 'DELETE' }); setDirectory(current => current ? { ...current, plans: current.plans.filter(item => item.id !== plan.id) } : current); setNotice('配方已删除'); } finally { setBusy(false); } })}><Trash2 size={14} />删除</DeleteButton></td></tr>;
        })}</tbody></table></div>
      {!directory?.plans.length && !busy && <p className="empty-state">暂无计费配方。未分配配方时外部模型不可用，内部模型不受影响。</p>}
      <AntPagination ariaLabel="计费配方分页" current={currentPage} total={plans.length} pageSize={pageSize}
        onChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1); }} />
      <div className="billing-panel-foot"><p className="billing-hint">可在新增、编辑配方时授权，也可在「用户管理」和「部门管理」中选择：部门配方下发给该部门的每位成员，个人配方优先于部门配方。</p></div>
    </section>

    {editing && <Modal className="billing-plan-modal" title={editing.id ? '编辑计费配方' : '新增计费配方'} onClose={() => setEditing(null)}>
      <form className="entity-form" onSubmit={save}>
        <div className="billing-plan-body" tabIndex={0} aria-label="计费配方配置">
        {error && <p role="alert" className="model-form-error">{error}</p>}
        <label>配方名称<input required maxLength={80} value={editing.name}
          onChange={e => setEditing({ ...editing, name: e.target.value })} /></label>
        <TokenAmountInput label="每人每周 token" value={editing.weeklyTokens}
          onChange={weeklyTokens => setEditing({ ...editing, weeklyTokens })} />
        <label className="billing-plan-enabled"><input type="checkbox" checked={editing.isEnabled}
          onChange={e => setEditing({ ...editing, isEnabled: e.target.checked })} />启用配方</label>
        <fieldset className="billing-authorization" disabled={busy}>
          <legend>授权范围</legend>
          <p className="billing-hint">部门成员继承部门配方，个人配方优先。选择已绑定其他配方的对象后，保存会将其切换到当前配方。</p>
          <div><span id="billing-departments-label">授权部门</span><ModernMultiSelect ariaLabel="授权部门" itemLabel="部门" values={departmentIds}
            options={(directory?.departments ?? []).map(x => ({ value: x.id, label: x.name }))} onChange={setDepartmentIds} /></div>
          <div><span id="billing-users-label">授权个人</span><ModernMultiSelect ariaLabel="授权个人" itemLabel="个人" values={userIds}
            options={(directory?.users ?? []).map(x => ({ value: x.id, label: x.name, description: x.employeeNo }))} onChange={setUserIds} /></div>
        </fieldset>
        </div>
        <footer className="modal-actions"><button type="button" onClick={() => setEditing(null)}>取消</button>
          <button className="primary-action" disabled={busy}>保存配方</button></footer>
      </form>
    </Modal>}
  </div>;
}
