'use client';
import './gitea-callback.css';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiRequest } from '../../../lib/api-client';

/**
 * OAuth landing page. It is normally opened as a popup by the repository picker:
 * on completion it reports back to the opener and closes itself so the half-filled
 * application form survives. When opened directly (no opener) it stays visible.
 */
export default function GiteaCallbackPage() {
  const started = useRef(false);
  const [status, setStatus] = useState<'working' | 'done' | 'error'>('working');
  const [message, setMessage] = useState('正在完成 Gitea 授权…');
  const [standalone, setStandalone] = useState(true);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    setStandalone(!window.opener);

    const finish = (ok: boolean, text: string) => {
      setStatus(ok ? 'done' : 'error');
      setMessage(text);
      if (!window.opener) return;
      // Forward the backend's reason so the picker can show why it failed instead of a
      // generic "authorization incomplete" that hides the real cause.
      try { window.opener.postMessage({ type: 'aigc-gitea-auth', ok, reason: ok ? null : text }, window.location.origin); } catch { /* opener went away */ }
      window.close();
    };

    const params = new URLSearchParams(window.location.search);
    const code = params.get('code'), state = params.get('state');
    window.history.replaceState(null, '', window.location.pathname);
    if (!code || !state) { finish(false, '授权被取消或回调参数不完整，请回到申请页面重试。'); return; }
    apiRequest<void>('/api/code-sources/gitea/complete', { method: 'POST', body: JSON.stringify({ code, state }) })
      .then(() => finish(true, 'Gitea 已连接。'))
      .catch((e: Error) => finish(false, e.message));
  }, []);

  return (
    <div className="admin-page page-enter">
      <section className="admin-panel gitea-callback-panel">
        <h1>连接 Gitea</h1>
        <p role="status" className={`gitea-callback-status is-${status}`}>{message}</p>
        {status === 'working' && <p className="gitea-callback-hint">正在与代码平台确认授权，请稍候…</p>}
        {status === 'done' && !standalone && <p className="gitea-callback-hint">窗口即将自动关闭，可回到申请页面继续填写。</p>}
        {status === 'done' && standalone && <p className="gitea-callback-hint">已可回到发布申请页面选择仓库。</p>}
        {standalone && <Link className="secondary-action" href="/admin/publications">返回发布申请</Link>}
      </section>
    </div>
  );
}
