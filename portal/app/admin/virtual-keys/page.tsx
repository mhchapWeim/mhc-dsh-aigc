'use client';

import { useEffect, useState } from 'react';
import { KeyRound, Plus } from 'lucide-react';
import { RecipientPicker } from '../components/recipient-picker';
import { Modal } from '../../components/modal';
import { createManagedVirtualKey, getVirtualKeyGrantOptions, getManagedVirtualKeys,
  getVirtualKeyGrants, getVirtualKeyOrganizations, saveVirtualKeyGrants, setManagedVirtualKeyEnabled,
  type GrantOptions, type ManagedVirtualKey, type VirtualKeyGrants, type VirtualKeyOrganization } from '../../lib/api-client';

const blank = (): VirtualKeyGrants => ({ userIds: [], departmentIds: [], roleIds: [], organizationIds: [] });

export default function VirtualKeysPage() {
  const [keys, setKeys] = useState<ManagedVirtualKey[]>([]);
  const [organizations, setOrganizations] = useState<VirtualKeyOrganization[]>([]);
  const [options, setOptions] = useState<GrantOptions | null>(null);
  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const [alias, setAlias] = useState('');
  const [customKey, setCustomKey] = useState('');
  const [selected, setSelected] = useState<ManagedVirtualKey | null>(null);
  const [grants, setGrants] = useState<VirtualKeyGrants>(blank());
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const [loadedKeys, loadedOrganizations, loadedOptions] = await Promise.all([
      getManagedVirtualKeys(), getVirtualKeyOrganizations(), getVirtualKeyGrantOptions(),
    ]);
    setKeys(loadedKeys); setOrganizations(loadedOrganizations); setOptions(loadedOptions);
  };
  useEffect(() => { void refresh().catch((error) => setMessage(String(error))); }, []);
  const create = async () => {
    setBusy(true); setMessage('');
    try { await createManagedVirtualKey(alias.trim(), customKey.trim()); setCreating(false); setAlias(''); setCustomKey(''); await refresh(); setMessage('Key 已在 LiteLLM 创建，并加密保存在 AIGC。请继续配置授权。'); }
    catch (error) { setMessage(error instanceof Error ? error.message : '创建失败'); }
    finally { setBusy(false); }
  };
  const openGrants = async (key: ManagedVirtualKey) => {
    try {
      const loaded = await getVirtualKeyGrants(key.id);
      // Preserve existing access while replacing legacy custom groups with explicit users on save.
      const legacyUsers = organizations.filter(item => loaded.organizationIds.includes(item.id)).flatMap(item => item.userIds);
      setGrants({ ...loaded, roleIds: loaded.roleIds ?? [], userIds: [...new Set([...loaded.userIds, ...legacyUsers])], organizationIds: [] });
      setSelected(key);
    }
    catch (error) { setMessage(String(error)); }
  };
  const saveGrants = async () => {
    if (!selected) return;
    setBusy(true);
    try { await saveVirtualKeyGrants(selected.id, grants); setSelected(null); setMessage('授权已保存。若同一用户命中多个 Key，DSH 会拒绝随机选择，请调整重叠授权。'); }
    catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  return <div className="admin-page page-enter">
    <div className="page-title"><div><span className="section-kicker">LITELLM ACCESS</span><h1>虚拟 Key 管理</h1><p>AIGC 负责创建和授权；共享 Key 合计用量、单人 Key 独立限额均由 LiteLLM 管控。</p></div>
      <div className="page-title-actions"><a className="secondary-action" href="/admin/departments">部门管理</a><button className="primary-action" onClick={() => setCreating(true)}><Plus size={18} />创建 Key</button></div></div>
    {message && <div className="inline-notice" role="status">{message}</div>}
    <section className="admin-panel table-panel"><div className="table-meta"><span>共 {keys.length} 个虚拟 Key</span><span>密钥不会在列表中展示</span></div>
      <div className="data-grid-wrap"><table className="data-grid"><thead><tr><th>别名</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{keys.map((key) => <tr key={key.id}>
        <td><strong>{key.alias}</strong></td><td>{key.isEnabled ? '已启用' : '已停用'}</td><td>{new Date(key.createdAt).toLocaleString()}</td>
        <td><div className="table-actions"><button className="secondary-action" onClick={() => void openGrants(key)}>授权</button><button className="secondary-action" onClick={() => void setManagedVirtualKeyEnabled(key.id, !key.isEnabled).then(refresh).catch((error) => setMessage(String(error)))}>{key.isEnabled ? '停用' : '启用'}</button></div></td>
      </tr>)}</tbody></table>{keys.length === 0 && <div className="empty-state"><KeyRound size={28} /><strong>尚无虚拟 Key</strong><span>先在此创建，再到 LiteLLM 管理限额和模型权限。</span></div>}</div></section>
    {creating && <Modal title="创建 LiteLLM 虚拟 Key" onClose={() => setCreating(false)}><form className="entity-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <p>自定义 Key 可留空，由 LiteLLM 生成。AIGC 仅保存加密后的 Key；创建后请到 LiteLLM 设置成本与用量限制。</p>
      <label>别名<input required minLength={2} maxLength={100} value={alias} onChange={(event) => setAlias(event.target.value)} /></label>
      <label>自定义 Key（可选）<input type="password" autoComplete="new-password" value={customKey} onChange={(event) => setCustomKey(event.target.value)} placeholder="sk-…（至少 16 字符）" /></label>
      <div className="modal-actions"><button className="secondary-action" type="button" onClick={() => setCreating(false)}>取消</button><button className="primary-action" disabled={busy}>创建</button></div></form></Modal>}
    {selected && options && <Modal title={`授权 ${selected.alias}`} onClose={() => setSelected(null)}><div className="entity-form model-grant-dialog distribution-form">
      <p>可绑定一个用户、多个用户、角色或部门。授权重叠会使 DSH 拒绝选择，避免计费落入错误的 Key。</p>
      <RecipientPicker options={options} value={{ userIds: grants.userIds, roleIds: grants.roleIds ?? [], departmentIds: grants.departmentIds }} mode="authorization" onChange={selection => setGrants({ ...grants, ...selection })} />
      <div className="modal-actions"><button className="secondary-action" onClick={() => setSelected(null)}>取消</button><button className="primary-action" disabled={busy} onClick={() => void saveGrants()}>保存授权</button></div></div></Modal>}
  </div>;
}
