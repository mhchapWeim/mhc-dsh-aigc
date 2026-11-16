import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PublicationReviewsPage from './page';

const mocks = vi.hoisted(() => ({
  reviewable: vi.fn(),
  complete: vi.fn(),
  platform: {
    currentUserId: 'reviewer', notice: '',
    users: [{ id: 'reviewer', name: '张敏', employeeNo: 'wh00136', email: '', department: '', role: '流程管理员', status: '启用' as const, lastLogin: '刚刚' }],
    publicationRequests: [],
    dispatch: vi.fn(),
  },
}));

vi.mock('../../components/platform-provider', () => ({ usePlatform: () => mocks.platform }));
vi.mock('../../lib/api-client', () => ({
  hasBackend: true,
  getReviewablePublications: mocks.reviewable,
  completeWorkflowTask: mocks.complete,
}));

const reviewable = {
  id: 'req-1', requestNo: 'PUB-20261109-ABC123', appName: '设备知识助手', category: '智慧服务',
  summary: '检索设备知识与维修经验', accessUrl: '', applicantName: '李俊', applicantDepartment: '质量管理部',
  status: 'Reviewing', currentNodeKey: 'code_review', currentNodeName: '仓库代码审核',
  createdAt: '2026-11-09T02:00:00Z', updatedAt: '2026-11-09T02:00:00Z',
  repositoryUrl: 'https://git.example.com/aigc/device-agent', branch: 'release/1.2.0',
  commitSha: 'abcdef1234567890abcdef1234567890abcdef12', version: '1.2.0', environment: 'Production',
  accessMode: 'Subjects', accessScope: '李俊、质量管理部', reviewerName: '', candidateScope: '候选用户组', assigneeId: null,
  availableActions: [{ code: 'approve', name: '通过' }, { code: 'reject', name: '退回' }],
  taskId: 'task-1',
};

beforeEach(() => {
  localStorage.setItem('aigc_hub_access_token', 'token');
  vi.clearAllMocks();
  mocks.reviewable.mockResolvedValue({ items: [reviewable], page: 1, pageSize: 100, total: 1 });
});
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

it('keeps the queue compact: the row does not carry the submitted field grid', async () => {
  render(<PublicationReviewsPage />);
  await screen.findByText('设备知识助手');

  // The whole point of the dialog: nine extra fields inline used to inflate every row.
  expect(screen.queryByText('https://git.example.com/aigc/device-agent')).toBeNull();
  expect(screen.queryByText('abcdef1234567890abcdef1234567890abcdef12')).toBeNull();
  expect(screen.queryByRole('textbox', { name: '设备知识助手审核意见' })).toBeNull();
  expect(screen.getByRole('button', { name: '查看设备知识助手详情' })).toBeInTheDocument();
});

it('shows every submitted field inside the detail dialog', async () => {
  const user = userEvent.setup();
  render(<PublicationReviewsPage />);
  await user.click(await screen.findByRole('button', { name: '查看设备知识助手详情' }));

  const dialog = screen.getByRole('dialog', { name: '设备知识助手 · 申请详情' });
  const field = (label: string) => within(dialog).getByText(label).closest('div')?.querySelector('dd')?.textContent;
  expect(field('申请人')).toBe('李俊');
  expect(field('所属部门')).toBe('质量管理部');
  expect(field('应用分类')).toBe('智慧服务');
  expect(field('代码仓库')).toBe('https://git.example.com/aigc/device-agent');
  expect(field('分支')).toBe('release/1.2.0');
  expect(field('Commit')).toBe('abcdef1234567890abcdef1234567890abcdef12');
  expect(field('发布版本')).toBe('1.2.0');
  expect(field('部署环境')).toBe('Production');
  expect(field('可访问范围')).toBe('李俊、质量管理部');
  expect(field('当前节点')).toBe('仓库代码审核');
  expect(field('处理方式')).toBe('候选用户组');
  expect(within(dialog).getByText('PUB-20261109-ABC123')).toBeInTheDocument();
});

it('approves from the dialog with the typed comment and closes it', async () => {
  const user = userEvent.setup();
  render(<PublicationReviewsPage />);
  await user.click(await screen.findByRole('button', { name: '查看设备知识助手详情' }));
  const dialog = screen.getByRole('dialog', { name: '设备知识助手 · 申请详情' });
  await user.type(within(dialog).getByRole('textbox', { name: '设备知识助手审核意见' }), '仓库与版本核对无误');
  await user.click(within(dialog).getByRole('button', { name: '通过设备知识助手' }));

  expect(mocks.complete).toHaveBeenCalledWith('task-1', 'approve', '仓库与版本核对无误');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '设备知识助手 · 申请详情' })).toBeNull());
  expect(await screen.findByRole('status')).toHaveTextContent('审核已通过，应用已进入发布节点');
});

it('keeps tasks outside the current candidate group read-only but still inspectable', async () => {
  mocks.reviewable.mockResolvedValue({ items: [{ ...reviewable, id: 'req-2', appName: '招聘面试 Copilot', availableActions: [] }], page: 1, pageSize: 100, total: 1 });
  const user = userEvent.setup();
  render(<PublicationReviewsPage />);

  expect(await screen.findByText('招聘面试 Copilot')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '通过招聘面试 Copilot' })).not.toBeInTheDocument();
  expect(screen.getByText('不在当前处理范围')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '查看招聘面试 Copilot详情' }));
  const dialog = screen.getByRole('dialog', { name: '招聘面试 Copilot · 申请详情' });
  expect(within(dialog).getByText('不在当前处理范围，仅可查看详情')).toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: '通过招聘面试 Copilot' })).toBeNull();
});

it('never claims the flow ended while a task is still pending', async () => {
  render(<PublicationReviewsPage />);
  await screen.findByText('设备知识助手');
  // The old hint read either "流程已结束" or a guessed scope; both were wrong.
  expect(screen.queryByText('流程已结束')).toBeNull();
  expect(screen.getByText('候选用户组')).toBeInTheDocument();
  expect(screen.queryByText('已处理完毕')).toBeNull();
});

it('says nothing about assignment once the flow has moved past review', async () => {
  mocks.reviewable.mockResolvedValue({ items: [{
    ...reviewable, id: 'req-3', appName: '研发规范问答', status: 'Approved', candidateScope: '',
    currentNodeKey: 'published', currentNodeName: '发布完成', taskId: undefined, availableActions: [],
  }], page: 1, pageSize: 100, total: 1 });
  render(<PublicationReviewsPage />);

  await screen.findByText('研发规范问答');
  // "发布完成" already explains the state; a filler line under it reads as noise.
  expect(screen.queryByText('不再等待审核')).toBeNull();
  expect(screen.queryByText('待分配')).toBeNull();
  expect(screen.queryByText('流程已结束')).toBeNull();
});

it('flags a pending review that has no candidate as unassigned', async () => {
  mocks.reviewable.mockResolvedValue({ items: [{
    ...reviewable, id: 'req-4', appName: '待分配应用', candidateScope: '', assigneeId: null,
  }], page: 1, pageSize: 100, total: 1 });
  render(<PublicationReviewsPage />);

  await screen.findByText('待分配应用');
  // Still waiting for review with nobody able to act is a real problem worth surfacing.
  expect(screen.getByText('待分配')).toBeInTheDocument();
});

it('keeps the dialog actions outside the scroll area so they stay reachable', async () => {
  const user = userEvent.setup();
  render(<PublicationReviewsPage />);
  await user.click(await screen.findByRole('button', { name: '查看设备知识助手详情' }));

  const dialog = screen.getByRole('dialog', { name: '设备知识助手 · 申请详情' });
  // Actions live in a pinned footer, not inside the element that scrolls.
  const footer = dialog.querySelector('.modal-footer');
  expect(footer).not.toBeNull();
  expect(dialog.querySelector('.modal-body')).not.toBeNull();
  expect(within(footer as HTMLElement).getByRole('button', { name: '通过设备知识助手' })).toBeInTheDocument();
  expect(dialog.querySelector('.modal-body')?.contains(footer!)).toBe(false);
  // The textarea must scroll with the content, not sit in the pinned footer.
  expect(within(footer as HTMLElement).queryByRole('textbox')).toBeNull();
});

it('reports an empty queue instead of rendering blank space', async () => {
  mocks.reviewable.mockResolvedValue({ items: [], page: 1, pageSize: 100, total: 0 });
  render(<PublicationReviewsPage />);
  await waitFor(() => expect(screen.getByText('当前没有待处理任务')).toBeInTheDocument());
});

it.each([
  ['Completed', 'Warning', '审查警告，待人工复核'],
  ['Completed', 'Needs Review', '需要人工复核'],
  ['Completed', 'Failed', '审计不通过'],
  ['Failed', null, '审计服务失败'],
  ['Cancelled', null, '审查已取消'],
  ['Rejected', null, '审查请求被拒绝'],
])('shows review-contract status %s and verdict %s separately', async (executionStatus, verdict, label) => {
  mocks.reviewable.mockResolvedValue({ items: [{ ...reviewable, audit: {
    nodeKey: 'code_audit', nodeName: '代码审查', executionStatus, verdict,
    decision: verdict === 'Failed' ? 'Rejected' : verdict,
    riskLevel: executionStatus === 'Completed' ? 'High' : null,
    taskId: executionStatus === 'Rejected' ? null : 'task-uuid',
    detailUrl: executionStatus === 'Rejected' ? null : 'https://review.example.com/reviews/task',
    finishedAt: '2026-11-12T08:30:00Z', errorCode: executionStatus === 'Rejected' ? 'REPOSITORY_UNAVAILABLE' : null,
    retryable: executionStatus === 'Rejected' ? false : null,
  } }], page: 1, pageSize: 100, total: 1 });
  const user = userEvent.setup(); render(<PublicationReviewsPage />);
  await user.click(await screen.findByRole('button', { name: '查看设备知识助手详情' }));
  expect(screen.getByText(label)).toBeInTheDocument();
  if (executionStatus === 'Completed') expect(screen.getByText('High')).toBeInTheDocument();
  if (executionStatus !== 'Rejected') expect(screen.getByRole('link', { name: '查看完整审计详情' })).toHaveAttribute('href', 'https://review.example.com/reviews/task');
  else expect(screen.getByText('REPOSITORY_UNAVAILABLE')).toBeInTheDocument();
});
