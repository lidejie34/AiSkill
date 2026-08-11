---
name: jean
description: >
  通过 Jean 平台管理应用发布流程：构建、部署、回滚、打包、查看/新增
  stage/uat/qa 子环境、查看/执行流水线和执行记录、变更实例负载状态（auto/enable/disable），
  以及查询部署/负载健康检查配置。
  当用户明确提到 Jean，或要求把应用/分支发布、部署、回滚到
  stage/uat/qa，创建子环境，查看/执行应用流水线、修改实例负载状态/挂摘流、
  查询应用健康检查配置时触发。
  product/prod/生产/线上环境：部署、回滚、发布等写操作必须拒绝；
  流水线执行、实例负载状态变更除外（由服务端 Matrix 白名单校验，skill 不拦截 product）。
---

# Jean 应用管理平台

通过 Jean API 操作内部应用管理平台。根据用户意图，执行公共前置步骤后，读取对应的 references 子文件完成具体操作。

## 目录结构

```
jean-platform/
├── SKILL.md                        ← 你正在阅读的文件（路由 + 公共逻辑）
├── assets/
│   └── jean-token                  ← token 缓存（纯文本）
├── scripts/
│   ├── check-env.js                ← Node.js 环境检查（.js，任意版本可运行）
│   ├── validate-token.ts           ← 验证 token（也可传入新 token 并保存）
│   ├── get-appuk.ts                ← 通过 git URL 识别 appUk
│   ├── get-jean-token.ts           ← 自动获取 token（打开浏览器登录）
│   ├── build-deploy.ts             ← 构建部署自动化脚本（构建→轮询→部署→轮询，支持 --instances 指定实例）
│   ├── instance-list.ts            ← 查询应用在某 env 下的实例列表（id + ip + areaId + businessId，用于灰度部署 / 负载状态 / 按 IP 选实例）
│   ├── update-load-state.ts        ← 修改实例负载状态（auto/enable/disable）
│   ├── pipeline-list.ts            ← 查看应用流水线列表
│   ├── pipeline-executions.ts      ← 查看流水线执行记录
│   ├── pipeline-run.ts             ← 执行流水线 + 自动轮询（支持 --instances → triggerClients 指定实例）
│   ├── deploy-history.ts           ← 查询应用部署记录（按时间范围）
│   └── deploy-health-check.ts       ← 查询部署 + 负载健康检查配置（可按环境过滤部署侧）
└── references/
    ├── auth.md                     ← token 获取完整流程（四条路径）
    ├── build-deploy.md             ← 构建 & 部署完整流程
    ├── environment.md              ← 环境管理（查看、新增环境）
    ├── pipeline.md                 ← 流水线管理（列表、执行、执行记录）
    ├── load-state.md               ← 实例负载状态变更（auto/enable/disable）
    ├── deploy-history.md           ← 部署记录查询（按时间范围）
    └── deploy-health-check.md       ← 健康检查配置查询（部署 + 负载）
```

---

## 安全约束（最高优先级）

以下规则在任何操作路径中都优先于其他逻辑，必须始终遵守：

- **生产环境保护**：`env` 以 `product` 开头时，拒绝 Jean 主站侧破坏性操作（部署、回滚、直接发布等），并明确告知用户原因。这是不可覆盖的硬性约束。
  - **例外 1：流水线执行**不在此拦截范围内。执行流水线时允许沿用或传入 `product` 环境；是否允许发生产由 **流水线服务端白名单** 校验，skill / `pipeline-run.ts` **不得**因 `product` 拒绝触发。
  - **例外 2：实例负载状态变更**（`POST /api/load/state` / `update-load-state.ts`）不在此拦截范围内。允许对 `product` 环境改 `auto`/`enable`/`disable`；是否允许由 **Matrix 应用白名单** 在服务端校验，skill / 脚本 **不得**因 `product` 拒绝。执行前**必须**向用户二次确认（appUk、env、state、实例列表）。
- **请求头**：
  - Jean 主站 API（`jean.17usoft.com`）必须携带 `jean-token: {token}`
  - 流水线 API（`matrix.17usoft.com/pipeline/api`）必须携带 `mptoken: {token}`，**值与 `jean-token` 相同**，无需额外获取
  - 用户信息接口：`http://tccommon.17usoft.com/oauth/rs/getuserinfo`（multipart/form-data，字段 `access_token`），由 `pipeline-run.ts` 自动调用
- **代理设置**：所有 curl 请求必须加 `--noproxy '*'`
- **轮询间隔**：状态轮询统一 15 秒一次
- **脚本执行**：所有 `scripts/*.ts` 需要 Node.js >= 22.6.0，统一用 `node --experimental-strip-types` 运行，无需额外安装依赖。首次使用前必须先执行环境检查（见步骤 0）。

---

## 公共前置步骤（每次操作前必须执行）

### 0. 检查 Node.js 环境（每次会话仅需执行一次）

本技能的所有脚本依赖 Node.js >= 22.6.0（需要 `--experimental-strip-types` 支持）。在首次执行任何脚本前，先运行环境检查：

```bash
node {SKILL.md 所在目录}/scripts/check-env.js
```

该脚本使用 `.js` 扩展名和基础语法，任意版本 Node.js 都能运行。输出 JSON：

- `{ "ok": true, ... }` → 环境满足要求，继续后续步骤。本次会话内无需再次检查。
- `{ "ok": false, "message": "...", "hint": "..." }` → 将 `message` 和 `hint` 内容展示给用户，引导其升级或安装 Node.js。**不继续执行后续步骤。**
- 若 `node` 命令本身不存在（command not found）→ 告知用户需要先安装 Node.js >= 22.6.0，推荐访问 https://nodejs.org/en/download 。

### 1. 获取 jean-token

缓存路径：`{SKILL.md 所在目录}/assets/jean-token`（纯文本，仅存 token 字符串）

执行验证脚本，自动读取缓存并检测有效性：

```bash
cd {SKILL.md 所在目录} && node --experimental-strip-types scripts/validate-token.ts
```

脚本输出 JSON：
- `{ "valid": true, "token": "..." }` → token 有效，跳到步骤 2
- `{ "valid": false, "reason": "..." }` → token 无效或不存在，**立即读取 `references/auth.md`**，按其中的优先级路径获取新 token。**优先尝试路径 A（tcode CLI）**，已是几乎全自动的最便捷路径；其他路径仅在 tcode 不可用 / 用户拒绝安装时降级使用。

### 2. 识别 appUk

若用户未提供 appUk，执行识别脚本（自动从 git remote 获取仓库地址并调用 API）：

```bash
cd {SKILL.md 所在目录} && node --experimental-strip-types scripts/get-appuk.ts
```

也可以手动指定 git URL：

```bash
cd {SKILL.md 所在目录} && node --experimental-strip-types scripts/get-appuk.ts --git-url <GIT_URL>
```

脚本输出 JSON，包含 `count` 和 `apps` 数组：
- `count === 1` → 自动使用，告知用户（展示应用名称和 appUk）
- `count > 1` → 列出所有匹配项（展示应用名称 + appUk），让用户选择
- `count === 0` 或 `success === false` → 请用户手动提供 appUk

### 3. 按目标能力确认环境（env）

仅当目标能力要求 `env` 时，用户未指定才**必须询问**，不可默认。建议先调用环境列表接口（参见 `references/environment.md`）获取可用环境，列出供用户选择，而非让用户凭记忆输入。

健康检查配置查询是例外：不指定 `env` 时查询并展示全部部署环境 + 全部负载配置；用户指定 `env` 时，使用脚本的 `--env` 仅本地过滤**部署侧**配置（负载侧不过滤）。任何部署、回滚等写操作仍不得默认环境。

---

## 功能路由

根据用户意图，读取对应的 reference 文件并按其中的流程执行：

| 用户意图 | 读取文件 | 典型表达 |
|---------|---------|---------|
| 构建、部署、发布、回滚 | `references/build-deploy.md` | "帮我构建一下"、"部署到 uat"、"发个版"、"回滚" |
| 查看/新增环境 | `references/environment.md` | "有哪些环境"、"加个子环境" |
| 查看/执行流水线、查看执行记录 | `references/pipeline.md` | "看看流水线"、"执行流水线"、"跑一下 pipeline"、"流水线执行记录" |
| 变更实例负载状态 | `references/load-state.md` | "改负载状态"、"disable 某台机器"、"把实例踢出负载"、"enable 负载"、"挂摘流" |
| 查询部署记录/部署历史 | `references/deploy-history.md` | "看看部署记录"、"部署历史"、"上个月发了几次版" |
| 查询健康检查配置（部署 + 负载） | `references/deploy-health-check.md` | "看看健康检查配置"、"stage 的部署检查是什么"、"查一下 Furt/负载健康检查" |

### 构建 & 部署 → `references/build-deploy.md`

覆盖能力：触发构建（支持 branch/tag）、轮询构建状态并在失败时获取 AI 分析、触发部署并轮询状态、部署失败时获取日志和失败原因、回滚到指定版本。

用户要求执行构建或部署相关操作时，立即读取此文件。

### 环境管理 → `references/environment.md`

覆盖能力：查看环境列表（按主环境分组展示，含所有子环境）、新增子环境（名称必须以 `{主环境}_` 开头，如 `uat_12`）。

Jean 平台采用主环境 + 子环境两级结构。主环境类型包括 product、stage、uat、qa 等，子环境命名规则为 `{主环境}_{自定义名称}`。

用户要求查看或创建环境时，立即读取此文件。

### 流水线管理 → `references/pipeline.md`

覆盖能力：查看应用关联的流水线列表、执行流水线（自动获取 triggerPerson + 触发 + 轮询执行状态）、查看流水线执行记录。

流水线接口部署在 `matrix.17usoft.com`，请求头使用 `mptoken`（值同 `jean-token`）。所有交互均通过 `scripts/pipeline-*.ts` 脚本完成，不直接拼 curl。

执行流水线时：用户提供 `pipelineId` 即可触发；`--branch` / `--env` 为可选覆盖项。需要灰度 / 指定机器时，先 `instance-list.ts` 按 IP 选实例 id，再传 `--instances "id1,id2"`（映射为 api-run 的 `triggerClients`；不传 = 全部实例）。涉及 `product` 时 **不要** 在 skill 侧拦截，由流水线服务端白名单决定是否放行。

用户要求查看流水线、执行流水线或查看执行历史时，立即读取此文件。

### 实例负载状态变更 → `references/load-state.md`

覆盖能力：将指定实例的负载状态改为 `auto` / `enable` / `disable`（Jean `POST /api/load/state`）。

流程：`instance-list.ts` 按 IP 选实例（同时拿到 `areaId` / `businessId`）→ **每次写操作二次确认** → `update-load-state.ts` 调用接口。`areaId` / `businessId` **优先从 instance-list 选中实例取值并传入**；列表无值时才省略，由服务端解析；多区域/多业务域仍报错时再向用户补传。涉及 `product` 时 **不要** 在 skill 侧拦截，由 Matrix 白名单决定是否放行。

用户要求修改负载状态、启用/禁用实例负载、挂摘流时，立即读取此文件。

### 部署记录查询 → `references/deploy-history.md`

覆盖能力：按 `appUk + env + 时间范围`（时间区间 / 最近 N 天 / 默认最近 7 天）查询历史部署记录，返回每次部署的操作人、版本、状态、成功/失败实例数等统计。

这是只读查询接口，查询 `product` 环境也被允许（生产保护仅针对写操作）。注意与 `build-deploy.md` 的「查看部署状态」区分：后者回答"现在部署到哪了"，本能力回答"历史发版记录 / 某时间段发了几次版"。

用户要求查看部署历史、部署记录、发版次数时，立即读取此文件。

### 健康检查配置查询（部署 + 负载）→ `references/deploy-health-check.md`

覆盖能力：按 `appUk` 一次查询 **部署健康检查**（Furt）与 **负载健康检查**（balance/TLB + tefe）。部署侧默认按应用地域返回全部 Furt 存储域及环境，可选 `env` 本地过滤、可选 `region` 限定 `serviceSite`；负载侧返回 core 字段 + `healthCheckHeaderHost`。两侧各自 partial success：`deploy` / `loadBalancer` 下均有 `configs` 与 `errors`。

这是只读配置查询，查询 `product` 环境也被允许。不依赖标准配置表是否存在。它不执行实时探活，不能仅根据配置内容判断应用当前是否健康。

用户要求查看健康检查、部署健康检查、负载/网关健康检查、Furt 健康检查时，立即读取此文件。

---

## 跨模块联动流程

某些场景需要串联多个模块，按以下顺序执行：

- **标准发布**：`build-deploy.md` 全流程
- **新子环境初始化**：`environment.md`（新增子环境）→ `build-deploy.md`（仅构建）
- **紧急回滚**：`build-deploy.md`（回滚段落）
- **流水线执行**：`pipeline.md`（查看列表 → 用户确认目标流水线 → 执行 → 自动轮询 → 失败时引导查看 matrix 控制台日志）
- **灰度后摘流/回挂**：`pipeline.md` 或 `build-deploy.md`（指定实例部署）→ `load-state.md`（对目标实例改 disable/enable/auto）
