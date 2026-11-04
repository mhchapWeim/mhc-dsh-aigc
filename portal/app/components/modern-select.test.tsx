import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { ModernSelect, SearchableSelect } from './modern-select';

it('searches labels and descriptions by default and resets the search on reopening', () => {
  const changed = vi.fn();
  render(<ModernSelect ariaLabel="用户" value="" onChange={changed} options={[
    { value: 'wei', label: '魏明（WA00038）' }, { value: 'admin', label: 'Admin', description: 'wh00028' },
  ]} />);
  fireEvent.click(screen.getByRole('combobox'));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'WH00028' } });
  expect(screen.queryByRole('option', { name: '魏明（WA00038）' })).toBeNull();
  fireEvent.click(screen.getByRole('option', { name: 'Admin' }));
  expect(changed).toHaveBeenCalledWith('admin');
  fireEvent.click(screen.getByRole('combobox'));
  expect(screen.getAllByRole('option')).toHaveLength(2);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '不存在' } });
  expect(screen.getByText('没有匹配选项')).toBeTruthy();
});

it('preserves controlled callbacks, required validation and native form data', () => {
  const changed = vi.fn();
  function Form() {
    const [value, setValue] = useState('');
    return <form aria-label="增量包"><SearchableSelect aria-label="用户" name="userId" required value={value}
      onChange={event => { changed(event.target.value); setValue(event.target.value); }}>
      <option value="">请选择用户</option><option value="wei">魏明（WA00038）</option>
    </SearchableSelect></form>;
  }
  render(<Form />);
  const form = screen.getByRole('form') as HTMLFormElement;
  expect(form.checkValidity()).toBe(false);
  fireEvent.click(screen.getByRole('combobox'));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'WA00038' } });
  fireEvent.click(screen.getByRole('option', { name: '魏明（WA00038）' }));
  expect(changed).toHaveBeenCalledWith('wei');
  expect(form.checkValidity()).toBe(true);
  expect(new FormData(form).get('userId')).toBe('wei');
  expect(screen.getByRole('combobox').textContent).toContain('魏明');
});

it('keeps disabled controls closed and prevents Escape from closing the surrounding modal', () => {
  const escape = vi.fn();
  const view = render(<div onKeyDown={escape}><SearchableSelect aria-label="状态" disabled defaultValue="on"><option value="on">启用</option></SearchableSelect></div>);
  expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('combobox'));
  expect(screen.queryByRole('searchbox')).toBeNull();
  view.rerender(<div onKeyDown={escape}><SearchableSelect aria-label="状态" defaultValue="on"><option value="on">启用</option></SearchableSelect></div>);
  fireEvent.click(screen.getByRole('combobox'));
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
  expect(screen.queryByRole('searchbox')).toBeNull();
  expect(escape).not.toHaveBeenCalled();
});
