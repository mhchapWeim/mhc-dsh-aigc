# AIGC Agent Hub 中台 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个可运行、可交互的 AIGC 企业应用门户及管理后台前端原型。

**Architecture:** 在 `portal/` 中创建 React + TypeScript 单页应用，以路由划分门户和后台页面，以集中式模拟数据 Store 连接分类、应用、用户和流程状态。BPMN 编辑器采用 HTML/CSS 节点与 SVG 连线组合实现，保证拖动、选择、属性修改、撤销重做、缩放和校验可独立测试。

**Tech Stack:** React、TypeScript、Vite/Vinext Sites 模板、React Router、Lucide 图标、Vitest、Testing Library、CSS Design Tokens

**Spec:** `docs/superpowers/specs/2026-08-26-aigc-agent-hub-ui-design.md`

## Global Constraints

- 第一阶段只使用模拟数据，不连接真实后端接口。
- 保留 Bosch 红与企业蓝的品牌识别，采用现代企业级浅色中台风格。
- 门户、后台工作台、流程设计、用户管理和分类管理都必须支持直接路由访问。
- BPMN 原型不实现 BPMN 2.0 XML 导入导出或真实流程执行。
- 所有主要点击区域不小于 44px，支持键盘焦点和 `prefers-reduced-motion`。
- 必须验证 375px、768px、1024px 和 1440px 的布局行为。
- 当前目录不是 Git 仓库，因此计划中的 Git 提交步骤记录为“不执行”，除非用户之后明确要求初始化仓库。

---

## File Structure

- `portal/src/app/App.tsx`：应用路由、全局 Provider 与 Toast 容器。
- `portal/src/app/routes.tsx`：门户及后台路由表。
- `portal/src/data/mockData.ts`：应用、分类、用户及 BPMN 示例数据。
- `portal/src/store/PlatformStore.tsx`：模拟数据操作、收藏、主题和 Toast 状态。
- `portal/src/types/platform.ts`：跨模块共享的数据类型。
- `portal/src/components/`：按钮、弹窗、表格状态、应用卡片等复用组件。
- `portal/src/pages/PortalPage.tsx`：门户首页。
- `portal/src/pages/admin/AdminLayout.tsx`：后台导航框架。
- `portal/src/pages/admin/DashboardPage.tsx`：后台工作台。
- `portal/src/pages/admin/ProcessDesignerPage.tsx`：BPMN 编辑器页面。
- `portal/src/pages/admin/UserManagementPage.tsx`：用户管理。
- `portal/src/pages/admin/CategoryManagementPage.tsx`：分类管理。
- `portal/src/styles/`：设计 Token、布局、组件与响应式样式。
- `portal/src/**/*.test.tsx`：行为测试。

---

### Task 1: 项目骨架、设计系统与测试基线

**Files:**
- Create: `portal/` Sites React 项目骨架
- Modify: `portal/package.json`
- Modify: `portal/src/app/App.tsx`
- Create: `portal/src/styles/tokens.css`
- Create: `portal/src/styles/global.css`
- Test: `portal/src/app/App.test.tsx`

**Interfaces:**
- Produces: `App` 根组件、测试命令、全局语义颜色与动效 Token。

- [ ] **Step 1: 创建失败的应用烟雾测试**

```tsx
render(<App />)
expect(screen.getByRole('heading', { name: /AIGC Agent Hub/i })).toBeInTheDocument()
```

- [ ] **Step 2: 运行 `npm test -- --run`，确认测试因根组件内容缺失而失败。**
- [ ] **Step 3: 完成 Sites 项目配置、应用入口和 Token，根页面显示平台标题及可访问的主内容区域。**
- [ ] **Step 4: 运行 `npm test -- --run`，确认烟雾测试通过。**
- [ ] **Step 5: 当前非 Git 仓库，不执行提交。**

### Task 2: 模拟数据、全局状态与路由

**Files:**
- Create: `portal/src/types/platform.ts`
- Create: `portal/src/data/mockData.ts`
- Create: `portal/src/store/PlatformStore.tsx`
- Create: `portal/src/app/routes.tsx`
- Test: `portal/src/store/PlatformStore.test.tsx`

**Interfaces:**
- Produces: `usePlatform(): PlatformContextValue`，包含 `apps`、`categories`、`users`、`favoriteIds`、`toggleFavorite`、`saveUser`、`toggleUserStatus`、`saveCategory`、`toggleCategoryStatus`、`deleteCategory` 和 `notify`。
- Produces: `/`、`/admin`、`/admin/processes`、`/admin/users`、`/admin/categories` 路由。

- [ ] **Step 1: 编写收藏切换和分类变更同步到应用筛选数据的测试。**
- [ ] **Step 2: 运行 Store 测试，确认 Provider 与操作函数尚不存在。**
- [ ] **Step 3: 定义严格 TypeScript 类型、真实中文模拟数据和不可变更新函数；收藏写入 localStorage。**
- [ ] **Step 4: 实现路由并运行测试，确认 Store 行为与直接路由通过。**
- [ ] **Step 5: 当前非 Git 仓库，不执行提交。**

### Task 3: 门户首页与导航卡片动效

**Files:**
- Create: `portal/src/pages/PortalPage.tsx`
- Create: `portal/src/components/TopNav.tsx`
- Create: `portal/src/components/AppCard.tsx`
- Create: `portal/src/components/ToastRegion.tsx`
- Create: `portal/src/styles/portal.css`
- Test: `portal/src/pages/PortalPage.test.tsx`

**Interfaces:**
- Consumes: `usePlatform()` 的应用、分类、收藏与通知接口。
- Produces: 可搜索、分类筛选、排序、收藏并模拟跳转的门户界面。

- [ ] **Step 1: 编写按名称搜索、切换分类、收藏过滤和打开用户菜单进入后台的测试。**
- [ ] **Step 2: 运行门户测试，确认页面组件缺失。**
- [ ] **Step 3: 实现紧凑欢迎区、统计卡、最近使用、分类胶囊、排序控件和响应式应用网格。**
- [ ] **Step 4: 实现卡片错峰入场、悬浮抬升、光带、图标缩放、箭头位移、按压状态和进入系统 Toast；为减少动态效果提供替代样式。**
- [ ] **Step 5: 运行门户测试与完整测试集，确认搜索、收藏和导航行为通过。**
- [ ] **Step 6: 当前非 Git 仓库，不执行提交。**

### Task 4: 后台框架与工作台

**Files:**
- Create: `portal/src/pages/admin/AdminLayout.tsx`
- Create: `portal/src/pages/admin/DashboardPage.tsx`
- Create: `portal/src/styles/admin.css`
- Test: `portal/src/pages/admin/AdminLayout.test.tsx`

**Interfaces:**
- Produces: 带可折叠侧栏、顶部栏、面包屑、返回门户入口和 `<Outlet />` 的后台外壳。

- [ ] **Step 1: 编写后台菜单选中状态、返回门户和窄屏侧栏开关测试。**
- [ ] **Step 2: 运行测试并确认后台布局缺失。**
- [ ] **Step 3: 实现后台外壳与工作台统计、快捷入口、平台动态和系统状态。**
- [ ] **Step 4: 运行后台布局测试及完整测试集。**
- [ ] **Step 5: 当前非 Git 仓库，不执行提交。**

### Task 5: BPMN 流程设计器

**Files:**
- Create: `portal/src/features/process/processTypes.ts`
- Create: `portal/src/features/process/processHistory.ts`
- Create: `portal/src/features/process/BpmnCanvas.tsx`
- Create: `portal/src/features/process/NodePalette.tsx`
- Create: `portal/src/features/process/PropertiesPanel.tsx`
- Create: `portal/src/pages/admin/ProcessDesignerPage.tsx`
- Create: `portal/src/styles/process.css`
- Test: `portal/src/features/process/processHistory.test.ts`
- Test: `portal/src/pages/admin/ProcessDesignerPage.test.tsx`

**Interfaces:**
- Produces: `ProcessNode`、`ProcessEdge`、`ProcessDefinition` 类型。
- Produces: `createHistory(initial)`，包含 `commit`、`undo`、`redo` 和可观察的 `present`。
- Produces: BPMN 节点新增、拖动、选择、属性编辑、删除、连线展示、缩放、适应画布、校验、保存与发布交互。

- [ ] **Step 1: 编写历史栈撤销重做测试及流程校验测试，覆盖缺少开始/结束事件和未命名节点。**
- [ ] **Step 2: 运行测试，确认历史栈和校验器缺失。**
- [ ] **Step 3: 实现纯函数历史栈、流程校验器和示例“内容审核发布流程”。**
- [ ] **Step 4: 运行纯函数测试，确认通过。**
- [ ] **Step 5: 编写页面测试，验证点击工具新增节点、选择节点后修改名称、撤销和发布反馈。**
- [ ] **Step 6: 实现左侧 BPMN 工具箱、SVG 连线、可拖动节点、右侧属性面板和顶部操作栏。所有拖动只更新 transform/坐标状态，不触发布局抖动。**
- [ ] **Step 7: 运行 BPMN 页面测试与完整测试集。**
- [ ] **Step 8: 当前非 Git 仓库，不执行提交。**

### Task 6: 用户管理

**Files:**
- Create: `portal/src/components/Modal.tsx`
- Create: `portal/src/pages/admin/UserManagementPage.tsx`
- Create: `portal/src/styles/table.css`
- Test: `portal/src/pages/admin/UserManagementPage.test.tsx`

**Interfaces:**
- Consumes: `saveUser(user)` 与 `toggleUserStatus(userId)`。
- Produces: 用户搜索、部门/状态筛选、新增、编辑、启停、分页和确认弹窗。

- [ ] **Step 1: 编写搜索用户、新增用户、编辑角色及停用确认测试。**
- [ ] **Step 2: 运行测试并确认用户管理页面缺失。**
- [ ] **Step 3: 实现语义化表格、筛选器、分页、表单弹窗、字段校验和启停确认。**
- [ ] **Step 4: 运行用户管理测试与完整测试集。**
- [ ] **Step 5: 当前非 Git 仓库，不执行提交。**

### Task 7: 分类管理与门户联动

**Files:**
- Create: `portal/src/pages/admin/CategoryManagementPage.tsx`
- Test: `portal/src/pages/admin/CategoryManagementPage.test.tsx`
- Modify: `portal/src/pages/PortalPage.tsx`

**Interfaces:**
- Consumes: `saveCategory`、`toggleCategoryStatus`、`deleteCategory`。
- Produces: 分类新增、编辑、启停、上下排序、删除限制和门户分类即时联动。

- [ ] **Step 1: 编写新增分类、调整排序、有关联应用时拒绝删除、空分类成功删除的测试。**
- [ ] **Step 2: 运行测试并确认分类操作页面缺失。**
- [ ] **Step 3: 实现分类卡片/表格、编辑弹窗、排序按钮、状态操作和删除原因提示。**
- [ ] **Step 4: 运行分类测试、门户联动测试和完整测试集。**
- [ ] **Step 5: 当前非 Git 仓库，不执行提交。**

### Task 8: 最终响应式、可访问性与构建验证

**Files:**
- Modify: `portal/src/styles/global.css`
- Modify: `portal/src/styles/portal.css`
- Modify: `portal/src/styles/admin.css`
- Modify: `portal/src/styles/process.css`
- Modify: `portal/src/styles/table.css`
- Modify: `portal/src/app/App.test.tsx`

**Interfaces:**
- Consumes: 所有已实现页面。
- Produces: 可构建、可测试、适配四个目标宽度并支持减少动态效果的最终原型。

- [ ] **Step 1: 增加路由烟雾测试，逐一渲染门户和四个后台路由且无运行错误。**
- [ ] **Step 2: 运行完整测试集，修复真实失败。**
- [ ] **Step 3: 运行生产构建，修复 TypeScript、打包和样式错误后重新构建。**
- [ ] **Step 4: 启动开发服务并验证门户及各后台路径返回成功响应。**
- [ ] **Step 5: 在 375px、768px、1024px 和 1440px 检查导航、卡片、表格、BPMN 画布及弹窗；检查键盘焦点与减少动态效果。**
- [ ] **Step 6: 运行 UI/UX 动画与可访问性规则检查，修复阻塞问题。**
- [ ] **Step 7: 当前非 Git 仓库，不执行提交，并记录最终运行命令。**
