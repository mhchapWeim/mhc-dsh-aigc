import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: '弯崽工作伙伴 · Windows 客户端下载',
  description: '下载弯崽工作伙伴 Windows x64 桌面客户端，使用 企业 SSO 登录，开始工作区中的第一段对话。',
  icons: { icon: '/wanzai.svg' },
};

export default function DesktopLayout({ children }: { children: ReactNode }) { return children; }
