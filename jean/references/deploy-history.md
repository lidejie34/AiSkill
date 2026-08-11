# 部署记录查询

按 `appUk + env` 查询某时间范围内的**历史部署记录**。服务端从 furt 部署历史中逐页拉取并按部署开始时间过滤，返回操作人、版本、成功/失败实例数等统计。

接口为 `POST http://jean.17usoft.com/api/openapi/external/deploy-history`，鉴权使用 **`jean-token`**（与 Jean 主站 API 一致，脚本默认从 `assets/jean-token` 读取）。

> **与「查看部署状态」的区别**：`references/build-deploy.md` 的「查看部署状态」（`/api/mcp/deploy/status`）回答"现在部署到哪了 / 最新状态"；本能力回答"历史记录 / 某时间段发了几次版 / 谁在什么时候发的哪个版本"。用户问历史、时间段、发版次数时用本文件。

---

## 所需参数

| 参数 | 类型 | 必填 | 说明 | 自动检测 |
|------|------|------|------|----------|
| `appUk` | string | 是 | 应用标识（即 furt serviceName） | 由主 SKILL.md 公共步骤识别 |
| `env` | string | 是 | 环境名（`product`/`stage`/`qa` 等） | 需用户指定 |
| `startTime` | string | 否 | 起始时间，格式 `yyyy-MM-dd HH:mm:ss`，需与 `endTime` 成对传入 | — |
| `endTime` | string | 否 | 结束时间，格式同上，不得早于 `startTime` | — |
| `recentDays` | number | 否 | 查询最近 N 天（正整数）；未传时间区间时生效 | — |
| `token` | string | 是 | jean-token | 脚本默认从 `assets/jean-token` 读取 |

**时间范围优先级：**

1. 同时传入 `startTime` + `endTime` → 使用该闭区间（仅传其一无效，脚本会报错）；
2. 否则按 `recentDays` 取最近 N 天；
3. 三者均未传 → 服务端默认查询最近 7 天。

> 本接口是**只读查询**，查询 `product` 环境是允许的，不触发 skill 的「生产环境保护」（该约束仅针对部署/回滚等写操作）。

---

## 调用方式 → `scripts/deploy-history.ts`

当用户说"看看部署记录"、"部署历史"、"上个月发了几次版"、"最近谁部署过"时使用。

```bash
cd {SKILL.md 所在目录} && node --experimental-strip-types scripts/deploy-history.ts \
  --appUk "{appUk}" \
  --env "{env}" \
  [--startTime "2026-04-01 00:00:00"] \
  [--endTime "2026-04-30 23:59:59"] \
  [--recentDays 30]
```

按时间区间查询传 `--startTime` + `--endTime`；按最近天数查询传 `--recentDays`；都不传则查最近 7 天。

**脚本输出：** JSON，含 `success`、`appUk`、`env`、`count`、`records[]`，每条 record 含：

- `opId` — 操作 ID
- `opType` — 操作类型（如 `instanceRebuild`）
- `status` — 部署状态（`success` / `fail`）
- `user` — 操作人（姓名+工号）
- `version` — 部署版本
- `startTime` / `endTime` — 部署开始/结束时间
- `failCause` — 失败原因（成功时为空）
- `successCount` / `failedCount` — 成功 / 失败实例数
- `redeployCount` / `scaleOutCount` / `shrinkCount` — 重新部署 / 扩容 / 缩容实例数

**Agent 拿到输出后：**
- 按 `startTime` 倒序展示，标注每次的操作人、版本、状态。
- 突出失败记录（`status` 为 `fail`，或 `failedCount > 0`），并展示 `failCause`。
- 用户问"发了几次版"时，直接用 `count` 回答，并简列各次版本与时间。
- 若 `success: false`，将 `reason` 告知用户。

---

## 错误处理

- HTTP 401 / token 无效 → 引导走 `references/auth.md` 重新获取 token。
- `code` 不为 200（参数校验失败等）→ 取 `msg`/`reason` 内容告知用户。常见原因：`appUk`/`env` 为空、时间格式非法、`endTime` 早于 `startTime`。
- 网络 / 超时 → 提示用户检查 VPN 或公司内网。
