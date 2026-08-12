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
6. 全局关闭skylog持久日志，仅终端临时输出执行信息；
7. 所有文档类产出只能落在本次需求目录内，`/Users/lidejie/aiSpecs` 之外禁止写入与删除。

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

## 五、需求文档工作区（所有项目共用一个根目录）
根目录固定 `/Users/lidejie/aiSpecs`，单层平铺，每个需求独占一个子目录：`{YYYYMMDD}-{项目名}-{需求slug}`。

```
/Users/lidejie/aiSpecs/
  20260812-drp-order-refund/
    requirements/        需求源文档（Wiki 导出）+ demand_summary.md / full_demand_doc.md
    design/              plan_summary.md / full_tech_plan.md / ddd_model_doc.md / bdd_scenarios.md / openapi.yaml
    reports/             task_meta_info.json / git_op_log.json / compile_check_report.json / deploy_result.json / doc_clean_log.json
    .history/            驳回重跑归档：demand_summary.v1.md / plan_summary.v1.md ...
    pipeline_meta.json   slug、项目、实际仓库路径、源 URL / fid、创建时间、版本号
  20260812-AiSkill-doc-path-fix/
```

规则：
1. 目录由**总控在 step_1 独家解析并创建**，绝对路径写入全局上下文；子Agent只消费路径，禁止自行拼接或改写；
2. `slug` 来自 Wiki 文档标题或用户确认，`项目名` 取启动时所在项目目录名；step_5 选定的仓库若不同，只记录进 `pipeline_meta.json`，**不重命名目录**；
3. 同日同需求重跑（含阶段驳回）复用同一目录，被覆盖的旧文件归档为 `.history/<名称>.v<N>.<扩展名>`，不新建 `-run2` 并行目录；
4. **文档与代码分离**：设计/需求文档进 aiSpecs，源码与单元测试留在代码仓库；两者不得互串；
5. 该目录在代码仓库之外，任何阶段都不纳入 git 提交；
6. 清理阶段的删除范围硬限制在本次需求目录内，越界即拒绝并上报。

## 六、Git 开发流程（step_5 建区 / step_7 收尾）
统一 **worktree 隔离**，分支名复用需求 slug，拉取基线必须发生在建分支之前。

```
step_5  定位仓库 → 脏工作区检查 → 确认基线分支（默认 release，每次都问不缓存）
        → fetch + pull --ff-only
        → 分支名 feature/<slug> → 同名分支检查
        → git worktree add {repo_root}/.worktrees/<slug> -b feature/<slug>
        → 回写 dev_workspace_path（= worktree 路径）

step_7  校验暂存区不含 aiSpecs → commit → fetch --prune
        → git push -u origin feature/<slug>   仅推开发分支，到此结束
        → worktree 默认保留
```

要点：
1. `dev_workspace_path` 指向 worktree 而非主仓库，是 agent-tdd 写代码的唯一依据；总控校验其非空后才可进 step_6；
2. **基线分支每次拉取新分支都重新确认**，默认选中远端 `origin/release`（不存在时回退 `origin/HEAD` → main/master/develop）；此为「已确认不再询问」缓存规则的明确例外；
3. **step_7 只 commit + push 开发分支**，不合并基线、不推送基线；入基线由用户在流水线外自行处理；
4. `.worktrees/` 通过 `.git/info/exclude` 忽略，不改动受版本控制的 `.gitignore`；
5. `--ff-only` 失败即暂停，禁止自动 merge/rebase 掩盖基线分叉；
6. 禁止 `push --force`、禁止自动解决冲突、禁止 `git add` aiSpecs 需求目录；
7. 仓库选择、脏工作区、基线确认、分支命名、同名分支、worktree 移除共 6 个弹窗全部由总控弹出。

## 七、启动加载方式
程序入口加载 `dev-pipeline-7agents.yaml`，自动递归读取agents目录下所有Agent配置与SKILL.md执行规则。

## 八、外部 Skill 依赖（文档读取）
当用户输入含 Wiki/云文档 URL（`wiki.17u.cn` / `toca.17u.cn`）时，**必须**按 `tiexin-doc` skill 读取，禁止臆造文档内容。

- Skill 路径：用户本机 `tiexin-doc`（如 `~/.agents/skills/tiexin-doc/SKILL.md` 或 Claude skills 同名目录）
- 主责：总控在 demand 阶段前完成预检与导出；`agent-demand` 以本地 Markdown 为需求源
- 导出落位：`{spec_dir}/requirements/<slug>.wiki.md`（由总控 step_1 解析的绝对路径）
- 默认只读：export / markdown-content；**禁止**未经用户确认的 wiki overwrite / push / 删除
- 降级：cli 未安装或未登录时，弹窗要求粘贴正文或提供本地 Markdown 路径
