'use client';

import { useMemo, useState } from 'react';
import { Check, Edit3, Filter, KeyRound, Plus, Search, ShieldCheck, Trash2, UsersRound } from 'lucide-react';
import { usePageSize } from '../../components/use-page-size';
import { AntPagination } from '../../components/ant-pagination';
import { Modal } from '../../components/modal';
import { ModernSelect, type SelectOption } from '../../components/modern-select';
import { usePlatform } from '../../components/platform-provider';
import type { AdminPath, PlatformRole } from '../../lib/platform-state';

export const adminPageOptions: Array<{ path: AdminPath; label: string; description: string }> = [
  { path: '/admin', label: '工作台', description: '查看平台运营概览' },
  { path: '/admin/publications', label: '发布申请', description: '创建并跟踪应用发布申请' },
  { path: '/admin/reviews', label: '发布审核', description: '处理被分配的流程任务' },
  { path: '/admin/processes', label: '流程设计', description: '设计与发布 BPMN 流程' },
  { path: '/admin/users', label: '用户管理', description: '维护用户及所属角色' },
  { path: '/admin/departments', label: '部门管理', description: '维护组织部门信息' },
  { path: '/admin/categories', label: '分类管理', description: '维护应用分类目录' },
  { path: '/admin/roles', label: '角色管理', description: '配置角色及页面权限' },
  { path: '/admin/plugins', label: '插件市场', description: '管理插件发布、授权与客户端状态' },
  { path: '/admin/models', label: '模型管理', description: '配置本地与在线 AI 模型接入' },
  { path: '/admin/announcements', label: '公告管理', description: '发布客户端定向公告' },
  { path: '/admin/dsh-failures', label: '失败日志', description: '查询客户端失败记录并下载诊断日志' },
  { path: '/admin/client-releases', label: '客户端发布', description: '管理客户端版本与灰度人员' },
  { path: '/admin/sensitive-words', label: '敏感词管理', description: '配置 DSH 输入内容过滤规则' },
];

const typeOptions: SelectOption[] = [
  { value: '全部类型', label: '全部类型' },
  { value: '系统角色', label: '系统角色' },
  { value: '自定义角色', label: '自定义角色' },
];
const emptyRole = (): PlatformRole => ({ id: `role-${Date.now()}`, name: '', description: '', permissions: ['/admin'], builtIn: false });

export default function RoleManagementPage() {
  const [pageSize, setPageSize] = usePageSize();
  const { roles, users, dispatch, notice } = usePlatform();
  const [query, setQuery] = useState('');
  const [roleType, setRoleType] = useState('全部类型');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<PlatformRole | null>(null);
  const [permissionRoleId, setPermissionRoleId] = useState<string | null>(null);

  const filtered = useMemo(() => roles.filter((role) => {
    const matchesQuery = !query.trim() || `${role.name}${role.description}`.toLowerCase().includes(query.trim().toLowerCase());
    const type = role.builtIn ? '系统角色' : '自定义角色';
    return matchesQuery && (roleType === '全部类型' || roleType === type);
  }), [query, roleType, roles]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleRoles = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const permissionRole = roles.find((role) => role.id === permissionRoleId) ?? null;

  const togglePermission = (role: PlatformRole, path: AdminPath) => {
    const paths = role.permissions.includes(path)
      ? role.permissions.filter((item) => item !== path)
      : [...role.permissions, path];
    dispatch({ type: 'save-role-permissions', role: role.name, paths });
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing?.name.trim()) return;
    try { await dispatch({ type: 'save-role', role: { ...editing, name: editing.name.trim(), description: editing.description.trim() } }); setEditing(null); }
    catch { /* 保持弹窗以便修正 */ }
  };
  const updateQuery = (value: string) => { setQuery(value); setPage(1); };
  const updateRoleType = (value: string) => { setRoleType(value); setPage(1); };

  return (
    <div className="admin-page page-enter">
      <div className="page-title">
        <div><span className="section-kicker">ROLE BASED ACCESS</span><h1>角色管理</h1><p>创建角色，并配置登录后台后可以查看的功能页面。</p></div>
        <button className="primary-action" type="button" onClick={() => setEditing(emptyRole())}><Plus size={18} />新增角色</button>
      </div>

      <section className="admin-panel table-panel role-table-panel">
        <div className="toolbar">
          <label className="table-search"><Search size={18} /><input type="search" aria-label="搜索角色" placeholder="搜索角色名称或说明" value={query} onChange={(event) => updateQuery(event.target.value)} /></label>
          <div className="toolbar-filters"><Filter size={16} /><ModernSelect compact ariaLabel="角色类型筛选" value={roleType} options={typeOptions} onChange={updateRoleType} /></div>
        </div>
        <div className="table-meta"><span>共 {filtered.length} 个角色</span><span><ShieldCheck size={14} />页面权限将在用户下次进入后台时生效</span></div>
        <div className="table-wrap">
          <table aria-label="角色数据表格">
            <thead><tr><th>角色名称</th><th>类型</th><th>关联用户</th><th>页面权限</th><th>角色说明</th><th><span className="sr-only">操作</span></th></tr></thead>
            <tbody>
              {visibleRoles.map((role) => {
                const userCount = users.filter((user) => user.role === role.name).length;
                const cannotDelete = role.builtIn || userCount > 0;
                return (
                  <tr key={role.id}>
                    <td><div className="role-name-cell"><span><ShieldCheck size={17} /></span><strong>{role.name}</strong></div></td>
                    <td><span className={`role-type-badge${role.builtIn ? ' is-system' : ''}`}>{role.builtIn ? '系统角色' : '自定义角色'}</span></td>
                    <td><span className="role-user-count"><UsersRound size={15} />{userCount} 人</span></td>
                    <td><button className="permission-count-button" type="button" aria-label={`配置${role.name}权限`} onClick={() => setPermissionRoleId(role.id)}><KeyRound size={15} /><strong>{role.permissions.length}</strong> / {adminPageOptions.length} 个页面</button></td>
                    <td><span className="role-table-description" title={role.description}>{role.description || '暂无角色说明'}</span></td>
                    <td><div className="row-actions"><button type="button" aria-label={`编辑${role.name}`} title="编辑角色" onClick={() => setEditing({ ...role })}><Edit3 size={16} /></button><button className="danger-icon" type="button" aria-label={`删除${role.name}`} title={cannotDelete ? (role.builtIn ? '系统角色不可删除' : '该角色仍有关联用户') : '删除角色'} disabled={cannotDelete} onClick={() => dispatch({ type: 'delete-role', id: role.id })}><Trash2 size={16} /></button></div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!visibleRoles.length && <div className="table-empty"><ShieldCheck size={28} /><strong>没有匹配的角色</strong><span>请调整搜索词或角色类型。</span></div>}
        <AntPagination onPageSizeChange={setPageSize} ariaLabel="角色分页" current={currentPage} pageSize={pageSize} total={filtered.length} onChange={setPage} />
      </section>

      {notice && <div className="inline-toast" role="status">{notice}</div>}

      {permissionRole && <Modal title={`配置${permissionRole.name}权限`} onClose={() => setPermissionRoleId(null)}>
        <div className="permission-dialog">
          <div className="permission-dialog__summary"><span><ShieldCheck size={18} /></span><div><strong>{permissionRole.permissions.length} / {adminPageOptions.length} 个页面已授权</strong><small>勾选后立即更新该角色的后台菜单可见范围。</small></div></div>
          <div className="modal-actions"><button className="secondary-action" type="button" disabled={adminPageOptions.every(item => permissionRole.permissions.includes(item.path))} onClick={() => dispatch({ type: 'save-role-permissions', role: permissionRole.name, paths: [...new Set([...permissionRole.permissions, ...adminPageOptions.map(item => item.path)])] })}>全选</button></div>
          <div className="permission-dialog-grid">{adminPageOptions.map((item) => { const checked = permissionRole.permissions.includes(item.path); return <label key={item.path} className={checked ? 'is-checked' : ''}><input type="checkbox" aria-label={`${permissionRole.name}查看${item.label}`} checked={checked} onChange={() => togglePermission(permissionRole, item.path)} /><span className="role-check">{checked && <Check size={13} />}</span><span><strong>{item.label}</strong><small>{item.description}</small></span></label>; })}</div>
          <footer className="modal-actions"><button className="primary-action" type="button" onClick={() => setPermissionRoleId(null)}>完成</button></footer>
        </div>
      </Modal>}

      {editing && <Modal title={roles.some((role) => role.id === editing.id) ? '编辑角色' : '新增角色'} onClose={() => setEditing(null)}><form className="entity-form" onSubmit={save}><div className="form-grid"><label className="form-span"><span>角色名称 *</span><input aria-label="角色名称" required value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label><label className="form-span"><span>角色说明</span><textarea aria-label="角色说明" rows={3} value={editing.description} onChange={(event) => setEditing({ ...editing, description: event.target.value })} /></label></div><footer className="modal-actions"><button type="button" onClick={() => setEditing(null)}>取消</button><button className="primary-action" type="submit">保存角色</button></footer></form></Modal>}
    </div>
  );
}
