# 环境管理

管理应用的子环境（如 uat_12、qa_zk_yh 等）。Jean 平台的环境模型为**主环境 + 子环境**两级结构，
子环境名称必须以 `{主环境}_` 开头（如主环境 `uat` 的子环境必须命名为 `uat_xxx`）。

---

## 一、查看环境列表

当用户说"有哪些环境"、"环境列表"、"看看这个应用的环境"时使用。

```bash
curl --noproxy '*' -s \
  -H "jean-token: {jean-token}" \
  -H "Content-Type: application/json" \
  "http://jean.17usoft.com/api/build/deploymentList/{appUk}"
```

> 注意：这是 GET 请求，无需 request body，URL 路径中直接拼接 appUk。

**响应示例：**
```json
{
  "code": 200,
  "data": {
    "product": [
      { "env": "product", "envType": "product" }
    ],
    "qa": [
      { "env": "qa", "envType": "qa" },
      { "env": "qa_zk_yh", "envType": "qa" }
    ],
    "stage": [
      { "env": "stage", "envType": "stage" }
    ],
    "uat": [
      { "env": "uat", "envType": "uat" }
    ]
  },
  "success": true
}
```

**响应结构说明：**
- `data` 按主环境类型分组（product / qa / stage / uat 等）
- 每组内包含主环境本身及其下的子环境
- `env` 为环境全名（用于其他接口调用），`envType` 为所属主环境类型

**展示建议：** 按主环境分组展示，清晰列出每个主环境下有哪些子环境。例如：

```
qa 环境组：
  - qa（主环境）
  - qa_zk_yh（子环境）
uat 环境组：
  - uat（主环境）
stage 环境组：
  - stage（主环境）
product 环境组：
  - product（主环境）
```

**错误处理：** 若 `code` 不为 200，取 `msg` 字段内容告知用户。

---

## 二、新增子环境

当用户说"新建一个环境"、"加个 uat 子环境"、"创建测试环境"时使用。

### 前置确认（必须在调用前完成）

需要向用户确认以下信息：

| 参数 | 说明 | 示例 | 确认要点 |
|------|------|------|----------|
| `env` | 主环境类型 | `uat` | 用户想在哪个主环境下创建 |
| `subEnv` | 子环境名称 | `uat_12` | **必须**以 `{env}_` 开头 |
| `reason` | 创建原因 | `新增uat_12子环境` | 简要说明用途 |

**命名校验：** 在发起请求前，Agent 必须检查 `subEnv` 是否以 `{env}_` 开头。
若不符合，提示用户修正。例如用户想在 `uat` 下创建名为 `test123` 的环境，
应提示："子环境名称必须以 `uat_` 开头，例如 `uat_test123`，是否使用这个名称？"

### 调用接口

```bash
curl --noproxy '*' -s -X POST \
  -H "jean-token: {jean-token}" \
  -H "Content-Type: application/json" \
  -d '{
    "subEnv": "{subEnv}",
    "env": "{env}",
    "appUk": "{appUk}",
    "reason": "{reason}"
  }' \
  "http://jean.t.17usoft.com/api/mcp/env/add"
```

**响应结构：**
```json
{
  "code": 200,
  "data": ...,
  "msg": null,
  "success": true
}
```

**结果处理：**
- `code` 为 200 → 告知用户创建成功，询问是否需要继续配置（→ 参考 `references/app-config.md`）或直接部署（→ 参考 `references/build-deploy.md`）
- `code` 不为 200 → 取 `msg` 内容告知用户失败原因

