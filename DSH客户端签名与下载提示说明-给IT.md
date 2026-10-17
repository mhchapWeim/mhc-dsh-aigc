# DSH 客户端签名与下载提示说明

## 背景

公司内部使用的“弯崽工作助手”（基于 DeepSeek Harness，简称 DSH）目前提供未签名的 Windows EXE 安装包。从 AIGC 下载页下载完成后，Edge 提示：

> 通常不会下载此文件，请在打开前确保信任此文件。

这是浏览器的下载信誉提示，不等于已经检测到病毒。

## 现有证书与官方签名证书的区别

| 项目 | 公司目前提供的证书 | DeepSeek 官方安装包证书 |
|---|---|---|
| 类型 | GlobalSign OV SSL/TLS 网站证书 | GlobalSign EV Code Signing 代码签名证书 |
| 主体 | 博世华域转向系统有限公司 | Hangzhou DeepSeek Artificial Intelligence Co., Ltd. |
| 主要用途 | 为 `*.boschhuayu-steering.com` 等域名提供 HTTPS 身份验证 | 对 Windows 软件和安装包签名，标识发布者并验证文件完整性 |
| 可否用于 DSH 安装包代码签名 | **不可**，未包含代码签名用途 | 可以，由持有配套私钥的一方签名 |

Apache_PEM、Nginx_PEM、BT_cn、JKS、PKCS12_IIS 是同一套网站证书的不同部署格式。**PFX 只是文件容器；网站证书转成 PFX，也不会变成代码签名证书。**

官方证书信息来自安装包属性截图：颁发机构为 `GlobalSign GCC R45 EV CodeSigning CA 2020`，签名摘要算法为 SHA256，并带有时间戳。

## 需要 IT 协助的事项

### 1. 提供软件签名能力

优先确认公司是否已有 Windows Authenticode 代码签名证书或集中签名服务。

- 证书须包含 **Code Signing** 用途，OID：`1.3.6.1.5.5.7.3.3`。
- 签名需能调用配套私钥；可以通过公司签名服务、HSM、UKey、Windows 证书存储区或允许使用的 PFX 实现，**不必须提供 PFX**。
- 内部 CA 签发的代码签名证书可用于内部部署，但需要 IT 向目标电脑部署证书链信任，并按终端策略配置发布者信任。
- 如需在未预先配置信任的电脑上验证发布者，可采用公开信任的代码签名证书或服务；不一定必须使用 EV。

### 2. 处理 Edge 下载信誉提示

**代码签名信任与 Edge 下载信誉是不同机制，签名后仍可能出现下载提示。**

针对内部 AIGC 下载渠道，可由 IT 评估下发 Edge 策略 `ExemptSmartScreenDownloadWarnings`，仅对实际下载主机的 `exe` 文件豁免下载信誉警告。该策略支持 Windows 上的 Edge 118 及以上版本。

示例配置（须替换实际下载域名）：

```json
[
  {
    "file_extension": "exe",
    "domains": ["https://实际下载域名"]
  }
]
```

- 使用最终提供 EXE 的下载主机；如有跳转，需确认实际来源。
- 限定具体主机，不配置全部域名通配放行。
- 下发后在 `edge://policy` 确认策略状态，再从 AIGC 重新下载验证。
- 此策略处理下载信誉提示，不代表安装包已签名，也不替代 Windows 运行阶段及终端安全软件的检查。

## 建议处理顺序

1. IT 确认现有代码签名能力和终端管理方式。
2. 开发侧接入签名，对应用及安装包签名并验证。
3. IT 按需部署内部证书信任及 AIGC 下载定向策略。
4. 在员工电脑验证下载、签名显示、安装及启动。

**私钥、PFX 密码不得随客户端安装包分发。网页代码或 HTTPS 网站证书不能直接消除 EXE 的下载信誉提示。**

## 微软参考文档

- [证书扩展用途：Code Signing](https://learn.microsoft.com/en-us/windows/win32/api/certenroll/nn-certenroll-ix509extensionenhancedkeyusage)
- [SignTool：Windows 软件签名工具](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)
- [Edge SmartScreen 下载信誉机制](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-security-smartscreen)
- [指定域名与文件类型的下载信誉豁免策略](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/ExemptSmartScreenDownloadWarnings)
