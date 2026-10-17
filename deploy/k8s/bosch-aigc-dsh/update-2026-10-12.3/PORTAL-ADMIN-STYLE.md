# AIGC 中台管理页面样式规范

适用范围：Portal 管理列表、筛选表单、分页、详情弹窗。新增页面及修复已有页面时均遵循本文；优先复用现有组件，不引入另一套设计系统。

## 基准和代码入口

- 全局样式与色彩：`portal/app/globals.css`。
- 列表、筛选、详情参考：`portal/app/admin/dsh-failures/` 和 `portal/app/admin/dsh-feedback/`。
- 分页统一使用 `portal/app/components/ant-pagination.tsx` 的 `AntPagination`。
- 普通弹窗使用 `portal/app/components/modal.tsx` 的 `Modal`；需要受限高度时传页面专属 className，避免修改所有弹窗的全局行为。

## 页面与控件

1. 外层用 `admin-page page-enter`；标题区用 `page-title`，包含 h1、描述及右侧操作，可选 `section-kicker`。
2. 筛选区用 `admin-panel`，内边距 20px、间距 16px，flex 换行、底部对齐。每个输入框和下拉框必须有可见 label 与可访问名称。
3. 筛选控件高度至少 38px，内边距 8px 10px，边框 `1px solid var(--line)`、圆角 6px；输入框和下拉框使用相同字体、前景、背景和焦点状态。
4. 主操作用 `primary-action`；刷新、重置、查看、关闭用 `secondary-action`。button 标明 type（在表单内尤其必要）。加载、禁用、错误均有可见反馈。
5. 颜色仅用已定义变量：`--ink`、`--muted`、`--line`、`--surface`、`--page`、`--blue-600`。不要使用未定义的 `--primary`、`--surface-soft`，不要在 JSX 中堆叠布局 style。

## 表格和分页

1. 容器用 `admin-panel table-panel`，顶部 `table-meta` 显示总数、排序；表格用 `data-grid`。不要自造没有 CSS 定义的 `admin-table`。
2. 横向滚动限制在表格包裹层，不能让整页横向溢出；列宽服务于数据，时间、操作列保持稳定，用户工号用 small 次级文本。
3. 长反馈列表最多展示三行摘要，保留换行、支持任意长词断行，完整内容在详情查看。不要把整段日志渲染到列表。
4. 加载状态用 `empty-state` + `role="status"`，空数据使用同类空态，错误用 `model-form-error` + `role="alert"`。请求失败时清除过期总数。
5. 分页放在同一 table-panel 底部，使用 `AntPagination`，准确传入 current、total、pageSize 和 onChange。筛选变化重置到第一页。

## 详情与滚动

1. 大详情弹窗宽度不超过 960px 和视口可用宽度，高度不超过 `calc(100dvh - 40px)`。
2. 外壳 flex column + overflow hidden；标题和底部操作区 flex none；正文 **flex: 1 1 auto、min-height: 0、overflow: auto**。不能只加 max-height，也不能被全局 `.modal { overflow: visible }` 覆盖。
3. 正文滚动区域提供 tabIndex=0 和可访问名称，支持键盘滚动；关闭按钮始终可见，Escape 保留关闭行为。
4. 元信息使用 dl/dt/dd，两列 minmax(0,1fr)，窄屏改单列。正文与日志使用 white-space: pre-wrap、overflow-wrap: anywhere，保留原始内容，不因样式截断详情。
5. 通常只保留一个正文纵向滚动区域，避免多层滚动抢占滚轮。日志使用等宽字体 12px，正文 13px，行高 1.6–1.75。

## 响应式和验收

- 600px 以下筛选项换为整行，详情内边距 16px，元信息单列；表格在自身容器横向滚动。
- 检查明暗主题的实际 CSS 变量作用域，不为单页硬编码白色背景。
- 至少检查普通数据、空数据、接口失败、分页及重置；详情覆盖 32K 文字、长无空格文本和大日志。
- 在桌面、低高度窗口和手机宽度下检查弹窗顶部、底部操作可见且正文可滚动。
- 单元测试不能证明真实布局；改动滚动或尺寸时补充浏览器实际渲染检查，并在交付中区分自动测试和实际视觉验证。

## 本次 DSH 品牌约定

产品显示名统一“弯崽工作伙伴”，包括侧栏、窗口、菜单、欢迎页和新安装包名称。新会话首页中央标题使用“今天有什么需要我来办的?”。保持应用 ID、包名、dsh 协议和用户数据根目录稳定；历史安装包作为已交付产物保留，不能原地改名冒充新构建。

Logo 使用用户提供的“弯崽形象_3D版.svg”。Web favicon、侧栏/首页/加载页、桌面欢迎页及原生图标必须来自同一图稿；原生 PNG 直接使用 SVG 内嵌 PNG，保持比例。安装器图片由 `apps/desktop/scripts/render-installer-brand.ps1` 生成，名称不能与 UI 名称分离维护。`/bhss-office-assistant.svg` 是既有资源地址，保留地址但替换其内容，避免破坏宿主白名单与缓存引用；旧包名匹配仅用于历史构建版本识别，不作为显示文案。
