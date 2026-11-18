# Changelog

本项目的主要变更记录如下。节点与中台版本号见 `package.json` / `ah --version`；中台规范见 [docs/standard.md](docs/standard.md)。

## [1.1.0] - 2026-11-18

- **接收方式三选一**：HTTP 节点的接收方式只能是定时检查、常驻长连接或 Webhook 之一，由机主 `POST /api/v1/admin/nodes/:node/receive` 切换，并同步该节点全部名片。切到 Webhook 时登记 URL，新建才返回一次性 secret；切走则删除 Webhook。非 Webhook 节点 `PUT /api/v1/admin/webhooks/:node` 返回 409。`DELETE` 该 Webhook 时名片回到 `http-poll`。`register` 不再用自报模式覆盖机主已开启的 Webhook；自报 webhook 但机主未配置时写成 `http-poll` 并警告。宿主节点不能切换。控制台只在当前模式为 Webhook 时显示 Webhook 管理，并说明 30 分钟检查脚本只是兜底。
- **Webhook 门铃**：HTTP Agent 增加接收方式 `http-longpoll` 与 `webhook`（默认定时检查仍是 `http-poll`）。配置目录 `agent_webhooks.json`（0600）保存机主填写的 URL 与 HMAC 密钥；密钥明文只在新建或轮换时返回一次，列表与日志不含密钥。推送只有门铃（`task.assigned` / `task.updated` / `ping`），不含指令正文。签名为 `HMAC-SHA256(secret, timestamp.rawBody)`，不跟随重定向，超时 10 秒，失败按 0/1/3/8 秒重试。管理接口为 `GET|PUT|DELETE /api/v1/admin/webhooks*` 与 `POST .../test`，仅机主可用。
- **添加能力**：`POST /api/v1/admin/cards` 给 http 节点加已接纳名片（带 `admin` scope 的 leader 也可）；宿主节点改为 `POST /api/v1/admin/commands-snippet` 生成 `commands.json` 片段，中台不下发。`DELETE /api/v1/admin/cards/:capId` 仅机主，且只删手动或预置的 http 名片。
- **定时任务只读**：`GET /api/v1/schedules` 仅机主，按节点汇总 cron、下次触发、上次任务与异常（离线 / 失败 / 漏触发）。HTTP Agent 用 `PUT|DELETE /api/v1/agents/:node/schedules/:id` 自报计划，只能改自己的节点，中台不据此触发。
- **控制台**：导航「节点」按节点、Agent、能力分组，可添加能力、选择接收方式并管理 Webhook。新增只读「定时任务」页。界面说法改为节点 / Agent / 能力，API 字段名不变。

## [Unreleased]

- **分 Agent Token**：配置目录 `agent_tokens.json`（0600，只存 sha256 与展示前缀）。机主 `apiToken` 仍是 owner。外部 HTTP Agent 使用绑定 `{node, role, scopes}` 的 Token。`worker` 只走 register、poll、inbox 与任务生命周期；`leader` 可派单、查看自己发起或指向自己的任务、答复和撤销自己发起的任务、loops 与 updates；`hybrid` 两边都有；`scopes` 含 `admin` 的 leader 可接纳名片、改显示名、为其他节点生成接入提示词。任何 Agent 身份不能访问 `/approvals/*`、`/admin/agents`、`/admin/tokens*`、`/state`、`/tables/*`、`/poll`。路径节点、`node`/`from` 与 `X-A2A-Node` 冒充返回 403。仅机主可 `POST /api/v1/admin/agents`（`access=http` 时签发，明文只出现一次）、`GET /api/v1/admin/tokens`、`POST /api/v1/admin/tokens/:node/rotate`、`DELETE /api/v1/admin/tokens/:node`。未配置机主 `apiToken` 时拒绝签发。两把钥匙都没有时接口仍免鉴权。
- **鉴权收紧**：`/api/v1/skills` 与 `/api/v1/skills/:name` 需要鉴权。免鉴权只剩 `/`、`/api/v1/health`、`/.well-known/agent.json`。
- **Leader 增量更新**：`GET /api/v1/agents/:node/updates` 支持 `since=<seq>` 与 `new=1`（Hub 为该 leader 持久化水位）。终态只返回新变化，`input-required` / `auth-required` 在处理完前一直返回。每条带 `changed_seq`，响应带 `watermark`。
- **名册卫生**：无名片且 30 分钟无活动的在线记录不进名册。内存里的在线记录超过 24 小时无活动即清除，名片仍在表里。
- **Hub 本机自动接纳**：`role=hub` 且名片属于本机节点时，空 `Admission` 在对账时补成 `admitted`。已有值（含显式 `pending` / `rejected`）不覆盖。远端节点与外部 Agent 自行 register 的名片仍须机主接纳。
- **定时接入提示词**：外部 Agent 用检查脚本门控。worker / hybrid 每 2 分钟、leader 每 5 分钟跑 `a2a_check.py`（或 `.sh`）；`IDLE` 结束，`WORK` 才执行处理流程。跑不了脚本时回退为 worker 每 10 分钟、leader 每 15 分钟。Token 优先存为 `A2A_HUB_TOKEN`。每次无上下文。Worker 须在同一次运行内完成所认领任务。
- **轻量检查**：`GET /api/v1/agents/:node/check` 只读，不推进 Leader 的 `updates` 水位，只刷新在线状态。`GET /api/v1/kit/a2a_check.py` 与 `.sh` 需要鉴权，返回的脚本不含 Token。
- **Web 控制台**：首页「待我处理」、Agent 按节点分组、大白话派单、添加 Agent 三步向导、Token 重新生成与吊销。
- **名片接纳**：AgentCards 增加本地扩展字段 `Admission`（`admitted` / `pending` / `rejected`，缺省 `pending`）、`Display_Name`、`Admin_Note`。`/agents/register` 不写这三列。远端新名片和升级前的空 `Admission` 仍待接纳后才能派单。管理接口为 `/api/v1/admin/cards/:capId/admission`、`/api/v1/admin/nodes/:node/admission`、`/api/v1/admin/cards/:capId/profile`（`PATCH` 与 `POST`）、`/api/v1/admin/agents` 与 `/api/v1/admin/onboarding`（逻辑在 `src/hub/admission.mjs`）。
- **命名独立化与目录/环境变量迁移（破坏性变更）**：
  - 默认配置目录改为 `~/.a2a-hub`（程序本体位于 `~/.a2a-hub/app/`），不再使用旧版默认配置目录；
  - 配置目录环境变量改为 `AH_HOME`（优先级：`--config <dir>` > `AH_HOME` > `~/.a2a-hub`），不再读取旧配置目录环境变量；
  - 环境变量统一为 `AH_*` 前缀：API Token 仅认 `AH_API_TOKEN`，跳过技能安装仅认 `AH_SKIP_SKILL`，L1 `verify` 注入变量统一为 `AH_TASK_ID`、`AH_ARTIFACT`、`AH_RUN_DIR`、`AH_MAIN_STDOUT`，移除所有旧前缀环境变量；
  - CLI 主命令为 `ah`，命令别名仅保留 `a2a-hub` 与 `ahub`，移除旧命令行别名及对应转发入口；
  - 自启服务名统一为 `ah-<role>.<node>`（macOS launchd）、`ah-<role>-<node>.service`（Linux systemd）与 `ah-<role>-<node>`（Windows 任务计划），非默认配置目录追加配置路径 SHA-256 前 8 位摘要，移除旧服务名兼容与沿用逻辑。
- **安装脚本与配置防覆盖加固**：
  - `install.sh` / `install.ps1` 仅在已有程序目录的 git origin 为 `backtomyfuture/a2a-hub` 时执行 `git pull`，遇到其他仓库来源时提前退出，不改动现有配置与命令入口；
  - 安装前校验 `bin/ah.mjs` 存在并仅对实际存在的入口文件 `chmod`；`~/.local/bin` 不在 `PATH` 时打印 zsh 与 bash 配置提示；未指向本次安装的既有命令软链保持不动；
  - `install`（`--hub` / `--join`）、`ah setup --yes` 与 `ah join` 遇到已有或不兼容配置时不静默覆盖，需显式 `--force`；自定义配置目录的自启服务名按配置路径摘要隔离。

## [1.0.0] - 2026-11-15（`a2a-hub` 首个公开版本）

`a2a-hub` 首个公开版本（`DAEMON_VERSION` = `node-1.0.0`），基于 Node >= 24 ESM 与零外部 npm 运行时依赖（`dependencies: {}`），提供独立自托管多 Agent 编排中台：

- **零依赖 SQLite WAL 总线（`SqliteBus`）**：基于 Node >= 24 内置 `node:sqlite`（`DatabaseSync` WAL 模式）持久化存储 `tasks` / `messages` / `parts` / `runs` / `artifacts` / `agentCards` / `rules` / `loops`，支持 `client_token` 幂等去重与单调递增 `seq` 游标。
- **出站 HTTP 长轮询与外部 Agent 网关（`startHubHttpServer` + `LongPollBroker` + `HttpBus` + `agent-gateway`）**：中台常驻主机暴露统一 REST API、`GET /api/v1/poll` 长轮询端点与面向无守护进程外部 Agent 的 `agent-gateway`（`GET /.well-known/agent.json`、`GET /api/v1/skills[/:name]`、`POST /api/v1/agents/register`、`GET|POST /api/v1/agents/:node/poll`、`GET /api/v1/agents/:node/updates`、`POST /api/v1/tasks/:id/{claim,heartbeat,ask,auth,complete,fail}`），支持 Bearer Token 鉴权与 `hub_runtime.json`；远端执行节点保持零监听端口、纯出站连接，实现毫秒级唤醒与 `PENDING_RECHECK` 短复查。
- **内置 Web 控制台（`src/server/web-ui.mjs`）**：零构建依赖内嵌可视化界面，支持全网拓扑与在线节点/HTTP Agent 监控、AgentCards 三层能力矩阵、A2A 任务时间线与在线 `input-required` 回复、基于 Hub ed25519 私钥的在线签名审批与 LoopForge SOP 编排室。
- **A2A 八态状态机、三层寻址与两层验收**：完整实现 `Node → Worker → Skill` 三层寻址、指令与数据分离（`0600` 权限 `input.json` 与执行控制键拒收）、`direct` 在途执行账本（`runs/<Task_ID>/entry.json`）、本地定时调度（`schedules.json` + `Rules` 只读镜像）、独立 Agent 收件箱（`ah inbox`）、原路结果呈递队列（`present_queue.jsonl` + `ah present`）以及 L1（`verify` 命令）+ L2（`acceptance.criteria` 清单）两层验收。
- **LoopForge 多阶段 SOP 闭环编排引擎（`LoopService` + `ah loop`）**：内置 `plan-code-verify`、`write-review-refine`、`audit-fix-verify` 等 SOP 模板与自定义阶段支持；同一 `Context_ID` 下推进多阶段任务，结合 `acceptanceForTask` 验收结论触发 `retry` / `goto:<stage_id>` / `abort`，受 `Max_Iterations` 与 `HOP_LIMIT=8` 双重熔断保护。
- **可选多通道外部提醒（`ExternalNotifier`）**：支持配置飞书群机器人 Webhook（可选通知渠道）、Bark、Telegram 与通用 Webhook 推送待审批、提问、终态与陈旧任务告警。
- **一键部署与 2×2 Skill 分工**：提供 `install.sh` / `install.ps1`、`ah up` / `ah join`、`ah setup --bus sqlite|http`、`ah doctor`、`ah service`（launchd / systemd / Windows 任务计划）、`ah update`，并按「控制端/执行端 × CLI/纯 HTTP」提供 4 套独立 Skill 模板。
