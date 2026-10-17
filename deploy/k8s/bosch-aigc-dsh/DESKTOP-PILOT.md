# Windows 桌面端静态试点更新源

本方案复用 nj304 上现有的 `aigc-edge` HTTPS 入口，不创建 Ingress、额外镜像或公开写入接口。更新文件只从 nj304 的 `/data/bosch-aigc-dsh/desktop-updates` 读取；对外 URL 为 `https://aigcbackend.boschhuayu-steering.com/dsh-desk/`。现有 Desktop `test` 通道使用 `dsh-desk/<32位发布ID>/feeds/win-x64/nightly.yml`，安装包位于同一发布 ID 下的 `bin/win-x64/`。

## 前提和边界

- 已安装的 `*-unsigned.exe` **没有更新源**，不能靠服务器端文件远程开启更新。试点用户必须先安装一次带更新源的基线包。
- 当前仓库的 Windows 更新构建要求代码签名证书；网站 TLS 证书不能代替 Windows Authenticode 证书。不要把 `unsigned` 安装包手工改名后发布为正式更新。
- `test` 通道的强更策略仍要求现有的测试登录配置；本静态文件服务只负责普通更新清单和安装包，不实现强更策略 API。制作基线包前应单独完成或调整该策略配置。
- 发布 ID 只是不可猜测路径，不是访问控制。内网用户只要知道 URL 就能下载安装包。不要在此目录存放 Secret、证书私钥或其他敏感文件。
- 试点名单通过**仅向试点用户分发试点基线包**控制；本阶段不按 AIGC 用户或部门动态授权。

## 1. nj304：准备目录

```bash
sudo install -d -m 0755 /data/bosch-aigc-dsh/desktop-updates
df -hT /data/bosch-aigc-dsh/desktop-updates
```

确认该目录位于持久磁盘上，且剩余空间足以保留至少两个版本的安装包。

## 2. master：更新现有 HTTPS 边缘服务

将本目录的 `edge-config.yaml`、`edge-hostnetwork.yaml` 上传到 master。在部署目录执行：

```bash
kubectl apply -f edge-config.yaml
kubectl apply -f edge-hostnetwork.yaml
kubectl -n bosch-aigc-dsh rollout restart deployment/aigc-edge
kubectl -n bosch-aigc-dsh rollout status deployment/aigc-edge --timeout=180s
```

ConfigMap 以 `subPath` 挂载，修改后必须重启边缘 Pod。此时还没有清单，`/dsh-desk/.../nightly.yml` 返回 404 是正常的；`/health` 必须继续可用。

## 3. 本机：制作可更新的试点基线包

在 `deepseek-harness/apps/desktop/.env.windows` 中使用以下同一组值，后续版本不能更换发布 ID，否则旧客户端会继续检查旧地址：

```dotenv
DSH_DESKTOP_AUTO_UPDATE_ENV=test
DOWNLOAD_TEST_ORIGIN=https://aigcbackend.boschhuayu-steering.com
DOWNLOAD_TEST_RELEASE_ID=<一次生成并长期保留的32位小写十六进制值>
```

发布 ID 可在本机 PowerShell 生成：

```powershell
([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(16))).ToLowerInvariant()
```

还需按现有签名流水线填写代码签名与强更策略配置。生成**签名**安装包后，在仓库根目录执行离线暂存命令（输出目录必须尚不存在）：

```powershell
pnpm --dir apps/desktop run stage:pilot:win:x64 -- --out D:\pilot-release-001
```

暂存器校验完成记录、版本及安装包 SHA-512，并生成 `payload-first/` 和 `metadata-last/` 两棵目录。它不会访问 COS 或 K8s，也不会自动发布。若只有 `unsigned` 包，命令会因缺少签名发布记录而失败，这是预期的安全边界。

## 4. nj304：先传载荷、再原子发布清单

将暂存目录安全上传到 nj304，例如放在 `~/pilot-release-001`。在节点上执行：

```bash
cd ~/pilot-release-001
sudo cp -a payload-first/. /data/bosch-aigc-dsh/desktop-updates/
```

先验证该发布 ID 下的安装包和 `.blockmap` 文件均已完整上传，再发布清单。将 `<发布ID>` 换成 `.env.windows` 中的实际值：

```bash
release_id='<发布ID>'
feed_dir="/data/bosch-aigc-dsh/desktop-updates/dsh-desk/$release_id/feeds/win-x64"
sudo install -d -m 0755 "$feed_dir"
sudo install -m 0644 "metadata-last/dsh-desk/$release_id/feeds/win-x64/nightly.yml" "$feed_dir/.nightly.yml.new"
sudo mv -f "$feed_dir/.nightly.yml.new" "$feed_dir/nightly.yml"
```

确认服务器返回清单且引用的安装包可下载：

```bash
curl -fI "https://aigcbackend.boschhuayu-steering.com/dsh-desk/$release_id/feeds/win-x64/nightly.yml"
curl -f "https://aigcbackend.boschhuayu-steering.com/dsh-desk/$release_id/feeds/win-x64/nightly.yml"
```

第二条会显示公开的版本、下载 URL 和哈希，不应包含密钥。不要用 `-k` 跳过 TLS 校验。之后让一台试点电脑通过客户端“检查更新 → 下载 → 确认重启”，验证安装版本、登录、模型、对话和工具执行。扩大试点时分发同一更新源的基线包；未来全员发布可另设稳定源及独立基线包。
