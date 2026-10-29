# AIGC 与 DSH MCP 市场

日期：2026-10-27。状态：源码已实现并完成本地聚焦验证；不代表已部署生产或发布客户端安装包。

## 使用规则

AIGC 统一登记远程 MCP 服务、上传图标并按用户、角色、部门授权。DSH 登录后自动连接获授权且已发布的服务；有服务时显示“连接器”，无服务时隐藏入口。客户端没有添加、安装、启用或停用按钮，卡片只提供搜索、说明展开和连接状态。

管理员使用 `/admin/mcp`，独立管理权限为 `mcp.manage`。使用授权资源为 `mcp:{id}`，用户、角色、部门任一命中即可，空授权表示无人可用。服务发布开关是组织级开关，不是客户端个人开关。

## 管理流程

1. 添加名称、简介、远程 Streamable HTTP 地址、调用超时和可选 Bearer Token。
2. 上传 PNG、JPEG 或 WebP 图标，最大 512000 字节；服务端验证文件签名，图片作为展示数据保存，不执行 SVG。
3. 设置用户、角色或部门授权并发布。首次创建默认停用且没有授权。
4. 测试连接只发现工具，不调用任何业务工具；当前快捷测试使用 MCP 2026-07-28 的无会话 tools/list 请求，较旧服务器可能需要单独验证协商兼容性。
5. 用户登录 DSH 后自动同步并使用。修改或撤销授权后网关下一次请求立即重新检查，客户端按策略轮询移除工具。

## 调用与身份

DSH → AIGC MCP 网关 → 目标 MCP 服务 → 业务系统。

用户策略接口为 `GET /v1/mcp/policy`，只返回当前用户获授权条目的名称、简介、图片、修订号、超时和网关相对路径，不返回上游 URL 或密钥。网关为 `/v1/mcp/{id}/gateway`，按请求验证 DSH 身份和授权，转发 MCP JSON-RPC 与 SSE；禁止自动重定向和共享 Cookie。

上游 Bearer Token 使用 ASP.NET Data Protection 加密保存，轮换在中台完成。DSH 按请求获取当前登录 Token，身份变化时旧连接不能继续发出请求。旧协议会话 ID 经加密封装并绑定用户、服务、策略修订号与有效期，不能跨账号或修改策略后复用。

DSH 使用现有 MCP SDK 2.0 的连接监督、工具发现、分页、结果适配、工具调用和重连。默认沿用组织同步间隔 60 秒及请求上限 30 秒；连接状态每 2 秒刷新到 Host，浏览器通过事件和 5 秒快照恢复。已连接表示连接与工具发现完成，不代表某项业务调用已经成功。

## 数据与代码

- `server/AigcHub.Api/Domain/ManagedMcpService.cs`：独立 MCP 实体。
- `server/AigcHub.Api/Endpoints/McpMarketEndpoints.cs`：管理、图标、策略、工具测试、会话隔离及网关。
- `server/AigcHub.Api/Data/DatabaseSchemaInitializer.cs`：新增表的幂等 DDL，保留既有表。
- `portal/app/admin/mcp/`：管理页面；复用 Modal、分页和 GrantSelector。
- `deepseek-harness/packages/boot/plugin-manager/src/managed-mcp.ts`：独立同步控制器；复用登录及 Remote 服务载体，不经过插件包安装流程。
- `deepseek-harness/packages/client/ui-managed-account/src/client/connectors.tsx`：授权可见性与状态同步。
- `deepseek-harness/packages/client/ui-managed-account/src/client/ConnectorCards.tsx`：展示卡片。

数据库结构更新按现有应用启动流程执行。上线前应在测试数据库验证并按运行手册交付；本次未执行生产数据库变更。Data Protection 密钥持久化与多副本共享仍遵循现有部署配置。

## 当前范围

支持管理员统一配置无认证或固定 Bearer Token 的远程 MCP，也支持可信目标通过 AIGC 短期员工身份断言进行无感 Token Exchange。后者由 DSH 直连目标 MCP，短期 Token 仅在当前 Host 生命周期内缓存，过期自动重新兑换；完整接口合同见 [KnowEngine MCP 无感身份交换改造说明](KNOWENGINE-MCP-TOKEN-EXCHANGE.md)，KnowEngine 服务端实施细节见 [KnowEngine 服务端同步改造指南](KNOWENGINE-SERVER-CHANGES.md)。个人第三方 OAuth、本地 stdio 软件分发、工具级授权、MCP prompts 和客户端自由填写连接地址不在本期范围。

中台授权只控制谁能使用连接器；目标服务仍须实现业务数据权限。使用共享服务账号时，不能自动获得每名员工各自的邮箱或文档权限。

## 本地验收

HTTP 集成测试覆盖空授权、发布授权、图标、发现工具、实际网关请求、撤权、管理权限、会话用户及修订隔离、SSE 工具发现。DSH 真实 Loader 配置与真实 MCP SDK 测试覆盖自动注册、工具执行、撤权、账号切换和登出清理；界面测试覆盖搜索、详情及侧栏条件显示。

视觉检查使用实际组件与模拟数据，覆盖明暗主题、1440×900 和 390×740，添加弹窗正文可滚动且底部操作可见。此证据不等同于已安装客户端或生产业务系统验收。

## WorkBuddy 续接

任务 ID 为 `mcp-market-connectors`，正式状态保存于 `.agent-handoff/tasks/mcp-market-connectors/state.json`。派生的 HANDOFF.md 和 WORKBUDDY_PROMPT.md 由 handoff.py checkpoint 生成，后续只更新状态后重新生成。
