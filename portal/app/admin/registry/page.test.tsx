import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Page from './page';
import * as api from '../../lib/application-registry';

vi.mock('../../lib/application-registry', () => ({
  getRegistryApps: vi.fn(async () => [{id: 'app', name: '设备助手', nameEn: 'Device assistant', description: '说明', descriptionEn: 'Description', owner: '', ownerEn: '', categoryId: 'child', categoryEn: '', accessUrl: 'https://example.com', isEnabled: true, sortOrder: 0, accessMode: 'All', grants: [], clicks: {day: 10, week: 20, month: 30, year: 40}, totalClicks: 500}]),
  getRegistryOptions: vi.fn(async () => ({categories: [{id: 'root', name: '智慧服务'}, {id: 'child', name: '设备', parentId: 'root'}], users: [], departments: []})),
  saveRegistryApp: vi.fn(async () => ({id: 'app'})), translateRegistryText: vi.fn(),
}));

it('edits only changed click periods and labels second-level category choices', async () => {
  const user = userEvent.setup(); render(<Page/>);
  await user.click(await screen.findByRole('button', {name: '编辑设备助手'}));
  expect(screen.getByRole('combobox', {name: '注册应用分类'})).toHaveTextContent('智慧服务 / 设备');
  fireEvent.change(screen.getByRole('spinbutton', {name: '日点击'}), {target: {value: '15'}});
  await user.click(screen.getByRole('button', {name: '保存应用'}));
  await waitFor(() => expect(api.saveRegistryApp).toHaveBeenCalledWith(expect.objectContaining({clicks: {day: 15}}), 'app'));
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
