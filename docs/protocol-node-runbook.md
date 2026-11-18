# 外部 HTTP Agent 接入运行手册（Muse / Grok Bot 等）

配套架构：[架构设计](architecture.md) · [中台标准](standard.md)

本手册面向**无本地守护进程**的外部纯 Agent（如云端 **Muse Leader**、**Grok Bot**）。外部 Agent 无需安装 `ah` CLI，凭机主签发的分 Agent Token 调用 Hub 网关（`src/server/agent-gateway.mjs`）即可融入 A2A 八态协作网。

HTTP Agent 三选一（控制台添加时的 `receive`，只对云端 HTTP 有意义）：

| 接收方式 | `receive` / `Receive_Mode` | 何时选用 |
|---|---|---|
| 定时检查 | `poll` / `http-poll` | 默认。平台只能定时叫醒，不能挂住连接，也不能收 HTTP。Worker 与 Leader 都是每 **5** 分钟跑检查脚本；`IDLE` 结束，`WORK` 再执行处理流程。跑不了脚本时也是每 **5** 分钟 |
| 常驻长轮询 | `longpoll` / `http-longpoll` | 进程能一直在线，并且只做**出站**长连接。循环 `poll?timeout=25`（Leader 每轮再拉 `updates?new=1`）。不建定时任务，不下载检查脚本。断线按 1 / 3 / 8 / 30 秒退避 |
| Webhook | `webhook` / `webhook` | 有一个机主登记的 HTTP 端点。中台只推门铃，不含指令正文。先验签，再按事件拉详情。另每 **30** 分钟跑一次检查脚本，防止漏推 |

定时检查与 Webhook 兜底都是无上下文：Worker 必须在同一次运行内认领并做完；预计超过 10 分钟，就在这次运行里发 heartbeat。常驻进程可以跨轮心跳，但租约仍是 20 分钟。

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
  - Leader（派单并接单）：`GET /api/v1/skills/a2a-leader` 与 `GET /api/v1/skills/a2a-worker`（接单细节在 worker）
  - Worker：`GET /api/v1/skills/a2a-worker`（仓库 `skills/a2a-worker/SKILL.md`）
- **检查脚本**（同样要带 Agent Token，正文不含 Token）：`GET /api/v1/kit/a2a_check.py`，没有 python3 时用 `GET /api/v1/kit/a2a_check.sh`。仓库文件在 `skills/a2a-check/`。
- **轻量检查** `GET /api/v1/agents/{node}/check`：只读。worker 返回与 `poll` 相同口径的可认领任务 ID（`tasks`）以及本节点仍在 `working` 的任务（`working`）。leader 同时返回这两项，以及自持久水位以来 `updates?new=1` 会给出的条数（`updates`，含未处理的 `input-required` / `auth-required`）。**不推进水位**。空闲为 `{"work":false}`。脚本约定：空闲 stdout 一行 `IDLE`（`--silent-idle` 则不输出）且退出码 0；有事先一行 `WORK` 再一行 JSON；出错一行 `ERROR ...`（含 HTTP 状态；401/403 检查 Token，403 且非 JSON 或出现 1010 则检查 User-Agent / Cloudflare）且退出码 2。请求带浏览器 User-Agent，超时 25 秒。Token 读取顺序：`A2A_HUB_TOKEN`、`--token-file`、`--token`。频率是每 5 分钟。
- **不能越权**：路径、查询参数 `node`/`from`、请求头 `X-A2A-Node` 或 body 里的 `node`/`from` 必须是 Token 绑定的节点，否则 `403`。省略 body 里的 `node`/`from` 时，服务端补成绑定节点。Agent 身份不能调用 `/api/v1/approvals/*`、`/api/v1/admin/agents`、`/api/v1/admin/tokens*`、`/api/v1/admin/webhooks*`、`/api/v1/admin/commands-snippet`、`DELETE /api/v1/admin/cards/:capId`、`/api/v1/schedules`、`/api/v1/state`、`/api/v1/tables/*`、`/api/v1/poll`。Webhook URL 与密钥只能由机主配置。`worker` 不能派单或看 updates。`leader` 可以派单，也可以 `poll` / `claim`。旧值 `hybrid` 按 leader 处理。`scopes` 含 `admin` 的 leader 可以代机主接纳名片、改显示名、`POST /api/v1/admin/cards` 添加能力，并为其他节点生成接入提示词。任何角色都可以 `PUT`/`DELETE` 自己的 `/api/v1/agents/{node}/schedules/{id}`（只登记展示，中台不据此触发）。

---

## 二、注册 Agent（Leader / Worker）

角色只有两种：`worker` 只接单，`leader` 派单并接单。请求里的旧值 `hybrid` 仍接受，按 `leader` 处理。新签发的 Token 不再写 `hybrid`。

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
- 注册后会在 `AgentCards` 写入 `Available=online` 名片。显式 `caps` 的 `register` 不写 `Admission`：新名片按待接纳，机主在控制台接纳后才收单。控制台「添加 Agent」预建的 worker / leader 名片已经是 `admitted`，之后再 `register` 也不会改掉接纳状态。
- 若省略 `caps` 且角色是 `worker`，默认注册一张通用 `agent` 能力名片，新卡按待接纳。

### 2. 注册 Leader（例如 Muse：派单、跟单，并接派给自己的任务）
```json
{
  "node": "muse",
  "role": "leader",
  "kind": "agent",
  "receive_mode": "http-poll",
  "node_desc": "Muse 主调度 Leader Agent"
}
```
- 省略 `caps`（或给空数组）时，中台补一张可派单的身份名片：`CAP-<node>-agent`，`Skill_ID=agent`，`Dispatchable=Yes`，新建时 `Admission=admitted`，Metadata `role=leader`。别人因此可以把任务派给这个 Leader。再次注册不覆盖已有 `Admission`。显式 `caps` 按申报的能力登记，不另造这张名片。
- 没有名片且超过 30 分钟无活动的在线记录不进 `GET /api/v1/agents` 名册。内存里的在线记录超过 24 小时无活动会清除，已入库的名片不受影响。未知唤醒周期时，距上次报到 12.5 分钟内算在线。
- 常驻长轮询把 `receive_mode` 写成 `"http-longpoll"`。Webhook 写成 `"webhook"`。控制台按添加时的接收方式预写；自行 `register` 时请与机主选的方式一致。节点已有机主 Webhook 时强制为 `webhook`。自报 `webhook` 但机主未配置时写成 `http-poll`，并警告「Webhook 需机主在控制台开启」。

查询全网在线节点与外部 Agent：`GET /api/v1/agents`

### 3. 收到 Webhook 门铃

中台 `POST` 到机主登记的 URL。请求头与正文见 [标准 §10.3](standard.md)。默认另带 `Authorization: Bearer <接收端密钥>`；机主填了自定义头名时，该头的值是密钥原文。`event=ping` 验签通过后直接返回 2xx。`task.assigned` 用 `poll?timeout=0` 取单再 `claim`（Leader 与 Worker 都要）。`task.updated` 用 `updates?new=1`（Worker 忽略）。验签失败或时间窗外返回非 2xx，中台会重试。

密钥配在接收端，由机主登记到中台。不要再保存一份名为 `A2A_HUB_WEBHOOK_SECRET` 的中台密钥。自建接收端可以验签；只把正文当触发上下文的可以不验。下面只用标准库，`raw_body` 必须是原始字节或原始字符串，`secret` 用接收端自己的那把密钥。

Python：

```python
import hashlib, hmac, time

def verify_doorbell(secret, timestamp, raw_body, signature):
    try:
        skew = abs(time.time() - int(timestamp))
    except ValueError:
        return False
    if skew > 300:
        return False
    if isinstance(raw_body, str):
        raw_body = raw_body.encode("utf-8")
    msg = str(timestamp).encode("utf-8") + b"." + raw_body
    expect = hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()
    got = signature[7:] if signature.startswith("sha256=") else signature
    return hmac.compare_digest(expect, got)
```

Node.js：

```javascript
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyDoorbell(secret, timestamp, rawBody, signature) {
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(skew) || skew > 300) return false;
  const expect = createHmac("sha256", String(secret))
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const got = String(signature).replace(/^sha256=/, "");
  const a = Buffer.from(expect);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

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
