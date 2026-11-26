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
- `to` 传多个 Agent ID 时，Hub 会在同一个 `context_id` 下原子创建多条子任务并各自追踪状态；多目标列表中若含任一已暂停（`enabled: false`）节点，整笔请求会被 `409` 拒绝。
- **同事项续线程**：对同一执行方的追问、补充或复测，若属于同一事项，原任务处于 `input-required` 时走 `POST /api/v1/tasks/<task_id>/reply` 补答恢复；其余情况（原任务已终态或需追加新指示）必须携带原 `context_id` 续派（使同设备 CLI Worker 自动 `--resume` 续接会话并保持线程完整），只有真正的新事项才留空新建线程。
- **主机级任务每机单派**：主机更新、安装、配置或巡检类任务每台设备仅派给一个在线 Worker，避免同机多 CLI 并发冲突。
- 严禁在 `params` 中传递 `command`、`cwd`、`env` 等执行控制字段（会被 400 拒绝）。

## 4. 增量拉取子任务进度与回执（水位推进）
- 只读轻量巡检（不推进水位，同时刷新在线心跳）：`GET /api/v1/agents/<your_agent_id>/check`（返回 `leader_updates_count`、`pending_count` 与 `tasks`；无更新时应静默结束不报空）
- 支持常驻循环的节点可用 `GET /api/v1/agents/<your_agent_id>/poll?since=<seq>&timeout=35` 实时等待子任务回执与直派任务；不支持常驻循环的云端节点应配置定时轮询 `/check` -> `/updates?new=1`
- 拉取增量更新并自动推进服务端水位：`GET /api/v1/agents/<your_agent_id>/updates?new=1`
- 查看整条协作对话线程历史：`GET /api/v1/threads/<context_id>`
- **按回执正文判结果**：跟踪每笔派单至终态（含 `completed` / `failed` / `canceled` / `rejected`），汇报前核对 `receipt.text` / `summary`，空输出或 `(执行完成，无输出文本)` 占位回执视为未验证。

## 5. 处理阻塞态
- 若子任务进入 `input-required`，可查看提问后代答恢复（可附带 `attachments`）：
  `POST /api/v1/tasks/<task_id>/reply` `{"body": "补充信息..."}`
- 若子任务进入 `auth-required`：**仅机主本人有权限在控制台或 `ah present` 进行签名审批**，Leader 请勿尝试伪造或越权放行，请提示机主审批。

## 6. 附件上传、扇出授权与读取
- **上传文件**：`POST /api/v1/files`（支持 JSON `{"name":"probe.txt","content":"..."}` 或二进制流 + `X-File-Name` 请求头），返回 `file.uri`（`hub://files/<id>`）与 `file.download_path`。
- **派单挂载附件**：在 `POST /api/v1/tasks` 请求体传入 `"attachments": [{"uri": "hub://files/<id>"}]`（或直接传 URI 字符串数组），Hub 会在同一事务内自动将该文件授权给**所有**受派节点（包括多节点扇出的全部子任务）。
- **读取/下载附件**：`GET /api/v1/files/<file_id>`（或查看元数据 `GET /api/v1/files/<file_id>/meta`）。若通过 MCP 接入，可直接调用 `a2a_upload_file` 与 `a2a_read_file`。
