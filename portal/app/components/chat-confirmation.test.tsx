import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmationCard } from './chat-shell';

describe('待确认工具操作', () => {
  const execution = {
    id: 'execution-1', toolName: 'create_department', displayName: '新建部门',
    arguments: { name: '研发部', code: '', description: '测试部门', managerId: 'user-1', isEnabled: true },
    status: 'AwaitingConfirmation' as const, requiresConfirmation: true, createdAt: '2026-09-15T00:00:00Z',
  };
  const options = {
    categories: [], departments: [], roles: [],
    users: [{ id: 'user-1', name: '张三', employeeNo: 'wh00001', department: '数字化办公室' }],
  };

  it('显示实际参数并提供确认和取消两个交互动作', () => {
    const decide = vi.fn();
    render(<ConfirmationCard execution={execution} options={options} loading={false} onDecision={decide} />);
    expect(screen.getByRole('group', { name: '新建部门待确认操作' })).toBeInTheDocument();
    expect(screen.getByText('研发部')).toBeInTheDocument();
    expect(screen.getByText('张三 · wh00001')).toBeInTheDocument();
    expect(screen.getByText('启用')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));
    expect(decide).toHaveBeenCalledWith(execution, true);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(decide).toHaveBeenCalledWith(execution, false);
  });
});
