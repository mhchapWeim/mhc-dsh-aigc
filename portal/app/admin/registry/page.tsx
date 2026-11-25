'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { Modal } from '../../components/modal';
import { AntPagination } from '../../components/ant-pagination';
import { ModernSelect } from '../../components/modern-select';
import { ModernMultiSelect } from '../../components/modern-multi-select';
import { usePageSize } from '../../components/use-page-size';
import { TokenAmountInput } from '../billing/token-amount-input';
import { getPublishedApps, getRegistryApps, getRegistryOptions, saveRegistryApp, setPublishedAccessReviewer, setPublishedOperational, translateRegistryText, type ClickUpdate, type PublishedApp, type RegistryApp, type RegistryInput, type RegistryOptions } from '../../lib/application-registry';
import './registry.css';

const empty = (): RegistryInput => ({ name: '', nameEn: '', description: '', descriptionEn: '', owner: '', ownerEn: '', categoryId: '', categoryEn: '', accessUrl: '', isEnabled: true, sortOrder: 0, accessMode: 'Subjects', grants: [], accessReviewerId: null });
type TextKey = 'name' | 'nameEn' | 'description' | 'descriptionEn' | 'owner' | 'ownerEn' | 'categoryEn' | 'accessUrl';

export default function ApplicationRegistryPage() {
  const [items, setItems] = useState<RegistryApp[]>([]);
  const [options, setOptions] = useState<RegistryOptions>({categories: [], departments: [], users: []});
  const [form, setForm] = useState<RegistryInput | null>(null);
  const [editing, setEditing] = useState<string>();
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [translating, setTranslating] = useState(0);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<'registered' | 'published'>('registered');
  const [published, setPublished] = useState<PublishedApp[]>([]);
  const [publishedLoading, setPublishedLoading] = useState(false);
  const [publishedError, setPublishedError] = useState('');
  const [publishedNotice, setPublishedNotice] = useState('');
  const [publishedSearch, setPublishedSearch] = useState('');
  const [publishedPage, setPublishedPage] = useState(1);
  const [pending, setPending] = useState<PublishedApp | null>(null);
  const [reviewerApp, setReviewerApp] = useState<PublishedApp | null>(null);
  const [reviewerId, setReviewerId] = useState('');
  const [operating, setOperating] = useState(false);
  const [operationError, setOperationError] = useState('');
  const tableRef = useRef<HTMLDivElement>(null);
  const publishedTableRef = useRef<HTMLDivElement>(null);
  const [pageSize, setPageSize] = usePageSize(tableRef, tab === 'registered' && !loading);
  const [publishedPageSize, setPublishedPageSize] = usePageSize(publishedTableRef, tab === 'published' && !publishedLoading);
  const session = useRef(0);
  const editedEnglish = useRef(new Set<TextKey>());
  const translationVersions = useRef<Record<string, number>>({});
  const attemptedTranslations = useRef<Record<string, string>>({});
  const load = async () => {
    setLoading(true); setError('');
    try { const [rows, choices] = await Promise.all([getRegistryApps(), getRegistryOptions()]); setItems(rows); setOptions(choices); }
    catch (e) { setError(e instanceof Error ? e.message : '注册应用加载失败'); setItems([]); }
    finally { setLoading(false); }
  };
  const loadPublished = async () => {
    setPublishedLoading(true); setPublishedError('');
    try { setPublished(await getPublishedApps()); }
    catch (e) { setPublishedError(e instanceof Error ? e.message : '流程发布应用加载失败'); setPublished([]); }
    finally { setPublishedLoading(false); }
  };
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, []);
  useEffect(() => { if (tab !== 'published') return; const timer = window.setTimeout(() => { void loadPublished(); }, 0); return () => window.clearTimeout(timer); }, [tab]);
  const open = (item?: RegistryApp) => {
    session.current++; editedEnglish.current.clear(); attemptedTranslations.current = {}; setTranslating(0); setFormError('');
    if (item) (['nameEn', 'descriptionEn', 'ownerEn', 'categoryEn'] as TextKey[]).forEach(key => { if (item[key]) editedEnglish.current.add(key); });
    setEditing(item?.id); setForm(item ? {...item, grants: [...item.grants]} : {...empty(), categoryId: options.categories[0]?.id || ''});
  };
  const close = () => { session.current++; setForm(null); };
  const translate = async (source: TextKey, target: TextKey, force = false) => {
    if (!form || !form[source].trim() || (!force && editedEnglish.current.has(target))) return;
    if (!force && attemptedTranslations.current[target] === form[source]) return;
    attemptedTranslations.current[target] = form[source];
    const currentSession = session.current, text = form[source], previous = form[target];
    const version = (translationVersions.current[target] || 0) + 1; translationVersions.current[target] = version;
    setTranslating(count => count + 1);
    try {
      const result = await translateRegistryText(text);
      if (currentSession === session.current && translationVersions.current[target] === version)
        setForm(current => current && current[source] === text && current[target] === previous ? {...current, [target]: result.text} : current);
    } catch (e) { if (currentSession === session.current) setFormError(e instanceof Error ? e.message : '自动翻译失败，请手动填写英文'); }
    finally { if (currentSession === session.current) setTranslating(count => Math.max(0, count - 1)); }
  };
  const field = (key: TextKey, label: string, required = false, target?: TextKey, multiline = false) => {
    if (!form) return null;
    const props = { 'aria-label': label, value: form[key], required, maxLength: key.startsWith('description') ? 4000 : key === 'accessUrl' ? 2000 : key === 'name' ? 150 : 200,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (key.endsWith('En')) editedEnglish.current.add(key);
        setForm(current => current && ({...current, [key]: event.target.value}));
      }, onBlur: () => { if (target) void translate(key, target); } };
    return <label className={multiline ? 'form-span' : undefined}><span>{label}{required ? ' *' : ''}</span>
      {multiline ? <textarea {...props} rows={3}/> : <input {...props} type={key === 'accessUrl' ? 'url' : 'text'}/>}
      {target && <small>输入中文后离开输入框自动填充英文，可手动修改。<button className="registry-translate" type="button" disabled={translating > 0 || !form[key]} onClick={() => void translate(key, target, true)}>重新翻译</button></small>}
    </label>;
  };
  const confirmOperational = async () => {
    if (!pending || operating) return;
    const enabled = !pending.operationalEnabled;
    setOperating(true); setOperationError('');
    try {
      await setPublishedOperational(pending.id, enabled);
      setPending(null); setPublishedNotice(enabled ? '应用已恢复，原有授权可以继续使用' : '应用已停用，门户目录和网关访问已关闭');
      await loadPublished();
    } catch (e) { setOperationError(e instanceof Error ? e.message : '操作失败'); }
    finally { setOperating(false); }
  };
  const routeLabel = (status: string | null) => status === 'Ready' ? '就绪' : status === 'Unavailable' ? '未就绪' : status === 'Retired' ? '已退出' : status ? status : '未登记';
  const reviewerLabel = (name?: string, employeeNo?: string) => name ? `${name}${employeeNo ? `（${employeeNo}）` : ''}` : '未指定';
  const saveReviewer = async () => {
    if (!reviewerApp || operating) return;
    setOperating(true); setOperationError('');
    try {
      await setPublishedAccessReviewer(reviewerApp.id, reviewerId || null);
      setReviewerApp(null); setPublishedNotice('访问审核负责人已保存');
      await loadPublished();
    } catch (e) { setOperationError(e instanceof Error ? e.message : '保存审核负责人失败'); }
    finally { setOperating(false); }
  };
  const filtered = items.filter(x => `${x.name} ${x.nameEn} ${x.owner}`.toLowerCase().includes(search.toLowerCase()));
  const publishedFiltered = published.filter(x => `${x.name} ${x.version} ${x.applicantName} ${x.applicantEmployeeNo}`.toLowerCase().includes(publishedSearch.toLowerCase()));
  const publishedCurrentPage = Math.min(publishedPage, Math.max(1, Math.ceil(publishedFiltered.length / publishedPageSize) || 1));
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (!form || saving) return;
    setSaving(true); setFormError('');
    try {
      const original = items.find(x => x.id === editing);
      // Only send what the editor actually changed, so an untouched save never rewrites an
      // adjustment row another administrator just set. The lifetime total rides inside the
      // same `clicks` payload as `total` — that is the only object the save endpoint reads.
      const changed: ClickUpdate = {};
      for (const period of ['day', 'week', 'month', 'year'] as const) {
        const value = form.clicks?.[period];
        if (value !== undefined && value !== original?.clicks?.[period]) changed[period] = value;
      }
      if (form.totalClicks !== undefined && form.totalClicks !== original?.totalClicks) changed.total = form.totalClicks;
      const { clicks: _clicks, totalClicks: _total, ...fields } = form;
      const payload: Omit<RegistryInput, 'clicks' | 'totalClicks'> & { clicks?: ClickUpdate } = { ...fields, accessReviewerId: form.accessReviewerId || null };
      if (Object.keys(changed).length > 0) payload.clicks = changed;
      await saveRegistryApp(payload, editing);
      close(); setNotice('应用已保存，启用的应用将展示在门户应用集合中'); await load();
    }
    catch (e) { setFormError(e instanceof Error ? e.message : '保存失败'); }
    finally { setSaving(false); }
  };
  return <div className="admin-page page-enter admin-stack">
    <div className="page-title"><div><h1>应用管理</h1><p>管理直接注册的门户应用，以及流程发布完成后的应用启停。申请和审批仍在申请管理、发布审核中处理。</p></div>{tab === 'registered' && <button className="primary-action" type="button" disabled={loading || Boolean(error)} onClick={() => open()}><Plus size={17}/>注册应用</button>}</div>
    <div className="registry-tabs" role="tablist" aria-label="应用管理分类">
      <button type="button" role="tab" aria-selected={tab === 'registered'} onClick={() => setTab('registered')}>注册应用</button>
      <button type="button" role="tab" aria-selected={tab === 'published'} onClick={() => setTab('published')}>流程发布应用</button>
    </div>
    {tab === 'registered' && <section className="admin-panel registry-filters"><label><span>搜索应用</span><input type="search" aria-label="搜索注册应用" placeholder="名称或负责人" value={search} onChange={e => {setSearch(e.target.value); setPage(1);}}/></label><button className="secondary-action" type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={16}/>刷新</button></section>}
    {tab === 'registered' && <section className="admin-panel table-panel"><div className="table-meta">共 {filtered.length} 个应用 · 所有人可见，进入时校验授权</div>
      {loading ? <div className="empty-state" role="status">正在加载注册应用…</div> : error ? <div className="model-form-error" role="alert">{error}</div> : <>
        <div ref={tableRef} className="registry-table-scroll"><table className="data-grid" aria-label="注册应用列表"><thead><tr><th>应用名称</th><th>分类</th><th>负责人</th><th>访问范围</th><th>状态</th><th>排序</th><th>操作</th></tr></thead><tbody>{filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize).map(item => <tr key={item.id}><td><strong>{item.name}</strong><small className="registry-secondary">{item.nameEn}</small></td><td>{item.category}</td><td>{item.owner || '—'}</td><td>{item.accessMode === 'All' ? '所有已登录用户' : `${item.grants.filter(x => x.subjectType === 'Department').length} 个部门 / ${item.grants.filter(x => x.subjectType === 'User').length} 位个人`}</td><td>{item.isEnabled ? '已启用' : '已停用'}</td><td>{item.sortOrder}</td><td><button className="secondary-action" aria-label={`编辑${item.name}`} onClick={() => open(item)}>编辑 / 授权</button></td></tr>)}</tbody></table></div>
        {!filtered.length && <div className="empty-state">暂无匹配的注册应用</div>}
      </>}
      <AntPagination ariaLabel="注册应用分页" current={currentPage} total={filtered.length} pageSize={pageSize} onChange={setPage} onPageSizeChange={setPageSize}/>
    </section>}
    {tab === 'published' && <>
      <section className="admin-panel registry-filters"><label><span>搜索应用</span><input type="search" aria-label="搜索流程发布应用" placeholder="名称、版本或申请人" value={publishedSearch} onChange={e => {setPublishedSearch(e.target.value); setPublishedPage(1);}}/></label><button className="secondary-action" type="button" onClick={() => void loadPublished()} disabled={publishedLoading || operating}><RefreshCw size={16}/>刷新</button></section>
      <section className="admin-panel table-panel"><div className="table-meta">共 {publishedError ? 0 : publishedFiltered.length} 个已发布应用 · 含已停用 · 按更新时间排序</div>
        {publishedLoading ? <div className="empty-state" role="status">正在加载流程发布应用…</div> : publishedError ? <div className="model-form-error" role="alert">{publishedError}</div> : <>
          <div ref={publishedTableRef} className="registry-table-scroll"><table className="data-grid" aria-label="流程发布应用列表"><thead><tr><th>应用名称</th><th>发布版本</th><th>申请人</th><th>访问审核负责人</th><th>网关路由状态</th><th>应用状态</th><th>操作</th></tr></thead><tbody>{publishedFiltered.slice((publishedCurrentPage - 1) * publishedPageSize, publishedCurrentPage * publishedPageSize).map(item => <tr key={item.id}><td><strong>{item.name}</strong></td><td>{item.version || '—'}</td><td>{item.applicantName || '—'}<small className="registry-secondary">{item.applicantEmployeeNo}</small></td><td>{reviewerLabel(item.accessReviewerName, item.accessReviewerEmployeeNo)}</td><td>{routeLabel(item.routeStatus)}</td><td>{item.operationalEnabled ? '已启用' : '已停用'}</td><td><button className="secondary-action" type="button" aria-label={`设置${item.name}审核负责人`} disabled={operating} onClick={() => { setOperationError(''); setReviewerId(item.accessReviewerId || ''); setReviewerApp(item); }}>审核负责人</button><button className="secondary-action" type="button" aria-label={`${item.operationalEnabled ? '停用' : '恢复'}${item.name}`} disabled={operating} onClick={() => { setOperationError(''); setPending(item); }}>{item.operationalEnabled ? '停用' : '恢复'}</button></td></tr>)}</tbody></table></div>
          {!publishedFiltered.length && <div className="empty-state">暂无匹配的流程发布应用</div>}
        </>}
        <AntPagination ariaLabel="流程发布应用分页" current={publishedCurrentPage} total={publishedError ? 0 : publishedFiltered.length} pageSize={publishedPageSize} onChange={setPublishedPage} onPageSizeChange={setPublishedPageSize}/>
      </section>
      {publishedNotice && <div className="inline-toast" role="status">{publishedNotice}</div>}
    </>}
    {tab === 'registered' && notice && <div className="inline-toast" role="status">{notice}</div>}
    {reviewerApp && <Modal className="registry-confirm" title={`访问审核负责人 · ${reviewerApp.name}`} onClose={operating ? () => {} : () => setReviewerApp(null)} footer={<><button type="button" disabled={operating} onClick={() => setReviewerApp(null)}>取消</button><button className="primary-action" type="button" disabled={operating} onClick={() => void saveReviewer()}>{operating ? '提交中…' : '保存'}</button></>}>
      <p>可以选择任意启用用户，包括原发布申请人 {reviewerLabel(reviewerApp.applicantName, reviewerApp.applicantEmployeeNo)}。留空则不指定，历史申请不会自动把申请人设为审核人。</p>
      <div className="form-field"><span>访问审核负责人</span><ModernSelect ariaLabel="流程发布应用审核负责人" value={reviewerId} placeholder="不指定" options={[{value: '', label: '不指定'}, ...options.users.map(user => ({value: user.id, label: `${user.name}（${user.employeeNo}）`, description: user.id === reviewerApp.applicantId ? '原发布申请人' : '人员'}))]} onChange={setReviewerId}/></div>
      {operationError && <p className="model-form-error" role="alert">{operationError}</p>}
    </Modal>}
    {pending && <Modal className="registry-confirm" title={pending.operationalEnabled ? '停用流程发布应用' : '恢复流程发布应用'} onClose={operating ? () => {} : () => setPending(null)} footer={<><button type="button" disabled={operating} onClick={() => setPending(null)}>取消</button><button className="primary-action" type="button" disabled={operating} onClick={() => void confirmOperational()}>{operating ? '提交中…' : pending.operationalEnabled ? '确认停用' : '确认恢复'}</button></>}>
      <p>{pending.operationalEnabled ? `停用「${pending.name}」后，它会从门户应用集合、最近使用和可申请访问列表中移除。已签发的票据和已打开的会话会失效，恢复后也不能继续使用。此操作不停止远端部署服务。` : `恢复「${pending.name}」后，沿用原来的发布记录和授权。发布已完成、路由就绪且用户有权访问时可以重新打开，无需重新审批。未就绪的路由不会被改为就绪。`}</p>
      {operationError && <p className="model-form-error" role="alert">{operationError}</p>}
    </Modal>}
    {form && <Modal className="registry-modal" title={editing ? '编辑注册应用' : '注册应用'} onClose={saving ? () => {} : close}>
      <form className="registry-form" onSubmit={submit}>
        <div className="entity-form registry-form-body" tabIndex={0} aria-label="注册应用表单">
          <div className="form-grid">
            {field('name', '中文名称', true, 'nameEn')}{field('nameEn', '英文名称', true)}
            {field('description', '中文简介', true, 'descriptionEn', true)}{field('descriptionEn', '英文简介', false, undefined, true)}
            <div className="form-field"><span>应用分类 *</span><ModernSelect ariaLabel="注册应用分类" value={form.categoryId} options={options.categories.map(x => ({value: x.id, label: x.parentId ? `${options.categories.find(p => p.id === x.parentId)?.name || ""} / ${x.name}` : x.name}))} onChange={categoryId => setForm({...form, categoryId})}/></div>
            <div className="form-field"><span>负责人 / 团队</span><ModernSelect ariaLabel="负责人 / 团队" value={form.owner} placeholder="请选择人员或部门" options={[
              {value: '', label: '不指定'},
              ...(!options.departments.some(x => x.name === form.owner) && !options.users.some(x => `${x.name}（${x.employeeNo}）` === form.owner) && form.owner ? [{value: form.owner, label: form.owner, description: '当前已保存的负责人 / 团队'}] : []),
              ...options.departments.map(x => ({value: x.name, label: x.name, description: '部门'})),
              ...options.users.map(x => ({value: `${x.name}（${x.employeeNo}）`, label: `${x.name}（${x.employeeNo}）`, description: '人员'})),
            ].filter((option, index, all) => all.findIndex(x => x.value === option.value) === index)} onChange={owner => setForm({...form, owner, ownerEn: ''})}/></div>
            <div className="form-field"><span>访问审核负责人</span><ModernSelect ariaLabel="访问审核负责人" value={form.accessReviewerId || ''} placeholder="不指定" options={[{value: '', label: '不指定'}, ...options.users.map(x => ({value: x.id, label: `${x.name}（${x.employeeNo}）`, description: '人员'}))]} onChange={accessReviewerId => setForm({...form, accessReviewerId: accessReviewerId || null})}/><small>只负责访问申请审核，与上方的负责人 / 团队展示无关。留空时走流程里的兜底角色。</small></div>
            <div className="form-span">{field('accessUrl', '应用访问 URL', true)}</div>
            {editing && <fieldset className="form-span registry-click-fields"><legend>点击数调整</legend><div className="form-grid"><TokenAmountInput label="累计点击" min={0} max={1000000000000} value={form.totalClicks ?? 0} onChange={totalClicks => setForm({...form, totalClicks})}/>{(['day', 'week', 'month', 'year'] as const).map((period, i) => <TokenAmountInput key={period} label={['日点击', '周点击', '月点击', '年点击'][i]} min={0} max={1000000000000} value={form.clicks?.[period] ?? 0} onChange={value => setForm({...form, clicks: {...(form.clicks ?? {day: 0, week: 0, month: 0, year: 0}), [period]: value}})}/>)}</div><small>累计点击独立于日/周/月/年四个周期：修改周期不影响门户卡片上的累计值。后续有效点击继续累加；原始记录保留并记录调整审计。</small></fieldset>}
            <div className="form-field"><TokenAmountInput label="显示排序" min={-2147483648} max={2147483647} value={form.sortOrder} onChange={sortOrder => setForm({...form, sortOrder})}/><small>数字越小越靠前</small></div>
            <div className="form-field"><span>门户状态</span><ModernSelect ariaLabel="注册应用状态" value={form.isEnabled ? 'on' : 'off'} options={[{value: 'on', label: '启用'}, {value: 'off', label: '停用'}]} onChange={value => setForm({...form, isEnabled: value === 'on'})}/></div>
            <div className="form-field form-span"><span>访问范围</span><ModernSelect ariaLabel="注册应用访问范围" value={form.accessMode} options={[{value: 'Subjects', label: '指定部门及个人'}, {value: 'All', label: '所有已登录用户'}]} onChange={value => setForm({...form, accessMode: value as RegistryInput['accessMode']})}/></div>
            {form.accessMode === 'Subjects' && <>
              <div className="form-field form-span"><span>授权部门</span><ModernMultiSelect ariaLabel="授权部门" itemLabel="部门" values={form.grants.filter(x => x.subjectType === 'Department').map(x => x.subjectId)} options={options.departments.map(x => ({value: x.id, label: x.name}))} onChange={ids => setForm({...form, grants: [...form.grants.filter(x => x.subjectType !== 'Department'), ...ids.map(subjectId => ({subjectType: 'Department' as const, subjectId}))]})}/></div>
              <div className="form-field form-span"><span>授权个人</span><ModernMultiSelect ariaLabel="授权个人" itemLabel="人员" values={form.grants.filter(x => x.subjectType === 'User').map(x => x.subjectId)} options={options.users.map(x => ({value: x.id, label: x.name, description: x.employeeNo}))} onChange={ids => setForm({...form, grants: [...form.grants.filter(x => x.subjectType !== 'User'), ...ids.map(subjectId => ({subjectType: 'User' as const, subjectId}))]})}/></div>
            </>}
          </div>
          {translating > 0 && <p role="status">正在自动翻译英文…</p>}
          {formError && <p className="model-form-error" role="alert">{formError}</p>}
        </div>
        <footer className="modal-actions"><button type="button" disabled={saving} onClick={close}>取消</button><button className="primary-action" type="submit" disabled={saving || translating > 0}>{saving ? '保存中…' : '保存应用'}</button></footer>
      </form>
    </Modal>}
  </div>;
}
