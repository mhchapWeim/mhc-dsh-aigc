# AIGC 托管网页搜索插件

独立的 DSH bundle 工程，首个服务端适配器为博查。插件通过命名导出的 `name / inject / Config / apply` 注册 DSH `web` 搜索 provider；注册随插件 fiber 销毁自动撤销。博查 Key 仅在 AIGC 服务端加密保存，客户端每次请求读取当前用户会话。

## 构建与发布

需要 Node.js 22.19 或更新的受支持版本。此工程没有需要安装的构建依赖。

```powershell
cd D:\Code\Bosch\aigc\plugins\dsh-plugin-managed-search
node --test tests/*.test.mjs
node build.mjs
npm pack --ignore-scripts
```

构建同时生成 JavaScript 入口和 `index.d.ts` 类型声明；宿主组合测试直接引用带声明的源码入口，不要求先生成插件的 `lib` 目录。

生成 `bhss-dsh-plugin-managed-search-1.0.0.tgz`。在 AIGC「管理后台 → 客户端运维 → 插件市场」上传，编辑名称、发布版本、博查 API Key、用户/角色/部门授权并启用。仅上传不会发布或执行代码。发布后，已升级的组织模式 DSH 登录时自动同步，之后默认每 60 秒同步一次。

配置 JSON 是 bundle 行 ID 到字面量配置的映射，例如：

```json
{"web-search-managed":{"requestTimeoutMs":30000}}
```

运行依赖由 DSH 提供，peer 版本必须与安装锚点兼容。`aigc.dshVersion` 暂时使用准确版本；目前支持 `0.1.7-alpha.2`。更换插件实现时增加版本号并重新打包；同一个版本不能覆盖。

## 模型与用户体验

模型仍使用 DSH 原生 `web_search` 工具，搜索结果包含来源 URL、标题和摘要，交给既有引用流程处理。关闭或撤回授权后，服务端拒绝新搜索；客户端同步后移除 provider。缺少插件时明确报错，不自动切回 DeepSeek。退出组织账号会触发同步卸载。包版本更新可能要求重启，市场显示客户端回报的 `RestartRequired`。

## 边界

插件拥有宿主代码执行权限，市场只发布管理员审核过的 bundle，并非不可信代码沙箱。平台校验压缩包、安装脚本、大小和 SHA-256，安装禁用生命周期脚本。博查适配器在 AIGC 内；新增其他需要服务端密钥的能力还需开发对应服务端适配器，上传前端插件不能自动产生服务端能力。
