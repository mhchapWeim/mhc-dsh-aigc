# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

企业内部管理员、模型管理员、发布审核人员和客户端运维人员。高频任务是查找记录、筛选状态、管理模型与权限、发布客户端版本、排查插件及客户端问题。

## Product Purpose

AIGC Hub 为企业智能应用提供管理入口，围绕组织权限、模型、发布流程和客户端运维完成管理工作。

## Operating Context

中文桌面浏览器为主要使用环境，同时保留窄屏、低高度窗口与键盘操作。存在明暗主题。内网环境不应依赖外部字体服务。

## Capabilities and Constraints

权限决定导航和操作可见性；API、分页、字段含义、导出能力和服务端业务逻辑保持原行为。本轮只改造管理后台公共视觉，继续复用现有组件和依赖，不替换整个组件库，不改动数据或统计，不部署生产。

## Brand Commitments

用户确认“企业蓝、清爽紧凑”，并指定 awesome-design-md 与 Impeccable 配合。具体视觉实现由 DESIGN.md 记录。

## Evidence on Hand

已有管理页面、路由、组件和样式规范：`app/admin/`、`app/components/`、`app/globals.css`、`../docs/PORTAL-ADMIN-STYLE.md`。实现入口是 `app/admin/admin-theme.css`。演示数据只用于本地视觉检查，不作为生产统计或部署验收证据。

## Product Principles

- 优先让管理员清楚找到并完成管理任务。
- 跨页面复用组件和交互习惯。
- 保留业务、权限和数据语义。
- 准确区分本地验证与生产运行证据。
