"use client";

import { ModernMultiSelect } from '../../components/modern-multi-select';
import type { UserAccessOption } from '../../lib/api-client';

export function UserModelPicker({ models, selected, busy, onChange }: {
  models: UserAccessOption[]; selected: string[]; busy: boolean; onChange: (ids: string[]) => void;
}) {
  return <div className="form-field"><span>模型选择</span><ModernMultiSelect ariaLabel="模型选择" values={selected} disabled={busy} onChange={onChange}
    options={models.map(item => ({ value: item.id, label: item.name, description: [item.inherited ? '部门 / 角色已授权' : '', !item.isEnabled ? '已停用' : ''].filter(Boolean).join(' · '), disabled: !item.isEnabled && !selected.includes(item.id) }))} />
    <small>可多选。此处维护直接授权；部门、角色继承的权限由对应管理页面维护。</small></div>;
}
