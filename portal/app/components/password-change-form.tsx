'use client';

import { useState } from 'react';
import { changeMyPassword, resetUserPassword } from '../lib/api-client';

export function PasswordChangeForm({ userId, onSaved }: { userId?: string; onSaved?: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy) return;
    setError(''); setMessage('');
    if (newPassword !== confirmation) { setError('两次输入的新密码不一致'); return; }
    setBusy(true);
    try {
      if (userId) await resetUserPassword(userId, newPassword);
      else await changeMyPassword(currentPassword, newPassword);
      setCurrentPassword(''); setNewPassword(''); setConfirmation('');
      setMessage('密码已修改，DSH 客户端需重新登录'); onSaved?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '密码修改失败'); }
    finally { setBusy(false); }
  };
  return <form className="password-change-form" onSubmit={save}>
    <p>修改 AIGC 本地登录密码，不影响企业统一登录密码。新密码为 8–128 个字符。</p>
    {!userId && <label>当前密码<input type="password" required autoComplete="current-password" maxLength={128} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></label>}
    <label>新密码<input type="password" required autoComplete="new-password" minLength={8} maxLength={128} value={newPassword} onChange={event => setNewPassword(event.target.value)} /></label>
    <label>确认新密码<input type="password" required autoComplete="new-password" minLength={8} maxLength={128} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
    {error && <p className="model-form-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <button className="primary-action" type="submit" disabled={busy}>{busy ? '保存中…' : '保存密码'}</button>
  </form>;
}
