const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "");

export const hasBackend = Boolean(API_BASE_URL);

export type DshBackupRow = { id: string; userId: string; userName: string; employeeNo: string; lastLoginAt: string | null; createdAt: string; bytes: number; sessionCount: number; scope: string; sha256: string; canDownload: boolean };
export const getDshBackups = (page: number, search: string, pageSize = 5) => apiRequest<BackendPage<DshBackupRow>>(`/api/dsh-backups?${new URLSearchParams({ page: String(page), search, pageSize: String(pageSize) })}`);
export const deleteDshBackup = (id: string) => apiRequest<void>(`/api/dsh-backups/${encodeURIComponent(id)}`, { method: 'DELETE' });
export async function downloadDshBackup(id: string): Promise<void> {
  if (!API_BASE_URL) throw new Error('未配置后端地址');
  const token = storedToken();
  const response = await fetch(`${API_BASE_URL}/api/dsh-backups/${encodeURIComponent(id)}/download`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (response.status === 401) {
    clearSession();
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('aigc-session-expired'));
    throw new Error('登录状态已失效，请重新登录');
  }
  if (!response.ok) throw new Error(`备份下载失败（HTTP ${response.status}）`);
  const binary = response.headers.get('content-type')?.includes('application/gzip');
  const blob = binary ? await response.blob() : new Blob([(await response.json() as { payload: string }).payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `conversation-backup-${id}.${binary ? 'tar.gz' : 'json'}`;
  document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type DesktopDownload = {
  id: string; version: string; notes: string; bytes: number; sha512: string;
  fileName: string; createdAt: string; platform: string;
};
export const getDesktopDownload = () => apiRequest<{ release: DesktopDownload | null }>('/api/desktop-downloads/windows-x64');
export async function startDesktopDownload(id: string): Promise<void> {
  const ticket = await apiRequest<{ path: string }>(`/api/desktop-downloads/${encodeURIComponent(id)}/ticket`,
    { method: 'POST', credentials: 'include' });
  if (ticket.path !== `/api/desktop-downloads/${id}/installer`) throw new Error('安装包下载地址无效，请重试。');
  const link = document.createElement('a');
  link.href = `${API_BASE_URL}${ticket.path}`;
  document.body.appendChild(link); link.click(); link.remove();
}

export type DshFeedbackRow = { id: string; sessionId: string; category: string; text: string; createdAt: string; userName: string; employeeNo: string; sessionLog?: string };
export const getDshFeedback = (search: string, category: string, page: number, pageSize = 5) => apiRequest<BackendPage<DshFeedbackRow>>(`/api/dsh-feedback?${new URLSearchParams({ search, category, page: String(page), pageSize: String(pageSize) })}`);
export const getDshFeedbackDetail = (id: string) => apiRequest<DshFeedbackRow>(`/api/dsh-feedback/${encodeURIComponent(id)}`);

export type BackendLogin = {
  accessToken: string;
  expiresAt: string;
  user: { id: string; employeeNo: string; name: string; roles: string[]; permissions: string[] };
};

export type BackendPage<T> = { items: T[]; page: number; pageSize: number; total: number };
export type DshFailureRow = {
  id: string; eventId: string; deviceId: string; appVersion: string; category: string; operation: string;
  sessionId: string; occurredAt: string; receivedAt: string; username: string; displayName: string;
};
export type DshFailureDetail = {
  schemaVersion: number; eventId: string; deviceId: string; username: string; appVersion: string;
  occurredAt: string; category: string; operation: string; sessionId: string; operationId: string;
  error: string; context: string[]; durationMs?: number; status?: number; platform?: string; arch?: string;
};
export const getDshFailures = (filters: Record<string, string>, page: number, pageSize = 5) => {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value.length > 0));
  query.set('page', String(page));
  query.set('pageSize', String(pageSize));
  return apiRequest<BackendPage<DshFailureRow> & { retentionDays: number }>(`/api/dsh-failures?${query}`);
};
export const getDshFailure = (id: string) => apiRequest<DshFailureDetail>(`/api/dsh-failures/${encodeURIComponent(id)}`);
export async function downloadDshFailure(id: string): Promise<void> {
  if (!API_BASE_URL) throw new Error('未配置后端地址');
  const token = storedToken();
  const response = await fetch(`${API_BASE_URL}/api/dsh-failures/${encodeURIComponent(id)}/download`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error(`日志下载失败（${response.status}）`);
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `dsh-failure-${id}.jsonl`;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export type BackendDshUpload = {
  id: string; clientUploadId: string; sessionId: string; eventSeq: number; prompt: string;
  userName: string; employeeNo: string; computerName: string; storedPath: string;
  fileName: string; bytes: number; offset: number; completed: boolean;
  status: 'Pending' | 'Uploading' | 'Finalizing' | 'Completed' | 'Recorded';
  createdAt: string; completedAt?: string | null;
};
export type BackendDshUploadBatch = {
  userId: string; sessionId: string; eventSeq: number; createdAt: string; files: BackendDshUpload[];
};
export type BackendProcessDefinition = {
  id: string; key: string; name: string; version: number; definitionJson: string;
  isPublished: boolean; updatedAt: string;
};
export type DesignerOption = { value: string; label: string; employeeNo?: string };
export type DesignerOptions = {
  users: DesignerOption[]; departments: DesignerOption[]; roles: DesignerOption[];
};
export type PublicationOption = { id: string; code: string; name: string; description: string };
export type PublicationAccessOptions = {
  users: Array<{ id: string; name: string; employeeNo: string; department: string }>;
  departments: Array<{ id: string; name: string }>;
  roles: Array<{ id: string; name: string }>;
};
export type BackendPublication = {
  id: string; requestNo: string; appName: string; category: string; summary: string;
  accessUrl: string; applicantName: string; applicantDepartment: string; status: string;
  currentNodeKey: string; currentNodeName: string; createdAt: string; updatedAt: string;
  reviewComment?: string; taskId?: string; availableActions: Array<{ code: string; name: string }>;
  correlationId?: string;
};
export type BackendDepartment = { id: string; code: string; name: string; description: string; managerId?: string; isEnabled: boolean };
export type BackendRole = { id: string; code: string; name: string; description: string; isBuiltIn: boolean; userCount: number; permissions: string[] };
export type BackendPermission = { id: string; code: string; name: string; pagePath: string };
export type BackendUser = { id: string; employeeNo: string; name: string; email: string; departmentId: string | null; department: string; isEnabled: boolean; lastLoginAt?: string; roles: Array<{ roleId: string; name: string }> };
export type BackendCategory = { id: string; code: string; name: string; description: string; color: string; sortOrder: number; isEnabled: boolean };
export type BackendCatalogApp = {
  id: string; name: string; description: string; category: string; categoryColor: string;
  owner: string; accessUrl: string; publishedAt: string;
};
export type BackendChatTool = {
  name: string; displayName: string; description: string; requiredPermission: string;
  requiresConfirmation: boolean; parameters: Record<string, unknown>;
};
export type BackendChatModel = { id: string; name: string; providerKind: string; modelIdentifier: string; supportsTools: boolean; isDefault: boolean };
export type BackendChatConversation = { id: string; title: string; modelId?: string | null; isArchived: boolean; createdAt: string; updatedAt: string };
export type BackendModelConfiguration = BackendChatModel & {
  multiplier?: string;
  imageInputMode?: "Auto" | "Supported" | "Unsupported";
  imageInput?: { state: "supported" | "unsupported" | "unknown"; source: string; reason: string };
  protocol: string; baseUrl: string; endpointPath: string; hasApiKey: boolean; authType: string;
  apiKeyHeader: string; isEnabled: boolean; temperature: number; maxTokens?: number; sortOrder: number;
  createdAt: string; updatedAt: string;
  liteLlmCapabilities?: { mode: string | null; supportedFeatures: string[];
    contextWindow: number | null; maxOutputTokens: number | null } | null;
};
export type BackendSensitiveWord = {
  id: string; term: string; isEnabled: boolean; createdAt: string; updatedAt: string;
};
export type BackendChatToolOptions = {
  categories: Array<{ id: string; code: string; name: string }>;
  departments: Array<{ id: string; code: string; name: string }>;
  roles: Array<{ id: string; code: string; name: string }>;
  users: Array<{ id: string; employeeNo: string; name: string; department: string }>;
};
export type BackendChatMessage = { id: string; role: string; content: string; toolExecutionId?: string; createdAt: string };
export type BackendChatToolExecution = {
  id: string; toolName: string; displayName: string; arguments: Record<string, unknown>;
  status: "AwaitingConfirmation" | "Running" | "Succeeded" | "Failed" | "Cancelled";
  requiresConfirmation: boolean;
  result?: { message: string; data?: unknown; navigationUrl?: string };
  error?: string; createdAt: string; completedAt?: string;
};
export type BackendChatResponse = {
  conversationId: string; message: BackendChatMessage;
  toolExecution?: BackendChatToolExecution; modelConfigured: boolean; modelId?: string; modelName?: string;
};

function storedToken() {
  return typeof window === "undefined" ? null : localStorage.getItem("aigc_hub_access_token");
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!API_BASE_URL) throw new Error("未配置后端地址");
  const token = storedToken();
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  if (response.status === 401) {
    clearSession();
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('aigc-session-expired'));
    throw new Error("登录状态已失效，请重新登录");
  }
  if (response.status === 403) {
    const body = await response.json().catch(() => null) as { detail?: string; message?: string } | null;
    throw new Error(body?.detail || body?.message || "当前账号没有执行此操作的权限");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as string | { detail?: string; message?: string; error?: string } | null;
    throw new Error(typeof body === 'string' ? body : body?.detail || body?.message || body?.error || `请求失败（${response.status}）`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function loginBackend(employeeNo: string, password: string): Promise<BackendLogin> {
  if (!API_BASE_URL) throw new Error("未配置后端地址");
  const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ employeeNo, password }),
  });
  if (response.status === 401) throw new Error("工号或密码错误，或账号已停用");
  if (!response.ok) throw new Error("登录服务暂时不可用");
  return response.json();
}

export async function getPortalSsoConfig(): Promise<{ enabled: boolean }> {
  if (!API_BASE_URL) return { enabled: false };
  const response = await fetch(`${API_BASE_URL}/api/auth/sso/config`, { cache: 'no-store' });
  if (!response.ok) throw new Error('无法读取 Bosch SSO 配置');
  return response.json();
}

export function portalSsoStartUrl(returnTo: string): string {
  if (!API_BASE_URL) throw new Error('未配置后端地址');
  return `${API_BASE_URL}/api/auth/sso/start?${new URLSearchParams({ returnTo })}`;
}

export function redirectPortalSso(returnTo: string): void {
  window.location.replace(portalSsoStartUrl(returnTo));
}

export async function completePortalSso(): Promise<BackendLogin> {
  if (!API_BASE_URL) throw new Error('未配置后端地址');
  const response = await fetch(`${API_BASE_URL}/api/auth/sso/complete`, {
    method: 'POST', credentials: 'include', cache: 'no-store',
  });
  if (!response.ok) throw new Error(response.status === 401
    ? 'SSO 登录结果已过期，请重新点击 Bosch SSO 登录。'
    : 'SSO 登录未能完成，请重试或使用工号密码登录。');
  return response.json();
}

export function saveSession(session: BackendLogin) {
  window.sessionStorage.removeItem('aigc-explicit-logout');
  localStorage.setItem("aigc_hub_access_token", session.accessToken);
  localStorage.setItem("aigc_hub_user", JSON.stringify(session.user));
}

export function clearSession() {
  localStorage.removeItem("aigc_hub_access_token");
  localStorage.removeItem("aigc_hub_user");
}

export const getProcessDefinitions = () =>
  apiRequest<BackendProcessDefinition[]>("/api/process-definitions");

export const getDesignerOptions = () =>
  apiRequest<DesignerOptions>("/api/process-definitions/designer-options");

export const saveProcessDefinition = (input: {
  key: string; name: string; version: number; definition: unknown; isPublished: boolean;
}) => apiRequest<BackendProcessDefinition>("/api/process-definitions", {
  method: "POST", body: JSON.stringify(input),
});

export const publishProcessDefinition = (id: string) =>
  apiRequest<void>(`/api/process-definitions/${id}/publish`, { method: "POST" });

export const getPublicationOptions = () =>
  apiRequest<PublicationOption[]>("/api/publication-requests/options");
export const getPublicationAccessOptions = () =>
  apiRequest<PublicationAccessOptions>("/api/publication-requests/access-options");

export const getMyPublications = (page = 1, pageSize = 100) =>
  (page === 1 && pageSize === 100 ? allPages<BackendPublication>("/api/publication-requests/mine") : apiRequest<BackendPage<BackendPublication>>(`/api/publication-requests/mine?page=${page}&pageSize=${pageSize}`));

export const getReviewablePublications = (page = 1, pageSize = 100) =>
  (page === 1 && pageSize === 100 ? allPages<BackendPublication>("/api/publication-requests/reviewable") : apiRequest<BackendPage<BackendPublication>>(`/api/publication-requests/reviewable?page=${page}&pageSize=${pageSize}`));

export const submitPublication = (input: {
  appName: string; categoryId: string; summary: string; accessUrl?: string;
  repositoryUrl?: string; branch?: string; commitSha?: string; version?: string;
  environment?: string; accessMode?: "All" | "Subjects";
  accessSubjects?: Array<{ subjectType: "User" | "Department" | "Role"; subjectId: string }>;
}) =>
  apiRequest<BackendPublication>("/api/publication-requests", { method: "POST", body: JSON.stringify(input) });

export const resubmitPublication = (id: string) =>
  apiRequest<BackendPublication>(`/api/publication-requests/${id}/resubmit`, { method: "POST" });

export const completeWorkflowTask = (taskId: string, action: "approve" | "reject", comment: string) =>
  apiRequest<unknown>(`/api/workflow/tasks/${taskId}/complete`, {
    method: "POST", body: JSON.stringify({ action, comment, variables: null }),
  });

export type UserAccessOption = { id: string; name: string; isEnabled: boolean; selected: boolean; inherited: boolean; departmentIds?: string[]; roleIds?: string[]; organizationInherited?: boolean };
export type UserAccessOptions = { departments?: Array<{ id: string; name: string }>; roles?: Array<{ id: string; name: string }>; models: UserAccessOption[]; virtualKeys: UserAccessOption[] };
export const getUserAccessOptions = (userId?: string) => apiRequest<UserAccessOptions>(`/api/users/access-options${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`);
async function allPages<T>(path: string): Promise<BackendPage<T>> {
  const separator = path.includes('?') ? '&' : '?';
  const first = await apiRequest<BackendPage<T>>(`${path}${separator}page=1&pageSize=100`);
  const items = [...first.items];
  for (let page = 2; items.length < first.total; page++) {
    const next = await apiRequest<BackendPage<T>>(`${path}${separator}page=${page}&pageSize=100`);
    if (!next.items.length) break;
    items.push(...next.items);
  }
  return { ...first, items };
}

export const getUsers = () => allPages<BackendUser>("/api/users");
export const resetUserPassword = (id: string, newPassword: string) => apiRequest<void>(`/api/users/${encodeURIComponent(id)}/password`, { method: "PUT", body: JSON.stringify({ newPassword }) });
export const changeMyPassword = (currentPassword: string, newPassword: string) => apiRequest<void>("/api/auth/password", { method: "PUT", body: JSON.stringify({ currentPassword, newPassword }) });
export const saveUser = (id: string | null, input: { employeeNo: string; name: string; email: string; password?: string; departmentId: string | null; roleIds: string[]; isEnabled: boolean; modelIds?: string[]; virtualKeyIds?: string[] }) =>
  apiRequest<void>(id ? `/api/users/${id}` : "/api/users", { method: id ? "PUT" : "POST", body: JSON.stringify(input) });

export const getDepartments = () => allPages<BackendDepartment>("/api/departments");
export const saveDepartment = (id: string | null, input: Omit<BackendDepartment, "id">) =>
  apiRequest<void>(id ? `/api/departments/${id}` : "/api/departments", { method: id ? "PUT" : "POST", body: JSON.stringify(input) });

export const getRoles = () => allPages<BackendRole>("/api/roles");
export const getPermissions = () => apiRequest<BackendPermission[]>("/api/roles/permissions");
export const saveRole = (id: string | null, input: { code: string; name: string; description: string; permissionCodes: string[] }) =>
  apiRequest<void>(id ? `/api/roles/${id}` : "/api/roles", { method: id ? "PUT" : "POST", body: JSON.stringify(input) });
export const deleteRole = (id: string) => apiRequest<void>(`/api/roles/${id}`, { method: "DELETE" });

export const getCategories = () => allPages<BackendCategory>("/api/categories");
export const saveCategory = (id: string | null, input: Omit<BackendCategory, "id">) =>
  apiRequest<void>(id ? `/api/categories/${id}` : "/api/categories", { method: id ? "PUT" : "POST", body: JSON.stringify(input) });
export const deleteCategory = (id: string) => apiRequest<void>(`/api/categories/${id}`, { method: "DELETE" });
export const getCatalogApps = () => apiRequest<BackendCatalogApp[]>("/api/catalog/apps");
export const getChatTools = () => apiRequest<BackendChatTool[]>("/api/chat/tools");
export const getChatModels = () => apiRequest<BackendChatModel[]>("/api/chat/models");
export const getChatToolOptions = () => apiRequest<BackendChatToolOptions>("/api/chat/tool-options");
export const getChatConversations = (archived = false) => apiRequest<BackendChatConversation[]>(`/api/chat/conversations?archived=${archived}`);
export const createChatConversation = (title = "新对话", modelId?: string) =>
  apiRequest<BackendChatConversation>("/api/chat/conversations", { method: "POST", body: JSON.stringify({ title, modelId: modelId || null }) });
export const renameChatConversation = (id: string, title: string) => apiRequest<BackendChatConversation>(`/api/chat/conversations/${id}/title`, { method: "PUT", body: JSON.stringify({ title }) });
export const archiveChatConversation = (id: string) => apiRequest<BackendChatConversation>(`/api/chat/conversations/${id}/archive`, { method: "POST" });
export const restoreChatConversation = (id: string) => apiRequest<BackendChatConversation>(`/api/chat/conversations/${id}/restore`, { method: "POST" });
export const deleteChatConversation = (id: string) => apiRequest<void>(`/api/chat/conversations/${id}`, { method: "DELETE" });
export const getChatMessages = (id: string) => apiRequest<BackendChatMessage[]>(`/api/chat/conversations/${id}/messages`);
export const getPendingChatToolExecutions = (id: string) =>
  apiRequest<BackendChatToolExecution[]>(`/api/chat/conversations/${id}/pending-tool-executions`);
export const sendChatMessage = (conversationId: string | null, content: string, modelId?: string) =>
  apiRequest<BackendChatResponse>("/api/chat/messages", { method: "POST", body: JSON.stringify({ conversationId, content, modelId: modelId || null }) });
export const getModelConfigurations = () => apiRequest<BackendModelConfiguration[]>("/api/models");
export type ManagedVirtualKey = { id: string; alias: string; isEnabled: boolean; createdAt: string };
export type VirtualKeyPolicy = { models: string[]; allModels: boolean; maxBudget: number | null; budgetDuration: string | null;
  rpmLimit: number | null; tpmLimit: number | null; duration: string | null; clearExpiry: boolean };
export type VirtualKeyPolicyView = Omit<VirtualKeyPolicy, 'duration' | 'clearExpiry'> & { expires: string | null };
export const getVirtualKeyModels = () => apiRequest<string[]>("/api/virtual-keys/model-options");
export const getVirtualKeyPolicy = (id: string) => apiRequest<VirtualKeyPolicyView>(`/api/virtual-keys/${id}/policy`);
export const updateVirtualKeyPolicy = (id: string, policy: VirtualKeyPolicy) => apiRequest<VirtualKeyPolicyView>(`/api/virtual-keys/${id}/policy`, {
  method: "PUT", body: JSON.stringify(policy),
});
export type VirtualKeyOrganization = { id: string; name: string; userIds: string[] };
export type VirtualKeyGrants = { userIds: string[]; departmentIds: string[]; roleIds?: string[]; organizationIds: string[] };
export const getManagedVirtualKeys = () => apiRequest<ManagedVirtualKey[]>("/api/virtual-keys");
export const createManagedVirtualKey = (alias: string, customKey: string, policy?: VirtualKeyPolicy) => apiRequest<ManagedVirtualKey>("/api/virtual-keys", {
  method: "POST", body: JSON.stringify({ alias, customKey: customKey || null, ...(policy ? { policy } : {}) }),
});
export const setManagedVirtualKeyEnabled = (id: string, enabled: boolean) => apiRequest<void>(`/api/virtual-keys/${id}/enabled?enabled=${enabled}`, { method: "PUT" });
export const getVirtualKeyGrants = (id: string) => apiRequest<VirtualKeyGrants>(`/api/virtual-keys/${id}/grants`);
export const saveVirtualKeyGrants = (id: string, grants: VirtualKeyGrants) => apiRequest<void>(`/api/virtual-keys/${id}/grants`, { method: "PUT", body: JSON.stringify(grants) });
export const getVirtualKeyOrganizations = () => apiRequest<VirtualKeyOrganization[]>("/api/virtual-keys/organizations");
export const createVirtualKeyOrganization = (name: string, userIds: string[]) => apiRequest<VirtualKeyOrganization>("/api/virtual-keys/organizations", {
  method: "POST", body: JSON.stringify({ name, userIds }),
});
export const updateVirtualKeyOrganization = (id: string, name: string, userIds: string[]) => apiRequest<void>(`/api/virtual-keys/organizations/${id}`, {
  method: "PUT", body: JSON.stringify({ name, userIds }),
});
export type OperationAuditRow = { id: string; userId: string; actorName: string; action: string; entityType: string; entityId: string | null; detailJson: string; actionLabel: string; entityLabel: string; detailLabel: string; succeeded: boolean; createdAt: string };
export type OperationAuditPage = { items: OperationAuditRow[]; total: number; page: number; pageSize: number };
export const getOperationAudits = async (page = 1, pageSize = 5): Promise<OperationAuditPage> => {
  const response = await apiRequest<unknown>(`/api/operation-audits?page=${page}&pageSize=${pageSize}`);
  if (!response || typeof response !== 'object' || Array.isArray(response)
    || !('items' in response) || !Array.isArray(response.items)
    || !('total' in response) || typeof response.total !== 'number'
    || response.items.some((item) => !item || typeof item !== 'object'
      || !('actorName' in item) || typeof item.actorName !== 'string'
      || !('actionLabel' in item) || typeof item.actionLabel !== 'string'
      || !('entityLabel' in item) || typeof item.entityLabel !== 'string'
      || !('detailLabel' in item) || typeof item.detailLabel !== 'string')) {
    throw new Error('AIGC 后端仍在返回旧版审计接口，请重启或更新 AIGC API 服务后刷新页面。');
  }
  return response as OperationAuditPage;
};
export const getSensitiveWords = () => apiRequest<BackendSensitiveWord[]>("/api/sensitive-words");
export const saveSensitiveWord = (id: string | null, input: { term: string; isEnabled: boolean }) =>
  apiRequest<BackendSensitiveWord>(id ? `/api/sensitive-words/${id}` : "/api/sensitive-words", {
    method: id ? "PUT" : "POST", body: JSON.stringify(input),
  });
export const deleteSensitiveWord = (id: string) => apiRequest<void>(`/api/sensitive-words/${id}`, { method: "DELETE" });
export const getDshUploads = (page = 1, pageSize = 10, query = '', status = '') => {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (query.trim()) params.set('query', query.trim());
  if (status) params.set('status', status);
  return apiRequest<BackendPage<BackendDshUpload>>(`/api/dsh-uploads?${params}`);
};
export const getDshUploadBatches = (page = 1, pageSize = 10, query = '', status = '') => {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (query.trim()) params.set('query', query.trim());
  if (status) params.set('status', status);
  return apiRequest<BackendPage<BackendDshUploadBatch>>(`/api/dsh-uploads/batches?${params}`);
};
export async function downloadDshUpload(upload: BackendDshUpload): Promise<void> {
  if (!API_BASE_URL) throw new Error("未配置后端地址");
  const token = storedToken();
  if (!token) throw new Error("请先登录");
  const response = await fetch(`${API_BASE_URL}/api/dsh-uploads/${encodeURIComponent(upload.id)}/download`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) throw new Error("登录状态已失效，请重新登录");
  if (response.status === 403) throw new Error("当前账号没有下载权限");
  if (!response.ok) throw new Error(`下载失败（${response.status}）`);
  const url = URL.createObjectURL(await response.blob());
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = upload.fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally { URL.revokeObjectURL(url); }
}
export const saveModelConfiguration = (id: string | null, input: Record<string, unknown>) =>
  apiRequest<BackendModelConfiguration>(id ? `/api/models/${id}` : "/api/models", { method: id ? "PUT" : "POST", body: JSON.stringify(input) });
export const deleteModelConfiguration = (id: string) => apiRequest<void>(`/api/models/${id}`, { method: "DELETE" });
export const testModelConfiguration = (id: string) => apiRequest<{ message: string }>(`/api/models/${id}/test`, { method: "POST" });
export type LiteLlmModelSyncResult = { discovered: number; created: number; updated: number; disabled: number };
export const syncLiteLlmModels = () =>
  apiRequest<LiteLlmModelSyncResult>("/api/models/sync-litellm", { method: "POST" });
export type SelectionAvailability = { disabled?: boolean; disabledReason?: string | null };
export type ModelGrantUser = SelectionAvailability & { id: string; employeeNo: string; name: string };
export type GrantSubject = SelectionAvailability & { id: string; code: string; name: string };
export type GrantOptions = { users: ModelGrantUser[]; roles: GrantSubject[]; departments: GrantSubject[] };
export type GrantSelection = { userIds: string[]; roleIds: string[]; departmentIds: string[] };
export const getGrantOptions = () => apiRequest<GrantOptions>("/api/models/grant-options");
export const getVirtualKeyGrantOptions = (keyId?: string) => apiRequest<GrantOptions>(`/api/virtual-keys/grant-options${keyId ? `?keyId=${encodeURIComponent(keyId)}` : ""}`);
export const getModelGrants = (id: string) => apiRequest<GrantSelection>(`/api/models/${id}/grants`);
export const saveModelGrants = (id: string, selection: GrantSelection) =>
  apiRequest<void>(`/api/models/${id}/grants`, { method: "PUT", body: JSON.stringify(selection) });
export type WebSearchSettings = { isEnabled: boolean; hasApiKey: boolean; grants: GrantSelection };
export const getWebSearchSettings = () => apiRequest<WebSearchSettings>("/api/web-search");
export const saveWebSearchSettings = (input: { apiKey: string; isEnabled: boolean; grants: GrantSelection }) =>
  apiRequest<void>("/api/web-search", { method: "PUT", body: JSON.stringify(input) });
export const getModelGrantUsers = () => apiRequest<ModelGrantUser[]>("/api/models/eligible-users");
export const getModelGrantedUserIds = (id: string) => apiRequest<string[]>(`/api/models/${id}/users`);
export const saveModelGrantedUserIds = (id: string, userIds: string[]) =>
  apiRequest<void>(`/api/models/${id}/users`, { method: "PUT", body: JSON.stringify(userIds) });
export const proposeChatTool = (conversationId: string, toolName: string, args: Record<string, unknown>) =>
  apiRequest<BackendChatToolExecution>(`/api/chat/tool-executions?conversationId=${encodeURIComponent(conversationId)}`, {
    method: "POST", body: JSON.stringify({ toolName, arguments: args }),
  });
export const confirmChatTool = (id: string) =>
  apiRequest<BackendChatToolExecution>(`/api/chat/tool-executions/${id}/confirm`, { method: "POST" });
export const cancelChatTool = (id: string) =>
  apiRequest<BackendChatToolExecution>(`/api/chat/tool-executions/${id}/cancel`, { method: "POST" });

export type DesktopRecipientOption = { id: string; name: string; employeeNo: string };
export type DesktopAudienceOptions = { users: Array<DesktopRecipientOption & { departmentId: string | null; roleIds: string[] }>; roles: GrantSubject[]; departments: GrantSubject[] };
export type DesktopAnnouncementRecipient = { userId: string; name: string; employeeNo: string; deliveredAt: string | null; readAt: string | null; confirmedAt: string | null };
export type DesktopAnnouncement = { id: string; title: string; body: string; important: boolean; status: string; startsAt: string; endsAt: string | null; createdAt: string; audience: GrantSelection; recipients: DesktopAnnouncementRecipient[] };
export type DesktopAnnouncementInput = { title: string; body: string; important: boolean; startsAt: string; endsAt: string | null } & GrantSelection;
export type DesktopRelease = { id: string; version: string; notes: string; platform: string; arch: string; status: string; fileName: string; bytes: number; hasBlockmap: boolean; createdAt: string; audience: GrantSelection; recipients: Array<{ userId: string; name: string; employeeNo: string }> };
export type DesktopClientReport = { userId: string; name: string; employeeNo: string; deviceId: string; computerName: string; version: string; updateStatus: string; targetVersion: string; error: string; lastSeenAt: string };
export const getDesktopAnnouncements = () => apiRequest<DesktopAnnouncement[]>('/api/desktop-announcements');
export const getDesktopRecipients = (kind: 'announcements' | 'releases') => apiRequest<DesktopRecipientOption[]>(`/api/desktop-${kind}/recipients`);
export const getDesktopAudienceOptions = (kind: 'announcements' | 'releases') => apiRequest<DesktopAudienceOptions>(`/api/desktop-${kind}/recipient-options`);
export const saveDesktopAnnouncement = (id: string | null, input: DesktopAnnouncementInput) => apiRequest<{ id: string } | void>(id ? `/api/desktop-announcements/${id}` : '/api/desktop-announcements', { method: id ? 'PUT' : 'POST', body: JSON.stringify(input) });
export const setDesktopAnnouncementStatus = (id: string, status: string) => apiRequest<void>(`/api/desktop-announcements/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
export const getDesktopReleases = () => apiRequest<DesktopRelease[]>('/api/desktop-releases');
export const getDesktopClients = () => apiRequest<DesktopClientReport[]>('/api/desktop-releases/clients');
export const createDesktopRelease = (input: { version: string; notes: string; arch: string } & GrantSelection) => apiRequest<{ id: string }>('/api/desktop-releases', { method: 'POST', body: JSON.stringify(input) });
export const setDesktopReleaseStatus = (id: string, status: string) => apiRequest<void>(`/api/desktop-releases/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
export const setDesktopReleaseRecipients = (id: string, audience: GrantSelection) => apiRequest<void>(`/api/desktop-releases/${id}/recipients`, { method: 'PUT', body: JSON.stringify(audience) });
export function uploadDesktopRelease(id: string, installer: File, blockmap: File | null, progress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData(); form.append('installer', installer); if (blockmap) form.append('blockmap', blockmap);
    const xhr = new XMLHttpRequest(); xhr.open('POST', `${API_BASE_URL}/api/desktop-releases/${id}/artifacts`);
    const token = storedToken(); if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(Math.round(event.loaded * 100 / event.total)); };
    xhr.onerror = () => reject(new Error('上传连接失败，请重试'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
      let message = `上传失败（${xhr.status}）`;
      try { message = JSON.parse(xhr.responseText).error || message; } catch { /* Proxy errors may return HTML. */ }
      reject(new Error(message));
    };
    xhr.send(form);
  });
}
