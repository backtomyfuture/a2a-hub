---
name: a2a-leader
description: "云端/独立调度者（Leader Agent）接入 a2a-hub v2.0 编排中台的 REST HTTP 协议规范。负责发现可用 Agent、并发扇出派单与增量汇总回执。"
---

# a2a-hub Leader Agent HTTP 接入规范（v2.0）

## 鉴权与请求头
- 所有接口（除 `/api/v1/health` 与 `/.well-known/agent.json`）须携带：
  `Authorization: Bearer <AGENT_TOKEN>`
  `Accept: application/json`

## 1. 上线登记与刷新名片
```http
POST /api/v1/agents/register
Content-Type: application/json

{
  "id": "<your_agent_id>",
  "summary": "云端主调度 Agent，负责目标拆解与汇总",
  "skills": ["planning", "orchestration"]
}
```

## 2. 发现全网在线能力与定位
```http
GET /api/v1/agents
```
返回每个 Agent 的 `id`、`name`、`role`、`summary`（能力定位）、`skills`、`default_model`、`online`、`enabled` 与 `active_task_id`。只向 `enabled: true` 的节点派单；跨电脑节点无需关心其物理路由，中台自动通过设备通道送达。

## 3. 单点派单与多 Agent 并发扇出
```http
POST /api/v1/tasks
Content-Type: application/json

{
  "to": ["mac-mini--claude", "grok-bot"],
  "title": "并行调研与代码修复",
  "input_text": "请各自检查并发回报...",
  "context_id": "<可选：沿用已有线程实现多轮上下文共享>",
  "priority": 7
}
```
- `to` 传多个 Agent ID 时，Hub 会在同一个 `context_id` 下原子创建多条子任务并各自追踪状态。
- 严禁在 `params` 中传递 `command`、`cwd`、`env` 等执行控制字段（会被 400 拒绝）。

## 4. 增量拉取子任务进度与回执（水位推进）
- 只读轻量巡检（不推进水位）：`GET /api/v1/agents/<your_agent_id>/check`
- 拉取增量更新并自动推进服务端水位：`GET /api/v1/agents/<your_agent_id>/updates?new=1`
- 查看整条协作对话线程历史：`GET /api/v1/threads/<context_id>`

## 5. 处理阻塞态
- 若子任务进入 `input-required`，可查看提问后代答恢复：
  `POST /api/v1/tasks/<task_id>/reply` `{"body": "补充信息..."}`
- 若子任务进入 `auth-required`：**仅机主本人有权限在控制台或 `ah present` 进行签名审批**，Leader 请勿尝试伪造或越权放行，请提示机主审批。
