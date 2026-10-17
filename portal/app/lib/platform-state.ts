export type UserStatus = '启用' | '停用';
export type UserRole = string;
export type AdminPath = '/admin' | '/admin/publications' | '/admin/reviews' | '/admin/processes' | '/admin/users' | '/admin/departments' | '/admin/categories' | '/admin/roles' | '/admin/models' | '/admin/virtual-keys' | '/admin/audits' | '/admin/sensitive-words' | '/admin/uploads' | '/admin/announcements' | '/admin/client-releases' | '/admin/dsh-feedback' | '/admin/dsh-failures' | '/admin/plugins' | '/admin/dsh-backups';

export type PlatformUser = {
  id: string;
  name: string;
  employeeNo: string;
  email: string;
  department: string;
  role: UserRole;
  status: UserStatus;
  lastLogin: string;
};

export type PlatformCategory = {
  id: string;
  code?: string;
  name: string;
  description: string;
  color: string;
  appCount: number;
  enabled: boolean;
  order: number;
};
export type PlatformDepartment = { id: string; code?: string; name: string; manager: string; description: string; enabled: boolean };
export type PlatformRole = { id: string; code?: string; name: string; description: string; permissions: AdminPath[]; builtIn: boolean };

export type PublicationStatus = '草稿' | '审核中' | '发布中' | '已通过' | '已退回' | '发布失败';
export type ReviewDecision = '通过' | '退回';

export type PublicationRequest = {
  id: string;
  appName: string;
  category: string;
  summary: string;
  accessUrl: string;
  applicantId: string;
  applicantName: string;
  applicantDepartment: string;
  status: PublicationStatus;
  currentNodeId: string;
  currentNodeName: string;
  currentAssigneeIds: string[];
  currentCandidateGroups: string[];
  submittedAt: string;
  updatedAt: string;
  reviewComment?: string;
  reviewerName?: string;
  processDefinitionId: string;
  processInstanceId: string;
};

export type PlatformState = { currentUserId: string; users: PlatformUser[]; departments: PlatformDepartment[]; categories: PlatformCategory[]; roles: PlatformRole[]; rolePermissions: Record<string, AdminPath[]>; publicationRequests: PublicationRequest[]; notice: string };

export type PlatformAction =
  | { type: 'hydrate-backend'; state: Partial<PlatformState> }
  | { type: 'set-notice'; notice: string }
  | { type: 'save-user'; user: PlatformUser }
  | { type: 'toggle-user-status'; id: string }
  | { type: 'save-category'; category: PlatformCategory }
  | { type: 'toggle-category-status'; id: string }
  | { type: 'delete-category'; id: string }
  | { type: 'move-category'; id: string; direction: -1 | 1 }
  | { type: 'login'; employeeNo: string }
  | { type: 'logout' }
  | { type: 'save-department'; department: PlatformDepartment }
  | { type: 'toggle-department-status'; id: string }
  | { type: 'save-role-permissions'; role: UserRole; paths: AdminPath[] }
  | { type: 'save-role'; role: PlatformRole }
  | { type: 'delete-role'; id: string }
  | { type: 'submit-publication'; actorId: string; request: Pick<PublicationRequest, 'id' | 'appName' | 'category' | 'summary' | 'accessUrl'> }
  | { type: 'review-publication'; id: string; actorId: string; decision: ReviewDecision; comment: string }
  | { type: 'resubmit-publication'; id: string; actorId: string }
  | { type: 'clear-notice' };

export function canReviewPublication(user: PlatformUser | undefined, request: PublicationRequest) {
  if (!user || user.status !== '启用' || request.status !== '审核中' || request.currentNodeId !== 'review') return false;
  if (request.currentAssigneeIds.includes(user.id)) return true;
  return request.currentCandidateGroups.some((group) => group === `department:${user.department}` || group === `role:${user.role}`);
}

export function canResubmitPublication(user: PlatformUser | undefined, request: PublicationRequest) {
  return Boolean(user && user.status === '启用' && request.status === '已退回' && request.currentNodeId === 'revise' && request.currentAssigneeIds.includes(user.id));
}

export function canAccessAdminPath(state: PlatformState, user: PlatformUser | undefined, path: string) {
  if (!user || user.status !== '启用') return false;
  if (path === '/admin/dsh-backups') return true;
  const normalized = path === '/admin' ? '/admin' : (`/${path.split('/').filter(Boolean).slice(0, 2).join('/')}` as AdminPath);
  return (state.rolePermissions[user.role] ?? state.roles.find((role) => role.name === user.role)?.permissions ?? []).includes(normalized);
}

export function createInitialPlatformState(): PlatformState {
  return {
    currentUserId: 'u1',
    notice: '',
    users: [
      { id: 'u1', name: '姚伟明', employeeNo: 'wh00028', email: 'di.Yao@boschhuayu-steering.com', department: '数字化办公室', role: '平台管理员', status: '启用', lastLogin: '今天 10:24' },
      { id: 'u2', name: '张敏', employeeNo: 'wh00136', email: 'min.zhang@bhss.com', department: '人力资源部', role: '流程管理员', status: '启用', lastLogin: '今天 09:42' },
      { id: 'u3', name: '李俊', employeeNo: 'wh00412', email: 'jun.li@bhss.com', department: '质量管理部', role: '普通用户', status: '启用', lastLogin: '昨天 16:35' },
      { id: 'u4', name: '陈晨', employeeNo: 'wh00658', email: 'chen.chen@bhss.com', department: '研发中心', role: '普通用户', status: '停用', lastLogin: '08-18 14:20' },
      { id: 'u5', name: '王磊', employeeNo: 'wh00721', email: 'lei.wang@bhss.com', department: '法务部', role: '普通用户', status: '启用', lastLogin: '08-25 11:08' },
    ],
    departments: [
      { id: 'digital', name: '数字化办公室', manager: '姚伟明', description: '数字化平台与智能应用建设', enabled: true },
      { id: 'hr', name: '人力资源部', manager: '张敏', description: '组织与人才服务', enabled: true },
      { id: 'quality', name: '质量管理部', manager: '李俊', description: '质量体系与问题闭环', enabled: true },
      { id: 'rd', name: '研发中心', manager: '陈晨', description: '产品与软件研发', enabled: true },
      { id: 'legal', name: '法务部', manager: '王磊', description: '合同与合规管理', enabled: true },
    ],
    rolePermissions: {
      平台管理员: ['/admin', '/admin/publications', '/admin/reviews', '/admin/processes', '/admin/users', '/admin/departments', '/admin/categories', '/admin/roles', '/admin/models', '/admin/virtual-keys', '/admin/audits', '/admin/sensitive-words', '/admin/uploads', '/admin/announcements', '/admin/client-releases', '/admin/dsh-feedback', '/admin/dsh-failures', '/admin/plugins'],
      流程管理员: ['/admin', '/admin/publications', '/admin/reviews', '/admin/processes'],
      普通用户: ['/admin', '/admin/publications'],
    },
    roles: [
      { id: 'platform-admin', name: '平台管理员', description: '管理平台配置、用户与全部业务功能', permissions: ['/admin', '/admin/publications', '/admin/reviews', '/admin/processes', '/admin/users', '/admin/departments', '/admin/categories', '/admin/roles', '/admin/models', '/admin/virtual-keys', '/admin/audits', '/admin/sensitive-words', '/admin/uploads', '/admin/announcements', '/admin/client-releases', '/admin/dsh-feedback', '/admin/dsh-failures', '/admin/plugins'], builtIn: true },
      { id: 'workflow-admin', name: '流程管理员', description: '设计流程并处理应用发布审核', permissions: ['/admin', '/admin/publications', '/admin/reviews', '/admin/processes'], builtIn: true },
      { id: 'normal-user', name: '普通用户', description: '提交并跟踪自己的应用发布申请', permissions: ['/admin', '/admin/publications'], builtIn: true },
    ],
    categories: [
      { id: 'service', name: '智慧服务', description: '面向员工的人事、行政与共享服务', color: '#2465d0', appCount: 2, enabled: true, order: 1 },
      { id: 'knowledge', name: '知识智能', description: '企业知识检索、问答与风险识别', color: '#7357d9', appCount: 2, enabled: true, order: 2 },
      { id: 'office', name: '效率办公', description: '会议、协作与日常办公提效工具', color: '#d56b1c', appCount: 1, enabled: true, order: 3 },
      { id: 'research', name: '研发创新', description: '面向产品与软件研发的智能能力', color: '#0f8f91', appCount: 1, enabled: true, order: 4 },
      { id: 'marketing', name: '市场营销', description: '内容生成、客户洞察与品牌传播', color: '#aa4b74', appCount: 0, enabled: false, order: 5 },
    ],
    publicationRequests: [
      { id: 'pub-20260827-01', appName: '质量问题分析助手', category: '知识智能', summary: '聚合质量案例并生成问题分析建议。', accessUrl: 'https://internal.example/apps/quality-analysis', applicantId: 'u3', applicantName: '李俊', applicantDepartment: '质量管理部', status: '审核中', currentNodeId: 'review', currentNodeName: '应用发布审核', currentAssigneeIds: ['u1'], currentCandidateGroups: [], submittedAt: '今天 09:18', updatedAt: '今天 09:18', processDefinitionId: 'application-publishing-v1', processInstanceId: 'process-pub-20260827-01' },
      { id: 'pub-20260826-02', appName: '招聘面试 Copilot', category: '智慧服务', summary: '辅助整理候选人材料和面试问题。', accessUrl: 'https://internal.example/apps/interview', applicantId: 'u2', applicantName: '张敏', applicantDepartment: '人力资源部', status: '审核中', currentNodeId: 'review', currentNodeName: '应用发布审核', currentAssigneeIds: [], currentCandidateGroups: ['role:流程管理员'], submittedAt: '昨天 15:40', updatedAt: '昨天 15:40', processDefinitionId: 'application-publishing-v1', processInstanceId: 'process-pub-20260826-02' },
      { id: 'pub-20260824-03', appName: '研发规范问答', category: '研发创新', summary: '查询研发规范、代码检查清单和交付模板。', accessUrl: 'https://internal.example/apps/dev-standards', applicantId: 'u1', applicantName: '姚伟明', applicantDepartment: '数字化办公室', status: '已通过', currentNodeId: 'published', currentNodeName: '发布完成', currentAssigneeIds: [], currentCandidateGroups: [], submittedAt: '08-24 10:12', updatedAt: '08-25 14:08', reviewComment: '信息完整，同意发布', reviewerName: '张敏', processDefinitionId: 'application-publishing-v1', processInstanceId: 'process-pub-20260824-03' },
      { id: 'pub-20260823-04', appName: '智能工位导航', category: '效率办公', summary: '根据员工角色快速定位常用系统和工位服务。', accessUrl: 'https://internal.example/apps/workstation', applicantId: 'u1', applicantName: '姚伟明', applicantDepartment: '数字化办公室', status: '已退回', currentNodeId: 'revise', currentNodeName: '修改申请', currentAssigneeIds: ['u1'], currentCandidateGroups: [], submittedAt: '08-23 09:30', updatedAt: '08-23 16:12', reviewComment: '请补充应用负责人和安全说明', reviewerName: '张敏', processDefinitionId: 'application-publishing-v1', processInstanceId: 'process-pub-20260823-04' },
    ],
  };
}

export function platformReducer(state: PlatformState, action: PlatformAction): PlatformState {
  if (action.type === 'hydrate-backend') return { ...state, ...action.state };
  if (action.type === 'set-notice') return { ...state, notice: action.notice };
  if (action.type === 'login') {
    const user = state.users.find((item) => item.employeeNo.toLowerCase() === action.employeeNo.trim().toLowerCase() && item.status === '启用');
    return user ? { ...state, currentUserId: user.id, notice: `欢迎回来，${user.name}` } : { ...state, notice: '账号不存在或已停用' };
  }
  if (action.type === 'logout') return { ...state, currentUserId: '', notice: '已安全退出' };
  if (action.type === 'save-department') {
    const exists = state.departments.some((item) => item.id === action.department.id);
    return { ...state, departments: exists ? state.departments.map((item) => item.id === action.department.id ? action.department : item) : [...state.departments, action.department], notice: exists ? '部门信息已更新' : '部门已创建' };
  }
  if (action.type === 'toggle-department-status') return { ...state, departments: state.departments.map((item) => item.id === action.id ? { ...item, enabled: !item.enabled } : item), notice: '部门状态已更新' };
  if (action.type === 'save-role-permissions') return { ...state, roles: state.roles.map((role) => role.name === action.role ? { ...role, permissions: action.paths } : role), rolePermissions: { ...state.rolePermissions, [action.role]: action.paths }, notice: `${action.role}的页面权限已保存` };
  if (action.type === 'save-role') {
    const exists = state.roles.some((role) => role.id === action.role.id);
    if (state.roles.some((role) => role.id !== action.role.id && role.name.trim() === action.role.name.trim())) return { ...state, notice: '角色名称已存在，请使用其他名称' };
    const previous = state.roles.find((role) => role.id === action.role.id);
    const rolePermissions = { ...state.rolePermissions };
    if (previous && previous.name !== action.role.name) delete rolePermissions[previous.name];
    rolePermissions[action.role.name] = action.role.permissions;
    return { ...state, roles: exists ? state.roles.map((role) => role.id === action.role.id ? action.role : role) : [...state.roles, action.role], rolePermissions, notice: exists ? '角色信息已更新' : '角色已创建' };
  }
  if (action.type === 'delete-role') {
    const role = state.roles.find((item) => item.id === action.id);
    if (!role) return state;
    if (state.users.some((user) => user.role === role.name)) return { ...state, notice: `“${role.name}”仍有关联用户，暂不能删除` };
    const rolePermissions = { ...state.rolePermissions }; delete rolePermissions[role.name];
    return { ...state, roles: state.roles.filter((item) => item.id !== action.id), rolePermissions, notice: '角色已删除' };
  }
  if (action.type === 'save-user') {
    const exists = state.users.some((user) => user.id === action.user.id);
    return { ...state, users: exists ? state.users.map((user) => user.id === action.user.id ? action.user : user) : [action.user, ...state.users], notice: exists ? '用户信息已更新' : '用户已添加' };
  }
  if (action.type === 'toggle-user-status') return { ...state, users: state.users.map((user) => user.id === action.id ? { ...user, status: user.status === '启用' ? '停用' : '启用' } : user), notice: '用户状态已更新' };
  if (action.type === 'save-category') {
    const exists = state.categories.some((category) => category.id === action.category.id);
    return { ...state, categories: exists ? state.categories.map((category) => category.id === action.category.id ? action.category : category) : [...state.categories, action.category], notice: exists ? '分类已更新' : '分类已创建' };
  }
  if (action.type === 'toggle-category-status') return { ...state, categories: state.categories.map((category) => category.id === action.id ? { ...category, enabled: !category.enabled } : category), notice: '分类状态已更新' };
  if (action.type === 'delete-category') {
    const category = state.categories.find((item) => item.id === action.id);
    if (category?.appCount) return { ...state, notice: `“${category.name}”仍有关联应用，暂不能删除` };
    return { ...state, categories: state.categories.filter((item) => item.id !== action.id), notice: '分类已删除' };
  }
  if (action.type === 'move-category') {
    const ordered = [...state.categories].sort((a, b) => a.order - b.order);
    const index = ordered.findIndex((category) => category.id === action.id);
    const target = index + action.direction;
    if (index < 0 || target < 0 || target >= ordered.length) return state;
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    return { ...state, categories: ordered.map((category, order) => ({ ...category, order: order + 1 })), notice: '分类顺序已调整' };
  }
  if (action.type === 'submit-publication') {
    const actor = state.users.find((user) => user.id === action.actorId && user.status === '启用');
    if (!actor) return { ...state, notice: '当前用户不可提交发布申请' };
    const request: PublicationRequest = {
      ...action.request,
      applicantId: actor.id,
      applicantName: actor.name,
      applicantDepartment: actor.department,
      status: '审核中',
      currentNodeId: 'review',
      currentNodeName: '应用发布审核',
      currentAssigneeIds: [],
      currentCandidateGroups: ['role:流程管理员', 'department:数字化办公室'],
      submittedAt: '刚刚',
      updatedAt: '刚刚',
      processDefinitionId: 'application-publishing-v1',
      processInstanceId: `process-${action.request.id}`,
    };
    return { ...state, publicationRequests: [request, ...state.publicationRequests], notice: '发布申请已提交，流程已进入应用发布审核节点' };
  }
  if (action.type === 'review-publication') {
    const actor = state.users.find((user) => user.id === action.actorId);
    const request = state.publicationRequests.find((item) => item.id === action.id);
    if (!request || !canReviewPublication(actor, request)) return { ...state, notice: '当前用户无权处理此审核任务' };
    const approved = action.decision === '通过';
    return {
      ...state,
      publicationRequests: state.publicationRequests.map((item) => item.id === action.id ? {
        ...item,
        status: approved ? '已通过' : '已退回',
        currentNodeId: approved ? 'published' : 'revise',
        currentNodeName: approved ? '发布完成' : '修改申请',
        currentAssigneeIds: approved ? [] : [item.applicantId],
        currentCandidateGroups: [],
        reviewComment: action.comment,
        reviewerName: actor?.name,
        updatedAt: '刚刚',
      } : item),
      notice: approved ? '审核已通过，应用已进入发布节点' : '申请已退回至提交人修改',
    };
  }
  if (action.type === 'resubmit-publication') {
    const actor = state.users.find((user) => user.id === action.actorId);
    const request = state.publicationRequests.find((item) => item.id === action.id);
    if (!request || !canResubmitPublication(actor, request)) return { ...state, notice: '当前用户无权重新提交此申请' };
    return { ...state, publicationRequests: state.publicationRequests.map((item) => item.id === action.id ? { ...item, status: '审核中', currentNodeId: 'review', currentNodeName: '应用发布审核', currentAssigneeIds: [], currentCandidateGroups: ['role:流程管理员', 'department:数字化办公室'], updatedAt: '刚刚', reviewComment: undefined, reviewerName: undefined } : item), notice: '申请已重新提交并返回应用发布审核节点' };
  }
  if (action.type === 'clear-notice') return { ...state, notice: '' };
  return state;
}

