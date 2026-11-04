'use client';

import { Tooltip } from 'antd';
import { useId, type ButtonHTMLAttributes } from 'react';
import './delete-button.css';

type DeleteButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { blockedReason?: string };

/** Disabled native buttons do not reliably receive hover/focus: put the explanation on a focusable wrapper. */
export function DeleteButton({ blockedReason, disabled, className = '', children, ...props }: DeleteButtonProps) {
  const reasonId = useId();
  return <Tooltip title={blockedReason} trigger={['hover', 'focus']}>
    <span className="delete-action-wrapper" tabIndex={blockedReason ? 0 : undefined} title={blockedReason}
      aria-label={blockedReason ? `无法删除：${blockedReason}` : undefined}>
      <button {...props} type="button" className={`delete-action-button ${className}`} disabled={disabled || Boolean(blockedReason)}
        aria-describedby={blockedReason ? reasonId : undefined}>{children}</button>
      {blockedReason && <span id={reasonId} className="sr-only">{blockedReason}</span>}
    </span>
  </Tooltip>;
}
