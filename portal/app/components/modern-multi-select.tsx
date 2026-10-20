'use client';

import { Check, ChevronDown, Search } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type Option = { value: string; label: string; description?: string; disabled?: boolean };

export function ModernMultiSelect({ ariaLabel, values, options, disabled = false, onChange }: {
  ariaLabel: string; values: string[]; options: Option[]; disabled?: boolean; onChange: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = options.filter(option => values.includes(option.value));
  const filtered = options.filter(option => `${option.label} ${option.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
      const below = window.innerHeight - rect.bottom - 12;
      const height = Math.min(300, Math.max(below, rect.top - 12));
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)), width: Math.min(rect.width, window.innerWidth - 16),
        ...(below >= Math.min(300, rect.top - 12) ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4 }), maxHeight: height });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  const escape = (event: React.KeyboardEvent) => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
  return <div className="modern-select" onKeyDown={escape}>
    <button ref={trigger} type="button" role="combobox" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={id}
      className="modern-select__trigger" disabled={disabled} onClick={() => { setOpen(!open); setQuery(''); }}>
      <span>{selected.length ? selected.length <= 2 ? selected.map(option => option.label).join('、') : `已选择 ${selected.length} 个模型` : '请选择模型（可多选）'}</span><ChevronDown size={15} />
    </button>
    {open && position && createPortal(<div ref={popup} className="modern-multi-popup" style={position} onKeyDown={escape}>
      <label className="modern-select__search"><Search size={14} /><input autoFocus type="search" aria-label={`搜索${ariaLabel}`} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索模型" /></label>
      <div className="modern-select__options" role="listbox" aria-label={`${ariaLabel}选项`} aria-multiselectable="true" id={id}>
        {filtered.map(option => <button key={option.value} type="button" role="option" aria-selected={values.includes(option.value)} disabled={option.disabled}
          className={values.includes(option.value) ? 'is-selected' : ''} onClick={() => onChange(values.includes(option.value) ? values.filter(value => value !== option.value) : [...values, option.value])}>
          <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{values.includes(option.value) && <Check size={15} />}
        </button>)}
        {!filtered.length && <span className="modern-select__empty">没有匹配模型</span>}
      </div><small className="modern-multi-popup__hint">已选择 {selected.length} 个模型</small>
    </div>, document.body)}
  </div>;
}
