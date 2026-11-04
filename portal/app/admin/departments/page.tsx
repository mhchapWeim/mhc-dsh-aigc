'use client';

import { DeleteButton } from '../../components/delete-button';
import { useDeleteConfirm } from '../../components/delete-confirm';
import { SearchableSelect } from '../../components/modern-select';

import { useEffect, useMemo, useState } from 'react';
import { Building2, Edit3, Filter, Plus, Power, Search, UsersRound, Trash2 } from 'lucide-react';
import { usePageSize } from '../../components/use-page-size';
import { AntPagination } from '../../components/ant-pagination';
import { Modal } from '../../components/modal';
import { ModernSelect } from '../../components/modern-select';
import { usePlatform } from '../../components/platform-provider';
import { getBillingPlanOptions, hasBackend, type BillingPlanOption } from '../../lib/api-client';
import type { PlatformDepartment } from '../../lib/platform-state';

const emptyDepartment = (): PlatformDepartment => ({ id: `dept-${Date.now()}`, name: '', manager: '', description: '', enabled: true });

export default function DepartmentManagementPage() {
  const { confirmDelete, deleteConfirmHolder } = useDeleteConfirm();
  const [pageSize, setPageSize] = usePageSize();
  const { departments, users, dispatch, notice } = usePlatform();
  const [editing, setEditing] = useState<PlatformDepartment | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('全部状态');
  const [page, setPage] = useState(1);
  const [plans, setPlans] = useState<BillingPlanOption[]>([]);
  useEffect(() => {
    if (!hasBackend) return;
    getBillingPlanOptions().then(setPlans).catch(() => setPlans([]));
  }, []);
  const filtered = useMemo(() => departments.filter((department) => (!query.trim() || `${department.name}${department.manager}${department.description}`.toLowerCase().includes(query.trim().toLowerCase())) && (status === '全部状态' || (status === '启用') === department.enabled)), [departments, query, status]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const save = async (event: React.FormEvent) => { event.preventDefault(); if (editing?.name.trim()) { try { await dispatch({ type: 'save-department', department: editing }); setEditing(null); } catch { /* 保持弹窗以便修正 */ } } };

  return <div className="admin-page page-enter">{deleteConfirmHolder}
    <div className="page-title"><div><span className="section-kicker">ORGANIZATION</span><h1>部门管理</h1><p>维护组织部门、负责人和启停状态。</p></div><button className="primary-action" type="button" onClick={() => setEditing(emptyDepartment())}><Plus size={18} />新增部门</button></div>
    <section className="admin-panel table-panel department-table-panel">
      <div className="toolbar"><label className="table-search"><Search size={18} /><input type="search" aria-label="搜索部门" placeholder="搜索部门、负责人或说明" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /></label><div className="toolbar-filters"><Filter size={16} /><ModernSelect compact ariaLabel="部门状态筛选" value={status} options={['全部状态', '启用', '停用'].map((value) => ({ value, label: value }))} onChange={(value) => { setStatus(value); setPage(1); }} /></div></div>
      <div className="table-meta"><span>共 {filtered.length} 个部门</span><span><UsersRound size={14} />成员数量根据用户所属部门自动统计</span></div>
      <div className="table-wrap"><table aria-label="部门数据表格"><thead><tr><th>部门名称</th><th>负责人</th><th>成员数量</th><th>状态</th><th>部门说明</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{visible.map((department) => { const memberCount = users.filter((user) => user.department === department.name).length; return <tr key={department.id}><td><div className="department-name-cell"><span><Building2 size={17} /></span><strong>{department.name}</strong></div></td><td>{department.manager || '未设置'}</td><td><span className="role-user-count"><UsersRound size={15} />{memberCount} 人</span></td><td><span className={`state-badge ${department.enabled ? 'is-enabled' : 'is-disabled'}`}>{department.enabled ? '启用' : '停用'}</span></td><td><span className="role-table-description" title={department.description}>{department.description || '暂无部门说明'}</span></td><td><div className="row-actions"><button type="button" aria-label={`编辑${department.name}`} onClick={() => setEditing(department)}><Edit3 size={16} /></button><button type="button" aria-label={`${department.enabled ? '停用' : '启用'}${department.name}`} onClick={() => dispatch({ type: 'toggle-department-status', id: department.id })}><Power size={16} /></button><DeleteButton type="button" className="danger-icon" aria-label={`删除${department.name}`} title={memberCount ? '部门仍有用户，请先转移用户' : '删除部门'} blockedReason={memberCount > 0 ? `部门仍有 ${memberCount} 位用户，请先转移用户后再删除` : undefined} onClick={() => void confirmDelete(`删除部门“${department.name}”？部门将不再显示，历史记录保留。`, () => dispatch({ type: 'delete-department', id: department.id }))}><Trash2 size={16} /></DeleteButton></div></td></tr>; })}</tbody></table></div>
      {!visible.length && <div className="table-empty"><Building2 size={28} /><strong>没有匹配的部门</strong><span>请调整搜索词或状态筛选。</span></div>}
      <AntPagination onPageSizeChange={setPageSize} ariaLabel="部门分页" current={currentPage} pageSize={pageSize} total={filtered.length} onChange={setPage} />
    </section>
    {notice && <div className="inline-toast" role="status">{notice}</div>}
    {editing && <Modal title={departments.some((department) => department.id === editing.id) ? '编辑部门' : '新增部门'} onClose={() => setEditing(null)}><form className="entity-form" onSubmit={save}><div className="form-grid"><label><span>部门名称 *</span><input aria-label="部门名称" required value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label><label><span>负责人</span><input aria-label="负责人" value={editing.manager} onChange={(event) => setEditing({ ...editing, manager: event.target.value })} /></label><label className="form-span"><span>部门说明</span><textarea aria-label="部门说明" rows={3} value={editing.description} onChange={(event) => setEditing({ ...editing, description: event.target.value })} /></label><label className="form-span"><span>计费配方</span>
        <SearchableSelect aria-label="部门计费配方" value={editing.billingPlanId ?? ''} onChange={(event) => setEditing({ ...editing, billingPlanId: event.target.value || null })}>
          <option value="">不分配配方</option>
          {plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name} · {plan.weeklyTokens.toLocaleString('zh-CN')} token/周{plan.isEnabled ? '' : '（已停用）'}</option>)}
        </SearchableSelect><small>部门成员各自获得一份该配方额度；个人在「用户管理」中单独选择的配方优先于这里。</small></label></div><footer className="modal-actions"><button type="button" onClick={() => setEditing(null)}>取消</button><button className="primary-action" type="submit">保存部门</button></footer></form></Modal>}
  </div>;
}
