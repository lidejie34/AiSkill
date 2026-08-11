---
name: analyzing-logs-with-code
description: Use when investigating runtime issues that require correlating SkyEye logs across one or more related UKs, mapping evidence back to source code, and optionally verifying related rows via the UK-bound database MCP.
---

# 日志与代码联合分析

## 概述

当用户需要一条结构化排障链路时使用这个 skill：先只查起始 uk 拿到命中日志，从命中里派生出 `contextId`，再带着 `contextId` 把 uk 组（起始 uk + 它的直接 `related_uks`）一次性打给 SkyEye，最后落到有证据支撑的代码位置——而不是直接给出确定性根因结论。

**范围分两阶段**：首查窄（只起始 uk，噪声低、快），精查宽（起始 uk + 直接 `related_uks` 邻居，已有 `contextId` 锁定链路，噪声低）。不要在首查阶段就把整组打出去；也不要做传递闭包。

这个 skill 由配置驱动。查日志之前必须先加载 `config.yaml` 并通过校验闸门。UK 可通过 `database:` 绑定到 `databases:` 中的 MCP 库，用于日志侧与数据侧交叉验证。

## 何时使用

- 用户希望按 uk、环境、时间范围、关键词排查日志
- 关键词可能是 traceId、contextId、orderId、异常字符串或任意业务字段——不需要用户预先判断类型
- 一条链路可能跨越多个应用 uk
- 用户希望把日志证据映射到代码路径
- 用户希望在同一条排障链路里用 UK 绑定的数据库 MCP 核对落库状态

不要用于写操作、部署或修改配置。数据库绑定一律只读。

## 工作流

1. 询问 `uk`（起始应用）。用户给的往往是简称（`drp.switch`、`pms.order`、`switch`），**必须**先按「uk 名称解析」把它解析成 config 里的完整 appUk，再往下走。
2. 询问 `environment`。
3. 询问时间模式：相对时间窗口或明确起止时间段。
4. 询问关键词或业务标识——**不要**让用户判断它到底是 traceId 还是业务字段，skill 会以模糊匹配为默认查法。
5. **加载 `config.yaml`，完成配置校验闸门**（见下节）。
6. **首查（模糊，窄范围）**：**只对起始 uk** 用 `--indexContext=<文本>` 做一次模糊查询，使用用户给的时间窗口。**禁止**写 `--keyword`（skyeye CLI 无此参数）。此阶段**不要**带上 `related_uks`——见「查询范围的两阶段扩张」。
   - 例外：用户明确说明给的就是 contextId 时，直接 `--contextId=<id>` + 起始 uk，跳过模糊匹配。见「关键词与 contextId 处理规则 → 例外」。
7. **命中处理**：
   - SkyEye 运行时错误（`success=false` 或 body 里 `code=1`）→ hard-stop，提示 `skyeye auth login`。
   - `success=true` 但 `count=0` → **先按「首查空命中的扩张」处理**（见下节），不要立刻结束。
   - 从命中里抽取 `contextId` 字段，去重。
8. **contextId 分支**：
   - 恰好 1 个 contextId → 直接采用，不问用户。
   - ≥2 个 contextId → 按 `(时间, contextId, 首条日志摘要, uk)` 列候选，让用户选。用户的问法已经隐含唯一答案时（如"最新一次"、"最后那次失败"），按该语义自行选定并说明选了哪个，不必再问。
   - 0 个可用 contextId → 走"线程栈回退路径"（见下节）。
9. **精查（focus，宽范围）**：对选定的 contextId，一次性打给 **uk 组 = 起始 uk + 它的直接 `related_uks` 邻居**（不做传递闭包），并**自动收敛时间窗**到 `[首条命中时间 − 5min, 末条命中时间 + 5min]`。contextId 已锁定链路，未参与的邻居自然返回 0 条。
10. **代码关联**：对每个有日志命中的 uk，按下面的优先级搜索：
    1. 日志栈里出现的 FQCN + 行号（最强证据，通常一步命中）；
    2. 异常类名；
    3. 日志文案 / 业务字段名。
    `code_root` 缺失或不可读时标记状态，保留日志分析结果。
11. **数据库交叉验证**（见下节「数据库绑定」）：若 uk 组内存在可用的 `database` 绑定且当前 `environment` 匹配，从日志/关键词中提取业务主键，用绑定的 MCP **只读**查库，把结果并入输出。
12. **输出**：默认给**信号级时间线**（见输出格式）。用户明说"给我完整时间线"时才全量。

## uk 名称解析（简称 → 完整 appUk）

**SkyEye 的 `--appUks` 只认完整应用标识，不做任何前缀补全或模糊匹配。** 传 `drp.switch` 而不是 `titc.java.drp.switch`，返回的是 `查询失败: 部分应用查询失败,失败应用参数信息=[drp.switch]` —— 和「uk 数过多」是**同一个报错文案**，极易被误判成需要减半重试，从而在一个根本不存在的 uk 上反复浪费查询。

用户在对话里基本都用简称（`drp.switch`、`pms.order`、`switch`、`开放平台`）。**在发起任何 SkyEye 查询之前**，先把它解析成 `config.yaml` 里 `uks:` 下的完整 key：

1. **精确匹配**：输入已经是 `uks:` 的某个 key → 直接用。
2. **后缀匹配**：`uks:` 中是否恰好有一个 key 以 `.<输入>` 结尾（`drp.switch` → `titc.java.drp.switch`）→ 采用。
3. **子串 / display_name 匹配**：在 key 与 `display_name` 里找包含该输入的项。
4. 命中 ≥2 个 → **列出候选让用户选**，不要替用户挑（`pms.order` 会同时命中 `titc.java.dubbo.pms.order` 和 `titc.java.pms.bridge.order`；`switch` 会同时命中 `titc.java.drp.switch` 和 `titc.java.pms.openapi.switch`，前者是 OTA 渠道入口、后者是开放平台，两条完全不同的链路）。
5. 命中 0 个 → hard-stop，告知该 uk 未在 `config.yaml` 中定义，并列出 `uks:` 里最接近的几个供用户确认。**不要**凭 `titc.java.` + 输入猜一个 appUk 去试。

解析结果**只要不是精确匹配**，就在首次查询前告诉用户实际用的完整 uk（如「按 `drp.switch` 解析为 `titc.java.drp.switch`」），让用户有机会纠正走错了链路。

`related_uks` 里的成员同样必须是完整 appUk —— 它们直接进 `--appUks`，一个写错就会让整次精查失败。

**config 之外的 uk 同理。** 排障常会追到 `uks:` 未收录的下游（如 cdm 的 `titc.java.dubbo.core.data`），此时完整 appUk 靠猜是猜不到的（`cdm` → `core.data` 毫无字面关系）。正确做法是去该服务的代码仓里读：`grep -rn "appUk=" <repo> --include="tcbase.properties"`，按目标环境取值（同一仓不同 module / 环境的 appUk 常常不同）。查到后建议用户补进 `config.yaml`。

## 配置校验闸门

加载 `config.yaml` 后，一次性完成以下校验，任一项失败立即 hard-stop 并精确指出失败项：

- 请求的 `uk` 存在于 `uks:` 下。
- 请求的 `environment` 存在于该 uk 的 `environments`（或 `defaults.environments`）。
- `code_root` 在配置中已定义。
- `query.query_hints` 在配置或 defaults 中定义。
- 起始 uk 的 `related_uks` 中每个成员都是 `uks:` 下已定义的合法 uk。
- **uk 组内**（起始 uk + 1 跳邻居）所有 uk 都通过上述校验（包括环境是否支持）。校验范围与查询范围一致——**不要**去校验整个连通分量。
- 若某 uk 声明了 `database:`：该 key 必须存在于顶层 `databases:`；且当前 `environment` 必须在该 database 的 `environments` 中（否则本轮跳过查库，标记 `DB: SKIPPED_ENV`，**不** hard-stop）。
- `databases.*.mcp_server`、`database`、`query_tool` 必须有值；`readonly` 必须为 `true`（若显式为 false → hard-stop，本 skill 禁止写库）。

`code_root` 存在但运行时路径不可读：**不** hard-stop，标记该 uk 的代码关联为 `UNREADABLE`，日志分析照常输出。

MCP server 不可用 / 连接失败：**不** hard-stop，标记 `DB: UNAVAILABLE`，日志与代码分析照常输出。

## 查询范围的两阶段扩张

`related_uks` 按**无向图**处理：只要 A 声明了 B，A 和 B 互为邻居，双向生效。用户不需要在两端各写一遍。

**uk 组的定义：起始 uk + 它的直接 `related_uks` 邻居（BFS 1 跳）。不做传递闭包。**

即 `组 = {起始 uk} ∪ neighbors(起始 uk)`。邻居的邻居**不算**在内。

为什么不用连通分量：实际 config 里业务域之间往往存在桥接 uk（一只脚在 A 域、一只脚在 B 域），无向闭包会把整张图连成一片，「连通分量」退化成「全部 uk」，既起不到收窄作用，又会超出 SkyEye 单次可查的 uk 数上限。1 跳邻居正好对应「本应用直接调用/被调用的上下游」，是同一条同步链路最可能落日志的范围。

若 1 跳不够（怀疑链路更远、或组内某 uk 有命中但明显不是终点），**由用户显式要求**再扩到 2 跳或指定 uk，不要自动扩。

### 阶段一：首查只打起始 uk

```
skyeye queryLog --appUks=<起始 uk> --indexContext=<关键词> --env <env> --minutes N
```

目标只有一个：拿到 `contextId`。范围越窄，噪声越低、越快。

### 阶段二：精查打 uk 组（起始 uk + 1 跳邻居）

拿到 `contextId` 后，对 uk 组一次性查询：

```
skyeye queryLog --appUks=<起始 uk>,<邻居1>,<邻居2>,... --contextId=<id> --begin ... --end ...
```

`contextId` 已经把链路锁死，带上没参与本次链路的邻居不会引入噪声（它们返回 0 条）。不要按 uk 逐个串行查询。

多数 uk 的 1 跳组只有 2–3 个，天然落在 SkyEye 的可查规模内，不需要取子集。但**枢纽 uk 例外**：当前 config 里 `titc.java.drp.job`（16）、`titc.java.dsf.drp`（15）声明了大量邻居，1 跳组本身就可能超限。以枢纽 uk 为起点时，先按下面的减半重试处理，并履行「uk 组过大时的说明义务」。

**若这一步返回 `部分应用查询失败`**：先看方括号里的失败 uk 名字。若是名字不合法（简称、拼错），回「uk 名称解析」重解；若失败列表很长，才是单次 uk 数超了 SkyEye 的承受范围。实测该阈值**不稳定**——曾见 15 个成功、12 个失败，同一批 uk 不同时段表现也不同。处理方式：**逐步减半重试**（如 12 → 6 → 3），成功后按「uk 组过大时的说明义务」说明实际查了哪些。不要预设某个具体数字是安全的。

另外注意 SkyEye 有**限流**：短时间内密集查询会返回 `失败: 日志查询接口返回状态码 429`。这是限流不是无数据，也不是那个 uk 有问题——间隔几十秒重试即可。批量探测时务必放慢节奏。

### 首查空命中的扩张

首查 `count=0` 时，**不要**立刻下"没有日志"的结论，按顺序尝试：

1. 检查时间参数拼写（`--begin/--end` 或 `--minutes`，见「常见错误」）。
2. 把范围扩到 **uk 组**（起始 uk + 1 跳邻居），重查。
3. 仍为 0 且用户认为链路应该更远，**询问用户**是否扩到 2 跳或指定 uk，不要自动扩。
4. 仍为 0 → 提示用户调整时间范围或关键词。

每次扩张都要告诉用户当前用的是哪一档范围。

### uk 组过大时的说明义务

多数起始 uk 的 1 跳组只有 2–3 个，不涉及取舍。但若起始 uk 的 `related_uks` 声明得很多（如 > 8 个，典型是 `drp.job`、`dsf.drp` 这类枢纽 uk），或精查因 `部分应用查询失败` 而不得不减半重试，**必须**告诉用户实际查了哪些 uk、共几个、按什么标准取的子集。若你判断该跳过某些 uk（例如明显与本次问题无关的其他渠道推送 job），**必须显式说明跳过了哪些、理由是什么**——不要默默收窄。

若组内某个 uk 在 SkyEye 侧返回失败但整体调用成功，显式列出失败 uk，保留其余命中继续分析。**不要**把失败误写成"未参与"。

## SkyEye 运行时错误处理

- HTTP 层错误 / `success=false` / body 里 `code=1`（权限过期）→ **hard-stop**，明确提示"请执行 `skyeye auth login` 后重试"。
- `失败: 日志查询接口返回状态码 429` → **限流**。不是无数据、也不是该 uk 有问题。间隔几十秒重试；批量探测时放慢节奏。
- `查询失败: 部分应用查询失败,失败应用参数信息=[...]` → 整次查询失败（非 0 退出），**没有**部分结果可用。这个文案有**两种**成因，先看方括号里的 uk 名字再决定怎么办：
  1. **uk 名字不合法**（不是完整 appUk、拼错、或该 uk 在 SkyEye 侧不存在）—— 典型是把简称 `drp.switch` 当 appUk 传了。特征是失败列表里就那一两个 uk，且名字缺 `titc.java.` 这类前缀。→ 回「uk 名称解析」重新解析，**不要**减半重试（uk 只有 1 个，减半减不下去）。
  2. **单次 uk 数过多**（实测 26 必失败、15 正常，阈值不稳定）—— 特征是失败列表很长。→ 逐步减半重试。
- HTTP 200 且 `success=true` 但 `count=0` → 数据侧空命中，走「首查空命中的扩张」。

这四种情况互不相同，不要混为一谈——尤其不要把限流或 uk 数超限说成"没有日志"。

## 时间窗策略

- **首查（模糊）**：使用用户输入的时间窗口。
- **精查（focus）**：一旦从首查选定 contextId，把时间窗口自动收敛到 `[首条命中时间 − 5min, 末条命中时间 + 5min]`。
- 若用户明确希望使用更宽的时间窗（例如查异步补偿），跳过自动收敛，使用用户值。

## 关键词与 contextId 处理规则

用户提供的关键词可能长得像 32 位十六进制的 traceId，但实际上可能是 authCode、requestId、加密串或任意业务字段。

**永远不要**把关键词直接当 `--contextId=` 精查，也**不要**使用无效的 `--keyword`。**始终**先用 `--indexContext=<文本>` 模糊匹配，再从命中日志的 `contextId` 字段派生真正的链路 id。

如果首查用模糊匹配命中了日志但所有条目都没有 `contextId` 字段，才转"线程栈回退路径"。

### 例外：用户明确给出 contextId

上面这条规则针对的是"关键词类型未知"的情况。如果**用户明确说明**给的就是 contextId / 链路 id（而不是让你去猜），跳过模糊首查这一步，直接用 `--contextId=<id>` + **起始 uk** 查询：

```
skyeye queryLog --appUks=<起始 uk> --contextId=<id> --env <env> --minutes N
```

链路已经被 contextId 锁定，不需要再从关键词派生。仍然**先只带起始 uk**——确认这个 contextId 在起始 uk 上确实有命中、时间落点在哪，再按「阶段二」扩到更大范围。

判断依据是用户的措辞（"这个 contextId"、"链路 id 是 xxx"、"trace 是 xxx"），不是字符串长得像不像 32 位十六进制。**长得像不算明确**——那正是本节开头警告的陷阱。

## 线程栈回退路径

仅在首查有命中但**无 contextId** 时启用：

1. 明确告知用户："未拿到 contextId，将改用线程栈匹配。"
2. 从命中里提取线程栈签名，如有多个，列出 `(时间, 线程栈头部, 首条日志摘要, uk)` 让用户选。
3. 用选中的线程栈签名到 uk 组内查询（与精查同档范围：起始 uk + 1 跳邻居）。
4. 后续代码关联流程与常规路径一致。

## 代码分析

对每个有日志命中的 uk：

1. **优先**在 `code_root` 下（受 `code_include` 收窄）搜索日志栈中出现的 `FQCN + 行号`——例如 `OrderSubmitOrder2Handler.java:122`。通常一步命中，不要跳过这一步。
2. 再搜异常类名（`NumberFormatException`、`ServiceException` 等）在业务代码中的抛出点。
3. 最后搜日志正文（中文文案 / 业务字段名 / 错误码常量）以定位没有栈的日志点。

`code_include` 是可选的 glob 数组，用来在包含多个 Maven module 的 `code_root` 里收窄搜索范围，避免命中兄弟模块。

输出必须基于证据，未证实的推测不能写成结论。

## 数据库绑定

从 `config.yaml` 的 `databases:` + `uks.*.database` 解析绑定。

### 何时查库

满足全部条件时执行步骤 11：

1. uk 组内至少有一个 uk 配置了 `database:`，且该 database 的 `environments` 包含当前环境。
2. 从日志正文 / 用户关键词中能提取到可用于 WHERE 的业务标识（如 orderId、hotelId、mchCode、主键 id 等）。
3. 用户未明确禁止查库。

若组内多个 uk 指向同一 `databases` key，只查一次，不要重复打 MCP。

### 怎么查

1. 使用对应 `mcp_server` 上的 `query_tool`（当前为 `mysql_query`）。
2. **只允许 SELECT**；禁止 INSERT/UPDATE/DELETE/DDL。
3. 查询要带 `LIMIT`（默认 ≤ 20），先确认表/字段再查，避免盲扫大表。
4. 查不到行时写 `DB: NO_ROW`，不要改写成“库连不上”。
5. 密码与连接细节只存在于本机 MCP 配置（`~/.cursor/mcp.json`），不要回显密码。

### 与日志的关系

- 数据库结果是**旁证**，用来核对落库状态 / 配置是否与日志描述一致。
- 日志说失败但库里已是成功态（或相反）→ 列入「待确认点」，不要直接当根因。

## 分析边界

默认输出：

1. **信号级时间线**（`priority=1 ERROR` + 入口 controller + 抛异常点 + 响应组装点 + 关键状态转换）。
2. 相关代码位置（带 `code_root` 状态标注）。
3. 数据库旁证（若执行了步骤 11；带 `DB:` 状态标注）。
4. 仍需人工确认的判断点。

用户显式要求（"给我完整时间线"、"全部日志都列出来"）时才输出组内所有命中的合并时间线。

除非用户明确要求推测，不要把根因说成确定事实。

## 偏离披露

如果实际执行偏离了本 skill 规定的路径——换了查询范围档位、跳过了某个步骤、用了不同的收窄策略——**必须在输出的「执行偏离」小节显式写出偏离点、理由、以及对结论的影响**。

偏离本身通常是合理的（工程判断），但把偏离藏起来不行：用户会以为结论是按规定流程得出的，从而高估覆盖面。不要把一次主动的规则偏离写成"可选的后续步骤"或含糊的"如有需要可以再查"。

## 输出格式

### 合并时间线（默认：信号级）
- `<timestamp>` - `<uk-name>` - `<关键日志摘要>`

### 相关代码
- `<uk-name>` (code_root: OK | MISSING | UNREADABLE)：`<文件路径>` - `<类/方法或等价入口位置>` - `<为什么相关>`

### 数据库旁证
- `<database-key>` (DB: OK | SKIPPED_ENV | UNAVAILABLE | NO_ROW | NO_KEY)：`mcp=<mcp_server>` / `<简要查询条件>` → `<关键字段摘要或空>`

### 查询范围
- 首查：`<起始 uk>`（1 个）→ contextId `<id>`
- 精查：uk 组 `<N>` 个（起始 uk + 1 跳邻居）/ 有命中：`<列表>` / 无命中：`<列表>`
- 减半重试或跳过：`<有则列出 + 理由>`（无则写"无"）

### 待确认点
- `<仍需人工确认的点>`

### 执行偏离（仅在偏离本 skill 规定路径时输出）
- `<偏离了哪条规则>` - `<为什么>` - `<对结论的影响>`

## 常见错误

- 没有先校验 `config.yaml` 就直接开始查 SkyEye。
- 把 `success=false` / `code=1` 当成"数据空命中"，实际是权限过期。
- 把关键词直接当 `contextId` 精查，命中 0 条就下"没有日志"的错误结论——应始终先 `indexContext` 模糊匹配。**除非**用户明确说了那就是 contextId。
- 反过来，用户已经明确给出 contextId，还绕一圈去做 `indexContext` 模糊匹配再派生——多一次无用查询。
- 多个 contextId 时自动替用户选一个。
- 首查阶段就把整个 uk 组打出去。首查**只打起始 uk**；扩大范围是精查（已有 contextId）才做的事。
- 反过来，精查阶段还只查起始 uk，白白丢掉跨应用链路——有了 contextId 就该扩范围。
- 把用户口语里的简称（`drp.switch`、`pms.order`）**原样**当 `--appUks` 传给 SkyEye。CLI 不做前缀补全，只会返回 `部分应用查询失败`。必须先按「uk 名称解析」查 `config.yaml` 拿到完整 appUk。
- 看到 `部分应用查询失败` 就一律当成 "uk 数过多" 去减半重试，没看方括号里的 uk 名字是否合法——单个非法 uk 减半减不下去，只会白跑。
- 简称同时命中多个 uk（`switch` → `drp.switch` / `pms.openapi.switch`）时替用户挑一个，结果查错了整条链路。
- 追到 config 未收录的下游 uk 时靠字面猜 appUk（`cdm` 猜成 `titc.java.cdm`，实际是 `titc.java.dubbo.core.data`）。应去该仓 `grep "appUk=" --include="tcbase.properties"` 按环境取准确值。
- 精查一次带太多 uk 导致 SkyEye 整次失败（`部分应用查询失败`）而不是返回部分结果。确认 uk 名字都合法后，再按 uk 数过多逐步减半重试；不要以为那些 uk 真的没日志。
- 把 uk 组理解成连通分量／传递闭包。**uk 组 = 起始 uk + 它的直接 `related_uks`，只 1 跳**；要更远必须由用户显式要求。
- 把 `429`（限流）当成"这个 uk 没有日志"或"这个 uk 有问题"。间隔几十秒重试即可。
- 忽略 `related_uks`，或只按声明方向单向扩展——`related_uks` 必须按**无向图**处理。
- 首查 `count=0` 就直接结论"没有日志"，没走「首查空命中的扩张」（查时间参数 → 1 跳邻居 → uk 组）。
- 精查时默默跳过部分 uk 而不说明，或反过来在 uk 组很大时不告知用户实际查询范围。
- 有 contextId 后还按 uk 串行查询，而不是一次性打给同一个 uk 组。
- 组内多 uk 查询里部分 uk 失败时把失败误写成"未参与"。
- 精查阶段不收敛时间窗，用首查的大窗口打组内多 uk，导致 SkyEye 慢或超时。
- 代码关联时不优先用栈里的 FQCN+行号，反而先 grep 中文文案，绕远路。
- `code_root` 不可读时假装代码关联完整。
- 把推测写成已确认的根因。
- 默认输出组内所有命中的合并时间线（几十上百条），没有做信号级降噪，让用户自己找 ERROR。
- 用了错误的时间参数名（例如 `--startTime/--endTime`）。skyeye CLI 只认 `--begin/--end`（时间格式 `YYYY-MM-DD HH:mm:ss.SSS`）或 `--minutes N`；未知选项会被**静默丢弃**并降级到默认时间窗（最近 15 分钟），造成 `success=true, count=0` 的假空命中。看到"UI 能查到、这里查不到"时**优先怀疑时间参数拼写**。
- 用 `skyeye queryLog --help` 探测用法。这个子命令不认 `--help`，会误报 `queryLog 要求至少填写应用标识(--appUks)或链路ID(--contextId)`——那不是真正的必填缺失，只是把整行当成了没有有效参数。查用法要用顶层 `skyeye --help`。
- uk 已绑定 database 且环境匹配、日志里也有业务主键，却完全不查库。
- 对绑定库执行写 SQL，或把 MCP 连接失败说成“库里没有数据”。
- 把数据库旁证直接写成已确认根因。
- 偏离了 skill 规定路径却不在「执行偏离」小节说明，让用户以为结论是按完整流程得出的。
- 关键词命中了下游的 `IN (...)` 批量 SQL（业务号只是几百个值之一），却把它当成本次链路的证据。
