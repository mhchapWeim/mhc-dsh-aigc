---
description: "dsh Web 客户端的组织登录步骤：受管后端部署在模型可用之前展示的账号密码表单与 CAS 浏览器流程。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-managed-account

[English](README.md) | 中文

## 概述

在受管部署中使用 AIGC 或 SSO 认证，并通过“数据与迁移”管理账号云端备份或修复本地数据。可上传全部历史或选中会话，再在另一台电脑的本地目录中恢复。未登录时仍可修复本地数据；云端操作需要登录。恢复会创建新会话并保留已有历史。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

账号菜单中的“数据与迁移”在未登录时也能使用：先预览备份，再复制会话及可选工作区文件；也可导入旧会话目录、恢复迁移备份、重建缺失目录、清理已确认缺失的引用，以及继续已保存的迁移任务。操作由 [Workspace Controller](../../api/workspace-controller/README.zh.md#data-repair-and-copy-migration) 提供。工作区准备失败时保留已验证的组织身份，并显示修复提示。

通过 `@deepseek-ai/dsh-llm-managed-backend` 路由模型的部署，在用户拿到组织会话之前不提供任何模型。本包提供账号密码引导步骤，以及包含“AIGC认证”和“SSO认证”两个独立入口的账号菜单。AIGC认证打开用户名和密码表单；SSO认证直接启动平台的 CAS 浏览器流程。受管后端报告已登录用户后，引导步骤立即消失；没有挂载该后端的安装永远不会看到它。

会话选择支持对当前工作区中可读取、未归档的会话一键全选或取消全选。已完成的回执提供“同步迁移会话显示”，可补同步标题缓存并归档隐藏已复制的原会话，不重复复制历史。迁移完成后刷新会话列表。

数据弹窗优先显示当前账号的云端备份：上传全部历史或选中会话，浏览按时间排列的备份，下载恢复到本地目录，或删除备份。未登录时仍可展开本地修复工具。云端操作由 [Workspace Controller](../../api/workspace-controller/README.zh.md#data-repair-and-copy-migration) 提供；恢复后刷新会话列表，并保留本地重试回执。

该步骤通过 `settings.onboarding` 挂载，设置外壳将其作为有序的首次运行步骤展示。预置 Web 组合在配置 `DSH_MANAGED_BACKEND_URL` 时启用本插件。挂载后，该步骤向受管后端查询当前登录状态：

- **没有受管后端** —— 如果单独挂载插件但没有挂载适配器，步骤立即自行完成，不渲染任何内容。
- **已有存储的会话** —— 步骤自行完成；用户已经登录。
- **没有会话** —— 步骤保持所有权并展示登录卡片。

账号菜单在“设置”之外提供 **AIGC认证**和 **SSO认证**。AIGC 卡片提交已输入的用户名和密码，不包含 SSO 按钮。选择 SSO 会直接发起 CAS 尝试，在默认浏览器中打开平台验证页，并按 `intervalSeconds` 轮询，直到确认或五分钟超时。独立的等待卡片不包含账号密码字段；“取消”会关闭卡片并停止轮询，但不会在平台上结束该尝试。失败或超时后可重试。取消后迟到的轮询结果不会完成引导步骤。

关闭卡片即为跳过：步骤把所有权交给下一个引导条目，用户仍然没有会话。下次启动会再次询问。

### 失败文案

每种拒绝都只渲染一句话：凭据错误、CAS 尝试过期或失败、后端不可达各有自己的文案。文案区分「无法连接后端」与「后端拒绝了这组凭据」，因为两者需要用户采取不同动作。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节 —— 点击展开</summary>

浏览器侧通过 `@deepseek-ai/dsh-api-settings-controller` 发布的 `credentials` Remote 命名空间读写；它不持有也永远看不到令牌，因为每个受管方法只返回安全的 `ManagedAuthState` 投影。会话记录、设备绑定以及登录用户打开的工作区都由 Host 拥有。

卡片复用已发布账号登录弹窗的视觉语言——相同的卡片描边、头部几何、正文字号与 36px 操作行——因此同时提供两种界面的部署呈现为一个家族。它新增了凭据表单，而已发布弹窗并无此需求。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [llm-managed-backend](../../llm/llm-managed-backend/README.zh.md) —— 其存在与否决定本步骤是否有内容可问的适配器。
- [api-settings-controller](../../api/settings-controller/README.zh.md) —— 本步骤驱动的 `credentials` Remote 命名空间。
- [ui-settings](../../client/ui-settings/README.zh.md) —— 声明 `settings.onboarding` 的设置外壳。
- [ui-settings-account](../ui-settings-account/README.zh.md) —— 本卡片所对齐的已发布 DeepSeek 账号界面。

-----

<a id="model-experience"></a>
## 模型体验

间接相关：本步骤存储的会话正是 `@deepseek-ai/dsh-llm-managed-backend` 用于认证其目录与生成请求的凭据。步骤本身不访问模型，也不向提示词添加任何内容。

#### KV Cache effect

模型请求前缀不变。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 托管部署沿用 Desktop 原有的侧边栏账号入口位置，显示组织用户及登录或退出操作；该部署不再显示 DeepSeek 平台账号入口。
- **步骤拥有自己的整张卡片。** 设置外壳不为引导步骤绘制任何装饰，因此 CAS 等待态、凭据表单以及每一句失败文案都位于此处，而非共享弹窗文案中。

### 持久登录

临时网络故障保留此前已验证的身份，并提示连接异常。手动退出后，之前正在进行的身份查询不能覆盖退出状态。

### 开发备注

无。
