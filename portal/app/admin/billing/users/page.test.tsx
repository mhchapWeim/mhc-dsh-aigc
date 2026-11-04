import { selectDropdown } from '../../../../test/select-dropdown';
import {render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BillingUsersPage from './page';

const api=vi.hoisted(()=>({apiRequest:vi.fn(),hasBackend:true}));
vi.mock('../../../lib/api-client',()=>api);

// Recharts measures its container; jsdom reports zero size, so render fixed dimensions.
vi.mock('recharts',async importOriginal=>{
  const actual=await importOriginal<typeof import('recharts')>();
  const Passthrough=({children}:{children?:React.ReactNode})=><div>{children}</div>;
  return {...actual,ResponsiveContainer:Passthrough};
});

const REPORT={
  from:'2026-10-26T00:00:00Z',to:'2026-11-02T00:00:00Z',
  trend:[
    {date:'2026-10-26',totalTokens:800,chargedTokens:1600,requests:1},
    {date:'2026-10-27',totalTokens:700,chargedTokens:1400,requests:1},
  ],
  byUser:[{userId:'user-1',employeeNo:'wh00028',userName:'王海',departmentName:'数字化办公室',totalTokens:1500,chargedTokens:3000,requests:2}],
  byDepartment:[{departmentName:'数字化办公室',totalTokens:1500,chargedTokens:3000,requests:2}],
  byModel:[{modelName:'Team Large',modelIdentifier:'team-large',totalTokens:1500,chargedTokens:3000,requests:2}],
  totals:{totalTokens:1500,chargedTokens:3000,requests:2},
  pending:[{id:'pending-1',userName:'王海',modelName:'Team Large',reservedTokens:4000,createdAt:'2026-10-28T02:00:00Z'}],
};
const DIRECTORY={
  plans:[],assignments:[],
  users:[{id:'user-1',name:'王海',employeeNo:'wh00028',departmentId:'dept-1'}],
  departments:[{id:'dept-1',name:'数字化办公室'}],
};

beforeEach(()=>{
  vi.clearAllMocks();
  api.apiRequest.mockImplementation(async(path:string)=>path.startsWith('/api/billing/report')?REPORT:DIRECTORY);
});

it('summarises raw and charged usage in cards',async()=>{
  render(<BillingUsersPage/>);
  const stats=await screen.findByLabelText('用量汇总');
  expect(within(stats).getByText('1,500')).toBeInTheDocument();
  expect(within(stats).getByText('3,000')).toBeInTheDocument();
  expect(within(stats).getByText('2')).toBeInTheDocument();
});

it('renders the daily trend and the department and model charts',async()=>{
  render(<BillingUsersPage/>);
  expect(await screen.findByRole('img',{name:'按日 token 用量趋势折线图'})).toBeInTheDocument();
  expect(screen.getByRole('img',{name:'部门 token 用量柱状图'})).toBeInTheDocument();
  expect(screen.getByRole('img',{name:'模型 token 用量柱状图'})).toBeInTheDocument();
  expect(screen.getByText('用量趋势')).toBeInTheDocument();
  expect(screen.getByText('部门用量')).toBeInTheDocument();
  expect(screen.getByText('模型用量')).toBeInTheDocument();
});

it('explains an empty range instead of drawing an empty chart',async()=>{
  api.apiRequest.mockImplementation(async(path:string)=>(path.startsWith('/api/billing/report')
    ? {...REPORT,trend:[],byDepartment:[],byModel:[],byUser:[],totals:{totalTokens:0,chargedTokens:0,requests:0}}
    : DIRECTORY));
  render(<BillingUsersPage/>);
  expect(await screen.findByText('所选区间暂无已结算用量')).toBeInTheDocument();
  expect(screen.queryByRole('img',{name:'按日 token 用量趋势折线图'})).toBeNull();
});

it('filters by range and person',async()=>{
  const user=userEvent.setup();render(<BillingUsersPage/>);await screen.findByText('用量趋势');
  selectDropdown(screen.getByRole('combobox', { name: '个人筛选' }),'user-1');
  await waitFor(()=>expect(api.apiRequest.mock.calls.some(([path])=>
    String(path)==='/api/billing/report?userId=user-1')).toBe(true));
});

it('switches the detail table between the three groupings',async()=>{
  const user=userEvent.setup();render(<BillingUsersPage/>);await screen.findByText('用量趋势');
  await user.click(screen.getByRole('tab',{name:'按模型'}));
  const table=screen.getByRole('table',{name:'Token用度报表'});
  expect(within(table).getByText('Team Large')).toBeInTheDocument();
});

it('exports the visible grouping as CSV',async()=>{
  const user=userEvent.setup();render(<BillingUsersPage/>);await screen.findByText('用量趋势');
  const createObjectURL=vi.fn(()=> 'blob:usage');const revokeObjectURL=vi.fn();
  Object.assign(URL,{createObjectURL,revokeObjectURL});
  await user.click(screen.getByRole('button',{name:/导出 CSV/}));
  expect(createObjectURL).toHaveBeenCalled();
});

it('releases an abandoned reservation only after a reconciliation note',async()=>{
  const user=userEvent.setup();render(<BillingUsersPage/>);await screen.findByText(/待核对预占/);
  await user.click(screen.getByRole('button',{name:'核对后释放'}));
  await user.type(screen.getByLabelText(/核对结果及释放原因/),'上游无记录');
  await user.click(screen.getByRole('button',{name:'确认释放'}));
  await waitFor(()=>expect(api.apiRequest).toHaveBeenCalledWith('/api/billing/pending/pending-1/release',
    expect.objectContaining({method:'POST',body:JSON.stringify({reason:'上游无记录'})})));
});

it('surfaces load failures instead of rendering placeholder usage',async()=>{
  api.apiRequest.mockRejectedValue(new Error('读取失败'));
  render(<BillingUsersPage/>);
  expect(await screen.findByRole('alert')).toHaveTextContent('读取失败');
});
