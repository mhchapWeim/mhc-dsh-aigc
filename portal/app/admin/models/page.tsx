'use client';

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Globe2, Plus, Power, RefreshCw, Search, Server } from 'lucide-react';
import { usePageSize } from '../../components/use-page-size';
import { AntPagination } from '../../components/ant-pagination';
import { Modal } from '../../components/modal';
import { ModernSelect } from '../../components/modern-select';
import { BackendModelConfiguration, GrantOptions, GrantSelection, WebSearchSettings, deleteModelConfiguration, getGrantOptions, getModelConfigurations, getModelGrants, getWebSearchSettings, hasBackend, saveModelConfiguration, saveModelGrants, saveWebSearchSettings, syncLiteLlmModels, testModelConfiguration } from '../../lib/api-client';
import { GrantSelector } from './grant-selector';
import { ModelCapabilitySummary, ModelDetails, ModelRowActions } from './model-details';

type ModelForm = { id: string; name: string; providerKind: string; baseUrl: string; endpointPath: string; modelIdentifier: string; apiKey: string; authType: string; apiKeyHeader: string; imageInputMode: string; multiplier: string; supportsTools: boolean; isEnabled: boolean; isDefault: boolean; temperature: string; maxTokens: string; sortOrder: string };
const emptyForm = (): ModelForm => ({ id: '', name: '', providerKind: 'Online', baseUrl: '', endpointPath: '/chat/completions', modelIdentifier: '', apiKey: '', authType: 'Bearer', apiKeyHeader: 'X-API-Key', imageInputMode: 'Auto', multiplier: '', supportsTools: true, isEnabled: true, isDefault: false, temperature: '0.3', maxTokens: '', sortOrder: '0' });
const emptyGrants = (): GrantSelection => ({ userIds: [], roleIds: [], departmentIds: [] });

function ModelOptionToggle({ checked, icon, label, onChange }: { checked: boolean; icon: React.ReactNode; label: string; onChange: () => void }) {
  return <button type="button" className={`model-option-toggle${checked ? ' is-on' : ''}`} role="switch" aria-checked={checked} onClick={onChange}>
    <span className="model-option-toggle__content"><span className="model-option-toggle__icon">{icon}</span><span><strong>{label}</strong><small>{checked ? '已开启' : '已关闭'}</small></span></span>
    <span className="model-option-toggle__switch" aria-hidden="true"><i /></span>
  </button>;
}

export default function ModelManagementPage() {
  const [pageSize, setPageSize] = usePageSize();
  const [items, setItems] = useState<BackendModelConfiguration[]>([]);
  const [loading, setLoading] = useState(hasBackend);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('全部类型');
  const [status, setStatus] = useState('全部状态');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ModelForm | null>(null);
  const [detailModel, setDetailModel] = useState<BackendModelConfiguration | null>(null);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [grantModel, setGrantModel] = useState<BackendModelConfiguration | null>(null);
  const [grantOptions, setGrantOptions] = useState<GrantOptions | null>(null);
  const [grantSelection, setGrantSelection] = useState<GrantSelection>(emptyGrants);
  const [searchSettings, setSearchSettings] = useState<WebSearchSettings | null>(null);
  const [searchKey, setSearchKey] = useState('');
  const [searchDialog, setSearchDialog] = useState(false);
  const [savingGrants, setSavingGrants] = useState(false);
  const [grantError, setGrantError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);

  const refresh = async () => { if (!hasBackend) return; setItems(await getModelConfigurations()); };
  useEffect(() => {
    if (!hasBackend) return;
    let active = true;
    getModelConfigurations().then(models => { if (active) setItems(models); })
      .catch(() => { if (active) { setItems([]); setLoadError('模型配置加载失败，请刷新页面重试'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const filtered = useMemo(() => items.filter((item) => (!query.trim() || `${item.name}${item.modelIdentifier}${item.baseUrl}`.toLowerCase().includes(query.trim().toLowerCase())) && (provider === '全部类型' || item.providerKind === provider) && (status === '全部状态' || (status === '已启用') === item.isEnabled)), [items, query, provider, status]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = filtered.slice((Math.min(page, pageCount) - 1) * pageSize, Math.min(page, pageCount) * pageSize);
  const openEdit = (item?: BackendModelConfiguration) => { setFormError(''); setEditing(item ? { ...emptyForm(), ...item, apiKey: '', temperature: String(item.temperature), maxTokens: item.maxTokens ? String(item.maxTokens) : '', sortOrder: String(item.sortOrder) } : emptyForm()); };
  const changeProvider = (providerKind: string) => setEditing((current) => current ? {
    ...current,
    providerKind,
    authType: current.authType,
    baseUrl: providerKind === 'LiteLLM' && !current.baseUrl ? 'http://localhost:4000/v1' : current.baseUrl,
    endpointPath: providerKind === 'LiteLLM' ? '/chat/completions' : current.endpointPath,
  } : current);
  const save = async (event: React.FormEvent) => { event.preventDefault(); if (!editing) return; setFormError(''); try { await saveModelConfiguration(editing.id || null, { ...editing, temperature: Number(editing.temperature) || 0.3, maxTokens: editing.maxTokens ? Number(editing.maxTokens) : null, sortOrder: Number(editing.sortOrder) || 0 }); setEditing(null); setNotice('模型配置已保存'); await refresh(); } catch (error) { setFormError(error instanceof Error ? error.message : '保存失败'); } };
  const remove = async (item: BackendModelConfiguration) => { if (!window.confirm(`确定删除模型“${item.name}”吗？`)) return; try { await deleteModelConfiguration(item.id); setNotice('模型已删除'); await refresh(); } catch (error) { setNotice(error instanceof Error ? error.message : '删除失败'); } };
  const test = async (item: BackendModelConfiguration) => { try { const result = await testModelConfiguration(item.id); setNotice(result.message || '连接测试成功'); } catch (error) { setNotice(error instanceof Error ? error.message : '连接测试失败'); } };
  const toggleModel = async (item: BackendModelConfiguration) => {
    try { await saveModelConfiguration(item.id, { ...item, apiKey: '', isEnabled: !item.isEnabled }); setNotice(`模型已${item.isEnabled ? '停用' : '启用'}`); await refresh(); }
    catch (error) { setNotice(error instanceof Error ? error.message : '模型状态更新失败'); }
  };
  const openGrants = async (item: BackendModelConfiguration) => {
    setGrantError('');
    try {
      const [options, grants] = await Promise.all([getGrantOptions(), getModelGrants(item.id)]);
      setGrantOptions(options);
      setGrantSelection(grants);
      setGrantModel(item);
    } catch (error) { setNotice(error instanceof Error ? error.message : '用户授权加载失败'); }
  };
  const saveGrants = async () => {
    if (!grantModel) return;
    setGrantError('');
    setSavingGrants(true);
    try {
      await saveModelGrants(grantModel.id, grantSelection);
      setGrantModel(null);
      setNotice('模型使用权限已保存');
    } catch (error) { setGrantError(error instanceof Error ? error.message : '保存授权失败'); }
    finally { setSavingGrants(false); }
  };
  const openSearch = async () => {
    setGrantError('');
    try {
      const [options, settings] = await Promise.all([getGrantOptions(), getWebSearchSettings()]);
      setGrantOptions(options); setSearchSettings(settings); setGrantSelection(settings.grants);
      setSearchKey(''); setSearchDialog(true);
    } catch (error) { setNotice(error instanceof Error ? error.message : '搜索配置加载失败'); }
  };
  const saveSearch = async () => {
    if (!searchSettings) return;
    setSavingGrants(true); setGrantError('');
    try {
      await saveWebSearchSettings({ apiKey: searchKey, isEnabled: searchSettings.isEnabled, grants: grantSelection });
      setSearchDialog(false); setNotice('DeepSeek 搜索配置和授权已保存');
    } catch (error) { setGrantError(error instanceof Error ? error.message : '搜索配置保存失败'); }
    finally { setSavingGrants(false); }
  };
  const synchronizeLiteLlm = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!syncDialogOpen || syncing) return;
    setSyncing(true);
    setFormError('');
    try {
      const result = await syncLiteLlmModels();
      setSyncDialogOpen(false);
      setNotice(`LiteLLM 同步完成：发现 ${result.discovered}，新增 ${result.created}，更新 ${result.updated}，停用 ${result.disabled}`);
      await refresh();
    } catch (error) { setFormError(error instanceof Error ? error.message : 'LiteLLM 同步失败'); }
    finally { setSyncing(false); }
  };

  return <div className="admin-page model-management-page page-enter">
    <div className="page-title"><div><span className="section-kicker">MODEL PROVIDERS</span><h1>模型管理</h1><p>配置本地 Ollama、vLLM 与在线 OpenAI 兼容模型，Chat 会实时读取启用的配置。</p></div><div className="page-title-actions"><button className="secondary-action" type="button" onClick={() => void openSearch()}><Globe2 size={18} />DeepSeek 搜索</button><button className="secondary-action" type="button" onClick={() => { setFormError(''); setSyncDialogOpen(true); }}><RefreshCw size={18} />同步 LiteLLM</button><button className="primary-action" type="button" onClick={() => openEdit()}><Plus size={18} />新增模型</button></div></div>
    {notice && <div className="inline-notice" role="status"><CheckCircle2 size={16} />{notice}<button type="button" onClick={() => setNotice('')}>×</button></div>}
    {formError && <div className="model-form-error" role="alert">{formError}</div>}
    {loadError && <div className="model-form-error" role="alert">{loadError}</div>}
    <section className="admin-panel table-panel model-table-panel">
      <div className="toolbar model-toolbar"><label className="model-search-field"><span>搜索模型</span><span className="table-search"><Search size={18} /><input type="search" aria-label="搜索模型" placeholder="搜索名称、模型标识或地址" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} /></span></label><div className="toolbar-filters"><div className="model-filter-field"><span id="model-type-label">接入类型</span><ModernSelect compact ariaLabel="模型类型筛选" value={provider} options={['全部类型', 'LiteLLM', 'Online', 'Local'].map((value) => ({ value, label: value === 'Online' ? '在线模型' : value === 'Local' ? '本地模型' : value }))} onChange={(v) => { setProvider(v); setPage(1); }} /></div><div className="model-filter-field"><span>状态</span><ModernSelect compact ariaLabel="模型状态筛选" value={status} options={['全部状态', '已启用', '已停用'].map((value) => ({ value, label: value }))} onChange={(v) => { setStatus(v); setPage(1); }} /></div></div></div>
      <div className="table-meta"><span>共 {filtered.length} 个模型</span><span>API Key 仅在服务端加密保存</span></div>
      <div className="data-grid-wrap"><table className="data-grid model-registry-table"><thead><tr><th>模型</th><th>接入类型</th><th>倍率</th><th>核心能力</th><th>状态</th><th>操作</th></tr></thead><tbody>{visible.map((item) => <tr key={item.id}>
        <td><button type="button" className="model-name-button" title={item.name} onClick={() => setDetailModel(item)}>{item.name}</button><small className="model-identifier" title={item.modelIdentifier}>{item.modelIdentifier}</small></td>
        <td><span className={`model-type-badge ${item.providerKind.toLowerCase()}`}>{item.providerKind === 'Local' ? <Server size={13} /> : <Globe2 size={13} />}{item.providerKind === 'Local' ? '本地' : item.providerKind === 'LiteLLM' ? 'LiteLLM' : '在线'}</span></td>
        <td>{item.multiplier || '—'}</td>
        <td><ModelCapabilitySummary model={item} onDetails={() => setDetailModel(item)} /></td>
        <td><div className="model-state"><span className={`status-pill ${item.isEnabled ? 'is-enabled' : 'is-disabled'}`}><i />{item.isEnabled ? '已启用' : '已停用'}</span>{item.isDefault && <small>默认模型</small>}</div></td>
        <td><ModelRowActions model={item} onGrants={() => void openGrants(item)} onTest={() => void test(item)} onEdit={() => openEdit(item)} onToggle={() => void toggleModel(item)} onRemove={() => void remove(item)} /></td>
      </tr>)}</tbody></table>{loading ? <div className="empty-state" role="status">正在加载模型…</div> : !visible.length && !loadError && <div className="empty-state"><Server size={28} /><strong>{items.length ? '没有匹配的模型' : '尚未配置模型'}</strong><span>{items.length ? '请调整搜索内容或筛选条件。' : '新增后即可在 Chat 顶部切换模型。'}</span></div>}</div>
      <AntPagination onPageSizeChange={setPageSize} ariaLabel="模型列表分页" current={Math.min(page, pageCount)} total={filtered.length} pageSize={pageSize} onChange={setPage} />
    </section>
    {detailModel && <ModelDetails model={detailModel} onClose={() => setDetailModel(null)} onEdit={() => { setDetailModel(null); openEdit(detailModel); }} />}
    {grantModel && grantOptions && <Modal title={`授权使用 ${grantModel.name}`} onClose={() => setGrantModel(null)}><div className="entity-form model-grant-dialog distribution-form"><p>可按部门、角色或指定用户授权。未授权用户看不到模型，生成请求也会被服务端拒绝。</p>{grantError && <div className="model-form-error" role="alert">{grantError}</div>}<GrantSelector options={grantOptions} value={grantSelection} onChange={setGrantSelection} /><div className="modal-actions"><button className="secondary-action" type="button" disabled={savingGrants} onClick={() => setGrantModel(null)}>取消</button><button className="primary-action" type="button" disabled={savingGrants} onClick={() => void saveGrants()}>{savingGrants ? '保存中…' : '保存授权'}</button></div></div></Modal>}
    {searchDialog && searchSettings && grantOptions && <Modal title="DeepSeek 网页搜索" onClose={() => setSearchDialog(false)}><div className="entity-form model-grant-dialog distribution-form"><p>API Key 仅保存在 AIGC 服务端；DSH 使用登录令牌调用搜索接口。授权范围支持部门、角色和指定用户。</p>{grantError && <div className="model-form-error" role="alert">{grantError}</div>}<label>DeepSeek API Key <small className="model-api-key-note">{searchSettings.hasApiKey ? '已配置，留空则保留' : '尚未配置'}</small><input type="password" autoComplete="new-password" value={searchKey} onChange={(event) => setSearchKey(event.target.value)} placeholder={searchSettings.hasApiKey ? '••••••••' : '输入 API Key'} /></label><div className="model-grant-search-toggle"><ModelOptionToggle checked={searchSettings.isEnabled} icon={<Globe2 size={16} />} label="启用网页搜索" onChange={() => setSearchSettings({ ...searchSettings, isEnabled: !searchSettings.isEnabled })} /></div><GrantSelector options={grantOptions} value={grantSelection} onChange={setGrantSelection} /><div className="modal-actions"><button className="secondary-action" type="button" disabled={savingGrants} onClick={() => setSearchDialog(false)}>取消</button><button className="primary-action" type="button" disabled={savingGrants} onClick={() => void saveSearch()}>{savingGrants ? '保存中…' : '保存配置'}</button></div></div></Modal>}
    {syncDialogOpen && <Modal title="同步 LiteLLM 模型" onClose={() => { if (!syncing) setSyncDialogOpen(false); }}><form className="entity-form" onSubmit={synchronizeLiteLlm}><p>将使用 AIGC 后端配置的 LiteLLM 服务地址和密钥读取模型目录。新模型默认停用且不授权；目录中消失的模型会停用但不会删除。</p><div className="modal-actions"><button className="secondary-action" type="button" disabled={syncing} onClick={() => setSyncDialogOpen(false)}>取消</button><button className="primary-action" type="submit" disabled={syncing}>{syncing ? '同步中…' : '开始同步'}</button></div></form></Modal>}
    {editing && <Modal title={editing.id ? '编辑模型' : '新增模型'} onClose={() => setEditing(null)}><form className="entity-form model-form" onSubmit={save}><div className="form-grid"><label>显示名称 *<input required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="例如：本地 Qwen3" /></label><label>模型标识 *<input required value={editing.modelIdentifier} onChange={(e) => setEditing({ ...editing, modelIdentifier: e.target.value })} placeholder={editing.providerKind === 'LiteLLM' ? '例如：aigc-default' : '例如：qwen3:8b'} /></label><label>接入类型 *<ModernSelect ariaLabel="接入类型" value={editing.providerKind} options={[{ value: 'LiteLLM', label: 'LiteLLM 网关' }, { value: 'Online', label: '在线模型' }, { value: 'Local', label: '本地模型' }]} onChange={changeProvider} /></label><label>认证方式<ModernSelect ariaLabel="认证方式" value={editing.authType} options={[{ value: 'Bearer', label: 'Bearer Token' }, { value: 'Header', label: '自定义请求头' }, { value: 'None', label: '无需认证' }]} onChange={(v) => setEditing({ ...editing, authType: v })} /></label><label className="field-span-2">Base URL *<input required value={editing.baseUrl} onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })} placeholder={editing.providerKind === 'LiteLLM' ? 'http://localhost:4000/v1' : editing.providerKind === 'Local' ? 'http://localhost:11434' : 'https://api.example.com'} /></label><label>Endpoint Path<input value={editing.endpointPath} onChange={(e) => setEditing({ ...editing, endpointPath: e.target.value })} /></label><label>API Key Header<input value={editing.apiKeyHeader} onChange={(e) => setEditing({ ...editing, apiKeyHeader: e.target.value })} disabled={editing.authType !== 'Header'} /></label><label className="field-span-2">API Key{editing.id && <small className="model-api-key-note">留空则保留现有密钥</small>}<input type="password" autoComplete="new-password" value={editing.apiKey} onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })} placeholder={editing.id ? '••••••••' : editing.authType === 'None' ? '无需填写' : editing.providerKind === 'LiteLLM' ? '输入 LiteLLM Master Key 或 Virtual Key' : '输入模型服务密钥'} /></label><label>倍率文本<input maxLength={32} value={editing.multiplier} placeholder="例如：0.5×、2×" onChange={e => setEditing({ ...editing, multiplier: e.target.value })} /><small>显示于客户端模型选择，不修改计费规则</small></label><label>图片理解<ModernSelect ariaLabel="图片理解" value={editing.imageInputMode} options={[{ value: 'Auto', label: '自动识别' }, { value: 'Supported', label: '支持图片' }, { value: 'Unsupported', label: '不支持图片' }]} onChange={(v) => setEditing({ ...editing, imageInputMode: v })} /></label><label>Temperature<input type="number" min="0" max="2" step="0.1" value={editing.temperature} onChange={(e) => setEditing({ ...editing, temperature: e.target.value })} /></label><label>Max Tokens<input type="number" min="1" value={editing.maxTokens} onChange={(e) => setEditing({ ...editing, maxTokens: e.target.value })} placeholder="不限制" /></label></div><div className="model-form-toggles"><ModelOptionToggle checked={editing.supportsTools} icon={<Power size={16} />} label="支持工具调用" onChange={() => setEditing({ ...editing, supportsTools: !editing.supportsTools })} /><ModelOptionToggle checked={editing.isEnabled} icon={<Power size={16} />} label="启用此模型" onChange={() => setEditing({ ...editing, isEnabled: !editing.isEnabled })} /><ModelOptionToggle checked={editing.isDefault} icon={<CheckCircle2 size={16} />} label="设为默认模型" onChange={() => setEditing({ ...editing, isDefault: !editing.isDefault })} /></div><div className="modal-actions"><button className="secondary-action" type="button" onClick={() => setEditing(null)}>取消</button><button className="primary-action" type="submit">保存配置</button></div></form></Modal>}
  </div>;
}
