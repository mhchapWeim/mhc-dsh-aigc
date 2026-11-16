'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';

/**
 * Dialogs scroll in the middle, never as a whole block: a footer that scrolls with the
 * content leaves actions like “通过/退回” below the viewport exactly when the reviewer
 * has just finished reading it.
 *
 * Passing `footer` moves the actions out of the scroll area. Without it the children
 * keep owning the footer, which the older forms rely on.
 */
export function Modal({ title, children, onClose, className = '', footer }: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  className?: string;
  footer?: React.ReactNode;
}) {
  useEffect(() => { const close = (event: KeyboardEvent) => event.key === 'Escape' && onClose(); window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [onClose]);
  return <div className="modal-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className={`modal${footer ? ' modal--framed' : ''} ${className}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header><h2 id="modal-title">{title}</h2><button className="modal-close-button" type="button" aria-label="关闭弹窗" onClick={onClose}><X size={20} strokeWidth={1.8} /></button></header>
      {footer ? <div className="modal-body">{children}</div> : children}
      {footer && <footer className="modal-footer">{footer}</footer>}
    </section>
  </div>;
}
