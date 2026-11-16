'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer } from 'react';
import { createInitialPlatformState, platformReducer, type PlatformAction, type PlatformState } from '../lib/platform-state';
import { getCategories, getDepartments, getPermissions, getRoles, getUsers, hasBackend, saveCategory, saveDepartment, saveRole, saveUser, deleteRole, deleteCategory, deleteUser, deleteDepartment } from '../lib/api-client';

type PlatformContextValue = PlatformState & { dispatch: (action: PlatformAction) => Promise<void> };
const PlatformContext = createContext<PlatformContextValue | null>(null);

export function PlatformProvider({ children }: { children: React.ReactNode }) {
  const [state, reducerDispatch] = useReducer(platformReducer, undefined, () => {
    const initial = { ...createInitialPlatformState(), currentUserId: '' };
    return hasBackend ? { ...initial, users: [], departments: [], categories: [], roles: [], publicationRequests: [], rolePermissions: {} } : initial;
  });

  const refresh = useCallback(async () => {
    if (!hasBackend || !localStorage.getItem('aigc_hub_access_token')) return;
    // Stored identity may be truncated by an interrupted write; fall back to an
    // empty session instead of aborting the whole provider during render.
    let stored: { id?: string; employeeNo?: string; name?: string; roles?: string[]; permissions?: string[] } = {};
    try { stored = JSON.parse(localStorage.getItem('aigc_hub_user') ?? '{}') ?? {}; } catch { stored = {}; }
    // Session identity must not depend on unrelated management requests succeeding.
    if (stored.id) reducerDispatch({ type: 'hydrate-backend', state: {
      currentUserId: stored.id,
      users: [{ id: stored.id, name: stored.name ?? '', employeeNo: stored.employeeNo ?? '', email: '', department: '', role: stored.roles?.[0] ?? '', status: '启用', lastLogin: '当前登录' }],
    }});
    const permissions = stored.permissions ?? [];
    const [userPage, departmentPage, rolePage, categoryPage, permissionItems] = await Promise.all([
      permissions.includes('user.manage') ? getUsers() : Promise.resolve({ items: [], page: 1, pageSize: 100, total: 0 }),
      permissions.includes('department.manage') ? getDepartments() : Promise.resolve({ items: [], page: 1, pageSize: 100, total: 0 }),
      permissions.includes('role.manage') ? getRoles() : Promise.resolve({ items: [], page: 1, pageSize: 100, total: 0 }),
      permissions.includes('category.manage') ? getCategories() : Promise.resolve({ items: [], page: 1, pageSize: 100, total: 0 }),
      permissions.includes('role.manage') ? getPermissions() : Promise.resolve([]),
    ]);
    const users = userPage.items.map((user) => ({
      id: user.id, allowCustomModels: user.allowCustomModels ?? false, name: user.name, employeeNo: user.employeeNo, email: user.email, department: user.department, departmentId: user.departmentId, roleIds: user.roles.map(role => role.roleId), billingPlanId: user.billingPlanId ?? null,
      role: user.roles[0]?.name ?? '未分配角色', status: user.isEnabled ? '启用' as const : '停用' as const,
      sync: user.sync ?? null,
      lastLogin: user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString('zh-CN') : '从未登录',
    }));
    if (!users.some((user) => user.id === stored.id) && stored.id)
      users.push({ allowCustomModels: false, sync: null, id: stored.id, name: stored.name ?? '', employeeNo: stored.employeeNo ?? '', email: '', department: '', departmentId: null, roleIds: [], billingPlanId: null, role: stored.roles?.[0] ?? '', status: '启用', lastLogin: '当前登录' });
    reducerDispatch({ type: 'hydrate-backend', state: {
      currentUserId: stored.id ?? '', users,
      departments: departmentPage.items.map((item) => ({ id: item.id, code: item.code, name: item.name, manager: '', description: item.description, enabled: item.isEnabled, billingPlanId: item.billingPlanId ?? null })),
      roles: rolePage.items.map((item) => ({ id: item.id, code: item.code, name: item.name, description: item.description,
        permissions: permissionItems.filter((permission) => item.permissions.includes(permission.code)).map((permission) => permission.pagePath as never), builtIn: item.isBuiltIn })),
      categories: categoryPage.items.map((item) => ({ id: item.id, parentId: item.parentId, code: item.code, name: item.name, description: item.description, color: item.color, appCount: 0, enabled: item.isEnabled, order: item.sortOrder })),
    }});
  }, []);

  useEffect(() => {
    if (!hasBackend) return;
    const timer = window.setTimeout(() => refresh().catch((error: Error) => reducerDispatch({ type: 'set-notice', notice: error.message })), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  // A notice is a transient confirmation, never a permanent badge: every page
  // renders it as a fixed floating card, so one left up covers the admin
  // surface until the next action. Each new message retires itself on a timer;
  // re-arming on the text rather than the state keeps a repeated identical
  // save visible for its own interval instead of clearing instantly.
  useEffect(() => {
    if (state.notice === '') return;
    const timer = window.setTimeout(() => reducerDispatch({ type: 'clear-notice' }), 4000);
    return () => window.clearTimeout(timer);
  }, [state.notice]);

  const dispatch = useCallback(async (action: PlatformAction) => {
    if (!hasBackend || !localStorage.getItem('aigc_hub_access_token')) { reducerDispatch(action); return; }
    if (action.type === 'login') {
      await refresh();
      reducerDispatch({ type: 'set-notice', notice: '' });
      return;
    }
    const persist = async () => {
      if (action.type === 'save-user' || action.type === 'toggle-user-status') {
        const user = action.type === 'save-user' ? action.user : state.users.find((item) => item.id === action.id);
        if (!user) return;
        const existing = state.users.some((item) => item.id === user.id);
        await saveUser(existing ? user.id : null, { employeeNo: user.employeeNo, name: user.name, email: user.email,
          departmentId: state.departments.find((item) => item.name === user.department)?.id ?? (user.department ? user.departmentId ?? null : null),
          roleIds: user.roleIds ?? [state.roles.find((item) => item.name === user.role)?.id ?? ''].filter(Boolean),
          ...(action.type === 'save-user' ? { allowCustomModels: user.allowCustomModels ?? false, pluginIds: user.pluginIds, releaseIds: user.releaseIds, mcpIds: user.mcpIds, virtualKeyIds: user.virtualKeyIds, billingPlanId: user.billingPlanId ?? null } : {}),
          isEnabled: action.type === 'toggle-user-status' ? user.status !== '启用' : user.status === '启用' });
      } else if (action.type === 'delete-department') {
        await deleteDepartment(action.id);
        reducerDispatch(action);
      } else if (action.type === 'delete-user') {
        await deleteUser(action.id);
        reducerDispatch(action);
      } else if (action.type === 'save-department' || action.type === 'toggle-department-status') {
        const item = action.type === 'save-department' ? action.department : state.departments.find((value) => value.id === action.id);
        if (!item) return;
        const existing = state.departments.some((value) => value.id === item.id);
        await saveDepartment(existing ? item.id : null, { code: item.code ?? `dept-${Date.now()}`, name: item.name, description: item.description, managerId: undefined, isEnabled: action.type === 'toggle-department-status' ? !item.enabled : item.enabled, billingPlanId: item.billingPlanId ?? null });
      } else if (action.type === 'save-category' || action.type === 'toggle-category-status') {
        const item = action.type === 'save-category' ? action.category : state.categories.find((value) => value.id === action.id);
        if (!item) return;
        const existing = state.categories.some((value) => value.id === item.id);
        await saveCategory(existing ? item.id : null, { code: item.code ?? `category-${Date.now()}`, name: item.name, description: item.description, parentId: item.parentId ?? null, color: item.color, sortOrder: item.order, isEnabled: action.type === 'toggle-category-status' ? !item.enabled : item.enabled });
      } else if (action.type === 'save-role' || action.type === 'save-role-permissions') {
        const item = action.type === 'save-role' ? action.role : state.roles.find((value) => value.name === action.role);
        if (!item) return;
        const existing = state.roles.some((value) => value.id === item.id);
        const paths = action.type === 'save-role-permissions' ? action.paths : item.permissions;
        const allPermissions = await getPermissions();
        const permissionCodes = allPermissions.filter((permission) => paths.includes(permission.pagePath as never)).map((permission) => permission.code);
        await saveRole(existing ? item.id : null, { code: item.code ?? `role-${Date.now()}`, name: item.name, description: item.description, permissionCodes });
      } else if (action.type === 'delete-role') {
        await deleteRole(action.id);
      } else if (action.type === 'delete-category') {
        await deleteCategory(action.id);
      } else if (action.type === 'move-category') {
        const ordered = [...state.categories].sort((a, b) => a.order - b.order);
        const index = ordered.findIndex((item) => item.id === action.id);
        const target = index + action.direction;
        if (index < 0 || target < 0 || target >= ordered.length) return;
        [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
        await Promise.all(ordered.map((item, order) => saveCategory(item.id, { code: item.code ?? `category-${item.id}`, name: item.name, description: item.description, parentId: item.parentId ?? null, color: item.color, sortOrder: order + 1, isEnabled: item.enabled })));
      } else { reducerDispatch(action); return; }
      reducerDispatch({ type: 'set-notice', notice: '保存成功' });
      await refresh();
    };
    try { await persist(); }
    catch (error) {
      reducerDispatch({ type: 'set-notice', notice: error instanceof Error ? error.message : '保存失败' });
      throw error;
    }
  }, [refresh, state]);

  const value = useMemo(() => ({ ...state, dispatch }), [dispatch, state]);
  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
}

export function usePlatform() {
  const value = useContext(PlatformContext);
  if (!value) throw new Error('usePlatform must be used inside PlatformProvider');
  return value;
}
