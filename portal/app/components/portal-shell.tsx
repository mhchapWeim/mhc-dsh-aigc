/* eslint-disable @next/next/no-img-element */
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, BookOpenCheck, ChevronDown, CircleCheckBig, Clock3, Download, FilePlus2, Heart, Inbox, Languages, LogOut, Moon, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Sun, UserRound, Wrench } from 'lucide-react';
import { AppCard } from './app-card';
import { AntPagination } from './ant-pagination';
import { usePageSize } from './use-page-size';
import { PasswordChangeForm } from './password-change-form';
import { Modal } from './modal';
import { usePlatform } from './platform-provider';
import { categoryLabels, localizeApp, portalCopy, type PortalLocale } from '../lib/portal-i18n';
import type { PortalApp } from '../lib/types';
import { clearSession, getCatalogApps } from '../lib/api-client';

type Theme = 'light' | 'dark';
type StatusFilter = 'all' | '运行中';

export function PortalShell() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize();
  const { currentUserId, users, dispatch } = usePlatform();
  const currentUser = users.find((user) => user.id === currentUserId);
  const searchRef = useRef<HTMLInputElement>(null);
  const catalogRef = useRef<HTMLElement>(null);
  const [apps, setApps] = useState<PortalApp[]>([]);
  const [appsLoading, setAppsLoading] = useState(true);
  const [appsError, setAppsError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部应用');
  const [favorites, setFavorites] = useState<string[]>([]);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [notice, setNotice] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileCenterOpen, setProfileCenterOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [theme, setTheme] = useState<Theme>('light');
  const [locale, setLocale] = useState<PortalLocale>('zh');
  const copy = portalCopy[locale];

  useEffect(() => {
    let active = true;
    getCatalogApps()
      .then((items) => {
        if (!active) return;
        setApps(items.map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          category: item.category,
          tags: [],
          owner: item.owner,
          accessUrl: item.accessUrl,
          publishedAt: item.publishedAt,
          status: '运行中',
          accent: item.categoryColor || '#2465d0',
        })));
        setAppsError('');
      })
      .catch((error: unknown) => {
        if (active) setAppsError(error instanceof Error ? error.message : '应用目录加载失败');
      })
      .finally(() => { if (active) setAppsLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- browser preferences are restored only after hydration */
    const storedTheme = window.localStorage.getItem('aigc-theme');
    const initialTheme: Theme = storedTheme === 'dark' ? 'dark' : 'light';
    const storedLocale = window.localStorage.getItem('aigc-locale');
    const initialLocale: PortalLocale = storedLocale === 'en' ? 'en' : 'zh';
    setTheme(initialTheme);
    setLocale(initialLocale);
    document.documentElement.dataset.theme = initialTheme;
    document.documentElement.lang = initialLocale === 'en' ? 'en' : 'zh-CN';
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (event.key === 'Escape' && document.activeElement === searchRef.current) {
        setQuery('');
        searchRef.current?.blur();
      }
      if (event.key === 'Escape') {
        setInboxOpen(false);
        setFilterOpen(false);
        setProfileOpen(false);
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  const categories = useMemo(() => ['全部应用', ...Array.from(new Set(apps.map((app) => app.category)))], [apps]);
  const localizedApps = useMemo(() => apps.map((app) => localizeApp(app, locale)), [apps, locale]);
  const filteredApps = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return localizedApps.filter((app) => {
      const searchable = [app.name, app.description, app.category, app.owner, ...app.tags].join(' ').toLowerCase();
      return (!normalized || searchable.includes(normalized)) && (category === '全部应用' || app.category === category) && (!favoritesOnly || favorites.includes(app.id)) && (statusFilter === 'all' || app.status === statusFilter);
    });
  }, [category, favorites, favoritesOnly, localizedApps, query, statusFilter]);

  const currentPage = Math.min(page, Math.max(1, Math.ceil(filteredApps.length / pageSize)));
  useEffect(() => { setPage(1); }, [query, category, favoritesOnly, statusFilter]);
  const toggleFavorite = (id: string) => setFavorites((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const openApp = (app: PortalApp) => {
    let target: URL;
    try { target = new URL(app.accessUrl); }
    catch { setNotice(locale === 'zh' ? '应用地址无效，请联系平台管理员' : 'The application URL is invalid'); return; }
    if (!['http:', 'https:'].includes(target.protocol)) {
      setNotice(locale === 'zh' ? '应用地址无效，请联系平台管理员' : 'The application URL is invalid');
      return;
    }
    setNotice(copy.opening(app.name));
    window.setTimeout(() => window.open(target.toString(), '_blank', 'noopener,noreferrer'), 180);
    window.setTimeout(() => setNotice(''), 2600);
  };
  const toggleTheme = () => {
    const nextTheme: Theme = theme === 'light' ? 'dark' : 'light';
    setTheme(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
    window.localStorage.setItem('aigc-theme', nextTheme);
  };
  const toggleLocale = () => {
    const nextLocale: PortalLocale = locale === 'zh' ? 'en' : 'zh';
    setLocale(nextLocale);
    document.documentElement.lang = nextLocale === 'en' ? 'en' : 'zh-CN';
    window.localStorage.setItem('aigc-locale', nextLocale);
  };
  const logout = () => {
    window.sessionStorage.setItem('aigc-explicit-logout', '1');
    clearSession();
    dispatch({ type: 'logout' });
    setProfileOpen(false);
    setProfileCenterOpen(false);
    router.replace('/login?sso=logged-out');
  };
  const activeCategoryIndex = categories.indexOf(category);
  const runningCount = localizedApps.filter((app) => app.status === '运行中').length;
  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    catalogRef.current?.focus({ preventScroll: true });
    catalogRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className={`portal-page theme-${theme}`}>
      <a className="skip-link" href="#main-content">{copy.skip}</a>
      <div className="topbar-shell">
        <div className="bhss-brand-stripe" aria-hidden="true" />
        <header className="topbar">
          <Link className="brand-lockup" href="/" aria-label="BHSS AIGC Agent Hub">
            <span className="brand-logo-viewport"><img className="brand-logo-image" src="/bhss-logo.png" width="765" height="295" alt="博世华域转向系统有限公司" /></span>
            <span className="brand-divider" aria-hidden="true" />
            <div className="brand-copy"><strong>AIGC Agent Hub</strong><small>{copy.subtitle}</small></div>
          </Link>
          <nav className="topbar-actions" aria-label={copy.globalActions}>
            <Link className="text-button" href="/desktop" aria-label="下载弯崽工作伙伴"><Download size={17} /><span className="desktop-only">{locale === 'zh' ? '客户端下载' : 'Desktop app'}</span></Link>
            <button className="text-button desktop-only" type="button" aria-label={theme === 'light' ? copy.switchDark : copy.switchLight} onClick={toggleTheme}>{theme === 'light' ? <Sun size={17} /> : <Moon size={17} />}<span>{theme === 'light' ? copy.light : copy.dark}</span></button>
            <button className="text-button desktop-only" type="button" aria-label={copy.switchLanguage} onClick={toggleLocale}><Languages size={17} /><span>{copy.language}</span></button>
            <div className="notification-wrap">
              <button className="icon-button notification-button" type="button" aria-label={copy.notification} aria-expanded={inboxOpen} onClick={() => { setInboxOpen((current) => !current); setProfileOpen(false); }}><Bell size={19} /><span className="notification-count" aria-hidden="true">2</span></button>
              {inboxOpen && <section className="notification-panel" role="dialog" aria-labelledby="inbox-title"><header><div><h2 id="inbox-title">{copy.inboxTitle}</h2><span>{copy.inboxUnread}</span></div><Inbox size={19} aria-hidden="true" /></header><div className="notification-list"><button type="button"><span className="notification-icon is-task"><BookOpenCheck size={18} /></span><span><strong>{copy.approvalMessage}</strong><small>{copy.approvalMeta}</small></span><time>{locale === 'zh' ? '刚刚' : 'Now'}</time></button><button type="button"><span className="notification-icon is-maintenance"><Wrench size={18} /></span><span><strong>{copy.maintenanceMessage}</strong><small>{copy.maintenanceMeta}</small></span><time>{locale === 'zh' ? '今天' : 'Today'}</time></button></div></section>}
            </div>
            <Link className="publish-link desktop-only" href="/admin/publications"><FilePlus2 size={17} />{locale === 'zh' ? '发布应用' : 'Publish app'}</Link>
            <Link className="admin-link desktop-only" href="/admin"><Settings2 size={17} />{copy.admin}</Link>
            <div className="profile-wrap"><button className="profile-button" type="button" aria-label={copy.openProfile} aria-expanded={profileOpen} onClick={() => { setProfileOpen((current) => !current); setInboxOpen(false); }}><span className="avatar">{currentUser?.name.slice(0, 1) ?? '访'}</span><span className="desktop-only">{currentUser?.employeeNo ?? (locale === 'zh' ? '未登录' : 'Guest')}</span><ChevronDown size={15} /></button>{profileOpen&&<div className="profile-menu"><div className="profile-menu__user"><span className="avatar">{currentUser?.name.slice(0, 1) ?? '访'}</span><span><strong>{currentUser?.name ?? (locale === 'zh' ? '访客' : 'Guest')}</strong><small>{currentUser?.email ?? (locale === 'zh' ? '请先登录' : 'Please sign in')}</small></span></div><Link href="/admin"><Settings2 size={17}/>{copy.enterAdmin}</Link><button type="button" onClick={() => { setProfileOpen(false); setProfileCenterOpen(true); }}><UserRound size={17}/>{copy.profile}</button><button className="logout-button" type="button" onClick={logout}><LogOut size={17}/>{copy.logout}</button></div>}</div>
          </nav>
        </header>
      </div>
      <main className="portal-main" id="main-content">
        <section className="hero-panel">
          <div className="hero-copy">
            <span className="hero-kicker"><Sparkles size={15} /> {copy.workspace}</span>
            <h1>AIGC Agent Hub<span>{copy.titleLead}<br /><em>{copy.titleAccent}</em></span></h1>
            <p>{copy.intro}</p>
            <label className="hero-search"><Search size={21} aria-hidden="true" /><input ref={searchRef} type="search" placeholder={copy.searchPlaceholder} aria-label={copy.searchLabel} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={handleSearchKeyDown} /><kbd>Ctrl K</kbd></label>
          </div>
          <aside className="hero-overview" aria-label={copy.platformOverview}><header><span>{copy.platformOverview}</span><CircleCheckBig size={19} aria-hidden="true" /></header><div className="overview-primary"><strong>{localizedApps.length}</strong><span>{copy.appsMetric}<small>{Math.max(0, categories.length - 1)} {locale === 'zh' ? '个业务分类' : 'categories'}</small></span></div><div className="overview-grid"><span><strong>{runningCount}</strong><small>{copy.runningApps}</small></span><span><strong>{Math.max(0, categories.length - 1)}</strong><small>{locale === 'zh' ? '应用分类' : 'Categories'}</small></span></div><footer><ShieldCheck size={17} aria-hidden="true" /><span><strong>{copy.secure}</strong><small>{copy.auth}</small></span></footer></aside>
        </section>
        <section className="recent-strip" aria-label={copy.recent}><span><Clock3 size={16} />{copy.recent}</span><button type="button" onClick={() => { setQuery(locale === 'zh' ? '会议' : 'Meeting'); catalogRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }}>{copy.meeting}</button><button type="button" onClick={() => { setQuery(locale === 'zh' ? '质量' : 'Quality'); catalogRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }}>{copy.quality}</button></section>
        <section ref={catalogRef} className="catalog-section" aria-labelledby="catalog-title" tabIndex={-1}>
          <div className="section-heading"><div><h2 id="catalog-title">{copy.catalogTitle}</h2><p>{copy.catalogIntro}</p></div><div className="catalog-actions"><button className={`filter-button${favoritesOnly ? ' is-active' : ''}`} type="button" onClick={() => setFavoritesOnly(!favoritesOnly)} aria-pressed={favoritesOnly}><Heart size={17} />{copy.favorites}</button><div className="catalog-filter-wrap"><button className={`filter-button${statusFilter !== 'all' ? ' is-active' : ''}`} type="button" aria-expanded={filterOpen} onClick={() => setFilterOpen((current) => !current)}><SlidersHorizontal size={17} />{copy.filter}</button>{filterOpen && <div className="catalog-filter-popover" role="dialog" aria-label={copy.filterPanel}><strong>{copy.statusFilter}</strong><div role="radiogroup" aria-label={copy.statusFilter}>{([['all', copy.allStatus], ['运行中', locale === 'zh' ? '运行中' : 'Running']] as Array<[StatusFilter, string]>).map(([value, label]) => <button type="button" role="radio" aria-checked={statusFilter === value} className={statusFilter === value ? 'is-selected' : ''} key={value} onClick={() => { setStatusFilter(value); setFilterOpen(false); }}><span>{label}</span>{statusFilter === value && <CircleCheckBig size={16} />}</button>)}</div></div>}</div></div></div>
          <div className="category-tabs" role="tablist" aria-label={copy.categoryLabel} style={{ '--active-index': activeCategoryIndex, '--category-count': categories.length } as React.CSSProperties}>
            <span className="category-indicator" data-testid="category-indicator" data-active-index={activeCategoryIndex} aria-hidden="true" />
            {categories.map((item) => <button key={item} role="tab" aria-selected={category === item} className={category === item ? 'is-active' : ''} onClick={() => setCategory(item)}><span>{categoryLabels[item]?.[locale] ?? item}</span></button>)}
          </div>
          <div className="result-meta"><span>{copy.foundPrefix} <strong>{filteredApps.length}</strong> {copy.foundSuffix}</span><span>{copy.sort}</span></div>
          {appsLoading ? <div className="catalog-skeleton" aria-label="正在加载应用"><i /><i /><i /></div> : appsError ? <div className="empty-state is-error"><Search size={30} /><h3>应用目录加载失败</h3><p>{appsError}</p><Link href="/login">重新登录</Link></div> : filteredApps.length ? <div className="app-grid app-grid--transition" key={`${locale}-${category}-${favoritesOnly}-${statusFilter}`}>{filteredApps.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((app, index) => <AppCard key={app.id} app={app} index={index} favorite={favorites.includes(app.id)} locale={locale} onFavorite={() => toggleFavorite(app.id)} onOpen={() => openApp(app)} />)}</div> : <div className="empty-state"><Search size={30} /><h3>{copy.emptyTitle}</h3><p>{copy.emptyBody}</p><button type="button" onClick={() => { setQuery(''); setCategory('全部应用'); setFavoritesOnly(false); setStatusFilter('all'); }}>{copy.clear}</button></div>}
          {!appsLoading && !appsError && <AntPagination ariaLabel="应用目录分页" current={currentPage} total={filteredApps.length} pageSize={pageSize} onChange={setPage} onPageSizeChange={setPageSize} />}
        </section>
      </main>
      {profileCenterOpen && <Modal className="profile-password-modal" title={copy.profile} onClose={() => setProfileCenterOpen(false)}><section className="profile-center"><header><span className="profile-center__avatar">{currentUser?.name.slice(0, 1) ?? '访'}</span><div><h3>{currentUser?.name ?? (locale === 'zh' ? '访客' : 'Guest')}</h3><p>{currentUser?.email ?? (locale === 'zh' ? '当前未登录' : 'Not signed in')}</p></div><span className={`state-badge ${currentUser ? 'is-enabled' : 'is-disabled'}`}>{currentUser ? (locale === 'zh' ? '账号正常' : 'Active') : (locale === 'zh' ? '未登录' : 'Signed out')}</span></header><dl><div><dt>{locale === 'zh' ? '企业工号' : 'Employee ID'}</dt><dd>{currentUser?.employeeNo ?? '—'}</dd></div><div><dt>{locale === 'zh' ? '所属部门' : 'Department'}</dt><dd>{currentUser?.department ?? '—'}</dd></div><div><dt>{locale === 'zh' ? '平台角色' : 'Role'}</dt><dd>{currentUser?.role ?? '—'}</dd></div><div><dt>{locale === 'zh' ? '最近登录' : 'Last login'}</dt><dd>{currentUser?.lastLogin ?? '—'}</dd></div></dl>{currentUser && <section className="profile-password-section"><h3>修改密码</h3><PasswordChangeForm /></section>}<footer className="modal-actions"><button className="primary-action" type="button" onClick={() => setProfileCenterOpen(false)}>{locale === 'zh' ? '关闭' : 'Close'}</button></footer></section></Modal>}
      <div className={`toast${notice ? ' is-visible' : ''}`} role="status" aria-live="polite">{notice}</div>
    </div>
  );
}
