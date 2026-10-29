# KnowEngine 验签失败排查指引（assertion_expired）

日期：2026-10-29。背景：AIGC 签发的断言内容与时钟已验证正确（见文末证据），但 KnowEngine Token Exchange 返回 `assertion_expired: "assertion expired or not yet valid"`。本指引按成本从低到高排查，每步只需几分钟。

## 第 0 步：先看服务器时间戳（1 分钟，最先做）

在 KnowEngine **容器内**和**宿主机**分别执行：

```bash
date +%s        # ← 关键：Unix 时间戳，与时区无关
date -u
```

**注意：`date` 显示 UTC 时间（比北京时间慢 8 小时）是正常现象，不是故障。判断标准只有一条：`date +%s` 与外部真实时间一致。**

对比方法：拿着容器内的输出，和 AIGC 侧同时刻的值对比（或直接和 https://time.is 对比）：

```bash
# AIGC 侧（已验证正确，可作参照）：
kubectl -n bosch-aigc-dsh exec deployment/aigc-api -- date +%s
```

判定：
- 容器 `date +%s` 与真实时间一致 → 服务器时钟没问题，**跳到第 1 步查应用代码**
- 容器 `date +%s` 比真实时间慢/快 → 修宿主机 NTP（容器与宿主机共享内核时钟，修宿主机即修容器）

## 第 1 步：检查验签代码的时钟源（最可能的根因）

在 Token Exchange 验签处（校验 `nbf`/`exp` 的那段代码）加一行临时日志，打印两个值：

**Java：**

```java
long sysNow = System.currentTimeMillis() / 1000;   // 系统真实时间（epoch 秒）
// 用于校验的那个 now（转换成 epoch 秒），例如：
long checkNow = /* 你代码里传给 JWT 库 / 用于比较的那个时间值 */;
log.info("clock check: sysNow={}, checkNow={}, diff={}s", sysNow, checkNow, sysNow - checkNow);
```

**对照判定：**

| diff（sysNow - checkNow） | 结论 |
|---|---|
| 0 | 时钟源没问题 → 跳到第 2 步 |
| **+28800（8 小时）** | 经典时区 bug：把 GMT+8 的本地时间当 UTC 用了 |
| -28800 | 反向时区 bug：把 UTC 值又减了 8 小时 |
| 其他 | 该值就是验签的偏差量，顺差找原因 |

**8 小时偏差的常见代码病灶（Java）：**

```java
// 错误写法 1：LocalDateTime 无时区，toInstant(UTC) 把北京时间当 UTC
LocalDateTime.now().toInstant(ZoneOffset.UTC)      // ✗ 慢 8h

// 错误写法 2：手动构造 Clock 用错时区
Clock.system(ZoneOffset.of("+8"))                  // ✗ 若后续按 UTC 语义使用

// 错误写法 3：自写的时间比较把 nbf/exp 当本地时间字符串解析
new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss")     // ✗ 默认 JVM 时区，易错

// 正确写法：验签唯一时钟源
Instant.now()                                       // ✓
System.currentTimeMillis()                          // ✓
```

同时检查 JWT 库配置是否被自定义时钟覆盖：

- jjwt：`Jwts.parser().clock(() -> ...)` 是否传了错误实现
- nimbus-jose-jwt：`JWTClaimsSetVerificationTime` / `TimeProvider` 是否被覆盖
- Spring Security：是否注册了自定义 `Clock` Bean

## 第 2 步：如果时钟源也正常，检查 nbf/exp 的解析

打印**解析后的** `nbf`、`exp`、`iat` 值（epoch 秒）与原始 JWT payload 对比：

```java
log.info("parsed: iat={}, nbf={}, exp={}, now={}", iat, nbf, exp, Instant.now().getEpochSecond());
```

样本断言（AIGC 已验证正确的一条）应满足：`exp = iat + 60`、`nbf = iat - 5`。若解析出来的值和 payload 不符（比如解析成了毫秒/秒混用、或字符串截断），是字段类型问题：`iat` 在 AIGC 断言里是 **JSON 数字**（不是字符串），部分解析库需要显式处理。

## 第 3 步：容差配置兜底

无论根因是什么，建议按接口合同把时钟容差配上（本可吸收 ±30 秒的合理偏差）：

```text
exchange.clock-skew-seconds=30
```

若部署环境时钟短期内无法对齐，可临时调大到 60~120 秒过渡，但 8 小时级别的偏差**必须修根因**，不能用容差掩盖。

## 附：AIGC 侧已验证的证据（无需再查）

- 断言样本：`iat=1793237620`（北京 09:33:40）、`nbf=iat-5`、`exp=iat+60`、`iss=bhss-aigc`、`aud=knowengine-mcp`、`sub=wh00028`、`kid=aigc-2026-10` —— 内容与格式均正确
- AIGC 容器时钟：`2026-10-29T01:47:32Z` = 宿主机 `09:47:33 CST`，偏差 1 秒（采样误差）
- AIGC 签发用 `DateTimeOffset.UtcNow` → Unix 时间戳，与时区无关
- 报错描述 "expired **or not yet valid**" 表明验方判定断言未生效（nbf > now），指向验方时钟偏慢

## 汇报格式

排查后请把以下信息回传，便于继续定位：
1. 容器 `date +%s` 与真实时间的差值
2. 第 1 步日志的 `sysNow`、`checkNow`、`diff`
3. JWT 库名称与版本、`clock-skew` 当前配置值
