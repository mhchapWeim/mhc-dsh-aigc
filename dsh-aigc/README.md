# DSH 上游升级机制

当前客户端源码以 `deepseek-harness/` 为唯一编辑入口。`upstream.lock.json` 固定该源码对应的上游 tag 和完整提交；版本号变化不能替代代码迁移。上游历史保存在可重建的本地 bare Git 缓存，AIGC 源码、版本锁、兼容测试配置及可复用冲突解决记录保存在本仓库。

## 基线与分支

- 源码检查点：`aigc-dsh-baseline-20261116`，提交 `3bf8fcce06194278ea13b9853c7aecf2a7faec01`。
- 旧版维护：`codex/dsh-0.1.7-maintenance`。
- 本次开发：`codex/dsh-upstream-integration`。
- 检查点仅表示代码已保存，不代表完成生产发布验收。

每次升级在 `codex/dsh-upgrade-<version>` 分支工作。先提交 DSH 源码变更；无需提交本地依赖、凭据、用户数据或缓存。

## 环境

升级工具只依赖 Python 3.12+ 和 Git；编译客户端仍需要目标上游版本要求的 Node.js、pnpm、原生构建工具及桌面运行环境。候选目录独立安装依赖，不共享旧客户端的 `node_modules` 或构建产物。命令从 AIGC 仓库根目录执行。

## 一次升级

```powershell
# 首次使用默认候选版本；以后显式指定目标 tag 和完整提交 SHA。
python dsh-aigc/upgrade.py prepare --name dsh-0.2.2-rc.3

# 后续版本示例：将占位符替换为经核验的 tag 和 SHA。
python dsh-aigc/upgrade.py prepare --tag <release-tag> --commit <full-sha> --name <candidate-id>
```

工具核验远端 tag，提取当前已提交 DSH 子树，建立以上游旧提交为父节点的下游快照，然后由 Git 三方合并目标上游。它不向缓存导入服务端、Portal 或其他仓库历史。JSON 文件会按对象字段三方合并，自动保留不重叠的依赖和版本修改；同一字段的不同值、同时修改的数组及删除与修改冲突仍交给人工。它自动处理无冲突变更，并生成：

```text
.cache/dsh-upgrades/
  upstream.git/                     上游历史与本地 Git 对象
  candidates/<candidate-id>/
    source/                         独立 Git worktree，可编辑、构建和调试
    plugins/                        固定提交中的配套插件源码
    state.json                      输入提交、树、目标版本、逐文件差异与冲突
    REPORT.md                       本次迁移报告
    verification-<profile>.json      精确到源码树和检查配置的验证记录
    <gate>.log                      各检查输出
```

退出码 `0` 表示合并无冲突，`2` 表示候选已生成且需要解决冲突，`1` 表示前置条件或命令失败。合并无冲突不表示功能兼容。相同名称的候选永不覆盖，保留人工修改和失败现场；离线重建可加 `--offline`，但本地必须已有匹配的发布 tag。

在候选 `source/` 内解决冲突后执行 `git add`。不要使用整批“全部保留本地”或“全部采用上游”来绕过授权和计费的语义适配。随后运行：

```powershell
python dsh-aigc/upgrade.py status <candidate-id>
python dsh-aigc/upgrade.py record-resolutions <candidate-id>
python dsh-aigc/upgrade.py verify <candidate-id> --profile contracts
python dsh-aigc/upgrade.py verify <candidate-id> --profile release
python dsh-aigc/upgrade.py promote <candidate-id>
```

`record-resolutions` 把 Git rerere 的 preimage/postimage 及 SHA-256 清单保存到 `dsh-aigc/resolutions/`，审查后随代码提交。下一次升级或在新机器运行时会自动恢复；缓存删除不会丢失已提交的解决记录。记录复用后仍须暂存、审查和运行验证，不自动认定功能正确。

外层配套插件由 `upstream.lock.json` 的 `companionDirectories` 显式列出，只复制已提交源码，排除 `lib/`、`dist/`、`node_modules/` 和历史 tarball。插件适配仍在主仓库 `plugins/` 中修改和提交，之后执行 `python dsh-aigc/upgrade.py refresh-companions <candidate-id>` 更新候选快照并重新验证；不要直接维护第二份候选插件源码。验证记录同时绑定插件快照，插件变化后不能复用旧结果。

`promote` 要求全部 release 检查通过，验证树及检查配置保持一致，原始 DSH 源码没有漂移。它只更新已追踪源码的差异，不删除本地依赖、用户配置和运行数据；同时更新上游版本锁及集成记录。相对且不离开运行时目录的符号链接按原目标写入；绝对路径、越界链接和子模块仍会停止。推广后审查并提交源码和版本锁，随后再进行灰度发布。工具不会推送、发布安装包或修改生产服务。

推广复制的是源码，候选依赖和构建产物仍在候选目录。重新在主源码目录工作时执行 `pnpm --dir deepseek-harness install --frozen-lockfile` 和 `pnpm --dir deepseek-harness run build`，避免使用旧依赖或旧产物启动新版源码。需要发行的安装包从通过验证的候选目录构建，并另行完成安装与回退验收。

## AIGC 功能归属

`customizations.json` 由 `inventory` 从 Git 对象生成，列出所有相对上游的本地改动，不依赖文件名中是否包含 managed/AIGC。完整独立包列为 extension；修改过上游文件的部分列为 patch；上游不存在的辅助文件列为 addition。

```powershell
python dsh-aigc/upgrade.py inventory
python dsh-aigc/upgrade.py inventory --check
```

目前独立扩展是托管模型、托管账号界面和敏感词策略。其他定制仍位于上游包的扩展点或补丁中。保留单一源码入口，避免把相同文件复制到两套目录后分别维护。逐步抽离补丁时必须保持验收测试，新增上游入口也必须执行 AIGC 授权策略。

## 兼容检查

`gates.json` 是可版本化的检查清单。安装依赖后先编译 Host 库和运行 bundle，再运行契约测试，确保 Cordis 等包的运行入口存在。contracts 覆盖托管模型、计费、自定义模型权限、敏感词、配置同步、模型适配器与会话路由、任务进度、文件锁、插件/MCP/搜索/语音、账号、桌面管理和数据迁移。release 在此基础上要求类型检查、构建、出站审计和安装器自动测试。必需测试文件被删除或移动时直接失败，需要明确更新检查清单；不使用 `passWithNoTests`。

验证记录绑定候选 Git index 的树、目标上游 SHA 和检查清单 SHA-256。修改源码、更新测试清单或只通过部分检查，均不能复用原 release 记录。外部依赖安装或编译失败时保留日志，不把跳过当作成功。自动检查不能替代真实麦克风、目标机器安装和生产环境验收；这些证据在发布时另行记录。

## 数据与回退

候选构建与自动测试使用独立目录及测试数据。手工启动候选时也必须使用独立测试账号和用户数据目录。不得直接让候选打开现有生产客户端的数据目录。

源码回退使用基线提交或维护分支。用户数据可能发生单向迁移，程序回退不能替代数据恢复；灰度发布前单独备份会话、凭据、插件状态和待结算记录。不要用 `git clean -fdx` 清理客户端目录。

## 工具测试

```powershell
python -m unittest discover -s dsh-aigc/tests -v
```

测试使用临时 Git 仓库，验证真实三方合并、冲突隔离、固定提交核验、验证失败禁止推广、推广后再次升级、路径限制及验证记录失效。CI 对 Windows 和 Linux 执行相同测试。

GitHub Actions 的 `DSH upstream candidate` 支持手工输入 tag、完整 SHA 和检查级别。它只生成候选和证据，不修改分支或发布产品；出现冲突时任务失败并上传报告。该工作流提交并推送后才可在远端使用。
