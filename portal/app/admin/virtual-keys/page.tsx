'use client';

import { useEffect, useState } from 'react';
import { KeyRound, Plus, Settings2, Users, Power } from 'lucide-react';
import { RecipientPicker } from '../components/recipient-picker';
import { AntPagination } from '../../components/ant-pagination';
import { usePageSize } from '../../components/use-page-size';
import { Modal } from '../../components/modal';
import { KeyPolicyFields, policyDraft, policyInput } from './key-policy-form';
import { createManagedVirtualKey, getVirtualKeyGrantOptions, getManagedVirtualKeys,
  getVirtualKeyPolicy, getVirtualKeyModels, updateVirtualKeyPolicy,
  getVirtualKeyGrants, getVirtualKeyOrganizations, saveVirtualKeyGrants, setManagedVirtualKeyEnabled,
  type VirtualKeyPolicyView, type GrantOptions, type ManagedVirtualKey, type VirtualKeyGrants, type VirtualKeyOrganization } from '../../lib/api-client';

const blank = (): VirtualKeyGrants => ({ userIds: [], departmentIds: [], roleIds: [], organizationIds: [] });

export default function VirtualKeysPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize();
  const [keys, setKeys] = useState<ManagedVirtualKey[]>([]);
  const [organizations, setOrganizations] = useState<VirtualKeyOrganization[]>([]);
  const [options, setOptions] = useState<GrantOptions | null>(null);
  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const [alias, setAlias] = useState('');
  const [customKey, setCustomKey] = useState('');
  const [policyKey, setPolicyKey] = useState<ManagedVirtualKey | null>(null);
  const [currentPolicy, setCurrentPolicy] = useState<VirtualKeyPolicyView>();
  const [policy, setPolicy] = useState(policyDraft());
  const [policyModels, setPolicyModels] = useState<string[]>([]);
  const [policyError, setPolicyError] = useState('');
  const [grantError, setGrantError] = useState('');
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
    setBusy(true); setMessage(''); setPolicyError('');
    try {
      const input = policyInput(policy);
      if (!input.allModels && input.models.length === 0) throw new Error('请选择至少一个模型，或明确选择全部模型');
      if (policyKey) await updateVirtualKeyPolicy(policyKey.id, input);
      else await createManagedVirtualKey(alias.trim(), customKey.trim(), input);
      const success = policyKey ? '套餐规则已同步到 LiteLLM。' : 'Key 及套餐规则已在 LiteLLM 创建，请继续配置授权。';
      setCreating(false); setPolicyKey(null); setAlias(''); setCustomKey(''); setMessage(success);
      try { await refresh(); } catch { setMessage(`${success}列表刷新失败，请刷新页面查看。`); }
    }
    catch (error) { setPolicyError(error instanceof Error ? error.message : '同步失败'); }
    finally { setBusy(false); }
  };
  const openPolicy = async (key?: ManagedVirtualKey) => {
    setBusy(true); setMessage(''); setPolicyError('');
    try {
      const [models, current] = await Promise.all([getVirtualKeyModels(), key ? getVirtualKeyPolicy(key.id) : Promise.resolve(undefined)]);
      setPolicyModels(models); setCurrentPolicy(current); setPolicy(policyDraft(current)); setPolicyKey(key ?? null);
      setAlias(''); setCustomKey(''); setCreating(true);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'LiteLLM 配置加载失败'); }
    finally { setBusy(false); }
  };
  const openGrants = async (key: ManagedVirtualKey) => {
    setBusy(true); setGrantError('');
    try {
      const [loaded, available] = await Promise.all([getVirtualKeyGrants(key.id), getVirtualKeyGrantOptions(key.id)]);
      setOptions(available);
      // Preserve existing access while replacing legacy custom groups with explicit users on save.
      const legacyUsers = organizations.filter(item => loaded.organizationIds.includes(item.id)).flatMap(item => item.userIds);
      setGrants({ ...loaded, roleIds: loaded.roleIds ?? [], userIds: [...new Set([...loaded.userIds, ...legacyUsers])], organizationIds: [] });
      setSelected(key);
    }
    catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const saveGrants = async () => {
    if (!selected) return;
    setBusy(true);
    setGrantError('');
    try {
      await saveVirtualKeyGrants(selected.id, grants); setSelected(null); setMessage('授权已保存，同一用户仅归属一个虚拟 Key 组。');
      try { await refresh(); } catch { setMessage('授权已保存，列表刷新失败，请刷新页面查看。'); }
    }
    catch (error) { setGrantError(error instanceof Error ? error.message : '授权保存失败'); }
    finally { setBusy(false); }
  };
  return <div className="admin-page page-enter">
    <div className="page-title"><div><span className="section-kicker">LITELLM ACCESS</span><h1>虚拟 Key 管理</h1><p>AIGC 负责创建和授权；共享 Key 合计用量、单人 Key 独立限额均由 LiteLLM 管控。</p></div>
      <div className="page-title-actions"><a className="secondary-action" href="/admin/departments">部门管理</a><button className="primary-action" disabled={busy} onClick={() => void openPolicy()}><Plus size={18} />创建 Key</button></div></div>
    {message && <div className="inline-notice" role="status">{message}</div>}
    <section className="admin-panel table-panel"><div className="table-meta"><span>共 {keys.length} 个虚拟 Key</span><span>密钥不会在列表中展示</span></div>
      <div className="data-grid-wrap"><table className="data-grid"><thead><tr><th>别名</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{keys.slice((Math.min(page, Math.max(1, Math.ceil(keys.length / pageSize))) - 1) * pageSize, Math.min(page, Math.max(1, Math.ceil(keys.length / pageSize))) * pageSize).map((key) => <tr key={key.id}>
        <td><strong>{key.alias}</strong></td><td>{key.isEnabled ? '已启用' : '已停用'}</td><td>{new Date(key.createdAt).toLocaleString()}</td>
        <td><div className="table-actions"><button type="button" className="icon-button" title="套餐规则" aria-label={`套餐规则 · ${key.alias}`} disabled={busy} onClick={() => void openPolicy(key)}><Settings2 size={16} /></button><button type="button" className="icon-button" title="授权" aria-label={`授权 · ${key.alias}`} disabled={busy} onClick={() => void openGrants(key)}><Users size={16} /></button><button type="button" className="icon-button" title={key.isEnabled ? '停用' : '启用'} aria-label={`${key.isEnabled ? '停用' : '启用'} · ${key.alias}`} disabled={busy} onClick={() => void setManagedVirtualKeyEnabled(key.id, !key.isEnabled).then(refresh).catch((error) => setMessage(String(error)))}><Power size={16} /></button></div></td>
      </tr>)}</tbody></table>{keys.length === 0 && <div className="empty-state"><KeyRound size={28} /><strong>尚无虚拟 Key</strong><span>在此创建，并直接配置模型权限、预算和速率限制。</span></div>}</div><AntPagination ariaLabel="虚拟 Key 分页" current={page} pageSize={pageSize} total={keys.length} onChange={setPage} onPageSizeChange={setPageSize} /></section>
    {creating && <Modal title={policyKey ? `套餐规则 · ${policyKey.alias}` : '创建 LiteLLM 虚拟 Key'} className="virtual-key-policy-modal" onClose={() => { if (!busy) { setCreating(false); setPolicyKey(null); } }}>
      <form className="entity-form virtual-key-policy-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <div className="virtual-key-policy-body" tabIndex={0} aria-label="虚拟 Key 套餐配置">
          <p>模型权限、预算和限额直接同步到 LiteLLM。编辑时读取网关当前配置，密钥仅加密保存在服务端。</p>
          {!policyKey && <><label>别名<input required minLength={2} maxLength={100} value={alias} onChange={(event) => setAlias(event.target.value)} /></label>
            <label>自定义 Key（可选）<input type="password" autoComplete="new-password" value={customKey} onChange={(event) => setCustomKey(event.target.value)} placeholder="留空自动生成；或 sk- 开头至少 16 字符" /></label></>}
          <KeyPolicyFields value={policy} onChange={setPolicy} models={policyModels} current={currentPolicy} />
          {policyError && <p className="model-form-error" role="alert">{policyError}</p>}
        </div>
        <div className="modal-actions"><button className="secondary-action" type="button" disabled={busy} onClick={() => { setCreating(false); setPolicyKey(null); }}>取消</button>
          <button className="primary-action" disabled={busy}>{busy ? '同步中…' : policyKey ? '保存并同步' : '创建并同步'}</button></div>
      </form></Modal>}
    {selected && options && <Modal title={`授权 ${selected.alias}`} className="virtual-key-grant-modal" onClose={() => { if (!busy) setSelected(null); }}><div className="entity-form model-grant-dialog distribution-form virtual-key-grant-form">
      <div className="virtual-key-grant-body" tabIndex={0} aria-label="虚拟 Key 授权配置">
      <p>每位用户只能归属一个虚拟 Key 组。已在其他组的用户不可选；部门或角色包含其他组成员时也不可选，需先解除原组授权。</p>
      <RecipientPicker options={options} value={{ userIds: grants.userIds, roleIds: grants.roleIds ?? [], departmentIds: grants.departmentIds }} mode="authorization" onChange={selection => setGrants({ ...grants, ...selection })} />
      {grantError && <p className="model-form-error" role="alert">{grantError}</p>}
      </div>
      <div className="modal-actions"><button className="secondary-action" onClick={() => setSelected(null)}>取消</button><button className="primary-action" disabled={busy} onClick={() => void saveGrants()}>保存授权</button></div></div></Modal>}
  </div>;
}
