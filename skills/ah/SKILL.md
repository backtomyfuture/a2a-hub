---
name: ah
description: "个人多 Agent 编排中台（a2a-hub v2.0）主控命令行与集群运维指南。用于在主机上查看在线 Agent、向多个节点并行派单、处理阻塞审批与巡检服务状态。"
---

# a2a-hub 主控 CLI (`ah`)

## 核心概念（三层结构）
- **Agent**：具备独立能力和定位的执行单元（云端 HTTP Agent、本地/远端电脑同步的 CLI Worker）。
- **Device**：运行 `ah daemon` 的物理机或虚拟机，自动发现本地 Claude / Codex / OpenCode / Gemini 等 CLI。
- **Thread / Task**：以 `context_id` 串联的多轮对话与并发子任务，遵循 A2A 八态模型。

## 常用操作

### 1. 查看全网可用 Agent
```sh
ah agents list
ah agents pause <agent_id>
ah agents resume <agent_id>
```

### 2. 派发任务（支持多 Agent 并发扇出、附件与同线程续接）
```sh
ah task create --to <agent_id1,agent_id2> --title "简短标题" --text "详细目标与验收要求" [--attach ./spec.md]
# 在同一条 Thread 下延续上下文多轮执行：
ah task create --to <agent_id> --context <ctx_id> --text "补充下一步要求"
```

**派单与验单口径（Leader / 主控通用）**：
- **同事项续线程**：对同一执行方的追问、补充、复测，若属于同一事项，应视为原 Thread 的延续——仅当原任务处于 `input-required`（追问挂起）时用 `ah task reply <task_id>` 补答恢复；其余情况（原任务已终态，或需追加要求/复测）用 `ah task create --to <agent_id> --context <原 ctx_id>` 续派（同设备 CLI Worker 会按 `(context_id, worker_key)` 自动串行并 `--resume` 续接会话）。只有真正的新事项才新建 context，避免执行方丢失上下文重复核查、控制台线程割裂。
- **跳过已暂停节点**：派单前先用 `ah agents list` 确认目标已启用且在线；勿将 `paused`（`enabled=false`）节点放入 `--to` 扇出列表（任一目标暂停会导致整笔派单被 `409` 拒绝）。
- **主机级任务每机单派**：更新、安装、配置与主机巡检等机器级任务，每台设备只派给一个在线 Worker，避免同机多 CLI 并发操作同一套本地文件；仅在验证各 Worker 会话能力时才逐个派单。
- **按回执正文判结果**：跟踪任务至终态（`completed` / `failed` / `canceled` / `rejected`），汇报前核对回执正文；空输出或 `(执行完成，无输出文本)` 占位回执视为未验证，不可直接当作已完成结论。

### 3. 查看、附件传输与控制任务
```sh
ah task list [--state working] [--agent <agent_id>] [--json]
ah task show <task_id>
ah task reply <task_id> "机主补充说明" [--attach ./patch.diff]   # 仅适用于 input-required 状态
ah task cancel <task_id>
ah file upload ./report.pdf [--task <task_id>]
ah file download <file_id|hub://files/...> [--out ./report.pdf]
```

### 4. 处理待审批（auth-required）与追问（input-required）
```sh
ah present list
ah present approve <task_id> [--note "同意修改"]
ah present deny <task_id> [--note "危险操作拒绝"]
ah present reply <task_id> "确认使用方案 A"
```

### 5. 定时任务（`ah schedule`）
```sh
ah schedule list [--agent <agent_id>] [--json]
ah schedule run <schedule_id> [--every 6d] [--name "名称"] -- <原命令与参数...>
ah schedule ok <schedule_id> [简短说明] [--every 1d]
ah schedule fail <schedule_id> [失败原因]
ah schedule noop <schedule_id> [说明]
```

### 6. 运维与公网暴露
```sh
ah up [--listen 0.0.0.0:8787] [--service]
ah join http://<device_token>@<hub_host>:8787 --service
ah expose [tailscale | cf <https://domain> | status | off] --auto-token
ah doctor
ah service [--ensure | --remove]
```
