/* eslint-disable @next/next/no-img-element */
'use client';

import Link from 'next/link';
import {
  Archive, ArchiveRestore, ArrowLeft, Check, ChevronRight, Copy, Grid2X2, LoaderCircle, Menu, MessageSquarePlus,
  MoreHorizontal, PanelLeftClose, Pencil, Send, Settings2, Sparkles, Trash2, UserRound, Wrench, X,
} from 'lucide-react';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { ChatMarkdown } from './chat-markdown';
import {
  archiveChatConversation, cancelChatTool, clearSession, confirmChatTool, createChatConversation, deleteChatConversation, getCatalogApps, getChatConversations,
  getChatMessages, getChatModels, getChatTools, getChatToolOptions, getPendingChatToolExecutions, hasBackend, proposeChatTool, sendChatMessage,
  renameChatConversation, restoreChatConversation,
  type BackendCatalogApp, type BackendChatConversation, type BackendChatMessage,
  type BackendChatModel, type BackendChatTool, type BackendChatToolExecution, type BackendChatToolOptions,
} from '../lib/api-client';
import { DirectoryUserPicker } from './directory-user-picker';
import { ModernSelect } from './modern-select';

type DraftMessage = BackendChatMessage & { pending?: boolean };

const initialArguments: Record<string, Record<string, string>> = {
  open_application: { applicationName: '' },
  create_publication_request: { appName: '', category: '', summary: '', repositoryUrl: '', branch: 'main', commitSha: '', version: '', environment: 'Production', accessMode: 'All', accessibleUserIds: '' },
  create_user: { employeeNo: '', name: '', email: '', department: '', role: '', initialPassword: '', isEnabled: 'true' },
  create_department: { code: '', name: '', description: '', managerId: '', isEnabled: 'true' },
  create_category: { code: '', name: '', description: '', color: '#2465d0', sortOrder: '0', isEnabled: 'true' },
};

const confirmationLabels: Record<string, string> = {
  name: '名称', code: '编码', description: '描述', color: '主题色', sortOrder: '排序',
  isEnabled: '状态', managerId: '负责人', employeeNo: '工号', email: '企业邮箱',
  department: '部门', roles: '角色', appName: '应用名称', category: '应用分类',
  summary: '应用简介', repositoryUrl: '仓库地址', branch: '分支', commitSha: 'Commit SHA',
  version: '版本', environment: '部署环境', accessMode: '可访问范围', accessSubjects: '可访问人员',
};

function confirmationValue(key: string, value: unknown, options: BackendChatToolOptions): string {
  if (key === 'isEnabled') return value ? '启用' : '禁用';
  if (key === 'managerId') {
    const user = options.users.find((item) => item.id === value);
    return user ? `${user.name} · ${user.employeeNo}` : String(value);
  }
  if (key === 'department' || key === 'category') {
    const collection = key === 'department' ? options.departments : options.categories;
    return collection.find((item) => item.id === value)?.name ?? String(value);
  }
  if (key === 'roles' && Array.isArray(value)) return value.map((id) => options.roles.find((item) => item.id === id)?.name ?? String(id)).join('、');
  if (key === 'accessSubjects' && Array.isArray(value)) return value.map((item: { subjectId?: string }) => options.users.find((user) => user.id === item.subjectId)?.name ?? item.subjectId ?? '').join('、');
  if (Array.isArray(value)) return value.map(String).join('、');
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function ConfirmationCard({ execution, options, loading, onDecision }: {
  execution: BackendChatToolExecution; options: BackendChatToolOptions; loading: boolean;
  onDecision: (execution: BackendChatToolExecution, confirm: boolean) => void;
}) {
  const fields = Object.entries(execution.arguments).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return <div className="chat-confirmation-dock" role="group" aria-label={`${execution.displayName}待确认操作`}>
    <div className="chat-confirmation-heading"><span><Wrench size={17} /></span><div><strong>确认{execution.displayName}</strong><small>请核对以下参数；仅在你确认后才会执行</small></div></div>
    <dl>{fields.map(([key, value]) => <div key={key}><dt>{confirmationLabels[key] ?? key}</dt><dd>{confirmationValue(key, value, options)}</dd></div>)}</dl>
    <div className="chat-confirmation-actions"><button type="button" disabled={loading} onClick={() => onDecision(execution, false)}>取消</button><button className="primary-action" type="button" disabled={loading} onClick={() => onDecision(execution, true)}>{loading ? <LoaderCircle className="is-spinning" size={16} /> : <Check size={16} />}确认执行</button></div>
  </div>;
}

export function ChatShell() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarReady, setSidebarReady] = useState(false);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [tools, setTools] = useState<BackendChatTool[]>([]);
  const [conversations, setConversations] = useState<BackendChatConversation[]>([]);
  const [archivedConversations, setArchivedConversations] = useState<BackendChatConversation[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [conversationMenuId, setConversationMenuId] = useState<string | null>(null);
  const [models, setModels] = useState<BackendChatModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DraftMessage[]>([]);
  const [executions, setExecutions] = useState<BackendChatToolExecution[]>([]);
  const [toolPanelOpen, setToolPanelOpen] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [loginPromptOpen, setLoginPromptOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<null | { name: string }>(null);
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [toolArguments, setToolArguments] = useState<Record<string, string>>({});
  const [catalogApps, setCatalogApps] = useState<BackendCatalogApp[]>([]);
  const [toolOptions, setToolOptions] = useState<BackendChatToolOptions>({ categories: [], departments: [], roles: [], users: [] });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLElement>(null);
  const [activeAnchorId, setActiveAnchorId] = useState('');
  const [copiedMessageId, setCopiedMessageId] = useState('');
  const copyResetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = localStorage.getItem('aigc-theme') === 'dark' ? 'dark' : 'light';
    const timer = window.setTimeout(() => {
      setSidebarOpen(localStorage.getItem('aigc-chat-sidebar') !== 'collapsed');
      window.requestAnimationFrame(() => setSidebarReady(true));
      if (!hasBackend) return;
      const accessToken = localStorage.getItem('aigc_hub_access_token');
      if (!accessToken) {
        setNotice('请先登录后使用企业 AI 助手。');
        setLoginPromptOpen(true);
        return;
      }
      try { setCurrentUser(JSON.parse(localStorage.getItem('aigc_hub_user') ?? 'null') as null | { name: string }); }
      catch { setCurrentUser(null); }
      Promise.all([getChatTools(), getChatModels(), getChatConversations(), getChatConversations(true), getCatalogApps(), getChatToolOptions()]).then(async ([toolItems, modelItems, conversationItems, archivedItems, apps, options]) => {
        setAuthenticated(true);
        setTools(toolItems); setModels(modelItems); setConversations(conversationItems); setArchivedConversations(archivedItems); setCatalogApps(apps); setToolOptions(options);
        const initialModelId = conversationItems[0]?.modelId ?? modelItems.find((item) => item.isDefault)?.id ?? modelItems[0]?.id ?? '';
        setSelectedModelId(initialModelId);
        if (conversationItems[0]) {
          setActiveConversationId(conversationItems[0].id);
          const [initialMessages, pendingExecutions] = await Promise.all([
            getChatMessages(conversationItems[0].id),
            getPendingChatToolExecutions(conversationItems[0].id),
          ]);
          setMessages(initialMessages);
          setExecutions(pendingExecutions);
        }
      }).catch((error: Error) => {
        setNotice(error.message);
        if (error.message.includes('登录状态已失效')) {
          clearSession(); setAuthenticated(false); setCurrentUser(null); setLoginPromptOpen(true);
        }
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!conversationMenuId) return;
    const closeMenu = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || (!target.closest('.chat-history-menu') && !target.closest('.chat-history-more'))) {
        setConversationMenuId(null);
      }
    };
    const closeMenuWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConversationMenuId(null);
    };
    window.addEventListener('pointerdown', closeMenu);
    window.addEventListener('keydown', closeMenuWithKeyboard);
    return () => {
      window.removeEventListener('pointerdown', closeMenu);
      window.removeEventListener('keydown', closeMenuWithKeyboard);
    };
  }, [conversationMenuId]);

  useEffect(() => {
    if (!messages.length || !threadRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const thread = threadRef.current;
      if (!thread) return;
      thread.scrollTo({ top: thread.scrollHeight, behavior: messages.some((message) => message.pending) ? 'smooth' : 'auto' });
      const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
      if (lastUserMessage) setActiveAnchorId(lastUserMessage.id);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, executions]);

  useEffect(() => () => {
    if (copyResetTimerRef.current) window.clearTimeout(copyResetTimerRef.current);
  }, []);

  const toggleSidebar = (open: boolean) => {
    setSidebarOpen(open);
    localStorage.setItem('aigc-chat-sidebar', open ? 'expanded' : 'collapsed');
  };

  const updateActiveAnchor = () => {
    const thread = threadRef.current;
    if (!thread) return;
    const threshold = thread.scrollTop + thread.clientHeight * 0.32;
    const anchorElements = Array.from(thread.querySelectorAll<HTMLElement>('[data-chat-anchor]'));
    let current = anchorElements[0]?.dataset.chatAnchor ?? '';
    for (const element of anchorElements) {
      if (element.offsetTop <= threshold) current = element.dataset.chatAnchor ?? current;
      else break;
    }
    if (current) setActiveAnchorId(current);
  };

  const jumpToAnchor = (id: string) => {
    const thread = threadRef.current;
    const target = thread?.querySelector<HTMLElement>(`[data-chat-anchor="${CSS.escape(id)}"]`);
    if (!thread || !target) return;
    thread.scrollTo({ top: Math.max(0, target.offsetTop - 28), behavior: 'smooth' });
    setActiveAnchorId(id);
  };

  const copyMessage = async (message: DraftMessage) => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(message.content);
      else {
        const textarea = document.createElement('textarea');
        textarea.value = message.content;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      setCopiedMessageId(message.id);
      if (copyResetTimerRef.current) window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(() => setCopiedMessageId(''), 1800);
    } catch {
      setNotice('复制失败，请选中文字后手动复制。');
    }
  };

  const refreshConversations = async () => {
    if (hasBackend) {
      const [activeItems, archivedItems] = await Promise.all([getChatConversations(), getChatConversations(true)]);
      setConversations(activeItems); setArchivedConversations(archivedItems);
    }
  };

  const ensureConversation = async () => {
    if (activeConversationId) return activeConversationId;
    const item = await createChatConversation('新对话', selectedModelId);
    setConversations((current) => [item, ...current]);
    setActiveConversationId(item.id);
    return item.id;
  };

  const startNewConversation = async () => {
    setMessages([]); setExecutions([]); setNotice(''); setDraft('');
    if (hasBackend && localStorage.getItem('aigc_hub_access_token')) {
      const item = await createChatConversation('新对话', selectedModelId);
      setConversations((current) => [item, ...current]);
      setActiveConversationId(item.id);
    } else setActiveConversationId(null);
    inputRef.current?.focus();
  };

  const openConversation = async (id: string) => {
    setActiveConversationId(id); setExecutions([]); setNotice('');
    const conversation = conversations.find((item) => item.id === id);
    if (conversation?.modelId) setSelectedModelId(conversation.modelId);
    const [conversationMessages, pendingExecutions] = await Promise.all([
      getChatMessages(id),
      getPendingChatToolExecutions(id),
    ]);
    setMessages(conversationMessages);
    setExecutions(pendingExecutions);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || loading) return;
    if (!hasBackend) {
      setNotice('模型服务尚未配置，当前内容已保留在输入框中。');
      inputRef.current?.focus();
      return;
    }
    setLoading(true); setNotice(''); setDraft('');
    const optimistic: DraftMessage = { id: `pending-${Date.now()}`, role: 'user', content, createdAt: new Date().toISOString(), pending: true };
    setMessages((current) => [...current, optimistic]);
    try {
      const response = await sendChatMessage(activeConversationId, content, selectedModelId);
      setActiveConversationId(response.conversationId);
      setMessages((current) => [...current.filter((item) => item.id !== optimistic.id), { ...optimistic, pending: false }, response.message]);
      if (response.toolExecution) {
        if (response.toolExecution.result?.navigationUrl) window.open(response.toolExecution.result.navigationUrl, '_blank', 'noopener,noreferrer');
      }
      // 每轮消息后以数据库待办状态为准，移除已被新意图撤销的旧确认卡片。
      const pendingItems = await getPendingChatToolExecutions(response.conversationId).catch(() => {
        setNotice('消息已发送，但待确认状态同步失败；请刷新页面核对。');
        return response.toolExecution?.status === 'AwaitingConfirmation' ? [response.toolExecution] : [];
      });
      setExecutions((current) => {
        const completed = response.toolExecution
          ? [...current.filter((item) => item.id !== response.toolExecution!.id), response.toolExecution]
          : current;
        return [...completed.filter((item) => item.status !== 'AwaitingConfirmation'), ...pendingItems];
      });
      await refreshConversations();
    } catch (error) {
      setMessages((current) => current.filter((item) => item.id !== optimistic.id));
      setDraft(content); setNotice(error instanceof Error ? error.message : '发送失败');
    } finally { setLoading(false); inputRef.current?.focus(); }
  };

  const chooseTool = (name: string) => {
    setSelectedTool(name);
    setToolArguments({ ...(initialArguments[name] ?? {}) });
  };

  const normalizeArguments = (): Record<string, unknown> => {
    if (selectedTool === 'create_publication_request') return {
      ...toolArguments,
      accessSubjects: toolArguments.accessMode === 'Subjects'
        ? toolArguments.accessibleUserIds.split(',').filter(Boolean).map((subjectId) => ({ subjectType: 'User', subjectId }))
        : [],
      accessibleUserIds: undefined,
    };
    if (selectedTool === 'create_user') return {
      ...toolArguments, roles: [toolArguments.role].filter(Boolean),
      isEnabled: toolArguments.isEnabled === 'true', role: undefined,
      initialPassword: toolArguments.initialPassword || undefined,
    };
    if (selectedTool === 'create_department') return { ...toolArguments, managerId: toolArguments.managerId || undefined, isEnabled: toolArguments.isEnabled === 'true' };
    if (selectedTool === 'create_category') return { ...toolArguments, sortOrder: Number(toolArguments.sortOrder || 0), isEnabled: toolArguments.isEnabled === 'true' };
    return toolArguments;
  };

  const runSelectedTool = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedTool || loading) return;
    setLoading(true); setNotice('');
    try {
      const conversationId = await ensureConversation();
      const execution = await proposeChatTool(conversationId, selectedTool, normalizeArguments());
      setExecutions((current) => [...current, execution]);
      setMessages((current) => [...current, {
        id: `tool-${execution.id}`, role: 'assistant',
        content: execution.requiresConfirmation
          ? `“${execution.displayName}”已准备好，请核对后确认执行。`
          : execution.status === 'Failed'
            ? `“${execution.displayName}”失败：${execution.error ?? '工具执行失败'}`
            : execution.result?.message ?? `“${execution.displayName}”正在执行。`,
        createdAt: new Date().toISOString(),
      }]);
      if (execution.result?.navigationUrl) window.open(execution.result.navigationUrl, '_blank', 'noopener,noreferrer');
      setToolPanelOpen(false); setSelectedTool(null);
      await refreshConversations();
    } catch (error) { setNotice(error instanceof Error ? error.message : '工具准备失败'); }
    finally { setLoading(false); }
  };

  const decideExecution = async (execution: BackendChatToolExecution, confirm: boolean) => {
    setLoading(true); setNotice('');
    try {
      const updated = confirm ? await confirmChatTool(execution.id) : await cancelChatTool(execution.id);
      setExecutions((current) => current.map((item) => item.id === updated.id ? updated : item));
      if (updated.result?.navigationUrl) window.open(updated.result.navigationUrl, '_blank', 'noopener,noreferrer');
      if (updated.error) setNotice(updated.error);
      await refreshConversations();
    } catch (error) { setNotice(error instanceof Error ? error.message : '工具执行失败'); }
    finally { setLoading(false); }
  };

  const renameConversation = async (item: BackendChatConversation) => {
    const title = window.prompt('请输入新的对话名称', item.title)?.trim();
    if (!title || title === item.title) { setConversationMenuId(null); return; }
    try { await renameChatConversation(item.id, title); await refreshConversations(); }
    catch (error) { setNotice(error instanceof Error ? error.message : '重命名失败'); }
    finally { setConversationMenuId(null); }
  };

  const archiveConversation = async (item: BackendChatConversation) => {
    try {
      await archiveChatConversation(item.id);
      if (activeConversationId === item.id) { setActiveConversationId(null); setMessages([]); setExecutions([]); }
      await refreshConversations();
    } catch (error) { setNotice(error instanceof Error ? error.message : '归档失败'); }
    finally { setConversationMenuId(null); }
  };

  const restoreConversation = async (item: BackendChatConversation) => {
    try { await restoreChatConversation(item.id); await refreshConversations(); }
    catch (error) { setNotice(error instanceof Error ? error.message : '恢复失败'); }
    finally { setConversationMenuId(null); }
  };

  const removeConversation = async (item: BackendChatConversation) => {
    if (!window.confirm(`确定永久删除对话“${item.title}”吗？此操作无法撤销。`)) return;
    try {
      await deleteChatConversation(item.id);
      if (activeConversationId === item.id) { setActiveConversationId(null); setMessages([]); setExecutions([]); }
      await refreshConversations();
    } catch (error) { setNotice(error instanceof Error ? error.message : '删除失败'); }
    finally { setConversationMenuId(null); }
  };

  const hasMessages = messages.length > 0 || executions.length > 0;
  const pendingExecution = [...executions].reverse().find((execution) => execution.status === 'AwaitingConfirmation');
  const selectedDefinition = tools.find((tool) => tool.name === selectedTool);
  return (
    <div className={`chat-page${sidebarOpen ? '' : ' chat-sidebar-collapsed'}${sidebarReady ? ' is-ready' : ''}`}>
      <aside className="chat-sidebar" aria-label="对话历史" aria-hidden={!sidebarOpen}>
        <header>
          <Link href="/" className="chat-mini-brand" tabIndex={sidebarOpen ? 0 : -1}><img src="/bhss-logo.png" alt="博世华域转向系统有限公司" /></Link>
          <button type="button" aria-label="收起侧边栏" tabIndex={sidebarOpen ? 0 : -1} onClick={() => toggleSidebar(false)}><PanelLeftClose size={18} /></button>
        </header>
        <button className="chat-new" type="button" tabIndex={sidebarOpen ? 0 : -1} onClick={() => void startNewConversation()}><MessageSquarePlus size={18} />新对话</button>
        <div className="chat-history-list">
          {conversations.map((item) => <div className={`chat-history-row${item.id === activeConversationId ? ' is-active' : ''}`} key={item.id}><button className="chat-history-main" type="button" tabIndex={sidebarOpen ? 0 : -1} onClick={() => void openConversation(item.id)}><span>{item.title}</span><small>{new Date(item.updatedAt).toLocaleDateString('zh-CN')}</small></button><button className="chat-history-more" type="button" aria-label={`${item.title}更多操作`} onClick={() => setConversationMenuId((current) => current === item.id ? null : item.id)}><MoreHorizontal size={17} /></button>{conversationMenuId === item.id && <div className="chat-history-menu"><button type="button" onClick={() => void renameConversation(item)}><Pencil size={14} />重命名</button><button type="button" onClick={() => void archiveConversation(item)}><Archive size={14} />归档对话</button><button className="is-danger" type="button" onClick={() => void removeConversation(item)}><Trash2 size={14} />删除对话</button></div>}</div>)}
          {!conversations.length && <div className="chat-history-empty"><span>暂无历史对话</span><small>完成一次对话后，记录会保存在这里。</small></div>}
          <button className="chat-archive-toggle" type="button" onClick={() => setShowArchived((current) => !current)}><Archive size={15} /><span>已归档对话</span><small>{archivedConversations.length}</small></button>
          {showArchived && <div className="chat-archived-list">{archivedConversations.map((item) => <div className="chat-history-row" key={item.id}><button className="chat-history-main" type="button" onClick={() => void openConversation(item.id)}><span>{item.title}</span><small>已归档</small></button><button className="chat-history-more" type="button" aria-label={`${item.title}更多操作`} onClick={() => setConversationMenuId((current) => current === item.id ? null : item.id)}><MoreHorizontal size={17} /></button>{conversationMenuId === item.id && <div className="chat-history-menu"><button type="button" onClick={() => void restoreConversation(item)}><ArchiveRestore size={14} />恢复对话</button><button className="is-danger" type="button" onClick={() => void removeConversation(item)}><Trash2 size={14} />删除对话</button></div>}</div>)}{!archivedConversations.length && <small className="chat-archived-empty">暂无归档对话</small>}</div>}
        </div>
        <footer>
          <Link tabIndex={sidebarOpen ? 0 : -1} href="/"><ArrowLeft size={18} />返回首页</Link>
          <Link tabIndex={sidebarOpen ? 0 : -1} href="/apps"><Grid2X2 size={18} />应用集合</Link>
          <Link tabIndex={sidebarOpen ? 0 : -1} href="/admin"><Settings2 size={18} />管理后台</Link>
          <div className="chat-sidebar-account">
            <span className="chat-sidebar-account__avatar"><UserRound size={16} /></span>
            <span><strong>{currentUser?.name ?? '未登录用户'}</strong><small>{currentUser ? '企业账号' : '请先登录'}</small></span>
          </div>
        </footer>
      </aside>

      <main className="chat-workspace">
        {!sidebarOpen && <button className="chat-sidebar-reopen" type="button" aria-label="展开侧边栏" onClick={() => toggleSidebar(true)}><Menu size={19} /></button>}

        {hasMessages ? <section ref={threadRef} className="chat-thread" aria-live="polite" onScroll={updateActiveAnchor}>
          {messages.map((message) => <article id={message.role === 'user' ? `chat-message-${message.id}` : undefined} data-chat-anchor={message.role === 'user' ? message.id : undefined} key={message.id} className={`chat-message is-${message.role}`}><div><ChatMarkdown content={message.content} /><div className="chat-message-actions"><button className={copiedMessageId === message.id ? 'is-copied' : ''} type="button" aria-label={copiedMessageId === message.id ? '消息已复制' : '复制消息'} title={copiedMessageId === message.id ? '已复制' : '复制'} onClick={() => void copyMessage(message)}>{copiedMessageId === message.id ? <Check size={15} /> : <Copy size={15} />}</button></div></div></article>)}
          {executions.filter((execution) => execution.status !== 'AwaitingConfirmation').map((execution) => <article className={`chat-tool-card is-${execution.status.toLowerCase()}`} key={execution.id}>
            <header><span><Wrench size={17} /></span><div><strong>{execution.displayName}</strong><small>{execution.status === 'AwaitingConfirmation' ? '等待确认' : execution.status === 'Succeeded' ? '执行成功' : execution.status === 'Cancelled' ? '已取消' : execution.status === 'Failed' ? '执行失败' : '执行中'}</small></div></header>
            <dl>{Object.entries(execution.arguments).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{Array.isArray(value) ? value.join('、') : typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}</dl>
            {execution.result?.message && <p className="chat-tool-result"><Check size={15} />{execution.result.message}</p>}
            {execution.error && <p className="chat-tool-error">{execution.error}</p>}
          </article>)}
        </section> : <section className="chat-empty-state" aria-labelledby="chat-title">
          <span className="chat-symbol"><Sparkles size={28} /></span>
          <h1 id="chat-title">今天想从哪里开始？</h1>
          <p>你可以询问公司知识、整理业务材料，或调用有权限的企业工具。</p>
          <div className="chat-suggestions">{['帮我梳理一份会议纪要', '查询内部质量规范', '起草应用发布说明'].map((item) => <button key={item} type="button" onClick={() => { setDraft(item); setNotice(''); inputRef.current?.focus(); }}>{item}</button>)}</div>
        </section>}

        {hasMessages && <nav className="chat-anchor-rail" aria-label="对话锚点">
          {messages.filter((message) => message.role === 'user').map((message, index) => <button className={message.id === activeAnchorId ? 'is-active' : ''} type="button" key={message.id} aria-label={`跳转到第 ${index + 1} 轮对话`} aria-current={message.id === activeAnchorId ? 'location' : undefined} onClick={() => jumpToAnchor(message.id)} />)}
        </nav>}

        <form className={`chat-composer${hasMessages ? ' has-history' : ''}`} onSubmit={submit}>
          {pendingExecution && <ConfirmationCard execution={pendingExecution} options={toolOptions} loading={loading} onDecision={(execution, confirm) => void decideExecution(execution, confirm)} />}
          {notice && <p role="status">{notice}</p>}
          <div className="chat-composer-box"><textarea ref={inputRef} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="输入消息，按 Enter 发送" aria-label="输入消息" rows={1} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) void submit(event); }} /><div className="chat-composer-toolbar"><button className="chat-tools-trigger" type="button" aria-label="打开工具" onClick={() => setToolPanelOpen(true)} disabled={!hasBackend || !authenticated}><Wrench size={18} /></button><span className="chat-composer-spacer" /><div className="chat-model-picker chat-composer-model"><ModernSelect ariaLabel="选择对话模型" value={selectedModelId} placeholder="暂无可用模型" options={models.map((item) => ({ value: item.id, label: item.name, description: `${item.providerKind === 'Local' ? '本地' : item.providerKind === 'Online' ? '在线' : '环境变量'} · ${item.modelIdentifier}${item.supportsTools ? ' · 支持工具' : ''}` }))} onChange={setSelectedModelId} /></div><button className="chat-send-button" type="submit" aria-label="发送消息" disabled={!draft.trim() || loading || (hasBackend && !authenticated)}>{loading ? <LoaderCircle className="is-spinning" size={19} /> : <Send size={19} />}</button></div></div>
          <small>AI 内容可能存在误差；写操作必须经你确认，并受当前账号权限控制。</small>
        </form>
      </main>

      {loginPromptOpen && <div className="chat-login-scrim" role="presentation"><section className="chat-login-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-login-title"><span className="chat-login-dialog__icon"><UserRound size={22} /></span><h2 id="chat-login-title">登录后开始对话</h2><p>企业 AI 助手需要登录后才能使用模型、历史会话和企业工具。</p><div><button type="button" onClick={() => setLoginPromptOpen(false)}>暂不登录</button><Link className="primary-action" href="/login">确定，前往登录</Link></div></section></div>}

      {toolPanelOpen && <div className="chat-tool-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setToolPanelOpen(false); }}>
        <section className="chat-tool-panel" role="dialog" aria-modal="true" aria-label="企业工具">
          <header><div><span><Wrench size={18} /></span><div><strong>企业工具</strong><small>仅展示当前账号有权使用的操作</small></div></div><button type="button" aria-label="关闭工具" onClick={() => setToolPanelOpen(false)}><X size={18} /></button></header>
          {!selectedTool ? <div className="chat-tool-list">{tools.map((tool) => <button type="button" key={tool.name} onClick={() => chooseTool(tool.name)}><span><Wrench size={18} /></span><div><strong>{tool.displayName}</strong><small>{tool.description}</small><em>{tool.requiresConfirmation ? '执行前需确认' : '直接执行'}</em></div><ChevronRight size={18} /></button>)}{!tools.length && <p>当前账号没有可用工具。</p>}</div> : selectedDefinition && <ToolForm tool={selectedDefinition} values={toolArguments} setValues={setToolArguments} options={toolOptions} apps={catalogApps} onBack={() => setSelectedTool(null)} onSubmit={runSelectedTool} loading={loading} />}
        </section>
      </div>}
    </div>
  );
}

function ToolForm({ tool, values, setValues, options, apps, onBack, onSubmit, loading }: {
  tool: BackendChatTool; values: Record<string, string>; setValues: (value: Record<string, string>) => void;
  options: BackendChatToolOptions; apps: BackendCatalogApp[]; onBack: () => void;
  onSubmit: (event: FormEvent) => void; loading: boolean;
}) {
  const field = (name: string, label: string, type = 'text') => <label><span>{label}</span><input type={type} required={!['code', 'description', 'initialPassword', 'managerId'].includes(name)} value={values[name] ?? ''} onChange={(event) => setValues({ ...values, [name]: event.target.value })} /></label>;
  const select = (name: string, label: string, options: Array<{ value: string; label: string }>, required = true) => <label><span>{label}</span><select required={required} value={values[name] ?? ''} onChange={(event) => setValues({ ...values, [name]: event.target.value })}><option value="">{required ? '请选择' : '暂不指定'}</option>{options.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>;
  return <form className="chat-tool-form" onSubmit={onSubmit}><button className="chat-tool-back" type="button" onClick={onBack}><ArrowLeft size={15} />返回工具列表</button><h2>{tool.displayName}</h2><p>{tool.description}</p><div className="chat-tool-fields">
    {tool.name === 'open_application' && select('applicationName', '应用', apps.map((app) => ({ value: app.name, label: app.name })))}
    {tool.name === 'create_publication_request' && <>{field('appName', '应用名称')}{select('category', '应用分类', options.categories.map((item) => ({ value: item.id, label: item.name })))}{field('summary', '应用简介')}{field('repositoryUrl', '仓库地址', 'url')}{field('branch', '分支')}{field('commitSha', 'Commit SHA')}{field('version', '版本')}{select('environment', '部署环境', ['Test', 'Staging', 'Production'].map((item) => ({ value: item, label: item })))}{select('accessMode', '可访问范围', [{ value: 'All', label: '所有已登录用户' }, { value: 'Subjects', label: '指定用户' }])}{values.accessMode === 'Subjects' && <label className="chat-tool-directory"><span>可访问用户</span><DirectoryUserPicker users={options.users} selectedIds={values.accessibleUserIds?.split(',').filter(Boolean) ?? []} onChange={(ids) => setValues({ ...values, accessibleUserIds: ids.join(',') })} /></label>}</>}
    {tool.name === 'create_user' && <>{field('employeeNo', '企业工号')}{field('name', '姓名')}{field('email', '企业邮箱', 'email')}{select('department', '部门', options.departments.map((item) => ({ value: item.id, label: item.name })))}{select('role', '角色', options.roles.map((item) => ({ value: item.id, label: item.name })))}{field('initialPassword', '初始密码（不填使用系统默认）', 'password')}</>}
    {tool.name === 'create_department' && <>{field('code', '部门编码（可选，留空自动生成）')}{field('name', '部门名称')}{field('description', '部门说明')}{select('managerId', '部门负责人（可选）', options.users.map((item) => ({ value: item.id, label: `${item.name} · ${item.employeeNo}` })), false)}</>}
    {tool.name === 'create_category' && <>{field('code', '分类编码（可选，留空自动生成）')}{field('name', '分类名称')}{field('description', '分类说明')}{field('color', '主题色', 'color')}</>}
  </div><footer><button type="button" onClick={onBack}>取消</button><button className="primary-action" type="submit" disabled={loading}>{loading ? '处理中…' : tool.requiresConfirmation ? '生成确认单' : '执行'}</button></footer></form>;
}
