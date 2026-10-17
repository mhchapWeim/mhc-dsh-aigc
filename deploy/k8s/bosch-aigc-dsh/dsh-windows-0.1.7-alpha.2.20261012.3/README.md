# bhssAiWork Windows x64 交付

版本：`0.1.7-alpha.2.20261012.3`。界面名称为“弯崽工作伙伴”，内部可执行文件固定为 `bhssAiWork.exe`，安装包前缀固定为 `bhssAiWork-`。内置后端为 `https://aigcbackend.boschhuayu-steering.com`。

## 升级行为

本版兼容已登记安装目录中的 `BHSS办公助手.exe`、`弯崽工作伙伴.exe` 和 `deepseek-harness.exe`。升级沿用原目录，替换为 `bhssAiWork.exe` 并更新快捷方式；全新安装默认使用 `bhssAiWork` 目录。应用 ID、包名、更新缓存身份和用户数据路径保持不变。无需为改名卸载旧版或手动清空目录。未登记的非空目录仍会被拒绝，避免覆盖其他文件。

若该安装目录中的旧程序仍运行，安装器提示退出；更新模式最多等待十秒后停止，并清理本次暂存载荷。退出客户端后重新运行安装包即可。

## 安装命令（Windows PowerShell）

在本交付目录执行，先核对校验值，再退出客户端并启动安装器：

```powershell
Get-FileHash -Algorithm SHA256 '.\bhssAiWork-0.1.7-alpha.2.20261012.3-win-x64-unsigned.exe'
Get-Content .\SHA256SUMS
Start-Process -FilePath '.\bhssAiWork-0.1.7-alpha.2.20261012.3-win-x64-unsigned.exe' -Wait
```

安装器自动读取原安装位置，不必指定新目录。交付中的 `.exe.blockmap` 必须与本版 exe 配对使用。

## 构建命令（开发机 PowerShell）

依据工作区 `DEPLOYMENT-RUNBOOK.md`，同一 `win-x64` 输出目录只运行一个打包任务：

```powershell
Set-Location D:\Code\Bosch\aigc\deepseek-harness
pnpm run package:desktop:win:x64:unsigned -- --build-version auto
```

自动版本号会识别旧中文名和新的英文名前缀，避免更名后重复使用已有版本。本次构建版本以本文件顶部为准。

## 验证记录

固定命名、版本编号、上传清单、更新分发及安装器模板相关的 123 项测试通过，桌面端 TypeScript 检查通过。独立测试身份下的中英文安装器均通过全新安装、三种旧程序名升级、运行中程序拦截及暂存清理、快捷方式目标、重复升级、未登记目录拒绝和测试卸载；结果见本目录两份 `upgrade-verification-*.json`。独立测试不会修改用户已安装的 DSH。

实际交付包的构建结果、运行时检查和校验值见本目录 `build-result.json`、`packaging-events.jsonl` 与 `SHA256SUMS`。

## 中台发布

客户端版本管理位于 `/admin/client-releases`。发布时使用新版本号、Windows x64、对应 exe 和 blockmap，核对灰度人员后发布；本次交付未自动上传或发布到生产中台。中台计算更新协议所需 SHA-512，本目录 SHA256SUMS 仅用于交付校验。

本包是未签名构建。已安装的签名客户端若要求发布者校验，应使用相同修复代码构建已签名版本后通过更新通道发布；未签名包用于与此前未签名基线一致的测试或手工安装。
