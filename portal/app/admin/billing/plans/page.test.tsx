import { selectDropdown } from '../../../../test/select-dropdown';
import {render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BillingPlansPage from './page';

const api=vi.hoisted(()=>({apiRequest:vi.fn(),hasBackend:true}));
vi.mock('../../../lib/api-client',()=>api);

const DIRECTORY={
  plans:[
    {id:'plan-1',name:'标准',weeklyTokens:1000000,isEnabled:true},
    {id:'plan-2',name:'停用配方',weeklyTokens:500000,isEnabled:false},
  ],
  assignments:[
    {subjectType:'Department',subjectId:'dept-1',planId:'plan-1'},
    {subjectType:'User',subjectId:'user-1',planId:'plan-1'},
    {subjectType:'User',subjectId:'user-2',planId:'plan-1'},
  ],
  users:[{id:'user-1',name:'王海',employeeNo:'wh00028',departmentId:'dept-1'}],
  departments:[{id:'dept-1',name:'数字化办公室'}],
};

beforeEach(()=>{
  vi.clearAllMocks();
  api.apiRequest.mockResolvedValue(DIRECTORY);
});

it('lists plans with their binding counts and the weekly reset rule',async()=>{
  render(<BillingPlansPage/>);
  const table=await screen.findByRole('table',{name:'计费配方'});
  expect(within(table).getByText('标准')).toBeInTheDocument();
  expect(within(table).getByText('1,000,000')).toBeInTheDocument();
  expect(within(table).getByText('1 个')).toBeInTheDocument();
  expect(within(table).getByText('2 人')).toBeInTheDocument();
  expect(screen.getByText(/周一 00:00（北京时间）重置/)).toBeInTheDocument();
});

it('shows how many plans are enabled in the summary cards',async()=>{
  render(<BillingPlansPage/>);
  await screen.findByRole('table',{name:'计费配方'});
  const stats=screen.getByLabelText('配方使用概况');
  expect(within(stats).getByText('配方数量').parentElement).toHaveTextContent('2');
  expect(within(stats).getByText('1 个启用')).toBeInTheDocument();
  expect(within(stats).getByText('已绑定部门').parentElement).toHaveTextContent('1');
});

it('creates a weekly plan through the modal',async()=>{
  const user=userEvent.setup();render(<BillingPlansPage/>);await screen.findByText('标准');
  await user.click(screen.getByRole('button',{name:/新增配方/}));
  await user.clear(screen.getByLabelText('配方名称'));
  await user.type(screen.getByLabelText('配方名称'),'高级');
  const weekly=screen.getByLabelText('每人每周 token');
  await user.clear(weekly);await user.type(weekly,'5000000');
  await user.click(screen.getByRole('button',{name:'保存配方'}));
  await waitFor(()=>expect(api.apiRequest).toHaveBeenCalledWith('/api/billing/plans',
    expect.objectContaining({method:'POST',body:JSON.stringify({id:'',name:'高级',weeklyTokens:5000000,isEnabled:true,userIds:[],departmentIds:[]})})));
  expect(await screen.findByRole('status')).toHaveTextContent('配方额度调整不会清空本周已用量');
});

it('edits an existing plan through PUT on its own id',async()=>{
  const user=userEvent.setup();render(<BillingPlansPage/>);await screen.findByText('标准');
  await user.click(screen.getAllByRole('button',{name:/编辑/})[0]!);
  await user.click(screen.getByRole('button',{name:'保存配方'}));
  await waitFor(()=>expect(api.apiRequest).toHaveBeenCalledWith('/api/billing/plans/plan-1',
    expect.objectContaining({method:'PUT'})));
});

it('warns that external models stay unavailable while no plan exists',async()=>{
  api.apiRequest.mockResolvedValue({plans:[],assignments:[],users:[],departments:[]});
  render(<BillingPlansPage/>);
  expect(await screen.findByText(/暂无计费配方/)).toBeInTheDocument();
  expect(screen.getByText(/内部模型不受影响/)).toBeInTheDocument();
});

it('surfaces load failures instead of rendering placeholder usage',async()=>{
  api.apiRequest.mockRejectedValue(new Error('读取失败'));
  render(<BillingPlansPage/>);
  expect(await screen.findByRole('alert')).toHaveTextContent('读取失败');
});

it('paginates plans and resets to the first page when the page size changes', async () => {
  api.apiRequest.mockResolvedValue({ ...DIRECTORY, plans: Array.from({ length: 12 }, (_, i) => ({
    id: `plan-${i}`, name: `分页配方${i + 1}`, weeklyTokens: 1000, isEnabled: true,
  })) });
  const user = userEvent.setup();
  render(<BillingPlansPage />);
  const table = await screen.findByRole('table', { name: '计费配方' });
  await screen.findByText('分页配方1');
  expect(within(table).getAllByRole('row')).toHaveLength(11);
  expect(within(table).queryByText('分页配方11')).toBeNull();
  const pager = screen.getByRole('navigation', { name: '计费配方分页' });
  expect(pager).toHaveTextContent('共 12 条');
  await user.click(within(pager).getByRole('button', { name: '下一页' }));
  expect(within(table).getByText('分页配方11')).toBeInTheDocument();
  expect(within(table).queryByText('分页配方1')).toBeNull();
  selectDropdown(within(pager).getByRole('combobox'), '5');
  expect(within(table).getByText('分页配方1')).toBeInTheDocument();
  expect(within(table).getAllByRole('row')).toHaveLength(6);
});

it('selects department and personal authorization when creating a plan', async () => {
  const user = userEvent.setup(); render(<BillingPlansPage />); await screen.findByText('标准');
  await user.click(screen.getByRole('button', { name: /新增配方/ }));
  await user.type(screen.getByLabelText('配方名称'), '授权配方');
  await user.click(screen.getByRole('combobox', { name: '授权部门' }));
  await user.click(screen.getByRole('option', { name: /数字化办公室/ }));
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('combobox', { name: '授权个人' }));
  await user.click(screen.getByRole('option', { name: /王海/ }));
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: '保存配方' }));
  await waitFor(() => expect(api.apiRequest).toHaveBeenCalledWith('/api/billing/plans', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ id: '', name: '授权配方', weeklyTokens: 1000000, isEnabled: true, userIds: ['user-1'], departmentIds: ['dept-1'] }),
  })));
});

it('blocks deletion of bound plans and confirms deletion of an unused plan',async()=>{
  const user=userEvent.setup(); render(<BillingPlansPage/>);
  const blocked = await screen.findByRole('button',{name:'删除配方 标准'});
  expect(blocked).toBeDisabled();
  expect(blocked).toHaveAccessibleDescription('配方仍绑定 1 个部门、2 位用户，请先解除绑定');
  await user.hover(blocked.parentElement!);
  expect(await screen.findByRole('tooltip')).toHaveTextContent('配方仍绑定 1 个部门、2 位用户，请先解除绑定');
  await user.click(screen.getByRole('button',{name:'删除配方 停用配方'}));
  expect(api.apiRequest).not.toHaveBeenCalledWith('/api/billing/plans/plan-2',expect.anything());
  await user.click(await screen.findByRole('button',{name:'确认删除'}));
  await waitFor(()=>expect(api.apiRequest).toHaveBeenCalledWith('/api/billing/plans/plan-2',{method:'DELETE'}));
  await waitFor(()=>expect(screen.queryByText('停用配方')).not.toBeInTheDocument());
});
