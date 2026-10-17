"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Boxes, LockKeyhole, UserRound } from "lucide-react";
import { usePlatform } from "./platform-provider";
import Link from 'next/link';
import { useRouter } from "next/navigation";
import { hasBackend, loginBackend, saveSession, getPortalSsoConfig, portalSsoStartUrl, redirectPortalSso, completePortalSso, type BackendLogin } from "../lib/api-client";
import { safeLoginReturnTo } from '../lib/login-return';

export function LoginEntry({ autoSso = false }: { autoSso?: boolean }) {
  const { dispatch, notice, users } = usePlatform();
  const router = useRouter();
  const [employeeNo, setEmployeeNo] = useState("");
  const [password, setPassword] = useState("");
  const destination = useCallback(() => {
    return safeLoginReturnTo(new URLSearchParams(window.location.search).get('returnTo'));
  }, []);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [returnTo, setReturnTo] = useState('/');
  const completion = useRef<Promise<BackendLogin> | null>(null);
  const loginDispatch = useRef(dispatch);
  useEffect(() => { loginDispatch.current = dispatch; }, [dispatch]);
  useEffect(() => {
    if (!hasBackend) return;
    let active = true;
    const status = new URLSearchParams(window.location.search).get('sso')
      ?? (window.sessionStorage.getItem('aigc-explicit-logout') === '1' ? 'logged-out' : null);
    const callback = status === 'complete' || status === 'expired' || status === 'failed' || status === 'disabled' || status === 'logged-out';
    void getPortalSsoConfig().then(config => {
      if (!active) return;
      setReturnTo(destination());
      setSsoEnabled(config.enabled);
      if (autoSso && !callback) {
        if (config.enabled) { setSubmitting(true); redirectPortalSso(destination()); }
        else setError('企业 SSO 尚未启用，请使用工号密码登录或联系管理员。');
      }
    }).catch(() => {
      if (active && autoSso && !callback) setError('企业 SSO 服务暂时不可用，请重试或使用工号密码登录。');
    });
    const timer = window.setTimeout(() => {
      setReturnTo(destination());
      if (status === 'complete') {
        setSubmitting(true);
        completion.current ??= completePortalSso();
        void completion.current.then(async session => {
          if (!active) return;
          saveSession(session);
          await loginDispatch.current({ type: 'login', employeeNo: session.user.employeeNo });
          if (active) router.replace(destination());
        }).catch(reason => {
          if (active) setError(reason instanceof Error ? reason.message : 'SSO 登录失败，请重试。');
        }).finally(() => { if (active) setSubmitting(false); });
      } else if (status === 'logged-out') {
        setError('已退出中台登录。再次进入请点击 企业 SSO 登录。');
      } else if (status === 'expired' || status === 'failed' || status === 'disabled') {
        setError(status === 'disabled' ? '此账号已停用，请联系管理员。' : status === 'expired'
          ? 'SSO 登录请求已过期，请重新点击 企业 SSO 登录。' : '企业 SSO 登录失败，请重试或使用工号密码登录。');
      }
      }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [autoSso, destination, router]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    if (hasBackend) {
      try {
        const session = await loginBackend(employeeNo.trim(), password);
        saveSession(session);
        await dispatch({ type: "login", employeeNo: session.user.employeeNo });
        router.replace(destination());
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "登录失败");
      } finally {
        setSubmitting(false);
      }
      return;
    }
    const account = users.find(
      (user) =>
        user.employeeNo.toLowerCase() === employeeNo.trim().toLowerCase() &&
        user.status === "启用",
    );
    dispatch({ type: "login", employeeNo });
    if (account) router.replace(destination());
    setSubmitting(false);
  };
  return (
    <main className="login-page">
      <section className="login-card">
        <header>
          <span>
            <Boxes size={25} />
          </span>
          <div>
            <strong>AIGC Agent Hub</strong>
            <small>企业智能应用中台</small>
          </div>
        </header>
        <div className="login-copy">
          <span>AIGC UNIFIED ACCESS</span>
          <h1>登录 AIGC Agent Hub</h1>
          <p>{autoSso ? '正在通过 企业 SSO 验证企业身份。' : '使用企业工号进入应用门户与管理控制台。'}</p>
        </div>
        {ssoEnabled && <div className="login-sso">
          <a className="primary-action" aria-disabled={submitting} tabIndex={submitting ? -1 : 0}
            href={portalSsoStartUrl(returnTo)} onClick={event => {
              if (submitting) { event.preventDefault(); return; }
              setError(''); setSubmitting(true);
            }}>使用 企业 SSO 登录</a>
          {!autoSso && <span>或使用工号密码登录</span>}
        </div>}
        {!autoSso && <form onSubmit={submit}>
          <label>
            <span>企业工号</span>
            <div>
              <UserRound size={18} />
              <input
                aria-label="企业工号"
                value={employeeNo}
                onChange={(e) => setEmployeeNo(e.target.value)}
                required
              />
            </div>
          </label>
          <label>
            <span>密码</span>
            <div>
              <LockKeyhole size={18} />
              <input
                aria-label="密码"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
          </label>
          <button className="primary-action" type="submit" disabled={submitting}>
            {submitting ? "登录中…" : "登录"}
          </button>
        </form>}
        {autoSso && <div className="login-sso-fallback">
          {submitting && <p role="status">正在跳转或完成 SSO 登录…</p>}
          <Link href={`/login/local?${new URLSearchParams({ returnTo })}`}>使用工号密码登录</Link>
        </div>}
        {(error || notice || (autoSso && !hasBackend)) && (
          <div role="status" className="login-notice">
            {error || notice || '当前未配置后端，请使用工号密码登录。'}
          </div>
        )}
        {/* <footer>
          {currentUserId ? (
            <Link href="/admin">进入管理后台</Link>
          ) : (
            <span>演示账号：wh00028</span>
          )}
          <small>当前为无后端接口的域控登录原型</small>
        </footer> */}
      </section>
    </main>
  );
}
