'use client';
import { useId, useRef } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import './token-amount-input.css';

type Props = { label: string; value: number; onChange: (value: number) => void; disabled?: boolean; min?: number; max?: number };
export function TokenAmountInput({ label, value, onChange, disabled = false, min = 1, max = 1000000000000 }: Props) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  function step(direction: number) {
    const field = input.current;
    if (!field) return;
    if (direction > 0) field.stepUp(); else field.stepDown();
    onChange(Number(field.value));
    field.focus();
  }
  return <div className="token-amount-field">
    <label htmlFor={id}>{label}</label>
    <div className="token-amount-control">
      <input id={id} ref={input} required type="number" min={min} max={max} step={1}
        disabled={disabled} value={value} onChange={event => onChange(Number(event.target.value))} />
      <div className="token-amount-arrows">
        <button type="button" aria-label={`增加${label}`} disabled={disabled || value >= max} onClick={() => step(1)}><ChevronUp size={12} /></button>
        <button type="button" aria-label={`减少${label}`} disabled={disabled || value <= min} onClick={() => step(-1)}><ChevronDown size={12} /></button>
      </div>
    </div>
  </div>;
}
