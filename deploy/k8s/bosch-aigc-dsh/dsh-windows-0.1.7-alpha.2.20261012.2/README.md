# 弯崽工作伙伴 Windows x64 交付

版本：0.1.7-alpha.2.20261012.2。依据工作区 DEPLOYMENT-RUNBOOK.md，使用 `pnpm run package:desktop:win:x64:unsigned -- --build-version auto` 构建。内置后端为 `https://aigcbackend.boschhuayu-steering.com`。

本次包含品牌名称、首页问候、安装器和加载界面的弯崽形象，以及深色背景透明通道修复；修复打开认证窗口时持久会话超时参数缺少默认值的问题。AIGC 密码与 CAS SSO 均支持关闭重开后恢复登录，主动退出仍撤销登录。

## 手工安装（Windows PowerShell）

退出所有 DSH 客户端进程，在本目录核对校验值后运行安装包：

```powershell
Get-FileHash -Algorithm SHA256 '.\弯崽工作伙伴-0.1.7-alpha.2.20261012.2-win-x64-unsigned.exe'
Get-Content .\SHA256SUMS
Start-Process -FilePath '.\弯崽工作伙伴-0.1.7-alpha.2.20261012.2-win-x64-unsigned.exe' -Wait
```

旧客户端如果没有刷新令牌，升级后需重新登录一次。分别检查 AIGC 和 SSO 登录、关闭所有进程重开、主动退出后重开，以及浅色/深色背景下的 Logo。真实 SSO 与企业终端安装策略需现场验证。

## 中台发布

此包未签名。已有签名客户端需要手工安装未签名基线，不能直接沿签名更新链自动切换。在中台客户端版本管理上传本目录的 exe 与 blockmap，核对 win-x64、版本号、用户范围后发布。不要把目录中 SHA256SUMS 的内容当作更新协议 SHA-512；中台按上传文件计算更新校验值。

若需回退，保留旧安装包，退出所有客户端进程后手工安装旧版；自动更新不支持降级。本次交付不自动修改生产客户端灰度策略。
