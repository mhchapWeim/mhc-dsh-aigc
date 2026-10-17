import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatPage from './chat/page';
import Home from './page';
import { PlatformProvider } from './components/platform-provider';

const renderChat = () => render(<PlatformProvider><ChatPage /></PlatformProvider>);

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.lang = 'zh-CN';
});

describe('AIGC Agent Hub landing page', () => {
  it('renders the new primary message and supplied corporate logo', () => {
    render(<Home />);

    expect(screen.getByRole('heading', { name: '让智能成为工作的起点' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '博世华域转向系统有限公司' })).toHaveAttribute('src', '/bhss-logo.png');
    expect(screen.getByRole('img', { name: /蓝色抽象曲面/ })).toHaveAttribute('src', '/hub-hero-blue.webp');
  });

  it('routes the two entry cards to chat and the real application catalog', () => {
    render(<Home />);

    expect(screen.getByRole('link', { name: /开始对话/ })).toHaveAttribute('href', '/chat');
    expect(screen.getByRole('link', { name: /应用集合/ })).toHaveAttribute('href', '/apps');
  });

  it('switches language and theme and persists both preferences', async () => {
    const user = userEvent.setup();
    render(<Home />);

    await user.click(screen.getByRole('button', { name: '切换主题' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem('aigc-theme')).toBe('dark');

    await user.click(screen.getByRole('button', { name: 'EN' }));
    expect(screen.getByRole('heading', { name: 'Make intelligence the start of work' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
  });
});

describe('AIGC chat workspace', () => {
  it('provides an empty chat workspace without fabricated messages', () => {
    renderChat();

    expect(screen.getByRole('heading', { name: '今天想从哪里开始？' })).toBeInTheDocument();
    expect(screen.getByText('暂无历史对话')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '应用集合' })).toHaveAttribute('href', '/apps');
  });

  it('fills a suggestion and reports the unconfigured model honestly', async () => {
    const user = userEvent.setup();
    renderChat();

    await user.click(screen.getByRole('button', { name: '查询内部质量规范' }));
    expect(screen.getByRole('textbox', { name: '输入消息' })).toHaveValue('查询内部质量规范');
    await user.click(screen.getByRole('button', { name: '发送消息' }));
    expect(screen.getByRole('status')).toHaveTextContent('模型服务尚未配置');
  });

  it('removes hidden sidebar controls from keyboard navigation when collapsed', async () => {
    const user = userEvent.setup();
    renderChat();

    await user.click(screen.getByRole('button', { name: '收起侧边栏' }));
    expect(screen.getByRole('complementary', { hidden: true })).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('link', { name: '应用集合', hidden: true })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('button', { name: '展开侧边栏' })).toBeInTheDocument();
  });
});
