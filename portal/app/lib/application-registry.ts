import { apiRequest } from './api-client';
export type ClickCounts = {day: number; week: number; month: number; year: number};
/** The wire shape of one click adjustment: the four windows plus the lifetime total. */
export type ClickUpdate = Partial<ClickCounts> & {total?: number};
export type RegistryGrant = { subjectType: 'User' | 'Department'; subjectId: string };
export type RegistryInput = {
  name: string; nameEn: string; description: string; descriptionEn: string; owner: string; ownerEn: string;
  categoryId: string; categoryEn: string; accessUrl: string; isEnabled: boolean; sortOrder: number;
  clicks?: ClickCounts;
  totalClicks?: number;
  accessMode: 'All' | 'Subjects'; grants: RegistryGrant[];
};
export type RegistryApp = RegistryInput & { id: string; category: string; updatedAt: string; totalClicks?: number };
export type RegistryOptions = { categories: {id: string; name: string; parentId?: string | null}[]; departments: {id: string; name: string}[]; users: {id: string; name: string; employeeNo: string}[] };
export const getRegistryApps = () => apiRequest<RegistryApp[]>('/api/application-registry');
export const getRegistryOptions = () => apiRequest<RegistryOptions>('/api/application-registry/options');
export const saveRegistryApp = (input: Omit<RegistryInput, 'clicks' | 'totalClicks'> & {clicks?: ClickUpdate; totalClicks?: number}, id?: string) => apiRequest<{id: string}>(`/api/application-registry${id ? `/${encodeURIComponent(id)}` : ''}`, {method: id ? 'PUT' : 'POST', body: JSON.stringify(input)});
export const translateRegistryText = (text: string) => apiRequest<{text: string}>('/api/application-registry/translate', {method: 'POST', body: JSON.stringify({text})});

export type ClickReport = {generatedAt: string; periods: Record<string, string>; from: string; to: string; trend: {date: string; clicks: number}[]; applications: {id: string; name: string}[]; items: {id: string; name: string; category: string; isEnabled: boolean; clicks: ClickCounts; rangeClicks: number}[]};
export const getClickReport = (filters: {from?: string; to?: string; applicationId?: string} = {}) => {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => Boolean(value)));
  return apiRequest<ClickReport>(`/api/application-registry/click-report${query.size ? `?${query}` : ''}`);
};
