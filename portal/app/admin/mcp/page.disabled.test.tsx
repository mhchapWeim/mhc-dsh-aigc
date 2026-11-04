import { selectDropdown } from '../../../test/select-dropdown';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import McpPage from './page';

const api = vi.hoisted(() => ({
  getMcpServices: vi.fn(), getMcpGrantOptions: vi.fn(), saveMcp: vi.fn(),
  uploadMcpIcon: vi.fn(), testMcp: vi.fn(),
}));
vi.mock('../../lib/mcp-api', () => api);

beforeEach(() => {
  vi.clearAllMocks();
  api.getMcpGrantOptions.mockResolvedValue({ users: [], roles: [], departments: [] });
  api.getMcpServices.mockResolvedValue([]);
  api.saveMcp.mockResolvedValue({ id: 'new-id' });
});

const openModal = async (user: ReturnType<typeof userEvent.setup>) => {
  render(<McpPage />);
  await screen.findByText('暂无 MCP 服务');
  await user.click(screen.getByRole('button', { name: '添加 MCP' }));
};

// A greyed-out button must tell the user which field is missing.
it('states which required field is missing', async () => {
  const user = userEvent.setup();
  await openModal(user);
  const btn = screen.getByRole('button', { name: '保存配置与授权' });
  expect(btn).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('请填写名称、MCP 地址后再保存');

  await user.type(screen.getByLabelText('名称'), '生产追溯');
  expect(screen.getByRole('status')).toHaveTextContent('请填写MCP 地址后再保存');

  await user.type(screen.getByLabelText('MCP 地址'), 'https://mcp.deepwiki.com/mcp');
  expect(screen.queryByRole('status')).toBeNull();
  expect(btn).not.toBeDisabled();
});

// An address the API would reject must be reported inline, not silently disable the button.
it('reports an invalid address and keeps saving blocked', async () => {
  const user = userEvent.setup();
  await openModal(user);
  await user.type(screen.getByLabelText('名称'), '生产追溯');
  await user.type(screen.getByLabelText('MCP 地址'), 'not-a-url');
  expect(screen.getByText(/MCP 地址需为完整网址/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '保存配置与授权' })).toBeDisabled();
});

it('rejects a non-http scheme', async () => {
  const user = userEvent.setup();
  await openModal(user);
  await user.type(screen.getByLabelText('名称'), '生产追溯');
  await user.type(screen.getByLabelText('MCP 地址'), 'ftp://example.com/mcp');
  expect(screen.getByText('MCP 地址仅支持 http 或 https')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '保存配置与授权' })).toBeDisabled();
});

// The address field must accept the raw text a user pastes instead of silently dropping it.
it('keeps a pasted address that the browser would not consider a valid URL', async () => {
  const user = userEvent.setup();
  await openModal(user);
  await user.type(screen.getByLabelText('名称'), '生产追溯');
  await user.click(screen.getByLabelText('MCP 地址'));
  await user.paste('https://mcp.deepwiki.com/mcp');
  expect(screen.getByLabelText('MCP 地址')).toHaveValue('https://mcp.deepwiki.com/mcp');
  expect(screen.getByRole('button', { name: '保存配置与授权' })).not.toBeDisabled();
});

// Assertion-exchange services are dialed directly by DSH, which only trusts HTTPS (loopback excepted).
// The form must refuse a plain-HTTP address in that mode, mirroring the API.
it('requires https for the MCP address in assertion-exchange mode', async () => {
  const user = userEvent.setup();
  await openModal(user);
  await user.type(screen.getByLabelText('名称'), '生产追溯');
  await user.type(screen.getByLabelText('MCP 地址'), 'http://192.168.1.10:8080/mcp');
  selectDropdown(screen.getByRole('combobox', { name: '认证方式' }), 'UserAssertionExchange');
  expect(screen.getByText(/员工身份断言模式要求 HTTPS/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '保存配置与授权' })).toBeDisabled();

  await user.clear(screen.getByLabelText('MCP 地址'));
  await user.type(screen.getByLabelText('MCP 地址'), 'http://localhost:8765/mcp');
  expect(screen.queryByText(/员工身份断言模式要求 HTTPS/)).toBeNull();
  expect(screen.getByRole('button', { name: '保存配置与授权' })).toBeDisabled(); // still missing exchange fields
});

it('keeps http allowed for the MCP address in gateway mode', async () => {
  const user = userEvent.setup();
  await openModal(user);
  await user.type(screen.getByLabelText('名称'), '生产追溯');
  await user.type(screen.getByLabelText('MCP 地址'), 'http://192.168.1.10:8080/mcp');
  expect(screen.queryByText(/员工身份断言模式要求 HTTPS/)).toBeNull();
  expect(screen.getByRole('button', { name: '保存配置与授权' })).not.toBeDisabled();
});

// The quick connectivity test only applies to gateway services; assertion services get an explanation, not an error.
it('explains instead of erroring when testing an assertion-exchange service', async () => {
  const user = userEvent.setup();
  render(<McpPage />);
  await screen.findByText('暂无 MCP 服务');
  api.getMcpServices.mockResolvedValue([{ id: 'ke-id', name: 'KnowEngine', description: '', url: 'https://ke.test/mcp',
    isEnabled: true, timeoutSeconds: 60, revision: 1, iconDataUrl: '', hasServerSecret: false,
    authenticationMode: 'UserAssertionExchange', tokenExchangeUrl: 'https://ke.test/oauth2/dsh-token',
    assertionAudience: 'knowengine-mcp', tokenResource: 'https://ke.test/mcp', tokenScopes: 'kb:read',
    grants: { userIds: [], roleIds: [], departmentIds: [] } }]);
  await user.click(screen.getByRole('button', { name: '刷新' }));
  await user.click(await screen.findByRole('button', { name: '测试连接' }));
  expect(await screen.findByRole('status')).toHaveTextContent('员工身份断言服务需由获授权员工在 DSH 客户端实际登录后自动验证');
  expect(api.testMcp).not.toHaveBeenCalled();
});
