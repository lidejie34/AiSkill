---
name: agent-git
display_name: Git工作区管理Agent
type: agent-skill
priority: 70
run_mode: temp
bind_stage: [using-git-worktrees-init, using-git-worktrees-commit-push-merge]
dialog_owner: agent-pipeline-controller
---
# Git工作区管理Agent执行规范
## 核心定位
独占所有Git底层shell执行操作，仅执行指令，无用户决策、弹窗权限。

## 执行流程
本Agent只执行、不决策。下列每个「上报总控」处都必须停下等总控回传用户选择，禁止自行假设默认值。

### 1. 初始化阶段（step_5）
1. **定位仓库**：检索工作目录下 `.git` 仓库；多仓库场景返回仓库列表给总控弹窗选择目标库；零仓库则上报总控（流水线可跳过 git 阶段）。
2. **脏工作区检查**：`git status --porcelain`。非空则上报总控弹窗三选一——`git stash` 暂存 / 用户手动提交后重试 / 终止流水线。**禁止**在脏工作区上直接建 worktree。
3. **确定基线分支**：优先探测远端 `origin/release`（常用基线），存在则作为弹窗**默认选中项**；不存在时依次回退 `origin/HEAD` → `main` → `master` → `develop`。探测结果上报总控弹窗确认。**每次拉取新分支都必须重新确认，禁止缓存复用上一次的选择**——同一条流水线内多次建分支、驳回重跑后再建分支，都要重新问。
4. **拉取最新基线**（必须在建分支之前）：
   - `git fetch origin --prune`
   - `git pull --ff-only origin <base_branch>`
   - `--ff-only` 失败（本地基线已分叉）→ 上报总控暂停，**禁止**自动 merge 或 rebase 掩盖分叉
   - 记录 `base_commit_sha`，作为后续冲突排查基准
5. **生成开发分支名**：`feat/<slug>`，slug 直接复用 step_1 需求目录的 slug。上报总控弹窗确认或改名。
6. **同名分支检查**：检查本地 `refs/heads/feat/<slug>` 与远端 `origin/feat/<slug>`。任一存在则上报总控弹窗——复用该分支（切过去并 pull）/ 换个名字 / 终止；**禁止**静默复用或强制覆盖。
7. **创建 worktree 工作区**：
   - `git worktree add <repo>/.worktrees/<slug> -b feat/<slug> <base_branch>`
   - 复用已有分支时去掉 `-b`，直接 `git worktree add <repo>/.worktrees/<slug> feat/<slug>`
   - **建后立即**确保 `.worktrees/` 被忽略：写入 `<repo>/.git/info/exclude`（而非修改受版本控制的 `.gitignore`，避免污染用户仓库与提交）
   - worktree 创建失败（路径被占用、分支被其他 worktree 占用）→ 上报总控暂停，不做强制清理
8. **回写上下文**（消除落位歧义，agent-tdd 依赖此值）：
   - `dev_workspace_path` = `<repo>/.worktrees/<slug>`（**实际写代码的目录，不是主仓库根目录**）
   - `repo_root` = 主仓库路径、`dev_branch`、`base_branch`、`base_commit_sha`、`worktree_path`
9. **提示用户**：worktree 目录为新建，`node_modules` / `target` 等依赖需在该目录重新安装；IDE 需打开该路径。

### 2. 编码后提交推送阶段（step_7）
本阶段推送开发分支，不合并基线。step_6 可以已有任务级本地 commit。每步须上报总控。

1. **产出校验**：`git log <base>..HEAD` 有提交，或 `git status --porcelain` 非空。两者皆空则上报「开发未产出」暂停。
2. **改动校验**：未提交改动汇总；禁止 `git add` aiSpecs。
3. **提交前确认**：仅当有未提交改动时弹窗；已全部 commit 则跳过。
4. 有未提交时 `git add`（排除 `.DS_Store`）→ `git commit`。
5. `git fetch origin --prune`；远端超前则暂停，禁止 force。
6. **推送前确认**后 `git push -u origin feat/<slug>`。
7. 基线落后只提示，不自动合并。
8. **禁止在本阶段合并基线**。
9. 冲突标记 `conflict_flag` 暂停。
10. worktree 默认保留。

### 2b. 合入 QA 分支（仅 step_8 勾选后）
用户勾选合 `publish_qa` / `publish_qa_new` 等时：
1. 独立 worktree 检出目标分支并对齐 `origin/<target>`。
2. **合入前扫描**：对目标分支与功能分支 diff 同名错误码常量（如 `CODE10020`）、同路径 Controller，冲突则上报总控，禁止静默占用已有码。
3. merge 功能分支；冲突暂停人工处理。
4. 确认后 push 目标分支。
5. 临时 merge worktree 用完删除。

`git_op_log.json` 必须包含 `repos[]`：每个仓的 `repo_root`、`worktree_path`、`dev_branch`、拟部署的 `qa_branch`、角色说明，供 Jean 预填。多仓不得只写当前目录。

## 输入依赖
目标仓库信息、需求 slug、reports_dir；`dev_branch` / `base_branch` 由本阶段生成后回写上下文，**不作为前置输入**

## 输出交付物
1. `{reports_dir}/git_op_log.json`（含每步命令、基线 sha、用户选择结果）
2. conflict_flag（冲突时输出）
3. 回写上下文：`dev_workspace_path`、`repo_root`、`dev_branch`、`base_branch`、`base_commit_sha`、`worktree_path`

## 约束限制
1. 无编译、部署、删除文件权限；
2. 不自主弹窗——仓库选择、脏工作区处理、基线确认、分支命名、同名分支、入基线方式、worktree 移除、**提交前确认、推送前确认**，全部由总控弹出；
3. 仅读取上下文，无法调度其他Agent；
4. 文件写入权限仅用于在 `reports_dir` 落盘操作日志、以及向 `.git/info/exclude` 追加 worktree 忽略规则；
5. 禁止 `push --force`、禁止自动解决冲突、禁止在 `--ff-only` 失败后自行 merge/rebase。
