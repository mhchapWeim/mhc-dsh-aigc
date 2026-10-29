import { AdminShell } from './components/admin-shell';
import './admin-theme.css';

export default function AdminLayout({ children }: { children: React.ReactNode }) { return <AdminShell>{children}</AdminShell>; }
