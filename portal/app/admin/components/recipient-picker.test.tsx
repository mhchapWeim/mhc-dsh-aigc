import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { emptyAudience, RecipientPicker } from './recipient-picker';

it.each(['users', 'roles', 'departments'] as const)('selects all %s across pages while preserving other selections', async group => {
  const options = {
    users: Array.from({ length: 25 }, (_, index) => ({ id: `user-${index}`, name: `员工${index}`, employeeNo: `w${index}` })),
    roles: Array.from({ length: 25 }, (_, index) => ({ id: `role-${index}`, name: `角色${index}`, code: `r${index}` })),
    departments: Array.from({ length: 25 }, (_, index) => ({ id: `department-${index}`, name: `部门${index}`, code: `d${index}` })),
  };
  function Form() {
    const [value, setValue] = useState({ userIds: ['user-0'], roleIds: ['role-0'], departmentIds: ['department-0'] });
    return <><RecipientPicker options={options} value={value} onChange={setValue} mode="authorization" /><output data-testid="selection">{JSON.stringify(value)}</output></>;
  }
  const user = userEvent.setup(); render(<Form />);
  const label = { users: '用户', roles: '角色', departments: '部门' }[group];
  const key = { users: 'userIds', roles: 'roleIds', departments: 'departmentIds' }[group];
  await user.click(screen.getByRole('tab', { name: new RegExp(label) }));
  await user.click(screen.getByRole('button', { name: '选择本页' }));
  expect(JSON.parse(screen.getByTestId('selection').textContent!)[key]).toHaveLength(5);
  await user.click(screen.getByRole('button', { name: '全选' }));
  const selection = JSON.parse(screen.getByTestId('selection').textContent!);
  expect(selection[key]).toHaveLength(25);
  expect(new Set(selection[key]).size).toBe(25);
  for (const other of ['userIds', 'roleIds', 'departmentIds']) if (other !== key) expect(selection[other]).toHaveLength(1);
  expect(screen.getByRole('button', { name: '全选' })).toBeDisabled();
});

it('selects every filtered result across pages without clearing existing selections', async () => {
  const options = { users: Array.from({ length: 26 }, (_, index) => ({ id: `user-${index}`, name: index === 0 ? '已选人员' : `研发人员${index}`, employeeNo: `w${index}` })), roles: [], departments: [] };
  function Form() {
    const [value, setValue] = useState({ ...emptyAudience(), userIds: ['user-0'] });
    return <><RecipientPicker options={options} value={value} onChange={setValue} /><output data-testid="selection">{JSON.stringify(value)}</output></>;
  }
  const user = userEvent.setup(); render(<Form />);
  await user.type(screen.getByRole('searchbox'), '研发');
  await user.click(screen.getByRole('button', { name: '全选' }));
  expect(JSON.parse(screen.getByTestId('selection').textContent!).userIds).toHaveLength(26);
  await user.clear(screen.getByRole('searchbox'));
  await user.type(screen.getByRole('searchbox'), '不存在');
  expect(screen.getByRole('button', { name: '全选' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '选择本页' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '清空' }));
  expect(JSON.parse(screen.getByTestId('selection').textContent!)).toEqual(emptyAudience());
});

it('preserves selections across pages and resets pagination after searching or changing tabs', async () => {
  const options = { users: Array.from({ length: 25 }, (_, index) => ({ id: `user-${index}`, name: `员工${index}`, employeeNo: `w${index}` })), roles: [], departments: [] };
  function Form() { const [value, setValue] = useState(emptyAudience); return <form className="entity-form"><RecipientPicker options={options} value={value} onChange={setValue} mode="authorization" /></form>; }
  const user = userEvent.setup(); render(<Form />);
  expect(screen.getAllByRole('checkbox')).toHaveLength(5);
  await user.click(screen.getByRole('checkbox', { name: /员工0.*w0/ }));
  await user.click(within(screen.getByRole('navigation', { name: '授权范围用户分页' })).getByRole('button', { name: '下一页' }));
  await user.click(screen.getByRole('checkbox', { name: /员工5.*w5/ }));
  expect(screen.getByRole('button', { name: '移除员工0' })).toBeVisible();
  expect(screen.getByRole('button', { name: '移除员工5' })).toBeVisible();
  await user.click(screen.getByRole('tab', { name: /部门/ }));
  await user.click(screen.getByRole('tab', { name: /用户/ }));
  expect(screen.getByRole('checkbox', { name: /员工0.*w0/ })).toBeChecked();
  await user.type(screen.getByRole('searchbox', { name: '搜索授权用户' }), 'w24');
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  expect(screen.getByRole('checkbox', { name: /员工24.*w24/ })).toBeVisible();
});
