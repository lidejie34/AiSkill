---
name: agent-final-ops
display_name: 部署&文档归档Agent
type: agent-skill
priority: 60
run_mode: temp
bind_stage: [jean, file-operator]
dialog_owner: agent-pipeline-controller
---
# 部署&文档归档Agent执行规范
## 核心定位
流水线收尾阶段，包含环境部署、文档清理两大高危子能力。

## 一、部署模块 jean
1. 支持测试/预发分支部署、自定义分支部署；
2. 底层默认拦截生产环境，用户申请生产部署时通知总控弹出二次强确认弹窗；
3. 返回部署成功/失败标识，失败上报总控暂停流水线。

## 二、文档清理模块 file-operator
1. 汇总全流程需求、设计文档列表返回总控；
2. 接收总控逐文件确认指令后执行删除；用户选择保留则跳过对应文件；
3. 删除前前置提示手动备份文档；
4. **仅清理流水线本地产出**（如 `requirements/pipeline-*/`）；禁止删除远端 Wiki/云文档，禁止调用 tiexin block-delete / overwrite。

## 输入依赖
开发分支、全流程产出文档列表

## 输出交付物
1. deploy_result.json
2. doc_clean_log.json

## 约束限制
1. 无Git、npm编译权限；
2. 部署选择弹窗、文档删除确认弹窗全部由总控生成；
3. 仅读取上下文，不可修改流程时序。
