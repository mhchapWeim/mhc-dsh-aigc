# Windows Release 出站审查

从仓库根目录执行 `pnpm run security:outbound`，在 `.desktop-build` 下生成静态线索清单。`pnpm run security:outbound:enforce` 在存在待审查源码时返回失败，适合 CI 门禁。

Windows 打包入口自动执行检查。签名打包要求已有的源码审查记录匹配当前文件 SHA-256，并登记匹配当前锁文件及依赖声明的审查记录；未签名打包可以生成待审查安装器，不能据此认定允许正式发布。构建完成后，清单记录本次 EXE、blockmap 的 SHA-256，位于 `apps/desktop/.desktop-build/targets/win-x64/outbound-audits/<版本>/`。

交付包括安装 EXE、`出站审查清单.md`、`outbound-audit.json` 和 `SHA256SUMS.txt`。记录涵盖 Git 提交、未提交状态、源码文件集合哈希、锁文件哈希、网络及子进程调用位置、URL origin 和依赖声明。URL 不记录凭据、路径或查询参数。

审核者逐项确认目标、用途、数据及触发条件后，才能在 `outbound-policy.json` 的 `reviews` 中填写 `file`、`sha256`、`reviewer`、`reviewedAt`、`purpose`、`data` 和 `trigger`。不能直接把本次发现批量视为允许。文件任何内容变化均使原批准失效，包含向同一域名新增发送数据的情况。该文件属于安全审查配置，应使用代码托管平台的保护分支及审核权限管理；本地修改策略文件可以绕过本地门禁。

依赖批准写入 `dependencyReview`，包含报告中的 `lockfileSha256`、`manifestSha256`，以及人工填写的 `reviewer`、`reviewedAt` 和 `scope`。依赖或锁文件发生变化会重新阻断检查；哈希匹配只说明审查记录未过期，不代替依赖代码审查。

当前为第一阶段静态检查：解析 apps、packages、vendor、native、scripts 中的 JavaScript/TypeScript AST，以及配置和脚本里的 URL；脚本文件均要求人工审查，排除测试、构建产物等目录。静态 URL 可能只是帮助链接；计算得到的目标、API 别名、其他脚本语言的执行语义、原生代码、安装依赖及外置插件仍需专项审查。此命令没有运行时抓包、安装包代码扫描、依赖漏洞扫描或反病毒功能。EXE 哈希只绑定文件身份，不证明它与源码一一对应。扫描通过也不等同于“无恶意行为”。

正式发布仍需对最终安装包及依赖、运行时进程树出站做验证，并核实用户主动访问与客户端自动上报的边界；清单保留这些尚未完成的状态。
