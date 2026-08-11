# 配置说明

## 文件结构

`config.yaml` 必须使用下面的结构：

```yaml
defaults:
  environments:
    - <env>
  query:
    query_hints:
      - <hint>

databases:
  <database-key>:
    display_name: <string>
    mcp_server: <mcp-server-id>
    database: <schema-name>
    environments:
      - <env>
    readonly: true
    query_tool: mysql_query

uks:
  <uk-name>:
    display_name: <string>
    code_root: <absolute-path>
    environments:
      - <env>
    query:
      query_hints:
        - <hint>
    related_uks:
      - <other-uk-name>
    database: <database-key>   # 可选
```

## 字段规则

| 字段 | 必填 | 含义 |
|---|---|---|
| `display_name` | 是 | 展示给用户看的 uk 名称，用于候选列表和摘要 |
| `code_root` | 是 | 代码搜索使用的绝对目录路径 |
| `environments` | 是* | 这个 uk 允许选择的环境列表（可继承 `defaults.environments`） |
| `query.query_hints` | 是* | 与用户关键词一起参与检索的额外搜索维度（可继承 defaults） |
| `related_uks` | 是 | 选定 trace 之后，用于递归展开并生成一次性多 uk 查询的其他 uk |
| `database` | 否 | 指向顶层 `databases:` 的 key，用于日志后只读查库旁证 |
| `code_include` | 否 | 在 `code_root` 下收窄代码搜索的 glob 列表 |

\* 可从 `defaults` 继承；校验闸门要求最终解析后必须有值。

### `databases` 字段

| 字段 | 必填 | 含义 |
|---|---|---|
| `display_name` | 是 | 给人看的库名称 |
| `mcp_server` | 是 | Cursor MCP server id（如 `user-mysql-drp-qa`） |
| `database` | 是 | schema / 库名 |
| `environments` | 是 | 哪些环境允许用这个绑定（例如只配 `qa`） |
| `readonly` | 是 | 必须为 `true`；本 skill 禁止写库 |
| `query_tool` | 是 | MCP 查询工具名（如 `mysql_query`） |

连接账号密码只放在本机 `~/.cursor/mcp.json`，**不要**写入 `config.yaml`。

当前示例：`TETitcDRP-qa` → MCP `user-mysql-drp-qa` → 库 `TETitcDRP`，挂在 DRP 相关 uk 上。

## 校验规则

1. 每个 uk 名称必须唯一。
2. 每个 `code_root` 都必须是绝对路径。
3. 每个 `related_uks` 条目都必须引用已经存在的 uk key。
4. 用户选择的环境必须出现在目标 uk 的 `environments` 中。
5. `uk`、`environment` 或 `related_uks` 配置字段缺失或未定义时，属于 hard-stop 错误。
6. `related_uks` 的扩展是递归的；每个被扩展到的 uk 在查询前都必须先校验。
7. 遍历 `related_uks` 时要维护首次出现顺序；如果再次遇到已经出现过的 uk，则在首次重复处立即截断，不再继续展开。
8. 用户选定 trace ID 之后，扩展出的 uk 列表应一次性交给 SkyEye，而不是按 uk 逐个顺序查询。
9. 如果一次性多 uk 查询中部分 uk 失败，要显式报告失败 uk，但仍保留成功命中的日志继续分析。
10. 若 uk 声明了 `database:`，该 key 必须存在于 `databases:`；`readonly` 必须为 `true`。
11. 当前环境不在 database 的 `environments` 中时：跳过查库（`DB: SKIPPED_ENV`），**不** hard-stop。

## 运行时说明

- 始终先查询用户选择的 uk。
- 只有在用户明确选定 trace ID 之后，才会沿着 `related_uks` 递归展开出一个有序 uk 列表。
- 递归展开得到的 uk 列表会一次性交给 SkyEye，而不是按 uk 逐个查询。
- 默认输出是一条合并时间线；每条关键日志都保留 uk 标识。
- 代码分析只会在有日志命中的 uk 的 `code_root` 下进行。
- 数据库旁证在代码关联之后执行；同一 `databases` key 在 uk 组内只查一次。
- MCP 不可用时标记 `DB: UNAVAILABLE`，不影响日志与代码分析输出。
