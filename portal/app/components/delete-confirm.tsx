'use client';

import { useEffect, useState } from 'react';
import { ConfigProvider, Modal, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';

/** Shared Ant Design confirmation for every administrative delete action. */
export function useDeleteConfirm() {
  const [modal, contextHolder] = Modal.useModal();
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const update = () => setDark(document.documentElement.dataset.theme === 'dark');
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  const confirmDelete = async (content: string, action?: () => Promise<unknown>) => {
    const dialog = modal.confirm({
      title: '确认删除', content, centered: true, width: 440,
      okText: '确认删除', cancelText: '取消', okButtonProps: { danger: true },
      focusable: { autoFocusButton: 'cancel' },
      onOk: async () => {
        dialog.update({ cancelButtonProps: { disabled: true }, keyboard: false });
        try { await action?.(); }
        catch (error) {
          dialog.update({ content: <><p>{content}</p><p role="alert">{error instanceof Error ? error.message : '删除失败，请重试'}</p></> });
          throw error;
        } finally { dialog.update({ cancelButtonProps: { disabled: false }, keyboard: true }); }
      },
    });
    return Boolean(await dialog);
  };
  return { confirmDelete, deleteConfirmHolder: <ConfigProvider locale={zhCN} theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm, token: { motion: false, colorPrimary: '#225dcc', borderRadius: 6, fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif' } }}>{contextHolder}</ConfigProvider> };
}
