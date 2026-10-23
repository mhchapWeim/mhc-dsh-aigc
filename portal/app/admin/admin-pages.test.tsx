import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlatformProvider, usePlatform } from '../components/platform-provider';
import { useLayoutEffect, useRef } from 'react';
import AdminDashboard from './page';
import UserManagementPage from './users/page';
import CategoryManagementPage from './categories/page';
import ProcessDesignerPage from './processes/page';
import PublicationRequestsPage from './publications/page';
import PublicationReviewsPage from './reviews/page';
import { AdminShell } from './components/admin-shell';
import DepartmentManagementPage from './departments/page';
import LoginPage from '../login/page';
import LocalLoginPage from '../login/local/page';
import RoleManagementPage from './roles/page';

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/admin', useRouter: () => ({ replace: replaceMock }) }));

function SignedInFixture({ children }: { children: React.ReactNode }) {
  const { dispatch } = usePlatform();
  const initialized = useRef(false);
  useLayoutEffect(() => { if (!initialized.current) { initialized.current = true; void dispatch({ type: 'login', employeeNo: 'wh00028' }); } }, [dispatch]);
  return children;
}
function renderWithPlatform(node: React.ReactNode) {
  return render(<PlatformProvider><SignedInFixture>{node}</SignedInFixture></PlatformProvider>);
}

describe('admin pages', () => {
  it('shows plugin management and status under a standalone plugin market menu', async () => {
    localStorage.removeItem('aigc-admin-sidebar');
    const user = userEvent.setup();
    renderWithPlatform(<AdminShell><div>content</div></AdminShell>);
    await user.click(screen.getByRole('button', { name: '插件市场' }));
    expect(screen.getByRole('link', { name: '插件管理' })).toHaveAttribute('href', '/admin/plugins');
    expect(screen.getByRole('link', { name: '插件状态' })).toHaveAttribute('href', '/admin/plugins/status');
    await user.click(screen.getByRole('button', { name: '客户端运维' }));
    expect(screen.queryByRole('link', { name: '插件管理' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '插件状态' })).not.toBeInTheDocument();
    await user.click(screen.getByText('版本管理'));
    expect(screen.getByRole('link', { name: '版本发布' })).toHaveAttribute('href', '/admin/client-releases');
    expect(screen.getByRole('link', { name: '版本状态' })).toHaveAttribute('href', '/admin/client-releases/status');
    expect(screen.queryByText('发布上报')).not.toBeInTheDocument();

  });
  it('shows an operational overview on the dashboard', () => {
    renderWithPlatform(<AdminDashboard />);
    expect(screen.getByRole('heading', { name: '运营工作台' })).toBeInTheDocument();
    expect(screen.getByText('运行中流程')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '发布新应用' })).toHaveAttribute('href', '/admin/publications');
  });

  it('filters users by name or employee number', async () => {
    const user = userEvent.setup();
    renderWithPlatform(<UserManagementPage />);
    await user.type(screen.getByRole('searchbox', { name: '搜索用户' }), 'wh00412');
    expect(screen.getByText('李俊')).toBeInTheDocument();
    expect(screen.queryByText('姚伟明')).not.toBeInTheDocument();
  });

  it('uses a modern popup list for user department selection', async () => {
    const user = userEvent.setup();
    renderWithPlatform(<UserManagementPage />);

    await user.click(screen.getByRole('button', { name: '新增用户' }));
    const department = screen.getByRole('combobox', { name: '部门' });
    await user.click(department);

    expect(screen.getByRole('listbox', { name: '部门选项' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: '研发中心' }));
    expect(department).toHaveTextContent('研发中心');
  });

  it('explains why a category with applications cannot be deleted', async () => {
    const user = userEvent.setup();
    renderWithPlatform(<CategoryManagementPage />);
    await user.click(screen.getByRole('button', { name: '删除智慧服务' }));
    expect(screen.getByRole('status')).toHaveTextContent('仍有关联应用');
  });

  it('renders category and department management as compact data grids', () => {
    const categoryView = renderWithPlatform(<CategoryManagementPage />);
    expect(screen.getByRole('table', { name: '分类数据表格' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '分类分页' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '第 1 页' })).toHaveAttribute('aria-current', 'page');
    categoryView.unmount();

    renderWithPlatform(<DepartmentManagementPage />);
    expect(screen.getByRole('table', { name: '部门数据表格' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '部门分页' })).toBeInTheDocument();
  });

  it('uses the shared Ant-style pagination on every admin list page', () => {
    const pages: Array<[React.ReactNode, string]> = [
      [<UserManagementPage key="users" />, '用户分页'],
      [<RoleManagementPage key="roles" />, '角色分页'],
      [<PublicationRequestsPage key="publications" />, '发布申请分页'],
      [<PublicationReviewsPage key="reviews" />, '发布审核分页'],
    ];

    pages.forEach(([page, label]) => {
      const view = renderWithPlatform(page);
      expect(screen.getByRole('navigation', { name: label })).toBeInTheDocument();
      view.unmount();
    });
  });

  it('adds a BPMN task from the palette', async () => {
    const user = userEvent.setup();
    render(<ProcessDesignerPage />);
    const before = screen.getAllByTestId('process-node').length;
    await user.click(screen.getByRole('button', { name: '添加用户任务' }));
    expect(screen.getAllByTestId('process-node')).toHaveLength(before + 1);
  });

  it('connects two BPMN nodes from their ports', async () => {
    const user = userEvent.setup();
    render(<ProcessDesignerPage />);
    await user.click(screen.getByRole('button', { name: '从开始开始连线' }));
    await user.click(screen.getByRole('button', { name: '连接到生成内容' }));
    expect(screen.getByRole('status')).toHaveTextContent('已存在');
  });

  it('renders login and department management', () => {
    renderWithPlatform(<LoginPage />);
    expect(screen.getByRole('heading', { name: '登录 AIGC Agent Hub' })).toBeInTheDocument();
    renderWithPlatform(<DepartmentManagementPage />);
    expect(screen.getByRole('heading', { name: '部门管理' })).toBeInTheDocument();
  });

  it('redirects a successful login to the portal home', async () => {
    const user = userEvent.setup();
    renderWithPlatform(<LocalLoginPage />);
    expect(screen.getByRole('textbox', { name: '企业工号' })).toHaveValue('');
    expect(screen.getByLabelText('密码')).toHaveValue('');
    await user.type(screen.getByRole('textbox', { name: '企业工号' }), 'wh00028');
    await user.type(screen.getByLabelText('密码'), 'test-password');
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(replaceMock).toHaveBeenCalledWith('/');
  });

  it('keeps a disabled or unknown account on the login page', async () => {
    replaceMock.mockClear();
    const user = userEvent.setup();
    renderWithPlatform(<LocalLoginPage />);
    const employeeNo = screen.getByRole('textbox', { name: '企业工号' });
    await user.clear(employeeNo);
    await user.type(employeeNo, 'unknown');
    await user.type(screen.getByLabelText('密码'), 'test-password');
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(replaceMock).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('账号不存在');
  });

  it('presents roles in a data grid and configures permissions in a modal', async () => {
    const user = userEvent.setup();
    renderWithPlatform(<RoleManagementPage />);
    expect(screen.getByRole('heading', { name: '角色管理' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: '角色数据表格' })).toBeInTheDocument();
    expect(screen.getByText('共 3 个角色')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: '普通用户查看用户管理' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '配置普通用户权限' }));

    expect(screen.getByRole('dialog', { name: '配置普通用户权限' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '普通用户查看用户管理' })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: '全选' }));
    await waitFor(() => { for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).toBeChecked(); });
    expect(screen.getByRole('button', { name: '全选' })).toBeDisabled();
  });

  it('paginates the role data grid', async () => {
    const user = userEvent.setup();
    renderWithPlatform(<RoleManagementPage />);

    for (const name of ['审计员1', '审计员2', '审计员3']) {
      await user.click(screen.getByRole('button', { name: '新增角色' }));
      await user.type(screen.getByRole('textbox', { name: '角色名称' }), name);
      await user.click(screen.getByRole('button', { name: '保存角色' }));
    }

    expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByRole('cell', { name: /审计员3/ })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: /平台管理员/ })).not.toBeInTheDocument();
  });

  it('creates a role that becomes available to user management', async () => {
    const user = userEvent.setup();
    renderWithPlatform(<><RoleManagementPage /><UserManagementPage /></>);
    await user.click(screen.getByRole('button', { name: '新增角色' }));
    await user.type(screen.getByRole('textbox', { name: '角色名称' }), '审计员');
    await user.click(screen.getByRole('button', { name: '保存角色' }));
    await user.click(screen.getByRole('button', { name: '新增用户' }));
    await user.click(screen.getByRole('combobox', { name: '角色' }));
    expect(screen.getByRole('option', { name: '审计员' })).toBeInTheDocument();
  });

  it('assigns a user task to a searchable domain user', async () => {
    const user = userEvent.setup();
    render(<ProcessDesignerPage />);

    const assignmentType = screen.getByRole('combobox', { name: '分配方式' });
    await user.click(assignmentType);
    await user.click(screen.getByRole('option', { name: '指定域用户' }));
    await user.click(screen.getByRole('button', { name: '选择域用户' }));
    await user.type(screen.getByRole('searchbox', { name: '搜索域用户' }), '李俊');
    await user.click(screen.getByRole('option', { name: /李俊.*wh00412/ }));

    expect(screen.getByText('李俊 · wh00412')).toBeInTheDocument();
  });

  it('configures inbox notification for user tasks', async () => {
    const user = userEvent.setup();
    render(<ProcessDesignerPage />);

    const notification = screen.getByRole('switch', { name: '发送站内信' });
    expect(notification).toHaveAttribute('aria-checked', 'true');
    await user.click(notification);
    expect(notification).toHaveAttribute('aria-checked', 'false');
  });

  it('submits an application request into the workflow', async () => {
    const user = userEvent.setup();
    renderWithPlatform(<PublicationRequestsPage />);

    await user.click(screen.getByRole('button', { name: '新建发布申请' }));
    await user.type(screen.getByRole('textbox', { name: '应用名称' }), '设备知识助手');
    await user.type(screen.getByRole('textbox', { name: '应用简介' }), '检索设备知识与维修经验');
    await user.type(screen.getByRole('textbox', { name: '代码仓库' }), 'https://git.example/apps/device.git');
    await user.type(screen.getByRole('textbox', { name: 'Commit SHA' }), 'abcdef1234567890');
    await user.type(screen.getByRole('textbox', { name: '发布版本' }), '1.0.0');
    await user.click(screen.getByRole('button', { name: '提交发布申请' }));

    expect(screen.getByText('设备知识助手')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('进入应用发布审核节点');
  });

  it('shows resubmit only when the current user owns the revise task', () => {
    renderWithPlatform(<PublicationRequestsPage />);
    expect(screen.getByRole('button', { name: '重新提交智能工位导航' })).toBeInTheDocument();
  });

  it('shows review actions only for tasks assigned to the current user or group', () => {
    renderWithPlatform(<PublicationReviewsPage />);

    expect(screen.getByRole('button', { name: '通过质量问题分析助手' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退回质量问题分析助手' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '通过招聘面试 Copilot' })).not.toBeInTheDocument();
    expect(screen.getByText('不在当前处理范围')).toBeInTheDocument();
  });

  it('completes an authorized publication review', async () => {
    const user = userEvent.setup();
    renderWithPlatform(<PublicationReviewsPage />);

    await user.click(screen.getByRole('button', { name: '通过质量问题分析助手' }));

    expect(screen.getByText('审核已通过，应用已进入发布节点')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '通过质量问题分析助手' })).not.toBeInTheDocument();
  });

  it('exposes publishing workflow destinations in the admin navigation', () => {
    renderWithPlatform(<AdminShell><div>content</div></AdminShell>);

    expect(screen.getByRole('link', { name: /发布申请/ })).toHaveAttribute('href', '/admin/publications');
    expect(screen.getByRole('link', { name: /发布审核/ })).toHaveAttribute('href', '/admin/reviews');
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('opens clickable child destinations when hovering a collapsed group', async () => {
    localStorage.removeItem('aigc-admin-sidebar');
    const user = userEvent.setup();
    renderWithPlatform(<AdminShell><div>content</div></AdminShell>);
    await user.click(screen.getByRole('button', { name: '收起侧边栏' }));
    expect(screen.queryByRole('link', { name: '用户管理' })).not.toBeInTheDocument();
    const group = screen.getByRole('button', { name: '组织与权限' });
    await user.hover(group);
    const destination = await screen.findByRole('link', { name: '用户管理' });
    expect(destination).toHaveAttribute('href', '/admin/users');
    await user.hover(destination);
    expect(screen.getByRole('navigation', { name: '组织与权限子菜单' })).toBeInTheDocument();
    await user.click(destination);
    expect(screen.queryByRole('navigation', { name: '组织与权限子菜单' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '展开侧边栏' })).toBeInTheDocument();
    expect(localStorage.getItem('aigc-admin-sidebar')).toBe('collapsed');
    localStorage.removeItem('aigc-admin-sidebar');
  });

  it('restores the collapsed sidebar after navigation remounts the shell', async () => {
    localStorage.setItem('aigc-admin-sidebar', 'collapsed');
    const view = renderWithPlatform(<AdminShell><div>content</div></AdminShell>);
    await waitFor(() => expect(screen.getByRole('button', { name: '展开侧边栏' })).toBeInTheDocument());
    view.unmount();
    renderWithPlatform(<AdminShell><div>next page</div></AdminShell>);
    await waitFor(() => expect(screen.getByRole('button', { name: '展开侧边栏' })).toBeInTheDocument());
    localStorage.removeItem('aigc-admin-sidebar');
  });

  it('expands only one navigation group at a time and allows closing it', async () => {
    const user = userEvent.setup();
    renderWithPlatform(<AdminShell><div>content</div></AdminShell>);
    const collaboration = screen.getByRole('button', { name: '协作与发布' });
    const organization = screen.getByRole('button', { name: '组织与权限' });
    expect(collaboration).toHaveAttribute('aria-expanded', 'true');
    await user.click(organization);
    expect(organization).toHaveAttribute('aria-expanded', 'true');
    expect(collaboration).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: '发布申请' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '用户管理' })).toBeInTheDocument();
    await user.click(organization);
    expect(organization).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: '用户管理' })).not.toBeInTheDocument();
  });
});
