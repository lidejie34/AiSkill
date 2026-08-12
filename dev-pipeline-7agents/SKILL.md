---
name: dev-pipeline-7agents
description: 7Agent拆分的端到端研发流水线：需求澄清→方案设计→任务拆解→Git工作区初始化→TDD编码→提交合并→部署与文档归档。当需要走需求先行、强制TDD、高危操作独立弹窗确认的完整研发流程时使用。
display_name: 7Agent拆分标准化端到端研发流水线
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
# 标准化端到端研发流水线（7Agent独立分仓架构）
## 一、架构概述
整体采用「1总控调度Agent + 6垂直专项Agent」拆分，每个Agent独立目录，分离配置文件`config.yaml`与AI执行说明`SKILL.md`。
全链路覆盖：需求澄清→方案设计→任务拆解→Git工作区初始化→TDD编码开发→Git提交合并→环境部署→文档归档清理。
核心红线：需求先行、设计前置、测试兜底，禁止跳过需求设计直接编码，禁止零测试交付。

## 二、全局强制约束（所有Agent必须遵守，仅总控校验）
1. 未完成需求澄清+方案设计，强制阻断编码阶段，无跳过入口；
2. 高危操作（分支合并、生产部署、文档删除）必须独立弹窗确认，不可合并多决策；
3. 单次阶段驳回仅重跑当前阶段；同一阶段连续两次驳回，可终止整条流水线；
4. 核心业务强制DDD+BDD+完整TDD循环；轻量接口必须主流程单元测试；
5. Git冲突、部署失败、文件异常直接暂停流水线，等待人工修复；
6. 全局关闭skylog持久日志，仅终端临时输出执行信息。

## 三、7个Agent分工清单
1. agent-pipeline-controller：总控中枢，流程调度、统一弹窗、全局校验、异常捕获、闭环校验
2. agent-demand：需求澄清，产出需求摘要/完整需求文档
3. agent-plan：方案设计，输出技术落地方案，禁止编写业务代码
4. agent-matrix：Matrix任务拆解，创建迭代任务或跳过
5. agent-git：Git工作区管理，分支初始化、提交、推送、合并、冲突检测
6. agent-tdd：TDD编码测试，双开发范式管控，强制测试交付
7. agent-final-ops：部署+文档清理，分级环境确认、文档逐文件删除确认

## 四、工程维护优势
1. 单Agent独立目录，修改编码逻辑仅改动agent-tdd，互不影响其他模块；
2. 机器配置(config.yaml)与AI执行指令(SKILL.md)分离，职责清晰；
3. 支持单人独立迭代、多人并行开发，减少代码冲突；
4. 支持单Agent单独下线、灰度更新、回滚；
5. 遵循Skill标准规范，每个Agent可独立调试、单独加载测试。

## 五、启动加载方式
程序入口加载 `dev-pipeline-7agents.yaml`，自动递归读取agents目录下所有Agent配置与SKILL.md执行规则。

## 六、外部 Skill 依赖（文档读取）
当用户输入含 Wiki/云文档 URL（`wiki.17u.cn` / `toca.17u.cn`）时，**必须**按 `tiexin-doc` skill 读取，禁止臆造文档内容。

- Skill 路径：用户本机 `tiexin-doc`（如 `~/.agents/skills/tiexin-doc/SKILL.md` 或 Claude skills 同名目录）
- 主责：总控在 demand 阶段前完成预检与导出；`agent-demand` 以本地 Markdown 为需求源
- 默认只读：export / markdown-content；**禁止**未经用户确认的 wiki overwrite / push / 删除
- 降级：cli 未安装或未登录时，弹窗要求粘贴正文或提供本地 Markdown 路径
