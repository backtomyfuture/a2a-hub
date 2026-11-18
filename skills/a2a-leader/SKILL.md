---
name: a2a-leader
description: A2A-Hub 纯 HTTP 控制端 / Leader Agent 接入协议（无 ah CLI 版，适配云端 Muse Leader 等外部编排 Agent）：通过标准 HTTP REST 与 Bearer Token 完成协议自发现、Leader 注册、查看全网 Agent 名录、异步派单与发起 SOP Loop、轮询所派任务更新、原任务答复追问及撤单。不含任何 Shell CLI 命令。
---

# `a2a-leader` HTTP 控制端 Skill（无 CLI 的云端 Leader）

你是一个通过标准 **HTTP + Bearer Token** 接入 `a2a-hub` 中台的**主控编排者（Leader Agent，例如 Muse）**。你所在环境没有 `ah` 命令行工具，所有调度、跟单、答复均通过 Hub 暴露的 HTTP 网关完成。

> **认证与探索前提**：
> - 先用 `GET <HUB_URL>/.well-known/agent.json`（**免鉴权**）探测中台版本与协议端点；
> - 后续所有 `/api/*` 请求在请求头携带：`Authorization: Bearer <AH_API_TOKEN>`，JSON 请求带 `Content-Type: application/json`。
> - 你**只负责编排与调度**：遇到 `auth-required` 时请通知机主前往 Web 控制台（或审批接口）签名批准，绝不代批或伪造决策；遇到 `input-required` 时只能在原任务调 `/reply`，禁止新开单代替答复。

---

## 一、上线注册与发现全网能力

### 1. 注册为纯 Leader（启动时调用一次，定期刷新活跃态）
```http
POST /api/v1/agents/register
```
```json
{
  "node": "muse",
  "role": "leader",
  "kind": "agent",
  "receive_mode": "http-poll",
  "node_desc": "Muse 云端主控编排 Leader"
}
```
- `role: "leader"` 会在 Web 控制台展示你的在线状态，但不对外声明接单技能名片（若你也愿意被他人派单，改用 `role: "hybrid"` 并附带 `caps` 数组）。

### 2. 查询全网在册宿主节点、Worker 与技能名片
```http
GET /api/v1/agents
```
从返回的 `agents[]` 中查看每个节点（如办公主机 `office-pc`、云端 `grok-bot`）的 `online`、`mode`、以及 `caps[]` 下的 `worker`、`skill_id`、`cap_id`、`side_effect`、`dispatchable`、`admission`。只能向 `caps[].admission` 为 `admitted` 的名片派单。

---

## 二、异步派单与多阶段闭环

### 1. 派发单任务 (`POST /api/v1/tasks`)
```http
POST /api/v1/tasks
```
```json
{
  "from": "muse",
  "to": "grok-bot",
  "cap": "research",
  "worker": "",
  "text": "调研并对比 A2A 长轮询与短轮询方案",
  "params": { "scope": "architecture" },
  "criteria": [
    { "id": "c1", "text": "给出对比表格", "verify": "agent" },
    { "id": "c2", "text": "附上可访问参考来源", "verify": "agent" }
  ],
  "approval": "auto",
  "context": "",
  "idempotencyKey": "optional-dedup-key"
}
```
- 若要派给某台固定主机上的特定本地 CLI（如 `office-pc` 上的 `claude`），填 `"to": "office-pc", "worker": "claude"`（省略 `cap` 会用其通用执行名片）。
- 成功返回 HTTP `201`，包含 `task_id`（例如 `"TASK-20261115-xxxxxx"`）。

### 2. 发起多阶段 SOP 闭环 (`POST /api/v1/loops`，可选)
当需要中台自动驱动 `plan → code → verify` 多阶段闭环并基于验收回跳时：
```http
POST /api/v1/loops
```
```json
{
  "from": "muse",
  "to": "office-pc",
  "worker": "claude",
  "template": "plan-code-verify",
  "title": "自动修复并验证认证竞态",
  "goal": "定位 token 并发刷新问题、修改实现并通过单测",
  "maxIterations": 5
}
```
可配合 `GET /api/v1/loops` 查看阶段历史，或 `POST /api/v1/loops/{loopId}/cancel` 终止闭环。

---

## 三、跟单拉取更新、答复追问与撤单

### 1. 拉取由你发起的任务状态更新 (`GET /api/v1/agents/{node}/updates`)
```http
GET /api/v1/agents/muse/updates?timeout=0
```
- 若你的平台靠 **cron/定时器唤醒**：使用 `timeout=0`（立即返回当前需要关注的结果，不阻塞连接）；
- 若你支持 **常驻挂起等待**：使用 `timeout=25&cursor=<上次返回的seq>`（最多 60 秒长轮询，一有结果毫秒级返回）；
- 默认只返回以下关键状态：`completed`、`failed`、`rejected`、`canceled`、`input-required`、`auth-required`（也可用 `&status=working` 按需筛选）。
- 返回条目包含：`task_id`、`status`、`target_node`、`result_text`、`question_text`、`auth_text`、`notice_text`、`acceptance`、`artifacts[]`。

### 2. 答复下级 Worker 的提问 (`POST /api/v1/tasks/{taskId}/reply`)
当 `updates` 中出现 `status === "input-required"` 且 `question_text` 非空时，分析并答复原任务：
```http
POST /api/v1/tasks/{taskId}/reply
```
```json
{
  "from": "muse",
  "text": "请优先关注 HTTP REST 场景，保留完整引用链接。"
}
```

### 3. 全量查询与撤销自己发起的任务
- 筛选查单：`GET /api/v1/tasks?from=muse&status=working&limit=50`
- 查单条完整明细（含 Messages / Runs / Artifacts）：`GET /api/v1/tasks/{taskId}`
- 取消未终态任务：`POST /api/v1/tasks/{taskId}/cancel`，请求体 `{ "from": "muse", "text": "需求变更，终止该任务" }`（注意：中台仅允许任务发起方或 Hub 取消）。
