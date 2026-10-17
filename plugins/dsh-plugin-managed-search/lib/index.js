import z from '@deepseek-ai/schemastery';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { WebError } from '@deepseek-ai/dsh-web';
import { searchOrganization } from './transport.js';

export const name = 'web-search-managed';
export const inject = ['web', 'credentials', 'managedBackend'];
export const Config = z.object({ requestTimeoutMs: z.number().min(1000).max(120000).default(30000) });

/** The web registry binds registration disposal to this plugin's fiber. */
export function apply(ctx, config) {
  ctx.web.registerSearchProvider({
    id: 'aigc-managed', available: () => true,
    async search(request, signal) {
      const record = await ctx.credentials.readRecord(credentialKey('llm-managed-backend', 'user-session'));
      if (record?.kind !== 'api-key') throw new WebError('请登录 AIGC 后使用网页搜索', 'WEB_PROVIDER_CREDENTIAL_MISSING');
      try { return await searchOrganization(ctx.managedBackend.endpoint, record.key, request, signal, config.requestTimeoutMs); }
      catch (error) {
        if (signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') throw new WebError('搜索请求已取消或超时', 'WEB_ABORTED');
        throw new WebError(error instanceof Error ? error.message : String(error), error?.code ?? 'WEB_PROVIDER_ERROR');
      }
    },
  });
}
