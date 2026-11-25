import { apiRequest } from './api-client';

export type IntegrationOperation = { code: string; resultEvent: string; protocol?: 'generic-v1' | 'code-review-20261112' };
export type IntegrationService = { code: string; name: string; kind: 'Mq' | 'Gitea'; isEnabled: boolean; connectionKey: string; operationsJson: string };
export type GiteaRepository = { id: number; name: string; full_name: string; html_url: string; default_branch: string; description: string };
export type GiteaCommit = { sha: string; commit: { message: string; author: { name: string; date: string } } };
export type CodeSelection = { serviceCode: string; repositoryId: number; ref: string; commitSha?: string };
export type Invocation = { id: string; instanceId: string; nodeKey: string; serviceCode: string; operation: string; status: string; attempts: number; expiresAt: string; canTriggerDeployment?: boolean };
export const getIntegrations = () => apiRequest<IntegrationService[]>('/api/integrations');
export const saveIntegration = (input: Omit<IntegrationService, 'operationsJson'> & { operations: IntegrationOperation[] }) => apiRequest<IntegrationService>(`/api/integrations/${encodeURIComponent(input.code)}`, { method: 'PUT', body: JSON.stringify(input) });
export const getInvocations = (page: number) => apiRequest<{ items: Invocation[]; total: number }>(`/api/integrations/invocations?page=${page}`);
export const retryInvocation = (id: string) => apiRequest<void>(`/api/integrations/invocations/${id}/retry`, { method: 'POST' });
export const completeDeploymentInvocation = (id: string, deploymentUrl: string) =>
  apiRequest<{ duplicate: boolean }>(`/api/integrations/invocations/${encodeURIComponent(id)}/complete-deployment`, {
    method: 'POST', body: JSON.stringify({ deploymentUrl }),
  });
export const giteaPath = (service: string) => `/api/code-sources/gitea/${encodeURIComponent(service)}`;
export const getGiteaServices = () => apiRequest<{ code: string; name: string }[]>('/api/code-sources/gitea/services');
export const getRequestTypes = () => apiRequest<{ code: string; name: string; version: number }[]>('/api/publication-requests/types');
