'use client';

import { useState } from 'react';
import { AntPagination } from '../../components/ant-pagination';
import { Building2, Check, Search, ShieldCheck, Users, X } from 'lucide-react';
import type { DesktopAudienceOptions, GrantOptions, GrantSelection } from '../../lib/api-client';

const groups = [
  { key: 'userIds', options: 'users', label: '用户', icon: Users },
  { key: 'roleIds', options: 'roles', label: '角色', icon: ShieldCheck },
  { key: 'departmentIds', options: 'departments', label: '部门', icon: Building2 },
] as const;
export const emptyAudience = (): GrantSelection => ({ userIds: [], roleIds: [], departmentIds: [] });
export const emptyAudienceOptions = (): DesktopAudienceOptions => ({ users: [], roles: [], departments: [] });

type PickerOptions = Omit<GrantOptions, 'users'> & { users: Array<GrantOptions['users'][number] & { departmentId?: string; roleIds?: string[] }> };

export function RecipientPicker({ options, value, onChange, mode = 'recipients' }: {
  options: PickerOptions; value: GrantSelection; onChange: (selection: GrantSelection) => void; mode?: 'recipients' | 'authorization';
}) {
  const [tab, setTab] = useState<(typeof groups)[number]>(groups[0]);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 12;
  const matches = options[tab.options].filter(item => `${item.name} ${'employeeNo' in item ? item.employeeNo : item.code}`.toLowerCase().includes(query.trim().toLowerCase()));
  const currentPage = Math.min(page, Math.max(1, Math.ceil(matches.length / pageSize)));
  const pageItems = matches.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const selected = value[tab.key];
  const selectedIds = new Set(selected);
  const selectItems = (items: Array<{ id: string }>) => onChange({ ...value, [tab.key]: [...new Set([...selected, ...items.map(item => item.id)])] });
  const recipients = options.users.filter(user => value.userIds.includes(user.id) || value.departmentIds.includes(user.departmentId ?? '')
    || (user.roleIds ?? []).some(id => value.roleIds.includes(id)));
  const toggle = (id: string) => onChange({ ...value, [tab.key]: selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id] });
  const title = mode === 'authorization' ? '授权范围' : '接收范围';
  return <section className="recipient-picker" aria-label={title}>
    <div className="recipient-heading"><div><h3>{title}</h3><p>{mode === 'authorization' ? '按用户、角色或部门组合授权。' : '支持组合选择，重复人员只接收一次。'}</p></div><span className="recipient-count">{mode === 'authorization' ? `${value.userIds.length + value.roleIds.length + value.departmentIds.length} 项` : `${recipients.length} 人`}</span></div>
    <div className="recipient-tabs" role="tablist" aria-label={mode === 'authorization' ? '授权对象类型' : '接收对象类型'}>{groups.map(group => <button type="button" role="tab" aria-selected={tab.key === group.key}
      key={group.key} onClick={() => { setTab(group); setQuery(''); setPage(1); }}><group.icon size={16} />{group.label}<span>{value[group.key].length}</span></button>)}</div>
    <div className="recipient-toolbar"><label className="recipient-search"><Search size={16} /><input type="search" aria-label={`搜索${mode === 'authorization' ? '授权' : '接收'}${tab.label}`} placeholder={`搜索${tab.label}名称${tab.key === 'userIds' ? '或工号' : '或编号'}`} value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} /></label>
      <button type="button" disabled={pageItems.length === 0 || pageItems.every(item => selectedIds.has(item.id))} onClick={() => selectItems(pageItems)}>选择本页</button>
      <button type="button" title={`选择当前${tab.label}搜索结果的全部 ${matches.length} 项（包含所有分页）`} disabled={matches.length === 0 || matches.every(item => selectedIds.has(item.id))} onClick={() => selectItems(matches)}>全选</button></div>
    <p className="recipient-hint">全选包含当前{tab.label}搜索结果的所有分页，共 {matches.length} 项。</p>
    <div className="recipient-list">{pageItems.map(item => <label key={item.id} className={selected.includes(item.id) ? 'is-selected' : ''}>
      <input type="checkbox" checked={selected.includes(item.id)} onChange={() => toggle(item.id)} />
      <span><strong>{item.name}</strong><small>{'employeeNo' in item ? item.employeeNo : item.code}</small></span><Check size={16} aria-hidden="true" />
    </label>)}{matches.length === 0 && <p className="recipient-empty">没有匹配的{tab.label}</p>}</div>
    <AntPagination ariaLabel={`${title}${tab.label}分页`} current={currentPage} total={matches.length} pageSize={pageSize} onChange={setPage} />
    {groups.some(group => value[group.key].length > 0) && <div className="recipient-selected">{groups.flatMap(group => value[group.key].map(id => {
      const item = options[group.options].find(option => option.id === id);
      return <button type="button" key={`${group.key}/${id}`} aria-label={`移除${item?.name ?? '已失效对象'}`} onClick={() => onChange({ ...value, [group.key]: value[group.key].filter(selectedId => selectedId !== id) })}>{group.label} · {item?.name ?? '已失效对象'}<X size={12} /></button>;
    }))}<button type="button" className="recipient-clear" onClick={() => onChange(emptyAudience())}>清空</button></div>}
    <p className="recipient-hint">{mode === 'authorization' ? '已选范围会保留在下方，可逐项移除或清空。' : '保存时按当前成员生成接收名单；成员变化后可重新保存范围。'}</p>
  </section>;
}
