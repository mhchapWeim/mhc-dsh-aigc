'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { hasBackend } from '../lib/api-client';
import { usePlatform } from './platform-provider';

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { currentUserId } = usePlatform();
  const [authenticated, setAuthenticated] = useState(false);
  const protectedPage = ['/admin', '/apps', '/chat'].some(prefix => path === prefix || path.startsWith(`${prefix}/`));
  useEffect(() => {
    const redirect = () => {
      setAuthenticated(false);
      router.replace(`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)}`);
    };
    const timer = window.setTimeout(() => {
      if (protectedPage) {
        if (hasBackend ? !localStorage.getItem('aigc_hub_access_token') : !currentUserId) redirect();
        else setAuthenticated(true);
      }
    }, 0);
    const expired = () => { if (protectedPage) redirect(); };
    const changed = () => { if (protectedPage && !localStorage.getItem('aigc_hub_access_token')) redirect(); };
    window.addEventListener('aigc-session-expired', expired);
    window.addEventListener('storage', changed);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('aigc-session-expired', expired);
      window.removeEventListener('storage', changed);
    };
  }, [path, protectedPage, currentUserId, router]);
  if (protectedPage && !authenticated) return <main className="empty-state" role="status">正在验证登录状态…</main>;
  return children;
}
