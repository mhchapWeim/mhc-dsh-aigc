import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AnnouncementPage from './announcements/page';
import ClientReleasesPage from './client-releases/page';
import * as api from '../lib/api-client';

vi.mock('../lib/api-client', () => ({
  getDesktopAnnouncements: vi.fn(async () => []),
  getDesktopAudienceOptions: vi.fn(async () => ({ users: [{ id: 'person-1', name: '测试员工', employeeNo: 'wh00028', departmentId: 'dept-1', roleIds: ['role-1'] }],
    roles: [{ id: 'role-1', name: '研发角色', code: 'rd' }], departments: [{ id: 'dept-1', name: '研发部', code: 'rd' }] })),
  saveDesktopAnnouncement: vi.fn(async () => ({ id: 'announcement-1' })),
  setDesktopAnnouncementStatus: vi.fn(async () => {}),
  getDesktopReleases: vi.fn(async () => []),
  getDesktopClients: vi.fn(async () => []),
  createDesktopRelease: vi.fn(async () => ({ id: 'release-1' })),
  setDesktopReleaseRecipients: vi.fn(async () => {}),
  setDesktopReleaseStatus: vi.fn(async () => {}),
  uploadDesktopRelease: vi.fn(async () => {}),
}));

describe('desktop distribution administration', () => {
  it('paginates releases and client reports independently', async () => {
    vi.mocked(api.getDesktopReleases).mockResolvedValueOnce(Array.from({ length: 11 }, (_, index) => ({
      id: `release-${index}`, version: `1.0.${index}`, notes: '', platform: 'win32', arch: 'x64', status: 'Draft', fileName: '', bytes: 0, hasBlockmap: false,
      createdAt: '2026-10-08T00:00:00Z', audience: { userIds: [], roleIds: [], departmentIds: [] }, recipients: [],
    })));
    vi.mocked(api.getDesktopClients).mockResolvedValueOnce(Array.from({ length: 11 }, (_, index) => ({
      userId: `user-${index}`, name: `员工${index}`, employeeNo: `w${index}`, deviceId: `device-${index}`, computerName: `pc-${index}`,
      version: '1.0.0', platform: 'win32', arch: 'x64', updateStatus: 'Current', targetVersion: '', error: '', lastSeenAt: '2026-10-08T00:00:00Z',
    })));
    const user = userEvent.setup(); render(<ClientReleasesPage />);
    await screen.findByText('1.0.9');
    const releases = screen.getByRole('table', { name: '客户端版本列表' });
    const reports = screen.getByRole('table', { name: '客户端上报' });
    expect(within(releases).getAllByRole('row')).toHaveLength(11);
    await user.click(within(screen.getByRole('navigation', { name: '客户端版本列表分页' })).getByRole('button', { name: '下一页' }));
    expect(within(releases).getAllByRole('row')).toHaveLength(2);
    expect(within(reports).getAllByRole('row')).toHaveLength(11);
    await user.click(within(screen.getByRole('navigation', { name: '客户端上报分页' })).getByRole('button', { name: '下一页' }));
    expect(within(reports).getAllByRole('row')).toHaveLength(2);
    expect(within(releases).getAllByRole('row')).toHaveLength(2);
  });

  it('saves an announcement draft with selected recipients and a UTC publication date', async () => {
    const user = userEvent.setup(); render(<AnnouncementPage />);
    await user.click(screen.getByRole('button', { name: /新增公告/ }));
    await user.type(screen.getByRole('textbox', { name: '标题' }), '员工公告');
    await user.type(screen.getByRole('textbox', { name: '正文' }), '通知指定人员');
    await user.click(await screen.findByRole('checkbox', { name: /测试员工/ }));
    await user.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(api.saveDesktopAnnouncement).toHaveBeenCalledWith(null, expect.objectContaining({ title: '员工公告', body: '通知指定人员', userIds: ['person-1'], endsAt: null })));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('creates a targeted Windows version without publishing or installing it automatically', async () => {
    const user = userEvent.setup(); render(<ClientReleasesPage />);
    await user.click(screen.getByRole('button', { name: /新增版本/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '版本号' }), { target: { value: '0.1.7-alpha.3' } });
    await user.click(await screen.findByRole('checkbox', { name: /测试员工/ }));
    await user.click(screen.getByRole('button', { name: '创建草稿' }));
    await waitFor(() => expect(api.createDesktopRelease).toHaveBeenCalledWith({ version: '0.1.7-alpha.3', notes: '', arch: 'x64', userIds: ['person-1'], roleIds: [], departmentIds: [] }));
    expect(api.setDesktopReleaseStatus).not.toHaveBeenCalled();
  });

  it('combines roles and departments, previews unique people and saves the selected groups', async () => {
    const user = userEvent.setup(); render(<AnnouncementPage />);
    await user.click(screen.getByRole('button', { name: /新增公告/ }));
    await user.type(screen.getByRole('textbox', { name: '标题' }), '部门公告');
    await user.type(screen.getByRole('textbox', { name: '正文' }), '部门和角色');
    await user.click(screen.getByRole('tab', { name: /角色/ }));
    await user.click(await screen.findByRole('checkbox', { name: /研发角色/ }));
    await user.click(screen.getByRole('tab', { name: /部门/ }));
    await user.click(screen.getByRole('checkbox', { name: /研发部/ }));
    expect(screen.getByText('1 人')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(api.saveDesktopAnnouncement).toHaveBeenLastCalledWith(null, expect.objectContaining({ userIds: [], roleIds: ['role-1'], departmentIds: ['dept-1'] })));
  });
});
