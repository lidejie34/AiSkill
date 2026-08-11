# 实例负载状态变更

修改应用在指定环境下**部分或全部已选实例**的负载状态（Naming / Furt `EditAppState`）。

对应 Jean 主站接口：`POST /api/load/state`。  
鉴权：请求头 `jean-token`（与其它 Jean 主站能力相同）。

本能力**允许** `product` 环境：是否放行由 **Matrix 应用白名单**（`ukwhitelist/exists`）在服务端校验；skill / 脚本**不得**因 `env` 为 `product*` 而拒绝。

---

## 所需参数

| 参数 | 类型 | 必填 | 说明 | 自动检测 |
|------|------|------|------|----------|
| `appUk` | string | 是 | 应用标识 | 公共步骤识别 |
| `env` | string | 是 | 目标环境（允许 `product`） | 需用户指定，不可默认 |
| `state` | string | 是 | `auto` / `enable` / `disable` | 需用户指定 |
| `instanceIds` | string[] | 是 | 实例 **id** 列表（至少 1 个） | 先 `instance-list.ts`，按 IP 选中后映射 |
| `areaId` | number | 条件 | 区域 ID | **优先**从 `instance-list` 选中实例的 `areaId` 取值；缺省时服务端按应用配置解析，多区域会报错 |
| `businessId` | number | 条件 | 业务域 ID | **优先**从 `instance-list` 选中实例的 `businessId` 取值；缺省时服务端解析，多业务域会报错 |
| `token` | string | 是 | jean-token | 脚本默认读 `assets/jean-token` |

### state 含义（沿用接口字面量）

| state | 含义 |
|-------|------|
| `enable` | 启用负载 |
| `disable` | 禁用负载 |
| `auto` | 自动（跟随健康检查 / Naming 策略） |

不要用其它同义词替换传参；与用户沟通时可解释上表，请求体必须用这三项之一。

---

## 操作流程（必须按序）

### 0. 公共前置

见主 `SKILL.md`：环境检查 → token → appUk → 用户指定 env。

### 1. 列出实例（含 IP / areaId / businessId）→ 用户选择

与灰度部署相同：先列实例，**按 IP 展示**让用户选，再映射为 id，并记录对应的 `areaId` / `businessId`。

```bash
cd {SKILL.md 所在目录} && node --experimental-strip-types scripts/instance-list.ts \
  --appUk "{appUk}" \
  --env "{env}"
```

- 输出 `instances: [{ id, ip, areaId, businessId }]`、`ids: [...]`（对应 jean.api `InstanceInfo`）
- **接口只认实例 id**，不要把 IP 直接塞进 `--instances`
- 用户给了 IP：在列表中映射为 id；给了 id：校验其在列表中（若列表可取到）
- 若 `ip` 为 `null`，退回展示 id 让用户选
- `areaId` / `businessId` 为 `null` 表示接口未返回（老形态或字段缺失）

### 2. 二次确认（写操作，每次必须）

在调用变更脚本**之前**，向用户明确展示并等待确认：

- appUk
- env
- state（及中文释义：启用 / 禁用 / 自动）
- 将影响的实例（建议同时展示 id + ip + areaId + businessId）
- 将传入的 `areaId` / `businessId`（来自选中实例）

用户未明确同意前**禁止**调用写接口。

### 3. 执行变更 → `scripts/update-load-state.ts`

```bash
cd {SKILL.md 所在目录} && node --experimental-strip-types scripts/update-load-state.ts \
  --appUk "{appUk}" \
  --env "{env}" \
  --state "{auto|enable|disable}" \
  --instances "{id1},{id2}" \
  [--areaId {n}] \
  [--businessId {n}]
```

**`areaId` / `businessId` 取值规则（按优先级）：**

1. **优先**使用步骤 1 选中实例上的 `areaId` / `businessId`（`!= null` 时传入，含 `0` 以外的有效值；`0` 与 `null` 视为无效，不传）
2. 若一次选中多台且 `(areaId, businessId)` **不一致**：按 `(areaId, businessId)` **分组分别调用** `update-load-state.ts`（每次只传同组实例），并在确认文案中写清分组
3. 列表无有效值时：可先不传，由服务端按应用配置解析
4. 仅当服务端仍返回「应用存在多个区域，请指定 areaId」或「多个业务域，请指定 businessId」时，再向用户索取并重试

**脚本行为：**

- 校验 `state` ∈ {auto, enable, disable}
- 实例 id trim + 去重
- **不**拦截 `product` 环境
- POST `http://jean.17usoft.com/api/load/state`，body 字段与服务端 `UpdateLoadStateDTO` 对齐
- 成功 / 失败均输出 JSON 到 stdout

**成功输出示例：**

```json
{
  "success": true,
  "appUk": "bjops.go.test.v2",
  "env": "product",
  "state": "disable",
  "instanceIds": ["furt--bjops-go-test-v2--12003"],
  "instanceCount": 1,
  "message": "已将 1 个实例的负载状态修改为 disable"
}
```

**失败常见原因（原样展示 `reason`）：**

| 场景 | 典型文案 |
|------|----------|
| 应用不在 Matrix 白名单 | `应用 xxx 不在负载状态操作白名单中` |
| 白名单服务异常 | `校验应用负载状态白名单失败...` |
| 多区域未指定 | `应用存在多个区域，请指定 areaId` |
| 多业务域未指定 | `应用存在多个业务域，请指定 businessId` |
| area/business 不属于应用 | `areaId N 不属于应用...` |
| token 失效 | `token 无效（HTTP 401）` |
| 未登录 / 参数错误 | 服务端 `msg` |

---

## Agent 行为约定

1. 用户说「改负载状态 / 挂摘流 / enable/disable 实例 / 把机器踢出负载」等 → 读本文件并走上述流程。
2. **不要**因 `product` 拒绝；白名单拒绝时把服务端错误完整告知用户。
3. **不要**在未列出实例且用户未给出明确 id/IP 时盲改；需要范围时先 `instance-list`。
4. **不要**在用户确认前调用 `update-load-state.ts`。
5. 一次变更只传用户选定的实例；用户说「全部」时，用当前 `instance-list` 的全部 id，并在确认文案中写清数量。
6. 本接口**不**查询当前状态；若用户要先看现状，说明 skill 当前仅支持变更，或引导其去 Jean 控制台 / 其它查询能力（勿编造状态）。

---

## 与其它能力的边界

| 能力 | 区别 |
|------|------|
| `build-deploy` 指定实例部署 | 改的是**部署版本**，不是 Naming 负载状态；且 skill 拦截 product 直接部署 |
| 流水线灰度 | 走 Matrix 流水线部署；本能力是即时改负载状态 |
| 健康检查配置查询 | 只读配置，不改实例状态 |
| CMDB 摘除服务器 | 从应用绑定删机器；本能力只改负载 enable/disable/auto |
