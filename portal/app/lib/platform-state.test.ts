import { describe, expect, it } from 'vitest';
import { canAccessAdminPath, canReviewPublication, createInitialPlatformState, platformReducer, type PublicationRequest } from './platform-state';

describe('platform state', () => {
  it('adds a user and toggles the user status', () => {
    const initial = createInitialPlatformState();
    const added = platformReducer(initial, { type: 'save-user', user: { id: 'u99', name: '测试用户', employeeNo: 'wh0099', email: 'test@bhss.com', department: '研发中心', role: '普通用户', status: '启用', lastLogin: '尚未登录' } });
    const disabled = platformReducer(added, { type: 'toggle-user-status', id: 'u99' });

    expect(disabled.users.find((user) => user.id === 'u99')?.status).toBe('停用');
  });

  it('authenticates an enabled employee and manages departments', () => {
    const initial = createInitialPlatformState();
    const signedIn = platformReducer(initial, { type: 'login', employeeNo: 'wh00136' });
    const added = platformReducer(signedIn, { type: 'save-department', department: { id: 'purchasing', name: '采购部', manager: '周宁', description: '采购与供应商协同', enabled: true } });
    expect(signedIn.currentUserId).toBe('u2');
    expect(added.departments.some((item) => item.name === '采购部')).toBe(true);
  });

  it('limits admin pages by the signed-in user role', () => {
    const initial = createInitialPlatformState();
    expect(canAccessAdminPath(initial, initial.users[2], '/admin/publications')).toBe(true);
    expect(canAccessAdminPath(initial, initial.users[2], '/admin/users')).toBe(false);
    const changed = platformReducer(initial, { type: 'save-role-permissions', role: '普通用户', paths: ['/admin/publications', '/admin/reviews'] });
    expect(canAccessAdminPath(changed, changed.users[2], '/admin/reviews')).toBe(true);
  });

  it('creates a new role with independently configurable pages', () => {
    const initial = createInitialPlatformState();
    const created = platformReducer(initial, { type: 'save-role', role: { id: 'auditor', name: '审计员', description: '只读审计角色', permissions: ['/admin', '/admin/reviews'], builtIn: false } });
    const user = { ...created.users[4], role: '审计员' };
    expect(created.roles.some((role) => role.name === '审计员')).toBe(true);
    expect(canAccessAdminPath(created, user, '/admin/reviews')).toBe(true);
    expect(canAccessAdminPath(created, user, '/admin/users')).toBe(false);
  });

  it('prevents deleting a role that is assigned to users', () => {
    const initial = createInitialPlatformState();
    const result = platformReducer(initial, { type: 'delete-role', id: 'normal-user' });
    expect(result.roles.some((role) => role.id === 'normal-user')).toBe(true);
    expect(result.notice).toContain('仍有关联用户');
  });

  it('rejects duplicate role names', () => {
    const initial = createInitialPlatformState();
    const result = platformReducer(initial, { type: 'save-role', role: { id: 'duplicate', name: '普通用户', description: '', permissions: ['/admin'], builtIn: false } });
    expect(result.roles).toHaveLength(initial.roles.length);
    expect(result.notice).toContain('角色名称已存在');
  });

  it('prevents deleting a category that still has applications', () => {
    const initial = createInitialPlatformState();
    const result = platformReducer(initial, { type: 'delete-category', id: 'service' });

    expect(result.categories.some((category) => category.id === 'service')).toBe(true);
    expect(result.notice).toContain('仍有关联应用');
  });

  it('authorizes the active task by direct assignee or candidate group', () => {
    const initial = createInitialPlatformState();
    const directTask: PublicationRequest = { ...initial.publicationRequests[0], currentAssigneeIds: ['u3'], currentCandidateGroups: [] };
    const groupTask: PublicationRequest = { ...initial.publicationRequests[0], currentAssigneeIds: [], currentCandidateGroups: ['department:质量管理部'] };

    expect(canReviewPublication(initial.users[2], directTask)).toBe(true);
    expect(canReviewPublication(initial.users[2], groupTask)).toBe(true);
    expect(canReviewPublication(initial.users[4], groupTask)).toBe(false);
  });

  it('submits an application into the workflow review node', () => {
    const initial = createInitialPlatformState();
    const result = platformReducer(initial, { type: 'submit-publication', actorId: 'u1', request: { id: 'pub-99', appName: '设备知识助手', category: '知识智能', summary: '检索设备知识与维修经验', accessUrl: 'https://internal.example/apps/device' } });
    const submitted = result.publicationRequests.find((request) => request.id === 'pub-99');

    expect(submitted).toMatchObject({ applicantId: 'u1', applicantName: '姚伟明', status: '审核中', currentNodeId: 'review', currentNodeName: '应用发布审核', processDefinitionId: 'application-publishing-v1' });
    expect(submitted?.processInstanceId).toBe('process-pub-99');
    expect(submitted?.currentCandidateGroups).toContain('role:流程管理员');
  });

  it('blocks an unauthorized user from completing a review task', () => {
    const initial = createInitialPlatformState();
    const protectedTask = { ...initial.publicationRequests[0], currentAssigneeIds: ['u3'], currentCandidateGroups: [] };
    const state = { ...initial, publicationRequests: [protectedTask, ...initial.publicationRequests.slice(1)] };
    const result = platformReducer(state, { type: 'review-publication', id: protectedTask.id, actorId: 'u5', decision: '通过', comment: '同意发布' });

    expect(result.publicationRequests[0].status).toBe('审核中');
    expect(result.notice).toContain('无权处理');
  });

  it('moves an authorized review to the matching workflow result', () => {
    const initial = createInitialPlatformState();
    const approved = platformReducer(initial, { type: 'review-publication', id: initial.publicationRequests[0].id, actorId: 'u1', decision: '通过', comment: '检查通过' });
    const rejected = platformReducer(initial, { type: 'review-publication', id: initial.publicationRequests[0].id, actorId: 'u1', decision: '退回', comment: '请补充安全说明' });

    expect(approved.publicationRequests[0]).toMatchObject({ status: '已通过', currentNodeId: 'published', reviewerName: '姚伟明' });
    expect(rejected.publicationRequests[0]).toMatchObject({ status: '已退回', currentNodeId: 'revise', reviewComment: '请补充安全说明' });
  });

  it('allows only the active revise-node assignee to resubmit a returned request', () => {
    const initial = createInitialPlatformState();
    const returned = platformReducer(initial, { type: 'review-publication', id: initial.publicationRequests[0].id, actorId: 'u1', decision: '退回', comment: '请补充说明' });
    const blocked = platformReducer(returned, { type: 'resubmit-publication', id: returned.publicationRequests[0].id, actorId: 'u5' });
    const resubmitted = platformReducer(returned, { type: 'resubmit-publication', id: returned.publicationRequests[0].id, actorId: 'u3' });

    expect(blocked.publicationRequests[0].status).toBe('已退回');
    expect(blocked.notice).toContain('无权重新提交');
    expect(resubmitted.publicationRequests[0]).toMatchObject({ status: '审核中', currentNodeId: 'review', currentNodeName: '应用发布审核' });
  });
});
