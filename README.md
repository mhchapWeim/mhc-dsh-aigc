# BHSS AIGC Agent Hub

项目包含交互式前端门户 `portal/` 和 ASP.NET Core 9 后端 `server/AigcHub.Api/`。后端使用 PostgreSQL，包含 JWT 登录、动态角色权限、组织与分类管理、应用发布流程、待办任务、站内信、SignalR 和幂等 Callback。

## 本地启动

```powershell
docker compose up -d postgres
dotnet run --project server/AigcHub.Api/AigcHub.Api.csproj
```

复制 `portal/.env.example` 为 `portal/.env.local` 后启动前端：

```powershell
cd portal
npm run dev
```

Swagger：`http://localhost:5080/swagger`。开发账号密码均为 `Bhss@123`：

- `wh00028`：平台管理员
- `wh00136`：流程管理员
- `wh00412`：普通申请人

生产环境必须通过环境变量覆盖 `ConnectionStrings__PostgreSql`、`Jwt__Key` 和 `Callback__Secret`。

## 发布 Callback

审批通过后任务接口返回 `correlationId`，流程进入 `Publishing/WaitingCallback`。发布服务完成后调用：

```http
POST /api/workflow/callbacks/application-publish
X-Callback-Timestamp: <Unix seconds>
X-Callback-Signature: sha256=<HMAC hex>
Content-Type: application/json

{
  "eventId": "external-event-001",
  "correlationId": "审批返回的 correlationId",
  "status": "Succeeded",
  "data": { "publishedUrl": "https://internal.example/app" }
}
```

签名原文为：

```text
{timestamp}.{eventId}.{correlationId}.{status}
```

使用 `Callback__Secret` 做 HMAC-SHA256。服务端允许 5 分钟时间偏差，以 `eventId` 唯一索引保证重复回调只推进一次。

## 验证

```powershell
dotnet test AigcHub.sln
cd portal
npm test -- --run
npm run lint
npm run build
```

## DSH 公告与灰度更新

管理入口是 `/admin/announcements` 与 `/admin/client-releases`，分别需要 `announcement.manage` 和 `client-release.manage` 权限。已有数据库启动时会补齐权限并授予平台管理员；现有登录令牌需重新登录后获取新权限。

公告先保存草稿，选择指定人员并设置生效时间和可选到期时间，再发布。已发布正文不可修改；撤回后需要重新创建公告。Windows DSH 登录后每 45 秒同步有效公告，托盘和应用菜单显示最近最多 100 条及未读数量，重要公告在窗口可见时通过 DSH 内置遮罩弹窗显示，不调用 Windows 消息框或系统通知。后台收到的公告可通过菜单阅读。送达、已读、确认分别保存到数据库；离线客户端重新登录会补收。

公告与客户端版本的接收范围支持指定用户、角色和部门组合。保存时按当前启用成员生成去重名单，并保留所选范围供再次编辑；成员变化后须重新保存范围，不会自动扩大已发布名单。旧公告和版本的指定用户范围继续保留。

虚拟 Key 和模型授权统一使用部门、角色和指定用户，复用相同的范围选择组件。角色授权按当前成员身份校验。旧自定义组织授权保留兼容；编辑并保存 Key 授权时，其成员转换为指定用户，不再从界面创建自定义组织。

版本先创建草稿并选择 Windows 架构和灰度人员，再上传现有 DSH 打包流程生成的 `.exe`（内网可使用 unsigned 未签名包） 与可选同名 `.exe.blockmap`。安装包最多 2 GiB、差分文件最多 32 MiB，服务端生成更新清单和 SHA-512，已上传文件不可覆盖。必须使用与安装包实际版本一致的 SemVer。发布后只有被指定的已登录人员能访问该版本的清单和文件；扩大名单、暂停和恢复发布在下一次检查时生效。暂停阻止新的服务端下载，不撤销已下载的安装包，也不降级已经升级的客户端。DSH 复用已有检查、下载、任务确认和重启安装流程，保留用户确认，不自动停止任务。

客户端每 45 秒上报设备和当前更新状态。Windows 开发运行可验证公告与上报，安装版更新必须验证真实的旧版到新版升级；`dev:desktop` 不启用安装更新。旧客户端需要具备可用更新入口才能获取包含该功能的过渡版本，否则需要安装一次过渡版本。只支持 Windows 首期，尚未提供强制更新、百分比灰度和版本降级。

Windows 托管打包保留现有 NSIS 流程；签名包继续校验发布者，unsigned 内网包不校验证书发布者，但仍保留鉴权、灰度范围与 SHA-512 文件校验，更新配置指向 AIGC，不再要求配置共享更新 CDN 或 COS。生成的 `.exe` 和可选 `.exe.blockmap` 通过管理页面上传；自动构建版本号根据本地产物建议，跨电脑打包时应显式指定唯一版本，服务端会拒绝重复版本。原有 COS 上传命令用于共享源发布，不用于此管理流程。

更新文件默认保存在后端 `data/desktop-releases`，可以用 `DesktopReleases__Root` 改变目录。Docker 配置提供独立持久卷；反向代理应允许大文件上传、Range 下载并将认证头传递到后端。公告和版本的人员授权使用 DSH 登录身份，不使用客户端提交的工号；后端 token 仅存在于 DSH Host 与 Electron 主进程中。

内网无证书测试：在 deepseek-harness 根目录执行 `pnpm run package:desktop:win:x64:unsigned -- --build-version auto`，产物位于 `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts`（以打包日志为准）。先安装一个包含灰度更新功能的未签名版本，再打包更高版本，按实际产物版本创建草稿、上传 exe 和可选 blockmap 后发布。已签名旧客户端仍会拒绝未签名更新，需要手动安装一次未签名过渡版本。
