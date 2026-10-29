import {render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import McpPage from './page';
const api=vi.hoisted(()=>({getMcpServices:vi.fn(),getMcpGrantOptions:vi.fn(),saveMcp:vi.fn(),uploadMcpIcon:vi.fn(),testMcp:vi.fn()}));
vi.mock('../../lib/mcp-api',()=>api);
beforeEach(()=>{vi.clearAllMocks();api.getMcpGrantOptions.mockResolvedValue({users:[],roles:[],departments:[]});api.getMcpServices.mockResolvedValue([]);});
it('shows empty state and creates a centrally authorized MCP',async()=>{
 const user=userEvent.setup();render(<McpPage/>);await screen.findByText('暂无 MCP 服务');
 await user.click(screen.getByRole('button',{name:'添加 MCP'}));
 await user.type(screen.getByLabelText('名称'),'生产追溯');await user.type(screen.getByLabelText('MCP 地址'),'https://example.com/mcp');
 api.saveMcp.mockResolvedValue({id:'new-id'});await user.click(screen.getByRole('button',{name:'保存配置与授权'}));
 await waitFor(()=>expect(api.saveMcp).toHaveBeenCalledWith(expect.objectContaining({name:'生产追溯',isEnabled:false,grants:{userIds:[],roleIds:[],departmentIds:[]}}),'',false));
 expect(await screen.findByRole('status')).toHaveTextContent('已保存');
});
it('surfaces API errors',async()=>{api.getMcpServices.mockRejectedValue(new Error('读取失败'));render(<McpPage/>);expect(await screen.findByRole('alert')).toHaveTextContent('读取失败');});
