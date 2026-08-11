---
name: skyeye
description: 查询和分析日志、链路、请求性能指标。适用于排查问题、监控应用性能或进行故障调查时使用。在提及 可观测指标、skyeye、天网、日志、Checklist、TLB七层流量 或上述指标查询、异常定位分析、指标巡检等意图时触发
metadata:
  version: 0.0.3
  publish: "true"
---

# skyeye 天网日志 / Checklist / TLB

## 概述

查询和分析应用部署环境的运行日志、请求链路和监控指标等可观测性数据。当提及查询天网/skyeye日志（Log）、APM链路（Trace）、性能指标(Metric)、checklist指标、tlb/七层负载请求监控等数据进行代码异常定位、问题排查、接口性能分析与优化相关意图场景时触发。
 [安装/更新手册](https://wiki.17u.cn/wiki?fid=b4685d06dba149d5ab8285479f1637fe "安装/更新手册")

## Agent 硬性约束（queryLog）

- **禁止**使用 `--keyword`。CLI **没有**该参数；历史误用会被静默忽略，返回的是时间窗内未按关键词过滤的日志，极易误判「查无」。
- 按消息内容模糊检索，**必须**用 `--indexContext=<文本>`（orderId / trackingId / 异常片段等）。
- 高流量应用务必同时收窄 `--beginTime`/`--endTime`（或 `--minutes`），并尽量带上 `--indexContext`，不要只靠时间窗翻最新 N 条。


## 使用手册

**执行方式** 安装本 skill 后，请先赋予 `bin` 目录下的执行文件权限，然后将 **skill 所在目录的 `bin`** 加入 PATH，即可在终端使用 `skyeye`。


```
# 若 skill 被安装到 .agents/skills/skyeye
chmod +x ~/.agents/skills/skyeye/bin/skyeye
export PATH="~/.agents/skills/skyeye/bin:$PATH"
source ~/.zshrc 或 ~/.bashrc
```



### 1. 刷新并缓存 Token（auth）

认证信息写入当前目录下的 `assets/skyeye-cache/cache.json`（map：key=`skyeye`）。任选一种方式即可；查询类子命令（`queryLog` / `queryChecklist` / `queryTlb`）会从缓存读取鉴权信息。若接口返回 HTTP 200 且 body 中 `code=1`，表示权限已过期，请重新执行 `auth` 更新。

#### 方式 A：`login`（tcode 自动登录，推荐）
若执行报错，请升级 tcode 版本：https://tws.17usoft.com/copilot/skill/detail?slug=skyeye&space=tongcheng

```bash
skyeye auth login
```

#### 方式 B：`--personalAccessToken`（Open API Key）
[personalAccessToken 点击查看【API Key 的值】](https://skyeye.17usoft.com/system/profile "personalAccessToken点击查看【API Key的值】")

```bash
skyeye auth --personalAccessToken <你的APIKey>
skyeye auth --personalAccessToken=<你的APIKey>
```

#### 清除缓存：`logout`
清除 skyeye 本地全部缓存（`assets/skyeye-cache/cache.json`）。

```bash
skyeye auth logout
```




### 2. 查询日志（queryLog）

从缓存读取 token，向天网日志接口发起查询。时间范围可选：`--minutes` 或 `--beginTime`/`--endTime`（或 `--begin`/`--end`）；均未指定时**默认最近 15 分钟**（逻辑见 `scripts/skyeye-api.ts` 的 `SkyEyeApi.resolveQueryTimeRange`）。**必须**指定 env 和 appUks。
<span style="color:red">会公用应用标识的openApi限流策略（限流值参考应用配置页面），请按需使用，不要影响到线上openApi业务</span>

**1.最近 N 分钟：**

```bash
skyeye queryLog --env=qa --appUks="a" --minutes=5 [--priority=INFO] [--pageSize=20]
skyeye queryLog --env=qa --appUks="a" --priority=1  --minutes=5
```

**1.1 按订单号 / trackingId 等消息内容检索（推荐）：**

```bash
# 正确：--indexContext
skyeye queryLog --env=qa --appUks="titc.java.drp.standard.push.job" \
  --beginTime="2026-08-07 16:37:50.000" --endTime="2026-08-07 16:39:30.000" \
  --pageSize=50 --indexContext="d71d7efc-998d-41a7-96f2-e44af35591f5"

# 错误：不要写 --keyword（无效参数，不会按关键词过滤）
# skyeye queryLog ... --keyword="d71d7efc"   # ❌
```

**2.指定时间范围的 qa 环境 error 日志：**

```bash
skyeye queryLog --env=qa --priority=1 --appUks="a,b"  --beginTime="2026-03-05 16:00:00.000" --endTime="2026-03-05 16:10:00.000"
```

**3.指定时间范围的 新生支付应用标识 qa 环境 error 日志：**

```bash
skyeye queryLog --queryRegion=newpay_cn_east  --env=qa --priority=1 --appUks="a,b"  --beginTime="2026-03-05 16:00:00.000" --endTime="2026-03-05 16:10:00.000"
```

**4.指定时间范围的 新生支付香港应用标识 qa 环境 error 日志：**

```bash
skyeye queryLog --queryRegion=newpay_ap-east-1  --env=qa --priority=1 --appUks="a,b"  --beginTime="2026-03-05 16:00:00.000" --endTime="2026-03-05 16:10:00.000"
```

**5.指定时间范围的 海外应用标识 qa 环境 error 日志：**

```bash
skyeye queryLog --queryRegion=general_ap-southeast-1  --env=qa --priority=1 --appUks="a,b"  --beginTime="2026-03-05 16:00:00.000" --endTime="2026-03-05 16:10:00.000"
```

**5.indexContext 不包含 msg1 且不包含 msg12（advancedSearchItems）：**

> 在 zsh/bash 中，`--advancedSearchItems` 的 JSON 必须用**单引号**包住整个值，否则方括号 `[]` 会被 shell 当作通配符解析并报错「no matches found」。

```bash
skyeye queryLog --env=qa --appUks="infrascs.java.skyeye.api"  --minutes=10 \
  --advancedSearchItems='[{"filter":"indexContext","compare":"nlike","value":["msg1"]},{"filter":"indexContext","compare":"nlike","value":["msg12"]}]'
```

**常用参数：**

| 参数 | 说明 |
|------|------|
| `--appUks` | 必填。应用标识或标识：支持多值，逗号分隔（如 'a,b'）或原生 JSON 数组 |
| `--env` | 必填。环境，如 qa/test/uat/stage/product |
| `--priority` | 日志等级：DEBUG(4)、INFO(3)、WARN(2)、ERROR(1)、FATAL(0)；不传则查所有 |
| `--envName` | 部署环境 |
| `--modules` | 模块，支持多值 同应用标识 |
| `--categories` | 大类，支持多值：同上 |
| `--subCategories` | 小类，支持多值：同上 |
| `--filter1s` / `--filter2s` | 过滤1、过滤2：支持多值，同上 |
| `--ips` | 实例 id 或 ip：支持多值，同上 |
| `--contextId` | 链路 id |
| `--indexContext` | 消息 msg 模糊查询（**唯一**正确的内容检索参数；勿用 `--keyword`） |
| `--pageSize` | 每页条数，默认 20 |
| `--minutes` | 最近 N 分钟；`>0` 时优先于起止时间与默认窗口 |
| `--beginTime` / `--endTime`（或 `--begin` / `--end`） | 与 `--minutes` 互斥（未传 minutes 时生效）；须成对出现才作为显式范围，否则走默认 15 分钟 |
| `--queryRegion` | 可选。未传或空为**集团通用-全国**（参数值 `general_cn_all`）。支持完整值：`newpay_cn_east`（新生支付-华东），`newpay_ap-east-1`（新生支付-香港），`general_ap-southeast-1`（集团通用-新加坡）；历史 `default` 同全国。其它值透传。统一逻辑见 `SkyEyeApi.normalizeQueryRegion` |
| `--advancedSearchItems` | 高级搜索条件，默认 `[]`。每项为 `{ "filter", "compare", "value" }`，如 `{"filter":"indexContext","compare":"nlike","value":["msg1"]}` 表示 且indexContext 不包含 msg1；{"filter":"indexContext","compare":"like","value":["msg2"]}` 表示 且indexContext 包含 msg2；可传 JSON 数组或多次传单条 |
| `--ignoreEnvParamAsDataFilter` | 可选，`true`\|`false`，**默认 false**。默认是false。支持false/true,若是true代表是用env作为数据筛选条件，如仅查询qa或uat环境数据。若是false，代表查询同网络条件数据，比如线下test/qa/uat,线上stage,product的都会返回，不做具体单个环境过滤
| `--verbose` | 开启后打印调试信息（如缓存路径、参数等）；默认不打印，仅查询结果（printLogResult）始终输出 |

### 3. 查询 Checklist 指标（queryChecklist）

从缓存读取 token，向 checklist 指标接口发起查询。时间范围可选：`--minutes` 或 `--beginTime`/`--endTime`；均未指定时**默认最近 30 分钟**。**必须**指定 `--env`。

> **数据源说明：** Checklist 数据源采用**白名单方法**方式接入，仅白名单内的方法才会上报指标数据。若查询结果为空，可能是该方法尚未加入白名单，可联系 SRE **景瑶（yao.jing）** 协助添加。

**子命令（任选其一）：**

| 子命令 | 说明 |
|--------|------|
| `execute-count` | 执行次数 |
| `biz-exception-count` | 业务异常次数 |
| `biz-exception-rate` | 业务异常率 |
| `exception-count` | 异常次数 |
| `exception-rate` | 异常率 |
| `lt300ms-count` | 耗时<300ms 次数 |
| `lt300ms-rate` | 耗时<300ms 占比 |
| `total-time` | 总耗时 |
| `avg-time` | 平均耗时 |
| `max-execute-time` | 最大执行时间 |

**示例：**

```bash
# 最近 30 分钟 线下 环境执行次数
skyeye queryChecklist execute-count --env=uat --minutes=30   --dataKey="myProduct::myService::myMethod"

# 最近 30 分钟 线上 环境执行次数
skyeye queryChecklist execute-count --env=product --minutes=30   --dataKey="myProduct::myService::myMethod"

# 指定时间范围，按 dataKey 筛选
skyeye queryChecklist biz-exception-rate --env=product  --beginTime="2026-04-24 10:00:00.000" --endTime="2026-04-24 10:30:00.000" \
  --dataKey="myProduct::myService::myMethod"

# 按 productLine + serviceName + methodName 筛选
skyeye queryChecklist avg-time --env=product --minutes=60 --productLine=myProduct --serviceName=myService --methodName=myMethod

# 业务异常次数
skyeye queryChecklist biz-exception-count --env=product --minutes=30 --dataKey="myProduct::myService::myMethod"

# 异常次数
skyeye queryChecklist exception-count --env=product --minutes=30 --dataKey="myProduct::myService::myMethod"

# 异常率
skyeye queryChecklist exception-rate --env=product --minutes=30 --dataKey="myProduct::myService::myMethod"

# 耗时<300ms 次数
skyeye queryChecklist lt300ms-count --env=product --minutes=30 --dataKey="myProduct::myService::myMethod"

# 耗时<300ms 占比
skyeye queryChecklist lt300ms-rate --env=product --minutes=30 --dataKey="myProduct::myService::myMethod"

# 总耗时
skyeye queryChecklist total-time --env=product --minutes=30 --dataKey="myProduct::myService::myMethod"

# 最大执行时间
skyeye queryChecklist max-execute-time --env=product --minutes=30 --dataKey="myProduct::myService::myMethod"
```

**常用参数（queryChecklist）：**

| 参数 | 说明 |
|------|------|
| `--env` | 必填。环境，如 qa/uat/stage/product |
| `--minutes` | 最近 N 分钟，默认 30 |
| `--beginTime` / `--endTime`（或 `--begin` / `--end`） | 指定时间范围 |
| `--queryRegion` | 查询区域，同 queryLog |
| `--stepSecond` | 时序步长（秒），默认 60 |
| `--logicalIdc` | 逻辑机房，默认 `.*` |
| `--productLine` | checklist 自定义产品名 |
| `--serviceName` | checklist 自定义服务名 |
| `--methodName` | checklist 方法名 |
| `--dataKey` | `productLine::serviceName::methodName`，填写后优先于以上三字段 |
| `--groupBy` | 分组维度，如 `dataKey`，默认为空 |

### 4. 查询 TLB 指标（queryTlb）

从缓存读取 token，向 TLB 指标接口发起查询。时间范围可选：`--minutes` 或 `--beginTime`/`--endTime`；均未指定时**默认最近 30 分钟**。**必须**指定 `--env`。

**子命令（任选其一）：**

| 子命令 | 说明 |
|--------|------|
| `request-count` | TLB 请求次数 |
| `request-avg-elapsed` | TLB 平均耗时 |

**示例：**

```bash
# 最近 30 分钟 product 环境5xx请求次数
skyeye queryTlb request-count --env=product --minutes=30 --host=域名 --status=5..

# 按应用标识筛选
skyeye queryTlb request-count --env=product --minutes=30 --appUk=应用标识

# 指定时间范围，按应用标识和 URI 筛选
skyeye queryTlb request-avg-elapsed --env=product --beginTime="2026-04-24 10:00:00.000" --endTime="2026-04-24 
10:30:00.000" --appUk=应用标识 --requestUri=请求uri

# 新生支付-华东 product 环境请求次数
skyeye queryTlb request-count --env=product --minutes=30 --queryRegion=newpay_cn_east --appUk=应用标识

# 新生支付-香港 product 环境请求次数
skyeye queryTlb request-count --env=product --minutes=30 --queryRegion=newpay_ap-east-1 --appUk=my-app

# 集团通用-新加坡（海外）product 环境请求次数
skyeye queryTlb request-count --env=product --minutes=30 --queryRegion=general_ap-southeast-1 --appUk=my-app

# 集团通用-新加坡（海外）指定时间范围平均耗时，按 URI 筛选
skyeye queryTlb request-avg-elapsed --env=product --beginTime="2026-04-24 10:00:00.000" --endTime="2026-04-24 10:30:00.000" --queryRegion=general_ap-southeast-1 --appUk=my-app --requestUri="/api/v1/foo"

# 按状态码分组
skyeye queryTlb request-count --env=product --minutes=60  --host=api.example.com --groupBy=status
```

**常用参数（queryTlb）：**

| 参数 | 说明 |
|------|------|
| `--env` | 必填。环境，如 qa/uat/stage/product |
| `--minutes` | 最近 N 分钟，默认 30 |
| `--beginTime` / `--endTime`（或 `--begin` / `--end`） | 指定时间范围 |
| `--queryRegion` | 查询区域，同 queryLog |
| `--stepSecond` | 时序步长（秒），默认 60 |
| `--logicalIdc` | 逻辑机房，默认 `.*` |
| `--appUk` | 应用标识 |
| `--host` | 域名 |
| `--productLineName` | 产品线名称 |
| `--requestMethod` | 请求方法，如 GET、POST |
| `--requestUri` | 请求 URI |
| `--status` | HTTP 状态码 |
| `--groupBy` | 分组维度，如 `status`、`host`，默认为空 |

