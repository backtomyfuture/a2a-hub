# AGENTS.md — lobe-a2a-hub

lobe-a2a-hub：自托管独立多 Agent 编排中台（基于 A2A 八态数据模型，从 `lark-a2a-hub` 演进迁移而来，默认采用 SQLite WAL + 出站 HTTP 长轮询总线，内置 LobeHub 风格 Web 控制台与 LoopForge 多阶段 SOP 闭环引擎，并保留对飞书多维表格总线的向下兼容）。
本仓库只有 Node >= 24 ESM 实现且**零外部 npm 运行时依赖**（`dependencies: {}`）：`lah`（主入口）、`lobe-hub` 与 `hub-node`（兼容别名）同时承载 `node` 与 `hub` 两个逻辑角色。
方向（标准 §10）：`hub` 角色是 `node` 角色的单进程超集；由 `lah daemon --role node|hub` 承载。省略 `--role` 时读配置目录 `node.json` 的 `role`，缺省 `node`。独立中台模式下，`role=hub` 单进程同时运行本地工作内核（按 `commands.json` 接单）、`SqliteBus`（`node:sqlite`）、`startHubHttpServer`（REST API + `LongPollBroker` + Web 控制台）、`ApprovalService`（ed25519 签名）、`PresentService`、`StaleService`、`ScheduleService`、`LoopService` 与 `ExternalNotifier`。

## 目录与职责

- `bin/lah.mjs` / `bin/hub-node.mjs`：CLI 分发 `setup | daemon | reconcile | doctor | inventory | service | task (create|reply|show|why|cancel|begin) | schedule (ls|add|rm|enable|disable|register) | loop (create|ls|show|cancel|templates) | present | inbox | update`（支持 `--role node|hub`；省略时 daemon / doctor / service 读 `node.json` 的 role，缺省 node）；配置目录取 `--config <dir>` > `HUB_NODE_HOME` > `~/.hub-node`（内含 `node.json` 与 `commands.json`）。
- `src/bus/tables.mjs`：统一逻辑表名映射 `DEFAULT_TABLES`（`tasks`, `messages`, `parts`, `runs`, `artifacts`, `agentCards`, `rules`, `loops`），供 SQLite / HTTP / Mock 总线共享。
- `src/bus/sqlite-bus.mjs`：`SqliteBus`（Node 内置 `node:sqlite` `DatabaseSync` + WAL 模式），支撑独立中台持久化存储、`client_token` 幂等去重、卡片记录管理与变更序号通知 `LongPollBroker`。
- `src/bus/http-bus.mjs`：`HttpBus`（基于原生 `fetch` 的远端总线客户端），远端节点通过 Bearer Token + HTTP REST 读写中台表，并经 `/api/v1/poll` 长轮询接收唤醒。
- `src/bus/feishu.mjs` / `src/bus/feishu-events.mjs`：`FeishuBus` 与飞书长连接订阅（当 `busType: "feishu"` 时保留向下兼容，不引入第三方 SDK 时通过全局 `fetch` 调用）。
- `src/server/longpoll-broker.mjs`：`LongPollBroker`，维护全网单调递增 `seq` 与挂起 HTTP 长轮询连接（`GET /api/v1/poll`），写操作发生后毫秒级唤醒目标节点。
- `src/server/http-server.mjs`：`startHubHttpServer`，暴露独立 Hub HTTP 网关：`/`（Web 控制台）、`/api/v1/health`（免鉴权健康探针）、`/api/v1/state`、`/api/v1/poll`、`/api/v1/tables/*`、`/api/v1/tasks*`、`/api/v1/approvals/:taskId/decide`、`/api/v1/loops*`；监听地址由 `cfg.listen`（默认 `0.0.0.0:8787`）控制并支持 Bearer Token 鉴权（`LAH_API_TOKEN` / `cfg.apiToken`）。
- `src/server/web-ui.mjs`：`renderWebConsoleHtml()`，零构建依赖内嵌 LobeHub + LoopForge 风格 Web 控制台（总览拓扑、Agent Hub 名片、A2A 任务详情与在线签名审批/答复、SOP Loop 编排室）。
- `src/hub/loop.mjs`：`LoopService`、`BUILTIN_LOOP_TEMPLATES`（含 `plan-code-verify`）、`createLoop`、`cancelLoop`；LoopForge 风格多阶段闭环状态机，在同一个 `Context_ID` 下推进阶段任务并结合 `acceptance.mjs` 验收结论触发 `retry` / `goto:<stage_id>` / `abort`，受 `Max_Iterations` 与 `HOP_LIMIT=8` 限制。
- `src/loop-cli.mjs`：`lah loop (create|ls|show|cancel|templates)` CLI 实现。
- `src/hub/notifier.mjs`：`ExternalNotifier`，可选外部通知器（飞书普通群机器人 Webhook / Bark / Telegram / 通用 Webhook），按事件去重并附带控制台深链。
- `src/kernel.mjs`：状态机骨架（构造、`sweepOnce`/`run` 主循环与状态迁移），唯一写任务状态的节点代码。辅助拆在 `receipt.mjs`、`retry-state.mjs`、`session-store.mjs`、`config.mjs`、`kernel-util.mjs`，以及原型混入的 `kernel-direct.mjs`、`kernel-approval.mjs`、`kernel-outbox.mjs`、`kernel-metadata.mjs`。常量 `DAEMON_VERSION`、`HOP_LIMIT=8`、`MAX_RETRIES=2`、`STALE_MIN=20`、`HEARTBEAT_MIN_SEC=90` 留在本文件。
- `src/config.mjs`：节点配置加载（自动识别 `busType`: `sqlite` / `http` / `feishu`）、监听地址解析、能力表归一（`normalizeCommands` / `resolveCapKey` / `capIdOf`）。
- `src/acceptance.mjs`：验收层纯函数（标准 §11）：清单校验、自检归一、逐条判定、overall、回执 DataPart 与 Metadata 索引。
- `src/approval-sign.mjs`：审批决定的 ed25519 签名与验签；hub 私钥在其配置目录 `approval_key.pem`，节点按 `node.json` 的 `hubPublicKey` 验。
- `src/transport/`：唤醒工厂（`createWaker`），支持 `longpoll`（`src/transport/longpoll.mjs`，默认于独立中台 `http` 与 `sqlite` 节点）、`ws` 与 `poll`，外加 15 分钟对账定时兜底及 `PENDING_RECHECK` 挂起短复查。
- `src/setup.mjs` / `src/doctor.mjs` / `src/service.mjs` / `src/inventory.mjs` / `src/update.mjs`：支持独立 `sqlite` Hub、远端 `http` 节点与 `feishu` 节点的向导、只读自检、用户级自启注册、名片盘点与程序更新。
- `src/hub/`：`hub` 角色组件（`approval.mjs`、`present.mjs`、`stale.mjs`、`schedule.mjs`、`loop.mjs`、`notifier.mjs`、`create.mjs`、`cancel.mjs`、`cards.mjs`、`owner.mjs`、`index.mjs`）。
- `docs/standard.md`：**中台标准，权威**。`docs/base-schema.md` 与 `schema/base-schema.json` 是生成物，由 `schema/generate_schema.mjs` 产出。
- `docs/configuration.md`：配置目录、`node.json` / `commands.json` / `schedules.json`、独立中台与 LoopForge SOP 配置及 CLI 速查。
- `config/*.example.json`：配置样例（`hub.standalone.example.json`、`node.remote.example.json`、`commands.example.json`、`schedules.example.json`、`node.example.json`），只放占位符。
- `tests/`：`node:test` 测试（`tests/*.test.mjs`，含 `sqlite-bus.test.mjs`、`http-longpoll.test.mjs`、`loop-engine.test.mjs` 等）与内存总线 `tests/mocks/`。不连真实外部服务，状态只写临时目录。

## 命令

```sh
# 语法检查（Node >= 24，零外部依赖，无需 npm install）
for f in bin/*.mjs src/*.mjs src/*/*.mjs schema/*.mjs; do node --check "$f" || exit 1; done
npm test
node bin/lah.mjs setup --role hub --bus sqlite --node mac-mini-hub --listen 0.0.0.0:8787 --yes --config <dir>
node bin/lah.mjs doctor --config <dir> [--role node|hub]
node bin/lah.mjs daemon --config <dir> [--role node|hub]
node bin/lah.mjs loop templates
node bin/lah.mjs loop create --config <dir> --title "..." --goal "..." --to <node>
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

- 不要提交 `app.env`、`.hub-node/`、`hub.db`、`hub.db-wal`、`hub.db-shm`、`hub_runtime.json`、`approval_key.pem`、`*_state.json`、`schedules.json`、`retry_state.json`、`runs/`，以及任何真实 API Token、Webhook 地址、Base token 或 open_id。
- 不要修改或删除 `Messages` / `Parts` 行，不要重开终态任务，不要给 `Tasks` 加参数列。
- 不要让守护进程因启动期或单轮错误退出，不要吞掉错误后假装成功。
- 未经要求不要提交、推送或发版。
