'use client';

import type { GrantOptions, GrantSelection } from '../../lib/api-client';
import { RecipientPicker } from '../components/recipient-picker';

export function GrantSelector({ options, value, onChange }: {
  options: GrantOptions; value: GrantSelection; onChange: (value: GrantSelection) => void;
}) {
  return <RecipientPicker options={options} value={value} onChange={onChange} mode="authorization" />;
}
