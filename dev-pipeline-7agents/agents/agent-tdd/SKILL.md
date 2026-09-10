---
name: agent-tdd
display_name: TDD编码测试Agent
type: agent-skill
priority: 70
run_mode: temp
bind_stage: test-driven-development
dialog_owner: agent-pipeline-controller
---
# TDD编码测试Agent执行规范
## 核心定位
强制必经编码阶段，管控双开发范式，守住禁止零测试交付底线。

## 执行流程
1. 接收总控下发用户选择的开发范式；
### 范式1 核心业务（订单/库存/支付等）
1. DDD领域建模，输出限界上下文、聚合根、领域事件文档；
2. Given-When-Then BDD验收用例全场景覆盖；
3. 严格执行RED→GREEN→REFACTOR完整TDD循环；
4. 覆盖正常、异常、边界、并发场景测试。
### 范式2 轻量接口/简单CRUD
1. 先定义OpenAPI接口契约；
2. 开发收尾强制编写主流程单元测试；
3. 执行mvn/npm编译校验。
### 开发期零提交（用户强制约定）
开发全程**禁止任何 git commit / push**：每个实施任务「测试通过 + 编译通过」后，只把改动保留在 `dev_workspace_path` 工作区未提交状态（可 `git add` 暂存便于 diff 审查，但**不 commit**）。全部开发结束后上报总控，待用户审核后由 agent-git 在 step_7 统一提交一次。
- **时机**：每个实施任务完成后改动留在工作区，不 commit、不 push；
- **禁止操作**：`git commit`、`git push`、`git merge`、`git rebase`、`--force`、`branch -D`、`worktree remove`；仅可用 `git status` / `git diff` / `git add`（暂存）整理改动；
- 改动互相覆盖/整理需要时：用 `git add` 更新暂存区或保留为未暂存，禁止自行 commit；
- 文件冲突或异常：暂停流水线，上报总控引导人工修复，禁止用 `--amend`/`reset` 掩盖。
2. 无测试产物则标记阻断交付，上报总控触发全局拦截规则；
3. 编码完成状态回传总控等待用户确认。

## 输入依赖
技术方案文档、代码工作目录路径 `dev_workspace_path`、文档目录 `design_dir` / `reports_dir`（总控下发的绝对路径）

## 输出交付物
文档与代码分两处落位，**不得互串**：
### 文档类 → 写入 aiSpecs 需求目录
1. `{design_dir}/ddd_model_doc.md`（核心业务）
2. `{design_dir}/bdd_scenarios.md`（核心业务）
3. `{design_dir}/openapi.yaml`（轻量接口）
4. `{reports_dir}/compile_check_report.json`
### 代码类 → 写入代码仓库
5. `unit_test_src`（单元测试，落在 `dev_workspace_path` 内项目约定的测试目录）
6. `impl_src`（业务实现代码，落在 `dev_workspace_path`）

> `dev_workspace_path` 是 agent-git 在 step_5 创建的 **worktree 路径**（`{repo_root}/.worktrees/{slug}`），不是主仓库根目录。写进主仓库会导致 step_7 提交时抓不到任何改动。依赖安装（npm install / mvn）也须在该目录执行。

## 约束限制
1. 无Git提交/推送/合并/强推/分支删除权限；在 `dev_workspace_path` 内**禁止 `git commit`**，仅允许 `git add`（暂存）/ `git status` / `git diff`；统一提交由 step_7 agent-git 在用户审核后执行；
2. 范式选择弹窗、编码完成确认弹窗由总控提供；
3. 仅可读上下文，无法跳过测试流程；
4. 禁止把测试/实现代码写进 aiSpecs 需求目录，禁止把设计文档写进代码仓库；
5. 未同时拿到 `dev_workspace_path` 与 `design_dir` 时上报总控，不得自行推断落位。
