# AIGC 虚拟 Key 配置与单组授权

源码修改分支：`main`（用户确认的生产分支）。本文不表示已部署。

## 管理方式

在“虚拟 Key 管理”中创建 Key 时配置模型范围、预算上限（美元）、预算重置周期、有效期、RPM 与 TPM；已有 Key 通过“套餐规则”编辑。配置直接提交 LiteLLM，编辑时实时读取网关，不另存一份本地套餐配置，因此无需为本功能新增数据库字段。

指定模型必须至少选择一个；“全部可用模型”需要明确选择，包含后续新增模型，仍受网关与团队权限限制。选择 Key 模型不代替 AIGC 的模型发布/用户授权。

预算 0 保持为 0，不会误当作无限额；空预算/RPM/TPM 表示清除该 Key 级限制，网关/团队上层限制仍然适用。周期支持正整数与 s/m/h/d/w/mo，兼容 hourly/daily/weekly/monthly。预算窗口与重置时区由 LiteLLM 决定，30d 不应解释为由 AIGC 实现的滚动窗口。

编辑有效期默认“保持当前到期时间”；设置新时长会从保存时起续期，“永久有效”明确清除到期时间。只改 RPM/TPM 不会发送未修改的 `budget_duration` 或 `duration`，也不修改 spend、metadata、团队等其他设置。

请求失败保留表单并显示错误，不提示同步成功。若发生网络超时或网关写入成功但回读失败，应重新打开“套餐规则”读取实际状态后再操作。创建后 AIGC 保存失败时，也应先检查 LiteLLM 是否已有同名 Key，避免盲目重复创建。

## 服务端接口

所有接口沿用 `model.manage` 权限。

| AIGC 接口 | 行为 |
|---|---|
| `GET /api/virtual-keys/model-options` | 使用服务端管理密钥读取 LiteLLM `/v1/models`，只返回模型标识 |
| `POST /api/virtual-keys` | 可附带 `policy`；与创建 Key 一次提交到 `/key/generate`，兼容旧请求省略 policy |
| `GET /api/virtual-keys/{id}/policy` | 读取 `/key/info`，返回模型、预算、周期、RPM/TPM、到期时间的白名单字段 |
| `PUT /api/virtual-keys/{id}/policy` | 仅将变化字段发送 `/key/update`，审计成功变更并回读有效配置 |
| `GET /api/virtual-keys/grant-options?keyId={id}` | 返回用户、角色、部门的 disabled/disabledReason，以及用户的所属 Key 及授权来源 |

管理密钥不下发。`/key/info` 的查询参数使用 Key 的 SHA-256，不在 URL 中放明文 Key。创建响应、配置回读和审计记录都不包含明文 Key 或 Key token/hash。

实现核对了 [LiteLLM 虚拟 Key 文档](https://docs.litellm.ai/docs/proxy/virtual_keys)、[v1.101.0 Key 管理实现](https://github.com/BerriAI/litellm/blob/v1.101.0/litellm/proxy/management_endpoints/key_management_endpoints.py) 和 [周期解析实现](https://github.com/BerriAI/litellm/blob/v1.101.0/litellm/litellm_core_utils/duration_parser.py)。实际环境应验证版本和接口权限。

## 单组归属

以虚拟 Key 为授权组，计算直接用户、部门、角色和旧自定义分组产生的有效成员。一个用户可以通过多种来源命中同一个 Key，但不能命中不同 Key。停用 Key 仍保留成员占用，避免重新启用后产生冲突；转组须先从原 Key 移除相应授权。

其他组已占用用户显示不可选和所属组名/来源；部门或角色包含其他组成员时也不可选。“选择本页”和“全选”只加入可选项。已有冲突选项仍允许移除，便于清理历史重叠；服务端在保存时重新检查，不依赖页面禁选。

Key 授权、重新启用、旧分组成员修改、用户部门/角色修改、普通接口/聊天工具创建用户，均参与同一授权写入互斥。生产 PostgreSQL 使用事务级 advisory lock（736421009）跨实例串行化；InMemory 测试使用进程内互斥。旧自定义分组本身也拒绝将一个用户加入多个分组。原有 DSH 多 Key 拒绝逻辑继续保留，作为直接改库等外部变更的兜底。

不自动修改历史授权。发布前可执行只读脚本 `deploy/sql/20261020-virtual-key-membership-preview.sql` 检查现有重叠，再由管理员解除原授权并重新分配；本功能不会静默迁移成员或删除数据。

## 发布与验证

本次虚拟 Key 功能只需更新 AIGC API 和 Portal，不新增 DSH 插件。工作区另有图片理解改动及其独立 SQL，不能将两项变更混为同一数据库迁移。

本地自动测试模拟 LiteLLM，验证了字段映射、零预算、清除限额、有效期/预算窗口保持、加密与脱敏、失败路径、各类授权冲突、并发保存、用户角色变更防绕过及界面选择行为。本地浏览器使用实际页面组件和模拟 API 验证桌面、390×640 手机宽度与 1024×480 低高度 iframe 中的滚动和固定操作区。

尚未连接生产 LiteLLM 验证配置写入和真实额度/速率拦截；未在真实 PostgreSQL 多实例部署中实测 advisory lock，未部署或改动生产授权。

2026-10-20 本地结果：服务端完整测试 129/129；Portal 25 个测试文件、125/125；Portal TypeScript 检查与生产构建通过，产物为 `portal/dist/standalone/`。全量前端回归发现两个密码登录测试仍指向 SSO 入口，已仅将这两个测试的渲染对象改为现有 `/login/local` 页面，登录业务代码未改动。

截图与构建/测试日志位于 `.verification/virtual-key-preview/`、`.verification/virtual-key-portal-build.log`、`.verification/virtual-key-portal-tests.log`。浏览器测试使用模拟 Key 和用户数据，不是生产截图。
