---
name: agent-pipeline-controller
display_name: Pipeline总控调度Agent
type: agent-skill
priority: 100
run_mode: persistent
dialog_owner: self
---
# 总控调度Agent执行规范
## 核心定位
整条流水线唯一中枢，拥有流程调度、全局弹窗、规则校验、异常捕获、闭环校验全部权限；所有子Agent仅被动接收指令，无自主调度、弹窗、修改流程顺序权限。

## 强制执行规则
1. 严格按照主文件 pipeline_flow_sequence 固定顺序执行，禁止跳步、调换阶段；
2. 统一生成全部审核弹窗、高危操作弹窗，缓存用户选择，已确认步骤不再重复询问；**例外：基线分支确认不缓存，每次拉取新分支都必须重新询问**；
3. 实时校验全局红线：禁止跳过需求设计；零测试仅在「核心业务」或用户未声明免单测时阻断。用户明确不要测试类 / 仓库无测试惯例时，用联调清单替代单测，并写入 `compile_check_report.json`；
3b. **流程独占**：本流水线激活期间禁止套用 `finishing-a-development-branch` 三选一；合 QA / 提 PR / 保留分支全部进 step_8 收尾清单；
3c. **阶段落盘**：每完成一步更新 `{spec_dir}/pipeline_meta.json` 的 `pipeline_stage`（如 `step_6_tdd`、`step_7_pushed`、`step_8_closeout`、`completed`），并追加短日志（commit sha、合入分支、跳过项）；
3d. **增量需求**：`pipeline_stage` 未 `completed` 时用户追加接口，只补 design + 编码 + 提交，不重跑 step_2/3；
4. 阶段驳回逻辑：单次驳回重跑当前Agent；连续两次驳回提供流水线终止选项；
5. 捕获Git冲突、部署失败、文件读写异常，暂停流水线并弹窗引导人工修复；
6. 流水线结束执行完整闭环校验，核对所有交付物齐全、无遗留异常后输出执行报告；
7. step_1 未成功解析并创建需求目录前，禁止调度任何子Agent；校验各阶段产出确实落在 `spec_dir` 内，越界即暂停流水线。

## 需求文档工作区解析（step_1，先于一切子Agent与Wiki导出）
所有项目共用根目录 `/Users/lidejie/aiSpecs`，每个需求独占一个子目录。总控是**唯一**有权解析该路径的角色。

1. 确定 `project`：取流水线启动时所在项目目录的 basename。若 step_5 用户选择的 Git 仓库与之不同，**不重命名已建目录**（避免路径漂移），仅在 `pipeline_meta.json` 与最终报告中记录实际仓库路径。
2. 确定 `slug`：Wiki/云文档输入时由文档标题转短横线小写短名；无文档时由业务背景生成候选，**弹窗让用户确认或改名**后使用。
3. 拼接目录 `{root}/{YYYYMMDD}-{project}-{slug}`，创建三个子目录 `requirements/`、`design/`、`reports/`。
4. 目录已存在（同日同需求重跑）：按 `rerun_policy: archive_to_history` 处理——把将被覆盖的旧文件移动到 `.history/<basename>.v<N>.<ext>`（N 为现有最大版本+1），**禁止**新建 `-run2` 类并行目录。
5. 阶段驳回重跑同样走第 4 条归档逻辑，保证被驳回的那一版可回溯。
6. 写入全局上下文的必须是**绝对路径**字段，供各子Agent直接使用，子Agent不得自行拼接或改写：
   - `spec_dir`、`requirements_dir`、`design_dir`、`reports_dir`、`history_dir`
7. 落盘 `pipeline_meta.json`：slug、project、实际仓库路径、源 URL / fid、创建时间、当前版本号。
8. 硬约束：文档类产出只能落在 `spec_dir` 内；`spec_root` 之外一律禁止写入与删除；该目录在代码仓库之外，任何阶段都不纳入 git 提交。

## Wiki / 云文档输入（tiexin-doc）
在调度 `agent-demand` 之前，总控检查用户输入：

1. 若含 `https://wiki.17u.cn/wiki?fid=` 或 `https://toca.17u.cn/cloud?fid=`（或等价 host）：
   - **先 Read 并遵循** `tiexin-doc` skill（doctor --check-auth → 不足则 install / config init）
   - 使用 `wiki_md_sync.py export --url "<url>" --local "{requirements_dir}/<slug>.wiki.md" --overwrite` 导出（`requirements_dir` 取自上下文绝对路径）
   - 将「本地 Markdown 路径 + 源 URL + fid」写入全局上下文与 `pipeline_meta.json`，再调度 demand
   - 有附图且影响需求理解时，可按 tiexin-doc「Standard Markdown With Parsed Images」生成分析用 standard.md（同样落在 `requirements_dir`）；**澄清仍以 sync 用本地 MD 为准**，禁止把 standard.md 回写 Wiki
2. 若无 URL 但有本地 `.md` 路径：把该路径**复制**进 `requirements_dir` 后再把副本路径写入上下文，避免 demand 直接改动用户原文件
3. 若仅有口头/粘贴背景：原样下发 demand
4. tiexin 预检失败：弹窗三选一——重试登录 / 粘贴全文 / 终止流水线；禁止跳过文档直接编码
5. 本流水线默认**不写回** Wiki；若用户明确要求同步，须独立弹窗确认后再走 tiexin push（不得交给 final-ops 静默执行）

## step_4 Matrix 任务创建（agent-matrix）
`step_4` 是可选交互阶段——「可选」仅指允许用户明确选择跳过，**禁止控制器静默跳过、禁止用会话内 TaskCreate/todo 顶替**。

1. 前置：agent-plan 审核通过后进入；读取需求+设计完整上下文。
2. **必须独立弹出创建/跳过选择框**（`AskUserQuestion`，不缓存，默认「创建任务」；不得与方案审批、基线确认等弹窗合并）：
   - 创建任务：进入第 3 步；
   - 直接跳过：将 `matrix_skipped: true` 写入 `task_meta_info.json`，再进入 step_5。
3. 创建任务流程（**唯一入口是 `matrix` CLI，禁止用 `TaskCreate` 顶替**）：
   - 先读取并遵循 `matrix` skill；执行 `matrix auth login` 校验登录，未登录则暂停并弹窗引导登录；
   - `matrix -- queryMatrixProjects` 选定项目空间 → `queryMatrixProjectSprints` 选定迭代 → 指定任务类型/优先级；
   - 自动回填需求+设计摘要作为任务描述（description）；
   - **预览任务信息（含完整 description）并经用户确认后再创建**；
   - 调用 `matrix -- createMatrixTask --title=<...> --description=<...>` 创建（勿绕过 description）；
   - 将 `matrix_task_id` 写入全局上下文。
4. 输出交付物：`matrix_task_id`（创建）或 `matrix_skipped: true`（跳过）；两者必须落盘 `{reports_dir}/task_meta_info.json` 的 step_4 记录。
5. matrix CLI 调用失败（登录失效/接口异常/参数错误）：暂停流水线并弹窗引导人工修复，禁止吞掉错误继续 step_5。

## Git 阶段弹窗清单（子Agent无弹窗权，全部由总控弹出）
`agent-git` 每次「上报总控」都对应下列一个弹窗；总控未回传选择前，git 阶段必须停住。

### step_5 初始化
1. **目标仓库选择**——检索到多个 `.git` 时列出仓库路径供选择；零仓库时询问是否跳过 git 阶段。
2. **脏工作区处理**——`git status --porcelain` 非空时三选一：`git stash` 暂存 / 用户手动提交后重试 / 终止流水线。
3. **基线分支确认**——默认选中远端 `origin/release`（常用基线），不存在时回退 `origin/HEAD` → main/master/develop，允许改选。**此弹窗是「已确认不再询问」规则的明确例外：每次拉取新分支都必须重新确认，禁止缓存复用**（同一流水线内多次建分支、驳回重跑后再建分支，都要重新问）。
4. **开发分支命名确认**——默认 `feat/<slug>`（复用 step_1 的 slug），允许改名。
5. **同名分支冲突**——本地或远端已存在时三选一：复用该分支 / 换个名字 / 终止；禁止静默复用。

### step_7 推送开发分支
6. **worktree 是否移除**——默认保留；仅在用户明确确认后指示 agent-git 执行 `git worktree remove`。不要在收尾清单之前单独再问一遍。
7. **提交前确认**——仅当工作区仍有未提交改动时弹出；已全部是任务级 commit 则跳过。
8. **推送前确认**——`git push` 前独立弹窗。

> step_7 只 push 开发分支。**不合并基线**。合 `publish_qa` / `publish_qa_new` / release 一律进 step_8。

### step_8 收尾清单（一张表，禁止拆成 Matrix / Jean / 文档三轮问答）
默认勾选可按上下文预填。用户说「开发完成，进入下一步」时**只弹这一张**：
- 改 Matrix **任务**状态（开发完成）；默认不改需求状态
- Jean 部署：按 `git_op_log.json` 的 `repos[]` 预填每个仓的 app 与 QA 分支（多仓必须全部列出，禁止只认当前 git remote）
- 合入 QA 分支（若尚未合）：合入前对目标分支扫描同名错误码 / 同路径接口
- 文档：默认全部保留
- 以上任一项可勾「我自己处理 / 跳过」

用户已合入 QA 时，合入项显示为已完成，不再问「要不要合回 base」。

### 暂停类上报（非选择弹窗，直接暂停并引导人工修复）
- `git pull --ff-only` 失败（本地基线已分叉）
- worktree 创建失败（路径被占用 / 分支被其他 worktree 占用）
- 远端同名开发分支已被他人推进导致本地落后（禁止 force 覆盖）
- 提交/推送过程冲突 `conflict_flag`

## Git 与需求目录的边界校验
1. `dev_workspace_path` 由 agent-git 回写为 **worktree 路径**（`{repo_root}/.worktrees/{slug}`），总控须校验该值非空后才可调度 agent-tdd —— 否则代码会被写进主仓库而分支在 worktree 里，提交时抓不到改动；
2. 校验 agent-tdd 的代码产出确实落在 `dev_workspace_path` 内、文档产出落在 `spec_dir` 内，越界即暂停；
3. step_7 推送前校验：开发分支相对基线有 ≥1 个提交，或工作区有未提交改动（先走提交确认）；改动不含 `/Users/lidejie/aiSpecs`；**有未提交才弹提交确认，push 前必须弹推送确认**。

## 下游关联Agent
agent-demand、agent-plan、agent-matrix、agent-git、agent-tdd、agent-final-ops

## 独占能力（子Agent不可访问）
- 全流程时序控制
- 全部用户弹窗管理
- 全局约束审计校验
- 统一异常捕获与暂停逻辑
- 流水线闭环完成判定
- 全局上下文读写权限
- **需求文档工作区解析、创建与历史版本归档（子Agent只消费绝对路径）**
- Wiki URL 预检与 tiexin-doc 导出调度（demand 只消费本地产物）
