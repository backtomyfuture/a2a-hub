# 外部 HTTP Agent 接入运行手册（Muse / Grok Bot 等）

配套架构：[架构设计](architecture.md) · [中台标准](standard.md)

本手册面向**无本地守护进程、无法长驻主机**的外部纯 Agent（如云端 **Muse Leader**、定时轮询或自主 loop 运行的 **Grok Bot** 等）。外部 Agent 无需安装 `ah` CLI，也不开任何入站监听端口，只需通过标准 HTTP + Bearer Token 与 Hub 网关（`src/server/agent-gateway.mjs`）交互即可融入 A2A 八态协作网。

---

## 一、自发现与认证

- **协议发现（免鉴权）**：`GET http://<HUB_HOST>:8787/.well-known/agent.json`
  返回中台名称、版本、长/短轮询能力、`authentication.type`（`bearer` / `none`）及全量 REST 端点模板。
- **鉴权头**：除 `GET /`、`GET /api/v1/health` 与 `GET /.well-known/agent.json` 外，所有 `/api/*` 请求均需携带：
  `Authorization: Bearer <LAH_API_TOKEN>`
- **配套 Skill 模板拉取**：认证后可调用 `GET /api/v1/skills` 查看目录，或按角色直接拉取对应提示词模板：
  - Leader 控制端（如 Muse）：`GET /api/v1/skills/a2a-leader`（对应仓库 `skills/a2a-leader/SKILL.md`）
  - Worker 执行端（如 Grok Bot）：`GET /api/v1/skills/a2a-worker`（对应仓库 `skills/a2a-worker/SKILL.md`）

---

## 二、注册 Agent（Leader / Worker / Hybrid）

```http
POST /api/v1/agents/register
Content-Type: application/json
```

### 1. 注册 Worker（例如云端 Grok Bot）
```json
{
  "node": "grok-bot",
  "role": "worker",
  "kind": "agent",
  "receive_mode": "http-poll",
  "node_desc": "Grok 搜索与摘要执行器",
  "caps": [
    {
      "skill_id": "research",
      "skill_name": "Grok Deep Search",
      "description": "实时搜索网页信息并归纳结构化报告",
      "side_effect": "read",
      "approval_class": "auto"
    }
  ]
}
```
- 注册后会在 `AgentCards` 写入 `Available=online` 名片，同时在 Web 控制台显示 `HTTP Agent · Worker` 在线状态；
- 若省略 `caps`（且 `role !== "leader"`），默认注册一张通用 `agent` 能力名片。

### 2. 注册纯 Leader（例如 Muse 只派单与跟单）
```json
{
  "node": "muse",
  "role": "leader",
  "kind": "agent",
  "receive_mode": "http-poll",
  "node_desc": "Muse 主调度 Leader Agent"
}
```
- `role: "leader"` 默认不生成被动接单的能力名片（`cards: []`），但在 Web 控制台「总览」与「Agent 名片」中可见其在线与活跃状态；
- 如希望别人也能给 Muse 派单，可将 `role` 设为 `"hybrid"` 或在 `caps` 中显式声明能力。

查询全网在线节点与外部 Agent：`GET /api/v1/agents`

---

## 三、Worker 工作闭环（Grok Bot 等执行方）

### 1. 取单轮询（短轮询与长轮询合一）
```http
GET /api/v1/agents/{node}/poll?timeout=0&cursor=<seq>&auto_claim=false
```
- `timeout=0`（默认）：**短轮询**，适合云端 Agent 自己的 cron / 定时心跳；立即返回当前待执行列表（`actionable`）；
- `timeout=5..60`：**长轮询**，无新任务时挂起直到有写操作或超时返回（毫秒级唤醒）；
- 支持 `POST /api/v1/agents/{node}/poll` 与别名 `GET /api/v1/agents/{node}/inbox`。

返回体中的 `tasks[]` 每项带有 `action` 提示：
- `action: "execute"`：`submitted` 新任务等待认领执行；
- `action: "resume"`：之前挂起的任务恢复，携带 `resume_reason: "answer"`（附 `answers[]`）或 `resume_reason: "auth_decision"`（附已验签 `decision`）。

### 2. 认领与续跑 (`POST /api/v1/tasks/{taskId}/claim`)
```json
{ "node": "grok-bot", "worker": "grok-4" }
```
- 检查目标归属、处理前置 `Approval_Class=approve` 审批门，并将状态置为 `working`、创建/恢复 Run、返回完整 `instruction`、`params`、`criteria` 与 `answers`。

### 3. 进度心跳 (`POST /api/v1/tasks/{taskId}/heartbeat`)
长耗时任务每隔数分钟（须短于 20 分钟陈旧阈值）续一次心跳，可选附带进度文本写入 `Messages(Kind="progress")`：
```json
{ "node": "grok-bot", "text": "已完成检索阶段 1/2" }
```

### 4. 中途提问 (`POST /api/v1/tasks/{taskId}/ask`)
信息不足时切入 `input-required` 等待发起方答复（不记失败、不扣重试）：
```json
{ "node": "grok-bot", "text": "请确认需要英文还是中文报告？" }
```
发起方回复后，下次 `/poll` 将以 `action: "resume", resume_reason: "answer"` 返回给原 Agent。

### 5. 执行中申请机主审批 (`POST /api/v1/tasks/{taskId}/auth`)
涉及对外发送消息、删改数据、花费资金等敏感动作前，主动暂停请求审批：
```json
{ "node": "grok-bot", "text": "准备对外推送公告至生产群，请机主批准" }
```
机主在 Web 控制台或 `POST /api/v1/approvals/{taskId}/decide` 批准并完成 **ed25519 签名** 后，网关验签通过才允许 `/claim` 恢复为 `working`。

### 6. 交付与失败 (`complete` / `fail`)
```http
POST /api/v1/tasks/{taskId}/complete
```
```json
{
  "node": "grok-bot",
  "text": "已完成方案调研与对比",
  "artifact": "https://example.com/report.md",
  "checks": {
    "c1": { "verdict": "pass", "evidence": "覆盖长轮询与短轮询延迟" }
  }
}
```
若无法完成，调 `POST /api/v1/tasks/{taskId}/fail` 提交 `{ "node": "grok-bot", "text": "失败原因" }`。

---

## 四、Leader 调度闭环（Muse 等主控 Agent）

1. **派发异步任务** (`POST /api/v1/tasks`)：
   ```json
   {
     "from": "muse",
     "to": "grok-bot",
     "cap": "research",
     "text": "调研最新 A2A 协议生态",
     "criteria": [{ "id": "c1", "text": "提供架构图摘要", "verify": "agent" }]
   }
   ```
   也支持面向任意宿主节点（如办公电脑上的 `claude` / `agy` Worker）派单：`{"from":"muse","to":"office-pc","worker":"claude","text":"..."}`。
2. **拉取跟进状态更新** (`GET /api/v1/agents/{node}/updates?timeout=0..60`)：
   自动过滤所有「由 `{node}` 发起」且进入 `completed`、`failed`、`rejected`、`canceled`、`input-required`、`auth-required` 的任务，返回 `result_text`、`question_text`、`acceptance`、`artifacts[]` 等汇总摘要。
3. **答复下级追问** (`POST /api/v1/tasks/{taskId}/reply`)：
   ```json
   { "from": "muse", "text": "中文报告即可，重点保留结论链接" }
   ```
4. **取消本方发起任务** (`POST /api/v1/tasks/{taskId}/cancel`)：
   ```json
   { "from": "muse", "text": "需求调整，终止该任务" }
   ```
5. **条件筛选查询** (`GET /api/v1/tasks?from=muse&status=working&limit=50`)。
