'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';

type AntPaginationProps = {
  ariaLabel: string;
  current: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
};

export function AntPagination({ ariaLabel, current, pageSize, total, onChange }: AntPaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const activePage = Math.min(Math.max(1, current), pageCount);
  const pages = pageCount <= 7
    ? Array.from({ length: pageCount }, (_, index) => index + 1)
    : Array.from(new Set([1, pageCount, ...Array.from({ length: 5 }, (_, index) => activePage + index - 2)]))
      .filter((page) => page >= 1 && page <= pageCount).sort((left, right) => left - right);

  return (
    <nav className="ant-pagination" aria-label={ariaLabel}>
      <span className="ant-pagination__total">共 {total} 条</span>
      <button className="ant-pagination__arrow" type="button" aria-label="上一页" disabled={activePage === 1} onClick={() => onChange(activePage - 1)}><ChevronLeft size={15} /></button>
      {pages.map((page, index) => <span key={page} className="ant-pagination__entry">{index > 0 && page - pages[index - 1] > 1 && <span aria-hidden="true">…</span>}<button className={`ant-pagination__page${page === activePage ? ' is-active' : ''}`} type="button" aria-label={`第 ${page} 页`} aria-current={page === activePage ? 'page' : undefined} onClick={() => onChange(page)}>{page}</button></span>)}
      <button className="ant-pagination__arrow" type="button" aria-label="下一页" disabled={activePage === pageCount} onClick={() => onChange(activePage + 1)}><ChevronRight size={15} /></button>
      <span className="ant-pagination__size">{pageSize} 条 / 页</span>
    </nav>
  );
}
