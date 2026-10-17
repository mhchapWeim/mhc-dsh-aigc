'use client';

import { ArrowUpRight, Bot, BookOpenCheck, BriefcaseBusiness, Code2, Heart } from 'lucide-react';
import type { PortalApp } from '../lib/types';
import type { PortalLocale } from '../lib/portal-i18n';

type AppCardProps = { app: PortalApp; index: number; favorite: boolean; locale: PortalLocale; onFavorite: () => void; onOpen: () => void };

export function AppCard({ app, index, favorite, locale, onFavorite, onOpen }: AppCardProps) {
  const isEnglish = locale === 'en';
  const status = isEnglish ? 'Running' : app.status;
  const available = Boolean(app.accessUrl);
  const AppIcon = app.category === '知识智能' ? BookOpenCheck : app.category === '效率办公' ? BriefcaseBusiness : app.category === '研发创新' ? Code2 : Bot;
  const favoriteLabel = isEnglish ? `${favorite ? 'Remove from' : 'Add to'} favorites: ${app.name}` : `${favorite ? '取消收藏' : '收藏'}${app.name}`;
  return (
    <article className="app-card" style={{ '--card-accent': app.accent, '--card-delay': `${index * 40}ms` } as React.CSSProperties}>
      <div className="app-card__topline">
        <span className="app-card__icon"><AppIcon size={24} aria-hidden="true" /></span>
        <button className={`icon-button favorite-button${favorite ? ' is-active' : ''}`} type="button" aria-label={favoriteLabel} aria-pressed={favorite} onClick={onFavorite}>
          <Heart size={19} fill={favorite ? 'currentColor' : 'none'} aria-hidden="true" />
        </button>
      </div>
      <div className="app-card__body">
        <div className="app-card__eyebrow"><span>{isEnglish ? ({ 智慧服务: 'Smart services', 知识智能: 'Knowledge AI', 效率办公: 'Productivity', 研发创新: 'R&D innovation' }[app.category] ?? app.category) : app.category}</span><span className="status-dot">{status}</span></div>
        <h3>{app.name}</h3><p>{app.description}</p>
        <div className="tag-row">{app.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div>
      </div>
      <footer className="app-card__footer">
        <div><span>{app.owner}</span><strong>{isEnglish ? 'Approved app' : '已审批发布'}</strong></div>
        <button className="enter-button" type="button" disabled={!available} onClick={onOpen} aria-label={available ? `${isEnglish ? 'Open ' : '进入'}${app.name}` : (isEnglish ? `${app.name} is under maintenance and cannot be opened` : `${app.name}维护中，暂不可进入`)}><span>{available ? (isEnglish ? 'Open' : '进入') : (isEnglish ? 'Unavailable' : '维护中')}</span><ArrowUpRight size={18} aria-hidden="true" /></button>
      </footer>
    </article>
  );
}
