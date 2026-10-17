/* eslint-disable @next/next/no-img-element */
'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowDown, ArrowRight, Download, FolderOpen, ShieldCheck, Undo2 } from 'lucide-react';
import { getDesktopDownload, startDesktopDownload, hasBackend, type DesktopDownload } from '../lib/api-client';
import styles from './page.module.css';

export default function DesktopDownloadPage() {
  const [release, setRelease] = useState<DesktopDownload | null>(null);
  const [state, setState] = useState<'loading' | 'signed-out' | 'ready' | 'empty' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      if (!hasBackend || !localStorage.getItem('aigc_hub_access_token')) { setState('signed-out'); return; }
      setState('loading'); setMessage('');
      void getDesktopDownload().then(value => {
        if (!active) return;
        setRelease(value.release); setState(value.release ? 'ready' : 'empty');
      }).catch(error => {
        if (!active) return;
        setState(localStorage.getItem('aigc_hub_access_token') ? 'error' : 'signed-out');
        setMessage(error instanceof Error ? error.message : '暂时无法获取安装包，请稍后重试。');
      });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [attempt]);
  async function download() {
    if (!release || busy) return;
    setBusy(true); setMessage('');
    try { await startDesktopDownload(release.id); setMessage('下载已交给浏览器，请在浏览器下载列表中查看进度。'); }
    catch (error) {
      setMessage(error instanceof Error ? error.message : '下载未能开始，请重试。');
      if (!localStorage.getItem('aigc_hub_access_token')) setState('signed-out');
    }
    finally { setBusy(false); }
  }
  const action = state === 'signed-out'
    ? <Link className={styles.download} href="/login?returnTo=%2Fdesktop"><Download size={20} />登录并下载 Windows x64<ArrowRight size={18} /></Link>
    : <button className={styles.download} type="button" disabled={state !== 'ready' || busy} onClick={() => void download()}><Download size={20} />{busy ? '正在准备下载…' : state === 'loading' ? '正在获取安装包…' : state === 'ready' ? '下载 Windows x64' : '暂无可下载版本'}</button>;
  return <div className={styles.page}>
    <header className={styles.header}>
      <Link href="/desktop" className={styles.brand}><img src="/wanzai.svg" width="44" height="44" alt="" /><span>弯崽工作伙伴<small>桌面客户端</small></span></Link>
      <nav aria-label="下载页导航"><a href="#getting-started">安装指南</a><Link href="/">返回 AIGC 中台<ArrowRight size={16} /></Link></nav>
    </header>
    <main>
      <section className={styles.hero} aria-labelledby="desktop-title">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>弯崽工作伙伴 · WINDOWS 桌面版</p>
          <h1 id="desktop-title">今天的工作，<br />让弯崽一起办。</h1>
          <p className={styles.intro}>从一段对话开始，把文档、代码和日常任务带回你的工作区。安装桌面客户端，使用企业账号登录，即可接入中台授权的模型与工具。</p>
          <div className={styles.actions}>{action}<a href="#getting-started" className={styles.guide}>了解如何安装<ArrowDown size={16} /></a></div>
          <div className={styles.status} aria-live="polite">
            {release && state === 'ready' && <p>版本 {release.version} <span>·</span> {(release.bytes / 1024 / 1024).toFixed(0)} MB <span>·</span> Windows x64 安装程序</p>}
            {state === 'signed-out' && <p>使用企业 SSO 登录，获取分配给你的已发布版本。</p>}
            {state === 'empty' && <p>当前账号暂无可下载的 Windows x64 版本，请联系管理员发布并授权。</p>}
            {state === 'error' && <p role="alert">{message}</p>}
            {state !== 'error' && message && <p role="status">{message}</p>}
            {(state === 'error' || state === 'empty') && <button type="button" onClick={() => setAttempt(value => value + 1)}>重新检查</button>}
          </div>
        </div>
        <div className={styles.mascot}><div className={styles.mascotDisc} /><img src="/wanzai.svg" alt="弯崽工作伙伴品牌形象" width="480" height="480" fetchPriority="high" /><span>你的桌面工作伙伴</span></div>
      </section>
      <section className={styles.benefits} aria-label="客户端能力">
        <article><FolderOpen size={24} /><h2>围绕工作区开展工作</h2><p>把任务放在熟悉的目录里，查看历史会话，继续之前的工作。</p></article>
        <article><ShieldCheck size={24} /><h2>企业账号，统一接入</h2><p>通过企业 SSO 登录，使用中台为你授权的模型和插件。</p></article>
        <article><Undo2 size={24} /><h2>历史随工作延续</h2><p>支持会话备份与工作区迁移，迁移前先预览，保留原始数据。</p></article>
      </section>
      <section id="getting-started" className={styles.setup} aria-labelledby="setup-title">
        <div><p className={styles.eyebrow}>开始使用</p><h2 id="setup-title">三步，让弯崽加入工作。</h2><p>目前提供 Windows x64 版本。无需自行安装 Node.js 或配置命令行环境。</p></div>
        <ol><li><span>01</span><div><h3>下载并安装</h3><p>登录后下载安装程序，按向导完成安装。升级前请保存工作并退出旧客户端。</p></div></li><li><span>02</span><div><h3>使用企业身份登录</h3><p>打开弯崽工作伙伴，选择 SSO 认证，在浏览器完成企业身份登录。</p></div></li><li><span>03</span><div><h3>从第一段对话开始</h3><p>进入默认工作区，选择可用模型，输入你的任务。Windows 默认工作区为 <code>D:\wanzaiwork</code>。</p></div></li></ol>
      </section>
      {release && <section className={styles.release} aria-labelledby="release-title"><div><p className={styles.eyebrow}>当前可下载版本</p><h2 id="release-title">{release.version}</h2><p>{new Date(release.createdAt).toLocaleDateString('zh-CN')} 发布 · Windows x64</p></div><div><p className={styles.notes}>{release.notes || '本版本暂无更新说明。'}</p><details><summary>安装包校验信息</summary><dl><dt>文件名</dt><dd>{release.fileName}</dd><dt>SHA-512（Base64）</dt><dd><code>{release.sha512}</code></dd></dl></details></div></section>}
      <section className={styles.bottom}><div><h2>准备好开始了吗？</h2><p>把下一件工作，交给你和弯崽。</p></div>{action}</section>
    </main>
    <footer className={styles.footer}><span>弯崽工作伙伴 · AIGC Agent Hub</span><Link href="/">返回中台</Link><span>Windows x64</span></footer>
  </div>;
}
