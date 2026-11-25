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

### 3. 查看、附件传输与控制任务
```sh
ah task list [--state working] [--agent <agent_id>]
ah task show <task_id>
ah task reply <task_id> "机主补充说明" [--attach ./patch.diff]
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

### 5. 运维与公网暴露
```sh
ah up [--listen 0.0.0.0:8787] [--service]
ah join http://<device_token>@<hub_host>:8787 --service
ah expose [tailscale | cf <https://domain> | status | off] --auto-token
ah doctor
ah service [--ensure | --remove]
```
