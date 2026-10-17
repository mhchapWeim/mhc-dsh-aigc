import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import DesktopDownloadPage from './page';

const mocks = vi.hoisted(() => ({ latest: vi.fn(), download: vi.fn() }));
vi.mock('../lib/api-client', () => ({ hasBackend: true, getDesktopDownload: mocks.latest, startDesktopDownload: mocks.download }));
const release = { id: 'release-1', version: '0.1.7-alpha.2.20261014.3', notes: '迁移与标题修复', bytes: 320631176,
  sha512: 'checksum', fileName: 'bhssAiWork-setup.exe', createdAt: '2026-10-14T06:43:00Z', platform: 'Windows x64' };
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); mocks.latest.mockResolvedValue({ release }); mocks.download.mockResolvedValue(undefined); });

it('offers a branded Windows-only login entry without requiring a desktop device', async () => {
  render(<DesktopDownloadPage />);
  expect(await screen.findAllByRole('link', { name: /登录并下载 Windows x64/ })).toHaveLength(2);
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('今天的工作，让弯崽一起办。');
  expect(screen.getByAltText('弯崽工作伙伴品牌形象')).toHaveAttribute('src', '/wanzai.svg');
  expect(mocks.latest).not.toHaveBeenCalled();
  expect(screen.queryByText('macOS')).not.toBeInTheDocument();
});
it('downloads the authorized published release and reports browser handoff', async () => {
  localStorage.setItem('aigc_hub_access_token', 'test-token');
  render(<DesktopDownloadPage />);
  fireEvent.click((await screen.findAllByRole('button', { name: '下载 Windows x64' }))[0]);
  await waitFor(() => expect(mocks.download).toHaveBeenCalledWith('release-1'));
  expect(await screen.findByText('下载已交给浏览器，请在浏览器下载列表中查看进度。')).toBeInTheDocument();
  expect(screen.getByText('迁移与标题修复')).toBeInTheDocument();
});
it('keeps unavailable releases disabled and supports retry', async () => {
  localStorage.setItem('aigc_hub_access_token', 'test-token'); mocks.latest.mockResolvedValueOnce({ release: null });
  render(<DesktopDownloadPage />);
  expect((await screen.findAllByRole('button', { name: '暂无可下载版本' }))[0]).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '重新检查' }));
  await screen.findAllByRole('button', { name: '下载 Windows x64' });
});
it('surfaces failed download requests', async () => {
  localStorage.setItem('aigc_hub_access_token', 'test-token'); mocks.download.mockRejectedValueOnce(new Error('安装包已停止发布'));
  render(<DesktopDownloadPage />);
  fireEvent.click((await screen.findAllByRole('button', { name: '下载 Windows x64' }))[0]);
  expect(await screen.findByText('安装包已停止发布')).toBeInTheDocument();
});
