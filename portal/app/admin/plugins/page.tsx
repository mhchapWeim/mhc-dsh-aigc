'use client';

import { useEffect, useRef, useState } from 'react';
import { Boxes, RefreshCw, Upload } from 'lucide-react';
import { AntPagination } from '../../components/ant-pagination';
import { Modal } from '../../components/modal';
import { GrantSelector } from '../models/grant-selector';
import type { GrantOptions } from '../../lib/api-client';
import { getPlugins, getPluginGrantOptions, publishPlugin, uploadPlugin, type ManagedPlugin } from '../../lib/plugin-api';
import './plugins.css';

const pageSize = 10;

export default function PluginsPage() {
  const [plugins, setPlugins] = useState<ManagedPlugin[]>([]);
  const [page, setPage] = useState(1);
  const [options, setOptions] = useState<GrantOptions | null>(null);
  const [editing, setEditing] = useState<ManagedPlugin | null>(null);
  const [configuration, setConfiguration] = useState('{}');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  const refresh = async () => {
    const [items, grants] = await Promise.all([getPlugins(), getPluginGrantOptions()]);
    setPlugins(items); setOptions(grants);
  };
  useEffect(() => { void refresh().catch(e => setError(String(e.message ?? e))).finally(() => setLoading(false)); }, []);
  const act = async (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const open = (plugin: ManagedPlugin) => {
    setEditing(structuredClone(plugin)); setConfiguration(JSON.stringify(plugin.configuration, null, 2)); setSecret(''); setError('');
  };
  const save = () => act(async () => {
    if (!editing) return;
    const value: unknown = JSON.parse(configuration);
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some(x => !x || typeof x !== 'object' || Array.isArray(x)))
      throw new Error('配置须为插件行 ID 到配置对象的 JSON 映射');
    await publishPlugin({ ...editing, configuration: value as ManagedPlugin['configuration'] }, secret);
    setEditing(null); setSecret(''); await refresh(); setNotice('策略已发布；客户端将在同步后回报实际生效状态。');
  });
  const currentPage = Math.min(page, Math.max(1, Math.ceil(plugins.length / pageSize)));
  const visiblePlugins = plugins.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  return <div className="plugin-market">
    <div className="page-title"><div><span className="section-kicker">DSH PLUGINS</span><h1>插件管理</h1><p>管理插件包、版本、配置与使用授权。</p></div>
      <div className="page-title-actions"><button className="secondary-action" disabled={busy} onClick={() => void act(refresh)}><RefreshCw size={16} />刷新</button>
        <button className="primary-action" disabled={busy} onClick={() => upload.current?.click()}><Upload size={16} />上传插件包</button></div></div>
    <input ref={upload} hidden type="file" accept=".tgz,.tar.gz" aria-label="上传插件包" onChange={event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (file) void act(async () => { await uploadPlugin(file); await refresh(); setNotice('版本已上传，请配置授权并发布。'); });
    }} />
    {error && <div role="alert" className="model-form-error">{error}</div>}
    {notice && <p role="status" className="plugin-notice">{notice}</p>}
    {loading ? <p role="status">正在读取插件…</p> : plugins.length === 0 ? <div className="plugin-empty"><Boxes size={32} /><h2>发布第一个 DSH 插件</h2><p>上传已构建的标准 bundle 包（.tgz），配置使用范围后发布。</p></div> :
      <div className="plugin-list">{visiblePlugins.map(plugin => {
        const version = plugin.versions.find(v => v.id === plugin.publishedVersionId);
        return <article className="plugin-item" key={plugin.id}><div><h2>{plugin.name}</h2><code>{plugin.packageName}</code><p>{plugin.description}</p>
          <div className="plugin-meta"><span>{plugin.isEnabled ? '已启用' : '已停用'}</span><span>{version ? `发布版本 ${version.version}` : '尚未发布'}</span><span>{plugin.versions.length} 个版本</span></div></div>
          <button className="secondary-action" onClick={() => open(plugin)}>配置与发布</button></article>;
      })}</div>}
    {!loading && plugins.length > 0 && <AntPagination ariaLabel="插件管理分页" current={currentPage} total={plugins.length} pageSize={pageSize} onChange={setPage} />}
    {editing && options && <Modal title="配置与发布插件" onClose={() => { if (!busy) { setEditing(null); setSecret(''); } }}><div className="entity-form plugin-form">
      <div className="plugin-form-scroll">
      {error && <p role="alert" className="model-form-error">{error}</p>}
      <label>名称<input value={editing.name} maxLength={120} onChange={e => setEditing({ ...editing, name: e.target.value })} /></label>
      <label>发布版本<select value={editing.publishedVersionId ?? ''} onChange={e => setEditing({ ...editing, publishedVersionId: e.target.value || null })}><option value="">请选择版本</option>{editing.versions.map(v => <option key={v.id} value={v.id}>{v.version} · DSH {v.dshVersion}</option>)}</select></label>
      <label className="plugin-enabled"><input type="checkbox" checked={editing.isEnabled} onChange={e => setEditing({ ...editing, isEnabled: e.target.checked })} />启用插件</label>
      <label>插件配置（JSON）<textarea rows={7} spellCheck={false} value={configuration} onChange={e => setConfiguration(e.target.value)} /></label>
      <small>格式：{`{"插件行 ID": {"参数名": "值"}}`}。密钥请使用下方服务端字段。</small>
      {editing.packageName === '@bhss/dsh-plugin-managed-search' && <label>博查 API Key（仅服务端保存）<input type="password" autoComplete="new-password" value={secret} onChange={e => setSecret(e.target.value)} placeholder={editing.hasServerSecret ? '已配置，留空保留' : '请输入博查 API Key'} /></label>}
      <h3>使用范围</h3><GrantSelector options={options} value={editing.grants} onChange={grants => setEditing({ ...editing, grants })} />
      <p>保存后下发策略。已有插件代码升级需要客户端重启。</p>
      </div>
      <div className="modal-actions"><button className="secondary-action" disabled={busy} onClick={() => setEditing(null)}>取消</button><button className="primary-action" disabled={busy} onClick={() => void save()}>{busy ? '发布中…' : '保存并发布'}</button></div>
    </div></Modal>}
  </div>;
}
