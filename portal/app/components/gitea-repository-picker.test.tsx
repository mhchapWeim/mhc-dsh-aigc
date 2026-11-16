import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GiteaRepositoryPicker } from './gitea-repository-picker';

const api = vi.hoisted(() => ({ request: vi.fn(), services: vi.fn() }));
vi.mock('../lib/api-client', () => ({ apiRequest: api.request }));
vi.mock('../lib/integrations', async importOriginal => ({ ...await importOriginal<typeof import('../lib/integrations')>(), getGiteaServices: api.services }));
vi.mock('./modern-select', () => ({ ModernSelect: ({ ariaLabel, value, options, onChange }: { ariaLabel: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) => <select aria-label={ariaLabel} value={value} onChange={e => onChange(e.target.value)}><option value="">请选择</option>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select> }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, 'open').mockReturnValue({ focus: vi.fn(), close: vi.fn(), closed: false } as unknown as Window);
  api.services.mockResolvedValue([{ code: 'gitea', name: '内网代码平台' }]);
  api.request.mockImplementation(async (path: string) => {
    if (path.endsWith('/connection')) return { login: 'bosch-user' };
    if (path.includes('/repositories?page=')) return [{ id: 5, name: 'app', full_name: 'org/app', html_url: 'https://git.example.com/org/app', default_branch: 'main', description: '说明' }];
    if (path.includes('/branches')) return [{ name: 'main' }];
    if (path.includes('/tags')) return [{ name: 'v1' }];
    if (path.includes('/commits')) return [{ sha: 'a'.repeat(40), commit: { message: 'Release', author: { name: '作者', date: '2026-11-12' } } }];
    throw new Error('Unexpected route');
  });
});

it('loads current-user repositories and returns a fixed commit with the selected branch', async () => {
  const changed = vi.fn(); render(<GiteaRepositoryPicker onChange={changed} />);
  await screen.findByText('org/app');
  fireEvent.change(screen.getByLabelText('选择仓库'), { target: { value: '5' } });
  await waitFor(() => expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ source: { serviceCode: 'gitea', repositoryId: 5, ref: 'main', commitSha: 'a'.repeat(40) }, branch: 'main' })));
  expect(api.request).toHaveBeenCalledWith('/api/code-sources/gitea/gitea/repositories?page=1');
  fireEvent.change(screen.getByLabelText('分支或标签'), { target: { value: 'v1' } });
  await waitFor(() => expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ branch: 'v1' })));
});

it('shows connection errors without inventing a repository selection', async () => {
  api.request.mockRejectedValue(new Error('授权失效'));
  const changed = vi.fn(); render(<GiteaRepositoryPicker onChange={changed} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('授权失效');
  expect(changed).toHaveBeenLastCalledWith(null);
});

it('survives an empty repository, where Gitea answers null for branches', async () => {
  api.request.mockImplementation(async (path: string) => {
    if (path.endsWith('/connection')) return { login: 'bosch-user' };
    if (path.includes('/repositories?page=')) return [{ id: 5, name: 'empty', full_name: 'org/empty', html_url: 'https://git.example.com/org/empty', default_branch: 'main', description: '' }];
    if (path.includes('/branches')) return null;
    if (path.includes('/tags')) return [];
    if (path.includes('/commits')) return [];
    throw new Error('Unexpected route');
  });
  const changed = vi.fn(); render(<GiteaRepositoryPicker onChange={changed} />);
  await screen.findByText('org/empty');
  fireEvent.change(screen.getByLabelText('选择仓库'), { target: { value: '5' } });
  // Empty repository is guidance, so it must not raise an alert.
  expect(await screen.findByText(/还没有提交/)).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(changed).toHaveBeenLastCalledWith(null);
});

it('opens authorization in a popup and refreshes the connection when it reports back', async () => {
  api.request.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { url: 'http://gitea.test/login/oauth/authorize' };
    if (path.endsWith('/connection')) return null;
    if (path.includes('/repositories')) return [];
    throw new Error('Unexpected route');
  });
  const changed = vi.fn(); render(<GiteaRepositoryPicker onChange={changed} />);
  const connectButton = await screen.findByRole('button', { name: '连接 Gitea' });
  await waitFor(() => expect(connectButton).toBeEnabled());
  fireEvent.click(connectButton);

  // The opener must stay mounted: authorization is requested in a popup instead.
  await waitFor(() => expect(window.open).toHaveBeenCalledWith('http://gitea.test/login/oauth/authorize', 'aigc-gitea-auth', expect.stringContaining('width=')));

  // Simulate the landing page reporting success; the picker re-reads the connection.
  api.request.mockImplementation(async (path: string) => {
    if (path.endsWith('/connection')) return { login: 'bosch-user' };
    if (path.includes('/repositories')) return [];
    throw new Error('Unexpected route');
  });
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'aigc-gitea-auth', ok: true }, origin: window.location.origin, source: vi.mocked(window.open).mock.results.at(-1)!.value }));
  });
  await screen.findByText('已连接：bosch-user');
});
