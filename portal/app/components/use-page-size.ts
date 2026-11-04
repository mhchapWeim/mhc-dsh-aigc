'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';

/** Optional table measurement; an explicit user selection takes precedence over automatic sizing. */
export function usePageSize(tableRef?: RefObject<HTMLElement | null>, ready = true) {
  const [size, setSize] = useState(5);
  const manual = useRef(false);
  useEffect(() => {
    if (!tableRef || !ready) return;
    let frame = 0;
    const measure = () => {
      if (manual.current || !tableRef.current) return;
      const table = tableRef.current.querySelector('table');
      if (!table) return;
      const top = table.getBoundingClientRect().top;
      const header = table.querySelector('thead')?.getBoundingClientRect().height ?? 40;
      const rows = Array.from(table.querySelectorAll('tbody tr'));
      const rowHeight = Math.max(64, ...rows.map(row => row.getBoundingClientRect().height));
      const available = window.innerHeight - top - header - 104;
      setSize(Math.max(1, Math.min(50, Math.floor(available / rowHeight))));
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    if (tableRef.current) observer.observe(tableRef.current);
    window.addEventListener('resize', schedule);
    schedule();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', schedule); };
  }, [tableRef, ready]);
  const selectSize = (value: number) => { manual.current = true; setSize(value); };
  return [size, selectSize] as const;
}
