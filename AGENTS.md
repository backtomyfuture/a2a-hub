# AGENTS.md — a2a-hub v2.0

a2a-hub：自托管个人版多 Agent 编排中台（基于 A2A 八态数据模型，统一采用关系型 SQLite WAL + 单 HTTP 网关 + 零构建 ESM Web 控制台，支持云端调度者 `Leader` 并发扇出、`Context_ID` 跨任务多轮上下文续接、电脑端本地 CLI 并发执行池与 Ed25519 审批签名）。
本仓库只有 Node >= 24 ESM 实现且**零外部 npm 运行时依赖**（`dependencies: {}`）：`ah`（主入口）、`a2a-hub` 与 `ahub` 同时承载 `hub`（完整中台 + 可选本机执行池）、`device`（远程电脑挂载节点）与 `agent`（独立长连接 Agent）三种模式，配置目录取 `--config <dir>` > `AH_HOME` > `~/.a2a-hub`。

## 目录与职责

- `bin/ah.mjs`：CLI 分发 `up | join | setup | daemon | expose | service | doctor | update | agents | task | present | inbox`（自动检测代理并重拉起 `NODE_USE_ENV_PROXY=1`，维护 `daemon.lock`）。
- `src/store/db.mjs`：`HubStore`（基于内置 `node:sqlite` `DatabaseSync` + WAL + `BEGIN IMMEDIATE` 单事务提交 + 后置变更钩子），统一持久化 `meta`、`devices`、`agents`、`tasks`、`messages`、`schedules`、`idempotency`、`watermarks`、`files`。
- `src/store/files.mjs`：`FileStore` 与 `FileRetentionService`，共享 `hub.db` `files` 表并在 `<configDir>/files/blobs` 落地中转文件。
- `src/core/config.mjs`：加载 `config.json`、`workers.json`、`app.env`；自动发现本机 `claude` / `codex` / `opencode` / `gemini` / `aider` / `goose` CLI 与默认模型；强制校验 `EXEC_CONTROL_KEYS`。
- `src/core/broker.mjs`：`LongPollBroker`，维护单调序号事件流（Hold 上限 `MAX_LONGPOLL_SEC = 40` 防云网关断连）及活跃窗口在线判定。
- `src/core/task-service.mjs`：唯一权威 A2A 八态状态机引擎（`submitted`, `working`, `input-required`, `auth-required`, `completed`, `failed`, `canceled`, `rejected`），支撑 `to: [...]` 多节点扇出、`context_id` 前情汇集、可重试故障重试、陈旧任务回收（`STALE_MIN=20`）与 Leader 水位增量消费。
- `src/core/approval-sign.mjs`：Ed25519 审批签名与验签（私钥存于 `<configDir>/approval_key.pem`）。
- `src/core/templates.mjs`：8 类平台模板目录（`agent_templates.json`）及一键接入提示词/设备挂载命令生成器。
- `src/core/webhooks.mjs` / `src/core/notifier.mjs` / `src/core/schedules.mjs`：HMAC-SHA256 签名 Webhook 门铃（`redirect: "manual"` 防 SSRF 重定向）、飞书/Bark/Telegram/通用 Webhook 机主实时推送、定时任务自报观测。
- `src/core/receipt.mjs` / `src/core/session-store.mjs` / `src/core/proc.mjs`：CLI 命令安全渲染、`stdout` JSON/JSONL 解析与 `(context_id, worker_key)` 会话续接。
- `src/core/hub-runtime.mjs`：单进程拉起 Hub（SQLite + HTTP 网关 + 本机 `DeviceDaemon`）。
- `src/server/auth.mjs` / `src/server/http-server.mjs`：机主口令 / `HttpOnly` Cookie 会话 / 设备 Token / Agent Token 分级鉴权与防冒充路由守卫，暴露全套 `/api/v1/*` 接口与托管 `src/web/` 控制台。
- `src/client/`：`GatewayClient`、`DeviceDaemon`（支持 `maxConcurrent` 真并发池 + 同 `(context_id, worker_key)` 串行锁）、`AgentDaemon` 与 `inbox`/`present` CLI 实现。
- `src/cli/`：`setup.mjs`、`doctor.mjs`、`expose.mjs`（Tailscale Funnel 与 Cloudflare WAF Bot 探针）、`service.mjs`（macOS LaunchAgent / Linux systemd + `--ensure` / Windows schtasks）、`update.mjs`。
- `src/web/`：零构建原生 HTML + CSS + Browser ESM Web 控制台（`待办概览`、`Agent 与设备` 3 秒可读卡片与详情抽屉、2 入口新增向导、多 Agent 扇出派单、`对话线程`、`设置与定时`）。
- `skills/`：2×2 四类 Skill（`ah`、`ah-inbox`、`a2a-leader`、`a2a-worker`）与轻量检查脚本 `skills/a2a-check/*`。
- `tests/`：内置 `node:test` 测试集。

## 命令

```sh
for f in bin/*.mjs src/*.mjs src/*/*.mjs; do node --check "$f" || exit 1; done
npm test
```

## 安全与开发约定

- **Node >= 24 ESM，零外部依赖**，注释使用简洁中文说明「为什么」。
- **指令与数据分离**：本地可执行的 `command`、`cwd`、`approval_policy` 仅读本地 `workers.json`；任何任务请求参数出现 `EXEC_CONTROL_KEYS` 直接拒收（HTTP 400）。
- **审批签名边界**：`auth-required` 仅机主（`owner`）可通过 `/api/v1/approvals/:taskId/decide` 使用 Hub 私钥签名放行；远端设备执行前必须用 `hubPublicKey` 验签。
- **不提交隐私状态**：禁止提交 `.a2a-hub/`、`app.env`、`config.json`、`workers.json`、`hub.db*`、`approval_key.pem`、`runs/`、`sessions/` 与任何真实令牌。
- 未经要求不要提交、推送或发版。
