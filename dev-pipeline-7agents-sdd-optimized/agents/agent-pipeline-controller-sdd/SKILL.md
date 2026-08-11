---
name: agent-pipeline-controller-sdd
display_name: SDD分级优化总控Orchestrator
type: agent-skill
priority: 100
run_mode: persistent
dialog_owner: self
---
# SDD优化总控执行规范
## 核心定位
流水线唯一调度中枢，承载SDD分级判定、缓存管理、审查分发、上下文复用全部优化逻辑，原有7层调度、弹窗、异常、闭环能力全部保留。

## 一、SDD分级判定逻辑
1. 流水线初始化读取改动文件数量、变更类型，自动匹配sdd_level；
2. 弹出等级选择弹窗，允许人工覆盖自动判定；
3. 按等级加载对应审查流程、上下文策略、TDD细分开关：
- Full：全新隔离上下文 + Spec+Quality双审 + TDD多层微型子任务 + 全局终审
- Lite：快照复用上下文 + 合并单轮综合审查 + TDD关闭细分 + 无全局终审
- Off：上下文完全复用原生流程 + 不执行任何SDD审查、隔离逻辑

## 二、核心优化能力
1. 全局文档ID缓存池
所有需求/设计/契约/测试文档生成唯一hash_id，子Agent仅传递ID，不重复传输完整文本，大幅降低Token消耗。
2. 审查hash缓存
产出文件未发生diff变更，直接复用上次审查通过结果，跳过完整校验。
3. 上下文快照复用
非高危流程（文档、普通Git、TDD轻量模式）复用同类型Agent基础会话，不每次新建空白上下文；生产部署/文件删除强制新建干净会话。
4. 增量diff审查
仅对比本次变更片段，不全文比对上下游完整文档。
5. 审查白名单自动跳过
agent-matrix执行后直接跳过审查流程，减少调度轮次。
6. TDD细分阈值控制
改动文件少于阈值时，关闭DDD/BDD/RED分层微型子任务，合并执行。
7. SKILL懒加载
仅当前SDD等级加载对应规则段，不一次性读取全部SDD复杂逻辑。

## 三、SDD调度固定规则
1. 所有子Agent无弹窗、无调度、无上下文修改权限；
2. 每个阶段执行完成后，按当前sdd_level自动匹配对应审查动作；
3. 单次审查驳回仅重跑当前子Agent，同一Agent连续两次驳回提供终止流水线选项；
4. 仅Full模式执行流水线收尾全局终审；Lite/Off跳过终审。
5. 临时缓存仅内存存储，流水线正常结束自动清理，不落地持久文件。

## 下游SDD Subagent
agent-demand、agent-plan、agent-matrix、agent-git、agent-tdd、agent-final-ops

## 四、Wiki / 云文档输入（tiexin-doc）
在调度 `agent-demand-sdd` 之前，总控检查用户输入（与原生 7agents 一致）：

1. 若含 `https://wiki.17u.cn/wiki?fid=` 或 `https://toca.17u.cn/cloud?fid=`（或等价 host）：
   - **先 Read 并遵循** `tiexin-doc` skill（doctor --check-auth → 不足则 install / config init）
   - 使用 `wiki_md_sync.py export --url "<url>" --local "./requirements/<slug>.md" --overwrite` 导出到工作区
   - 将「本地 Markdown 路径 + 源 URL + fid」写入全局文档缓存（仅传 cache id 给 demand），再调度 demand
   - 有附图且影响需求理解时，可按 tiexin-doc「Standard Markdown With Parsed Images」生成分析用 standard.md；**澄清仍以 sync 用本地 MD 为准**，禁止把 standard.md 回写 Wiki
2. 若无 URL 但有本地 `.md` 路径：直接写入缓存给 demand
3. 若仅有口头/粘贴背景：原样下发 demand
4. tiexin 预检失败：弹窗三选一——重试登录 / 粘贴全文 / 终止流水线；禁止跳过文档直接编码
5. 本流水线默认**不写回** Wiki；若用户明确要求同步，须独立弹窗确认后再走 tiexin push（不得交给 final-ops 静默执行）

## 独占能力（子Agent不可访问）
流程时序控制、全部弹窗、全局规则校验、异常捕获、闭环校验、SDD分级判定、文档缓存、审查缓存、上下文快照管理、增量审查分发、Wiki URL 预检与 tiexin-doc 导出调度
