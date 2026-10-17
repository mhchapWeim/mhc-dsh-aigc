/* eslint-disable @next/next/no-img-element */
'use client';

import Link from 'next/link';
import { ArrowRight, Download, Grid2X2, Languages, MessageSquareText, Moon, Settings2, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
type Locale = 'zh' | 'en';

const copy = {
  zh: {
    product: 'AIGC Agent Hub', subtitle: '企业智能应用中台', language: 'EN', theme: '切换主题', admin: '管理后台', download: '客户端下载',
    eyebrow: 'BHSS 企业 AI 工作空间', title: '让智能成为工作的起点',
    intro: '从一次对话开始，连接公司知识、业务流程与已发布的智能应用。',
    chat: '开始对话', chatBody: '进入企业 AI 对话工作台', apps: '应用集合', appsBody: '浏览已审批发布的内部应用',
    visualTitle: '连接业务与智能', visualBody: '统一入口，清晰抵达每一种能力', visualAlt: '蓝色抽象曲面，象征企业流程与智能能力的连接',
  },
  en: {
    product: 'AIGC Agent Hub', subtitle: 'Enterprise AI Application Hub', language: '中文', theme: 'Switch theme', admin: 'Admin', download: 'Desktop app',
    eyebrow: 'BHSS ENTERPRISE AI WORKSPACE', title: 'Make intelligence the start of work',
    intro: 'Start with a conversation, then connect company knowledge, workflows and approved intelligent applications.',
    chat: 'Start a conversation', chatBody: 'Open the enterprise AI chat workspace', apps: 'Application collection', appsBody: 'Browse approved internal applications',
    visualTitle: 'Connect work with intelligence', visualBody: 'One clear entrance to every capability', visualAlt: 'Blue abstract surface representing connected enterprise workflows and intelligence',
  },
} as const;

export function LandingShell() {
  const [theme, setTheme] = useState<Theme>('light');
  const [locale, setLocale] = useState<Locale>('zh');
  const t = copy[locale];

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- restore persisted browser preference after hydration */
    const savedTheme: Theme = localStorage.getItem('aigc-theme') === 'dark' ? 'dark' : 'light';
    const savedLocale: Locale = localStorage.getItem('aigc-locale') === 'en' ? 'en' : 'zh';
    setTheme(savedTheme);
    setLocale(savedLocale);
    document.documentElement.dataset.theme = savedTheme;
    document.documentElement.lang = savedLocale === 'zh' ? 'zh-CN' : 'en';
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    localStorage.setItem('aigc-theme', next);
    document.documentElement.dataset.theme = next;
  };

  const toggleLocale = () => {
    const next = locale === 'zh' ? 'en' : 'zh';
    setLocale(next);
    localStorage.setItem('aigc-locale', next);
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
  };

  return (
    <div className="landing-page">
      <div className="bhss-brand-stripe" aria-hidden="true" />
      <header className="landing-nav landing-reveal landing-delay-1">
        <Link className="landing-brand" href="/" aria-label="BHSS AIGC Agent Hub">
          <span className="landing-logo-frame"><img src="/bhss-logo.png" alt="博世华域转向系统有限公司" /></span>
          <span><strong>{t.product}</strong><small>{t.subtitle}</small></span>
        </Link>
        <nav aria-label={locale === 'zh' ? '全局导航' : 'Global navigation'}>
          <Link href="/desktop" aria-label={locale === 'zh' ? '下载弯崽工作伙伴' : 'Download Wanzai desktop'}><Download size={17} /><span>{t.download}</span></Link>
          <button type="button" onClick={toggleTheme} aria-label={t.theme}>{theme === 'light' ? <Sun size={17} /> : <Moon size={17} />}</button>
          <button type="button" onClick={toggleLocale}><Languages size={17} /><span>{t.language}</span></button>
          <Link href="/admin"><Settings2 size={17} /><span>{t.admin}</span></Link>
        </nav>
      </header>

      <main className="landing-main">
        <section className="landing-copy">
          <p className="landing-eyebrow landing-reveal landing-delay-2">{t.eyebrow}</p>
          <h1 className="landing-reveal landing-delay-3">{t.title}</h1>
          <p className="landing-intro landing-reveal landing-delay-4">{t.intro}</p>
          <div className="landing-actions landing-reveal landing-delay-5">
            <Link className="landing-action landing-action-primary" href="/chat">
              <span className="landing-action-icon"><MessageSquareText size={23} /></span>
              <span><strong>{t.chat}</strong><small>{t.chatBody}</small></span>
              <ArrowRight size={20} className="landing-action-arrow" />
            </Link>
            <Link className="landing-action" href="/apps">
              <span className="landing-action-icon"><Grid2X2 size={23} /></span>
              <span><strong>{t.apps}</strong><small>{t.appsBody}</small></span>
              <ArrowRight size={20} className="landing-action-arrow" />
            </Link>
          </div>
        </section>

        <figure className="landing-visual landing-reveal landing-delay-4">
          <img src="/hub-hero-blue.webp" alt={t.visualAlt} width="1456" height="1094" />
          <figcaption><strong>{t.visualTitle}</strong><span>{t.visualBody}</span></figcaption>
        </figure>
      </main>
    </div>
  );
}
