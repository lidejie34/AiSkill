---
name: dev-pipeline-7agents-sdd-optimized
description: SDD分级优化版7Agent研发流水线：内置Full/Lite/Off三级自动分级，配合交付物缓存复用、增量diff审查、低风险阶段审查白名单，在保留需求先行与强制TDD的前提下降低执行耗时与Token消耗。当需要按需求规模自动伸缩流程强度的完整研发流程时使用。
display_name: SDD分级优化版7Agent标准化研发流水线
priority: 100
auto_bootstrap: true
override_default_flow: true
global_constraints:
  disable_skylog: true
  all_risky_ops_mandatory_confirm: true
  forbid_skip_demand_design: true
  forbid_zero_test_release: true
  rollback_rule: single_reject_rollback_stage, double_reject_support_terminate
---
# SDD分级优化 7Agent融合流水线总文档
## 一、架构说明
基于Subagent-Driven Development融合7层垂直Agent架构，内置**三级SDD自动分级优化机制**，解决原版执行慢、Token消耗高问题：
1. Full 完整SDD：大型核心业务，全隔离上下文+双审查+TDD细分子任务
2. Lite 轻量SDD：中小型迭代，合并审查、简化上下文、关闭TDD细分
3. Off 关闭SDD：Hotfix/纯文档/单行修改，退回原生7层无额外校验

## 二、核心优化能力
1. 自动判定需求规模，动态切换SDD等级，也支持人工强制选择
2. 交付物ID全局缓存，不重复传输完整文档，降低Token
3. 增量diff审查、未改动文件复用审查缓存，避免重复校验
4. 低风险阶段审查白名单，跳过无意义Spec/Quality校验
5. TDD细分任务阈值控制，简单代码关闭多层微型子任务
6. SKILL规则懒加载，仅当前SDD等级加载对应规则文本
7. 上下文快照复用，非高危流程不重复新建空白会话

## 三、7个SDD Subagent分工
1. agent-pipeline-controller：SDD Orchestrator总控，调度、缓存、审查分发、分级判定
2. agent-demand：需求澄清子代理
3. agent-plan：方案设计子代理
4. agent-matrix：Matrix任务拆解子代理（审查白名单）
5. agent-git：Git工作区管理子代理
6. agent-tdd：TDD编码测试子代理（内置细分任务开关）
7. agent-final-ops：部署&文档归档子代理（无代码场景免审查）

## 四、全局强制红线（SDD各级别均生效）
1. 禁止跳过需求、设计直接编码
2. 核心业务完整TDD；轻量接口默认主流程单测，用户免单测或仓库无测试惯例时走联调清单。OMS/网关类改动默认 Lite，不要按 Full TDD 拆微型子任务。
3. 高危操作（合并/生产部署/删文件）独立弹窗二次确认
4. Git冲突、部署失败暂停流水线等待人工修复
5. 同一阶段两次驳回可终止流水线
6. 全局关闭skylog持久日志，仅终端临时输出

## 五、加载方式
启动加载 `dev-pipeline-7agents-sdd-optimized.yaml`，自动读取agents下所有Agent配置与规则文档

## 六、外部 Skill 依赖（Wiki / 云文档）
需求澄清优先使用本地 Markdown；若用户输入为 Wiki / toca URL，总控须先按 **`tiexin-doc`** Skill 完成 CLI/鉴权检查与 `wiki_md_sync.py export`，再将本地路径交给 `agent-demand-sdd`。默认不写回 Wiki；`agent-final-ops` 清理仅针对流水线本地产出目录，禁止静默删除远端 Wiki。
