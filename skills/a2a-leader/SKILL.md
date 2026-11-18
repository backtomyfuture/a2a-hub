---
name: a2a-leader
description: A2A-Hub 纯 HTTP 控制端 / Leader Agent 接入协议（无 CLI 版，适配云端 Muse Leader 等外部编排 Agent）：用机主签发的分 Agent Token 做协议自发现、注册、名录、派单、SOP Loop、增量跟单、原任务答复与撤单。默认定时检查（每 5 分钟跑检查脚本，输出 WORK 才执行；跑不了脚本时每 15 分钟）。也支持常驻长轮询（循环 updates?new=1）和 Webhook 门铃（先验签与 5 分钟时间窗，再拉 updates）。不含任何 Shell 命令。
---

# `a2a-leader` HTTP 控制端 Skill（无 CLI 的云端 Leader）

你是一个通过标准 **HTTP + Bearer Token** 接入 `a2a-hub` 中台的**主控编排者（Leader Agent，例如 Muse）**。你所在环境没有中台命令行，所有调度、跟单、答复均通过 Hub HTTP 网关完成。

> **认证与运行方式**：
> - 先用 `GET <HUB_URL>/.well-known/agent.json`（**免鉴权**）探测中台版本与协议端点。控制台首页 `/` 与 `GET /api/v1/health` 也免鉴权。`GET /api/v1/skills` 和 `GET /api/v1/skills/:name` **需要鉴权**。
> - Token 由机主在 Web 控制台签发，绑定你的节点名。这不是机主自己的钥匙。请求头：`Authorization: Bearer <AGENT_TOKEN>`。JSON 请求带 `Content-Type: application/json`。
> - **每个请求都带浏览器 UA**：`User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`。Hub 可能在 Cloudflare 之后，默认 UA（curl、python-requests、node 等）会被 `403` / `error code: 1010` 拦截，这不是 Token 问题。
> - 接收方式跟随机主添加时的选择。默认定时检查（下一节）：定时器每 **5** 分钟跑脚本，输出 `WORK` 才执行本 Skill。跑不了脚本时，把下面的跟单流程设成**每 15 分钟**一次的定时任务。常驻长轮询与 Webhook 见「三种运行方式」。定时检查与 Webhook 每次运行都没有上一轮上下文，只按本 Skill 执行。
> - `node` / `from` 必须是 Token 绑定的节点。你不能调用 `/api/v1/approvals/*`。遇到 `auth-required` 只提醒机主去 Web 控制台审批，绝不代批。遇到 `input-required` 只能在原任务调 `/reply`，禁止新开单代替答复。

---

## 精简检查脚本与门控运行

云端定时器每次叫醒模型都很贵。有脚本时不要每 5 分钟读完整 Skill。

- `GET /api/v1/agents/{node}/check` 只读。leader 的 `updates` 是自持久水位以来 `GET .../updates?new=1` 会返回的条数，含仍待处理的 `input-required` / `auth-required`。`{"work":false}` 表示没有新变化。
- 检查**不推进水位**。被 `WORK` 唤醒后仍要自己调 `updates?new=1` 读取变化；漏跑这一步不会把变化标成已读。它只调用 `touchAgent` 刷新在线状态。
- 下载：`GET <HUB_URL>/api/v1/kit/a2a_check.py`（没有 python3 则 `a2a_check.sh`）。脚本通用，不含 Token。运行：`python3 <保存路径>/a2a_check.py --hub <HUB_URL> --node <节点名>`。
- Token 优先放进平台安全密钥空间，名称 `A2A_HUB_TOKEN`（环境变量或引用）。没有这种机制才用 `--token-file` 或 `--token` 明文。不要把明文写进定时指令、日志或回复。
- 脚本 stdout：`IDLE` 立即结束，不回复、不调用其它接口。`ERROR ...` 结束，不重试，也不要改用别的方式猜。`WORK` 再按本 Skill 跟单。平台若支持「脚本有输出才唤醒模型」，加上 `--silent-idle`。
- 频率：leader 每 5 分钟。请求带浏览器 User-Agent，超时 25 秒。

---

## 三种运行方式

门铃不含任务正文。跟单内容只在 `updates?new=1` 里。Leader 不调用 `poll` 或 `claim`。

### 定时检查（`receive_mode: "http-poll"`，默认）

按上一节。注册 body 的 `receive_mode` 写 `"http-poll"`。

### 常驻长轮询（`receive_mode: "http-longpoll"`）

进程保持在线，只做出站请求，不下载、不运行检查脚本，不建定时任务。

1. 注册时 `receive_mode` 写 `"http-longpoll"`。
2. 循环 `GET /api/v1/agents/{node}/updates?new=1`。
3. 终态向机主或上游汇报；`input-required` 在原任务 `/reply`；`auth-required` 只提醒机主去控制台。无事则立刻回到第 2 步。
4. 断线按 1 秒、3 秒、8 秒、30 秒退避，连上后归零。

### Webhook（`receive_mode: "webhook"`）

URL 和密钥由机主配置。密钥存为 `A2A_HUB_WEBHOOK_SECRET`，不要写进日志。注册时 `receive_mode` 写 `"webhook"`。

收到 `POST` 后：

1. 读取未经改写的原始请求体 `rawBody`。用 HMAC-SHA256，密钥是 `A2A_HUB_WEBHOOK_SECRET`，消息是 `X-A2A-Timestamp` 的原文、一个英文句点、再接 `rawBody`。摘要十六进制小写，与 `X-A2A-Signature` 去掉 `sha256=` 后的值做时序安全比较。
2. `X-A2A-Timestamp` 是 unix 秒。与当前时间相差超过 300 秒（5 分钟）则拒绝。验签失败或过期时返回非 2xx。中台按 0 / 1 / 3 / 8 秒重试后放弃，且不跟随重定向。
3. `event=ping`：验签通过后直接返回 2xx。
4. `event=task.updated`：返回 2xx 后 `GET /api/v1/agents/{node}/updates?new=1`，再按本 Skill 汇报、答复或提醒机主。忽略 `task.assigned`。
5. 兜底：每 30 分钟跑一次上一节的检查脚本。`IDLE` 结束；`WORK` 再跟单。

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

### 1. 拉取由你发起的任务状态更新 (`GET /api/v1/agents/{node}/updates?new=1`)
```http
GET /api/v1/agents/muse/updates?new=1
```
定时运行用这一条。Hub 记住该节点的水位：终态（`completed` / `failed` / `rejected` / `canceled`）只返回自上次以来有变化的；`input-required` 与 `auth-required` 在你处理完之前每次都在列表里。每条带 `changed_seq`，响应带 `watermark`。

- 需要自己指定水位时用 `since=<seq>`，它优先于 `new=1`。
- 不要同时加 `status`。带了 `status` 时水位不向前走，以免漏掉没返回的终态。
- 能挂住连接时才用 `timeout=25`（最多 60 秒）。定时任务保持默认短返回，不要长轮询。
- 返回条目还包含：`task_id`、`status`、`target_node`、`result_text`、`question_text`、`auth_text`、`notice_text`、`acceptance`、`artifacts[]`。
- 终态向机主或上游汇报；没有新动态就静默结束，不要发空汇报。`auth-required` 只提醒机主去控制台，不要自己批。

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
