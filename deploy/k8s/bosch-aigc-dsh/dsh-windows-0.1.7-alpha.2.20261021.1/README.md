# DSH Windows 0.1.7-alpha.2.20261021.1

Windows x64 未签名安装包，基于 main 工作区构建。主进程显式内联 home-paths 和 deepseek-account，避免安装后启动时解析不到开发依赖。

先从托盘完全退出旧客户端，再运行同目录 EXE 覆盖安装，无需先卸载。SHA256SUMS 包含安装包校验值。

同目录已包含对应的 .exe.blockmap，SHA256SUMS 同时覆盖 EXE 与 blockmap。可通过 AIGC 客户端版本管理上传两者、配置目标用户/角色/部门后发布灰度。包内托管后端及更新源为 https://aigcplatform.boschhuayu-steering.com；需向该环境发布，目标旧客户端也需连接此环境并支持未签名托管更新。签名旧客户端不能直接自动切换为此未签名包。

验证结果：7 项主进程构建和安装打包相关测试通过；official 构建通过；最终 app.asar 的 main.js 未包含上述两个包的外部导入，版本及导入清单见 PACKAGE-VERIFICATION.json；成包运行时原生模块检查、Workspace controller 启动以及 DOCX/XLSX/PPTX 转 PDF 检查通过。

完整打包流程首次在原生安装辅助 DLL 编译阶段失败；单独重编成功后复用已准备的运行目录，重新执行 electron-builder 及 smoke-packaged-runtime.ts，最终均退出 0。依赖收集阶段的 pnpm SQLite 沙箱访问限制通过沙箱外重试解决。

未在用户报错机器上执行覆盖安装及图形界面启动验证。未上传或发布此安装包。
