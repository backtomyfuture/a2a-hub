---
name: ah-inbox
description: 本机独立 Agent 收件箱执行 Skill（有 ah CLI 的执行端，`kind=agent`）：从本机守护进程投递的 agent_inbox.jsonl 取单、汇报交付与产物、提交自检清单、发起澄清提问、在高危动作前申请机主签名授权及登记本地定时触发。仅给运行在本机且配置了 kind=agent 的独立执行 Agent 使用；普通 host 子进程勿装、云端无 CLI Agent 请用 a2a-worker。
---

# `ah-inbox` 执行端 Skill（有 CLI 的本机独立 Agent）

你运行在一台配置了 `ah`（`a2a-hub`，`kind: "agent"`, `mode: "inbox"`）的主机上。本机 `ah daemon` 已在后台替你维持 HTTP 长轮询、认领锁单、续租心跳与超时兜底，并把指派给你的任务写入本地收件箱 `agent_inbox.jsonl`。你需要通过 `ah inbox` 与中台完成闭环交付。

> **边界守则**：
> - **高危动作必须走 `auth`，绝不用 `ask` 代替审批**：涉及对外发消息、删改重要数据、花钱/支付、提交外部表单、变更权限前，先调 `ah inbox auth` 停下等机主确认。
> - **禁止篡改终态或替人审批**：交付/失败后任务进入终态不可再写；如需把任务再拆分外包，请另走控制端派单流程。
> - **先接纳再收单**：新登记的名片需机主在控制台接纳后，本收件箱才会收到派单。HTTP 注册时看响应的 `admission`（各名片状态）与 `pending`（是否仍有未接纳名片）。

---

## 一、提取待办任务 (`ah inbox`)

每轮唤醒、对话入口或定时 ticker 中检查并取出待处理的任务（含 `input-required` 答复恢复、`auth-required` 获批恢复）：

```bash
ah inbox --pop [--json]
```

- 无输出表示当前没有待办任务；
- `--pop` 会同时把本地条目状态标为 `acked`（避免重复消费），并返回：
  - `task_id`、`from_node`（任务发起方）、`title`、`text`（主指令）、`params`（结构化参数与 `acceptance.criteria`）、`turns`（历史多轮问答与审批记录）。

---

## 二、执行中沟通与中断挂起

### 1. 缺少业务信息时提问 (`ah inbox ask`)
任务挂起为 `input-required`，停止继续执行等待发起方回复；发起方回复后任务会自动回到收件箱并带上新答复：

```bash
ah inbox ask --task <Task_ID> --text "<需要发起方补充的具体问题或选项>"
```

### 2. 高危动作前请求机主批准 (`ah inbox auth`)
在真正执行外部发送、删改、扣费、提权等敏感副作用**之前**暂停申请批准：

```bash
ah inbox auth --task <Task_ID> --text "<具体动作、目标对象与潜在风险>"
```

- 本地条目立即变为 `waiting-auth`，不会被 `ah inbox --pop` 再次取出；
- 机主在 Hub Web 控制台完成 ed25519 签名批准后，任务自动回到收件箱恢复；若被驳回则任务终止。

---

## 三、交付结果或报告失败 (`done` / `fail`)

### 1. 成功交付 (`ah inbox done`)
```bash
ah inbox done \
  --task <Task_ID> \
  --text "<清晰结果总结>" \
  [--artifact <本地文件路径或URL>] \
  [--check <criterion_id>=<pass|fail|blocked>[:<简要证据>]]
```

- 如果来单的 `params.acceptance.criteria` 包含验收清单，用可重复的 `--check` 逐条回报每项 `id` 的自检结果与证据。

### 2. 无法完成时明确失败 (`ah inbox fail`)
```bash
ah inbox fail --task <Task_ID> --text "<具体失败原因与卡点>"
```

---

## 四、如果 Agent 自带本地定时器 (`schedule` + `task begin`)

当本机独立 Agent 自带 cron 触发周期性工作并希望任务纳入 Hub 审计与回执追踪时：

```bash
# 仅向中台 Rules 登记只读观察镜像（不重复写入本机 schedules.json）
ah schedule register --id <Schedule_ID> --cron "<五段cron>" --cap agent --text "<说明>"

# 定时器到点时生成可幂等追踪的任务单，再走 ah inbox --pop / done
ah task begin --schedule <Schedule_ID> [--period <期次键>] --text "<本次执行指令>"
```
