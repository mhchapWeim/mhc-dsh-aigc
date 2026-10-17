# DSH 内网模型诊断版

版本：`0.1.7-alpha.2.20261016.1`，Windows x64，未签名安装包。

本包用于定位 `Request was aborted`。增加诊断不代表错误已修复；真实内网模型尚未在本机验证。没有发布到 AIGC 自动更新渠道。

## 安装与复现

1. 保存进行中的任务并正常退出客户端，使用本目录安装包覆盖安装到原安装位置。不要删除原数据目录。
   如果原来通过 `DSH_HOME` 指定了数据目录，继续使用相同的启动配置；本安装包不迁移数据目录。
2. 启动后，在“应用 → 关于”确认版本为 `0.1.7-alpha.2.20261016.1`。认证仍由用户手动选择。
3. 使用原来报错的内网模型和原任务复现，记录本地开始时间与报错时间。
4. 在 AIGC 下载该版本、该用户、报错时间附近的完整错误记录，包含 `host-log`、`llm` 和 `agent`；不要只下载一条 `agent/error`。
5. 搜索 `llm-request-diagnostic`。这些失败记录包含本地请求关联 ID、会话 ID、模型、API 协议、去除 URL 凭证及查询参数的请求入口、耗时、HTTP 状态与取消信号分类。

AIGC 接入地址：`https://aigcplatform.boschhuayu-steering.com`。

## 如何判断

- `caller.aborted=true`：上层任务或生命周期取消；检查 `reason` 分类及相近时间记录。
- `watchdog.reason=LLM_STREAM_IDLE_TIMEOUT`：DSH 的流式空闲超时。
- 信号未取消却收到 `ABORTED`：继续检查 SDK/协议适配和上游流结束处理。
- `httpStatus=200` 只表示响应开始，不能证明完整生成结束。
- `lastChunkAgoMs` 是客户端解析后的内容事件间隔，不是原始网络包间隔。
- `sdkTimeoutMs=null` 表示没有显式覆盖 SDK 超时，不表示没有 SDK 默认值。

错误日志保留近期活动的时间和会话标识；已格式化的错误字符串不再重复转义。诊断不记录提示词、模型正文、工具参数、API Key 或请求头。

本包保留当前工作区已完成的云备份和菜单调整；不调整模型超时、上下文容量或重试策略。未对生产服务器配置做修改。

服务器侧对照探测工具另见 `output/dsh-local-model-diagnostics-2026-10-16.zip`。

验证：82 项相关测试、4 项探测脚本模拟测试、14 项安装包代码核对通过。最终打包运行时冒烟检查与 DOCX/XLSX/PPTX 转 PDF 检查通过。详细结果见 BUILD-INFO.json、PACKAGE-VERIFICATION.json、PACKAGING-RESULT.json；文件校验和见 SHA256SUMS。

未执行真实内网模型复现，也未在现有客户端上安装或验证升级。
