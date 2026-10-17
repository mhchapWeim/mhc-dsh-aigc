'use client';

import { Check, Search, UserRound } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
type DirectoryUser = { id: string; name: string; employeeNo: string; department: string };

export function DirectoryUserPicker({ users, selectedIds, onChange }: { users: DirectoryUser[]; selectedIds: string[]; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => users.filter((user) => `${user.name}${user.employeeNo}${user.department}`.toLowerCase().includes(query.toLowerCase())), [query, users]);
  const selectedUsers = users.filter((user) => selectedIds.includes(user.id));

  useEffect(() => {
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, []);

  const toggle = (id: string) => onChange(selectedIds.includes(id) ? selectedIds.filter((item) => item !== id) : [...selectedIds, id]);

  return <div className={`directory-picker${open ? ' is-open' : ''}`} ref={rootRef}><button className="directory-picker__trigger" type="button" aria-label="选择域用户" aria-expanded={open} onClick={() => setOpen((current) => !current)}><UserRound size={15} /><span>{selectedUsers.length ? `已选择 ${selectedUsers.length} 人` : '选择域用户'}</span></button>{selectedUsers.length > 0 && <div className="directory-picker__selected">{selectedUsers.map((user) => <span key={user.id}>{user.name} · {user.employeeNo}<button type="button" aria-label={`移除${user.name}`} onClick={() => toggle(user.id)}>×</button></span>)}</div>}{open && <div className="directory-picker__popup"><label className="directory-picker__search"><Search size={14}/><input autoFocus type="search" aria-label="搜索域用户" placeholder="姓名、工号或部门" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="directory-picker__list" role="listbox" aria-label="域用户列表" aria-multiselectable="true">{filtered.map((user) => { const checked = selectedIds.includes(user.id); return <button type="button" role="option" aria-selected={checked} aria-label={`${user.name} ${user.employeeNo} ${user.department}`} key={user.id} onClick={() => toggle(user.id)}><span className="directory-avatar">{user.name.slice(0, 1)}</span><span><strong>{user.name}<small>{user.employeeNo}</small></strong><em>{user.department}</em></span><i className={checked ? 'is-checked' : ''}>{checked && <Check size={12}/>}</i></button>})}</div><footer><span>企业目录用户</span><button type="button" onClick={() => setOpen(false)}>完成</button></footer></div>}</div>;
}
