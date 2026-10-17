import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SensitiveWordManagementPage from './page';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../../lib/api-client', () => ({
  hasBackend: true,
  getSensitiveWords: mocks.list,
  saveSensitiveWord: mocks.save,
  deleteSensitiveWord: mocks.remove,
}));

describe('sensitive word management', () => {
  beforeEach(() => {
    mocks.list.mockReset().mockResolvedValue([{ id: 'word-1', term: '机密项目', isEnabled: true, createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' }]);
    mocks.save.mockReset().mockResolvedValue({});
    mocks.remove.mockReset().mockResolvedValue(undefined);
  });

  it('lists rules and creates a new enabled rule', async () => {
    const user = userEvent.setup();
    render(<SensitiveWordManagementPage />);
    expect(await screen.findByText('机密项目')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: '敏感词数据表格' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '新增敏感词' }));
    await user.type(screen.getByRole('textbox', { name: /敏感词/ }), '内部代号');
    await user.click(screen.getByRole('button', { name: '保存规则' }));

    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(null, { term: '内部代号', isEnabled: true }));
  });

  it('changes rule status from the table', async () => {
    const user = userEvent.setup();
    render(<SensitiveWordManagementPage />);
    await user.click(await screen.findByRole('switch', { name: '停用机密项目' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith('word-1', { term: '机密项目', isEnabled: false }));
  });
});
