import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Page from './page';
import * as api from '../../lib/application-registry';

vi.mock('../../lib/application-registry', () => ({
  getRegistryApps: vi.fn(async () => [{id: 'app', name: '设备助手', nameEn: 'Device assistant', description: '说明', descriptionEn: 'Description', owner: '', ownerEn: '', categoryId: 'child', categoryEn: '', accessUrl: 'https://example.com', isEnabled: true, sortOrder: 0, accessMode: 'All', grants: [], clicks: {day: 10, week: 20, month: 30, year: 40}, totalClicks: 500}]),
  getRegistryOptions: vi.fn(async () => ({categories: [{id: 'root', name: '智慧服务'}, {id: 'child', name: '设备', parentId: 'root'}], users: [{id: 'owner', name: '李俊', employeeNo: 'wh00412'}], departments: []})),
  saveRegistryApp: vi.fn(async () => ({id: 'app'})), translateRegistryText: vi.fn(),
  getPublishedApps: vi.fn(async () => [{id: 'pub', name: '发布设备', version: '1.2.0', applicantId: 'owner', applicantName: '李俊', applicantEmployeeNo: 'wh00412', routeStatus: 'Ready', operationalEnabled: true, publicationStatus: 'Approved'}]),
  setPublishedOperational: vi.fn(async () => ({id: 'pub', operationalEnabled: false, changed: true})),
  setPublishedAccessReviewer: vi.fn(async () => ({id: 'pub'})),
}));

it('edits only changed click periods and labels second-level category choices', async () => {
  const user = userEvent.setup(); render(<Page/>);
  await user.click(await screen.findByRole('button', {name: '编辑设备助手'}));
  expect(screen.getByRole('combobox', {name: '注册应用分类'})).toHaveTextContent('智慧服务 / 设备');
  expect(screen.getByRole('combobox', {name: '负责人 / 团队'})).toBeInTheDocument();
  await user.click(screen.getByRole('combobox', {name: '访问审核负责人'}));
  await user.click(screen.getByRole('option', {name: '李俊（wh00412）'}));
  fireEvent.change(screen.getByRole('spinbutton', {name: '日点击'}), {target: {value: '15'}});
  await user.click(screen.getByRole('button', {name: '保存应用'}));
  await waitFor(() => expect(api.saveRegistryApp).toHaveBeenCalledWith(expect.objectContaining({clicks: {day: 15}, accessReviewerId: 'owner'}), 'app'));
});

it('starts the lifetime field from the stored total and submits it on its own', async () => {
  const user = userEvent.setup(); render(<Page/>);
  await user.click(await screen.findByRole('button', {name: '编辑设备助手'}));
  const total = screen.getByRole('spinbutton', {name: '累计点击'});
  // The editor starts from what the portal card shows, not from zero.
  expect(total).toHaveValue(500);
  fireEvent.change(total, {target: {value: '2048'}});
  await user.click(screen.getByRole('button', {name: '保存应用'}));
  await waitFor(() => expect(api.saveRegistryApp).toHaveBeenCalled());
  const payload = vi.mocked(api.saveRegistryApp).mock.calls.at(-1)![0];
  // The save endpoint reads adjustments from `clicks` only, so the lifetime value must
  // travel there as `total`; a top-level field would be silently ignored.
  expect(payload.clicks).toEqual({total: 2048});
  expect(payload).not.toHaveProperty('totalClicks');
});

it('leaves the lifetime total out of the payload when it was not edited', async () => {
  const user = userEvent.setup(); render(<Page/>);
  await user.click(await screen.findByRole('button', {name: '编辑设备助手'}));
  fireEvent.change(screen.getByRole('spinbutton', {name: '日点击'}), {target: {value: '11'}});
  await user.click(screen.getByRole('button', {name: '保存应用'}));
  await waitFor(() => expect(api.saveRegistryApp).toHaveBeenCalled());
  const payload = vi.mocked(api.saveRegistryApp).mock.calls.at(-1)![0];
  expect(payload).not.toHaveProperty('totalClicks');
  // Only the edited window travels; the lifetime total stays untouched.
  expect(payload.clicks).toEqual({day: 11});
});

it('confirms disable for a published app and shows the server message when it fails', async () => {
  const user = userEvent.setup();
  render(<Page/>);
  expect(screen.getByRole('heading', {name: '应用管理'})).toBeInTheDocument();
  expect(screen.getByRole('tab', {name: '注册应用'})).toHaveAttribute('aria-selected', 'true');
  await user.click(screen.getByRole('tab', {name: '流程发布应用'}));
  const row = await screen.findByRole('row', {name: /发布设备/});
  expect(row).toHaveTextContent('1.2.0');
  expect(row).toHaveTextContent('李俊');
  expect(row).toHaveTextContent('wh00412');
  expect(row).toHaveTextContent('就绪');
  await user.type(screen.getByRole('searchbox', {name: '搜索流程发布应用'}), '没有这个应用');
  expect(screen.getByText('暂无匹配的流程发布应用')).toBeInTheDocument();
  await user.clear(screen.getByRole('searchbox', {name: '搜索流程发布应用'}));
  await user.click(screen.getByRole('button', {name: '停用发布设备'}));
  expect(screen.getByRole('dialog', {name: '停用流程发布应用'})).toBeInTheDocument();
  let rejectSubmit: (error: Error) => void = () => {};
  vi.mocked(api.setPublishedOperational).mockImplementationOnce(() => new Promise((_, reject) => { rejectSubmit = reject; }));
  const pendingClick = user.click(screen.getByRole('button', {name: '确认停用'}));
  expect(await screen.findByRole('button', {name: '提交中…'})).toBeDisabled();
  expect(screen.getByRole('button', {name: '取消'})).toBeDisabled();
  rejectSubmit(new Error('应用已不在可管理状态'));
  await pendingClick;
  expect(await screen.findByRole('alert')).toHaveTextContent('应用已不在可管理状态');
  expect(screen.getByRole('button', {name: '确认停用'})).toBeEnabled();
  vi.mocked(api.getPublishedApps).mockResolvedValueOnce([{id: 'pub', name: '发布设备', version: '1.2.0', applicantName: '李俊', applicantEmployeeNo: 'wh00412', routeStatus: 'Ready', operationalEnabled: false, publicationStatus: 'Approved'}]);
  await user.click(screen.getByRole('button', {name: '确认停用'}));
  expect(await screen.findByRole('button', {name: '恢复发布设备'})).toBeEnabled();
  expect(api.setPublishedOperational).toHaveBeenLastCalledWith('pub', false);
  await user.click(screen.getByRole('button', {name: '设置发布设备审核负责人'}));
  await user.click(screen.getByRole('combobox', {name: '流程发布应用审核负责人'}));
  await user.click(screen.getByRole('option', {name: '李俊（wh00412）'}));
  await user.click(screen.getByRole('button', {name: '保存'}));
  await waitFor(() => expect(api.setPublishedAccessReviewer).toHaveBeenCalledWith('pub', 'owner'));
});
