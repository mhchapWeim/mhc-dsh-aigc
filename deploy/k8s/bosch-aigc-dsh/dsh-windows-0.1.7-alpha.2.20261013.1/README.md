# 弯崽工作伙伴 Windows 安装包

版本：0.1.7-alpha.2.20261013.1，Windows x64，未签名。

## 安装与升级

运行同目录 `bhssAiWork-0.1.7-alpha.2.20261013.1-win-x64-unsigned.exe`。
全新安装默认目录为 `D:\Program Files (x86)\wanzai`，升级保留原登记目录。
安装器不会主动请求管理员权限；如果出现权限不足，可关闭安装器后右键选择“以管理员身份运行”。
升级前退出安装目录中的应用及后台进程。已登记的 BHSS办公助手、弯崽工作伙伴和 deepseek-harness 旧版均支持升级，保留应用身份和用户数据。

客户端界面使用微软雅黑。托管 Windows 客户端默认工作区为 `D:\wanzaiwork`，可创建或选择其子目录；目录选择、工作区创建、会话启动及恢复均校验限制，并拒绝通过目录联接越界。该限制针对工作区位置，不是对所有工具文件访问的沙箱。历史目录不会自动搬迁，需先自行迁移。

## 安装失败日志

失败时向安装包配置的 AIGC 服务 `/v1/desktop/installer-diagnostics` 上报，记录阶段、错误码、错误文本、安装目录、Windows 版本、计算机名及管理员状态。无需客户端登录。
本地报告位于 `%LOCALAPPDATA%\wanzai\InstallerLogs`；`.json.status` 表示此次上报结果。网络不可用时保留本地报告，不自动重传；完整解压错误输出另存本地。

必须部署本次修改后的 AIGC API 和 Portal，才能在管理端“失败日志”中按安装器分类查看。接收端包含字段校验、大小限制、敏感信息清理、去重及 IP 限流，数据库通过启动时的增量结构初始化支持未登录安装器事件。
本交付未部署生产 AIGC，未发布客户端市场，未做真实生产服务上报验证。旧版 AIGC 不支持该接口时，请收集本地日志。

## 校验与验证

PowerShell：

```powershell
Get-FileHash .\bhssAiWork-0.1.7-alpha.2.20261013.1-win-x64-unsigned.exe -Algorithm SHA256
```

与同目录 `SHA256SUMS` 比对。测试结果及限制见 `verification.md`，原始验证输出保存在 `evidence` 目录。
