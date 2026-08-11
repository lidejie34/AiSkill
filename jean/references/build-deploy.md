# 构建 & 部署

## 所需参数

| 参数 | 类型 | 必填 | 说明 | 自动检测 |
|------|------|------|------|----------|
| `appUk` | string | 是 | 应用标识 | 由主 SKILL.md 公共步骤自动识别 |
| `env` | string | 视情况 | 目标环境（不能以 product 开头）。**仅在 `--build-only` 通用环境构建时可省略或传空字符串**；涉及部署时必填 | 需用户指定 |
| `buildType` | string | 是 | `tag` 或 `branch` | 未指定时默认 `branch` |
| `branchTag` | string | 是 | 分支或 tag 名 | 未指定时自动检测当前 git 分支 |
| `buildVersion` | string | 否 | 自定义构建版本号 | 不指定则不传此字段 |
| `deployVersion` | string | 否 | 用户指定的部署镜像版本（非构建返回的 recordId） | 用户未指定时留空，不传此字段 |

### 通用环境构建（仅构建场景）

当用户表达"通用环境构建"、"通用构建"、"不绑定环境构建"等意图时，**省略 `--env` 或传 `--env ""`**，并搭配 `--build-only`。此时脚本会把 `env: ""` 发给构建接口，跳过部署。

- 仅适用于 `--build-only`：不允许通用环境跑完整流程（构建+部署），因为部署接口需要具体 env
- 若用户在非 `--build-only` 场景下未给 env，脚本会直接报错提示

## 分支自动检测

若用户未指定 branchTag：
```bash
git branch --show-current
```
- 检测成功 → `branchTag` = 当前分支，`buildType` = `branch`，告知用户
- 检测失败 → 请用户手动提供

---

## 操作方式

### A. 完整流程（构建 + 部署）→ 使用脚本

构建→轮询→部署→轮询 的完整链路已封装为脚本，直接调用：

```bash
bash scripts/build-deploy.sh \
  --token  "{jean-token}" \
  --appUk  "{appUk}" \
  --env    "{env}" \
  --buildType "{buildType}" \
  --branchTag "{branchTag}"
```

**可选参数：**
- `--buildVersion "1.0.0"` — 自定义版本号
- `--deploy-version "指定镜像版本"` — 部署用户指定的镜像版本（注意：这不是构建接口返回的 recordId，而是用户明确提供的镜像标识；用户未指定时不要传此参数）
- `--build-only` — 仅构建，不部署
- `--deploy-only` — 仅部署，跳过构建
- `--instances "id1,id2"` — 仅部署到指定实例（灰度 / 重发失败实例）。详见下方"指定实例部署"段落。**不传此参数 = 部署全部实例**（保持原行为）

**脚本输出：** JSON 格式，包含 `success`、`stage`、`message`、`details` 字段。

**重要：** 完整流程（构建+部署）中，构建成功后部署会自动使用最新构建的镜像，无需将构建返回的 recordId 或 version 传给 `--deploy-version`。`--deploy-version` 仅用于用户明确要求部署某个特定镜像时才传。

**脚本自动处理的逻辑（无需 Agent 手动管理）：**
- 生产环境拦截（env 以 product 开头时直接拒绝）
- 构建状态轮询（15s 间隔，最多 30 次 ≈ 7.5 分钟超时）
- 构建失败时自动获取 AI 分析
- 部署状态轮询（15s 间隔，最多 20 次 ≈ 5 分钟超时）
- 部署失败时自动获取日志和失败原因
- 所有请求自动加 `--noproxy '*'`

**Agent 拿到输出后：**
- `success: true` → 直接将 message 告知用户
- `success: false` → 将 message 和 details 中的分析/日志展示给用户，帮助排查

---

### B. 单独查询（不触发流程）→ 内联调用

以下是独立的查询接口，不涉及复杂流程，Agent 直接调用即可：

#### 查看最近构建列表

当用户说"看看最近的构建记录"、"构建历史"时使用。

```bash
curl --noproxy '*' -s \
  -H "jean-token: {jean-token}" \
  "http://jean.17usoft.com/api/build/ci/list?appUk={appUk}&page=1&pageSize=10"
```

#### 查看某次构建状态

当用户说"上次构建成功了吗"、"查一下构建状态"时使用。

```bash
curl --noproxy '*' -s \
  -H "jean-token: {jean-token}" \
  "http://jean.17usoft.com/api/build/ci/status/mcp?appUk={appUk}&version={version}"
```

状态值：1=排队中 2=构建中 3=成功 4=失败

#### 查看部署状态

当用户说"部署到哪了"、"看看部署情况"时使用。

```bash
curl --noproxy '*' -s \
  -H "jean-token: {jean-token}" \
  "http://jean.17usoft.com/api/mcp/deploy/status?appUk={appUk}&env={env}"
```

返回最新部署记录数组，第一条为最新。状态：deploying / success / failed / stop

> 该接口只返回当前最新状态。若用户要查"某时间段的历史部署记录""发了几次版"，改用 `references/deploy-history.md`。

---

## 回滚

当用户说"回滚"、"退回上一个版本"时，使用脚本的 deploy-only 模式指定旧版本：

```bash
bash scripts/build-deploy.sh \
  --token "{jean-token}" \
  --appUk "{appUk}" \
  --env "{env}" \
  --deploy-only \
  --deploy-version "{要回滚到的版本号}"
```

如果用户不知道要回滚到哪个版本，先用"查看部署状态"接口获取历史记录，让用户选择。

---

### C. 指定实例部署（灰度 / 重发失败实例）

适用场景：仅推送到一台或几台实例，例如灰度验证、对失败实例重发。**常规发布不需要此参数**，不传即部署全部实例。

#### 步骤 1：列出当前实例（含 IP）

```bash
node --experimental-strip-types scripts/instance-list.ts \
  --appUk "{appUk}" \
  --env "{env}"
```

输出 JSON：
- `instances`：`[{ id, ip, areaId, businessId }]` —— 与 jean.api `InstanceInfo` 对齐：内部 ID、IP、区域 ID、业务域 ID；
- `ids`：扁平的 ID 字符串数组，便于直接拼接 `--instances`。

> 该脚本请求 `GET /api/mcp/instances/detail`（返回 `[{ id, ip, areaId, businessId }]`）。解析器同时兼容老接口的 `string[]` 形态，此时 `ip` / `areaId` / `businessId` 为 `null`，不影响按 ID 部署。

> **同源保证**：`id` 列表与部署接口在 `clients` 为空时使用的查询逻辑完全一致（共用 `mcp_service.ListInstances` / `ListInstanceDetails`）。从中挑选的 ID 一定能被部署接口正确识别，不会出现"实例已不存在"或"ID 不匹配"的问题。`areaId` / `businessId` 主要用于负载状态变更（见 `load-state.md`），部署接口本身不消费这两个字段。

**把 `ip` 展示给用户挑选**（IP 比内部 ID 可读得多）。用户指定 IP 后，在 `instances` 里用 `ip` 找到对应的 `id`，再把 **id** 传给步骤 2 的 `--instances`——部署接口只认 id，不认 ip。若 `ip` 为 `null`（老接口/拿不到 IP），退回展示 id 让用户选。

#### 步骤 2：调用部署脚本

```bash
node --experimental-strip-types scripts/build-deploy.ts \
  --token "{jean-token}" \
  --appUk "{appUk}" \
  --env "{env}" \
  --deploy-only \
  --instances "{id1},{id2}"
```

参数说明：
- `--instances`：逗号分隔的实例 **id**（不是 IP；IP 已在步骤 1 映射为 id）
- 与 `--deploy-only` 或完整流程都兼容；与 `--deploy-version` 可叠加（指定实例 + 指定版本，常用于回滚单台）
- 不传 `--instances` 时行为与改动前完全一致（部署全部实例）

#### 注意事项

- **云原生应用**：若应用是 Kubernetes Deployment/StatefulSet 编排，后端 furt 服务可能会忽略指定实例参数（这是 furt 行为，skill 不前置拦截）。如发现部署到了所有实例，原因可能在此。
- **优先按 IP 交互**：Docker 应用的 ID 是内部标识，用户难以凭记忆提供。**务必先调步骤 1 列出实例（含 IP）供其选择**，再由 skill 把 IP 映射成 id 传给部署接口。
