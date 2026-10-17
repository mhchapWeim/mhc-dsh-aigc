"use client";
import Link from "next/link";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Clock3,
  FilePlus2,
  Network,
  Tags,
  TrendingUp,
  Users,
} from "lucide-react";
import { usePlatform } from "../components/platform-provider";
import { canAccessAdminPath, type AdminPath } from "../lib/platform-state";

export default function AdminDashboard() {
  const platform = usePlatform();
  const currentUser = platform.users.find(
    (user) => user.id === platform.currentUserId,
  );
  const metrics = [
    {
      label: "已发布应用",
      value: "27",
      trend: "+3 本月",
      icon: Bot,
      tone: "blue",
    },
    {
      label: "运行中流程",
      value: "12",
      trend: "98.6% 成功率",
      icon: Network,
      tone: "violet",
    },
    {
      label: "活跃用户",
      value: "286",
      trend: "+12.4%",
      icon: Users,
      tone: "teal",
    },
    {
      label: "业务分类",
      value: "5",
      trend: "4 个已启用",
      icon: Tags,
      tone: "orange",
    },
  ];
  const activities = [
    ["发布成功", "合同审阅流程 V2.3 已发布", "10:18"],
    ["新增用户", "张敏添加了 3 位业务用户", "09:42"],
    ["分类更新", "研发创新分类信息已更新", "昨天"],
    ["流程校验", "内容审核发布流程通过校验", "昨天"],
  ];
  const availableActions: Array<{
    href: AdminPath;
    label: string;
    description: string;
    icon: typeof FilePlus2;
  }> = [
    {
      href: "/admin/publications",
      label: "提交发布申请",
      description: "创建应用并进入审核流程",
      icon: FilePlus2,
    },
    {
      href: "/admin/processes",
      label: "设计新流程",
      description: "使用 BPMN 画布编排业务流程",
      icon: Network,
    },
    {
      href: "/admin/users",
      label: "管理用户",
      description: "维护用户与角色权限",
      icon: Users,
    },
    {
      href: "/admin/categories",
      label: "整理分类",
      description: "调整门户的应用导航结构",
      icon: Tags,
    },
  ];
  const quickActions = availableActions.filter((item) => canAccessAdminPath(platform, currentUser, item.href));
  return (
    <div className="admin-page page-enter">
      <div className="page-title">
        <div>
          <span className="section-kicker">PLATFORM OVERVIEW</span>
          <h1>运营工作台</h1>
          <p>
            上午好，{currentUser?.name ?? "访客"}。这里是平台今天的运行概览。
          </p>
        </div>
        {canAccessAdminPath(platform, currentUser, "/admin/publications") && (
          <Link className="primary-action" href="/admin/publications">
            <FilePlus2 size={18} />
            发布新应用
          </Link>
        )}
      </div>
      <div className="metric-grid">
        {metrics.map(({ label, value, trend, icon: Icon, tone }) => (
          <article className={`metric-card tone-${tone}`} key={label}>
            <span className="metric-card__icon">
              <Icon size={21} />
            </span>
            <div>
              <span>{label}</span>
              <strong>{value}</strong>
              <small>
                <TrendingUp size={13} />
                {trend}
              </small>
            </div>
          </article>
        ))}
      </div>
      <div className="dashboard-grid">
        <section className="admin-panel activity-panel">
          <div className="panel-heading">
            <div>
              <h2>平台动态</h2>
              <p>最近发生的管理操作</p>
            </div>
            <button type="button">查看全部</button>
          </div>
          <div className="activity-list">
            {activities.map(([title, desc, time], index) => (
              <div className="activity-item" key={title}>
                <span className={`activity-dot activity-dot--${index}`}>
                  <CheckCircle2 size={16} />
                </span>
                <div>
                  <strong>{title}</strong>
                  <p>{desc}</p>
                </div>
                <time>{time}</time>
              </div>
            ))}
          </div>
        </section>
        <section className="admin-panel quick-panel">
          <div className="panel-heading">
            <div>
              <h2>快捷操作</h2>
              <p>继续你的管理工作</p>
            </div>
          </div>
          <div className="quick-links">
            {quickActions.map(({ href, label, description, icon: Icon }) => (
              <Link href={href} key={href}>
                <Icon size={20} />
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
                <ArrowRight size={18} />
              </Link>
            ))}
          </div>
          <div className="system-status">
            <Clock3 size={18} />
            <span>
              <strong>系统运行正常</strong>
              <small>最后检查于 2 分钟前</small>
            </span>
            <i />
          </div>
        </section>
      </div>
    </div>
  );
}
