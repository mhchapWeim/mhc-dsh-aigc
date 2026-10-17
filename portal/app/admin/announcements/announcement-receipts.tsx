'use client';

import { useState } from 'react';
import { AntPagination } from '../../components/ant-pagination';
import type { DesktopAnnouncement } from '../../lib/api-client';

const formatDate = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN') : '—';

export function AnnouncementReceipts({ announcement, onClose }: { announcement: DesktopAnnouncement; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const people = announcement.recipients;
  const current = Math.min(page, Math.max(1, Math.ceil(people.length / pageSize)));
  const counts = [
    { label: '接收人员', count: people.length },
    { label: '已送达', count: people.filter(person => person.deliveredAt).length },
    { label: '已读', count: people.filter(person => person.readAt).length },
    { label: '已确认', count: people.filter(person => person.confirmedAt).length },
  ];
  return <div className="entity-form distribution-form announcement-receipts">
    <section className="receipt-content"><h3>公告正文</h3><p>{announcement.body}</p></section>
    <div className="receipt-period"><div><span>生效时间</span><strong>{formatDate(announcement.startsAt)}</strong></div><div><span>到期时间</span><strong>{announcement.endsAt ? formatDate(announcement.endsAt) : '长期有效'}</strong></div></div>
    <section className="receipt-section"><h3>接收回执</h3><div className="receipt-summary">{counts.map(item => <div key={item.label}><span>{item.label}</span><strong>{item.count}</strong></div>)}</div>
      <div className="receipt-table-wrap"><table className="data-grid receipt-table" aria-label="公告接收回执"><thead><tr><th>人员</th><th>送达时间</th><th>已读时间</th><th>确认时间</th></tr></thead><tbody>{people.slice((current - 1) * pageSize, current * pageSize).map(person => <tr key={person.userId}>
        <td><strong>{person.name}</strong><small>{person.employeeNo}</small></td><td>{formatDate(person.deliveredAt)}</td><td>{formatDate(person.readAt)}</td><td>{formatDate(person.confirmedAt)}</td>
      </tr>)}</tbody></table></div>{people.length === 0 && <div className="empty-state">暂无接收人员</div>}
      <AntPagination ariaLabel="公告回执分页" current={current} total={people.length} pageSize={pageSize} onChange={setPage} />
    </section>
    <div className="modal-actions"><button type="button" className="secondary-action" onClick={onClose}>关闭</button></div>
  </div>;
}
