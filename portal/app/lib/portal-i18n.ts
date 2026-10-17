import type { PortalApp } from './types';

export type PortalLocale = 'zh' | 'en';

export const categoryLabels: Record<string, Record<PortalLocale, string>> = {
  全部应用: { zh: '全部应用', en: 'All apps' },
  智慧服务: { zh: '智慧服务', en: 'Smart services' },
  知识智能: { zh: '知识智能', en: 'Knowledge AI' },
  效率办公: { zh: '效率办公', en: 'Productivity' },
  研发创新: { zh: '研发创新', en: 'R&D innovation' },
};

export const portalCopy = {
  zh: {
    skip: '跳转到主要内容', subtitle: '企业智能应用中台', globalActions: '全局操作', light: '明亮', dark: '深色', switchDark: '切换到深色模式', switchLight: '切换到明亮模式', language: '中文', switchLanguage: 'Switch to English', notification: '通知', inboxTitle: '站内信', inboxUnread: '2 条未读消息', approvalMessage: '内容发布申请待审批', approvalMeta: '内容运营组提交了新的发布申请', maintenanceMessage: '合同审阅助手维护通知', maintenanceMeta: '应用将在维护完成后恢复访问', admin: '管理后台', openProfile: '打开用户菜单', enterAdmin: '进入管理后台', profile: '个人中心', logout: '退出登录',
    workspace: 'AI 工作空间', titleLead: '让每一个业务场景，', titleAccent: '都能快速连接智能能力', intro: '统一发现、访问与管理企业内部 Agent 和数字化应用，让可靠的 AI 能力触手可及。', searchPlaceholder: '搜索 Agent、应用场景或标签', searchLabel: '搜索应用', recent: '最近使用', meeting: '会议纪要 Copilot', quality: '质量知识助手', appsMetric: '可用应用', scenes: '覆盖 4 类业务场景', weekly: '累计使用', runningApps: '运行中', platformOverview: '平台概览', secure: '企业级安全', auth: '内部统一认证', catalogKicker: 'APPLICATION CATALOG', catalogTitle: '发现适合你的智能应用', catalogIntro: '按业务场景浏览，快速进入日常工作所需的智能能力。', favorites: '我的收藏', filter: '筛选', filterPanel: '筛选应用', statusFilter: '运行状态', allStatus: '全部状态', categoryLabel: '应用分类', foundPrefix: '为你找到', foundSuffix: '个应用', sort: '按推荐排序', emptyTitle: '没有找到匹配的应用', emptyBody: '换一个关键词，或清除当前筛选条件。', clear: '清除筛选', opening: (name: string) => `正在进入「${name}」`, unavailable: (name: string) => `${name}维护中，暂不可进入`, enter: '进入', uses: '次使用', favorite: '收藏', unfavorite: '取消收藏',
  },
  en: {
    skip: 'Skip to main content', subtitle: 'Enterprise AI Application Hub', globalActions: 'Global actions', light: 'Light', dark: 'Dark', switchDark: 'Switch to dark mode', switchLight: 'Switch to light mode', language: 'EN', switchLanguage: '切换到中文', notification: 'Notifications', inboxTitle: 'Inbox', inboxUnread: '2 unread messages', approvalMessage: 'Content publishing request needs approval', approvalMeta: 'Submitted by Content Operations', maintenanceMessage: 'Contract Review maintenance notice', maintenanceMeta: 'Access returns when maintenance is complete', admin: 'Admin console', openProfile: 'Open user menu', enterAdmin: 'Open admin console', profile: 'Profile', logout: 'Sign out',
    workspace: 'AI WORKSPACE', titleLead: 'Connect every business scenario,', titleAccent: 'to intelligence in seconds', intro: 'Discover, access and manage internal agents and digital applications from one reliable enterprise AI hub.', searchPlaceholder: 'Search agents, scenarios or tags', searchLabel: 'Search applications', recent: 'Recently used', meeting: 'Meeting Copilot', quality: 'Quality Knowledge Assistant', appsMetric: 'Available apps', scenes: 'Across 4 business scenarios', weekly: 'Total uses', runningApps: 'Running', platformOverview: 'Platform overview', secure: 'Enterprise security', auth: 'Unified internal identity', catalogKicker: 'APPLICATION CATALOG', catalogTitle: 'Find the right intelligent application', catalogIntro: 'Browse by business scenario and enter the capabilities you need for everyday work.', favorites: 'Favorites', filter: 'Filter', filterPanel: 'Filter applications', statusFilter: 'Status', allStatus: 'All statuses', categoryLabel: 'Application categories', foundPrefix: '', foundSuffix: 'applications found', sort: 'Recommended', emptyTitle: 'No matching applications', emptyBody: 'Try another keyword or clear the current filters.', clear: 'Clear filters', opening: (name: string) => `Opening “${name}”`, unavailable: (name: string) => `${name} is under maintenance and cannot be opened`, enter: 'Open', uses: 'uses', favorite: 'Add to favorites: ', unfavorite: 'Remove from favorites: ',
  },
} as const;

type EnglishAppCopy = Pick<PortalApp, 'name' | 'description' | 'tags' | 'owner'>;

export const englishApps: Record<string, EnglishAppCopy> = {
  'hui-assistant': { name: 'Hui HR Assistant', description: 'One-stop access to HR policies covering attendance, overtime, performance, leave and business travel.', tags: ['HR service', 'Policy Q&A'], owner: 'Human Resources' },
  'quality-knowledge': { name: 'Quality Knowledge Assistant', description: 'Search quality standards, issue cases and resolution experience to support shop-floor decisions.', tags: ['Quality', 'Knowledge base'], owner: 'Quality Management' },
  'employee-partner': { name: 'Employee Companion', description: 'An employee companion for onboarding, recruiting, training and attendance enquiries.', tags: ['Employee service', '24/7'], owner: 'Human Resources' },
  'meeting-copilot': { name: 'Meeting Copilot', description: 'Turn meetings into clear summaries, action items and accountable owners.', tags: ['Meeting notes', 'Collaboration'], owner: 'Digital Office' },
  'contract-review': { name: 'Contract Review Assistant', description: 'Identify risky clauses and provide review suggestions to shorten legal review cycles.', tags: ['Legal', 'Risk detection'], owner: 'Legal' },
  'code-companion': { name: 'R&D Code Companion', description: 'Internal code Q&A, standards checks and solution assistance for engineering teams.', tags: ['Engineering', 'Code assistant'], owner: 'R&D Center' },
};

export function localizeApp(app: PortalApp, locale: PortalLocale): PortalApp {
  if (locale === 'zh') return app;
  const translated = englishApps[app.id];
  return translated ? { ...app, ...translated } : app;
}
