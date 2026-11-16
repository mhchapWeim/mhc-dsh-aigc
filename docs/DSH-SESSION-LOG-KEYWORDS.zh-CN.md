# DSH 会话日志关键字说明

本文用于查看 DSH 导出的会话 ZIP，理解 token 消耗、上下文容量、输出截断、压缩和错误记录。

## 1. 在哪里查看

解压会话 ZIP，用 VS Code 打开其中的 `session.v4.jsonl`。JSONL 文件每行是一条事件，一行可能很长；可以打开自动换行，或将需要检查的一行复制到临时 JSON 文件后格式化查看。

按 `Ctrl+F` 搜索下文关键字。若日志格式化后空格不同，搜索字段名即可，例如搜索 `totalTokens`，不必连同冒号和值一起搜索。

## 2. 最常用的关键字

| 搜索关键字 | 含义 | 主要用途 |
|---|---|---|
| `assistant/message` | 一次模型请求成功记录下来的回复，可能包含正文、推理或工具调用 | 查看该次回复和用量；注意它也可能以输出截断结束 |
| `assistant/attempt` | 未作为普通成功回复落下的模型尝试，例如请求失败或进入恢复 | 检查失败尝试；有 usage 时也可能消耗了 token |
| `usage` | 模型提供方返回的 token 用量 | 找到具体消耗数字 |
| `totalTokens` | 该次请求上报的总 token 数 | 查看单次请求总量，不是整场会话累计量 |
| `inputTokens` | DSH 归一化后的非缓存输入 token | 查看新增或未命中缓存的输入量 |
| `cacheReadTokens` | 从提供方缓存读取的输入 token | 查看重复历史等命中缓存的量 |
| `cacheWriteTokens` | 提供方报告的缓存写入 token | 字段可能没有；不要假定所有提供方都会报告 |
| `outputTokens` | 模型生成的输出 token | 查看该次生成量；可能包含推理 |
| `reasoningTokens` | 提供方单独报告的推理 token | 通常是输出的子集，不要再加到输出总量上 |
| `contextWindow` | 声明的模型上下文容量 | 与同一次请求的输入量比较 |
| `CONTEXT_WINDOW_EXCEEDED` | DSH 归类的上下文超限错误 | 查找明确进入上下文错误处理的请求 |
| `stopReason` | 底层模型响应的结束原因，常保存在回放元数据中 | 区分正常结束、工具调用和截断 |
| `max-tokens` | DSH 将该次结束归为输出 token 截断 | 对应界面上的输出上限提示 |
| `compaction/start` | 开始压缩 | 判断有没有发起压缩 |
| `compaction/summary` | 压缩摘要记录 | 查看摘要和被替换的历史范围 |
| `compaction/end` | 本次压缩结束 | 查看有无 `error`，不要只看事件是否存在 |
| `compaction/prune` | 对历史工具结果做裁剪 | 与调用模型生成摘要的压缩不同 |
| `turn/end` | 一轮任务结束 | 查看最终是完成、截断还是错误 |

## 3. 怎么看消耗了多少 token

下面是本次提供的会话日志最后一次模型请求的用量：

```json
"usage": {
  "inputTokens": 50,
  "outputTokens": 1,
  "totalTokens": 330931,
  "cacheReadTokens": 330880
}
```

解释如下：

- 非缓存输入：50 token。
- 缓存读取：330,880 token。
- 输出：1 token。
- 本次请求上报总量：330,931 token。

在这个字段齐全、统计口径一致的示例中：

```text
本次输入 = inputTokens + cacheReadTokens
         = 50 + 330880
         = 330930

本次总量 = 本次输入 + outputTokens
         = 330930 + 1
         = 330931
```

如果还报告了 `cacheWriteTokens`，它也是输入统计中需要考虑的独立桶。字段缺失时，不要为了凑等式推断一个未经报告的值；优先保留提供方报告的 `totalTokens`，并说明统计缺口。

### 缓存读取不是免费，也不是新增内容

缓存命中表示提供方复用了已有输入的计算，通常涉及此前的提示词、历史消息、代码或工具结果。`cacheReadTokens` 仍属于输入用量，但不等于用户又输入了这么多新内容。

token 数、供应商费用和平台扣额是不同概念。供应商可以对缓存采用不同价格；平台如何扣额度则取决于其结算规则，不能仅凭 `usage` 判断实际金额。

### 输出只有 1 token 怎么理解

token 是模型处理文本的单位，不固定等于一个汉字或一个英文单词。输出 1 token，意味着这次只生成了很短的一段内容。

在本次日志中，最后一次只留下推理片段 `Let`，没有形成正式回答。结合上下文容量、输入用量和结束原因，能看到输出空间不足的迹象。单独看到 `outputTokens: 1`，不能认定所有情况都是上下文已满。

## 4. 怎么判断上下文是否满了

先搜索 `request/context` 或 `contextWindow`，找到与当前请求路由对应的容量记录。本次日志中的记录是：

```json
"contextWindow": 262144
```

再查看同一次模型请求的输入量。本次最后一次输入为 330,930 token，已超过声明的 262,144 token；同时输出只有 1 token，底层以 `length` 结束。这几个信号结合起来，说明该请求存在明显的上下文空间不足问题。

判读顺序：

1. 找到当前提供方、模型及对应的 `contextWindow`。切换过模型时，不要直接使用文件最前面的旧容量。
2. 查看单次请求的输入量，包含缓存读取和已报告的缓存写入。
3. 查看 `stopReason`、DSH 的 `finish.reason` 和错误码。
4. 查看是否出现压缩记录，以及压缩是否成功。

需要注意：

- 上下文容量不是整场会话可以累计使用的 token 额度。
- 不要把全会话累计 `totalTokens` 与 `contextWindow` 比较。
- 输入、输出预留以及服务端的具体限制都会影响可用空间；输入尚未达到窗口，也可能已没有足够空间完成回答。
- 声明容量可能与服务端实际能力不同，SDK 估算也可能与提供方分词不同。只有数字超过声明值，不能证明服务端一定拒绝了请求；还要结合结束原因和错误记录。
- `CONTEXT_WINDOW_EXCEEDED` 也可能由 DSH 根据 SDK 裁剪或响应特征判定，并不一定来自服务端 HTTP 错误。

## 5. 怎么看响应为什么结束

### 底层 `stopReason`

| 值 | 含义 |
|---|---|
| `stop` | 模型正常结束本次响应；不代表用户整个任务必然完成 |
| `toolUse` | 模型要求调用工具，通常还有后续步骤 |
| `length` | 生成受到长度或 token 限制而截断；可能是输出上限，也可能是上下文挤占输出空间 |
| `error` | 提供方或 SDK 报错 |
| `aborted` | 请求被取消或中止 |

搜索 `stopReason` 后，注意它可能位于历史回复的回放元数据中。应同时核对所在事件的 `turn`、`step` 和 `seq`，不要误读为当前请求的结果。

### DSH 的结束分类

流式记录里常见如下结构，以下为结构示意：

```json
{
  "type": "finish",
  "reason": {
    "kind": "max-tokens"
  }
}
```

| `reason.kind` | 含义 |
|---|---|
| `stop` | 本次响应正常结束 |
| `tool-calls` | 进入工具调用阶段 |
| `max-tokens` | 输出被截断 |
| `error` | 请求失败，继续查看 `failure.code` 和 `failure.message` |
| `aborted` | 请求中止 |

`turn/end` 则反映整轮结果，常见 `completed`、`max-tokens`、`error`。工具调用成功不等于最终回复成功；文件也可能已生成，但该轮在收尾时失败。

## 6. 怎么看有没有压缩上下文

建议依次搜索：

```text
compaction/start
compaction/summary
compaction/end
compaction/prune
```

- 没有 `compaction/start`：这份日志中没有记录摘要压缩的启动。
- 有 `compaction/start`：只能证明开始尝试，不能证明成功。
- 有 `compaction/summary`，且配对的 `compaction/end` 没有 `error`：是成功完成摘要压缩的重要证据，可进一步查看替换范围和检查点消息。
- `compaction/end` 带 `error`：压缩失败，继续读错误内容。
- 只有 `compaction/prune`：发生了工具结果裁剪，不等于模型生成了摘要。

同一压缩尝试通过 `compactionId` 配对。不同尝试之间不要混配开始、摘要和结束记录。

### 手动压缩命令

支持该命令的 DSH 客户端中，手动压缩使用：

```text
/compact
```

输入“压缩上下文”只是给模型的一条普通消息，不等于执行 `/compact`。日志中可搜索 `command/run` 和 `command/done` 查看命令执行记录，再结合 `compaction/` 事件判断结果。

## 7. 怎么区分额度耗尽与上下文超限

| 关键字或错误码 | 通常表示 |
|---|---|
| `CONTEXT_WINDOW_EXCEEDED` | 单次请求的上下文空间问题 |
| `max-tokens`、`length` | 输出截断，需要结合请求额度和上下文判断 |
| `QUOTA`、`insufficient_quota`、`quota exceeded` | 账户、平台或提供方的额度问题，需要查看具体错误消息 |
| `RATE_LIMIT`、`rate limit` | 请求速率限制，与额度耗尽不同 |
| `AUTH` | 登录、凭据或权限相关错误 |
| `TIMEOUT` | 请求超时 |
| `TRANSPORT` | 连接中断等传输问题 |

看到 `length` 或 `max-tokens`，不能直接下结论说账户额度耗尽。不同提供方的原始错误措辞可能不同，最终还需要核对服务端结算或额度记录。

## 8. 定位某一次请求和工具调用

| 字段或事件 | 用法 |
|---|---|
| `seq` | 事件在会话日志中的序号，用于定位记录 |
| `turn` | 轮次编号，一轮通常包含多次模型请求 |
| `step` | 轮内步骤；错误恢复或重试可能让同一步包含多个请求尝试 |
| `responseId` | 提供方响应标识，报告时可用于关联具体请求；部分记录可能没有 |
| `tool/call` | 工具名称、参数和调用标识 |
| `tool/result` | 工具输出、错误和退出状态 |
| `callId`、`toolCallId` | 将工具调用与其结果配对 |
| `deliverables/presented` | 已登记向用户呈现的文件；不单独证明文件内容正确或客户端显示成功 |
| `task-progress` | 进度提醒消息的来源标记；部分版本或配置中不存在，且不是完整账单 |

工具结果中的 `isError`、退出码和错误正文需要一起看。某些 shell 管道可能掩盖前面程序的失败，所以退出码为 0 也不能代替检查 `Traceback` 等错误内容。

## 9. 汇总用量时最容易犯的错误

**不要把搜索到的全部 `totalTokens` 直接相加。**

同一次请求的用量可能同时出现在：

```text
assistant/message → data.usage
assistant/message → data.stream → usage 分片
```

这些可能是同一次请求的重复表示。若两处都相加，会重复计数。

但也不能只统计成功的 `assistant/message`：失败的 `assistant/attempt` 可能有已发生的用量，同一步的不同重试也可能分别计费。辅助请求、缺失 usage 和未记录的请求还可能造成统计缺口。

查看单次请求时，优先读该事件的 `data.usage`；没有时再查看对应流中的最后一个 usage 样本。汇总会话时，建议使用诊断脚本，而不是人工按关键字求和。

## 10. 使用汇总脚本

在当前源码仓库中打开 PowerShell：

```powershell
Set-Location 'D:\Code\Bosch\aigc\deepseek-harness'

python .\packages\skill\skill-office\assets\scripts\session_usage.py 'C:\路径\会话日志.zip'
```

只查看指定轮次，例如第 14 轮：

```powershell
python .\packages\skill\skill-office\assets\scripts\session_usage.py 'C:\路径\会话日志.zip' --turn 14
```

脚本可直接读取导出的 ZIP 或 JSONL，无需手动解压。它使用 Python 标准库，不要求安装 Excel 分析库。

输出字段：

| 字段 | 含义 |
|---|---|
| `requests_with_usage` | 取得用量样本并去重后的请求记录数 |
| `settlements_without_usage` | 未取得用量样本的相关记录数，不能据此假定没有消耗 |
| `totals.reported_total` | 统计到的上报总量；缺失 total 时脚本会按已有桶求和，因此仍需结合缺失情况判断 |
| `totals.input` | 非缓存输入合计 |
| `totals.cache_read` | 缓存读取合计 |
| `totals.cache_write` | 缓存写入合计 |
| `totals.output` | 输出合计 |
| `turns` | 按轮统计的请求数、总量和最大单次输入量 |
| `largest_tool_results` | 文本输出最大的几条工具结果，帮助定位上下文膨胀来源 |
| `limits` | 统计范围及限制说明 |

诊断脚本结果用于排查，不能代替平台或提供方的权威账单。

## 11. 快速排查顺序

1. 搜索 `turn/end`，找到出问题的轮次及结束原因。
2. 根据 `turn`、`step`、`seq` 定位最后几次模型请求。
3. 查看 `usage`，区分非缓存输入、缓存读取和输出。
4. 查找对应路由的 `contextWindow`，比较单次输入和剩余输出空间。
5. 搜索 `stopReason`、`CONTEXT_WINDOW_EXCEEDED`，判断是正常结束、截断还是上下文错误。
6. 搜索 `compaction/`，检查是否启动、是否成功以及失败原因。
7. 若怀疑额度耗尽，查找 `QUOTA` 等错误，再核对服务端记录。
8. 用汇总脚本统计用量，避免重复累计流式样本。
