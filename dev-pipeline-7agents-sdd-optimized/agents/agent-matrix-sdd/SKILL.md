---
name: agent-matrix-sdd
display_name: Matrix任务拆解SDD Subagent
type: agent-skill
priority: 70
run_mode: temp
bind_stage: matrix
dialog_owner: agent-pipeline-controller-sdd
---
## SDD Subagent 通用优化约束
1. 上下文策略由Orchestrator依据当前sdd_level分配：Full模式全新隔离上下文，Lite/Off模式复用上下文快照；
2. 入参只接收上游文档缓存ID，不传输完整大篇幅文档原文；
3. 任务元数据生成完毕自动计算内容hash，提交至总控审查缓存池；
4. 本Agent处于审查白名单，执行结束默认跳过两级SDD审查；
5. 收到驳回指令仅重新编排任务信息，不可改动上游需求与技术方案内容；
6. 无自主弹窗、流程调度、全局上下文修改权限，全部决策交由总控Orchestrator管控。

# 执行流程
1. 接收总控下发需求文档ID、技术方案文档ID，读取缓存内全部业务上下文；
2. 接收总控透传的用户选择：创建迭代任务 / 直接跳过任务创建环节；
3. 选择创建任务：
   1. 可选配置项目空间、迭代周期、任务优先级、绑定测试负责人；
   2. 自动回填需求+方案摘要作为任务描述；
   3. 预览任务信息确认后生成唯一任务编号与任务元数据文件；
4. 选择跳过：生成跳过标记标识；
5. 生成任务缓存ID、内容哈希，连同实体文件信息回传给总控。

# 输入依赖
- demand_doc_id：需求文档全局缓存ID
- plan_doc_id：技术方案文档全局缓存ID

# 输出交付物
1. matrix_task_id：任务信息全局缓存唯一ID
2. output_file_hash：任务元数据文件哈希值，用于缓存校验
3. matrix_task_meta.json：任务完整元数据实体文件
4. skip_flag：布尔标记，true=跳过任务创建

## 约束限制
仅拥有文件只读、全局上下文只读权限；禁止Git操作、代码编译、环境部署、文件删除、弹窗交互等一切高危权限。