# 流水线管理

Jean 平台的流水线（Pipeline）部署在 `matrix.17usoft.com`，与构建/部署接口分属不同子系统，
但鉴权使用同一个 token —— 区别在于请求头名为 **`mptoken`**（而非 `jean-token`），值与 `jean-token` 相同。

本文件覆盖三类操作：查看流水线列表、执行流水线（含自动轮询）、查看执行记录。

---

## 所需参数

| 参数 | 类型 | 必填 | 说明 | 自动检测 |
|------|------|------|------|----------|
| `appUk` | string | 列表场景必填 | 应用标识 | 由主 SKILL.md 公共步骤识别 |
| `pipelineId` | number/string | 执行 / 查询执行记录场景必填 | 流水线 ID | 由"查看流水线列表"返回 |
| `token` | string | 是 | mptoken（值同 jean-token） | 脚本默认从 `assets/jean-token` 读取 |
| `branch` | string | 否 | 覆盖 bindApp 默认分支 | 不传则沿用上一次执行的分支 |
| `env` | string | 否 | 覆盖 bindApp 默认环境（允许 `product`，由服务端白名单校验） | 不传则沿用上一次执行的环境 |
| `instances` | string | 否 | 指定部署实例 **id**（逗号分隔）；映射为 api-run 的 `triggerClients` | 不传 = 部署全部实例；灰度时先用 `instance-list.ts` 按 IP 选 id |

---

## 一、查看应用流水线列表 → `scripts/pipeline-list.ts`

当用户说"看看流水线"、"这个应用有哪些流水线"、"流水线列表"时使用。

```bash
cd {SKILL.md 所在目录} && node --experimental-strip-types scripts/pipeline-list.ts \
  --appUk "{appUk}" \
  [--page 1] \
  [--pageSize 10]
```

**脚本输出：** JSON，含 `success`、`total`、`pipelines[]`，每条 pipeline 含：

- `id` — 流水线 ID（执行 / 查询记录时使用）
- `name` — 流水线名称
- `leader` — 负责人（姓名(工号) 格式）
- `lastStatus` / `lastTrigger` / `lastTriggerPerson` / `lastTime` — 最近一次执行的状态、触发方式、触发人、时间
- `env` / `branch` — 上一次执行用到的环境与分支（执行时如未指定 `--env`/`--branch` 将沿用此值）
- `executionCount` — 总执行次数
- `stages` — 各节点（stage）名称数组

**Agent 拿到输出后：**
- 按 `lastStatus` / `env` 分组展示，便于用户快速定位想要的流水线
- 同时呈现 `id` 和 `name`，让用户用任一形式选择目标流水线
- 若 `success: false`，将 `reason` 告知用户（常见为 token 过期 → 重走 `references/auth.md`）

---

## 二、执行流水线 → `scripts/pipeline-run.ts`

当用户说"跑一下流水线"、"执行 pipeline"、"触发流水线"时使用。

```bash
cd {SKILL.md 所在目录} && node --experimental-strip-types scripts/pipeline-run.ts \
  --pipelineId "{pipelineId}" \
  [--branch "{branch}"] \
  [--env "{env}"] \
  [--instances "{id1},{id2}"]
```

**脚本自动处理的逻辑（无需 Agent 手动管理）：**
- 调用 `http://tccommon.17usoft.com/oauth/rs/getuserinfo`（multipart/form-data，字段 `access_token`）获取 username + workId，自动构造 `triggerPerson = {username}({workId})`
- 通过 `/pipeline-execution?pipelineId=...&page=1&pageSize=1` 取最近一次执行记录的 `bindApps`，构造 `executeInfos`：
  - `--branch` / `--env` 覆盖 bindApp 默认值
  - 若执行记录无 bindApps，回退 `GET /pipeline/{pipelineId}` 的 `appUks`（此时必须显式传 `--branch` / `--env`）
  - 每个 bindApp 一条 executeInfo（`appUk` + `triggerBranch` + `triggerEnv` [+ 可选 `triggerClients`]）
  - `--instances` 写入每条 executeInfo 的 **`triggerClients`**（matrix-pipeline-server 指定部署客户端字段）；**不传 = 全部实例**
- 调用 `POST /pipeline/{pipelineId}/api-run` 触发执行
- 每 15s 轮询一次执行状态，最多 30 次（≈7.5 分钟超时）
- **不拦截 `product` 环境**：流水线执行涉及生产时，由服务端白名单决定是否允许；skill / 脚本不得因 `triggerEnv` 为 `product*` 而拒绝

**脚本输出：** 与 `build-deploy.ts` 一致的 Result 结构：

```json
{
  "success": true,
  "stage": "poll",
  "message": "流水线执行成功 (pipelineId=23203)",
  "details": {
    "pipelineId": "23203",
    "executionId": 456,
    "startTime": "...",
    "endTime": "...",
    "nodes": [{ "stageName": "构建", "status": "Success" }]
  }
}
```

`stage` 取值：`init` / `userinfo` / `trigger` / `poll`，对应失败时正在执行的阶段。

**Agent 拿到输出后：**
- `success: true` → 告知用户执行成功，列出各 stage 状态
- `success: false` 且 `stage: "poll"` → 展示 `details.nodes` 中失败节点，引导用户去 `matrix.17usoft.com` 看完整日志
- `success: false` 且 `stage: "userinfo"` → 多半是 token 过期，重走 `references/auth.md`
- 若用户没有提供 `pipelineId`，先按"一、查看流水线列表"引导其选择一条

**前置确认（必须在调用前完成）：**
- 用户是否明确要执行该流水线？流水线可能涉及多应用部署，影响范围大于单次部署
- **不要**因目标 env 为 `product*` 而拒绝；若服务端因未在白名单拒绝，将 API 返回的错误信息展示给用户

---

### 二.1 流水线指定实例部署（灰度）

适用：用户要求「流水线只发某几台」「灰度到某 IP」。**常规执行不要传 `--instances`。**

与 Jean 直接部署（`build-deploy.ts --instances`）的区别：流水线走 matrix `api-run` 的 `triggerClients`，由 CD 共享库消费后推部署；语义同 Jean 的 `clients`（实例 **id**，不是 IP）。

#### 步骤 1：列出实例（含 IP / areaId / businessId）

```bash
node --experimental-strip-types scripts/instance-list.ts \
  --appUk "{appUk}" \
  --env "{env}"
```

把 **IP 展示给用户** 挑选；将选中的 IP 映射为 **id** 后再执行流水线。流水线的 `--instances` 只消费实例 **id**；`areaId` / `businessId` 可展示，但不必传入 `pipeline-run.ts`。

#### 步骤 2：带实例执行流水线

```bash
cd {SKILL.md 所在目录} && node --experimental-strip-types scripts/pipeline-run.ts \
  --pipelineId "{pipelineId}" \
  --env "{env}" \
  [--branch "{branch}"] \
  --instances "{id1},{id2}"
```

注意：
- `--instances` 只认实例 **id**；不要把 IP 直接塞进该参数
- 与 `--branch` / `--env` 可叠加
- 多应用流水线时，同一组 `triggerClients` 会写入每条 `executeInfo`（通常流水线只绑定一个主应用；若多应用且实例 id 不通用，需用户明确目标应用或改用 Jean 直接部署）
- 云原生（K8s）应用后端可能忽略指定实例，与 Jean `/mcp/deploy` 行为一致

---

## 三、查看执行记录 → `scripts/pipeline-executions.ts`

当用户说"流水线执行记录"、"上次跑得怎样"、"流水线历史"时使用。

```bash
cd {SKILL.md 所在目录} && node --experimental-strip-types scripts/pipeline-executions.ts \
  --pipelineId "{pipelineId}" \
  [--page 1] \
  [--pageSize 10]
```

**脚本输出：** JSON，含 `success`、`total`、`executions[]`，每条 execution 含：

- `id` — 执行记录 ID
- `triggerMode` — 触发方式（`webhook` / `manual` / `apiRun` 等）
- `triggerPerson` — 触发人（姓名(工号)）
- `status` / `subStatus` / `subStatusText` — 整体状态及子状态
- `startTime` / `endTime`
- `remark` — 触发备注（如 "GitLab Webhook 触发"）
- `nodes[]` — 各节点（stage）执行详情：`stageName` / `status` / `startTime` / `endTime`

**Agent 拿到输出后：**
- 按时间倒序展示，标注每次的触发方式和触发人
- 失败的记录优先突出显示（`status` 为 `fail` / `failed` / `aborted`）
- 若用户问的是"为什么失败"，引导其去 `matrix.17usoft.com` 查看具体节点日志（API 不返回完整日志）

---

## 错误处理通用规则

- 所有脚本失败时输出 `success: false` + `reason` 或 `message`，直接展示给用户
- HTTP 401 / token 无效 → 引导走 `references/auth.md` 重新获取 token
- 网络/超时 → 提示用户检查 VPN 或公司内网
- 流水线执行被服务端拒绝（如应用不在 product 白名单）→ 原样展示服务端错误，勿在 skill 侧二次拦截
