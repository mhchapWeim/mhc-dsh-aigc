# Kubernetes MinIO 备份存储

生产部署使用 Kubernetes。`minio.yaml` 是单节点持久化实例，ClusterIP 仅供 AIGC API 访问，没有 NodePort 或外部控制台。路径、节点、100 GiB 容量需要按目标现场检查；这是部署模板，尚未在生产集群应用。

已本地验证服务镜像 `RELEASE.2025-06-13T11-33-47Z` 的 S3 分片读写；模板固定其摘要。同一镜像内置 `mc`，初始化 Job 无需另拉工具镜像。离线集群先将该镜像导出导入 containerd 的 `k8s.io` namespace，并确认清单所写摘要可解析。

1. 在 nj304 选择持久磁盘，创建独立空目录。复制并修改 `pv-local.example.yaml` 中的路径。不要复用已有 Bound PV。PVC/PV 容量声明不会限制本地目录实际占用，必须监控磁盘。
2. 私下复制 `secret.example.yaml`，替换全部占位符。root 与应用必须使用不同账号/随机密码；填写后的文件不得入库。
3. 从仓库根目录，在已确认的目标 kube context 执行：

```bash
kubectl apply -f /private/minio-secret.yaml
kubectl apply -f /private/minio-pv.yaml
kubectl apply -f deploy/k8s/bosch-aigc-dsh/minio-backup/minio.yaml
kubectl -n bosch-aigc-dsh rollout status deployment/aigc-backup-minio --timeout=180s
kubectl apply -f deploy/k8s/bosch-aigc-dsh/minio-backup/bootstrap.yaml
kubectl -n bosch-aigc-dsh wait --for=condition=complete job/aigc-backup-minio-bootstrap --timeout=300s
```

4. 构建/导入包含新代码的 API 镜像，按现有发布流程更新镜像。确认实际容器名是 `api`，将配置以 strategic merge 合入，保留原有 env/envFrom：

```bash
kubectl -n bosch-aigc-dsh patch deployment aigc-api --type=strategic --patch-file deploy/k8s/bosch-aigc-dsh/minio-backup/api-patch.yaml
kubectl -n bosch-aigc-dsh rollout status deployment/aigc-api --timeout=180s
```

5. 使用新版 DSH 上传小备份→暂停/重试→恢复勾选会话；确认历史列表仅显示已校验对象，跨账号访问被拒绝，重启 MinIO Pod 后数据仍在。再检查剩余磁盘和数据库只有清单、没有新的备份正文。Portal 下载新归档还需更新 Portal。

API 默认上限 1 GiB/账号 10 GiB/分片 8 MiB/未完成任务 7 天，详见 [功能与限制](../../../../docs/DSH-CLOUD-BACKUP-MINIO.md)。上传全过程经过 AIGC，客户端无须配置 MinIO 地址。

回退时先关闭 `BackupStorage__Enabled` 并回退 API/客户端；保留 MinIO Deployment、PVC、Secret 和数据库元数据。旧客户端不能恢复新版二进制归档，不要删除已上传数据。禁止删除 PV/PVC 来回退功能。数据库无需新增结构，历史 JSON 记录不会被本次自动迁移。

MinIO 初始化 Job 是一次性任务，失败先查看日志和 Service/Secret；修正后删除该 Job 再重建，不删除数据。应用账号只能操作备份桶，API 不使用 root 账号。后台清理跟随 API 单副本运行；应保留数据库和 MinIO 成套快照。该模板的本地 PV 单节点方案不提供高可用。
