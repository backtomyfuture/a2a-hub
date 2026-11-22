# AGENTS.md — a2a-hub

a2a-hub：自托管独立多 Agent 编排中台（基于 A2A 八态数据模型，统一采用 SQLite WAL + HTTP 网关架构：内置 HTTP 长轮询总线、`agent-gateway` 纯 HTTP Agent 接入协议、Web 控制台与 `Context_ID` 跨任务多轮记忆 / Leader 扇出编排）。
本仓库只有 Node >= 24 ESM 实现且**零外部 npm 运行时依赖**（`dependencies: {}`）：`ah`（主入口）、`a2a-hub` 与 `ahub` 同时承载 `node` 与 `hub` 两个逻辑角色。
方向（标准 §10）：`hub` 角色是 `node` 角色的单进程超集；由 `ah daemon --role node|hub` 承载。省略 `--role` 时读配置目录 `node.json` 的 `role`，缺省 `node`。独立中台模式下，`role=hub` 单进程同时运行本地工作内核（按 `commands.json` 接单）、`SqliteBus`（`node:sqlite`）、`startHubHttpServer`（REST API + `LongPollBroker` + `agent-gateway` + Web 控制台）、`ApprovalService`（ed25519 签名）、`PresentService`、`StaleService` 与 `ExternalNotifier`。

## 目录与职责

- `bin/ah.mjs`：CLI 分发 `setup | up | join | daemon | reconcile | doctor | inventory | service | task (create|reply|show|why|cancel) | present | inbox | update`（支持 `--role node|hub`；省略时 daemon / doctor / service 读 `node.json` 的 role，缺省 node；`task create` 支持 `--schedule <id>`）；配置目录取 `--config <dir>` > `AH_HOME` > `~/.a2a-hub`（内含 `node.json` 与 `commands.json`）。
- `src/bus/tables.mjs`：统一逻辑表名映射 `DEFAULT_TABLES`（5 张纯 A2A 核心逻辑表：`tasks`, `messages`, `parts`, `artifacts`, `agentCards`）与字段读取辅助 `f1`，供 SQLite / HTTP / Mock 总线共享。
- `src/bus/sqlite-bus.mjs`：`SqliteBus`（Node 内置 `node:sqlite` `DatabaseSync` + WAL 模式），支撑独立中台持久化存储、`client_token` 幂等去重、卡片记录管理与变更序号通知 `LongPollBroker`。
- `src/bus/http-bus.mjs`：`HttpBus`（基于原生 `fetch` 的远端总线客户端），远端宿主节点通过 Bearer Token + HTTP REST 读写中台表，并经 `/api/v1/poll` 长轮询接收唤醒。
- `src/server/longpoll-broker.mjs`：`LongPollBroker`，维护全网单调递增 `seq`、挂起 HTTP 长轮询连接（`GET /api/v1/poll` / `GET /api/v1/agents/:node/poll`）与各节点/外部 Agent 在线状态；支持按节点名片配置的分钟轮询间隔（`poll_interval_min`）以 `× 1.5` 判定在线（无配置时 `http-poll` 默认 5×1.5=7.5 分钟、`webhook` 默认 30×1.5=45 分钟）；无名片且超出闲置窗口无活动的在线记录不进名册，24 小时后从内存清除。在线快照可节流写入 SQLite `meta` 并在启动时装回。没有活跃连接且超出在线窗口时 `online=false`，不用名片 Availability 兜底。
- `src/server/agent-gateway.mjs`：`handleAgentGatewayRequest`，面向纯 HTTP Agent（如云端 Muse Leader、Grok Bot Worker 等无守护进程节点）的 A2A REST 网关：免鉴权 `GET /.well-known/agent.json`（其余均需鉴权，含 `GET /api/v1/skills[/:name]` 与 `GET /api/v1/kit/a2a_check.py|.sh`）、`POST /api/v1/agents/register`、`GET /api/v1/agents`、`GET /api/v1/agents/:node/check`（只读，不推进 Leader 水位；唯一副作用是 `touchAgent`）、`GET|POST /api/v1/agents/:node/poll`、`GET /api/v1/agents/:node/inbox`、`GET /api/v1/agents/:node/updates`（`since=<seq>` 或 `new=1` 增量，响应带 `watermark`，每条带 `changed_seq`）、`GET /api/v1/tasks` 与 `POST /api/v1/tasks/:id/{claim,heartbeat,complete,fail,ask,auth}`。`register` 响应带 `admission` / `pending`，`GET /api/v1/agents` 的 `caps[]` 带 `admission`；这两处不写接纳字段。路由级权限不在网关内，由 `src/hub/agent-access.mjs` 在 http-server 入口先校验。
- `src/server/http-server.mjs`：`startHubHttpServer`，暴露统一 Hub HTTP 网关：`/`（Web 控制台）、`/api/v1/health`（免鉴权健康探针）、`/.well-known/agent.json`、`/api/v1/state`、`/api/v1/poll`、`/api/v1/tables/*`、`/api/v1/agents*`、`/api/v1/tasks*`（支持单节点派单与 `to: [...]` 批量扇出，共享 `context_id`）、`/api/v1/approvals/:taskId/decide`、`GET /api/v1/schedules`、`/api/v1/admin/*`（名片接纳、显示名备注、添加 Agent 与接入提示词在 `src/hub/admission.mjs`（Step 3 提示词按节点模板 id `template_id` 选取，如 `generic-poll` / `workbuddy` / `muse` / `grok-bot`，写入名片 `Metadata.template_id`；粗分类 `template` 仍是 `generic` / `muse` / `grok-bot`，后两者约束接收方式并在非 generic 时写入 `Metadata.template`。轮换 Token 沿用 `template_id`。模板目录是配置目录 `agent_templates.json`（`src/hub/agent-templates.mjs`）：初始四条由 hub 首次启动写入，之后新增模板也只改这个文件；`intro` 只换开场，协议步骤仍由程序生成。提示词自包含、不伪装 UA、不要求对方下载脚本）；添加能力与 `commands-snippet` 在 `src/hub/capabilities.mjs`；Webhook 在 `src/hub/webhooks.mjs`；Token 管理 `GET /api/v1/admin/tokens`、`POST /api/v1/admin/tokens/:node/rotate`、`DELETE /api/v1/admin/tokens/:node` 与名录审计 `GET /api/v1/admin/audit` 仅机主可用）；监听地址由 `cfg.listen`（默认 `0.0.0.0:8787`）控制。陈旧巡检约每 60 秒一次，不改对账 `sweepSec=900`。鉴权分两类身份：机主 `apiToken`（`AH_API_TOKEN`，owner 全权限）与分 Agent Token（agent，绑定 `{node, role, scopes}`）；仅 `/`、`/api/v1/health`、`/.well-known/agent.json` 免鉴权，`/api/v1/skills*` 需要鉴权。未配机主 `apiToken` 且未签发任何 Agent Token 时为 open 免鉴权。未配置机主 `apiToken` 时拒绝签发 Agent Token。
- `src/server/web-ui.mjs`：`renderWebConsoleHtml()`，零构建依赖内嵌机主视角 Web 控制台（首页「待我处理」、「节点」页按节点 / Agent / 能力分组、添加能力、添加 Agent 三步向导含接收方式、Webhook 查看与测试、Token 重新生成/吊销、「定时任务」只读页、任务详情与在线签名审批/答复）。
- `src/hub/agent-tokens.mjs`：`AgentTokenStore`，`<configDir>/agent_tokens.json`（0600，只存 sha256 哈希与展示前缀）的签发 / 轮换 / 吊销 / 验证，明文只在签发响应出现一次；`last_used_at` 按分钟合并写。
- `src/hub/agent-templates.mjs`：`<configDir>/agent_templates.json`（0600）。HTTP 节点模板的完整目录，初始四条和后加模板同一份文件；文件不存在时由 hub 写入初始四条。

- `src/hub/webhooks.mjs`：`AgentWebhookStore` + `WebhookDispatcher`。`<configDir>/agent_webhooks.json`（0600）保存机主登记的 URL 与接收端提供的密钥（明文，列表与日志只返回掩码和请求头名）。任务变为 `submitted`（执行节点）或 Leader 关心的状态时只 POST 门铃，不跟随重定向。messages 的 `answer` / `auth_decision` 另发 `event=task.resumed`（去重含消息号），仍不跟随重定向。
- `src/hub/capabilities.mjs`：区分 http / host 节点，`POST /api/v1/admin/cards` 与 `commands-snippet`，`GET /api/v1/schedules` 只读汇总（从 `AgentCard.Metadata.schedules` 聚合，自动关联 `Tasks` 的 `last_task` 并按 `interval_min * 1.5` 判 `missed`），以及 `PUT|DELETE /api/v1/agents/:node/schedules/:id`（支持可选 `run` 一步落 `Source=cron` 的 `Task` 记录；中台不据此主动触发）。
- `src/hub/agent-access.mjs`：Agent Token 的路由矩阵（`assertAgentRoute`：任何角色可拉 `skills`、`kit` 检查脚本、`register`、`GET /agents` 和自己的 `check`，以及自己的 `PUT|DELETE /api/v1/agents/:node/schedules/:id`；`worker` 只走 poll、inbox 与任务生命周期；`leader` 在此之上再走派单、updates，以及自己发起或指向自己的任务（旧 `hybrid` 按 leader 处理）；`scopes` 含 `admin` 的 leader 另可接纳名片、改显示名、生成接入提示词、`POST /api/v1/admin/cards`；仅 `access` 为 `host` / `inbox` 的节点专属 Token 可通过 `/api/v1/poll` 与 `/api/v1/tables/*` 运行 `HttpBus`，并在 `assertAgentTableWrite` 中强制守卫 `Node` / `From_Node` / `Produced_By`、禁止自授 `Admission` / 伪造 `auth_decision` / 修改只追加表 / 越权写任务。任何 agent 都不能访问 `/approvals/*`、`/admin/agents`、`/admin/tokens*`、`/admin/webhooks*`、`/admin/commands-snippet`、`/admin/audit`、`DELETE /admin/cards/:capId`、`/schedules`、`/state`）、请求体身份绑定（`bindAgentBody`，省略 `node`/`from` 补成绑定节点；路径节点、查询参数 `node`/`from` 与 `X-A2A-Node` 冒充返回 403。`GET /api/v1/admin/onboarding` 的 `node` 是目标节点，不按冒充计）与任务可见性（`agentCanSeeTask`）；机主与 open 身份不走这里。
- `src/hub/notifier.mjs`：`ExternalNotifier`，可选外部通知器（飞书自定义群机器人 Webhook / Bark / Telegram / 通用 Webhook），按事件去重并附带控制台深链。
- `src/kernel.mjs`：状态机骨架（构造、`sweepOnce`/`run` 主循环与状态迁移），唯一写任务状态的节点代码。辅助拆在 `receipt.mjs`、`retry-state.mjs`、`session-store.mjs`（支持按 `Context_ID` 跨任务持久化并自动续接 CLI `Session_ID`）、`config.mjs`、`kernel-util.mjs`，以及原型混入的 `kernel-direct.mjs`（含 `collectContextHistory` 上下文注入）、`kernel-approval.mjs`、`kernel-outbox.mjs`、`kernel-metadata.mjs`。常量 `DAEMON_VERSION`、`HOP_LIMIT=8`、`MAX_RETRIES=2`、`STALE_MIN=20`、`HEARTBEAT_MIN_SEC=90` 留在本文件。
- `src/config.mjs`：节点配置加载（识别 `busType`: `sqlite` / `http`）、监听地址解析、能力表归一（`normalizeCommands` / `resolveCapKey` / `capIdOf`）。
- `src/acceptance.mjs`：验收层纯函数（标准 §11）：清单校验、自检归一、逐条判定、overall、回执 DataPart 与 Metadata 索引。
- `src/attachments.mjs`：附件入参校验、外部 URL 规范、消息与产物 FilePart 构建及任务视图附件展开。
- `src/files-client.mjs`：统一文件客户端（`LocalFileClient` / `HttpFileClient`），供内核、CLI 与 inbox 上传/下载 `hub://` 文件。
- `src/approval-sign.mjs`：审批决定的 ed25519 签名与验签；hub 私钥在其配置目录 `approval_key.pem`，节点按 `node.json` 的 `hubPublicKey` 验。
- `src/transport/`：唤醒工厂（`createWaker`），支持 `longpoll`（`src/transport/longpoll.mjs`，统一默认模式）与 `poll`，外加 15 分钟对账定时兜底及 `PENDING_RECHECK` 挂起短复查。
- `src/setup.mjs` / `src/doctor.mjs` / `src/service.mjs` / `src/inventory.mjs` / `src/update.mjs`：支持独立 `sqlite` Hub 与远端 `http` 节点（`up` / `join`）的向导、只读自检、用户级自启注册（`ah service --ensure` 为幂等自愈：已活跃且代理指纹未变即 0 退出，否则按 system → user → 后台 spawn 逐级收敛，适配无 systemd 的临时云 VM）、名片盘点与程序更新。`bin/ah.mjs` 在检测到代理环境变量时自动带 `NODE_USE_ENV_PROXY=1` 原地自重启一次（Node 24 的 fetch 只在启动前读该变量）；`install.sh` 在缺少 Node >= 24 时自动把官方 Node 24 LTS 装进家目录（sha256 校验，`~/.local/node`）。
- `src/hub/files.mjs`：`FileStore`（`<configDir>/files/blobs` + `files.db`）、`FileRetentionService` 定时清理与任务引用查找。
- `src/hub/`：`hub` 角色组件（`approval.mjs`、`present.mjs`、`stale.mjs`、`notifier.mjs`、`webhooks.mjs`、`capabilities.mjs`、`admission.mjs`、`agent-templates.mjs`、`files.mjs`、`create.mjs`、`cancel.mjs`、`cards.mjs`、`owner.mjs`、`index.mjs`）。
- `docs/standard.md`：**中台标准，权威**。`docs/base-schema.md` 与 `schema/base-schema.json` 是生成物，由 `schema/generate_schema.mjs` 产出。
- `docs/configuration.md`：配置目录、`node.json` / `commands.json`、独立中台、HTTP Agent 协议接入、定时自报与观测、多轮上下文续接与 CLI 速查。
- `config/*.example.json`：配置样例（`hub.standalone.example.json`、`node.remote.example.json`、`commands.example.json`、`agent_templates.example.json`、`node.example.json`），只放占位符。
- `skills/`：2×2 四类 Agent Skill（`ah` 主控 CLI、`ah-inbox` 本地收件箱 CLI、`a2a-leader` 纯 HTTP Leader、`a2a-worker` 纯 HTTP Worker）；`setup`/`update` 仅按 `role/kind` 安装对应的本地 CLI Skill，纯 HTTP Agent 可经需鉴权的 `GET /api/v1/skills/:name` 拉取。
- `tests/`：`node:test` 测试（`tests/*.test.mjs`，含 `sqlite-bus.test.mjs`、`http-longpoll.test.mjs`、`agent-gateway.test.mjs` 等）与内存总线 `tests/mocks/`。不连真实外部服务，状态只写临时目录。

## 命令

```sh
# 语法检查（Node >= 24，零外部依赖，无需 npm install）
for f in bin/*.mjs src/*.mjs src/*/*.mjs schema/*.mjs; do node --check "$f" || exit 1; done
npm test
node bin/ah.mjs setup --role hub --bus sqlite --node mac-mini-hub --listen 0.0.0.0:8787 --yes --config <dir>
node bin/ah.mjs doctor --config <dir> [--role node|hub]
node bin/ah.mjs daemon --config <dir> [--role node|hub]
```

测试只用 `npm test`（Node 内置 `node:test` 与 `node:assert`）。不要引入第三方运行时依赖或测试框架。

## 代码约定与安全红线

- **Node >= 24，ESM `.mjs`，零第三方运行时依赖**：SQLite 用 `node:sqlite`，HTTP 服务端用 `node:http`，HTTP 客户端用全局 `fetch`，加密签名用 `node:crypto`。
- **三层寻址**：Node → Worker → Skill；按任务取能力条目一律用 `kernel.capKeyOf(task)`。
- **A2A 八态与只追加消息**：`submitted`、`working`、`input-required`、`auth-required`、`completed`、`failed`、`canceled`、`rejected`；`Messages` 与 `Parts` 只追加、不修改、不删除；终态不可重启。
- **指令与数据分离**：可执行命令、`cwd`、`verify` 只读本地 `commands.json`；任务上下文落 `0600` 权限 `runs/<Task_ID>/input.json`；请求参数出现执行控制键直接拒收。
- **签名审批边界**：审批只认 `auth_decision` 消息的 DataPart；节点配了 `hubPublicKey` 时必须通过 `kernel.decisionForRequest` 验签。
- **节点出站、Hub 鉴权**：边缘执行节点（`role=node`）绝不开监听端口；独立中台 Hub（`role=hub`）HTTP 服务仅按 `listen` 配置绑定并对除 `/api/v1/health` 与静态页外的 `/api/*` 路由执行 Bearer API Token 校验。
- **注释语言**：注释用中文，写「为什么」，沿用现有风格。

## 禁止事项

- 不要提交 `app.env`、`.a2a-hub/`、`hub.db`、`hub.db-wal`、`hub.db-shm`、`hub_runtime.json`、`approval_key.pem`、`agent_tokens.json`、`agent_webhooks.json`、`agent_templates.json`、`*_state.json`、`retry_state.json`、`runs/`，以及任何真实 API Token 或 Webhook 地址。
- 不要修改或删除 `Messages` / `Parts` 行，不要重开终态任务，不要给 `Tasks` 加参数列。
- 不要让守护进程因启动期或单轮错误退出，不要吞掉错误后假装成功。
- 未经要求不要提交、推送或发版。
