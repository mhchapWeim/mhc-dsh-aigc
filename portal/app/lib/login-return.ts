/** Login redirects remain within the Portal, including decoded control and separator checks. */
export function safeLoginReturnTo(value: string | null): string {
  if (!value || value.length > 2048) return '/';
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return '/'; }
  return decoded.startsWith('/') && !decoded.startsWith('//') && !/[\\\x00-\x1f\x7f]/.test(decoded)
    && !['/login', '/login/local'].includes(decoded.split(/[?#]/)[0]!) ? value : '/';
}
