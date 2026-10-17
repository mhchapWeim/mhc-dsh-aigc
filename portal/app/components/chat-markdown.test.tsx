import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChatMarkdown } from './chat-markdown';

describe('聊天 Markdown 展示', () => {
  it('忽略回复中的装饰性分隔线，但保留正文和 GFM 表格', () => {
    const { container } = render(<ChatMarkdown content={'如果需要，请继续提问。\n\n---\n\n---\n\n| 参数 | 值 |\n| --- | --- |\n| 名称 | Demo |'} />);

    expect(container.querySelector('hr')).not.toBeInTheDocument();
    expect(screen.getByText('如果需要，请继续提问。')).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Demo')).toBeInTheDocument();
  });
});
