'use client';

import { useEffect, useRef, useState } from 'react';
import { AppCard } from './app-card';
import type { PortalApp } from '../lib/types';
import type { PortalLocale } from '../lib/portal-i18n';

const BATCH_SIZE = 12;

export function AppCatalogGrid({ apps, locale, favorites, onFavorite, onOpen }: {
  apps: PortalApp[]; locale: PortalLocale; favorites: string[];
  onFavorite: (id: string) => void; onOpen: (app: PortalApp) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  const sentinel = useRef<HTMLDivElement>(null);
  const hasMore = visibleCount < apps.length;
  const showMore = () => setVisibleCount(count => Math.min(count + BATCH_SIZE, apps.length));

  useEffect(() => {
    const target = sentinel.current;
    if (!hasMore || !target || typeof IntersectionObserver === 'undefined') return;
    let requested = false;
    const observer = new IntersectionObserver(entries => {
      if (requested || !entries.some(entry => entry.isIntersecting)) return;
      requested = true;
      observer.disconnect();
      setVisibleCount(count => Math.min(count + BATCH_SIZE, apps.length));
    }, {rootMargin: '400px 0px', threshold: 0});
    observer.observe(target);
    return () => { requested = true; observer.disconnect(); };
  }, [hasMore, visibleCount, apps.length]);

  return <>
    <div className="app-grid">{apps.slice(0, visibleCount).map((app, index) => <AppCard key={app.id} app={app} index={index % BATCH_SIZE}
      favorite={favorites.includes(app.id)} locale={locale} onFavorite={() => onFavorite(app.id)} onOpen={() => onOpen(app)}/>)}</div>
    <div ref={sentinel} className="catalog-continuation">
      <span aria-live="polite">{locale === 'zh'
        ? hasMore ? `已展示 ${Math.min(visibleCount, apps.length)} / ${apps.length} 个应用，向下滚动继续浏览` : `已展示全部 ${apps.length} 个应用`
        : hasMore ? `Showing ${Math.min(visibleCount, apps.length)} of ${apps.length} apps. Scroll for more.` : `All ${apps.length} apps shown`}</span>
      {hasMore && <button type="button" className="filter-button" onClick={showMore}>{locale === 'zh' ? '加载更多应用' : 'Load more apps'}</button>}
    </div>
  </>;
}
