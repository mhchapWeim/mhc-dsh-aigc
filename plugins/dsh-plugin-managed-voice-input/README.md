# AIGC 托管语音输入

兼容 DSH `0.1.7-alpha.2` 基线（包括同基线的日期构建），插件版本 `1.0.0`。

客户端安装包预置约 241 MB 的 INT8 SenseVoice 模型、词表及 Silero VAD。插件只组合已随客户端安装的语音服务、API 和麦克风 UI；插件归档不包含模型、私钥或原生运行时。

## 发布与使用

1. 在 DSH 中构建并准备桌面安装资源；`preparePrimaryRuntime` 会校验并复制三个模型文件到 `runtime/speech-models`，electron-builder 随 runtime 一并打包。
2. 用户安装包含本次改动的客户端。旧客户端缺少模型资源路径，不能仅靠下发插件获得此能力。
3. 在本目录执行 `node build.mjs`，再执行 `npm pack --ignore-scripts`。构建使用同仓库 DSH 的 TypeScript；发布包不依赖构建工具。
4. 在 AIGC 插件管理上传生成的 tgz，选择版本、启用，并授权用户、部门或角色。配置可留为空对象，不需要服务密钥。
5. 客户端登录后同步策略；如报告 `RestartRequired`，重启客户端。模型自动检查后进入可用状态，直接点击麦克风录音。

未授权不加载该 Bundle；退出、撤权和策略请求失败沿用现有托管插件停用流程。安装在本地的模型保留，可再次授权复用。原有非托管语音 Bundle 默认关闭，桌面升级会移除此前免授权的默认选择。

## 资源和生命周期

Host 向插件进程提供 `DSH_SPEECH_MODELS_ROOT`，由安装位置派生，不由 AIGC 下发机器绝对路径。必须包含 `model.int8.onnx`、`tokens.txt`、`silero_vad.onnx`。资源缺失时明确失败，不访问外部模型源。

识别发生在本机 CPU，不新增聊天模型工具或修改 Agent 循环。音频不作为聊天消息提交；转写文字进入草稿，用户发送后按普通消息处理。

源码组合与卸载验证位于 DSH 的 `packages/boot/plugin-manager/tests/managed-voice.spec.ts`，托管授权和撤权回归位于同目录 `manager.spec.ts`。
