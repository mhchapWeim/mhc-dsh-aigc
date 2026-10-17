'use client';

import { Check, ChevronDown, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

export type SelectOption = { value: string; label: string; description?: string };

type ModernSelectProps = {
  ariaLabel: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchable?: boolean;
  compact?: boolean;
};

export function ModernSelect({ ariaLabel, value, options, onChange, placeholder = '请选择', searchable = false, compact = false }: ModernSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(() => options.filter((option) => `${option.label}${option.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())), [options, query]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, []);

  const choose = (nextValue: string) => {
    onChange(nextValue);
    setOpen(false);
    setQuery('');
  };

  return (
    <div className={`modern-select${open ? ' is-open' : ''}${compact ? ' is-compact' : ''}`} ref={rootRef} onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}>
      <button className="modern-select__trigger" type="button" role="combobox" aria-label={ariaLabel} aria-expanded={open} aria-controls={listboxId} aria-haspopup="listbox" onClick={() => setOpen((current) => !current)}>
        <span className={selected ? '' : 'is-placeholder'}>{selected?.label ?? placeholder}</span><ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && <div className="modern-select__popup"><div className="modern-select__arrow" />{searchable && <label className="modern-select__search"><Search size={14} aria-hidden="true" /><input autoFocus type="search" aria-label={`搜索${ariaLabel}`} placeholder="输入关键词搜索" value={query} onChange={(event) => setQuery(event.target.value)} /></label>}<div className="modern-select__options" id={listboxId} role="listbox" aria-label={`${ariaLabel}选项`}>{filtered.map((option) => <button type="button" role="option" aria-label={option.label} aria-selected={option.value === value} className={option.value === value ? 'is-selected' : ''} key={option.value} onClick={() => choose(option.value)}><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{option.value === value && <Check size={15} aria-hidden="true" />}</button>)}{!filtered.length && <span className="modern-select__empty">没有匹配选项</span>}</div></div>}
    </div>
  );
}
