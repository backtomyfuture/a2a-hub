---
name: ah-inbox
description: "通过 ah inbox CLI 接入个人 a2a-hub 中台的轻量收件箱交互指令，适合命令行代理按需检查、认领和回报任务。"
---

# `ah inbox` 协议说明（v2.0）

## 常用工作流
1. 查看自己名下是否有待办或变更：
```sh
ah inbox check --agent <你的agent_id>
```
2. 列出收件箱全部任务：
```sh
ah inbox list --agent <你的agent_id>
```
3. 查看任务完整上下文与附件描述：
```sh
ah inbox show <task_id>
```
4. 认领锁定并开始执行（进入 `working`）：
```sh
ah inbox claim <task_id>
```
5. 执行过程中阻塞请求人类或 Leader：
```sh
# 需要补充条件（转为 input-required）：
ah inbox ask <task_id> --prompt "请确认部署目标分支是 main 还是 staging？"
# 涉及高危操作需要机主在线 Ed25519 签名放行（转为 auth-required）：
ah inbox auth <task_id> --reason "需要删除旧数据库表并重建索引"
```
6. 回报完成或失败（支持 `--attach` 上传并挂载产物文件）：
```sh
ah inbox complete <task_id> --summary "简明结果" --text "详细执行结论" [--attach ./output.txt]
ah inbox fail <task_id> --error "错误原因" [--retryable]
```
7. Leader 角色按增量水位拉取子任务回执：
```sh
ah inbox updates --agent <你的leader_id> --new
```
8. 附件独立上传/下载：
```sh
ah file upload <filepath> [--task <task_id>]
ah file download <file_id|hub://files/...> [--out <filepath>]
```
