import { apiRequest, type BackendPage } from './api-client';

export type ConfigSyncDevice = {
  userId: string; employeeNo: string; userName: string; deviceId: string | null; deviceName: string;
  clientVersion: string; targetRevision: number; appliedRevision: number; attemptedRevision: number;
  status: 'Applied' | 'Pending' | 'Failed' | 'Offline' | 'Unreported'; errorCode: string;
  lastSeenAt: string | null; appliedAt: string | null;
};
export type ConfigSyncPage = BackendPage<ConfigSyncDevice> & {
  revision: number; mqEnabled: boolean; mqConnected: boolean; mqErrorCode: string; pendingEvents: number;
  summary: {applied: number; pending: number; failed: number; offline: number; unreported: number};
};
export const getConfigSyncDevices = (page: number, pageSize: number, search: string, status: string) =>
  apiRequest<ConfigSyncPage>(`/api/config-sync/devices?${new URLSearchParams({page: String(page), pageSize: String(pageSize), search, status})}`);
