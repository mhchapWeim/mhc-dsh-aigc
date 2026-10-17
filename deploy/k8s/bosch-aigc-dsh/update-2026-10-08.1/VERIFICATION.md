# 本机交付验证

- API 和 Portal Dockerfile 完成 linux/amd64 构建。
- API 使用隔离 PostgreSQL 17 启动，创建新增分发表。
- API /health、管理员登录、公告列表、版本列表、客户端上报列表、受众选项均验证成功（HTTP 200）。
- Portal 镜像 /login HTTP 200。
- update.sh 与 rollback.sh 使用新 API Linux 镜像的 bash -n 检查通过。
- 镜像 tar 单平台导出，21 个 OCI blob 的 SHA256 内容及所有 manifest/config/layer 引用完整性检查通过。
- 未连接或变更生产集群；真实生产升级和 Windows 客户端升级仍需按 README 验证。
