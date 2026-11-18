# AGENTS.md — a2a-hub

a2a-hub：自托管独立多 Agent 编排中台（基于 A2A 八态数据模型，统一采用 SQLite WAL + HTTP 网关架构：内置 HTTP 长轮询总线、`agent-gateway` 纯 HTTP Agent 接入协议、Web 控制台与 LoopForge 多阶段 SOP 闭环引擎）。
本仓库只有 Node >= 24 ESM 实现且**零外部 npm 运行时依赖**（`dependencies: {}`）：`ah`（主入口）、`a2a-hub` 与 `ahub` 同时承载 `node` 与 `hub` 两个逻辑角色。
方向（标准 §10）：`hub` 角色是 `node` 角色的单进程超集；由 `ah daemon --role node|hub` 承载。省略 `--role` 时读配置目录 `node.json` 的 `role`，缺省 `node`。独立中台模式下，`role=hub` 单进程同时运行本地工作内核（按 `commands.json` 接单）、`SqliteBus`（`node:sqlite`）、`startHubHttpServer`（REST API + `LongPollBroker` + `agent-gateway` + Web 控制台）、`ApprovalService`（ed25519 签名）、`PresentService`、`StaleService`、`ScheduleService`、`LoopService` 与 `ExternalNotifier`。

## 目录与职责

- `bin/ah.mjs`：CLI 分发 `setup | up | join | daemon | reconcile | doctor | inventory | service | task (create|reply|show|why|cancel|begin) | schedule (ls|add|rm|enable|disable|register) | loop (create|ls|show|cancel|templates) | present | inbox | update`（支持 `--role node|hub`；省略时 daemon / doctor / service 读 `node.json` 的 role，缺省 node）；配置目录取 `--config <dir>` > `AH_HOME` > `~/.a2a-hub`（内含 `node.json` 与 `commands.json`）。
- `src/bus/tables.mjs`：统一逻辑表名映射 `DEFAULT_TABLES`（`tasks`, `messages`, `parts`, `runs`, `artifacts`, `agentCards`, `rules`, `loops`）与字段读取辅助 `f1`，供 SQLite / HTTP / Mock 总线共享。
- `src/bus/sqlite-bus.mjs`：`SqliteBus`（Node 内置 `node:sqlite` `DatabaseSync` + WAL 模式），支撑独立中台持久化存储、`client_token` 幂等去重、卡片记录管理与变更序号通知 `LongPollBroker`。
- `src/bus/http-bus.mjs`：`HttpBus`（基于原生 `fetch` 的远端总线客户端），远端宿主节点通过 Bearer Token + HTTP REST 读写中台表，并经 `/api/v1/poll` 长轮询接收唤醒。
- `src/server/longpoll-broker.mjs`：`LongPollBroker`，维护全网单调递增 `seq`、挂起 HTTP 长轮询连接（`GET /api/v1/poll` / `GET /api/v1/agents/:node/poll`）与各节点/外部 Agent 在线状态。
- `src/server/agent-gateway.mjs`：`handleAgentGatewayRequest`，面向纯 HTTP Agent（如云端 Muse Leader、Grok Bot Worker 等无守护进程节点）的 A2A REST 网关：免鉴权 `GET /.well-known/agent.json`、`GET /api/v1/skills[/:name]`、`POST /api/v1/agents/register`、`GET /api/v1/agents`、`GET|POST /api/v1/agents/:node/poll`、`GET /api/v1/agents/:node/inbox`、`GET /api/v1/agents/:node/updates`、`GET /api/v1/tasks` 与 `POST /api/v1/tasks/:id/{claim,heartbeat,complete,fail,ask,auth}`。
- `src/server/http-server.mjs`：`startHubHttpServer`，暴露统一 Hub HTTP 网关：`/`（Web 控制台）、`/api/v1/health`（免鉴权健康探针）、`/.well-known/agent.json`、`/api/v1/state`、`/api/v1/poll`、`/api/v1/tables/*`、`/api/v1/agents*`、`/api/v1/tasks*`、`/api/v1/approvals/:taskId/decide`、`/api/v1/loops*`；监听地址由 `cfg.listen`（默认 `0.0.0.0:8787`）控制并支持 Bearer Token 鉴权（`AH_API_TOKEN` / `cfg.apiToken`）。
- `src/server/web-ui.mjs`：`renderWebConsoleHtml()`，零构建依赖内嵌 Web 控制台（总览拓扑含宿主节点与 HTTP Agent 状态、Agent Hub 名片与接入参考、A2A 任务详情与在线签名审批/答复、SOP Loop 编排室）。
- `src/hub/loop.mjs`：`LoopService`、`BUILTIN_LOOP_TEMPLATES`（含 `plan-code-verify`）、`createLoop`、`cancelLoop`；LoopForge 风格多阶段闭环状态机，在同一个 `Context_ID` 下推进阶段任务并结合 `acceptance.mjs` 验收结论触发 `retry` / `goto:<stage_id>` / `abort`，受 `Max_Iterations` 与 `HOP_LIMIT=8` 限制。
- `src/loop-cli.mjs`：`ah loop (create|ls|show|cancel|templates)` CLI 实现。
- `src/hub/notifier.mjs`：`ExternalNotifier`，可选外部通知器（飞书自定义群机器人 Webhook / Bark / Telegram / 通用 Webhook），按事件去重并附带控制台深链。
- `src/kernel.mjs`：状态机骨架（构造、`sweepOnce`/`run` 主循环与状态迁移），唯一写任务状态的节点代码。辅助拆在 `receipt.mjs`、`retry-state.mjs`、`session-store.mjs`、`config.mjs`、`kernel-util.mjs`，以及原型混入的 `kernel-direct.mjs`、`kernel-approval.mjs`、`kernel-outbox.mjs`、`kernel-metadata.mjs`。常量 `DAEMON_VERSION`、`HOP_LIMIT=8`、`MAX_RETRIES=2`、`STALE_MIN=20`、`HEARTBEAT_MIN_SEC=90` 留在本文件。
- `src/config.mjs`：节点配置加载（识别 `busType`: `sqlite` / `http`）、监听地址解析、能力表归一（`normalizeCommands` / `resolveCapKey` / `capIdOf`）。
- `src/acceptance.mjs`：验收层纯函数（标准 §11）：清单校验、自检归一、逐条判定、overall、回执 DataPart 与 Metadata 索引。
- `src/approval-sign.mjs`：审批决定的 ed25519 签名与验签；hub 私钥在其配置目录 `approval_key.pem`，节点按 `node.json` 的 `hubPublicKey` 验。
- `src/transport/`：唤醒工厂（`createWaker`），支持 `longpoll`（`src/transport/longpoll.mjs`，统一默认模式）与 `poll`，外加 15 分钟对账定时兜底及 `PENDING_RECHECK` 挂起短复查。
- `src/setup.mjs` / `src/doctor.mjs` / `src/service.mjs` / `src/inventory.mjs` / `src/update.mjs`：支持独立 `sqlite` Hub 与远端 `http` 节点（`up` / `join`）的向导、只读自检、用户级自启注册、名片盘点与程序更新。
- `src/hub/`：`hub` 角色组件（`approval.mjs`、`present.mjs`、`stale.mjs`、`schedule.mjs`、`loop.mjs`、`notifier.mjs`、`create.mjs`、`cancel.mjs`、`cards.mjs`、`owner.mjs`、`index.mjs`）。
- `docs/standard.md`：**中台标准，权威**。`docs/base-schema.md` 与 `schema/base-schema.json` 是生成物，由 `schema/generate_schema.mjs` 产出。
- `docs/configuration.md`：配置目录、`node.json` / `commands.json` / `schedules.json`、独立中台、HTTP Agent 协议接入与 LoopForge SOP 配置及 CLI 速查。
- `config/*.example.json`：配置样例（`hub.standalone.example.json`、`node.remote.example.json`、`commands.example.json`、`schedules.example.json`、`node.example.json`），只放占位符。
- `skills/`：2×2 四类 Agent Skill（`ah` 主控 CLI、`ah-inbox` 本地收件箱 CLI、`a2a-leader` 纯 HTTP Leader、`a2a-worker` 纯 HTTP Worker）；`setup`/`update` 仅按 `role/kind` 安装对应的本地 CLI Skill，纯 HTTP Agent 可经 `GET /api/v1/skills/:name` 拉取。
- `tests/`：`node:test` 测试（`tests/*.test.mjs`，含 `sqlite-bus.test.mjs`、`http-longpoll.test.mjs`、`agent-gateway.test.mjs`、`loop-engine.test.mjs` 等）与内存总线 `tests/mocks/`。不连真实外部服务，状态只写临时目录。

## 命令

```sh
# 语法检查（Node >= 24，零外部依赖，无需 npm install）
for f in bin/*.mjs src/*.mjs src/*/*.mjs schema/*.mjs; do node --check "$f" || exit 1; done
npm test
node bin/ah.mjs setup --role hub --bus sqlite --node mac-mini-hub --listen 0.0.0.0:8787 --yes --config <dir>
node bin/ah.mjs doctor --config <dir> [--role node|hub]
node bin/ah.mjs daemon --config <dir> [--role node|hub]
node bin/ah.mjs loop templates
node bin/ah.mjs loop create --config <dir> --title "..." --goal "..." --to <node>
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

- 不要提交 `app.env`、`.a2a-hub/`、`hub.db`、`hub.db-wal`、`hub.db-shm`、`hub_runtime.json`、`approval_key.pem`、`*_state.json`、`schedules.json`、`retry_state.json`、`runs/`，以及任何真实 API Token 或 Webhook 地址。
- 不要修改或删除 `Messages` / `Parts` 行，不要重开终态任务，不要给 `Tasks` 加参数列。
- 不要让守护进程因启动期或单轮错误退出，不要吞掉错误后假装成功。
- 未经要求不要提交、推送或发版。
