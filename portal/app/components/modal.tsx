'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';

export function Modal({ title, children, onClose, className = '' }: { title: string; children: React.ReactNode; onClose: () => void; className?: string }) {
  useEffect(() => { const close = (event: KeyboardEvent) => event.key === 'Escape' && onClose(); window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [onClose]);
  return <div className="modal-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className={`modal ${className}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><header><h2 id="modal-title">{title}</h2><button className="modal-close-button" type="button" aria-label="关闭弹窗" onClick={onClose}><X size={20} strokeWidth={1.8} /></button></header>{children}</section></div>;
}
