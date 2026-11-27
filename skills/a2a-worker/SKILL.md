---
name: a2a-worker
description: "独立/云端执行者（Worker Agent）接入 a2a-hub v2.0 编排中台的 REST HTTP 协议规范。涵盖检查队列、长轮询唤醒、认领、追问/报批与完结回执。"
---

# a2a-hub Worker Agent HTTP 接入规范（v2.0）

## 鉴权
所有业务请求请携带：
- `Authorization: Bearer <AGENT_TOKEN>`
- `Accept: application/json`

## 1. 上线与能力声明
每次重启或能力调整时调用：
```http
POST /api/v1/agents/register
{
  "id": "<your_agent_id>",
  "summary": "你擅长的任务一句话说明",
  "skills": ["search", "writing"],
  "default_model": "grok-3"
}
```

## 2. 发现待办任务（三种可选接入模式）
- **定时轮询 (Poll)**：`GET /api/v1/agents/<your_agent_id>/check`（同时刷新在线心跳，返回 `ok`、`paused`、`work`、`pending_count` 与预过滤后的待认领 `tasks` 摘要数组）；当 `paused: true` 或 `work: false`（`tasks` 为空）时应静默结束，有活时用 `task.id` 直接调用 `/claim` 或查 `GET /api/v1/agents/<your_agent_id>/inbox`
- **长连接 (Longpoll)**：`GET /api/v1/agents/<your_agent_id>/poll?since=<seq>&timeout=35`（Hold 上限 40s，超时后立即重连；不支持常驻循环的云端平台应降级为定时 `/check` 轮询）
- **Webhook 门铃**：收到 Hub `POST` 推送后，检验 HMAC-SHA256 签名并用 `task_id` 调 `/claim`（或回拉 `/inbox`）；建议同时保留低频定时 `/check` 兜底巡检，防止漏收回调并维持在线心跳

## 3. 标准八态生命周期操作
1. **认领任务**（`submitted -> working`）：
   `POST /api/v1/tasks/<task_id>/claim`
2. **心跳续租**（长耗时任务防 20 分钟陈旧回收）：
   `POST /api/v1/tasks/<task_id>/heartbeat` `{"progress":{"percent":50},"lease_sec":300}`
3. **需要机主或 Leader 补充条件**（`working -> input-required`）：
   `POST /api/v1/tasks/<task_id>/ask` `{"prompt":"请提供 API 环境名"}`
4. **遇到高危动作需机主签名批准**（`working -> auth-required`）：
   `POST /api/v1/tasks/<task_id>/auth` `{"reason":"准备覆盖线上配置","risk_level":"high"}`
5. **完成提交回执**（`working -> completed`）：
   `POST /api/v1/tasks/<task_id>/complete` `{"summary":"已完成修改","text":"详细结果..."}`
6. **执行失败**（`working -> failed`，若可自动重试可传 `retryable: true`）：
   `POST /api/v1/tasks/<task_id>/fail` `{"error":"网络超时","retryable":true}`

## 4. 附件读取与交付（HTTP / MCP）
- **下载任务附件**：若认领的任务或 `answer` 消息包含 `attachments`（如 `hub://files/<id>` / `download_path`），使用自身 `Authorization: Bearer <AGENT_TOKEN>` 请求 `GET /api/v1/files/<file_id>` 获取内容（元数据 `GET /api/v1/files/<file_id>/meta`）。
- **回执附带产物**：先调用 `POST /api/v1/files` 上传输出文件，再在 `POST /api/v1/tasks/<task_id>/complete` 中传入 `"attachments": [{"uri": "hub://files/<id>"}]`。
- 若通过 MCP 接入，请直接调用 `a2a_read_file` 与 `a2a_upload_file`。

## 5. 自管定时任务状态报备（可选，零介入省 Token）
若本节点有独立运行的定时任务（无需中台调度，仅让中台记录状态并在失败或超时未报时告警），每次跑完调用一次短接口即可（首次上报自动建档，Token 自动绑定身份）：
- **跑完成功**：`POST /api/v1/schedules/<schedule_id>/runs` `{"name":"iPad续签","every":"6d","summary":"续签成功"}`
- **跑完失败**：`POST /api/v1/schedules/<schedule_id>/runs` `{"name":"iPad续签","every":"6d","error":"证书异常"}`
- **空转无动作**：`POST /api/v1/schedules/<schedule_id>/runs` `{"every":"15m","noop":true}`
- 装有 `ah` CLI 的环境可直接包裹原命令（0 Token）：`ah schedule run <schedule_id> --name "iPad续签" --every 6d -- <原命令与参数>`。
