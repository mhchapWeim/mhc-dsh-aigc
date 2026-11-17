/** Reconcile organization authorization into automatically mounted MCP tools. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm-managed-backend'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { mountManagedMcp } from '@deepseek-ai/dsh-mcp-client'
import { z } from 'zod'
import type { ManagedMcpConnector } from './types.ts'

const policySchema = z.object({userId:z.string().uuid(), services:z.array(z.object({
  id:z.string().uuid(),name:z.string().max(120),description:z.string().max(2000),
  iconDataUrl:z.string().max(700000).refine(value => value === '' || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u.test(value)),
  revision:z.number().int(),timeoutSeconds:z.number().int().min(5).max(300),
  authenticationMode:z.enum(['gateway-bearer','user-assertion-exchange']).default('gateway-bearer'),
  gatewayPath:z.string().nullable().optional(),url:z.string().url().optional(),tokenExchangeUrl:z.string().url().optional(),
  tokenResource:z.string().optional(),tokenScopes:z.string().optional(),assertionPath:z.string().optional(),
})).max(100)})

const assertionSchema = z.object({assertion:z.string().min(1),expiresAt:z.string()})
const tokenSchema = z.object({access_token:z.string().min(1),token_type:z.string().transform(value=>value.toLowerCase()),
  expires_in:z.number().int().positive(),scope:z.string().optional()})

/** Install one serial, cancellable policy reconciler; lost authorization fails closed.
 * @param ctx Host context owning identity and tool registrations.
 * @param options Organization polling and request limits.
 * @param publish Publish the current user's display-only catalog.
 */
export function installManagedMcpSync(ctx: Context, options: {pollMs:number;requestTimeoutMs:number}, publish: (items:readonly ManagedMcpConnector[])=>void): void {
  ctx.inject(['managedBackend','credentials'], scope => {
    scope.effect(() => {
      const lifetime = new AbortController()
      let catalog: readonly ManagedMcpConnector[] = []
      const publishCatalog = (): void => {
        const next = catalog.map(item => ({ ...item, status: mounts.get(item.id)?.connection.connected() ? 'Ready' as const : Date.now() - (mounts.get(item.id)?.startedAt ?? 0) > 5000 ? 'Unavailable' as const : 'Connecting' as const }))
        publish(next)
      }
      let wake: (()=>void) | undefined
      let identityGeneration = 0
      const mounts = new Map<string, { signature:string; startedAt:number; connection:ReturnType<typeof mountManagedMcp> }>()
      const clear = async ():Promise<void> => {
        const previous = [...mounts.values()]; mounts.clear(); catalog = []; publish([])
        await Promise.all(previous.map(item=>item.connection.dispose()))
      }
      const healthTimer = setInterval(publishCatalog, 2000)
      scope.on('credentials/record-updated', key => {
        if (key !== credentialKey('llm-managed-backend', 'user-session')) return
        identityGeneration++; catalog = []; publish([]); wake?.()
      })
      const task = (async () => {
        while (!lifetime.signal.aborted) {
          const generation = identityGeneration
          try {
            const backend = scope.managedBackend
            if (backend.accessToken) await backend.accessToken()
            const record = await scope.credentials.readRecord(credentialKey('llm-managed-backend','user-session'))
            if (record?.kind !== 'api-key') { await clear() }
            else {
              const endpoint = backend.endpoint.replace(/\/$/u,'')
              const response = await fetch(`${endpoint}/v1/mcp/policy`, {redirect:'error',headers:{authorization:`Bearer ${record.key}`},
                signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(options.requestTimeoutMs)])})
              if (!response.ok) throw new Error(`MCP policy HTTP ${response.status}`)
              const policy = policySchema.parse(await response.json())
              if (generation !== identityGeneration || lifetime.signal.aborted) { await clear(); continue }
              const authorized = new Set(policy.services.map(item=>item.id))
              for (const [id,item] of mounts) if (!authorized.has(id)) {mounts.delete(id); await item.connection.dispose()}
              for (const item of policy.services) {
                const assertionExchange = item.authenticationMode === 'user-assertion-exchange'
                if (!assertionExchange && item.gatewayPath !== `/v1/mcp/${item.id}/gateway`) throw new Error('Invalid managed MCP gateway path')
                const directUrl = item.url === undefined ? undefined : new URL(item.url)
                const secureDirectUrl = directUrl?.protocol === 'https:'
                  || (directUrl?.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(directUrl.hostname))
                if (assertionExchange && (item.assertionPath !== `/v1/mcp/${item.id}/identity-assertion`
                  || !secureDirectUrl || !item.tokenExchangeUrl?.startsWith('https://'))) {
                  throw new Error('Invalid managed MCP identity exchange policy')
                }
                const signature = `${endpoint}/${policy.userId}/${item.revision}/${generation}`
                const old = mounts.get(item.id)
                if (old?.signature === signature) continue
                if (old) { mounts.delete(item.id); await old.connection.dispose() }
                if (generation !== identityGeneration || lifetime.signal.aborted) break
                let cachedToken: {value:string;expiresAt:number} | undefined
                let exchange: Promise<string> | undefined
                const organizationToken = async ():Promise<string> => {
                  const token = backend.accessToken ? await backend.accessToken() : record.key
                  if (!token) throw new Error('Organization session token is unavailable')
                  const current = await scope.credentials.readRecord(credentialKey('llm-managed-backend','user-session'))
                  if (generation !== identityGeneration || current?.kind !== 'api-key' || current.key !== token) throw new Error('Organization identity changed')
                  return token
                }
                const mcpToken = async ():Promise<string> => {
                  if (cachedToken && cachedToken.expiresAt-Date.now()>60_000) return cachedToken.value
                  if (exchange) return exchange
                  exchange = (async () => {
                    const aigcToken = await organizationToken()
                    const assertionResponse = await fetch(`${endpoint}${item.assertionPath!}`, {method:'POST',redirect:'error',
                      headers:{authorization:`Bearer ${aigcToken}`},signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(options.requestTimeoutMs)])})
                    if (!assertionResponse.ok) throw new Error(`MCP assertion HTTP ${assertionResponse.status}`)
                    const assertion = assertionSchema.parse(await assertionResponse.json())
                    const tokenResponse = await fetch(item.tokenExchangeUrl!, {method:'POST',redirect:'error',headers:{'content-type':'application/json'},
                      body:JSON.stringify({assertion:assertion.assertion}),signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(options.requestTimeoutMs)])})
                    if (!tokenResponse.ok) throw new Error(`MCP token exchange HTTP ${tokenResponse.status}`)
                    const issued = tokenSchema.parse(await tokenResponse.json())
                    if (issued.token_type !== 'bearer') throw new Error('MCP token exchange returned a non-Bearer token')
                    cachedToken={value:issued.access_token,expiresAt:Date.now()+issued.expires_in*1000}
                    return issued.access_token
                  })().finally(()=>{exchange=undefined})
                  return exchange
                }
                const connection = mountManagedMcp(scope, {
                  transport:'streamable-http',serverName:`org_${item.id.replace(/-/gu,'').slice(0,28)}`,
                  url:assertionExchange ? item.url! : `${endpoint}${item.gatewayPath!}`,
                  closeTimeoutMs:options.requestTimeoutMs,expandTemplates:false,headers:{},toolCallTimeoutMs:item.timeoutSeconds*1000,failOnStartupError:false,
                  requestHeaders:async () => {
                    if (generation !== identityGeneration || lifetime.signal.aborted) throw new Error('Organization identity changed')
                    return {authorization:`Bearer ${assertionExchange ? await mcpToken() : await organizationToken()}`}
                  },
                })
                mounts.set(item.id,{signature,startedAt:Date.now(),connection})
              }
              if (generation === identityGeneration && !lifetime.signal.aborted) { catalog = policy.services.map(item=>({
                id:item.id,name:item.name,description:item.description,iconDataUrl:item.iconDataUrl,
                status:mounts.get(item.id)?.connection.connected() ? 'Ready' : 'Connecting',
              })); publishCatalog() }
              else await clear()
            }
          } catch (error) {
            await clear()
            if (!lifetime.signal.aborted) scope.logger('managed-mcp').warn(error instanceof Error ? error.message : String(error))
          }
          if (lifetime.signal.aborted) break
          if (generation !== identityGeneration) continue
          await new Promise<void>(resolve => {
            const done = ():void => {clearTimeout(timer); lifetime.signal.removeEventListener('abort',done); wake=undefined; resolve()}
            const timer = setTimeout(done,options.pollMs); wake=done; lifetime.signal.addEventListener('abort',done,{once:true})
          })
        }
      })()
      return async () => {clearInterval(healthTimer);lifetime.abort(); wake?.(); await task; await clear()}
    }, 'managed-mcp.policy')
  })
}
