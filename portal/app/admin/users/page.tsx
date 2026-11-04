'use client';

import { DeleteButton } from '../../components/delete-button';
import Link from 'next/link';
import { useDeleteConfirm } from '../../components/delete-confirm';
import { SearchableSelect } from '../../components/modern-select';

import { useEffect, useMemo, useRef, useState } from 'react';
import './user-sync.css';
import { syncStatusNames } from '../../lib/user-sync-api';
import { Edit3, Filter, Plus, Search, Shield, KeyRound, Ticket, UserCheck, UserX, Trash2 } from 'lucide-react';
import { usePageSize } from '../../components/use-page-size';
import { AntPagination } from '../../components/ant-pagination';
import { ModernMultiSelect } from '../../components/modern-multi-select';
import { PasswordChangeForm } from '../../components/password-change-form';
import { Modal } from '../../components/modal';
import { ModernSelect, type SelectOption } from '../../components/modern-select';
import { usePlatform } from '../../components/platform-provider';
import { getBillingPlanOptions, getUserTokenQuotas, type UserTokenQuota, getUserAccessOptions, hasBackend, type BillingPlanOption, type UserAccessOptions } from '../../lib/api-client';
import type { PlatformUser, UserRole } from '../../lib/platform-state';

const toOptions = (items: Array<string | { name: string; enabled?: boolean }>): SelectOption[] => items.filter((item) => typeof item === 'string' || item.enabled !== false).map((item) => { const label = typeof item === 'string' ? item : item.name; return { value: label, label }; });
const emptyUser = (): PlatformUser => ({ id: `u-${Date.now()}`, name: '', employeeNo: '', email: '', department: '', role: '普通用户', status: '启用', lastLogin: '尚未登录' });

export default function UserManagementPage() {
  const { confirmDelete, deleteConfirmHolder } = useDeleteConfirm();
  const [pageSize, setPageSize] = usePageSize();
  const { users, departments, roles, dispatch, notice, currentUserId } = usePlatform();
  const [canManageBilling, setCanManageBilling] = useState(false);
  useEffect(() => {
    try { setCanManageBilling(JSON.parse(localStorage.getItem('aigc_hub_user') ?? 'null')?.permissions?.includes('model.manage') === true); }
    catch { setCanManageBilling(false); }
  }, []);
  const [query, setQuery] = useState('');
  const [department, setDepartment] = useState('全部部门');
  const [status, setStatus] = useState('全部状态');
  const [page, setPage] = useState(1);
  const [passwordUser, setPasswordUser] = useState<PlatformUser | null>(null);
  const [editing, setEditing] = useState<PlatformUser | null>(null);
  const [access, setAccess] = useState<UserAccessOptions | null>(null);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState('');
  const [saving, setSaving] = useState(false);
  const [plans, setPlans] = useState<BillingPlanOption[]>([]);
  const accessRequest = useRef(0);
  const open = async (user: PlatformUser) => {
    const request = ++accessRequest.current;
    setEditing({ ...user }); setAccess(null); setAccessError('');
    if (!hasBackend) { setAccess({ models: [], virtualKeys: [] }); return; }
    setAccessLoading(true);
    try {
      const [options, planOptions] = await Promise.all([
        getUserAccessOptions(users.some(item => item.id === user.id) ? user.id : undefined),
        getBillingPlanOptions().catch(() => [] as BillingPlanOption[]),
      ]);
      if (request !== accessRequest.current) return;
      setPlans(planOptions);
      setAccess(options);
      setEditing(current => current?.id === user.id ? { ...current, roleIds: current.roleIds ?? (options.roles ?? roles).filter(item => item.name === current.role).map(item => item.id), pluginIds: options.plugins?.filter(item => item.selected).map(item => item.id), releaseIds: options.releases?.filter(item => item.selected).map(item => item.id), mcpIds: options.mcps?.filter(item => item.selected).map(item => item.id), virtualKeyIds: options.virtualKeys.filter(item => item.selected).map(item => item.id) } : current);
    } catch (error) { if (request === accessRequest.current) setAccessError(error instanceof Error ? error.message : '授权选项加载失败'); }
    finally { if (request === accessRequest.current) setAccessLoading(false); }
  };
  const effectiveOption = (item: UserAccessOptions['models'][number]) => ({ ...item,
    inherited: item.departmentIds === undefined && item.roleIds === undefined ? item.inherited
      : Boolean(item.organizationInherited || item.departmentIds?.includes(editing?.departmentId ?? '') || item.roleIds?.some(id => editing?.roleIds?.includes(id))) });
  const viewAccess = access && { ...access, plugins: access.plugins?.map(effectiveOption), mcps: access.mcps?.map(effectiveOption), models: access.models.map(effectiveOption), virtualKeys: access.virtualKeys.map(effectiveOption) };
  // A personal binding wins; otherwise the member inherits whatever the department carries.
  const departmentPlanId = departments.find(item => item.name === editing?.department)?.billingPlanId ?? null;
  const departmentPlan = plans.find(plan => plan.id === departmentPlanId);
  const inheritedPlanName = editing?.billingPlanId
    ? `个人配方优先于部门：${plans.find(plan => plan.id === editing.billingPlanId)?.name ?? '已删除配方'}`
    : departmentPlan
      ? `继承部门配方：${departmentPlan.name} · ${departmentPlan.weeklyTokens.toLocaleString('zh-CN')} token/周`
      : '所在部门未配置配方；外部模型将不可用，内部模型不受影响';
  const availableDepartments = access?.departments ?? departments;
  const availableRoles = access?.roles ?? roles;
  const departmentFilters = useMemo(() => [{ value: '全部部门', label: '全部部门' }, { value: '', label: '未分配部门' }, ...toOptions([...new Set(users.map(user => user.department).filter(Boolean))])], [users]);
  const filtered = useMemo(() => users.filter((user) => (!query || `${user.name}${user.employeeNo}${user.email}`.toLowerCase().includes(query.toLowerCase())) && (department === '全部部门' || user.department === department) && (status === '全部状态' || user.status === status)), [department, query, status, users]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const [quotas, setQuotas] = useState<Record<string, UserTokenQuota>>({});
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaError, setQuotaError] = useState('');
  const [quotaRefresh, setQuotaRefresh] = useState(0);
  const visibleUserIds = JSON.stringify(visible.map(user => user.id));
  useEffect(() => {
    let active = true;
    setQuotas({}); setQuotaError('');
    const ids = JSON.parse(visibleUserIds) as string[];
    if (!hasBackend || !ids.length) { setQuotaLoading(false); return; }
    setQuotaLoading(true);
    getUserTokenQuotas(ids).then(items => { if (active) setQuotas(items); })
      .catch(error => { if (active) setQuotaError(error instanceof Error ? error.message : '流量加载失败'); })
      .finally(() => { if (active) setQuotaLoading(false); });
    return () => { active = false; };
  }, [visibleUserIds, quotaRefresh, users]);
  const quotaValue = (id: string, field: 'total' | 'used' | 'remaining') => quotas[id]
    ? quotas[id][field].toLocaleString('zh-CN') : quotaLoading ? '加载中…' : '—';
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!editing || saving || accessLoading || !access) return;
    setSaving(true);
    try { await dispatch({ type: 'save-user', user: editing }); setEditing(null); }
    catch (error) { setAccessError(error instanceof Error ? error.message : '保存失败'); }
    finally { setSaving(false); }
  };

  return <div className="admin-page page-enter user-management-page">{deleteConfirmHolder}<div className="page-title"><div><span className="section-kicker">IDENTITY & ACCESS</span><h1>用户管理</h1><p>维护平台用户、所属部门和角色状态。</p></div><div className="user-page-actions"><button className="secondary-action" type="button" disabled={quotaLoading || !hasBackend} onClick={() => setQuotaRefresh(value => value + 1)}>刷新流量</button><a className="secondary-action" href="/admin/users/sync">用户同步</a><button className="primary-action" type="button" onClick={() => { void open(emptyUser()); }}><Plus size={18} />新增用户</button></div></div><section className="admin-panel table-panel"><div className="toolbar"><label className="table-search"><Search size={18} /><input type="search" aria-label="搜索用户" placeholder="搜索姓名、工号或邮箱" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /></label><div className="toolbar-filters"><Filter size={16} /><ModernSelect compact ariaLabel="部门筛选" value={department} options={departmentFilters} onChange={(value) => { setDepartment(value); setPage(1); }} /><ModernSelect compact ariaLabel="状态筛选" value={status} options={toOptions(['全部状态', '启用', '停用'])} onChange={(value) => { setStatus(value); setPage(1); }} /></div></div><div className="table-meta"><span>本周期流量单位：Token；已用按模型倍率结算，进行中的请求可能尚未计入。</span></div>{quotaError && <p className="model-form-error" role="alert">流量加载失败：{quotaError}</p>}<div className="table-meta"><span>共 {filtered.length} 位用户</span><span><Shield size={14} />角色变更将在下次登录后生效</span></div><div className="table-wrap"><table className="data-grid user-management-table" aria-label="用户数据表格"><thead><tr><th>用户</th><th>工号</th><th>部门</th><th>角色</th><th>状态</th><th>本周期总额度</th><th>已用流量</th><th>剩余流量</th><th>周期截止（北京时间）</th><th>最近登录</th><th>MQ 同步</th><th className="user-actions-column">操作</th></tr></thead><tbody>{visible.map((user) => <tr key={user.id}><td><div className="user-cell"><span className="table-avatar">{user.name.slice(0, 1)}</span><span><strong>{user.name}</strong><small>{user.email}</small></span></div></td><td>{user.employeeNo}</td><td>{user.department || '未分配'}</td><td><span className="role-badge">{user.role}</span></td><td><span className={`state-badge ${user.status === '启用' ? 'is-enabled' : 'is-disabled'}`}>{user.status}</span></td><td>{quotaValue(user.id, 'total')}{quotas[user.id] && <small>{quotas[user.id].assigned ? `${quotas[user.id].planName} · ${quotas[user.id].source === 'User' ? '个人' : '部门继承'}` : '无有效配方'}</small>}</td><td>{quotaValue(user.id, 'used')}</td><td>{quotaValue(user.id, 'remaining')}</td><td>{quotas[user.id] ? new Date(quotas[user.id].resetsAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—'}</td><td>{user.lastLogin}</td><td className="user-sync-cell">{user.sync ? syncStatusNames[user.sync.status] : '暂无发送记录'}{user.sync?.sentAt && <small>{new Date(user.sync.sentAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</small>}</td><td className="user-actions-column"><div className="row-actions">{canManageBilling && <Link href={`/admin/billing/packages?userId=${encodeURIComponent(user.id)}`} title="流量包" aria-label={`查看${user.name}流量包`}><Ticket size={16} /></Link>}<button type="button" title="修改密码" aria-label={`修改${user.name}密码`} onClick={() => setPasswordUser(user)}><KeyRound size={16} /></button><button type="button" title="编辑用户" aria-label={`编辑${user.name}`} onClick={() => { void open(user); }}><Edit3 size={16} /></button><button type="button" title={user.status === '启用' ? '停用用户' : '启用用户'} aria-label={`${user.status === '启用' ? '停用' : '启用'}${user.name}`} onClick={() => dispatch({ type: 'toggle-user-status', id: user.id })}>{user.status === '启用' ? <UserX size={16} /> : <UserCheck size={16} />}</button><DeleteButton type="button" className="danger-icon" title={user.id === currentUserId ? '不能删除当前登录账号' : '删除用户'} aria-label={`删除${user.name}`} blockedReason={user.id === currentUserId ? '不能删除当前登录账号' : undefined} onClick={() => void confirmDelete(`删除用户“${user.name}”？删除后账号无法登录，历史记录保留。`, () => dispatch({ type: 'delete-user', id: user.id }))}><Trash2 size={16} /></DeleteButton></div></td></tr>)}</tbody></table></div>{!visible.length && <div className="table-empty"><UserX size={28} /><strong>没有匹配的用户</strong><span>请调整搜索或筛选条件。</span></div>}<AntPagination onPageSizeChange={setPageSize} ariaLabel="用户分页" current={currentPage} pageSize={pageSize} total={filtered.length} onChange={setPage} /></section>{notice && <div className="inline-toast" role="status">{notice}</div>}{passwordUser && <Modal title={`修改密码 · ${passwordUser.name}`} className="password-change-modal" onClose={() => setPasswordUser(null)}><PasswordChangeForm userId={passwordUser.id} /></Modal>}{editing && <Modal title={users.some((user) => user.id === editing.id) ? '编辑用户' : '新增用户'} className="user-access-modal" onClose={() => setEditing(null)}><form className="entity-form" onSubmit={save}><div className="user-edit-body" tabIndex={0} aria-label="用户资料和授权"><div className="form-grid"><label><span>姓名 *</span><input required value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label><label><span>工号 *</span><input required value={editing.employeeNo} onChange={(event) => setEditing({ ...editing, employeeNo: event.target.value })} /></label><label className="form-span"><span>企业邮箱 *</span><input required type="email" value={editing.email} onChange={(event) => setEditing({ ...editing, email: event.target.value })} /></label><div className="form-field"><span>部门</span><ModernSelect ariaLabel="部门" value={editing.department} options={[{ value: '', label: '未分配部门' }, ...toOptions(availableDepartments)]} onChange={(value) => setEditing({ ...editing, department: value, departmentId: availableDepartments.find(item => item.name === value)?.id ?? null })} /></div><div className="form-field"><span>角色</span><ModernSelect ariaLabel="角色" value={editing.role} options={toOptions(availableRoles)} onChange={(value) => setEditing({ ...editing, role: value as UserRole, roleIds: availableRoles.filter(item => item.name === value).map(item => item.id) })} /></div><label className="form-field"><span>计费配方</span>
        <SearchableSelect aria-label="计费配方" value={editing.billingPlanId ?? ''} disabled={saving} onChange={event => setEditing({ ...editing, billingPlanId: event.target.value || null })}>
          <option value="">继承部门配方</option>
          {plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name} · {plan.weeklyTokens.toLocaleString('zh-CN')} token/周{plan.isEnabled ? '' : '（已停用）'}</option>)}
        </SearchableSelect><small>{inheritedPlanName}</small></label></div><section className="user-access-fields" aria-label="用户资源授权">
      <label className="user-custom-model-toggle"><input type="checkbox" checked={editing.allowCustomModels ?? false} disabled={saving} onChange={event => setEditing({...editing, allowCustomModels: event.target.checked})}/><span>允许 DSH 自定义模型<small>开启后，该用户可在客户端配置并直连自定义模型；自定义调用不计入中台额度。</small></span></label>
      {accessLoading && <p role="status">正在加载授权选项…</p>}
      {accessError && <p role="alert" className="model-form-error">{accessError}</p>}
      {viewAccess && <><label className="form-field"><span>虚拟 Key 组</span><SearchableSelect aria-label="虚拟 Key 组" value={editing.virtualKeyIds?.[0] ?? ''} disabled={saving} onChange={event => setEditing({ ...editing, virtualKeyIds: event.target.value ? [event.target.value] : [] })}>
        <option value="">不直接分配</option>{viewAccess.virtualKeys.map(item => <option key={item.id} value={item.id} disabled={(!item.isEnabled && !item.selected) || viewAccess.virtualKeys.some(key => key.inherited && key.id !== item.id)}>{item.name}{item.inherited ? '（继承归属）' : ''}{!item.isEnabled ? '（已停用）' : ''}</option>)}
      </SearchableSelect><small>{viewAccess.virtualKeys.filter(item => item.inherited).map(item => `已通过部门、角色或分组归属：${item.name}`).join('；') || '一个用户只能归属一个虚拟 Key 组'}</small><small>可用模型自动跟随虚拟 Key 的授权范围，无需单独配置模型。</small></label></>}
      {viewAccess && ([['plugins', 'pluginIds', '插件'], ['releases', 'releaseIds', '版本'], ['mcps', 'mcpIds', 'MCP']] as const).map(([key, field, label]) => <div className="form-field" key={key}><span>{label}选择</span><ModernMultiSelect ariaLabel={`${label}选择`} itemLabel={label} values={editing[field] ?? []} disabled={saving || !viewAccess[key]} onChange={ids => setEditing({ ...editing, [field]: ids })} options={(viewAccess[key] ?? []).map(item => ({ value: item.id, label: item.name, description: [item.inherited ? '部门 / 角色已授权' : '', !item.isEnabled ? '未启用 / 未发布' : ''].filter(Boolean).join(' · '), disabled: !item.isEnabled && !editing[field]?.includes(item.id) }))} /><small>{!viewAccess[key] ? '当前后端不支持此选项，请更新 API。' : key === 'releases' ? '可多选客户端发布版本；更新检查按平台、架构和版本号匹配，不会强制降级。' : '可多选。此处维护直接授权，部门、角色继承的权限保持有效。'}</small></div>)}
      </section></div><footer className="modal-actions"><button type="button" onClick={() => setEditing(null)}>取消</button><button className="primary-action" type="submit" disabled={saving || accessLoading || !access}>保存用户</button></footer></form></Modal>}</div>;
}
