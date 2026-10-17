import type { Metadata } from 'next';
import './globals.css';
import { PlatformProvider } from './components/platform-provider';
import { AuthGuard } from './components/auth-guard';

export const metadata: Metadata = {
  title: 'AIGC Agent Hub · 企业智能应用中台',
  description: '统一发现、访问与管理企业内部 Agent 和数字化应用。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body><PlatformProvider><AuthGuard>{children}</AuthGuard></PlatformProvider></body>
    </html>
  );
}
