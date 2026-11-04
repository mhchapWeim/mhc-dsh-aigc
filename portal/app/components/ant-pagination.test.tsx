import { selectDropdown } from '../../test/select-dropdown';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { AntPagination } from './ant-pagination';
import { usePageSize } from './use-page-size';

it('defaults to five and offers the five requested sizes while resetting the page', async () => {
  function List() {
    const [size, setSize] = usePageSize();
    const [page, setPage] = useState(2);
    return <><output>{page}:{size}</output><AntPagination ariaLabel="测试分页" current={page} total={83} pageSize={size} onChange={setPage} onPageSizeChange={setSize} /></>;
  }
  const user = userEvent.setup(); render(<List />);
  const select = screen.getByRole('combobox', { name: '测试分页每页条数' });
  expect(select).toHaveTextContent('5 条 / 页');
  fireEvent.click(select);
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['5 条 / 页', '10 条 / 页', '15 条 / 页', '20 条 / 页', '50 条 / 页']);
  selectDropdown(select, '15');
  expect(screen.getByText('1:15')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '第 2 页' }));
  selectDropdown(select, '50');
  expect(screen.getByText('1:50')).toBeVisible();
});
