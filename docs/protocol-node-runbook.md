# 外部 HTTP Agent 接入运行手册（Muse / Grok Bot 等）

配套架构：[架构设计](architecture.md) · [中台标准](standard.md)

本手册面向**无本地守护进程、无法长驻主机**的外部纯 Agent（如云端 **Muse Leader**、由外部定时器唤醒的 **Grok Bot** 等）。外部 Agent 无需安装 `ah` CLI，也不开任何入站监听端口，凭机主签发的分 Agent Token 调用 Hub 网关（`src/server/agent-gateway.mjs`）即可融入 A2A 八态协作网。

推荐运行方式是脚本门控、无上下文：定时器跑检查脚本（Worker / Hybrid 每 **2** 分钟，Leader 每 **5** 分钟）。脚本输出 `IDLE` 就结束，不要叫醒模型；输出 `WORK` 再按下面的处理流程执行。跑不了任何脚本时回退为 Worker 每 **10** 分钟、Leader 每 **15** 分钟直接执行处理流程。Worker 必须在同一次运行内认领并做完；预计超过 10 分钟，就在这次运行里发 heartbeat。

Token 优先放进平台的安全密钥空间（Secrets / Vault / 加密环境变量），名称 `A2A_HUB_TOKEN`。不要把明文写进定时指令、日志或回复。只有平台没有任何安全存储时，才写入权限 `0600` 的本地文件或定时指令。

---

## 一、自发现与认证

- **协议发现（免鉴权）**：`GET http://<HUB_HOST>:8787/.well-known/agent.json`
  返回中台名称、版本、长/短轮询能力、`authentication.type`（`bearer` / `none`）及全量 REST 端点模板。
- **同样免鉴权的只有**控制台首页 `GET /` 与健康探针 `GET /api/v1/health`。`GET /api/v1/skills`、`GET /api/v1/skills/:name` 与 `GET /api/v1/kit/a2a_check.py|.sh` **需要鉴权**。
- **两把钥匙**：机主 `AH_API_TOKEN` 是 owner，用于控制台、`ah join` 和全部管理接口。外部 HTTP Agent 使用机主在控制台签发的分 Agent Token（绑定节点、角色与 scopes），请求头：
  `Authorization: Bearer <AGENT_TOKEN>`
  未配置机主 Token 且尚未签发任何 Agent Token 时，接口保持免鉴权。未配置机主 Token 时，控制台拒绝签发 Agent Token。
- **配套 Skill 模板**（要带上面的 Agent Token）：
  - Leader：`GET /api/v1/skills/a2a-leader`（仓库 `skills/a2a-leader/SKILL.md`）
  - Worker：`GET /api/v1/skills/a2a-worker`（仓库 `skills/a2a-worker/SKILL.md`）
- **检查脚本**（同样要带 Agent Token，正文不含 Token）：`GET /api/v1/kit/a2a_check.py`，没有 python3 时用 `GET /api/v1/kit/a2a_check.sh`。仓库文件在 `skills/a2a-check/`。
- **轻量检查** `GET /api/v1/agents/{node}/check`：只读。worker 返回与 `poll` 相同口径的可认领任务 ID（`tasks`）以及本节点仍在 `working` 的任务（`working`）。leader 返回自持久水位以来 `updates?new=1` 会给出的条数（`updates`，含未处理的 `input-required` / `auth-required`）。**不推进水位**。空闲为 `{"work":false}`。脚本约定：空闲 stdout 一行 `IDLE`（`--silent-idle` 则不输出）且退出码 0；有事先一行 `WORK` 再一行 JSON；出错一行 `ERROR ...`（含 HTTP 状态；401/403 检查 Token，403 且非 JSON 或出现 1010 则检查 User-Agent / Cloudflare）且退出码 2。请求带浏览器 User-Agent，超时 15 秒。Token 读取顺序：`A2A_HUB_TOKEN`、`--token-file`、`--token`。
- **不能越权**：路径、查询参数 `node`/`from`、请求头 `X-A2A-Node` 或 body 里的 `node`/`from` 必须是 Token 绑定的节点，否则 `403`。省略 body 里的 `node`/`from` 时，服务端补成绑定节点。Agent 身份不能调用 `/api/v1/approvals/*`、`/api/v1/admin/agents`、`/api/v1/admin/tokens*`、`/api/v1/state`、`/api/v1/tables/*`、`/api/v1/poll`。`worker` 不能派单或看 updates；`leader` 不能 claim。`scopes` 含 `admin` 的 leader 可以代机主接纳名片、改显示名，并为其他节点生成接入提示词。

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
- 注册后会在 `AgentCards` 写入 `Available=online` 名片。`register` 不写 `Admission`：新名片按待接纳，机主在控制台接纳后才收单。控制台「添加 Agent」预建的 worker/hybrid 名片已经是 `admitted`，之后再 `register` 也不会改掉接纳状态。
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
- `role: "leader"` 默认不生成被动接单的能力名片（`cards: []`）。没有名片时，超过 30 分钟无活动就不进 `GET /api/v1/agents` 名册；每 15 分钟跑一次 updates 或 register 即可保持可见。内存里的在线记录超过 24 小时无活动会清除，已入库的名片不受影响。
- 如希望别人也能给 Muse 派单，可将 `role` 设为 `"hybrid"` 或在 `caps` 中显式声明能力。

查询全网在线节点与外部 Agent：`GET /api/v1/agents`

---

## 三、Worker 工作闭环（Grok Bot 等执行方）

### 1. 取单轮询（定时短轮询；长轮询仍可用）
```http
GET /api/v1/agents/{node}/poll?timeout=0
```
- 定时 Worker 用 `timeout=0`：立即返回当前待执行列表，然后在**这一次运行里** claim 并 complete/fail。不要把任务留到下一次唤醒。
- `timeout=5..60` 仍是长轮询，留给能挂住连接的常驻进程。
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
2. **拉取跟进状态更新** (`GET /api/v1/agents/{node}/updates?new=1`)：
   只含「由 `{node}` 发起」且处于 `completed`、`failed`、`rejected`、`canceled`、`input-required`、`auth-required` 的任务。定时 Leader 用 `new=1`：Hub 为该节点持久化水位，终态只返回 `changed_seq` 大于水位的新变化，`input-required` 与 `auth-required` 在处理完之前每次都返回。每条带 `changed_seq`，响应带 `watermark`。`since=<seq>` 可显式指定水位，并优先于 `new=1`。带 `status` 时水位不推进，以免把这次没返回的终态跳过。定时跟单不要加 `status`。不带 `since`/`new` 时仍返回全部匹配任务。`timeout=0` 适合定时唤醒；`timeout=5..60` 留给能挂住连接的进程。
3. **答复下级追问** (`POST /api/v1/tasks/{taskId}/reply`)：
   ```json
   { "from": "muse", "text": "中文报告即可，重点保留结论链接" }
   ```
4. **取消本方发起任务** (`POST /api/v1/tasks/{taskId}/cancel`)：
   ```json
   { "from": "muse", "text": "需求调整，终止该任务" }
   ```
5. **条件筛选查询** (`GET /api/v1/tasks?from=muse&status=working&limit=50`)。
