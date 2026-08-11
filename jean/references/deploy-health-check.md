# 健康检查配置查询（部署 + 负载）

按应用一次查询两类**当前生效配置**：

1. **部署健康检查**（Furt）  
2. **负载健康检查**（balance / TLB 网关 + tefe 网关）

未指定地域时，部署侧根据应用 `areaIds` 查询全部 Furt 配置存储地域；负载侧 balance 使用默认/传入的路由 scope，tefe 按 naming 聚合。若用户只关心某个部署环境，可由脚本通过 `--env` **仅本地过滤部署侧**。

> 本能力查询的是“健康检查如何配置”，**不是实时探活**，也不能据此判断应用当前是否健康。`healthCheck: false` 只表示配置已关闭，不表示服务已经故障。

接口为 `GET http://jean.17usoft.com/api/healthcheck/standard/combined-realtime-config`，鉴权使用 `jean-token`。脚本默认从 `assets/jean-token` 读取 token。

接口支持 **partial success**：

- 部署：某 `serviceSite` 失败 → 写入 `deploy.errors`，其它地域仍在 `deploy.configs`
- 负载：`balance` 或 `tefe` 一侧失败 → 写入 `loadBalancer.errors`，另一侧仍可返回
- HTTP 仍为 200；脚本在 `success: true` 时同时输出 `deploy` 与 `loadBalancer`

> 说明：旧接口 `deploy-realtime-config` 仅返回部署配置，本能力已切换到聚合接口 `combined-realtime-config`。

---

## 所需参数

| 参数 | 类型 | 必填 | 说明 | 获取方式 |
|------|------|------|------|----------|
| `appUk` | string | 是 | 应用标识 | 由主 `SKILL.md` 公共步骤识别，或由用户提供 |
| `region` | string | 否 | Furt / balance 的 `serviceSite` 地域标识；脚本以 `serviceSite` 查询参数发送 | 用户明确指定地域时传入；未指定时不传 |
| `env` | string | 否 | 只展示该**部署环境**的配置 | 用户指定时传入；仅本地过滤 `deploy.configs`，不发送给接口，也不过滤负载配置 |
| `token` | string | 是 | jean-token | 脚本默认从 `assets/jean-token` 读取 |

此能力不强制用户指定 `env`：

- 未传 `--env`：返回全部部署环境配置 + 全部负载配置；
- 传入 `--env stage`：只保留 `deploy.configs` 中 `env === stage` 的项；`loadBalancer` 不过滤；
- 未传 `--region`：部署侧查应用全部 Furt 存储域；负载 balance 使用默认 scope；
- 传入 `--region`：部署与 balance 均限定该 `serviceSite`；
- `region` 与 `env` 含义不同。`region` 是 Furt/网关地域，`env` 是 `stage`/`uat`/`product` 等部署环境。

这是只读查询，允许查询 `product` / 生产环境，不触发生产写操作保护，也无需写操作确认。

**不依赖** Jean「健康检查标准配置」是否存在；无标准配置也可查询线上实际配置。

---

## 调用方式 → `scripts/deploy-health-check.ts`

查询全部部署环境 + 负载配置：

```bash
cd {SKILL.md 所在目录} && node --experimental-strip-types scripts/deploy-health-check.ts \
  --appUk "{appUk}"
```

只查看指定部署环境（负载侧仍全量返回）：

```bash
cd {SKILL.md 所在目录} && node --experimental-strip-types scripts/deploy-health-check.ts \
  --appUk "{appUk}" \
  --env "stage"
```

指定地域：

```bash
cd {SKILL.md 所在目录} && node --experimental-strip-types scripts/deploy-health-check.ts \
  --appUk "{appUk}" \
  --region "cn_east"
```

联调时可通过 `JEAN_DEPLOY_HEALTH_CHECK_API` 覆盖接口地址；正常使用不要设置。

### 脚本输出

成功时输出（含 partial success；两侧 `errors` 始终为数组）：

```json
{
  "success": true,
  "deploy": {
    "configs": [
      {
        "serviceSite": "cn_east",
        "env": "stage",
        "config": {
          "healthCheckType": "http",
          "healthCheckUri": "/health",
          "healthCheckInterval": 5000,
          "healthCheckRise": 2,
          "healthCheckFall": 3,
          "healthCheckCount": 60,
          "healthCheck": true,
          "healthCheckPort": 8080
        }
      }
    ],
    "errors": []
  },
  "loadBalancer": {
    "configs": [
      {
        "platform": "balance",
        "upstreamNameOrEnv": "demo-upstream",
        "id": "u-1",
        "groupId": "",
        "groupName": "",
        "config": {
          "healthCheckType": "http",
          "healthCheckUri": "/health",
          "healthCheckInterval": 5000,
          "healthCheckRise": 2,
          "healthCheckFall": 3,
          "healthCheckCount": 0,
          "healthCheck": true,
          "healthCheckPort": 8080,
          "healthCheckHeaderHost": "demo.example.com"
        }
      }
    ],
    "errors": []
  }
}
```

失败时输出（鉴权失败、网络错误、业务 4xx、响应结构错误等）：

```json
{ "success": false, "reason": "..." }
```

### 接口 data 结构（脚本解析依据）

Jean 统一响应：`{ code, success, msg, data }`。`data`：

| 字段 | 说明 |
|------|------|
| `data.deploy.configs` | 部署健康检查项 |
| `data.deploy.errors` | 部署按 serviceSite 失败项 |
| `data.loadBalancer.configs` | 负载健康检查项（balance / tefe） |
| `data.loadBalancer.errors` | 负载按 source 失败项 |

### 配置字段说明

**部署 `config`（core）：**

| 字段 | 说明 |
|------|------|
| `healthCheck` | 是否启用 |
| `healthCheckType` | 类型，如 `http`、`tcp` |
| `healthCheckUri` | 路径或脚本来源 |
| `healthCheckPort` | 端口；`0` 表示未解析到明确端口 |
| `healthCheckInterval` | 间隔(ms) |
| `healthCheckRise` / `Fall` / `Count` | 成功/失败阈值与检查次数 |

**负载 `config`（core + Host）：**

| 字段 | 说明 |
|------|------|
| `healthCheck` | 是否启用 |
| `healthCheckType` | 类型，如 `http`、`tcp` |
| `healthCheckUri` | 路径；tcp 时可能为空 |
| `healthCheckPort` | 健康检查端口。**`0` 表示不单独指定端口，探活时直接使用实例（后端）上的 port**，不是配置错误，也不是服务不健康 |
| `healthCheckInterval` | 间隔(ms) |
| `healthCheckRise` / `Fall` / `Count` | 成功/失败阈值与检查次数（TLB 常无 count，可为 0） |
| `healthCheckHeaderHost` | 健康检查 Host 头；无则为空字符串 |

**负载项标识：**

| 字段 | 说明 |
|------|------|
| `platform` | `balance` 或 `tefe` |
| `upstreamNameOrEnv` | TLB upstream 名，或 TEFE 的 `name#env&id` |
| `id` / `groupId` / `groupName` | 平台侧标识（可能为空串） |

---

## Agent 展示规则

- 先说明这是**配置查询**，不是实时健康状态或探活结果。
- **分两块展示**，不要混在一张无表里：
  1. **部署健康检查**：按地域 + 环境；表格建议含地域、环境、开关、类型、端口、URI、间隔、rise/fall/count。
  2. **负载健康检查**：按平台 + upstream；表格建议含平台、名称、开关、类型、端口、URI、Host、间隔、rise/fall。
- **负载侧 `healthCheckPort === 0`**：向用户说明为「使用实例自身端口」，**不要**表述为端口未配置/异常/解析失败。
- 多地域部署结果中即使环境名相同，也必须保留 `serviceSite`。
- `healthCheckInterval` 展示保留毫秒；换算成秒时同时写原值。
- **partial success**：
  - `deploy.errors` 非空：先展示已成功的部署配置，再列出失败地域；
  - `loadBalancer.errors` 非空：先展示已成功的负载配置，再列出失败 source（balance/tefe）；
  - 不要把整次查询当成失败。
- `deploy.configs` 为空：
  - 若 `deploy.errors` 非空：说明部署侧地域查询失败；
  - 若 errors 为空且传了 `--env`：说明该环境无部署健康检查配置；
  - 若 errors 为空且未传 `--env`：说明未查到任何部署环境配置。
- `loadBalancer.configs` 为空：
  - 若 `loadBalancer.errors` 非空：说明 balance/tefe 查询失败；
  - 若 errors 为空：说明未配置负载健康检查或应用无对应 upstream，**不是**探活失败。
- 若 `success: false`，将 `reason` 原样告知用户；HTTP 401 时读 `references/auth.md` 重取 token；网络/超时提示检查 VPN / 内网。
