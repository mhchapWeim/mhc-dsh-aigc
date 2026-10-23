---
description: "Host 与 Client 工作区控制：修改工作区导航并跟随其完整投影。"
kind: "package-reference"
---
# Workspace Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-workspace-controller` 拥有 Host 的 `ctx.workspaceController` 服务和生成的 Client `ctx.remote.workspace` namespace。它的 Remote 方法负责创建、重命名、移除和重排 Workspace，在 Workspace 内重排 Session，归档与取消归档 Session，以及跟随完整的 Workspace 投影。当 Client 必须修改或跟随 Workspace 导航时，请通过 API 网关使用它。本包同时拥有 `ctx.directoryPickerController` 与生成的 `ctx.remote.directoryPicker` namespace，因为它承载的选目录 seam 是抽象的，自身从不作为 Loader entry。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

<a id="data-repair-and-copy-migration"></a>
### 数据修复与复制迁移

云端备份方法要求登录受管后端。`uploadCloudBackup()` 导出全部已保存会话（含归档）或明确指定的 `sessionIds`，拒绝运行中或不可读的会话。每个会话和二进制附件分别写文件后压缩，容量与分片由 AIGC 返回（默认 1 GiB / 8 MiB）。AIGC 逐请求鉴权并将归档正文存入 MinIO，Host 只连接 AIGC。本地固定快照与服务器分片记录支持重启续传。`cloudBackupProgress()` 与 `pauseCloudBackup()` 提供进度和暂停，再次上传同一范围可续传。`cloudBackupSessions(id)` 列出会话名称；`restoreCloudBackup({ id, targetPath, sessionIds? })` 按 Range 下载，校验归档和文件，恢复全部或勾选会话的副本。持久化恢复回执避免重试重复复制。已有会话和消息中的路径保持不变。旧 JSON 快照仍可读取，维持其 24 MiB 限制。备份是手动快照，不是自动同步。

`dataStatus()` 检查目录和会话引用，并列出已保存的迁移回执。未登录时也能执行本地数据操作。`repairDirectory()` 只重建缺失目录，不会恢复已删除文件。`forgetMissingSessions()` 仅在持久化服务确认文件不存在时移除引用；无法读取的文件和活动会话都会保留。

`previewMigration()` 将所选历史保存到 `$DSH_HOME/migrations/<id>/sessions.json`，并生成校验值与回执。可选择已登记工作区、单个会话、旧 JSONL 会话存储根目录或本功能生成的备份目录。可选工作区文件按 SHA-256 校验备份，保留空目录。历史格式转换仅操作原会话目录的副本。运行中的会话会跳过并明确报告。

`commitMigration({ migrationId })` 复制文件时拒绝覆盖冲突，为会话生成新 id 和目标 cwd，校验日志后登记到目标工作区。原日志、原目录、凭据和插件保持不变。复制成功的原会话会归档，不再显示于默认列表；失败的原会话仍然显示。目标会话登记前先持久化标题投影。再次提交已完成回执只同步标题与原会话归档，不重复复制。重试沿用相同目标 id，部分失败保留在回执中；缺失或损坏的源会话逐项报告。消息中的旧绝对路径会保留，会话目录备份不包含外部附件存储；跨电脑导入时需单独恢复这些附件。迁移不调用模型，后续请求使用迁移后的历史。

Host 控制器会串行执行正确性取决于当前注册表状态的变更，并为预期失败抛出带有稳定错误码的 `RemoteError`。它的 `follow()` 流会同步订阅持久 Workspace 变更，先发出一份完整 baseline，再按顺序发出 `upsert`、`remove`、`order`、`archived` 和 `pinned` 增量。归档与置顶集合都是会话 id 数组，置顶数组把最近置顶的 id 放在前面。重连会以替换 baseline 开始新一代，因此消费方不依赖收到断线期间的每个增量。不带 `stopActivity` 的 `archiveSession` 会以 `workspace/session-active` 拒绝仍有工作在跑的会话，其 details 按族（`turn`、`subagent`、`job`、`schedule`）列出这些工作及各项的 id 与名称；带 `stopActivity: true` 时注册表的提供方先停止这些工作，归档集合持久化后即返回响应，停止在后台收敛。

Client 入口提供 `ClientWorkspaceModel` 和 `createWorkspaceStateStream()`。该模型拥有 Workspace 行、registry 顺序、归档与置顶会话身份、一元变更回显，以及流与一元调用的竞态处理。较新的 Host 行按 `updatedAt` 获胜；已提交的流顺序优先于较旧的一元响应；已经移除的 Workspace id 不会被延迟数据复活。置顶快照仅在会话身份或顺序变化时更新。该包公开与框架无关的快照和订阅，把导航策略与 React 钩子留给 UI owner。`WorkspaceController.archiveSession(sessionId, { stopActivity })` 抛出携带 Host `rpcError` 的 `WorkspaceArchiveError`，界面因此能区分"仍有工作在跑"的拒绝与会话缺失或载体故障，并提议停止这些工作。

<a id="first-use-workspace"></a>
### 首次使用工作区

`workspace.initializeDefault({ directoryName, title })` 返回持久化的默认工作区；Client service 通过 `workspaces.initializeDefault(request, signal?)` 提供同一请求。[Workspace Client](../../client/ui-workspace/README.zh.md)按启动时的语言解析这些名称。Host 将目录放在其账户的 `<Documents>/deepseek-harness` 下，远程 Web Host 也遵循此规则。目录名必须是非空的单个片段，不能含分隔符、冒号、NUL、首尾空白或末尾句点；标题不能为空。操作系统的文件名限制同样适用。Linux 系统查询要求存在 `xdg-user-dir` 且启用了 Documents 目录；不具备该条件的 Host 必须配置 `documentsDirectory` 或使用文件夹选择器。

[Workspace 注册表](../../workspace/workspace/README.zh.md#first-use-workspace)负责资格判断、目录创建和持久化初始化。已有默认工作区直接返回，不再查询 Documents；请求中的名称不会将其重命名。不满足首次使用条件时返回 `undefined`，启动流程可将目录选择留给用户。名称无效时以 `gateway/bad-request` 拒绝；查询和创建失败遵循标准 Remote 错误处理。初始化不创建 Session，也不发送消息。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `defaultDirectory` | 未设置 | 默认工作区的完整目录，设置后不查询系统文档目录 |
| `documentsDirectory` | 系统 Documents 目录 | 完全限定的 Host 目录覆盖值 |
| `documentsLookupTimeoutMs` | `10000` | 操作系统目录查询的正数最大时长，单位为毫秒 |
| `cloudRequestTimeoutMs` | `120000` | 单次云端备份 HTTP 请求的正数最大时长，单位为毫秒 |

Documents 查询占用注册表变更队列，因此其他 Workspace 变更（包括登记已选目录）最多可能等待 `documentsLookupTimeoutMs`。取消可以停止查询；解析成功后，取消不会回滚创建或登记。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 Workspace 组织属于浏览器和 Host 的控制状态，并且不注册提示词、工具或会话事件。

#### KV Cache 影响

无直接影响；Workspace 变更不会改变模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `follow()` 在重连后替换完整投影，不提供持久 cursor 或增量追赶协议。
- 进程内删除标记只会在 Client 模型生命周期内阻止延迟数据复活已移除的 Workspace。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。Workspace 注册表负责持久化，每次流生成都是完整投影。
