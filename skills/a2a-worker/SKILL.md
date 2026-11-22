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
- **定时轮询 (Poll)**：`GET /api/v1/agents/<your_agent_id>/check`（返回 `work: true/false` 与待处理任务概览），有活时再查 `GET /api/v1/agents/<your_agent_id>/inbox`
- **长连接 (Longpoll)**：`GET /api/v1/agents/<your_agent_id>/poll?since=<seq>&timeout=35`（Hold 上限 40s，超时后立即重连）
- **Webhook 门铃**：收到 Hub `POST` 推送后，检验 HMAC-SHA256 签名并主动回拉 `/inbox`

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

## 4. 定时任务自报（可选）
若本节点自带本地 cron 任务，可向中台上报供机主在面板集中观测：
`PUT /api/v1/agents/<your_agent_id>/schedules/<schedule_id>` `{"name":"每日晨报","interval_min":1440,"run":true}`
