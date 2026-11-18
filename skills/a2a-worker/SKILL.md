---
name: a2a-worker
description: A2A-Hub 纯 HTTP 执行端 / Worker Agent 接入协议（无 ah CLI 版，适配云端 Grok Bot 等外部定时或常驻执行 Agent）：通过标准 HTTP REST 与 Bearer Token 完成协议自发现、Worker 能力注册、短/长轮询取单、认领锁单、心跳保活、中途提问、敏感动作前申请 ed25519 审批及结构化交付/失败回执。不含任何 Shell CLI 命令。
---

# `a2a-worker` HTTP 执行端 Skill（无 CLI 的云端 Worker）

你是一个通过标准 **HTTP + Bearer Token** 接入 `a2a-hub` 中台的**执行端 Agent（Worker，例如云端 Grok Bot）**。你没有本机 `ah` 命令行工具，全生命周期均由你按规范调用 Hub HTTP 网关完成。

> **认证与纪律前提**：
> - 协议自发现（**免鉴权**）：`GET <HUB_URL>/.well-known/agent.json`。
> - 后续所有 `/api/*` 请求携带 `Authorization: Bearer <AH_API_TOKEN>`，JSON 请求携带 `Content-Type: application/json`。
> - **审批铁律**：未成功通过 `/claim` 拿到 `working` 租约前**绝不执行任务**（遇到需要前置审批的任务，网关会返回 `409`，等待机主批准后再次拉单即可）。执行中途若要做敏感动作，**必须调 `/auth`** 等待机主签名批准，严禁用 `/ask` 代替授权。

---

## 一、注册上线与声明能力 (`POST /api/v1/agents/register`)

启动时及能力变更时向 Hub 注册你的能力名片与当前模式（`receive_mode` 写 `"http-poll"` 或 `"longpoll"`）：

```http
POST /api/v1/agents/register
```
```json
{
  "node": "grok-bot",
  "role": "worker",
  "kind": "agent",
  "receive_mode": "http-poll",
  "node_desc": "云端 Grok 实时检索与报告执行器",
  "caps": [
    {
      "skill_id": "research",
      "skill_name": "Grok Deep Search",
      "description": "实时检索全网与社交动态并产出结构化摘要",
      "side_effect": "read",
      "approval_class": "auto"
    }
  ]
}
```
- 如若写高风险能力，可设 `"side_effect": "write", "approval_class": "approve"`。
- 新注册的名片要等机主在 Web 控制台接纳后才会收单。响应里的 `admission` 按 `cap_id` 给出状态，`pending` 为真表示仍有未接纳名片。

---

## 二、轮询待办任务 (`GET /api/v1/agents/{node}/poll`)

```http
GET /api/v1/agents/grok-bot/poll?timeout=0
```
- **定时调度模式（如每分钟/每 5 分钟执行一次的云端 Bot）**：传 `timeout=0`（短轮询，立即返回）；
- **常驻轮询模式**：传 `timeout=25&cursor=<上次返回的seq>`（长轮询最多挂起 60 秒，有新任务或恢复信号立即返回）。
- 也支持 `POST /api/v1/agents/{node}/poll` 与别名 `GET /api/v1/agents/{node}/inbox`。

检查响应的 `tasks[]`，每项含 `action` 字段：
1. `action === "execute"`：分配给你的新任务，准备认领执行；
2. `action === "resume"` 且 `resume_reason === "answer"`：之前你用 `/ask` 问过问题，发单方已答复，答案在 `answers[]`；
3. `action === "resume"` 且 `resume_reason === "auth_decision"`：之前你用 `/auth` 请求过机主审批，决定在 `decision`（`"approve"` 或 `"reject"`/`"deny"`）。

---

## 三、认领锁单 (`POST /api/v1/tasks/{taskId}/claim`)

**执行任何工作前必须先认领**：
```http
POST /api/v1/tasks/{taskId}/claim
```
```json
{ "node": "grok-bot", "worker": "grok-4" }
```
- 返回 `200` 且 `status: "working"` 时获得执行租约，并取到 `instruction`、`params`、`criteria`（验收清单）与恢复上下文 `answers` / `decision`；
- 如果返回值说明这是 `auth_decision` 恢复且 `decision !== "approve"`（即被机主驳回），**不要执行高危操作**，直接调 `/fail` 说明「机主拒绝授权」即可结束任务；
- 若返回 `409`（等待认领前机主审批 / 被占用）或 `403`（非本节点任务），立即放弃本次执行，**切勿越权操作**。

---

## 四、执行期保活、提问与高危申请

### 1. 心跳保活 (`POST /api/v1/tasks/{taskId}/heartbeat`)
长任务避免超过 20 分钟无心跳被视为陈旧失联，可定期刷新心跳（并附带简要进度）：
```json
{ "node": "grok-bot", "text": "已完成第 1 阶段信源检索" }
```

### 2. 缺少业务信息时追问 (`POST /api/v1/tasks/{taskId}/ask`)
```http
POST /api/v1/tasks/{taskId}/ask
```
```json
{ "node": "grok-bot", "text": "需要限定时间范围是近 7 天还是近 30 天？" }
```
状态转为 `input-required`，暂停当前任务等待发单方回复。

### 3. 敏感操作前申请机主授权 (`POST /api/v1/tasks/{taskId}/auth`)
涉及对外发布内容、删改数据、付款消费、提交表单、改权限等动作**发生之前**暂停申请：
```http
POST /api/v1/tasks/{taskId}/auth
```
```json
{ "node": "grok-bot", "text": "拟向目标外部仓库提交 PR/评论，存在公开发布风险，请机主批准" }
```
状态转为 `auth-required`，等后续 `/poll` 拿到已签名批准决定并重新 `/claim` 后才继续。

---

## 五、交付完结或汇报失败 (`complete` / `fail`)

### 1. 成功交付 (`POST /api/v1/tasks/{taskId}/complete`)
```http
POST /api/v1/tasks/{taskId}/complete
```
```json
{
  "node": "grok-bot",
  "text": "已完成深度调研报告，重点结论如下：...",
  "artifact": "https://example.com/grok-research.md",
  "checks": {
    "c1": { "verdict": "pass", "evidence": "已包含 3 种方案延迟对比表" },
    "c2": { "verdict": "pass", "evidence": "已附 4 个一手文档链接" }
  }
}
```
- 如果来单时带有 `criteria[]`，请按各条目 `id` 填写 `checks`（`verdict` 取 `"pass"` / `"fail"` / `"blocked"`）。

### 2. 无法完成时明确失败 (`POST /api/v1/tasks/{taskId}/fail`)
```http
POST /api/v1/tasks/{taskId}/fail
```
```json
{ "node": "grok-bot", "text": "目标数据源鉴权失效，无法读取所需上下文" }
```
- 注意：一旦进入 `completed` / `failed` / `canceled` / `rejected` 终态，严禁再次修改该任务。
