/** Real Loader composition and real MCP SDK; only the organization policy is an external fixture. */
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect,it,vi} from 'vitest'
import type {Context} from '@deepseek-ai/cordis'
import {boot} from '@deepseek-ai/dsh-app-boot'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import {credentialKey} from '@deepseek-ai/dsh-credentials'
import {installManagedMcpSync} from '../src/managed-mcp.ts'
import type {ManagedMcpConnector} from '../src/types.ts'
import {startHttpMcpFixture} from '../../../mcp/mcp-client/tests/http-fixture.ts'

it('automatically registers authorized tools, calls the real MCP SDK and removes tools on revocation and signout',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'managed-mcp-'))
  const fixture=await startHttpMcpFixture()
  const id='11111111-1111-4111-8111-111111111111'
  const userId='22222222-2222-4222-8222-222222222222'
  let authorized=true; let latest:readonly ManagedMcpConnector[]=[]; let exchanges=0
  const realFetch=globalThis.fetch
  const send=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
    const url=String(input)
    if(url==='https://organization.test/v1/mcp/policy')return Response.json({userId,services:authorized && new Headers(init?.headers).get('authorization') !== 'Bearer other-user-token'?[{id,name:'追溯',description:'产品查询',iconDataUrl:'',revision:1,timeoutSeconds:5,
      authenticationMode:'user-assertion-exchange',url:fixture.url,tokenExchangeUrl:'https://knowengine.test/oauth2/dsh-token',
      tokenResource:fixture.url,tokenScopes:'kb:read',assertionPath:`/v1/mcp/${id}/identity-assertion`,gatewayPath:null}]:[]})
    if(url===`https://organization.test/v1/mcp/${id}/identity-assertion`){
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer user-token')
      return Response.json({assertion:'signed-employee-assertion',expiresAt:new Date(Date.now()+60_000).toISOString()})
    }
    if(url==='https://knowengine.test/oauth2/dsh-token'){
      exchanges++;expect(JSON.parse(String(init?.body))).toEqual({assertion:'signed-employee-assertion'})
      return Response.json({access_token:'employee-mcp-token',token_type:'Bearer',expires_in:600,scope:'kb:read'})
    }
    return realFetch(input,init)
  })
  let shutdown:(()=>Promise<void>)|undefined
  try {
    const config=join(dir,'cordis.yml')
    await writeFile(config,JSON.stringify([
      {id:'prompt',name:'cordis:prompt'},
      {id:'tools',name:'cordis:tools'},
      {id:'credentials',name:'cordis:credentials',config:{path:join(dir,'credentials.yaml'),watch:false}},
      {id:'connectors',name:'cordis:connectors'},
    ]))
    const ctx=await boot('test',config,[],ctx=>{
      ctx.loader.builtins.prompt=SystemPrompt
      ctx.loader.builtins.tools=ToolRuntime
      ctx.loader.builtins.credentials=CredentialsLocal
      ctx.loader.builtins.connectors={name:'test-managed-mcp',apply(inner:Context){installManagedMcpSync(inner,{pollMs:25,requestTimeoutMs:1000},value=>{latest=value})}}
      ctx.provide('managedBackend',{endpoint:'https://organization.test'})
    })
    shutdown=async()=>{await ctx.fiber.dispose()}
    const key=credentialKey('llm-managed-backend','user-session')
    await ctx.credentials.modifyRecord(key,async()=>({kind:'api-key',key:'user-token'}))
    const name=`mcp__org_${id.replace(/-/gu,'').slice(0,28)}__ping`
    await vi.waitFor(()=>expect(latest[0]?.status).toBe('Ready'),{timeout:10000})
    const result=await ctx.tools.execute({signal:new AbortController().signal,callId:ToolCallId('managed-mcp-call'),name,arguments:{}})
    expect(result.content).toEqual([{type:'text',text:'pong'}])
    expect(fixture.authorization).toContain('Bearer employee-mcp-token')
    expect(exchanges).toBe(1)
    authorized=false
    await vi.waitFor(()=>expect(latest).toEqual([]))
    expect(ctx.tools.get(name)).toBeUndefined()
    authorized=true
    await vi.waitFor(()=>expect(latest[0]?.status).toBe('Ready'),{timeout:10000})
    await ctx.credentials.modifyRecord(key,async()=>({kind:'api-key',key:'other-user-token'}))
    await vi.waitFor(()=>expect(ctx.tools.get(name)).toBeUndefined())
    expect(latest).toEqual([])
    await ctx.credentials.modifyRecord(key,async()=>({kind:'api-key',key:'user-token'}))
    await vi.waitFor(()=>expect(latest[0]?.status).toBe('Ready'),{timeout:10000})
    await ctx.credentials.deleteRecord(key)
    await vi.waitFor(()=>expect(ctx.tools.get(name)).toBeUndefined())
    expect(latest).toEqual([])
  }finally{await shutdown?.();send.mockRestore();await fixture.close();await rm(dir,{recursive:true,force:true})}
},20000)






