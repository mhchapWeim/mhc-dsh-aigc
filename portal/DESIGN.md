---
name: AIGC Hub Admin
description: 企业蓝、清爽紧凑的管理后台；面向高频运维任务。
colors:
  primary: "#225dcc"
  primary-hover: "#174ea6"
  on-primary: "#ffffff"
  selection: "#e8effc"
  ink: "#1d2939"
  ink-soft: "#475467"
  muted: "#667085"
  surface: "#ffffff"
  page: "#f6f8fb"
  line: "#e2e7ef"
  chrome: "#fafbfd"
  hover: "#f0f3f8"
  dark-primary: "#91baff"
  dark-selection: "#243c60"
  dark-ink: "#edf2fa"
  dark-ink-soft: "#c0cbdc"
  dark-muted: "#9aaac0"
  dark-surface: "#162235"
  dark-page: "#101a29"
  dark-line: "#2d3c51"
  dark-chrome: "#142032"
  dark-hover: "#203149"
typography:
  title:
    fontFamily: "Segoe UI, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "24px"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Segoe UI, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "14px"
    lineHeight: 1.5
  data:
    fontSize: "13px"
  label:
    fontSize: "12px"
    fontWeight: 600
  control:
    fontSize: "13px"
  mobile-control:
    fontSize: "16px"
rounded:
  control: "6px"
  panel: "8px"
  modal: "10px"
spacing:
  inline: "12px"
  group: "14px"
  toolbar-block: "16px"
  panel: "20px"
  page: "28px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "38px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "38px"
  navigation-active:
    backgroundColor: "{colors.selection}"
    textColor: "{colors.primary-hover}"
    rounded: "{rounded.control}"
    height: "36px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
  modal:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.modal}"
---

# Design System: AIGC Hub Admin

## Overview

**Creative North Star: "企业蓝、清爽紧凑"**

管理后台采用 Operate 模式：管理员在熟悉的框架中完成任务，设计以可读性、数据密度、键盘导航和明确反馈服务查找、筛选与维护。品牌蓝集中在主操作、当前选中和焦点；内容面通过浅色背景与细线形成秩序。

用户已确认这一方向，并要求 awesome-design-md 与 Impeccable 配合。参考 [awesome-design-md 的 SAP 分析](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/sap/DESIGN.md) 的浅色应用框架和平面分层，不复制其营销页尺度或品牌字体；采用 [Impeccable](https://github.com/pbakaus/impeccable) 的 Operate、craft-floor 和 polish 方法。读取的 Impeccable 源码版本为 `3671d50f0ac9a662ce0615e85a256110c9cd720b`。

**Key Characteristics:**
- 单一企业蓝强调，导航与内容使用中性层次。
- 紧凑字阶与一致的表格、筛选和按钮语言。
- 浅色和深色成对维护，保留现有权限与业务行为。
- 内网本机字体，减少装饰和页面入场动画。

实现入口为 `app/admin/admin-theme.css`，由 `app/admin/layout.tsx` 加载。作用域限定于 `.admin-app`；应用门户、登录、聊天和桌面端不属于本轮视觉改造范围。既有约束继续见 [管理页面样式规范](../docs/PORTAL-ADMIN-STYLE.md)。前言记录真实样式值；这是人工整理的实现规范，不代表 Impeccable CLI 或 Stitch linter 已验证。

## Colors

### Primary
企业蓝承担主操作和交互定位。深色主题中链接及焦点使用较亮的 `dark-primary`，主按钮仍保留 `primary` 填充与白字，避免浅蓝填充导致白字失去对比。

**The Accent Rule.** 强调色用于当前选择、主要操作和焦点；不把所有普通导航、面板或表格装饰成强调色。

### Neutral
`ink` / `ink-soft` / `muted` 分别承担主正文、次正文和辅助信息。`surface` 是内容面，`page` 是工作区，`chrome` 是表头与工具区域的轻分层，`line` 是边界。深色值以 `dark-` 前缀成对记录。实现中这些颜色映射到既有 CSS 变量，沿用页面专属语义状态色。

## Typography

本机 Segoe UI / 微软雅黑 / 苹方适合内网离线环境，不加载远程字体。基础正文对应 `body`，表格正文与控件对应 `data` / `control`，辅助文字和表头对应 `label`；标题使用克制的固定字阶。数字使用 tabular-nums。

手机宽度下页面标题缩小至 22px，表单控件使用 `mobile-control`，主次按钮文字保持原有紧凑尺寸。模型列表仍保留原有双行信息和 80px 行高。

**The Heading Rule.** 标题直接承担层级；现有重复英文眉题在后台隐藏，不追加新的装饰性 kicker。

## Layout

桌面侧栏宽 232px，折叠宽 68px；顶栏高 60px，内容最大宽度 1720px。内容边距使用 `page`，900px 以下为 20px，600px 以下为上下 20px、左右 14px。保留原有移动导航抽屉断点；760px 以下顶栏预留汉堡按钮位置。

标题与右侧操作在窄屏上下排列；筛选工具条换行。宽表格仅在 `.table-wrap`、`.data-grid-wrap`、`.plugin-table-scroll` 等既有包裹层横向滚动，不重置专属列宽。分页在窄屏换行。

## Elevation & Depth

侧栏、顶栏、统计卡和普通面板采用平面分层，无重阴影或装饰性模糊。折叠菜单浮层保留柔和偏移阴影，表达其覆盖关系。弹窗继续保留现有遮罩和专属滚动结构，不统一覆盖正文高度行为。

页面切换不做装饰性位移动画；按钮状态过渡为 150ms。`prefers-reduced-motion` 下关闭后台过渡及动画。

## Shapes

控件、面板和弹窗分别使用前言中的 `control`、`panel`、`modal` 圆角。图标来自已有 Lucide 图标库。状态标签保留原有语义与形状，不因本轮改造改变含义。

## Components

复用 `data-grid`、`AntPagination`、`Modal`、`primary-action` 和 `secondary-action`。前言中的 button height 表示 CSS 的最小高度；桌面至少 38px，600px 以下主次按钮至少 44px。次要操作使用描边与内容面底色，主操作使用企业蓝实底。

焦点为 2px 蓝色外描边，偏移 3px；输入光标跟随强调色。禁用按钮降低不透明度并显示不可操作光标。选中导航继续保留文字与 `aria-current`，状态不只靠颜色表达。页面已有加载、空态、错误反馈与按钮行为保持。

详情弹窗复用已有结构：标题、关闭和底部操作保持可达，长内容在正文中滚动。不能通过公共主题破坏页面专属的视口高度约束。

## Do's and Don'ts

### Do
- 先读取本规范与管理页面样式规范，再修改管理页面。
- 使用已有组件与主题变量，同步检查浅色、深色、窄屏和键盘焦点。
- 保留原有搜索、分页、授权、导出、API 与字段含义。
- 把实际构建、测试、浏览器验证与生产部署证据分开记录。

### Don't
- 不复制参考网站的品牌字体、营销页大字号或宽大留白。
- 不为每一页引入一套按钮、表格或弹窗样式。
- 不用渐变、光晕、重阴影或页面入场动画替代信息层级。
- 不修改数据或伪造统计来展示视觉效果。
