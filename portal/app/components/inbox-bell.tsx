'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell, BellRing, Inbox, X } from 'lucide-react';
import {
  getInboxMessages,
  getInboxUnread,
  hasBackend,
  markInboxAllRead,
  markInboxRead,
  type InboxMessage,
} from '../lib/api-client';
import type { PortalLocale } from '../lib/portal-i18n';
import './inbox.css';

const POLL_INTERVAL_MS = 20_000;
const POPUP_VISIBLE_MS = 5_000;

type Popup = InboxMessage & { leaving: boolean };

const TEXT = {
  zh: {
    bell: '通知',
    title: '站内信',
    unread: (count: number) => `${count} 条未读消息`,
    none: '暂无未读消息',
    empty: '还没有收到站内信',
    readAll: '全部标记已读',
    open: '查看任务',
    dismiss: '关闭提醒',
    now: '刚刚',
    loadFailed: '站内信加载失败',
  },
  en: {
    bell: 'Notifications',
    title: 'Inbox',
    unread: (count: number) => `${count} unread`,
    none: 'Nothing unread',
    empty: 'No messages yet',
    readAll: 'Mark all as read',
    open: 'Open task',
    dismiss: 'Dismiss',
    now: 'now',
    loadFailed: 'Could not load messages',
  },
} as const;

/**
 * Shared bell for the portal and the admin console. Both surfaces mount their own
 * copy, so the unread count comes from the server instead of a shared store, and
 * every newly arrived message raises a five-second card in the top-right corner —
 * a badge alone is too easy to miss while a reviewer is buried in a list page.
 */
export function InboxBell({ locale = 'zh' }: { locale?: PortalLocale }) {
  const copy = TEXT[locale];
  const [enabled, setEnabled] = useState(false);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [notice, setNotice] = useState('');
  const [popups, setPopups] = useState<Popup[]>([]);
  const seenIds = useRef<Set<string>>(new Set());
  const initialized = useRef(false);

  useEffect(() => {
    // Reading the token is a browser-only concern and stays out of render.
    const timer = window.setTimeout(() => setEnabled(hasBackend && Boolean(localStorage.getItem('aigc_hub_access_token'))), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const check = async () => {
      try {
        const [state, page] = await Promise.all([getInboxUnread(), getInboxMessages(1, 20)]);
        if (!active) return;
        setUnread(state.unread);
        setMessages(page.items);
        setNotice('');
        const incoming = page.items.filter((item) => !item.isRead && !seenIds.current.has(item.id));
        for (const item of page.items) seenIds.current.add(item.id);
        // The first poll only establishes the baseline: messages that were already
        // waiting before login must not fire five banners at once.
        if (!initialized.current) {
          initialized.current = true;
          return;
        }
        if (incoming.length > 0)
          setPopups((current) => [
            ...current,
            ...incoming.map((item) => ({ ...item, leaving: false })),
          ].slice(-3));
      } catch (error) {
        if (active) setNotice(error instanceof Error ? error.message : copy.loadFailed);
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), POLL_INTERVAL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [enabled, copy.loadFailed]);

  // Each card retires itself, and the tail of the animation removes it from the tree.
  useEffect(() => {
    if (popups.length === 0) return;
    const timers = popups.filter((item) => !item.leaving).map((item) => window.setTimeout(() => {
      setPopups((current) => current.map((value) => value.id === item.id ? { ...value, leaving: true } : value));
      window.setTimeout(() => setPopups((current) => current.filter((value) => value.id !== item.id)), 260);
    }, POPUP_VISIBLE_MS));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [popups]);

  const dismissPopup = (id: string) => {
    setPopups((current) => current.map((value) => value.id === id ? { ...value, leaving: true } : value));
    window.setTimeout(() => setPopups((current) => current.filter((value) => value.id !== id)), 260);
  };

  const readAll = async () => {
    try {
      await markInboxAllRead();
      setUnread(0);
      setMessages((current) => current.map((item) => ({ ...item, isRead: true })));
      setPopups([]);
    } catch (error) { setNotice(error instanceof Error ? error.message : '操作失败'); }
  };

  const openMessage = async (message: InboxMessage) => {
    if (!message.isRead) {
      try { await markInboxRead(message.id); } catch { /* The panel still opens; the badge refresh will retry. */ }
      setUnread((current) => Math.max(0, current - 1));
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, isRead: true } : item));
    }
    dismissPopup(message.id);
  };

  const toggle = () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    void getInboxUnread().then((state) => setUnread(state.unread)).catch(() => { /* Keep the last known count. */ });
  };

  return <>
    {popups.length > 0 && <div className="inbox-popup-stack" aria-live="assertive" aria-atomic="false">
      {popups.map((popup) => <aside className={`inbox-popup${popup.leaving ? ' is-leaving' : ''}`} key={popup.id} role="alert">
        <span className="inbox-popup__icon"><BellRing size={19} /></span>
        <div className="inbox-popup__body">
          <strong>{popup.title}</strong>
          <p>{popup.content}</p>
          <small>{copy.now}</small>
          {popup.link && <Link className="inbox-popup__link" href={popup.link} onClick={() => void openMessage(popup)}>{copy.open}</Link>}
        </div>
        <button className="inbox-popup__close" type="button" aria-label={copy.dismiss} onClick={() => dismissPopup(popup.id)}><X size={15} /></button>
        <span className="inbox-popup__timer" aria-hidden="true" />
      </aside>)}
    </div>}
    <div className="inbox-bell-wrap notification-wrap">
      <button className="icon-button notification-button" type="button" aria-label={copy.bell} aria-expanded={open}
        onClick={toggle}>
        {unread > 0 ? <BellRing size={19} /> : <Bell size={19} />}
        {unread > 0 && <span className="notification-count" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && <section className="notification-panel" role="dialog" aria-labelledby="inbox-title">
        <header>
          <div><h2 id="inbox-title">{copy.title}</h2><span>{unread > 0 ? copy.unread(unread) : copy.none}</span></div>
          <div className="inbox-panel__actions">
            <button type="button" onClick={() => void readAll()} disabled={unread === 0}>{copy.readAll}</button>
            <Inbox size={18} aria-hidden="true" />
          </div>
        </header>
        <div className="notification-list">
          {messages.length === 0
            ? <div className="inbox-panel__empty"><Bell size={26} /><span>{copy.empty}</span></div>
            : messages.map((message) => {
              const label = <><span className="notification-icon is-task"><Bell size={17} /></span>
                <span><strong>{message.title}</strong><small>{message.content}</small></span>
                <time>{new Date(message.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></>;
              const shared = `inbox-list__item${message.isRead ? '' : ' is-unread'}`;
              // A message that points at a task must be able to take the reviewer there.
              return message.link
                ? <Link className={shared} key={message.id} href={message.link} onClick={() => void openMessage(message)}>{label}</Link>
                : <button className={shared} key={message.id} type="button" onClick={() => void openMessage(message)}>{label}</button>;
            })}
        </div>
        {notice && <div className="inbox-panel__footer"><span>{notice}</span></div>}
      </section>}
    </div>
  </>;
}
