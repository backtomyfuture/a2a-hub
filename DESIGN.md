# a2a-hub 系统设计

- 状态：现行（v1.0.0）。系统级规范见 [docs/standard.md](docs/standard.md)，架构决策见 [docs/architecture.md](docs/architecture.md)，配置与 CLI 参考见 [docs/configuration.md](docs/configuration.md)。

## 1. 定位

`a2a-hub` 是一个**自托管、零外部运行时依赖的独立多 Agent 编排中台**（Node >= 24 ESM）。一台常驻主机（如 Mac mini 或 Linux 服务器）作为中台 Hub，集中托管 SQLite WAL 总线、HTTP 网关、长轮询事件代理、内置 Web 控制台与 LoopForge SOP 闭环引擎，将本机 CLI Agent、远端电脑节点以及无常驻守护进程的纯 HTTP 云端 Agent 组织为统一的可审计协作网络。

## 2. 设计原则

- **零依赖**：`package.json` 的 `dependencies` 为空，全部能力基于 Node >= 24 内置模块实现（`node:sqlite`、`node:http`、全局 `fetch`、`node:crypto`、`node:test`），安装即跑、无第三方构建链路。
- **薄内核**：`src/kernel.mjs` 只承载 A2A 协议状态机与调度循环（认领、心跳、派发、收回执、重试退避、熔断、对账），不内嵌任何具体 Agent 或业务执行器；能力完全由节点本地 `commands.json` 声明。
- **失败要响**：能力未登记、点名 Worker 不存在、配置语法或字段取值非法、参数夹带执行控制键、L1 验收失败或审批验签未通过，一律明确拒收或报错并留痕，绝不静默降级或伪装成功。
- **节点只出不进**：边缘执行节点与纯 HTTP Agent 只向 Hub 发起出站 HTTP 请求，不开设任何入站监听端口、不做端口映射或反向隧道；仅 Hub 进程按 `listen` 配置对外提供 HTTP 服务。除 `/api/v1/health`、控制台首页与 `/.well-known/agent.json` 外，`/api/*`（含 `/api/v1/skills*`）一律要 Bearer Token：机主 `apiToken`（`AH_API_TOKEN`）为 owner 全权限，外部 HTTP Agent 用机主在控制台签发的分 Agent Token（见 §8）。
- **指令与数据分离**：可执行命令、`cwd`、`verify` 与 `approval_class` 下限只来自执行节点本地可信的 `commands.json`；来自总线的指令正文、参数与问答上下文只作为数据写入 `0600` 权限的 `runs/<Task_ID>/input.json`（或经 `json` 模式标准输入传入），请求参数中携带执行控制键的任务直接拒收。

## 3. 总体形态

- **单进程 `hub` 超集 `node`（标准 §10.1）**：中台只有 `node` 与 `hub` 两个逻辑角色，`hub` 是 `node` 的单进程超集，均由 `ah daemon --role node|hub` 承载；省略 `--role` 时读取配置目录 `node.json` 的 `role`（缺省 `node`）。
- **`role=hub` 单进程运行态**：同一进程与同一配置目录（默认 `~/.a2a-hub`）内同时运行：
  1. **本地工作内核（`Kernel`）**：按 `commands.json` 登记能力名片并认领执行指向本节点的任务；
  2. **SQLite WAL 总线（`SqliteBus`）**：持久化存储全部 8 张逻辑表与卡片/幂等元数据；
  3. **统一 HTTP 网关（`startHubHttpServer`）**：暴露 REST API、`LongPollBroker`、面向外部 Agent 的 `agent-gateway` 以及零构建内嵌 Web 控制台（`src/server/web-ui.mjs`）；
  4. **Hub 治理服务**：`ApprovalService`（ed25519 审批签名）、`PresentService`（结果呈递队列）、`StaleService`（陈旧告警与回收）、`ScheduleService`（`later` 预约复查）、`LoopService`（多阶段 SOP 闭环）与可选 `ExternalNotifier`。
- **一键部署与用户级自启**：提供 `install.sh` / `install.ps1`、`ah up` / `ah join` 与 `ah service`，自动注册用户级守护服务（macOS LaunchAgent `ah-<role>.<node>`、Linux systemd `ah-<role>-<node>.service`、Windows 任务计划 `ah-<role>-<node>`；非默认配置目录追加配置路径 SHA-256 前 8 位摘要）。

## 4. SQLite WAL 总线与 HTTP 网关 / 长轮询门铃

- **SQLite WAL 总线（`src/bus/sqlite-bus.mjs`）**：基于 `node:sqlite` `DatabaseSync`（开启 `PRAGMA journal_mode = WAL` 与 `busy_timeout = 5000`），承载 `tasks`、`messages`、`parts`、`runs`、`artifacts`、`agentCards`、`rules`、`loops` 八张逻辑表及 `idempotency_tokens`、`cards`、`meta` 内部表。每次写入提交后推进单调递增 `seq` 游标并通知 `LongPollBroker` 与 `ExternalNotifier`。
- **HTTP 客户端总线（`src/bus/http-bus.mjs`）**：远端宿主节点配置 `busType: "http"` 与 `hubUrl`，通过 Bearer Token + REST API（`/api/v1/tables/:table/records`）读写中台数据，在 HTTP 429/5xx 或瞬时网络异常时指数退避重试（`0/1/3/8` 秒）。
- **长轮询门铃（`src/server/longpoll-broker.mjs` + `src/transport/`）**：
  - 每次写入只传递变更通知与 `seq` 游标，具体数据一律回表或经网关拉取，断线与重启不丢状态；
  - 远端宿主节点经出站 `GET /api/v1/poll?node=<node>&cursor=<seq>&timeout=25` 挂起等待，写入提交后毫秒级唤醒；Hub 进程内通过 `subscribeLocal` 零网络开销直连唤醒；无法长轮询时降级为 `poll` 定时扫表（默认 `pollSec=45`）；
  - 客户端游标落出环形缓冲时返回 `resync` 触发全量对账；所有守护进程保留低频对账扫表兜底（默认 `sweepSec=900`）以及面向 `input-required` / `auth-required` 的挂起短复查（`PENDING_RECHECK`：前 10 分钟不超 60 秒，60 分钟内不超 180 秒）。
- **外部 Agent 网关（`src/server/agent-gateway.mjs`）**：为无守护进程、无 `ah` CLI 的纯 HTTP Agent 提供自发现（`GET /.well-known/agent.json`）、Skill 拉取（`GET /api/v1/skills/:name`，需鉴权）、注册（`POST /api/v1/agents/register`）、短/长轮询取单（`GET|POST /api/v1/agents/:node/poll`）、Leader 状态追踪（`GET /api/v1/agents/:node/updates`，`new=1` 由 Hub 为该 Leader 持久化水位、只返回新变化的终态任务与全部仍待处理的 `input-required` / `auth-required`，`since=<seq>` 可显式指定，每条带 `changed_seq`、响应带 `watermark`）及生命周期操作（`POST /api/v1/tasks/:id/{claim,heartbeat,ask,auth,complete,fail}`）。名片接纳、添加 Agent 与 Token 管理不在该网关，而在 `startHubHttpServer` 的 `/api/v1/admin/*`，状态归一与接入提示词在 `src/hub/admission.mjs`。
- **名册卫生**：无名片且 30 分钟无活动的内存在线记录不进名册（纯 Leader 没有名片，停更超过 30 分钟也会从名册消失）。内存里的在线记录超过 24 小时无活动即清除，名片仍留在表里。`role=hub` 且名片 `Node` 等于本机节点名时，空的 `Admission` 在对账时补成 `admitted`（已有值，含显式 `pending` / `rejected`，不覆盖）；远端节点与外部 Agent 自行 `register` 的名片仍须机主接纳。

## 5. 三种接入形态

| 接入形态 | 适用场景 | 唤醒与执行方式 | 纪律约束 |
|---|---|---|---|
| **宿主守护进程型**（`kind: host`） | 办公电脑、Mac mini、Linux 工作站、GPU 服务器 | `ah daemon` 出站长轮询（`/api/v1/poll`），按 `commands.json` 拉起本机 CLI/脚本 | 守护内核强制租约、心跳、单并发账本、退避与验收 |
| **本地独立 Agent 型**（`kind: agent`） | 同机常驻但自主消费任务的独立 Agent | `ah daemon` 认领后写入 `0600` `agent_inbox.jsonl` 并持续续心跳；本尊调 `ah inbox` 取单/交付 | 内核维护租约与 `inbox_timeout_sec`，`inbox` 出站计划保证防重与终态守卫 |
| **纯 HTTP 外部 Agent** | 云端或由外部 cron/tick 驱动的 Leader / Worker | 凭分 Agent Token 调 `agent-gateway`（`/agents/:node/poll` 或 `/updates`）；接入提示词为「定时运行版」：Worker 每 10 分钟、Leader 每 15 分钟被唤醒，每次无上下文，Worker 须在同一次运行内完成所认领任务 | `agent-gateway` 在网关侧执行目标匹配、静态/动态审批门与状态守卫 |

## 6. executor × context 抽象

本机执行能力收敛为两个配置维度（`src/config.mjs`、`src/kernel-direct.mjs`、`src/inbox.mjs`）：

- **执行模式（`mode`，即 executor 的交互形态）**：
  - `agent`（默认）：基于 `{prompt}` 模板拉起本机 Agent CLI，任务原文与参数写入 `runs/<Task_ID>/input.json`，通过结构化围栏（`` ```agent-ask ```` / ```` ```agent-auth ````）与围栏外整行指令解析回执；
  - `json`：确定性脚本或结构化工具，从 `stdin` 读取任务信封 JSON，从 `stdout` 最后一个非空行读取 JSON 回执；
  - `inbox`：仅用于独立 Agent 节点（`kind: agent`），守护进程认领后写入 `agent_inbox.jsonl` 并保持心跳，不起子进程，由 Agent 本尊通过 `ah inbox (done|ask|fail|auth)` 完成交付与续跑。
- **执行语境（`context`）**：
  - 现行唯一合法值为 `direct`（默认值，可省略）：守护进程直接以独立进程组（`src/proc.mjs` / `src/direct-ledger.mjs`）拉起命令，并将 `pid`、进程启动时间戳、`run_id`、stdout/stderr/exit 文件路径原子写入 `runs/<Task_ID>/entry.json`（0600）。
  - 同一节点同一时刻只允许一条 `direct` 在途命令，守护进程重启后依据账本判断进程组存活与退出码实现断点续接（不二次重跑副作用命令），超时向进程组先发 `SIGTERM` 再 `SIGKILL`。配置中出现非法 `context` 取值时认领预检直接 `rejected`。

## 7. 能力模型与回执约定

详细语法与判定口径以 [docs/standard.md](docs/standard.md) §6、§9、§11 为准：

- **三层寻址（`Node → Worker → Skill`）**：`commands.json` 保留键 `workers` 定义本机 Agent 启动模板；每个 Worker 自动在 `AgentCards` 登记一张 `Skill_ID=agent` 的 Worker 名片（`CAP-<capPrefix>-<worker>-agent`）；专长技能通过 `workers: [...]` 绑定至指定 Worker（`CAP-<capPrefix>-<worker>-<skill>`）；自带 `command` 的条目由节点本尊直接执行（`Worker` 列为空）。
- **能力热重载**：守护进程按文件 `mtime` 与内容哈希检测 `commands.json` 变更并串行对账 `AgentCards`；文件解析损坏时保留上一版能力表并暂停认领新单，修复后自动恢复。
- **结构化回执与两层验收（标准 §11）**：
  - 除正文与产物指针（`Artifacts` + `FilePart`）外，回执可附带 `USAGE:`（累计至 `Tasks.Metadata.usage`）、`SESSION:`（仅存本机 `runs/<Task_ID>/session.json` 用于问答/审批续跑 `resume_command`）与 `LATER:`（写入 `Tasks.Metadata.later`，由 Hub `ScheduleService` 到点派生复查任务）；
  - **L1 执行式验收（`verify`）**：针对 `context=direct` 的 `json` / `agent` 任务，主命令成功且解析为完成回执后，在 `entry.json` 的 `state=verifying` 阶段执行只读 `verify` 命令（通过 stdin JSON 与 `AH_TASK_ID` / `AH_ARTIFACT` / `AH_RUN_DIR` / `AH_MAIN_STDOUT` 传入上下文），失败、超时或错误一律置 `failed` 且不计重试；
  - **L2 声明式验收（`acceptance.criteria`）**：建单时冻结在首条 `instruction` 的 `DataPart`，执行方自检输出 `CHECK:` 行 / `checks` 对象 / `ah inbox done --check`，统一汇总写入回执消息 Seq 2 的 `DataPart` 并索引至 `Tasks.Metadata.acceptance`。

## 8. 安全纪律

- **控制键拦截**：`EXEC_CONTROL_KEYS`（`command`、`cmd`、`cwd`、`context`、`agent`、`worker`、`mode`、`side_effect`、`approval_class`、`permissions`、`shell`、`env`、`executable`、`argv`、`bin`、`max_timeout_sec`、`verify`、`verify_timeout_sec`）出现在任务参数中时，建单端与执行节点一律拒收；唯一可由任务参数覆盖的执行控制键为 `timeout_sec`（且受节点本地 `max_timeout_sec` 夹紧）。
- **审批下限与 ed25519 签名**：认领前静态审批下限取「任务行 `Approval_Class`、本地 Worker 下限、本地 Skill 下限」中最严者；执行中可由 `agent-auth` / `need_auth` / `ah inbox auth` / 网关 `/auth` 触发动态审批。Hub 使用配置目录 `0600` 私钥 `approval_key.pem` 为 `auth_decision` 签名，配了 `hubPublicKey` 的节点与网关严格验签。
- **分 Agent Token（`src/hub/agent-tokens.mjs` + `src/hub/agent-access.mjs`）**：机主 `apiToken` 即 owner，权限不变。每个外部 HTTP Agent 由机主在控制台（`POST /api/v1/admin/agents`，`access=http`）签发独立 Token，绑定 `{node, role, scopes}`，`<configDir>/agent_tokens.json`（0600）只存 sha256 哈希与展示前缀，明文只在签发/轮换响应出现一次；可 `rotate` 重新生成、`DELETE` 吊销。控制台添加时 `scopes` 为空，`admin` 要在轮换 body 里写入。未配置机主 `apiToken` 时拒绝签发（否则鉴权一开机主自己会被挡在外）。`hybrid` 同时具备两边权限。`worker` 只能 register / poll / inbox / 任务生命周期（claim、heartbeat、complete、fail、ask、auth）；`leader` 可派单，查看自己发起或指向自己的任务，答复和撤销仅限自己发起的任务，loops 的列表与取消也仅限自己发起的，并用 updates；scopes 含 `admin` 的 leader 另可接纳名片（单卡或整节点）、改显示名、为别的节点生成接入提示词；任何 Agent 身份都不能访问 `/approvals/*`、`/admin/agents`、`/admin/tokens*`、`/state`、`/tables/*`、`/poll`。路径节点、查询参数 `node`/`from`、请求头 `X-A2A-Node` 与绑定节点不一致返回 403；body 里省略 `node`/`from` 则补成绑定节点。`GET /api/v1/admin/onboarding` 的 `node` 是操作对象，不按冒充拒绝。
- **熔断与防重跑**：派生任务 `Hop_Count` 累加不清零，超过 `HOP_LIMIT = 8` 熔断；执行失败与心跳超时（`STALE_MIN = 20`）共享 `MAX_RETRIES = 2` 预算，退避水位记在 `retry_state.json`（60 秒起翻倍至 10 分钟）；节点写表先落 `outbox/`（或 `inbox-outbox/`），失败只补缺不重跑命令；Hub 宽限 30 分钟仍无心跳则由 `StaleService` 置 `failed` 回收。

## 9. LoopForge SOP 闭环引擎

`src/hub/loop.mjs` 在 A2A 原生会话（`Context_ID`）与任务派生链（`Ref_Task_IDs`）之上实现了多阶段闭环编排：

- **数据面**：`loops` 表记录阶段定义（`Stages`）、当前阶段索引（`Stage_Index`）、当前迭代计数（`Iteration` / `Max_Iterations`）、活跃子任务（`Active_Task_ID`）与阶段流转历史（`History`）。
- **内置模板与自定义编排**：内置 `plan-code-verify`、`write-review-refine`、`audit-fix-verify` 三套模板，并支持通过 `ah loop create` 或 Web 控制台传入自定义 `stages` 与逐阶段 `stageBindings`（`to` / `worker` / `cap`）。
- **验收驱动回跳**：每阶段子任务进入终态后，`LoopService` 结合任务状态与 `acceptanceForTask` 判定结果决定推进下一阶段或按阶段的 `on_fail` 策略执行 `retry`、`goto:<stage_id>` 或 `abort`，将失败原因与验收证据注入下一跳 `{{failure_feedback_block}}`；全链路受 `Max_Iterations` 与 `HOP_LIMIT = 8` 双重熔断约束。

## 10. 仓库结构

```text
a2a-hub/
  bin/
    ah.mjs                      # CLI 主入口（支持 setup / up / join / daemon / reconcile / doctor /
                                #   inventory / service / task / schedule / loop / present / inbox / update）
  src/
    kernel.mjs                  # 状态机骨架（Sweep 主循环、能力对账、认领与状态迁移）
    kernel-direct.mjs           # direct 在途命令与 L1 verify 编排（原型混入）
    kernel-approval.mjs         # 认领前静态门与动态审批续跑（原型混入）
    kernel-outbox.mjs           # 回执 outbox 幂等提交（原型混入）
    kernel-metadata.mjs         # usage / later / acceptance Metadata 合并写（原型混入）
    kernel-util.mjs             # 日志、时间格式、脱敏与终态常量
    config.mjs                  # 配置加载（sqlite / http）、控制键校验、能力表归一（Node/Worker/Skill）
    acceptance.mjs              # 验收层纯函数（标准 §11：清单校验、自检归一、overall 判定）
    approval-sign.mjs           # ed25519 审批决策签名与验签
    direct-ledger.mjs           # direct 在途执行账本（runs/<Task_ID>/entry.json）
    proc.mjs                    # 独立进程组拉起、超时 SIGTERM/SIGKILL、输出头尾截断
    receipt.mjs                 # agent / json 回执解析、later 时区校验与命令占位替换
    retry-state.mjs             # retry_state.json 指数退避水位
    session-store.mjs           # runs/<Task_ID>/session.json 读写
    inbox.mjs                   # kind=agent 收件箱（agent_inbox.jsonl）与 ah inbox CLI
    present-queue.mjs           # present_queue.jsonl 锁互斥读写
    local-schedule.mjs          # 节点本地定时调度（schedules.json）
    schedule-cron.mjs           # cron 表达式与时区期次键纯函数
    schedule-mirror.mjs         # 本机计划向 Rules 表的只读观察镜像
    schedule-cli.mjs            # ah schedule 与 ah task begin CLI
    loop-cli.mjs                # ah loop CLI
    setup.mjs                   # 交互/非交互初始化向导（up / join / setup）与本地 Skill 安装
    doctor.mjs                  # 只读自检
    service.mjs                 # launchd / systemd / Windows 任务计划用户级自启托管
    inventory.mjs               # 只读名片与任务盘点
    update.mjs                  # git 检出自更新
    why.mjs                     # ah task why 只读时间线与排障诊断
    bus/
      tables.mjs                # 8 张逻辑表名映射与字段读取工具
      sqlite-bus.mjs            # Node 内置 node:sqlite WAL 总线
      http-bus.mjs              # 远端节点 HTTP REST 总线客户端
    server/
      http-server.mjs           # Hub HTTP 网关主服务（REST API、owner/agent 双身份鉴权、hub_runtime.json、/api/v1/admin/*）
      longpoll-broker.mjs       # 单调 seq 事件代理与长轮询连接管理
      agent-gateway.mjs         # 纯 HTTP 外部 Agent A2A 网关
      web-ui.mjs                # 零构建内嵌机主视角 Web 控制台
    hub/
      index.mjs                 # hub 角色主运行时与 hubDoctor
      approval.mjs              # ApprovalService（审批登记、ed25519 签名写入与状态流转）
      present.mjs               # PresentService（原路结果呈递与基线水位）
      stale.mjs                 # StaleService（陈旧告警与宽限回收）
      schedule.mjs              # ScheduleService（later 预约复查时钟）
      loop.mjs                  # LoopService（LoopForge 多阶段 SOP 闭环引擎）
      notifier.mjs              # ExternalNotifier（可选外部 Webhook / Bark / Telegram 通知）
      admission.mjs             # 名片接纳归一化、管理参数校验与定时运行版接入提示词（/api/v1/admin/*）
      agent-tokens.mjs          # AgentTokenStore（agent_tokens.json 哈希存储、签发/轮换/吊销/验证）
      agent-access.mjs          # Agent Token 路由矩阵、node/from 身份绑定与任务可见性
      create.mjs                # 建单（参数校验、名册校验、先消息后任务行）
      cancel.mjs                # 任务取消（发起方 / hub）
      cards.mjs                 # 消息正文提取与审批交互载荷构建
      owner.mjs                 # 机主标识解析
    transport/
      index.mjs                 # 唤醒工厂 createWaker（longpoll / poll）
      longpoll.mjs              # HTTP 长轮询与本地 Broker 唤醒器
      poll.mjs                  # 定时轮询唤醒器
    executors/
      echo.mjs                  # 示例 json 模式执行器
  skills/                       # 2×2 四类 Skill（ah / ah-inbox / a2a-leader / a2a-worker）
  config/                       # 占位符配置样例
  docs/                         # 中台标准、架构、配置、外部 HTTP Agent 手册与 SVG 图
  schema/                       # 表结构快照与生成脚本
  tests/                        # node:test 测试套件与内存 Mock 总线
  install.sh / install.ps1      # 一行安装脚本
  DESIGN.md
  README.md / README.en.md
```
