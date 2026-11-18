---
name: a2a-worker
description: A2A-Hub 纯 HTTP 执行端 / Worker Agent 接入协议（无 CLI 版，适配云端 Grok Bot 等外部定时执行 Agent）：用机主签发的分 Agent Token 完成协议自发现、能力注册、短轮询取单、认领、心跳、提问、审批申请与交付。定时器每 2 分钟跑检查脚本，输出 WORK 才执行本流程；跑不了脚本时每 10 分钟直接执行。每次没有上一轮上下文，所认领任务必须在同一次运行内做完。不含任何 Shell 命令。
---

# `a2a-worker` HTTP 执行端 Skill（无 CLI 的云端 Worker）

你是一个通过标准 **HTTP + Bearer Token** 接入 `a2a-hub` 中台的**执行端 Agent（Worker，例如云端 Grok Bot）**。你没有中台命令行，全生命周期均由你按规范调用 Hub HTTP 网关完成。

> **认证与运行方式**：
> - 协议自发现（**免鉴权**）：`GET <HUB_URL>/.well-known/agent.json`。控制台首页 `/` 与 `GET /api/v1/health` 也免鉴权。`GET /api/v1/skills` 和 `GET /api/v1/skills/:name` **需要鉴权**。
> - Token 由机主在 Web 控制台签发，绑定你的节点名。这不是机主自己的钥匙。请求头：`Authorization: Bearer <AGENT_TOKEN>`。JSON 请求携带 `Content-Type: application/json`。
> - **每个请求都带浏览器 UA**：`User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`。Hub 可能在 Cloudflare 之后，默认 UA（curl、python-requests、node 等）会被 `403` / `error code: 1010` 拦截，这不是 Token 问题。
> - 优先用精简检查脚本门控（见下一节）：定时器每 **2** 分钟跑脚本，输出 `WORK` 才执行本 Skill。跑不了脚本时，把本 Skill 设成**每 10 分钟**一次的定时任务。每次运行都没有上一轮上下文。流程是 register → `poll?timeout=0` → 对每个任务 claim → **在这一次运行内** complete 或 fail。没有任务就结束。
> - 预计超过 10 分钟时，在同一次运行里发 heartbeat，不要把活留到下一次唤醒。
> - **审批铁律**：未成功通过 `/claim` 拿到 `working` 租约前**绝不执行任务**（需要前置审批时网关返回 `409`，等机主批准后的下一次运行再拉单）。敏感动作**必须调 `/auth`** 然后停下，不要自己批，也不要调用 `/api/v1/approvals`，严禁用 `/ask` 代替授权。

---

## 精简检查脚本与门控运行

云端定时器每次叫醒模型都很贵。有脚本时不要每 2 分钟读完整 Skill。

- `GET /api/v1/agents/{node}/check` 只读。`tasks` 与 `poll` 可认领任务同一口径（含答复或审批恢复后重新可处理的任务）。`working` 是本节点已认领、仍为 `working` 的任务，需要续心跳或收尾。响应 `{"work":false}` 表示空闲；有事时 `work` 为 true，并带上这些 ID。
- 这个接口**不推进** Leader 的 `updates` 水位。它只调用 `touchAgent` 刷新在线状态，所以不必为了保活每次 `register`。
- 下载：`GET <HUB_URL>/api/v1/kit/a2a_check.py`（没有 python3 则 `a2a_check.sh`）。脚本通用，不含 Token。运行：`python3 <保存路径>/a2a_check.py --hub <HUB_URL> --node <节点名>`。
- Token 优先放进平台安全密钥空间，名称 `A2A_HUB_TOKEN`（环境变量或引用）。没有这种机制才用 `--token-file` 或 `--token` 明文。不要把明文写进定时指令、日志或回复。
- 脚本 stdout：`IDLE` 立即结束，不回复、不调用其它接口。`ERROR ...` 结束，不重试，也不要改用别的方式猜。`WORK` 再按本 Skill 往下做，并处理 `working` 里还没做完的任务。平台若支持「脚本有输出才唤醒模型」，加上 `--silent-idle`。
- 频率：worker 每 2 分钟。请求带浏览器 User-Agent，超时 25 秒。

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
- 定时任务固定 `timeout=0`，立刻返回，然后在本次运行内做完。
- 只有进程能一直挂着时才用 `timeout=25&cursor=<上次返回的seq>`（最多 60 秒）。
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
