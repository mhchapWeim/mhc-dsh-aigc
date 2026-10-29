'use client';
import { useEffect, useState } from 'react';
import { Network, Plus, RefreshCw } from 'lucide-react';
import { Modal } from '../../components/modal';
import { AntPagination } from '../../components/ant-pagination';
import { usePageSize } from '../../components/use-page-size';
import { GrantSelector } from '../models/grant-selector';
import type { GrantOptions } from '../../lib/api-client';
import { getMcpServices, getMcpGrantOptions, saveMcp, uploadMcpIcon, testMcp, type McpService } from '../../lib/mcp-api';
import './mcp.css';

const empty = (): McpService => ({id: '', name: '', description: '', url: '', isEnabled: false, timeoutSeconds: 60, revision: 0,
  iconDataUrl: '', hasServerSecret: false, authenticationMode: 'GatewayBearer', tokenExchangeUrl: '',
  assertionAudience: '', tokenResource: '', tokenScopes: '', grants: {userIds: [], roleIds: [], departmentIds: []}});

/** Validate the remote address the same way the API does, so the form never saves into a rejection.
 *  Returns an error message, or null when the address is acceptable. */
function urlProblem(value: string, mode: McpService['authenticationMode']): string | null {
  const url = value.trim();
  if (!url) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'MCP 地址需为完整网址，例如 https://service.example.com/mcp'; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'MCP 地址仅支持 http 或 https';
  if (parsed.username || parsed.password) return 'MCP 地址不能包含用户名或密码，请改用 Bearer Token';
  // Assertion-exchange services are dialed directly by DSH, which only trusts HTTPS (loopback excepted).
  if (mode === 'UserAssertionExchange' && parsed.protocol !== 'https:'
    && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
    return '员工身份断言模式要求 HTTPS 的 MCP 地址（本机调试可用 http://localhost）';
  return null;
}
export default function McpPage() {
  const [items, setItems] = useState<McpService[]>([]);
  const [options, setOptions] = useState<GrantOptions | null>(null);
  const [editing, setEditing] = useState<McpService | null>(null);
  const [icon, setIcon] = useState<File | null>(null);
  const [secret, setSecret] = useState(''); const [clearSecret, setClearSecret] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(''); const [page, setPage] = useState(1); const [pageSize, setPageSize] = usePageSize();
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof testMcp>> | null>(null);
  const refresh = async () => { const [rows, grants] = await Promise.all([getMcpServices(), getMcpGrantOptions()]); setItems(rows); setOptions(grants); };
  useEffect(() => { void refresh().catch(e => {setError(String(e.message ?? e)); setItems([]);}).finally(() => setLoading(false)); }, []);
  const act = async (action: () => Promise<void>) => { setBusy(true); setError(''); setNotice('');
    try { await action(); } catch(e) {setError(e instanceof Error ? e.message : String(e));} finally {setBusy(false);} };
  const open = (item: McpService) => {setEditing(structuredClone(item)); setIcon(null); setSecret(''); setClearSecret(false); setError('');};
  // Explain why the primary action is unavailable instead of leaving a greyed-out button.
  const urlError = editing ? urlProblem(editing.url, editing.authenticationMode) : null;
  const missing = editing ? [
    !editing.name.trim() ? '名称' : null,
    !editing.url.trim() ? 'MCP 地址' : null,
    editing.authenticationMode === 'UserAssertionExchange' && !editing.tokenExchangeUrl.trim() ? 'Token Exchange 地址' : null,
    editing.authenticationMode === 'UserAssertionExchange' && !editing.assertionAudience.trim() ? '断言接收方' : null,
    editing.authenticationMode === 'UserAssertionExchange' && !editing.tokenResource.trim() ? '资源标识' : null,
  ].filter(Boolean).join('、') : '';
  const saveDisabled = busy || Boolean(missing) || Boolean(urlError);
  const save = () => act(async () => {
    if (!editing) return;
    const result = await saveMcp(editing, secret, clearSecret);
    // Keep the newly created ID if a subsequent icon upload fails, so retry cannot create duplicate services.
    setEditing({...editing, id: result.id});
    if (icon) await uploadMcpIcon(result.id, icon);
    setEditing(null); setSecret(''); await refresh(); setNotice('已保存。获授权用户将在客户端同步后自动使用。');
  });
  const filtered = items.filter(x => `${x.name} ${x.description}`.toLowerCase().includes(search.toLowerCase()));
  const current = Math.min(page, Math.max(1, Math.ceil(filtered.length/pageSize)));
  return <div className="admin-page page-enter mcp-market">
    <div className="page-title"><div><span className="section-kicker">MCP</span><h1>MCP 市场</h1><p>统一配置服务与使用授权，客户端自动接入。</p></div>
      <div className="page-title-actions"><button type="button" className="secondary-action" disabled={busy} onClick={() => void act(refresh)}><RefreshCw size={16}/>刷新</button>
      <button type="button" className="primary-action" disabled={busy} onClick={() => open(empty())}><Plus size={16}/>添加 MCP</button></div></div>
    {error && <p className="model-form-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="admin-panel mcp-filter"><label>搜索 MCP<input value={search} placeholder="名称或简介" onChange={e => {setSearch(e.target.value); setPage(1);}} /></label></div>
    <div className="admin-panel table-panel"><div className="table-meta">共 {filtered.length} 个服务</div><div className="mcp-table-scroll">
    <table className="data-grid"><thead><tr><th>服务</th><th>状态</th><th>授权范围</th><th>操作</th></tr></thead><tbody>
      {filtered.slice((current-1)*pageSize,current*pageSize).map(item => <tr key={item.id}><td><div className="mcp-name">{item.iconDataUrl ? <img src={item.iconDataUrl} alt=""/> : <Network aria-hidden size={36}/>}<div><strong>{item.name}</strong><p>{item.description || '暂无简介'}</p></div></div></td>
      <td>{item.isEnabled ? '已发布' : '已停用'}</td><td>{item.grants.userIds.length} 用户 · {item.grants.roleIds.length} 角色 · {item.grants.departmentIds.length} 部门</td>
      <td><div className="mcp-actions"><button type="button" className="secondary-action" disabled={busy} onClick={() => open(item)}>配置与授权</button>
      {item.authenticationMode === 'UserAssertionExchange'
        ? <button type="button" className="secondary-action" disabled={busy} onClick={() => setNotice('员工身份断言服务需由获授权员工在 DSH 客户端实际登录后自动验证；此处的快捷测试仅适用于中台网关模式。')}>测试连接</button>
        : <button type="button" className="secondary-action" disabled={busy} onClick={() => void act(async () => {setPreview(await testMcp(item.id));})}>测试连接</button>}</div></td></tr>)}
    </tbody></table></div>
    {loading ? <p className="empty-state" role="status">正在加载…</p> : filtered.length === 0 && <p className="empty-state">暂无 MCP 服务</p>}
    <AntPagination ariaLabel="MCP 分页" current={current} total={filtered.length} pageSize={pageSize} onChange={setPage} onPageSizeChange={setPageSize}/></div>
    {editing && options && <Modal title={editing.id ? '配置 MCP 与授权' : '添加 MCP'} className="mcp-modal" onClose={() => {if (!busy) setEditing(null);}}>
      <div className="entity-form mcp-form"><div className="mcp-form-body" tabIndex={0} aria-label="MCP 配置正文">
      {error && <p role="alert" className="model-form-error">{error}</p>}
      <label>名称<input maxLength={120} value={editing.name} onChange={e => setEditing({...editing,name:e.target.value})}/></label>
      <label>简介<textarea maxLength={2000} rows={3} value={editing.description} onChange={e => setEditing({...editing,description:e.target.value})}/></label>
      <label>图标（PNG / JPEG / WebP，最大 500 KB）<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => {const file=e.target.files?.[0]; if(file && file.size>512000) {setError('图标不能超过 500 KB'); return;} setIcon(file ?? null);}}/></label>
      {editing.iconDataUrl && <img className="mcp-icon-preview" src={editing.iconDataUrl} alt="当前图标"/>}
      <label>MCP 地址<input type="text" inputMode="url" spellCheck={false} value={editing.url} placeholder="https://service.example.com/mcp" onChange={e => setEditing({...editing,url:e.target.value})}/></label>
      {urlError && <p className="model-form-error mcp-url-error">{urlError}</p>}
      <label>认证方式<select value={editing.authenticationMode} onChange={e=>setEditing({...editing,authenticationMode:e.target.value as McpService['authenticationMode']})}>
        <option value="GatewayBearer">中台网关 / 固定 Bearer Token</option><option value="UserAssertionExchange">员工身份断言 / 无感 Token Exchange</option>
      </select></label>
      {editing.authenticationMode === 'GatewayBearer' ? <>
        <p>地址和服务密钥仅保留在中台，由 AIGC 网关代为调用。</p>
        <label>Bearer Token<input type="password" autoComplete="new-password" value={secret} placeholder={editing.hasServerSecret ? '已配置，留空保留' : '无认证时留空'} onChange={e => setSecret(e.target.value)}/></label>
        {editing.hasServerSecret && <label className="mcp-check"><input type="checkbox" checked={clearSecret} onChange={e=>setClearSecret(e.target.checked)}/>清除原有密钥</label>}
      </> : <>
        <p>DSH 自动申请 AIGC 短期员工断言，向目标服务兑换个人 MCP Token；无需浏览器再次登录。</p>
        <label>Token Exchange 地址<input type="text" inputMode="url" spellCheck={false} value={editing.tokenExchangeUrl} placeholder="https://service.example.com/oauth2/dsh-token" onChange={e=>setEditing({...editing,tokenExchangeUrl:e.target.value})}/></label>
        <label>断言接收方（aud）<input value={editing.assertionAudience} placeholder="knowengine-mcp" onChange={e=>setEditing({...editing,assertionAudience:e.target.value})}/></label>
        <label>资源标识（resource）<input value={editing.tokenResource} placeholder="https://service.example.com/mcp" onChange={e=>setEditing({...editing,tokenResource:e.target.value})}/></label>
        <label>Scope（空格分隔）<input value={editing.tokenScopes} placeholder="kb:read document:read retrieval:read knowledge:ask" onChange={e=>setEditing({...editing,tokenScopes:e.target.value})}/></label>
      </>}
      <label>调用超时（秒）<input type="number" min={5} max={300} value={editing.timeoutSeconds} onChange={e=>setEditing({...editing,timeoutSeconds:Number(e.target.value)})}/></label>
      <label className="mcp-check"><input type="checkbox" checked={editing.isEnabled} onChange={e=>setEditing({...editing,isEnabled:e.target.checked})}/>发布服务</label>
      <h3>使用授权</h3><p>用户、角色、部门任一命中即可使用。未选择授权对象时无人可用。</p>
      <GrantSelector options={options} value={editing.grants} onChange={grants=>setEditing({...editing,grants})}/>
      </div><div className="modal-actions">
        {missing && <p className="mcp-action-hint" role="status">请填写{missing}后再保存</p>}
        <button type="button" className="secondary-action" disabled={busy} onClick={()=>setEditing(null)}>取消</button><button type="button" className="primary-action" disabled={saveDisabled} onClick={()=>void save()}>{busy?'保存中…':'保存配置与授权'}</button></div></div>
    </Modal>}
    {preview && <Modal title="MCP 工具发现结果" className="mcp-modal" onClose={()=>setPreview(null)}><div className="mcp-form-body" tabIndex={0} aria-label="工具清单"><p>已发现 {preview.tools.length} 个工具{preview.hasMore ? '，服务还有更多工具' : ''}。未执行业务操作。</p>{preview.tools.map(tool=><article key={tool.name}><h3>{tool.name}</h3><p>{tool.description}</p><pre>{JSON.stringify(tool.inputSchema,null,2)}</pre></article>)}</div></Modal>}
  </div>;
}
