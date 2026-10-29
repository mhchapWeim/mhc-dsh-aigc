import { apiRequest, type GrantOptions, type GrantSelection } from './api-client';
export type McpService = { id: string; name: string; description: string; url: string; isEnabled: boolean;
  timeoutSeconds: number; revision: number; iconDataUrl: string; hasServerSecret: boolean; grants: GrantSelection;
  authenticationMode: 'GatewayBearer' | 'UserAssertionExchange'; tokenExchangeUrl: string;
  assertionAudience: string; tokenResource: string; tokenScopes: string };
export const getMcpServices = () => apiRequest<McpService[]>('/api/mcp');
export const getMcpGrantOptions = () => apiRequest<GrantOptions>('/api/mcp/grant-options');
export const saveMcp = (item: McpService, secret: string, clearSecret: boolean) => apiRequest<{id: string}>(item.id ? `/api/mcp/${item.id}` : '/api/mcp', {
  method: item.id ? 'PUT' : 'POST', body: JSON.stringify({ name: item.name, description: item.description, url: item.url,
    isEnabled: item.isEnabled, timeoutSeconds: item.timeoutSeconds, grants: item.grants, serverSecret: secret, clearSecret,
    authenticationMode: item.authenticationMode, tokenExchangeUrl: item.tokenExchangeUrl,
    assertionAudience: item.assertionAudience, tokenResource: item.tokenResource, tokenScopes: item.tokenScopes }),
});
export const uploadMcpIcon = (id: string, file: File) => {
  const body = new FormData(); body.append('icon', file);
  return apiRequest<void>(`/api/mcp/${id}/icon`, { method: 'POST', body });
};
export const testMcp = (id: string) => apiRequest<{tools: {name: string; description?: string; inputSchema: unknown}[]; hasMore: boolean}>(`/api/mcp/${id}/test`, {method: 'POST'});
