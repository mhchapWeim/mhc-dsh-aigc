/* eslint-disable @next/next/no-img-element */
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, CircleCheckBig, Clock3, Download, FilePlus2, Heart, Languages, LogOut, Moon, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Sun, UserRound } from 'lucide-react';
import { AppCatalogGrid } from './app-catalog-grid';
import { InboxBell } from './inbox-bell';
import { PasswordChangeForm } from './password-change-form';
import { Modal } from './modal';
import { usePlatform } from './platform-provider';
import { categoryLabels, localizeApp, portalCopy, type PortalLocale } from '../lib/portal-i18n';
import type { PortalApp } from '../lib/types';
import { clearSession, getCatalogApps, getRecentCatalogApps, getRegisteredAppAccess } from '../lib/api-client';
import type { RecentCatalogApp } from '../lib/api-client';

type Theme = 'light' | 'dark';
type StatusFilter = 'all' | '运行中';

export function PortalShell() {
  const router = useRouter();
  const { currentUserId, users, dispatch } = usePlatform();
  const currentUser = users.find((user) => user.id === currentUserId);
  const searchRef = useRef<HTMLInputElement>(null);
  const catalogRef = useRef<HTMLElement>(null);
  const [apps, setApps] = useState<PortalApp[]>([]);
  const [appsLoading, setAppsLoading] = useState(true);
  const [appsError, setAppsError] = useState('');
  const [recent, setRecent] = useState<RecentCatalogApp[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部应用');
  const [subcategory, setSubcategory] = useState('');
  const [favorites, setFavorites] = useState<string[]>([]);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [notice, setNotice] = useState('');
  const accessPending = useRef(false);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileCenterOpen, setProfileCenterOpen] = useState(false);
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
          nameEn: item.nameEn, descriptionEn: item.descriptionEn, ownerEn: item.ownerEn,
          categoryEn: item.categoryEn, registered: item.registered, subcategory: item.subcategory, subcategoryId: item.subcategoryId, clicks: item.clicks, totalClicks: item.totalClicks,
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

  // Recency is per account, so it is fetched independently of the shared catalog and
  // never substituted with placeholder entries: an empty strip means nothing was opened yet.
  const loadRecent = useCallback(() => {
    getRecentCatalogApps(6).then(setRecent).catch(() => { setRecent([]); });
  }, []);
  useEffect(() => { loadRecent(); }, [loadRecent]);

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
        setFilterOpen(false);
        setProfileOpen(false);
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  const categories = useMemo(() => ['全部应用', ...Array.from(new Set(apps.map((app) => app.category)))], [apps]);
  const localizedApps = useMemo(() => apps.map((app) => localizeApp(app, locale)), [apps, locale]);
  const subcategories = useMemo(() => Array.from(new Map(apps.filter(app => app.subcategory && (category === '全部应用' || app.category === category)).map(app => [app.subcategoryId || app.subcategory!, {value: app.subcategoryId || app.subcategory!, label: category === '全部应用' ? `${app.category} / ${app.subcategory}` : app.subcategory!}])).values()), [apps, category]);
  const filteredApps = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return localizedApps.filter((app) => {
      const searchable = [app.name, app.description, app.category, app.subcategory, app.owner, ...app.tags].join(' ').toLowerCase();
      return (!normalized || searchable.includes(normalized)) && (category === '全部应用' || app.category === category) && (!subcategory || (app.subcategoryId || app.subcategory) === subcategory) && (!favoritesOnly || favorites.includes(app.id)) && (statusFilter === 'all' || app.status === statusFilter);
    });
  }, [category, subcategory, favorites, favoritesOnly, localizedApps, query, statusFilter]);

  const toggleFavorite = (id: string) => setFavorites((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const openApp = (app: PortalApp) => {
    if (app.registered) {
      if (accessPending.current) return;
      accessPending.current = true;
      setNotice('');
      getRegisteredAppAccess(app.id).then(({ accessUrl, clicks, totalClicks }) => {
        if (clicks || totalClicks !== undefined) setApps(current => current.map(item => item.id === app.id ? {...item, ...(clicks ? { clicks } : {}), ...(totalClicks === undefined ? {} : { totalClicks })} : item));
        const target = new URL(accessUrl);
        if (!['http:', 'https:'].includes(target.protocol)) throw new Error('应用地址无效');
        // Authorization must finish before creating any tab, including blank tabs.
        const popup = window.open(target.toString(), '_blank');
        if (popup) popup.opener = null;
        else setNotice(locale === 'zh' ? '请允许浏览器弹出窗口后重试' : 'Please allow pop-ups and try again');
        loadRecent();
      }).catch(() => { setNotice(locale === 'zh' ? '无权访问该应用或应用已停用，请联系管理员' : 'Access denied or application unavailable. Contact an administrator.'); })
        .finally(() => { accessPending.current = false; });
      return;
    }
    let target: URL;
    try { target = new URL(app.accessUrl); }
    catch { setNotice(locale === 'zh' ? '应用地址无效，请联系平台管理员' : 'The application URL is invalid'); return; }
    if (!['http:', 'https:'].includes(target.protocol)) {
      setNotice(locale === 'zh' ? '应用地址无效，请联系平台管理员' : 'The application URL is invalid');
      return;
    }
    setNotice(copy.opening(app.name));
    window.setTimeout(() => {
      window.open(target.toString(), '_blank', 'noopener,noreferrer');
      // A published launch is not recorded server-side, so the strip cannot learn
      // about it from a click row; it reflects this session's order until reload.
      setRecent(current => [{ id: app.id, name: app.name, registered: false, lastUsedAt: new Date().toISOString() },
        ...current.filter(item => item.id !== app.id)].slice(0, 6));
    }, 180);
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
            <InboxBell locale={locale} />
            <Link className="publish-link desktop-only" href="/admin/publications"><FilePlus2 size={17} />{locale === 'zh' ? '发布应用' : 'Publish app'}</Link>
            <Link className="admin-link desktop-only" href="/admin"><Settings2 size={17} />{copy.admin}</Link>
            <div className="profile-wrap"><button className="profile-button" type="button" aria-label={copy.openProfile} aria-expanded={profileOpen} onClick={() => setProfileOpen((current) => !current)}><span className="avatar">{currentUser?.name.slice(0, 1) ?? '访'}</span><span className="desktop-only">{currentUser?.employeeNo ?? (locale === 'zh' ? '未登录' : 'Guest')}</span><ChevronDown size={15} /></button>{profileOpen&&<div className="profile-menu"><div className="profile-menu__user"><span className="avatar">{currentUser?.name.slice(0, 1) ?? '访'}</span><span><strong>{currentUser?.name ?? (locale === 'zh' ? '访客' : 'Guest')}</strong><small>{currentUser?.email ?? (locale === 'zh' ? '请先登录' : 'Please sign in')}</small></span></div><Link href="/admin/usage"><SlidersHorizontal size={17}/>{locale === 'zh' ? '我的用量' : 'My usage'}</Link><Link href="/admin"><Settings2 size={17}/>{copy.enterAdmin}</Link><button type="button" onClick={() => { setProfileOpen(false); setProfileCenterOpen(true); }}><UserRound size={17}/>{copy.profile}</button><button className="logout-button" type="button" onClick={logout}><LogOut size={17}/>{copy.logout}</button></div>}</div>
          </nav>
        </header>
      </div>
      <main className="portal-main" id="main-content">
        <section className="hero-panel">
          <div className="hero-copy">
            <span className="hero-kicker"><Sparkles size={15} /> {copy.workspace}</span>
            <h1>AIGC Agent Hub<span>{copy.titleLead}<br /><em>{copy.titleAccent}</em></span></h1>
            <p>{copy.intro}</p>
            <label className="hero-search"><Search size={21} aria-hidden="true" /><input ref={searchRef} type="search" placeholder={copy.searchPlaceholder} aria-label={copy.searchLabel} value={query} onChange={(event) => { setQuery(event.target.value); }} onKeyDown={handleSearchKeyDown} /><kbd>Ctrl K</kbd></label>
          </div>
          <aside className="hero-overview" aria-label={copy.platformOverview}><header><span>{copy.platformOverview}</span><CircleCheckBig size={19} aria-hidden="true" /></header><div className="overview-primary"><strong>{localizedApps.length}</strong><span>{copy.appsMetric}<small>{Math.max(0, categories.length - 1)} {locale === 'zh' ? '个业务分类' : 'categories'}</small></span></div><div className="overview-grid"><span><strong>{runningCount}</strong><small>{copy.runningApps}</small></span><span><strong>{Math.max(0, categories.length - 1)}</strong><small>{locale === 'zh' ? '应用分类' : 'Categories'}</small></span></div><footer><ShieldCheck size={17} aria-hidden="true" /><span><strong>{copy.secure}</strong><small>{copy.auth}</small></span></footer></aside>
        </section>
        {recent.length > 0 && <section className="recent-strip" aria-label={copy.recent}><span><Clock3 size={16} />{copy.recent}</span>{recent.map(item => <button key={item.id} type="button" onClick={() => { const match = apps.find(app => app.id === item.id); if (match) openApp(match); }}>{item.name}</button>)}</section>}
        <section ref={catalogRef} className="catalog-section" aria-labelledby="catalog-title" tabIndex={-1}>
          <div className="section-heading"><div><h2 id="catalog-title">{copy.catalogTitle}</h2><p>{copy.catalogIntro}</p></div><div className="catalog-actions"><button className={`filter-button${favoritesOnly ? ' is-active' : ''}`} type="button" onClick={() => { setFavoritesOnly(!favoritesOnly); }} aria-pressed={favoritesOnly}><Heart size={17} />{copy.favorites}</button><div className="catalog-filter-wrap"><button className={`filter-button${statusFilter !== 'all' ? ' is-active' : ''}`} type="button" aria-expanded={filterOpen} onClick={() => setFilterOpen((current) => !current)}><SlidersHorizontal size={17} />{copy.filter}</button>{filterOpen && <div className="catalog-filter-popover" role="dialog" aria-label={copy.filterPanel}><strong>{copy.statusFilter}</strong><div role="radiogroup" aria-label={copy.statusFilter}>{([['all', copy.allStatus], ['运行中', locale === 'zh' ? '运行中' : 'Running']] as Array<[StatusFilter, string]>).map(([value, label]) => <button type="button" role="radio" aria-checked={statusFilter === value} className={statusFilter === value ? 'is-selected' : ''} key={value} onClick={() => { setStatusFilter(value); setFilterOpen(false); }}><span>{label}</span>{statusFilter === value && <CircleCheckBig size={16} />}</button>)}</div></div>}</div></div></div>
          <div className="category-tabs" role="tablist" aria-label={copy.categoryLabel} style={{ '--active-index': activeCategoryIndex, '--category-count': categories.length } as React.CSSProperties}>
            <span className="category-indicator" data-testid="category-indicator" data-active-index={activeCategoryIndex} aria-hidden="true" />
            {categories.map((item) => <button key={item} role="tab" aria-selected={category === item} className={category === item ? 'is-active' : ''} onClick={() => { setCategory(item); setSubcategory(''); }}><span>{(locale === 'en' ? apps.find(app => app.category === item && app.categoryEn)?.categoryEn : undefined) || categoryLabels[item]?.[locale] || item}</span></button>)}
          </div>
          <div className="result-meta"><span>{copy.foundPrefix} <strong>{filteredApps.length}</strong> {copy.foundSuffix}</span><span>{copy.sort}</span></div>
          {subcategories.length > 0 && <div className="subcategory-filters" role="group" aria-label={locale === 'zh' ? '二级分类' : 'Subcategories'}><button type="button" aria-pressed={!subcategory} onClick={() => { setSubcategory(''); }}>{locale === 'zh' ? '全部二级分类' : 'All subcategories'}</button>{subcategories.map(option => <button key={option.value} type="button" aria-pressed={subcategory === option.value} onClick={() => { setSubcategory(option.value); }}>{option.label}</button>)}</div>}
          {appsLoading ? <div className="catalog-skeleton" aria-label="正在加载应用"><i /><i /><i /></div> : appsError ? <div className="empty-state is-error"><Search size={30} /><h3>应用目录加载失败</h3><p>{appsError}</p><Link href="/login">重新登录</Link></div> : filteredApps.length ? <AppCatalogGrid key={JSON.stringify([locale, query, category, subcategory, favoritesOnly, statusFilter])} apps={filteredApps} locale={locale} favorites={favorites} onFavorite={toggleFavorite} onOpen={openApp}/> : <div className="empty-state"><Search size={30} /><h3>{copy.emptyTitle}</h3><p>{copy.emptyBody}</p><button type="button" onClick={() => { setQuery(''); setCategory('全部应用'); setSubcategory(''); setFavoritesOnly(false); setStatusFilter('all'); }}>{copy.clear}</button></div>}
        </section>
      </main>
      {profileCenterOpen && <Modal className="profile-password-modal" title={copy.profile} onClose={() => setProfileCenterOpen(false)}><section className="profile-center"><header><span className="profile-center__avatar">{currentUser?.name.slice(0, 1) ?? '访'}</span><div><h3>{currentUser?.name ?? (locale === 'zh' ? '访客' : 'Guest')}</h3><p>{currentUser?.email ?? (locale === 'zh' ? '当前未登录' : 'Not signed in')}</p></div><span className={`state-badge ${currentUser ? 'is-enabled' : 'is-disabled'}`}>{currentUser ? (locale === 'zh' ? '账号正常' : 'Active') : (locale === 'zh' ? '未登录' : 'Signed out')}</span></header><dl><div><dt>{locale === 'zh' ? '企业工号' : 'Employee ID'}</dt><dd>{currentUser?.employeeNo ?? '—'}</dd></div><div><dt>{locale === 'zh' ? '所属部门' : 'Department'}</dt><dd>{currentUser?.department ?? '—'}</dd></div><div><dt>{locale === 'zh' ? '平台角色' : 'Role'}</dt><dd>{currentUser?.role ?? '—'}</dd></div><div><dt>{locale === 'zh' ? '最近登录' : 'Last login'}</dt><dd>{currentUser?.lastLogin ?? '—'}</dd></div></dl>{currentUser && <section className="profile-password-section"><h3>修改密码</h3><PasswordChangeForm /></section>}<footer className="modal-actions"><button className="primary-action" type="button" onClick={() => setProfileCenterOpen(false)}>{locale === 'zh' ? '关闭' : 'Close'}</button></footer></section></Modal>}
      <div className={`toast${notice ? ' is-visible' : ''}`} role="status" aria-live="polite">{notice}</div>
    </div>
  );
}
