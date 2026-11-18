# 枢纽（hub）对接

枢纽是中台的操作者侧：负责把意图变成任务、把结果带回操作者。它不是
一个独立进程，而是一个**逻辑角色**，并且是 node 角色的单进程超集（标准 §10.1）。实现是 Node 版
`ah daemon --role node|hub`（代码在 `src/hub/`）。省略 `--role` 时
读该配置目录 `node.json` 的 `role`，缺省 node。`role=hub` 单进程单配置目录（默认 `~/.a2a-hub`）
即可同时承载干活与枢纽职责，无需再拆两个进程。本篇是对接规范。

## 职责清单

1. **建单与路由**：任何宿主节点、CLI、Web 控制台与已接入的 HTTP Leader Agent（如 Muse）都可以作为任务入口。按 AgentCards 校验目标节点与能力（或触发 `LoopService` 多阶段闭环），生成 Task_ID / Context_ID / Idempotency_Key 并建单（先写 `instruction` 与 Parts，最后写 `Tasks` 行）。
2. **唤醒与网关服务**：Hub 单进程运行本地 SQLite WAL、REST API、`LongPollBroker`（对宿主节点提供 `GET /api/v1/poll`，对纯外部 Agent 提供 `agent-gateway` `/api/v1/agents/:node/poll|updates`）以及内嵌 Web 控制台。除长期对账兜底（默认 `sweepSec` 900s）外，写操作发生后通过单调递增 `seq` 毫秒级唤醒长轮询连接。
3. **结果呈递（原路落盘，静默协作）**：
   - `role=hub` 与各宿主节点在收到唤醒事件或对账扫表时，将属于本节点发起的任务结果（`completed`、`failed`、`rejected`、`canceled`、`input-required`）写入本机 `present_queue.jsonl`，供本机 Agent / CLI (`ah present`) 消费；
   - 外部 HTTP Leader Agent 可直接调用 `GET /api/v1/agents/{node}/updates` 拉取由自己发起任务的状态变更；
   - 配置 `notifications` 后，`ExternalNotifier` 可向群机器人 Webhook / Bark / Telegram / 通用 Webhook 发送精简提醒与控制台链接。
4. **审批签名中继**：`ApprovalService` 与 Web 控制台 `/api/v1/approvals/:taskId/decide` 使用配置目录 `0600` 私钥 `approval_key.pem` 为 `auth_decision` 生成 **ed25519 签名**（绑定 `Task_ID` 与 `In_Reply_To` / `Status_Msg`）。节点与外部 HTTP 网关均按公钥验签。
5. **取消**：`canceled` 只由发起方或 `hub` 角色写入；普通 Worker 节点不能越权取消他方发起的任务。
6. **答复与续派**：操作者或 Leader Agent 对 `input-required` 的答复写成 `answer` 消息追加到原任务，目标节点或 Worker Agent 自动续跑。
7. **对账与告警**：`StaleService` 周期性扫表检查 `working` 超时未心跳或无人认领的任务并通知机主。

**角色边界**：`auth_decision` 与合法签名只能由 `hub` 角色私钥路径签发，Worker 节点从不签发。

## 接入拓扑

- **单机主枢纽（Mac mini / 常驻主机，推荐）**：以 `ah up` / `ah daemon --role hub` 启动本地 `SqliteBus` + HTTP 服务（默认 `0.0.0.0:8787`），单进程既托管全网状态、Web 控制台与外部通知，也可同时按本机 `commands.json` 接单。
- **远端宿主节点（`busType: "http"`）**：通过 `ah join http://<token>@<hub-ip>:8787` 自动拉取 `hubPublicKey` 并保存 `0600` Bearer Token 至 `app.env`，以纯出站 HTTP 长轮询接入，**绝不开设任何入站监听端口**。
- **纯 HTTP 外部 Agent（Muse / Grok Bot 等）**：直接走 `GET /.well-known/agent.json` 自发现，凭 Bearer Token 调用 `/api/v1/agents/register`、`/api/v1/agents/{node}/poll|updates` 与 `/api/v1/tasks/{id}/claim|complete|...`，详见 [外部 HTTP Agent 手册](protocol-node-runbook.md)。

## 传输方式

| 方式 | 机制 | 适用 |
|---|---|---|
| `longpoll` | 节点 / Agent 向 Hub 发起出站长轮询（`/api/v1/poll` 或 `/api/v1/agents/:node/poll?timeout=25`），写后毫秒级唤醒 | **默认推荐**：Hub、远端宿主节点与常驻/长连接 HTTP Agent |
| `poll` | 定时轮询（宿主守护节点默认 45s；外部 bot 按自有 cron 短轮询 `?timeout=0`） | 无法维持长连接的无状态云端 Agent 或降级环境 |

宿主守护节点保留低频对账扫表兜底（默认 15 分钟）及面向 `input-required`/`auth-required` 的 `PENDING_RECHECK` 短复查。

## 建单纪律

1. **先消息、后任务行**：先写 `instruction` 消息，再写它的 Parts（参数放 DataPart），**最后写 `Tasks` 行**——任务行就是触发信号，先建行会让节点抢跑、读到空参数。
2. **幂等**：同一业务意图复用同一 `Idempotency_Key`；节点与枢纽都按它查重。写请求中途断线先按幂等键确认再决定是否重建。
3. **审批类**：`Approval_Class=approve` 的任务在认领前先进入 `auth-required`（不经 `working`）；执行中需高危操作时发起带 `scope=dynamic` 的 `auth_request`（见标准 §8.3）。枢纽与外部网关放行必须依赖已验签的 `auth_decision`（DataPart 携带签名）。

## 呈递（原路落盘消费）

`ah daemon` 在收到唤醒事件或对账扫表时处理结果呈递：

- 要呈递的状态：`completed`、`failed`、`rejected`、`canceled`（含审批驳回）、`input-required`（`auth-required` 单独走审批中心/通知）。
- 原路分流与落盘：
  - 发起节点（`From_Node === 本节点`）将结果写入本机配置目录的 `present_queue.jsonl`，供本机 Agent / CLI 消费；
  - `Source="hub"` 或 `"cron"`（定时任务）归 `role=hub` 主节点消费；
  - 纯 HTTP Leader Agent（如 Muse）则直接通过 `GET /api/v1/agents/{node}/updates` 拉取所属任务回执。
- 去重键：中断态是 `(Task_ID, Status_Msg)`；终态带上 `Status`。
- 本地与总线双向记账：已呈递的键保存在本地配置目录的 `present_state.json`，并读-合并写回 `Tasks.Metadata.presented_keys`。
- 陈旧告警与呈递分开：`working` 心跳为空或早于 20 分钟，以及 `submitted` 超过 20 分钟无人认领，每种情况每个任务只告警一次，记在 `stale_state.json`。

## 审批回路

1. 认领前（`Claimed_By` 为空）或执行中（`Claimed_By` 非空）进入 `auth-required` 后，`ApprovalService` 记账并由 `ExternalNotifier`（若配置）推送带 Web 控制台深链的待批提醒。
2. 机主在 Web 控制台或调用 `POST /api/v1/approvals/:taskId/decide` 操作批准或驳回：
   - 回读确认任务仍处于 `auth-required` 且 `Status_Msg` 一致；
   - 使用 Hub `approval_key.pem` 为 `(task_id, request_id, decision)` 生成 **ed25519 签名**，写入 `auth_decision`（`From_Node=hub`、`Role=user`、`In_Reply_To=当前 Status_Msg`、`DataPart={decision, sig}`）；
   - `approve` 时若 `Claimed_By` 为空则回置 `submitted` 等待认领；若 `Claimed_By` 非空则保留状态，由原宿主节点或 HTTP Agent 验签后恢复 `working`；`reject` 时认领前转 `rejected` / 执行中置 `canceled` 并写 `notice`。
3. 宿主内核与外部网关在放行/续跑前均执行标准 §8.3 校验（配了公钥时强制校验 ed25519 签名）。

## 运维要点

- **进程托管**：使用 `ah up --service` 或 `ah join <hub-url> --service` 注册用户级自启（macOS launchd `ah-<role>.<node>` / Linux systemd `ah-<role>-<node>.service` / Windows 任务计划 `ah-<role>-<node>`，非默认配置目录追加配置路径 SHA-256 前 8 位摘要），日志在配置目录 `daemon.log`。
- **本地状态**：`approval_state.json`、`present_state.json`、`stale_state.json`、`schedule_state.json`、`hub.db*`、`approval_key.pem`、`app.env` 保存在配置目录，不进仓库。
- **留痕与溯源**：排查具体单据时运行 `ah task why <Task_ID> [--config <dir>] [--json]` 查阅单任务全链时间线与本地在途状态，亦可通过 Web 控制台或 `ah task show <Task_ID>` 查看。
