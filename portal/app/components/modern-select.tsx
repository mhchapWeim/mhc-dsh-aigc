'use client';

import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type SelectHTMLAttributes } from 'react';

export type SelectOption = { value: string; label: string; description?: string; disabled?: boolean };

type ModernSelectProps = {
  ariaLabel: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchable?: boolean;
  compact?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
};

export function ModernSelect({ ariaLabel, value, options, onChange, placeholder = '请选择', searchable = true, compact = false, disabled = false, invalid = false, required = false }: ModernSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<React.CSSProperties>();
  useLayoutEffect(() => {
    if (!open || disabled) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(rect.width, 180), window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width,
        maxHeight: Math.min(320, Math.max(below, above)),
        ...(below >= Math.min(320, above) ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4 }) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, disabled]);
  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(() => options.filter((option) => `${option.label}${option.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())), [options, query]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !popupRef.current?.contains(event.target as Node)) { setOpen(false); setQuery(''); }
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, []);

  const choose = (nextValue: string) => {
    onChange(nextValue);
    setOpen(false);
    setQuery('');
    triggerRef.current?.focus();
  };
  const escape = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); setQuery(''); triggerRef.current?.focus(); }
  };

  return (
    <div className={`modern-select${open ? ' is-open' : ''}${compact ? ' is-compact' : ''}`} ref={rootRef} onKeyDown={escape}>
      <button ref={triggerRef} disabled={disabled} className="modern-select__trigger" type="button" role="combobox" aria-invalid={invalid || undefined} aria-required={required || undefined} aria-label={ariaLabel} aria-expanded={open && !disabled} aria-controls={listboxId} aria-haspopup="listbox" onClick={() => { setQuery(''); setOpen((current) => !current); }}>
        <span className={selected ? '' : 'is-placeholder'}>{selected?.label ?? placeholder}</span><ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && !disabled && position && createPortal(<div ref={popupRef} className="modern-multi-popup modern-single-popup" style={position} onKeyDown={escape}>{searchable && <label className="modern-select__search"><Search size={14} aria-hidden="true" /><input autoFocus type="search" aria-label={`搜索${ariaLabel}`} placeholder="输入关键词搜索" value={query} onChange={(event) => setQuery(event.target.value)} /></label>}<div className="modern-select__options" id={listboxId} role="listbox" aria-label={`${ariaLabel}选项`}>{filtered.map((option) => <button type="button" role="option" disabled={option.disabled} aria-label={option.label} aria-selected={option.value === value} className={option.value === value ? 'is-selected' : ''} key={option.value} onClick={() => choose(option.value)}><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{option.value === value && <Check size={15} aria-hidden="true" />}</button>)}{!filtered.length && <span className="modern-select__empty">没有匹配选项</span>}</div></div>, rootRef.current?.closest('.admin-app') ?? document.body)}
    </div>
  );
}


/** Retains native form validation and change events while rendering a searchable picker. */
export function SearchableSelect({ children, className, style, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const native = useRef<HTMLSelectElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [options, setOptions] = useState<SelectOption[]>([]);
  const [label, setLabel] = useState(props['aria-label'] ?? '选择选项');
  const [value, setValue] = useState(String(props.value ?? props.defaultValue ?? ''));
  const [invalid, setInvalid] = useState(false);
  useLayoutEffect(() => {
    const element = native.current;
    if (!element) return;
    const next = Array.from(element.options, option => ({ value: option.value, label: option.label, disabled: option.disabled }));
    setOptions(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    setValue(element.value);
    if (!props['aria-label']) {
      const owner = element.labels?.[0];
      const text = owner && Array.from(owner.childNodes).filter(node => node.nodeType === Node.TEXT_NODE || (node instanceof HTMLElement && node.tagName === 'SPAN')).map(node => node.textContent).join('').trim();
      if (text) setLabel(text);
    }
  });
  return <div ref={root} className={`searchable-select ${className ?? ''}`} style={style}>
    <select {...props} ref={native} className="searchable-select__native" aria-label={undefined} aria-hidden="true" tabIndex={-1}
      onFocus={() => root.current?.querySelector('button')?.focus()}
      onInvalid={event => { event.preventDefault(); setInvalid(true); root.current?.querySelector('button')?.focus(); props.onInvalid?.(event); }}>
      {children}
    </select>
    <ModernSelect ariaLabel={label} value={value} options={options} disabled={props.disabled} required={props.required} invalid={invalid} onChange={next => {
      const element = native.current;
      if (!element) return;
      element.value = next;
      setValue(next);
      setInvalid(false);
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }} />
    {invalid && <span className="searchable-select__error" role="alert">请选择{label}</span>}
  </div>;
}
