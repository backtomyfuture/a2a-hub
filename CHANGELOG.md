# Changelog

本项目的主要变更记录如下。节点与中台版本号见 `package.json` / `ah --version`；中台规范见 [docs/standard.md](docs/standard.md)。

## [Unreleased]

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
