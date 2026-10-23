# 交付验证记录

日期：2026-10-23。目标：192.168.10.30；未连接或修改目标服务器。

## 已完成

- 从官方 ghcr.io/berriai/litellm 拉取 v1.106.2 的固定 manifest，验证全部压缩 blob SHA256 和长度。
- 验证 amd64 manifest 在已固定的多架构 index 中；验证每个解压层与原镜像 config.rootfs.diff_ids 一致。
- 官方 index digest：sha256:7294b90f868c5c38c99b83021c7ba46f9b439e95f8e32964c925c7d2563a03f7。
- amd64 manifest digest：sha256:d1da6edc025e6a59be6faa50b4e8e42c115e1c99644aa3fc2ac416dd353f41da。
- 使用 cosign v2.4.3（下载后与该版本官方 checksums 比对）和 LiteLLM 固定提交 0112e53046018d726492c814b3644b7d376029d0 中的公钥验证上述 index。
- cosign 成功验证 claims、公钥签名和离线透明日志证明；未关闭透明日志验证。结果保存在 signature-verification.json。
- 验证离线 Docker save 归档格式、config image ID、全部镜像层完整性、linux/amd64 平台。
- 从镜像层中读取实际安装的 litellm dist-info/METADATA，版本为 1.106.2。
- Bash 脚本全部通过 bash -n；Python 文件通过编译检查。
- 25 项模拟 Docker/Compose 流程测试通过，包括原有流程、镜像 ID 兼容性，以及标准输入校验命令、非归档输出拒绝、私有 stderr 日志三项新增回归检查。
- 使用真实 Docker Compose v5.1.2（无需 daemon）完成含美元符号密码/命令的配置解析、快照往返及 config-hash 一致性检查。确认 Compose 输出已转义美元符号，升级器不会重复转义；执行升级时也会检查真实快照往返一致。
- Master Key 探针在本地子进程实际执行 7 个案例，覆盖环境变量、YAML 值及环境变量引用；输出仅含状态。测试 PyYAML 安装在 .build/qa-libs，不进入交付包；目标旧版 LiteLLM 容器使用其已有 PyYAML。
- 最终 ZIP 和全部交付文件生成 SHA256 清单；ZIP 重新读取并通过 CRC/逐文件 SHA256 校验。

## fix1 实机镜像识别验证

- 本机 Docker 实际加载同一份离线 v1.106.2 归档后，源配置摘要 sha256:0e5340fc3d4dee8ca7c0ecbea798714f2493b15085e171527267ef9bb480fcd9 不能直接 inspect；通过版本标签可以查询，复现现场失败。
- Docker 返回的本地镜像 ID 为 sha256:dd1af31f589483491cd16d68f51d30752d21cf8edc7f2d20a18dc978567dfe48，与源配置摘要不同。
- 使用修复后的函数核对归档及已加载镜像的全部层、平台和启动配置通过；按实际本地 ID 启动无网络、无数据库挂载的临时 Python 容器，读取真实包版本为 1.106.2，临时容器自动删除。

## fix2 真实 PostgreSQL 备份/恢复验证

- 独立 PostgreSQL 17.10 容器中，使用同一份 custom dump 复现 `pg_restore --list /dev/stdin` 的 `did not find magic string in file header` 错误；省略文件名、通过标准输入传入时通过。
- 通过升级器的真实 dump/verify_dump 函数生成预备和最终备份并校验；追加测试数据后另存回退前备份，再禁止新连接、删除测试数据库、用标准输入执行 pg_restore --create，恢复后只包含备份时刻的数据。
- 测试容器和测试数据卷完成后删除；未访问生产服务器或生产数据库。具体结果见 PG-VALIDATION.json。

## 尚未验证

- 未在真实完整 Compose 拓扑中启动 LiteLLM 服务或执行数据库迁移；上述临时 Python 容器不等于启动 LiteLLM 代理服务。
- 已验证真实测试 PostgreSQL 的 dump/恢复命令，但未验证真实生产数据库副本或 LiteLLM schema 迁移。
- 用户 check.sh 输出已确认 Compose 工作目录 /data/litellm、LiteLLM 容器 litellm-litellm-1、PostgreSQL 容器 litellm_db 和当前版本 1.103.0；空间、资源、数据库独占及生产恢复能力仍需现场确认。
- 未验证现场模型、虚拟 Key、费用、DSH、DMZ/内网请求和博查/ASR。
- prepare-release.sh 已通过语法检查，未实际运行 Docker 拉取/导出新版本流程。

以上不构成生产升级成功证明。请先执行 check.sh，并在独立数据库副本上演练升级/回退；正式升级后完成 README 中的业务验收。
