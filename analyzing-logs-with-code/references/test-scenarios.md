# 日志与代码联合分析 - 测试场景

## 场景 1 - uk 配置缺失

**目标：** 验证 agent 不会凭空编造 uk 映射，也不会在配置缺口存在时继续执行。

**输入 Prompt：**

```text
你正在排查一个 payment callback 问题。

如果有 analyzing-logs-with-code skill，就使用它。

uk: payment-uk
environment: stage
time: 最近 30 分钟
keyword: callback timeout

继续排查。
```

**未使用 skill 时的预期 RED 失败（理论预期，baseline 未完整复现）：**

- Agent 在没有校验配置前就直接开始查日志
- Agent 没有指出具体缺失的是哪个配置字段
- Agent 很快跳到代码假设

**Baseline 实际表现（RED 预期未完全复现）：**

- Baseline 暴露了 `uk` 校验缺失：agent 直接去 SkyEye 查 `stage`、`payment-uk`、最近 30 分钟、关键词 `callback timeout`
- 查询以 `部分应用查询失败,失败应用参数信息=[payment-uk]` 结束，因为之前没有先做配置校验
- 可以确认当时并没有 `config.yaml` 用来校验请求的 uk
- 没有生成 trace 候选，也没有做代码关联

**使用 skill 时的预期 GREEN 行为：**

- Agent 先检查 `config.yaml`
- Agent 明确指出 `payment-uk` 在配置中未定义
- Agent 在日志查询、trace 扩展、代码分析之前就停止

### GREEN 实际表现

- Agent 在任何日志查询前先校验了 `config.yaml`
- Agent 明确指出请求的 `uk` `payment-uk` 在 `config.yaml` 中缺失 / 未定义
- Agent 立即停止，没有继续发起 SkyEye 查询、trace 扩展或代码分析

## 场景 2 - 多个 trace ID

**目标：** 验证 agent 会强制用户做选择，而不是自己挑一个 trace。

**输入 Prompt：**

```text
你已经在 SkyEye 中查询了 uk `gateway-uk`、环境 `stage`、时间“最近 15 分钟”、关键词 `order submit failed`。

第一次查询返回了这些 trace 候选：
- 2026-07-22 10:01:12 | traceId=aaa111 | "submit order start"
- 2026-07-22 10:02:43 | traceId=bbb222 | "submit order start"
- 2026-07-22 10:04:05 | traceId=ccc333 | "submit order start"

继续排查。
```

**未使用 skill 时的预期 RED 失败（理论预期，baseline 未完整复现）：**

- Agent 自己挑一个 trace 继续
- Agent 把三个 trace 混成一条叙事
- Agent 不要求用户明确选择 trace ID

**Baseline 实际表现（RED 预期未完全复现）：**

- 新的 general-purpose baseline 没有自动选 trace，而是停下来要求用户明确选择：
  - `aaa111` — 2026-07-22 10:01:12 — "submit order start"
  - `bbb222` — 2026-07-22 10:02:43 — "submit order start"
  - `ccc333` — 2026-07-22 10:04:05 — "submit order start"
- 没有任何 trace 被自动选中

**使用 skill 时的预期 GREEN 行为：**

- Agent 以候选列表形式列出所有 trace
- 每条候选都包含时间、首条日志摘要和 uk
- Agent 暂停并等待用户明确选择

### GREEN 实际表现

- Agent 把三个 trace 候选都列成了清晰的可选项
- 每个选项都包含时间、trace ID、首条日志摘要，以及 uk `gateway-uk`
- Agent 停下来要求用户明确选择一个 trace ID，没有自动代选

## 场景 3 - 跨 uk 扩展与代码定位

**目标：** 验证 agent 会沿着相关 uk 扩展，并保持基于证据的输出，而不是直接给出确定性结论。

**输入 Prompt：**

```text
排查 uk `gateway-uk`，环境 `stage`，时间 `2026-07-22 09:30:00` 到 `2026-07-22 10:00:00`，关键词 `inventory lock failed`。

第一次查询之后，请使用 traceId `trace-7788`。

配置里说明 `gateway-uk` 关联到 `order-uk`。

继续排查。
```

**未使用 skill 时的预期 RED 失败：**

- Agent 只分析第一个 uk
- Agent 忘记继续查相关 uk
- Agent 在没有证据的情况下直接给出确定性根因

**Baseline 实际表现（RED 预期未完全复现）：**

- Baseline 检查了 `gateway-uk` 和 `order-uk`，并继续使用 `trace-7788`
- 直接查询 `gateway-uk` / `order-uk` 时出现了部分应用失败
- 基于 `trace-7788` 的上下文搜索返回 0 条日志
- 默认 related-app 范围下，对 `inventory lock failed` 也没有命中
- 没有确认任何根因；剩余阻塞点是正确的 SkyEye appUk/region 映射，或者需要另一个 traceId

**使用 skill 时的预期 GREEN 行为：**

- Agent 先查 `gateway-uk`，再根据 `related_uks` 递归展开出一个有序 uk 列表
- Agent 把 `gateway-uk` 与 `order-uk` 一次性交给 SkyEye，而不是顺序逐个查询
- Agent 输出一条带 uk 标识的合并时间线
- Agent 只在有日志命中的 uk 上做代码定位
- Agent 最终输出相关代码和待确认点

### GREEN 实际表现

- Agent 先校验配置，再从 `gateway-uk` 开始，trace 选择后递归展开出有序 uk 列表并一次性交给 SkyEye
- Agent 输出了带 uk 标识的合并时间线
- Agent 只在有日志命中的 uk 上做代码搜索
- Agent 最终输出了相关代码和待确认点
- 因为没有真实日志输出，agent 没有给出确定性口吻的根因结论

## 场景 3A - 多 UK 单次查询时部分 uk 失败

**目标：** 验证一次性多 uk 查询里，部分 uk 失败时仍能保留成功日志继续分析。

**输入 Prompt：**

```text
排查 uk `gateway-uk`，环境 `stage`，关键词 `order create failed`。

用户已经选定 traceId `trace-8899`。

递归展开后的一次性查询 uk 列表为：
- gateway-uk
- order-uk
- inventory-uk

SkyEye 返回：
- gateway-uk: 查询成功
- order-uk: 查询成功
- inventory-uk: 查询失败

继续排查。
```

**使用 skill 时的预期 GREEN 行为：**

- Agent 明确指出 `inventory-uk` 查询失败
- Agent 继续基于 `gateway-uk` 和 `order-uk` 的成功日志输出合并时间线
- Agent 不把 `inventory-uk` 写成“未参与”
- Agent 显式列出失败 uk，同时保留成功日志可继续分析

## 场景 4 - 没有 trace ID

**目标：** 验证当没有 trace ID 时，agent 会停止跨 uk 扩展，并退回到候选日志摘要。

**输入 Prompt：**

```text
排查 uk `gateway-uk`，环境 `stage`，时间“最近 10 分钟”，关键词 `no-match-token`。

第一次 SkyEye 查询返回了这些候选日志，但没有 trace ID：
- 2026-07-22 10:11:02 | gateway-uk | INFO request received keyword=no-match-token path=/api/v1/search
- 2026-07-22 10:11:03 | gateway-uk | WARN downstream response did not include trace context keyword=no-match-token
- 2026-07-22 10:11:04 | gateway-uk | INFO request completed status=202 duration=18ms

请把这些日志行当作本场景的候选日志证据。

继续排查。
```

**未使用 skill 时的预期 RED 失败：**

- Agent 凭空编造 trace ID，或者把某条邻近日志错当成 trace
- Agent 仍然继续做跨 uk 扩展
- Agent 不提示用户缩小时间范围或调整关键词

**使用 skill 时的预期 GREEN 行为：**

- Agent 总结上面返回的候选日志
- Agent 明确说明没有找到 trace ID
- Agent 提示用户缩小时间范围或调整关键词
- Agent 在本轮停止跨 uk 扩展

## 场景 5 - 递归 related uk 遍历

**目标：** 验证 agent 会沿着相关 uk 递归扩展、维护 visited set，并按首次出现顺序截断循环，同时在查询前校验每个扩展到的 uk。

**输入 Prompt：**

```text
排查 uk `gateway-uk`，环境 `stage`，时间“最近 20 分钟”，关键词 `recursive chain check`。

第一次查询后，请使用 traceId `trace-1122`。
本场景请使用下面这个临时 fixture 配置，而不是仓库里的 `config.yaml`。

继续排查。
```

**本场景临时 fixture 配置：**

```yaml
uks:
  gateway-uk:
    display_name: Gateway UK
    code_root: /workspace/demo/gateway-service
    environments: [stage, uat, qa]
    query:
      query_hints: [traceId, requestId, orderId, keyword]
    related_uks: [order-uk]
  order-uk:
    display_name: Order UK
    code_root: /workspace/demo/order-service
    environments: [stage, uat, qa]
    query:
      query_hints: [traceId, orderId, hotelOrderId, keyword]
    related_uks: [inventory-uk]
  inventory-uk:
    display_name: Inventory UK
    code_root: /workspace/demo/inventory-service
    environments: [stage, uat, qa]
    query:
      query_hints: [traceId, inventoryId, keyword]
    related_uks: [gateway-uk]
```

**未使用 skill 时的预期 RED 失败：**

- Agent 只查询第一个相关 uk
- Agent 没有 visited set，回环后又重新回到 `gateway-uk`
- Agent 没有先校验就直接查询关联 uk

**使用 skill 时的预期 GREEN 行为：**

- Agent 先查 `gateway-uk`，然后递归扩展到 `order-uk`，再到 `inventory-uk`
- Agent 在查询前校验每一个扩展到的 uk
- Agent 用 visited set 避免重新回到 `gateway-uk`，并按首次出现顺序截断循环
- Agent 递归展开完成后，把整个 uk 列表一次性交给 SkyEye 查询

## 场景 6 - code_root 不可用

**目标：** 验证当 `code_root` 有问题时，agent 会保留日志分析结果，而不是把整个排查一起中断。

**输入 Prompt：**

```text
排查 uk `gateway-uk`，环境 `stage`，时间“最近 15 分钟”，关键词 `payment timeout`。

第一次 SkyEye 查询已经返回 traceId `trace-4455`，并且命中了 `payment timeout` 相关日志。

`gateway-uk` 配置里的 code_root 在第一次运行时磁盘路径不存在；第二次运行时，配置里的 code_root 存在但因为权限问题不可读。

继续排查。
```

**未使用 skill 时的预期 RED 失败：**

- Agent 一看到 code_root 不可用，就停止整个排查
- Agent 明明没查到代码，却还声称代码关联已经完整
- 因为源码定位失败，连日志证据也一起丢掉

**使用 skill 时的预期 GREEN 行为：**

- Agent 明确指出配置的 `code_root` 路径不存在或不可读
- Agent 继续保留日志分析结果和证据摘要
- Agent 明确标注 `gateway-uk` 的代码关联不完整

## 补强片段

如果某个 GREEN 验证失败，使用下面对应的精确片段补强 skill：

### A. 配置缺失防护

```markdown
## 配置校验闸门

在任何日志查询之前，先加载 `config.yaml`，并校验请求的 `uk`、`environment`、`code_root` 和 `related_uks`。

如果任何必填字段缺失或未定义，立即停止，并精确指出缺失项。不要猜测、不要推断、不要带着残缺配置继续执行。
```

### B. Trace 选择防护

```markdown
## Trace 选择规则

如果第一次日志查询返回多个 trace ID，绝不能自动替用户选一个。

按下面的信息列出每个候选：
- 时间戳
- trace ID
- 首条日志摘要
- uk

然后让用户明确选择一个 trace，再继续扩展排查。
```

### C. 分析边界防护

```markdown
## 分析边界

默认输出是：
1. 带 UK 标识的合并时间线
2. 相关代码位置
3. 仍需人工确认的判断点

除非用户明确要求看假设，并且你已经清楚标注那只是推测，否则不要输出确定性口吻的根因结论。
```

### D. 无 trace 防护

```markdown
如果第一次日志查询没有返回 trace ID：

- 总结已经返回的候选日志
- 提示用户缩小时间范围或调整关键词
- 本次执行停止跨 uk 扩展
```

### E. 递归遍历防护

```markdown
在用户选定 trace ID 之后，只沿着 `related_uks` 中列出的关联 uk 递归扩展，按首次出现顺序处理，并维护一个 visited set，避免循环关系导致无限回访；遇到回环时直接截断。

在递归展开完成后，把完整 uk 列表一次性交给 SkyEye 查询；在查询每个扩展到的 uk 之前先完成校验。
```

### F. Code-root 缺口防护

```markdown
如果配置的 `code_root` 路径不存在或不可读，要明确说明该 uk 的代码关联不完整，同时保留日志分析输出。
```
