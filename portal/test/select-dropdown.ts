import { fireEvent, screen } from '@testing-library/react';

/** Select through the visible picker while keeping value-based test fixtures. */
export function selectDropdown(trigger: HTMLElement, value: string) {
  const native = trigger.closest('.searchable-select')?.querySelector('select');
  const option = native && Array.from(native.options).find(option => option.value === value);
  if (!option) throw new Error(`Dropdown option ${value} does not exist`);
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('option', { name: option.label }));
}
