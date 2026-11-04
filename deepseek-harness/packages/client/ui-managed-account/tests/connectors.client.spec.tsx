// @vitest-environment jsdom
import {expect,it,onTestFinished,vi} from 'vitest'
import {render,screen,fireEvent,cleanup} from '@testing-library/react'
import {Context} from '@deepseek-ai/cordis'
import {LocaleRuntime} from '@deepseek-ai/dsh-client-locale/client'
import {SlotRegistry} from '@deepseek-ai/dsh-client-ui-renderer/client'
import {TestRemote} from '@deepseek-ai/dsh-client-test-runtime'
import {installConnectors} from '../src/client/connectors.tsx'
import {ConnectorCards} from '../src/client/ConnectorCards.tsx'
import type {ManagedMcpConnector} from '@deepseek-ai/dsh-plugin-manager/types'
const item:ManagedMcpConnector={id:'test',name:'生产追溯',description:'查询产品检验记录',iconDataUrl:'',status:'Ready'}

it('shows cards and search without add or activation switches',()=>{
 onTestFinished(cleanup);render(<ConnectorCards items={[item]} english={false}/>);
 expect(screen.getByText('已连接')).toBeTruthy();expect(screen.queryByRole('switch')).toBeNull();expect(screen.queryByText('+')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/生产追溯/u}));expect(screen.getByRole('button',{name:/生产追溯/u}).getAttribute('aria-expanded')).toBe('true');
 fireEvent.change(screen.getByRole('textbox',{name:'搜索连接器'}),{target:{value:'没有匹配'}});expect(screen.getByRole('status').textContent).toContain('暂无');
});
it('only registers navigation while authorized and clears it on identity changes',async()=>{
 const ctx=new Context();onTestFinished(()=>ctx.fiber.dispose());await ctx.plugin(SlotRegistry).await();ctx.provide('locale',new LocaleRuntime(ctx));
 const slots=ctx.get('slots') as SlotRegistry;
 slots.register({name:'root',children:{main:{kind:'keyed',scope:'root'},'sidebar.panellist':{kind:'list',scope:'root'}}} as never,()=>null);
 const read=vi.fn(async()=>({ok:true as const,value:[] as readonly ManagedMcpConnector[]}));
 const remote=new TestRemote(ctx,{pluginManager:{connectors:read}});
 await ctx.plugin({inject:['slots','locale','remote','remote.pluginManager'],apply:installConnectors}).await();
 expect(slots.entries('sidebar.panellist')).toHaveLength(0);
 remote.emit('plugin-manager/connectors-updated',[[item]]);
 await vi.waitFor(()=>expect(slots.entries('sidebar.panellist')).toHaveLength(1));
 const navigation=slots.entries('sidebar.panellist')[0];
 const reads=read.mock.calls.length;
 remote.emit('credentials/record-updated',['llm-managed-backend/billing-pending']);
 expect(slots.entries('sidebar.panellist')[0]).toBe(navigation);
 expect(read).toHaveBeenCalledTimes(reads);
 remote.emit('credentials/record-updated',['llm-managed-backend/user-session']);
 expect(slots.entries('sidebar.panellist')).toHaveLength(0);
 await vi.waitFor(()=>expect(read).toHaveBeenCalledTimes(reads+1));
 remote.emit('plugin-manager/connectors-updated',[[]]);
 await vi.waitFor(()=>expect(slots.entries('sidebar.panellist')).toHaveLength(0));
});
