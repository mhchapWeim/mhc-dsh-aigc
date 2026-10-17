"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { clearSession } from "../../lib/api-client";
import {
  Bell,
  Download,
  Boxes,
  Bot,
  KeyRound,
  ScrollText,
  Building2,
  House,
  ChevronDown,
  ClipboardCheck,
  FilePlus2,
  Files,
  Grid2X2,
  LogOut,
  Menu,
  Network,
  PanelLeftClose,
  ShieldCheck,
  ShieldAlert,
  Tags,
  Users,
  X,
} from "lucide-react";
import { usePlatform } from "../../components/platform-provider";
import {
  canAccessAdminPath,
  canReviewPublication,
} from "../../lib/platform-state";

const sections = [
  {
    label: "协作与发布",
    icon: Grid2X2,
    items: [
      { href: "/admin", label: "工作台", icon: Grid2X2 },
      { href: "/admin/publications", label: "发布申请", icon: FilePlus2 },
      { href: "/admin/reviews", label: "发布审核", icon: ClipboardCheck },
      { href: "/admin/processes", label: "流程设计", icon: Network },
      { href: "/admin/categories", label: "分类管理", icon: Tags },
    ],
  },
  {
    label: "组织与权限",
    icon: Users,
    items: [

      { href: "/admin/users", label: "用户管理", icon: Users },
      { href: "/admin/departments", label: "部门管理", icon: Building2 },

      { href: "/admin/roles", label: "角色管理", icon: ShieldCheck },
    ],
  },
  {
    label: "模型与安全",
    icon: ShieldCheck,
    items: [
      { href: "/admin/models", label: "模型管理", icon: Bot },
      { href: "/admin/virtual-keys", label: "虚拟 Key", icon: KeyRound },
      { href: "/admin/audits", label: "操作审计", icon: ScrollText },
      { href: "/admin/sensitive-words", label: "敏感词管理", icon: ShieldAlert },
    ],
  },
  {
    label: "客户端运维",
    icon: Boxes,
    items: [
      { href: "/admin/uploads", label: "附件审查", icon: Files },
      { href: "/admin/announcements", label: "公告管理", icon: Bell },
      { href: "/admin/client-releases", label: "发布上报", icon: Download },
      { href: "/admin/dsh-feedback", label: "用户反馈", icon: ScrollText },
      { href: "/admin/dsh-backups", label: "客户端备份", icon: Files },
      { href: "/admin/dsh-failures", label: "失败日志", icon: ScrollText },
    ],
  },
  {
    label: "插件市场",
    icon: Boxes,
    items: [
      { href: "/admin/plugins", label: "插件管理", icon: Boxes },
      { href: "/admin/plugins/status", label: "插件状态", icon: ScrollText },
    ],
  },
];
const items = sections.flatMap((section) => section.items);
type StoredAdminUser = { id: string; name: string; employeeNo: string; roles: string[]; permissions: string[] };

export function AdminShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [expandedGroup, setExpandedGroup] = useState<string | null>(() => sections.find(section => section.items.some(item => item.href === path))?.label ?? null);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [flyout, setFlyout] = useState<{ label: string; top: number; left: number } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHide = () => { if (hoverTimer.current !== null) clearTimeout(hoverTimer.current); };
  const hideFlyout = () => { cancelHide(); hoverTimer.current = setTimeout(() => setFlyout(null), 150); };
  useEffect(() => () => { if (hoverTimer.current !== null) clearTimeout(hoverTimer.current); }, []);
  const showFlyout = (element: HTMLElement, label: string) => {
    if (!collapsed) return;
    cancelHide();
    const rect = element.getBoundingClientRect();
    const sidebar = element.closest('aside')?.getBoundingClientRect();
    setFlyout({ label, left: sidebar?.right ?? rect.right, top: Math.max(8, Math.min(rect.top, window.innerHeight - 340)) });
  };
  const platform = usePlatform();
  const { currentUserId, users, publicationRequests, dispatch } = platform;
  const [storedUser, setStoredUser] = useState<StoredAdminUser | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { setCollapsed(localStorage.getItem('aigc-admin-sidebar') === 'collapsed'); } catch { /* Keep the default when browser storage is unavailable. */ }
      try { setStoredUser(JSON.parse(localStorage.getItem("aigc_hub_user") ?? "null") as StoredAdminUser | null); }
      catch { setStoredUser(null); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const currentUser = users.find((user) => user.id === currentUserId) ?? (storedUser ? {
    id: storedUser.id, name: storedUser.name, employeeNo: storedUser.employeeNo, email: '', department: '',
    role: storedUser.roles[0] ?? '', status: '启用' as const, lastLogin: '当前登录',
  } : undefined);
  const pendingReviews = publicationRequests.filter((request) =>
    canReviewPublication(currentUser, request),
  ).length;
  const permissionByPath: Record<string, string> = {
    '/admin': 'admin.view', '/admin/publications': 'publication.create', '/admin/reviews': 'publication.review',
    '/admin/processes': 'process.design', '/admin/users': 'user.manage', '/admin/departments': 'department.manage',
    '/admin/categories': 'category.manage', '/admin/roles': 'role.manage', '/admin/models': 'model.manage', '/admin/virtual-keys': 'model.manage', '/admin/audits': 'model.manage',
    '/admin/sensitive-words': 'model.manage', '/admin/uploads': 'model.manage',
    '/admin/announcements': 'announcement.manage', '/admin/client-releases': 'client-release.manage',
    '/admin/dsh-failures': 'diagnostic.manage', '/admin/dsh-feedback': 'diagnostic.manage',
    '/admin/plugins': 'plugin.manage', '/admin/plugins/status': 'plugin.manage',
  };
  const canAccess = (target: string) => target === '/admin/dsh-backups' ? Boolean(storedUser || currentUser) : storedUser
    ? storedUser.permissions.includes(permissionByPath[target] ?? 'admin.view')
    : canAccessAdminPath(platform, currentUser, target);
  const canOpenReviews = canAccess('/admin/reviews');
  const hasAccess = canAccess(path);
  const active = items.find((item) => item.href === path) ?? items[0];
  return (
    <div className={`admin-app${collapsed ? " is-collapsed" : ""}`}>
      <a className="skip-link" href="#admin-main">
        跳转到主要内容
      </a>
      <button
        className="mobile-menu-button"
        type="button"
        aria-label="打开后台导航"
        onClick={() => setMobileOpen(true)}
      >
        <Menu size={20} />
      </button>
      {mobileOpen && (
        <button
          className="sidebar-scrim"
          type="button"
          aria-label="关闭后台导航"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside className={`admin-sidebar${mobileOpen ? " is-open" : ""}`}>
        <div className="admin-brand">
          <span className="admin-brand__mark">
            <Boxes size={21} />
          </span>
          <span className="admin-brand__copy">
            <strong>AIGC Hub</strong>
            <small>管理控制台</small>
          </span>
          <button
            className="sidebar-mobile-close"
            type="button"
            aria-label="关闭后台导航"
            onClick={() => setMobileOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        <nav className="admin-nav" aria-label="后台导航">
          {sections.filter(section => section.items.some(item => canAccess(item.href))).map((section) => (
            <div className={`admin-nav-group${section.items.some(item => item.href === path) ? ' has-active' : ''}`} key={section.label} onMouseLeave={hideFlyout}>
              <button type="button" className="admin-nav-toggle" title={section.label}
                aria-label={section.label}
                aria-expanded={collapsed ? flyout?.label === section.label : expandedGroup === section.label}
                onMouseEnter={event => showFlyout(event.currentTarget, section.label)}
                onFocus={event => showFlyout(event.currentTarget, section.label)}
                onKeyDown={event => { if (event.key === 'Escape') { cancelHide(); setFlyout(null); } }}
                onClick={event => { if (collapsed) showFlyout(event.currentTarget, section.label); else setExpandedGroup(value => value === section.label ? null : section.label); }}>
                <section.icon size={18} className="admin-nav-group-icon" /><span>{section.label}</span><ChevronDown size={15} className="admin-nav-chevron" />
              </button>
              <div className="admin-nav-children" hidden={collapsed || expandedGroup !== section.label}>
              {section.items
                .filter(
                  (item) =>
                    canAccess(item.href) &&
                    (item.href !== "/admin/reviews" || canOpenReviews),
                )
                .map((item) => {
                  const Icon = item.icon;
                  const selected = path === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={item.label}
                      aria-label={item.label}
                      className={selected ? "is-active" : ""}
                      aria-current={selected ? "page" : undefined}
                      onClick={() => setMobileOpen(false)}
                    >
                      <Icon size={19} />
                      <span>{item.label}</span>
                      {item.href === "/admin/reviews" && pendingReviews > 0 && (
                        <b
                          className="nav-badge"
                          aria-label={`${pendingReviews}项待审核`}
                        >
                          {pendingReviews}
                        </b>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Link href="/" title="返回应用门户">
            <House size={18} />
            <span>返回应用门户</span>
          </Link>
          <Link href="/login?sso=logged-out" title="退出登录" className="sidebar-bottom-logout" onClick={() => { window.sessionStorage.setItem('aigc-explicit-logout', '1'); clearSession(); dispatch({ type: "logout" }); }}>
            <LogOut size={18} />
            <span>退出登录</span>
          </Link>
          <button
            type="button"
            aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
            title={collapsed ? "展开侧边栏" : "收起侧边栏"}
            onClick={() => {
              cancelHide(); setFlyout(null);
              const next = !collapsed;
              setCollapsed(next);
              try { localStorage.setItem('aigc-admin-sidebar', next ? 'collapsed' : 'expanded'); } catch { /* Navigation remains usable without browser storage. */ }
            }}
          >
            <PanelLeftClose size={18} />
            <span>{collapsed ? '展开侧边栏' : '收起侧边栏'}</span>
          </button>
        </div>
      </aside>
      {collapsed && flyout && <div className="admin-nav-flyout" style={{ top: flyout.top, left: flyout.left }}
        onMouseEnter={cancelHide} onMouseLeave={hideFlyout} onFocus={cancelHide}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hideFlyout(); }}
        onKeyDown={event => { if (event.key === 'Escape') { cancelHide(); setFlyout(null); } }}>
        <nav aria-label={`${flyout.label}子菜单`}><strong>{flyout.label}</strong>
          {sections.find(section => section.label === flyout.label)?.items.filter(item => canAccess(item.href)).map(item => <Link
            key={item.href} href={item.href} aria-current={path === item.href ? 'page' : undefined}
            onClick={() => { cancelHide(); setFlyout(null); setMobileOpen(false); }}>
            <item.icon size={17} /><span>{item.label}</span>
          </Link>)}
        </nav>
      </div>}
      <div className="admin-workspace">
        <header className="admin-topbar">
          <div>
            <span>平台管理 /</span>
            <strong>{active.label}</strong>
          </div>
          <div className="admin-user">
            <span className="avatar">
              {currentUser?.name.slice(0, 1) ?? "W"}
            </span>
            <span>
              <strong>{currentUser?.name ?? "未登录"}</strong>
              <small>{currentUser?.role ?? "访客"}</small>
            </span>
          </div>
        </header>
        <main className="admin-content" id="admin-main">
          <div className="admin-route-transition" key={path}>
            {hasAccess ? (
              children
            ) : (
              <section className="access-denied">
                <ShieldCheck size={34} />
                <h1>无权访问此页面</h1>
                <p>
                  当前角色“{currentUser?.role ?? "未登录"}
                  ”未获得该页面权限，请联系平台管理员。
                </p>
                <Link href="/">返回平台主界面</Link>
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
