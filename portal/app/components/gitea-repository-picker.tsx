'use client';
import '../admin/processes/integrations/integrations.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../lib/api-client';
import { getGiteaServices, giteaPath, type CodeSelection, type GiteaCommit, type GiteaRepository } from '../lib/integrations';
import { ModernSelect } from './modern-select';

type Selection = { source: CodeSelection; repository: GiteaRepository; commit: GiteaCommit; branch: string };

// Query results carry their source key: a previous repository's result is never
// usable while the next repository is loading, without cascading reset effects.
function useRemote<T>(key: string, load: () => Promise<T>) {
  const [result, setResult] = useState<{ key: string; value?: T; error?: string }>();
  useEffect(() => {
    if (!key) return;
    let active = true;
    load().then(value => { if (active) setResult({ key, value }); })
      .catch(error => { if (active) setResult({ key, error: error instanceof Error ? error.message : '加载失败' }); });
    return () => { active = false; };
  }, [key, load]);
  return { value: key && result?.key === key ? result.value : undefined,
    error: key && result?.key === key ? result.error : undefined, loading: Boolean(key && result?.key !== key) };
}

async function allPages<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const rows = await apiRequest<T[] | null>(`${path}${path.includes('?') ? '&' : '?'}page=${page}`);
    if (!Array.isArray(rows)) return items;
    items.push(...rows);
    if (rows.length < 50) return items;
  }
}

export function GiteaRepositoryPicker({ onChange }: { onChange: (selection: Selection | null) => void }) {
  const callback = useRef(onChange);
  useEffect(() => { callback.current = onChange; }, [onChange]);
  const [chosenService, setService] = useState(''), [repoId, setRepoId] = useState('');
  const [chosenRef, setReference] = useState(''), [chosenSha, setSha] = useState('');
  const [search, setSearch] = useState(''), [revision, setRevision] = useState(0);
  const [connecting, setConnecting] = useState(false), [authError, setAuthError] = useState('');
  const popup = useRef<Window | null>(null), watch = useRef<number | null>(null);
  const services = useRemote('services', getGiteaServices);
  const service = chosenService || services.value?.[0]?.code || '';
  const loadConnection = useCallback(() => apiRequest<{ login: string } | null>(`${giteaPath(service)}/connection`), [service]);
  const connection = useRemote(service ? `${service}:${revision}` : '', loadConnection);
  const loadRepos = useCallback(() => allPages<GiteaRepository>(`${giteaPath(service)}/repositories`), [service]);
  const repositories = useRemote(connection.value?.login ? service : '', loadRepos);
  const repos = repositories.value ?? [];
  const repository = repos.find(r => String(r.id) === repoId);
  const base = `${giteaPath(service)}/repositories/${repoId}`;
  const loadRefs = useCallback(async () => {
    const [branches, tags] = await Promise.all([allPages<{ name: string }>(`${base}/branches`), allPages<{ name: string }>(`${base}/tags`)]);
    return { branches, tags };
  }, [base]);
  const refs = useRemote(repository ? base : '', loadRefs);
  const branches = refs.value?.branches ?? [], tags = refs.value?.tags ?? [];
  const reference = chosenRef || repository?.default_branch || branches[0]?.name || tags[0]?.name || '';
  const commitsPath = `${base}/commits?reference=${encodeURIComponent(reference)}`;
  const loadCommits = useCallback(async () => {
    const value = await apiRequest<GiteaCommit[] | null>(commitsPath);
    return Array.isArray(value) ? value : [];
  }, [commitsPath]);
  const commits = useRemote(repository && refs.value && (branches.length || tags.length) && reference ? commitsPath : '', loadCommits);
  const sha = chosenSha || commits.value?.[0]?.sha || '';
  const commit = commits.value?.find(c => c.sha === sha);
  const login = connection.value?.login ?? '';
  const busy = connecting || services.loading || connection.loading || repositories.loading || refs.loading || commits.loading;
  const error = authError || services.error || connection.error || repositories.error || refs.error || commits.error;
  const empty = repository && refs.value && (!branches.length && !tags.length || commits.value?.length === 0);
  useEffect(() => {
    callback.current(repository && commit ? { source: { serviceCode: service, repositoryId: repository.id, ref: reference, commitSha: commit.sha }, repository, commit, branch: reference } : null);
  }, [service, repository, reference, commit]);

  const stopWatch = () => { if (watch.current !== null) window.clearInterval(watch.current); watch.current = null; };
  const connect = async () => {
    setConnecting(true); setAuthError('');
    try {
      const result = await apiRequest<{ url: string }>(`${giteaPath(service)}/authorize`, { method: 'POST' });
      const windowRef = window.open(result.url, 'aigc-gitea-auth', 'width=520,height=720,popup=yes');
      if (!windowRef) throw new Error('浏览器阻止了授权窗口，请允许弹出窗口后重试。');
      popup.current = windowRef; windowRef.focus(); stopWatch();
      watch.current = window.setInterval(() => {
        if (windowRef.closed && popup.current === windowRef) { stopWatch(); popup.current = null; setConnecting(false); setAuthError('授权窗口已关闭，未完成授权。'); }
      }, 800);
    } catch (e) { setAuthError(e instanceof Error ? e.message : '授权失败'); setConnecting(false); }
  };
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== popup.current || !popup.current || event.data?.type !== 'aigc-gitea-auth') return;
      if (watch.current !== null) window.clearInterval(watch.current);
      watch.current = null; popup.current = null; setConnecting(false);
      if (!event.data.ok) { setAuthError(typeof event.data.reason === 'string' ? event.data.reason : 'Gitea 授权未完成，请重试。'); return; }
      setAuthError(''); setRevision(value => value + 1);
    };
    window.addEventListener('message', receive);
    return () => { window.removeEventListener('message', receive); if (watch.current !== null) window.clearInterval(watch.current); popup.current?.close(); popup.current = null; };
  }, [service]);
  return <div className="form-span integration-fields">
    <div className="form-field"><span>代码平台</span><ModernSelect ariaLabel="代码平台" value={service} options={(services.value ?? []).map(s => ({ value: s.code, label: s.name }))} disabled={connecting} onChange={value => { callback.current(null); setService(value); setRepoId(''); setReference(''); setSha(''); setAuthError(''); }} /></div>
    {!services.loading && !services.value?.length && <p className="integration-note">管理员尚未启用 Gitea 服务，可继续使用现有仓库填写方式。</p>}
    {service && <div><span>{login ? `已连接：${login}` : '请连接您的 Gitea 账号以读取授权仓库'}</span> <button type="button" className="secondary-action" disabled={busy} onClick={connect}>{login ? '重新授权' : '连接 Gitea'}</button></div>}
    {login && <>
      <label><span>搜索仓库</span><input value={search} onChange={e => setSearch(e.target.value)} /></label>
      <div className="form-field"><span>选择仓库</span><ModernSelect ariaLabel="选择仓库" value={repoId} disabled={busy} options={repos.filter(r => r.full_name.toLowerCase().includes(search.toLowerCase())).map(r => ({ value: String(r.id), label: r.full_name }))} onChange={value => { callback.current(null); setRepoId(value); setReference(''); setSha(''); }} /></div>
      {repository && <div className="form-field"><span>分支或标签</span><ModernSelect ariaLabel="分支或标签" value={reference} disabled={busy} options={[...branches.map(b => ({ value: b.name, label: `分支：${b.name}` })), ...tags.filter(t => !branches.some(b => b.name === t.name)).map(t => ({ value: t.name, label: `标签：${t.name}` }))]} onChange={value => { callback.current(null); setReference(value); setSha(''); }} /></div>}
      {reference && <div className="form-field"><span>固定提交（最近 50 条）</span><ModernSelect ariaLabel="固定提交" value={sha} disabled={busy} options={(commits.value ?? []).map(c => ({ value: c.sha, label: `${c.sha.slice(0, 10)} · ${c.commit.message.split('\n')[0]}`, description: `${c.commit.author.name} · ${c.commit.author.date}` }))} onChange={setSha} /></div>}
    </>}
    {busy && <p className="integration-note" role="status">正在加载代码平台信息…</p>}
    {empty && <p className="integration-note is-hint" role="status">此仓库还没有提交，请先推送代码后再创建申请。</p>}
    {error && <p className="model-form-error" role="alert">{error}</p>}
  </div>;
}
