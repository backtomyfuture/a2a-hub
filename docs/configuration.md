# 配置与命令参考

本文承接 [README](../README.md) 里放不下的细节：配置目录、`node.json` / `commands.json`、机器类型、CLI 速查、本机状态文件。
规范性约定以 [中台标准](standard.md) 为准，这里只讲怎么配、怎么用。

## 1. 配置目录

配置目录取 `--config <dir>` > 环境变量 `AH_HOME` > `~/.a2a-hub`（Windows 为 `%USERPROFILE%\.a2a-hub`），程序本体默认安装于 `~/.a2a-hub/app/`。里面有：

| 文件 | 作用 | 能否提交仓库 |
|---|---|---|
| `node.json` | 节点身份、总线参数（`sqlite` / `http`）、长轮询与对账周期、角色 | 否 |
| `commands.json` | 能力表：本机能干什么、怎么干 | 否 |
| `schedules.json` | 定时调度表：本机定时任务计划（`id`, `cron`, `cap`, `text` 等） | 否 |
| `agent_templates.json` | HTTP 节点模板目录：内置四条和后加的模板都在这一份里（0600） | 否 |
| `app.env` | 机主 HTTP Bearer 口令 `AH_API_TOKEN`（owner），权限 600 | 绝不 |
| `agent_tokens.json` | 分 Agent Token 账本（0600，version 1，只存 sha256 与展示前缀，无明文） | 绝不 |
| `agent_webhooks.json` | HTTP Agent 门铃（0600，`version: 1`，`hooks[]` 含 URL 与 HMAC `secret` 明文；列表接口不返回 secret） | 绝不 |
| `approval_key.pem` | `role=hub` 的 ed25519 审批签名私钥，权限 600 | 绝不 |
| `hub.db` / `hub.db-wal` / `hub.db-shm` | `role=hub` SQLite WAL 主数据库文件 | 绝不 |
| `runs/<Task_ID>/` | 每次执行的输入、输出与在途账本（`entry.json`） | 否 |
| `retry_state.json` `approval_state.json` `present_state.json` `stale_state.json` `schedule_local_state.json` | 节点私有状态与水位，非协议字段 | 否 |
| `present_queue.jsonl` `present_bell` `present_queue.jsonl.lock` | 发给本机 Agent 的回执队列、门铃，以及队列锁。锁是临时文件；没有 `ah present` 在跑且守护进程空闲时可以删 | 否 |
| `agent_inbox.jsonl` | `kind=agent` 节点的收件箱 | 否 |

仓库里只有占位符样例：[`config/hub.standalone.example.json`](../config/hub.standalone.example.json)、[`config/node.remote.example.json`](../config/node.remote.example.json)、[`config/commands.example.json`](../config/commands.example.json)、[`config/schedules.example.json`](../config/schedules.example.json)、[`config/agent_templates.example.json`](../config/agent_templates.example.json)。

## 2. node.json

节点身份（`node` / `zone`）、总线模式（`busType`: `sqlite`、`http` 或 `agent`）、访问口令来源（`appEnv` 指向 `0600` 的 `AH_API_TOKEN`，或 `tokenFile` 指向另一份 `0600` 凭据）、长轮询与对账周期。

- `role`：`node` 或 `hub`，缺省 `node`。`ah daemon`、`doctor`、`service` 省略 `--role` 时读它。`busType=agent` 时 `role` 仍写 `node`。
- `busType`：`sqlite`（Hub 主中枢）、`http`（远端长轮询节点，机主 Token）或 `agent`（官方 Agent Gateway 客户端，只用分 Agent Token `aht_...`）。
- `tokenFile`：`busType=agent` 时推荐。指向 `0600` 凭据文件（一行 Token，或 `AH_API_TOKEN=` / `A2A_HUB_TOKEN=`）。明文不进 `node.json`、systemd unit 或日志。该文件优先于环境变量里的 `AH_API_TOKEN`。
- `agentRole`：`worker` 或 `leader`（旧值 `hybrid` 按 `leader`）。只在 `busType=agent` 下表示网关角色。
- `receiveMode`：`busType=agent` 缺省 `http-longpoll`。
- `longPollSec`：长轮询单次挂起秒数（默认 `25`）；`pollSec`（默认 `45`）是 `poll` 模式的定时轮询间隔；`sweepSec`（默认 `900`，即 15 分钟）是对账兜底。
- `hubPublicKey`：hub 的审批签名公钥（base64）。`ah join` 会从 `GET /api/v1/health` 自动拉取写入；配了它，本节点只认 hub 私钥签过的 `auth_decision`。hub 自己私钥在配置目录 `approval_key.pem`（600，首次启动自动生成），公钥由私钥推出。详见 [SECURITY.md](../SECURITY.md)。
- `tz`：IANA 时区名，缺省 `Asia/Shanghai`。决定本地定时调度的 cron 墙钟与期次键偏移，与宿主机时区及系统 `TZ` 环境变量无关。
- `maxConcurrent`：可选正整数，默认 `4`。控制 `context: "herdr"` 宿主机节点的最大并发槽位数（`working` 与处于 `input-required` / `auth-required` 的驻留 Pane 均计入占槽）。`ah setup` 检测到本机安装 `herdr` 时自动写入 `4`。
- `herdrSession` / `herdrWorkspace`：可选。指定 `herdr` 的 `--session <name>`（缺省使用默认 session）及任务工作区标签（默认 `"a2a-hub"`）。

## 3. 机器类型：host 与 agent

`ah setup [--kind host|agent]` 的向导支持：

- **`kind: host`（电脑宿主，默认）**：扫描识别本机已装的 Agent（Claude Code、Codex、agy、Paseo、Grok CLI 等），把它们登记为 `commands.json` 里的 Worker；守护进程认领任务后拉起本机命令干活。
- **`kind: agent`（本机独立 Agent，有守护进程壳）**：Agent 自己就是干活的人。`busType=http` 时 setup 不扫描 PATH、不注册外部 CLI，只登记一张本尊 Worker 名片 `agent`（`mode: inbox`）。守护进程认领任务后写入本地 `agent_inbox.jsonl` 并刷新心跳，由本尊调 `ah inbox` 接单、办完回执。
- **`busType: agent`（官方 Agent Gateway 客户端）**：云端 VM 只用最小权限的分 Agent Token。`ah daemon` 不开监听端口，走 `/api/v1/agents/*` 与 `/api/v1/tasks/*`。不要求本机 `commands.json`。`agentRole=worker` 安装 `ah-inbox`；`leader` 安装 `ah` 与 `ah-inbox`。Leader 把终态和追问追加到 `present_queue.jsonl`，用 `ah present` 消费。

> [!IMPORTANT]
> **Skill 自动匹配安装**：`ah setup` / `ah update` 会按当前节点 `role` 与 `kind` 向 `~/.agents/skills/` 精确写入本地 CLI Skill（`kind=host` 仅安装主控端 `ah`；`role=node, kind=agent` 仅安装执行端 `ah-inbox`；`role=hub, kind=agent` 两者都装）。云端定时唤醒、无法运行守护进程的外部 Agent（如 **Muse Leader**、**Grok Bot**）无需跑 `ah setup`。机主在控制台签发分 Agent Token 后，Agent 用它访问网关（`GET /.well-known/agent.json` 免鉴权；`GET /api/v1/skills/a2a-leader|a2a-worker` 需要鉴权）。详见 [外部 HTTP Agent 运行手册](protocol-node-runbook.md)。

## 4. commands.json：能力表

中台按三层寻址（标准 §0 第 8 条）：**Node** 是这台机器，**Worker** 是机器上的一个 Agent，**Skill** 是这个 Worker 能做的一类任务。`commands.json` 写的就是后两层。**加能力、改能力、删能力，只改这个文件，不改内核。**

```jsonc
{
  // 保留键 workers：本机的 Worker，值是这个 Agent CLI 的无头启动模板
  "workers": {
    "agy": {
      "command": "agy --dangerously-skip-permissions --print {prompt}",
      "name": "Antigravity",
      "desc": "通用 Agent：终端/SSH 工具面",
      "approval_class": "approve",
      "timeout_sec": 900
    }
  },
  // 其余键都是 Skill。自带 command 的由节点本尊直接执行，不经过任何 Worker
  "daily-briefing": {
    "command": "node scripts/briefing.js",
    "mode": "json",
    "name": "每日早报",
    "desc": "天气、热点、本机状态汇总",
    "side_effect": "read"
  },
  // 写 workers 数组的是这些 Worker 的专长技能：怎么启动取自 Worker，这里只写技能属性
  "ops-check": {
    "workers": ["agy"],
    "name": "运维巡检",
    "desc": "只读检查磁盘、负载与服务状态，汇报异常项",
    "side_effect": "read"
  }
}
```

这份配置登记三张名片：

| Cap_ID | Worker | Skill_ID | 说明 |
|---|---|---|---|
| `CAP-<前缀>-agy-agent` | `agy` | `agent` | Worker 名片：代表 Worker agy 在册及其通用执行（不是一项技能） |
| `CAP-<前缀>-agy-ops-check` | `agy` | `ops-check` | 专长技能 |
| `CAP-<前缀>-daily-briefing` | （空） | `daily-briefing` | 节点本尊直接执行的脚本 |

规则：

- **每个 Worker 在名册里自动有一张 Worker 名片（`Skill_ID=agent`）**，代表它在册及其通用执行，不用另写条目。独立 Agent 节点的 `agent`（`mode: inbox`）就是本尊的 Worker 名片，只是 Worker 为空。
- **专长技能**执行时，Agent 收到的受信提示里会多一行「本次任务使用技能：<Skill_ID>（<name>）。<desc>」，所以 `name` 和 `desc` 要写成 Agent 看得懂的指引。
- **派单时指定 Worker 是硬约束**：`ah task create --to <节点> --worker agy --cap ops-check`。目标节点没有这项 Worker × Skill 就拒收，不换别的 Worker 代跑。
- **不指定 Worker 时由节点取默认**：该技能有节点本尊的条目就用它，否则取第一个登记了该技能的 Worker（专长技能按 `workers` 数组顺序，`agent` 按 `workers` 对象的书写顺序）。认领时把选中的 Worker 回填到任务行，重试和问答续跑都钉在它上面。
- **本机审批下限取 Worker 与 Skill 中更严者**。上例 `agy` 是 `approve`，所以 `ops-check` 即使不写也要走审批。
- 同一条目不能同时写 `command` 和 `workers`；`workers` 里引用了没定义的 Worker、Worker 缺 `command`、Cap_ID 重复时，那一项能力不登记并记日志，`ah doctor` 也会报。
- 没有 `workers` 键的旧配置含义不变：每个条目都是节点本尊的能力，Cap_ID 不变。迁到 `workers` 的步骤见下文 [旧平表迁到 workers](#旧平表迁到-workers)。不要用重跑 `ah setup` 代替：它用默认模板覆盖旧条目，自定义的 `command`、`cwd`、`timeout_sec` 会丢。

Worker 条目与节点本尊的技能条目可用的字段：

| 字段 | 说明 |
|---|---|
| `command` | 命令模板。agent 模式含 `{prompt}` |
| `mode` | `agent`（默认）纯文本输出＋结构化回执；`json` 脚本类，stdin 收信封、stdout 最后一行出结果；`inbox` 交给本尊收件箱 |
| `context` | 支持 `direct`（默认，守护进程直接拉起单槽子进程）与 `herdr`（借本机 `herdr` 终端复用器为每个任务开独立 Tab/Pane，支持 `maxConcurrent` 多槽并行与多轮交互热驻留）。取值非法时任务直接 `rejected`，不静默降级 |
| `herdr_kind` | `context=herdr` 时传给 `herdr agent start --kind <kind>` 的交互式 Agent 类型（如 `claude`、`codex`、`agy`、`gemini`、`amp`、`droid`、`grok`、`hermes`、`cursor`、`opencode`）。缺省可从 Worker 名或 `command` 首词推导 |
| `herdr_args` | 可选字符串数组。`context=herdr` 时附在 `herdr agent start ... -- <args...>` 后的额外参数 |
| `herdr_env` | 可选对象（`{ KEY: "VAL" }`）。`context=herdr` 创建 Tab 时通过 `--env` 注入的自定义环境变量（内核固定注入 `AH_TASK_ID` / `AH_NODE` / `AH_WORKER` / `AH_RUN_DIR` / `AH_INPUT_PATH` / `AH_RECEIPT_PATH`） |
| `timeout_sec` | 单次执行上限，默认 600 |
| `verify` | 可选。一条本机 shell 命令，与 `command` 同一可信等级，原样执行，不做 `{prompt}` / `{session}` 替换。只支持 `context=direct` 的 `json` / `agent`。Skill 条目优先，Skill 未写时用其 Worker 条目的值。`mode=inbox` 写了是配置错误：认领预检 `rejected` + notice，`ah doctor` 报问题，不静默忽略。命令必须只读、可重复。执行者的数据不拼进命令，只经两条通道：stdin 一行 JSON `{"task_id","summary","artifact","artifact_name","checks"}`，以及环境变量 `AH_TASK_ID`、`AH_ARTIFACT`、`AH_RUN_DIR`、`AH_MAIN_STDOUT` |
| `verify_timeout_sec` | 可选正数，缺省 120，夹紧到 1–1800。继承规则同 `verify` |
| `cwd` | 工作目录，默认配置目录 |
| `side_effect` | 副作用等级，写进名片，如 `read` / `write` |
| `approval_class` | 本机审批下限，只收紧不放宽。设为 `approve` 的能力执行前必走机主审批 |
| `resume_command` | 可选，含 `{session}` 与 `{prompt}`。仅 direct 问答续跑且本机已有 session 时替换 `command` |
| `cap_id` `name` `desc` | 登记到 AgentCards 的名片信息。`cap_id` 只对节点本尊的条目有效，可省，缺省为 `CAP-<capPrefix>-<能力名>`（`capPrefix` 缺省取 `node`）；Worker 的能力固定为 `CAP-<capPrefix>-<Worker>-<Skill_ID>`。计划里的 `cap` 按这个口径匹配。迁到 Worker 时删掉 `cap_id`，Worker 能力不接受显式 Cap_ID。 |
| `workers` | 仅专长技能条目：能跑这项技能的 Worker 名数组。写了它就不能写 `command` / `mode` / `context` / `cwd` / `resume_command`，这些取自 Worker |

命令、目录、语境、`verify` 只来自这个文件。任务参数里带 `command` / `cwd` / `context` / `agent` / `worker` / `verify` / `verify_timeout_sec` 等执行控制键，会被直接拒收，不会被当作指令。任务行上的 Worker 与技能名只是在这个文件已登记的能力里按名字选一项，选不中就拒收。

热更新与降级：

- 守护进程每轮用文件 mtime 与内容哈希判断能力表变没变；变了就串行对账 AgentCards：新增或修改的能力更新名片，被删的能力把名片 `Dispatchable` 置为 `No`。
- 首次同步时也强制校准名片；写表全部成功后才更新本地缓存，写一半失败就保持上一版，下一轮补写。
- `commands.json` 解析失败时，保留上一版有效能力表并**暂停接新单**（任务留在 `submitted`，不会因能力表被清空而被拒成 `rejected`）。修好文件后下一轮自动恢复。`ah doctor` 会检查两份配置是否合法。

守护进程是薄壳，不内嵌任何执行器：确定性脚本、Worker 的专长技能、Worker 的通用执行，都只是这个文件里的模板。

### 回执约定（摘要）

内核只认结构，不猜自然语言。完整语法见标准 §9。

- **agent 模式**：最后一个完整围栏若是 ```` ```agent-ask ````，表示提问（任务转 `input-required`）；若是 ```` ```agent-auth ````，表示执行中请求批准（块内写明动作、对象与风险，任务转 `auth-required`）。二者只认最后一个，空的 `agent-auth` 是无效回执。围栏外整行的 `ARTIFACT:` / `ARTIFACT_NAME:` / `USAGE:` / `SESSION:` / `LATER:` / `CHECK:` 分别表示产物、用量、会话、预约复查、清单自检。`CHECK: <id> <pass|fail|blocked>[ | <证据>]` 只在回执收口为完成时收下；提问、审批和无效回执上的自检忽略并记日志。同一 `id` 多行取最后一行。围栏内伪造的行不生效。`agent-auth` 在进程退出后才解析，拦不住已经做完的副作用；要在动作前停住，用 `ah inbox auth`。
- **json 模式**：只认 stdout 最后一行 JSON：`summary`、`artifact`、`artifact_name`、`need_input`、`need_auth`，可选 `usage`、`session`、`later`、`checks`。`checks` 形如 `{"<id>":{"verdict":"pass|fail|blocked","evidence":"…"}}`，值也可以直接是判定字符串。`need_input` 与 `need_auth` 不能同时出现。未知顶层键忽略并记日志。提问、审批和无效回执上的 `checks` 忽略并记日志。
- `usage` 累计到 `Tasks.Metadata.usage`；`session` 只存本机 `runs/<Task_ID>/session.json`，不进总线；`later` 在任务完成时生效，由 hub 到点在同一 `Context_ID` 新建复查任务。

### 验收

验收判「做得对不对」，不代替审批。审批仍只认机主签名。

L1 是本机 `verify`，只覆盖 direct 的 json / agent。主命令退出码为 0 且回执是完成之后、写表之前跑。退出码 0 才 `completed`；`fail` / `timeout` / `error` 一律 `failed` + notice，不计重试、不回 `submitted`、不自动重跑。证据由守护进程捕获，是唯一能改状态的验收证据。没配 `verify`（含 inbox）显示「未配置执行式验收」，不得显示为通过。

L2 是建单时冻在首条 instruction DataPart 的 `acceptance.criteria`（`ah task create --criteria`）。执行方用 `CHECK:` 行、json `checks` 或 `ah inbox done --check` 自检。v1 只记录和展示，不改任务状态：自检里有 `fail` 仍是 `completed`。

既没有 verify 也没有清单时不写验收记录，行为与原来一致。有记录时，权威在回执消息 Seq 2 的 DataPart；`Tasks.Metadata.acceptance` 只是去掉证据正文的索引。

`ah task why`（文本与 `--json`）和 `ah present` 正文都能看到摘要。验收未通过的 `failed` 在呈递标题上带「验收未通过」，与执行失败区分。

### 旧平表迁到 workers

早期配置把 Agent 写成自带 `command` 的顶层条目（如 `agy-agent`）。这种条目按规则是节点本尊的技能，名片的 Worker 列为空，在名册上看不出它是一个 Worker。迁到 `workers` 后，它与独立 Agent 节点的名片口径一致。

**适用对象**：`commands.json` 里没有 `workers` 键、Agent 直接写成自带 `command` 的顶层条目的节点。独立 Agent 节点（`kind: agent`）和手工登记名片的协议节点不用迁，它们本来就是「本尊即 Worker」。确定性脚本（`mode: json`）也不用动，它本来就是节点本尊技能。

**升级顺序**：先升级 hub，再升级所有会发单的机器（包括装了 ah Skill 的 Agent 所在机器），最后才改节点的 `commands.json`。可以在名册的 `Daemon_Version` 列确认各节点是否都已是 `node-0.8.0` 或更高。只装了 ah CLI / Skill 用来发单的机器不在名册里，在那台机器上用 `ah -v` 自查。原因：

- 旧版守护进程不认识 `workers`，会把它当成一项名叫 `workers` 的能力登记，并把原来的卡置为停派；
- 旧版发单方用 `--cap CAP-<前缀>-<x>-agent` 时会丢掉 Worker，任务落到节点的默认 Worker（`workers` 里写在最前的那个）；
- 旧版 hub 做 later 复查时同样不继承 Worker。

**步骤**：

1. **升级本机守护进程**：`ah update`，按平时的方式重启守护进程。跑 `ah doctor --config <dir>`，能看到「N 个 Worker、M 项技能」这样的分组输出和针对旧条目的迁移提示，说明已是新代码。更直接的判断是版本号：`ah -v` 应打印 `node-0.8.0` 或更高；守护进程重启后，名册（AgentCards）里本节点名片的 `Daemon_Version` 也会是这个值。
2. **清空在途任务**：`ah inventory --config <dir>` 确认本节点没有 `submitted`、`working`、`input-required`、`auth-required` 的任务，有就等它们结束、答复或撤掉。不清空的后果：以旧 Skill_ID 寻址的任务迁移后会被拒收并带 notice（不会静默跑错），但会白丢一次执行或一轮问答。另外通过 Web 控制台或接口看一下有没有目标是本节点、已 `completed`、`Metadata` 里有 `later` 但还没有 `later_fired` 的任务，有就等它触发后再迁，否则 hub 会因为找不到旧 Skill_ID 而一直建单失败。
3. **备份**：`cp <dir>/commands.json <dir>/commands.json.bak`。
4. **改写 `commands.json`**，改前改后如下（只用占位命令）。

   改前：

   ```json
   {
     "agy-agent":   { "command": "<agy 无头命令> {prompt}",   "mode": "agent", "cap_id": "CAP-<前缀>-agy-agent",
                      "name": "<名称>", "desc": "<说明>", "approval_class": "approve", "timeout_sec": 900 },
     "paseo-agent": { "command": "<paseo 无头命令> {prompt}", "mode": "agent", "cap_id": "CAP-<前缀>-paseo-agent",
                      "name": "<名称>", "desc": "<说明>", "approval_class": "approve", "timeout_sec": 900 }
   }
   ```

   改后：

   ```json
   {
     "workers": {
       "agy":   { "command": "<agy 无头命令> {prompt}",   "mode": "agent",
                  "name": "<名称>", "desc": "<说明>", "approval_class": "approve", "timeout_sec": 900 },
       "paseo": { "command": "<paseo 无头命令> {prompt}", "mode": "agent",
                  "name": "<名称>", "desc": "<说明>", "approval_class": "approve", "timeout_sec": 900 }
     }
   }
   ```

   字段对照：`command`、`resume_command`、`mode`、`context`、`cwd`、`timeout_sec`、`approval_class`、`side_effect`、`name`、`desc` 原样搬进 Worker 条目；删掉 `cap_id`。旧条目必须删掉，不能和同名 Worker 并存（两者 Cap_ID 相同，Worker 名片会登记不上）。

5. **自检**：`ah doctor --config <dir>` 不再有迁移提示，能看到 `Worker agy`、`Worker paseo` 两行，本地计划全部正常。
6. **确认名片**：守护进程会热加载新配置，不用重启。`ah inventory --config <dir>` 应看到 `CAP-<前缀>-agy-agent` 这张卡变成 `Worker=agy`、`Skill=agent`、`Dispatchable=Yes`，没有新增的行，也没有被置停派的行。
7. **冒烟**：从任意已升级的机器 `ah task create --to <节点> --worker agy --text "回一句 ok"`，再 `ah task why <ID>` 确认 `Worker_Hint=agy`。
8. **改派单习惯**：`--cap agy-agent` 会在写表前报「未登记能力」，改用 `--worker agy`；`--cap CAP-<前缀>-agy-agent` 和只写 `--to <节点>` 的自动挑选照常可用。

**迁移前后对照**：

| | 迁移前 | 迁移后 |
|---|---|---|
| Skill_ID | `agy-agent` | `agent` |
| Worker | 空 | `agy` |
| 能力键 | `agy-agent` | `agy/agent` |
| Cap_ID | `CAP-<前缀>-agy-agent` | `CAP-<前缀>-agy-agent`（旧键恰好是 `<W>-agent` 形式时不变） |

**Cap_ID 规律**：旧键不是 `<x>-agent` 形式的（比如键叫 `claude`、`cap_id` 是 `CAP-<前缀>-claude`），迁移后 Cap_ID 变为 `CAP-<前缀>-claude-agent`；旧卡由对账自动置 `Dispatchable=No`，引用旧 Cap_ID 的 `schedules.json` 要同步改 `cap`。

**用某个 Agent 跑的专门任务**（比如旧平表里一个用 agy 跑的 `ops` 条目）：迁成专长技能 `"ops": { "workers": ["agy"], "name": "<名称>", "desc": "<说明>" }`，Cap_ID 变为 `CAP-<前缀>-agy-ops`，`--cap ops` 照样能用。确定性脚本（`mode: json`）不用动，它本来就是节点本尊技能。

**回滚**：把备份拷回去，守护进程热加载后名片原地改回。回滚前同样要先清空在途任务。

## 5. 定时调度：schedules.json 与双时钟

自 v3.6 起，定时调度下沉至各节点本地（时钟不再由 hub 独占）。Rules 表中的调度列降为节点单向同步的只读观察镜像。

### 5.1 调度架构与双时钟

- **终端类节点（`kind: host` 与 hub 所在机）**：由 `ah daemon` 内置的分钟定时器驱动，读取配置目录下的 `schedules.json`，到点以 `Status=submitted` 建单入总线，并立刻置本进程唤醒标志，走统一认领链路（在途账本、心跳、单并发、审批下限）。
- **Agent 类节点（`kind: agent`，本机有守护进程）**：使用 Agent 自身定时器到点调用 `ah task begin` 建单，由本机守护进程认领写入收件箱，Agent 处理完后调用 `ah inbox done`。云端 Muse / Grok 不走这条，见 [外部 HTTP Agent 手册](protocol-node-runbook.md)。

### 5.2 schedules.json 字段表与示例

计划保存在配置目录的 `schedules.json`（权限 0600，不进仓库、不进总线）。占位符样例见 [`config/schedules.example.json`](../config/schedules.example.json)。

```jsonc
{
  "schedules": [
    {
      "id": "DAILY-BRIEFING",
      "enabled": true,
      "cron": "50 8 * * *",
      "cap": "daily-briefing",
      "text": "生成今日早报并汇总天气与热点",
      "approval_class": "auto"
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | 计划唯一标识，如 `DAILY-BRIEFING` |
| `enabled` | 是否启用（布尔值，`true` / `false`） |
| `cron` | 五段标准 cron 表达式（分 时 日 月 周），按 `node.json` 的 `tz` 墙钟解析 |
| `cap` | 本机能力 ID，必须存在于本机 `commands.json`（或 `agent`） |
| `text` | 任务指令正文 |
| `approval_class` | 可选（`auto` / `notify` / `approve`），写入任务行的审批级别；认领时与 `commands.json` 的 `approval_class` 下限取更严者，只收紧不放宽 |

> [!WARNING]
> 指令与数据严格分离：`schedules.json` 中严禁出现 `command` / `cwd` / `context` / `agent` / `mode` 等执行控制键，出现则整条计划拒收。

### 5.3 状态与基线（schedule_local_state.json）

配置目录下的 `schedule_local_state.json` 记录每条计划的 `{cron, last_fired, last_task}` 基线水位，以及已向 Rules 镜像同步的 ID 集合 `mirrored_ids`。
- **基线优先于补期**：新建计划、修改 `cron` 表达式或状态文件损坏/缺失时，首次扫描仅将水位线锚定在最近一期，不建单；从下一期起才触发。
- **只补最近一期**：停机或错过多期时只触发最近一期；节点关机或睡眠期间未执行的期次不做代偿。
- **幂等防重**：幂等键为 `sched:<Node_ID>:<Schedule_ID>:<期次键>`，查重命中已有任务时只补水位线，不重复建单。

### 5.4 CLI 调度管理

```bash
ah schedule ls [--config <dir>] [--json]                                                  # 查看本机计划
ah schedule add --id <id> --cron "<五段>" --cap <cap_id> --text <指令> [--approval auto|notify|approve] [--disabled]  # 添加计划并刷新镜像
ah schedule rm <id> [--config <dir>]                                                     # 删除计划（镜像标 No）
ah schedule enable <id> [--config <dir>]                                                 # 启用计划
ah schedule disable <id> [--config <dir>]                                                # 停用计划
ah schedule register --id <id> --cron "<五段>" --cap <cap_id> [--text <指令>]              # 仅登记 Rules 观察镜像
ah task begin --schedule <id> [--period <期次键>] [--cap <cap_id>] [--text <指令>]        # Agent 类自带时钟到点触发建单（--text 缺省为「定时任务 <id>」）
```

### 5.5 Agent 类自带时钟接入示例

本机独立 Agent（`kind: agent`）自带定时器时的接入流程：
1. **登记镜像**：`ah schedule register --id AGENT-MORNING --cron "0 9 * * *" --cap agent --text "每日早间同步"`
2. **到点建单**：Agent 定时器触发时运行 `ah task begin --schedule AGENT-MORNING --text "每日早间同步"`
3. **认领接单**：本节点 `ah daemon` 认领该任务写入 `agent_inbox.jsonl`
4. **处理并交付**：Agent 读取收件箱，完成后调用 `ah inbox done --task <Task_ID> --text "已完成同步"`

### 5.6 Rules 观察镜像与自检

- **单向观察镜像**：节点将本机每条计划镜像为 Rules 一行（`Rule_ID=<Node_ID>:<Schedule_ID>`）。任何节点**绝不从 Rules 读计划触发任务**，手动修改 Rules **不影响本地实际执行**。
- **升级顺序：先升级 hub，再升级各节点。** 旧版本 hub 仍会把 Rules 里 `Enabled=Yes` 且 `Schedule` 非空的行当成计划建单；新版节点一旦写入镜像行，就会被旧 hub 误触发，造成同一计划双跑。迁移存量计划（如 `SCHED-HUB-MORNING`）时，先把 Rules 旧行 `Enabled` 置 No，再用 `ah schedule add` 在对应节点落计划。
- **已知限制：定时任务中途提问需要人答复。** 本地定时任务的发起方是本节点自己，`question` 会原路回给本节点并进入 `present_queue.jsonl`，需要本机 Agent 消费后执行 `ah task reply`。无人值守时任务会停在 `input-required`。没写 `wait_timeout_sec` 时，hub 的陈旧告警只处理 `working` 与无人认领的 `submitted`；建单写入该键后，挂起超时会回收。无人值守的计划请选不会提问的能力。
- **`ah doctor` 增检**：存在 `schedules.json` 时，自检会逐条验证 cap 存在性、cron 表达式合法性、时区 `tz` 合法性与控制键拦截。若有异常仅打印告警，不改变 doctor 退出码，不阻断守护进程启动。时区检查放开至所有含有 `schedules.json` 的节点。
- **只读总览**：机主用 `GET /api/v1/schedules` 或控制台「定时任务」页看各节点镜像（cron、下次触发、上次任务、异常）。改计划仍用本机 `ah schedule`。HTTP Agent 可 `PUT /api/v1/agents/:node/schedules/:id` 自报计划，中台只展示、不据此触发。详见 §7.6。

## 6. CLI 速查

`ah` 是主入口（别名 `a2a-hub`、`ahub`）。以下 `--config <dir>` 均可省略（见第 1 节）。

| 命令 | 作用 |
|---|---|
| `ah up` / `ah join <url>` | 一键初始化 SQLite Hub 或接入远端 HTTP 节点，自动配置 Token、公钥与自启 |
| `ah setup [--role node\|hub] [--bus sqlite\|http\|agent] [--kind host\|agent] [--agent] [--agent-role worker\|leader] [--token-file <path>] [--wake longpoll\|poll] [--skip-skill]` | 交互/非交互初始化。`bus=agent` 时把凭据路径写入 `tokenFile`，不把明文 Token 写入 `node.json` 或 `app.env`，也不生成 `commands.json` |
| `ah daemon [--role node\|hub]` | 常驻守护进程 |
| `ah doctor [--role node\|hub]` | 只读自检：配置合法性、连通性、能力登记、本地计划 |
| `ah service [--role node\|hub] [--system\|--user] [--name <unit>] [--remove]` | 注册（或卸载）开机自启：macOS launchd `ah-<role>.<node>` / Linux systemd `ah-<role>-<node>.service` / Windows 任务计划 `ah-<role>-<node>`（非默认配置目录追加配置路径 SHA-256 前 8 位摘要）。`--user` 为用户级；`--system` 为系统级（Linux VM 换机自愈用这一条，并带上当前代理环境与 `NODE_USE_ENV_PROXY=1`）。`--name` 指定 unit 名。日志在配置目录 `daemon.log`。失败返回非 0，输出不含凭据 |
| `ah update [--check] [--skip-skill]` | 自更新程序本体：git pull、依赖重装、入口与 Skill 补齐；不碰配置目录。`--check` 只看远端有没有新版本。tarball 安装请重跑 install.sh（Windows 为 install.ps1） |
| `ah reconcile` | 单次回表认领与对账后退出 |
| `ah inventory` | 只读盘点本节点名片与任务 |
| `ah task create --to <node> [--worker <worker>] [--cap <cap_id 或技能名>] [--text …] [--file <路径>]... [--params <json 或 @文件>] [--criteria <json 或 @文件>] [--idempotency-key <键>] [--from <node>]` | 派单。写表前按 AgentCards 名册校验 `--to` 与 `--cap`。`--criteria` 写入首条 instruction 的验收清单；`--file` 可重复（有附件时 `--text` 可省） |
| `ah task reply --task <id> [--text …] [--file <路径>]...` | 答复 `input-required` 的追问，原任务续跑；`--file` 可重复（有附件时 `--text` 可省） |
| `ah task show <id>` | 看状态与产物 |
| `ah task why <id> [--json]` | 只读时间线：任务行、消息、Runs、Artifacts、本机待补交状态、调度幂等来源、验收 |
| `ah task cancel --task <id> [--text …]` | 撤单。发起方只撤自己的单，hub 可撤任意单；终态报错且不改状态 |
| `ah task begin --schedule <id> [--period <期次键>] [--cap <cap_id>] [--text <指令>]` | Agent 类自带时钟到点触发建单（经 submitted 入总线由本节点认领；`--text` 缺省为「定时任务 <id>」） |
| `ah schedule ls [--config <dir>] [--json]` | 列出本机定时调度计划 |
| `ah schedule add --id <id> --cron "<五段>" --cap <cap_id> --text <指令> [--approval auto\|notify\|approve] [--disabled]` | 添加本机计划并同步镜像 |
| `ah schedule rm <id> [--config <dir>]` | 删除本机计划（镜像行标 No） |
| `ah schedule enable\|disable <id> [--config <dir>]` | 启用/停用本机计划 |
| `ah schedule register --id <id> --cron "<五段>" --cap <cap_id> [--text <指令>]` | 登记 Agent 观察镜像（不写本机计划） |
| `ah present [--pop] [--task <Task_ID>] [--wait <秒>]` | 读取本机发起任务的回执队列。`--wait` 阻塞到出现匹配回执（超时退出码 2）；`--pop` 只移除本次输出的条目 |
| `ah inbox [--pop] [--limit <n>] [--json]` | `kind=agent` 接单（`--limit <n>` 可限制本次弹出条数） |
| `ah inbox done\|ask\|fail\|auth --task <id> --text …` | 完单（可重复 `--artifact <路径或URL>`、`--check <id>=<pass\|fail\|blocked>[:证据]`）、追问（可重复 `--file`）、失败、执行中请求审批回执（可重复 `--file`） |

回执队列 `present_queue.jsonl` 旁边的 `present_bell` 仍会在有新回执落盘时刷新 mtime，供想低成本感知的 Hook 使用。`ah present --wait` 不依赖门铃，直接轮询队列文件。

### `ah present` 等待模式

- `ah present [--pop] [--task <Task_ID>] [--wait <秒>]` 只读本机 `present_queue.jsonl`，不额外发网络请求。
- 不带 `--wait`：立刻读当前队列。空队列无输出，退出码 0。`--pop` 只取走本次输出的行。
- `--wait <秒>`：阻塞到出现匹配回执。队列里已经有匹配则立刻返回，不必等到秒数走完。超时则标准输出为空，退出码 2，标准错误说明已等待多久。
- 退出码：0 成功（等待模式表示至少拿到一行）；1 是参数、读写或拿锁失败。未知参数和多余的位置参数现在也是 1，不再静默忽略。2 是等待超时。
- `--wait` 不带 `--task`：队列里出现任意一条就返回。多个在途任务务必带 `--task`，否则会把别的任务的回执一并拿走。
- `--wait` 是 0 到 86400 的整数。0 表示不等：没有现成回执就马上以退出码 2 结束。
- 守护进程没在跑（没有 `daemon.lock`，或其中的 pid 已经退出）时，标准错误提示一次，然后继续等。超时的说明里会再提一次。可用 `ah doctor` 排查。回执要等守护进程写进队列，只跑 `ah present --wait` 不会主动从 Hub 拉取。
- 等待期间被中断不会丢回执。

`present_queue.jsonl.lock` 是守护进程追加和 `ah present --pop` 共用的互斥锁。别的进程拿着一把还没过期的锁时，守护进程每写一条回执最多等 3 秒，连续几条会累加（实测 3 条约 9.5 秒），扫表主循环在这段时间里是堵住的。大约 10 秒后这把锁按过期被接管。没有 `ah present` 在跑、并且守护进程空闲（没有扫表卡在这把锁上）时，可以安全删除它。

### 用日志看请求量与限流

守护进程日志（`ah service` 写在配置目录 `daemon.log`）里，每一轮扫表结束有一行，hub 另外四段各一行，退避重试再加一行。`log()` 前缀是 UTC 的 `YYYY-MM-DDTHH:MM:SS`。值里没有空格，方便按天相加：

```
sweep end ms=1234 ok=1 list=5 get=0 write=0 other=0 backoff=0
scan approval ms=312 ok=1 list=1 get=0 write=0 other=0 backoff=0
api backoff reason=http-429 kind=list retry=1/3 wait=2s
```

`scan` 的名字是 `approval`、`present`、`stale`、`schedule` 之一。上面的数字只说明格式，不是空闲一轮的固定次数。

口径：一行里的 `list` / `get` / `write` / `other` / `backoff` 是自上一次这样的行以来的增量。把一天里的 `sweep end` 和 `scan` 行相加，就是该进程当天发出的总线请求，包含扫表间隙里 60 秒定时心跳，不含 `ah task create` 这类一次性进程，也不含进程启动到第一行之间的请求。四个分类是实际发出的请求数（含重试的那几次），`backoff` 是其中因退避而重发的次数。日志不写凭据、Token、record_id 和请求路径。

`api backoff` 通常用于请求退避与重发定位，一般日志不写凭据、Token 与隐私字段。

## 7. 独立中台（SQLite Hub）、长轮询节点与外部 HTTP Agent / LoopForge SOP

`a2a-hub` 统一采用 `sqlite`（Hub 主中枢）+ `http`（远端宿主长轮询 / 纯外部 HTTP Agent）运行。配置样例见 [`config/hub.standalone.example.json`](../config/hub.standalone.example.json) 与 [`config/node.remote.example.json`](../config/node.remote.example.json)。

### 7.1 `node.json` 独立中台与长轮询字段

| 字段 | 适用角色 | 说明 |
|---|---|---|
| `busType` | 全部 | 总线类型：`sqlite`（`role=hub` 默认）、`http`（填写了 `hubUrl` 的远端节点，机主 Token）或 `agent`（官方 Agent Gateway 客户端，分 Agent Token） |
| `dbPath` | Hub (`sqlite`) | SQLite WAL 数据库文件路径，支持相对配置目录路径，默认 `hub.db` |
| `listen` | Hub (`sqlite`) | HTTP API 与 Web 控制台绑定地址，格式 `<host>:<port>`，默认 `0.0.0.0:8787` |
| `publicUrl` | Hub (`sqlite`) | 可选外部访问地址（如 `http://192.168.1.10:8787` 或 Tailscale 地址），用于生成外部通知跳转链接，以及控制台「添加 Agent」接入提示词里的 Hub 地址 |
| `apiToken` | Hub / 远端 `http` 节点 | 机主（owner）Bearer Token，权限覆盖全部接口。建议放在 0600 权限的 `app.env` 环境变量 `AH_API_TOKEN` 中。外部 HTTP Agent 不要用这把钥匙，用 §7.5 的分 Agent Token |
| `hubUrl` | 远端节点 (`http` / `agent`) | 中台 HTTP 根地址，如 `http://192.168.1.10:8787` |
| `tokenFile` | `busType=agent` | `0600` 凭据文件路径。一行 Token，或 `AH_API_TOKEN=` / `A2A_HUB_TOKEN=`。优先于环境变量。明文不进 `node.json` |
| `agentRole` | `busType=agent` | `worker` 或 `leader`。`role` 字段仍是 `node` |
| `receiveMode` | `busType=agent` | 缺省 `http-longpoll` |
| `longPollSec` | 全部模式 | 长轮询单次挂起秒数，默认 `25`（服务端安全夹紧在 5–60 秒） |
| `notifications` | Hub (`sqlite`) | 可选外部提醒配置对象：`feishuWebhookUrl`（飞书群机器人 Webhook，可选通知渠道）、`barkUrl`、`telegramBotToken`、`telegramChatId`、`webhookUrl`、`events`（默认 `auth-required`、`input-required`、`completed`、`failed`、`rejected`，另可加 `stale`） |

### 7.2 快速启动与接入方式

- 一键启动主中台 Hub：`ah up [--listen 0.0.0.0:8787] [--service]`（自动生成 SQLite 库、`app.env` 随机口令与 `approval_key.pem` ed25519 密钥对）
- 一键接入远端电脑：`ah join http://<TOKEN>@<HUB>:8787 [--service]`（自动抽离口令至 `app.env`、拉取 `hubPublicKey` 并启动只出站长轮询守护）
- 官方 Agent Gateway 客户端（云端 VM，只用分 Agent Token）：
  ```bash
  ah join http://<HUB>:8787 --agent --agent-role worker --token-file ~/.a2a-hub-worker/token --node worker-1 --config ~/.a2a-hub-worker-1
  ah service --system --config ~/.a2a-hub-worker-1
  ```
  `node.json` 只写 `tokenFile` 路径。`ah daemon` / `ah inbox` / `ah task` / `ah present` / `ah doctor` / `ah reconcile` 都走 Agent Gateway，不访问 `/api/v1/tables/*` 或 `/api/v1/poll`。
- 临时 VM 换机自愈：把 `ah`、配置和恢复脚本放在家目录（例如 `~/.local/state/`）。开机探针用 `/tmp/a2a-hub-<node>.ready`（换机后 `/tmp` 为空）。runtime hook 每 5 秒检查探针；缺失时执行 `ah service --system --config ~/.a2a-hub-<node> && touch /tmp/a2a-hub-<node>.ready`。只有退出码 0 才写探针，失败下一轮再收敛。命令会带上当前环境的代理变量和 `NODE_USE_ENV_PROXY=1`，输出不含凭据。
- 手动非交互配置：
  - `ah setup --role hub --bus sqlite [--listen 0.0.0.0:8787] [--db-path ./hub.db] [--public-url http://...] [--api-token <token>] [--yes]`
  - `ah setup --role node --bus http --hub-url http://<HUB>:8787 --api-token <token> [--hub-key <pubkey>] [--yes]`
  - `ah setup --bus agent --agent-role leader --hub-url http://<HUB>:8787 --token-file ~/.a2a-hub-leader/token --node leader-1 --config ~/.a2a-hub-leader-1 --yes`
- **纯 HTTP 外部 Agent（Muse Leader / Grok Bot 等无守护进程 Agent）**：在控制台添加并复制分 Agent Token，存进平台安全密钥空间 `A2A_HUB_TOKEN`。角色是 `worker`（只接单）或 `leader`（派单并接单）。`hybrid` 为旧值，等同 `leader`；新签发不再写出 `hybrid`。`access=http` 时选一种接收方式：定时检查（默认，`receive=poll`，名片 `Receive_Mode=http-poll`）、常驻长轮询（`longpoll` → `http-longpoll`）或 Webhook 门铃（`webhook`，必填对方的 URL 与密钥）。添加或注册时可配置分钟级轮询间隔 `poll_interval_min`（`1–1440` 整数分钟，定时检查默认 `5`，Webhook 兜底默认 `30`，支持 60 分钟等长周期），持久化在名片 `Metadata.poll_interval_min` 并动态写入接入提示词。接入提示词按节点模板 id（`template_id`）生成。模板目录是配置目录的 `agent_templates.json`（见 7.2.1），初始四条是 `generic-poll`、`workbuddy`、`muse`、`grok-bot`。它写入名片 `Metadata.template_id`，第三步和轮换 Token 都按这个 id 取同一套提示词。粗分类 `template` 仍是 `generic` / `muse` / `grok-bot`（默认 `generic`）：`generic` 为自包含通用版（定时检查直接用只读 `GET /api/v1/agents/:node/check` 判定有没有活，常驻长连接与 Webhook 也变体齐全），`muse` 面向临时云 VM（官方 `ah` + `ah service --ensure` + runtime hook 每 5 秒自愈换机重建），`grok-bot` 为 Webhook 门铃短指令（对方看不到原始请求体与签名头，不含验签与脚本）。`muse`→长轮询、`grok-bot`→Webhook，非 generic 时写入 `Metadata.template`。手动改了接收方式且与所选节点模板不一致时不写 `template_id`，提示词回到该接收方式的通用版。`generic` 与 `workbuddy` 的粗分类都是 `generic`，只靠 `template` 分不开。提示词自包含：不要求对方下载或运行任何脚本，也不要求伪装浏览器 UA；若 Hub 在 Cloudflare 之后，应在 Cloudflare 对该主机名 `/api/v1/*` 加一条 WAF 自定义 Skip 规则（跳过浏览器完整性检查等），否则 python 等非浏览器 UA 会被 403 / error 1010 拦在边缘。无需安装本地 `ah` 进程（`muse` 模板除外，它本来就装官方 `ah`）。控制台的在线判定统一按 **「轮询间隔 × 1.5」** 计算：显式配置了 `poll_interval_min` 时直接取 `poll_interval_min × 60s × 1.5`（如 60 分钟 → 90 分钟，不被 30 分钟名册闲置期限截断，也不被 3 分钟下限强行拉长）；未配置时，定时检查默认 5 × 1.5 = 7.5 分钟（观测到周期后按观测值 × 1.5，上限 30 分钟），Webhook 固定按 30 × 1.5 = 45 分钟。Hub 启动时预加载名片中的 `poll_interval_min` 至内存 Broker，确保重启后首次 Webhook 投递或 `updates` 调用均套用正确窗口。长轮询的宿主节点仍是 90 秒。三种方式怎么选、门铃怎么验签，见 [外部 HTTP Agent 手册](protocol-node-runbook.md)。

### 7.2.1 节点模板目录 `agent_templates.json`

HTTP 节点模板只有这一份文件。Hub 第一次启动时，如果配置目录里还没有它，会写入初始四条（通用、WorkBuddy、Muse、Grok Bot），权限 `0600`。之后改这四条、再追加新模板，都改这个文件，字段一样。控制台每次打开都重读，改完刷新即可，不用重启。

某节点用的是哪一条，仍只记在名片 `Metadata.template_id`。文件里删掉一条之后，旧名片轮换 Token 时找不到这个 id，提示词回到该接收方式的通用版。删掉整个文件再启动，会重新写入初始四条；把数组清空则是一份空目录，不会自动补回。

| 字段 | 作用 |
|---|---|
| `id` | 小写字母、数字、短横线。名片和第三步提示词都用它 |
| `label` | 下拉框和节点卡片上的名字 |
| `template` | `generic` / `muse` / `grok-bot`。决定程序拼哪一套协议步骤 |
| `receive` | `poll` / `longpoll` / `webhook`。`muse` 固定长轮询，`grok-bot` 固定 Webhook |
| `role` | `worker` 或 `leader` |
| `interval` | 分钟，`1–1440`。长轮询用 `null` |
| `hint` | 下拉框下面的一句说明 |
| `defaults` | 向导预填：`node`、`displayName`、`description`、`adminNote`，Webhook 还可写 `webhookHeader`、`webhookUrlPlaceholder`、`webhookKeyPlaceholder` |
| `intro` | 只换开场白。占位符 `{{base}}` `{{node}}` `{{role}}` `{{token}}` `{{interval}}`。后面的取单、认领、回报仍由程序接上 |
| `prompt` | 整段提示词，同一套占位符。写了它就不再附协议步骤。和 `intro` 同时存在时用 `prompt` |

`template` 仍只能是上面三个值，因为协议步骤在程序里。新平台若走同一套定时检查，用 `generic` 加自己的 `intro`。流程确实不同，再写 `prompt`。

文件损坏或某一条不合法时，控制台顶部告警，`ah doctor` 也打印。整份损坏时不改文件，先用内存里的初始四条；某一条坏了就跳过那一条。占位示例见 [`config/agent_templates.example.json`](../config/agent_templates.example.json)。

### 7.3 LoopForge SOP 多阶段闭环 CLI（`ah loop`）

```bash
# 查看内置 SOP 模板（如 plan-code-verify）
ah loop templates

# 发起多阶段闭环（在相同 Context_ID 下串联 plan → code → verify 并基于验收自动回跳）
ah loop create \
  --title "修复登录竞态并补单测" \
  --goal "定位 token 并发刷新竞态，修复代码并确保 verify 全通过" \
  --template plan-code-verify \
  --to edge-node-1 \
  --worker agy \
  --max-iterations 5 \
  [--config <dir>]

# 进阶：通过 JSON 文件或内联 JSON 自定义阶段与每阶段指定节点/能力绑定
ah loop create --title "跨节点发布闭环" --goal "..." --stages @stages.json --bindings @bindings.json [--config <dir>]

# 查看全网 Loop 列表或单条历史明细
ah loop ls [--json] [--config <dir>]
ah loop show <Loop_ID> [--config <dir>]

# 取消闭环及当前在途子任务
ah loop cancel <Loop_ID> [--text "说明"] [--config <dir>]
```

### 7.4 名片接纳与添加 Agent

远端节点对账，以及外部 Agent 自行 `register` 写上的名片，先进「待接纳」池。机主接纳后才能派单。`role=hub` 本机名片（`Node` 等于 Hub 自己的节点名）如果 `Admission` 为空，对账时补成 `admitted`；已经写过的值（含 `pending` / `rejected`）不覆盖。`Admission` 三种状态：

| 状态 | 含义 |
|---|---|
| `pending` | 待接纳。缺省、空或非法值都按此处理 |
| `admitted` | 已接纳。还要 `Dispatchable=Yes` 才能派单 |
| `rejected` | 已拒绝，不派单 |

控制台「节点」页按节点分组：节点下列出 Agent（`Skill_ID=agent`），Agent 下列出能力；Worker 为空且 `Skill_ID` 不是 `agent` 的能力归在「节点直属能力」。筛选为已接纳（默认）、待接纳（带数量徽标）、已拒绝。待接纳里可单卡接纳或拒绝，节点标题可整节点接纳。已接纳卡可编辑显示名与备注、移回待接纳或拒绝；`Dispatchable=Yes` 时可向该能力派单。已拒绝卡可恢复为待接纳或直接接纳。

节点卡片上的「+ 添加能力」：http 节点提交 `POST /api/v1/admin/cards`，建成已接纳名片；宿主节点提交 `POST /api/v1/admin/commands-snippet`，只展示可合并进该节点 `commands.json` 的片段和复制按钮，中台不下发。`Metadata.manual` 或 `preset` 的 http 名片可以 `DELETE /api/v1/admin/cards/:capId`；宿主名片返回 409，要改本机 `commands.json`。

「+ 添加 Agent」是三步向导：选择接入类型、填写名字与角色、获取密钥与接入指引。接入类型为云端 HTTP、宿主机 `ah join` 或本机独立 Agent inbox；角色为执行方 `worker` 或派单并接单的 `leader`。`hybrid` 为旧值，等同 `leader`，向导不再提供。云端 HTTP 再选接收方式：定时检查（默认）、常驻长连接、Webhook 推送（要填对方的 URL、密钥，以及可选请求头名）。云端 HTTP 的 worker 与 leader 都预建一张已接纳的默认 `agent` 名片（`CAP-<node>-agent`，`Dispatchable=Yes`，`role` 写成 `leader` 或 `worker`），`Receive_Mode` 按接收方式写入。宿主机与 inbox 不预建卡，由守护进程登记后进入待接纳。云端 HTTP 会同时签发分 Agent Token，明文只在这一次响应和提示词里出现。选了 Webhook 时，响应里的 `webhook` 只有 `url`、`header`、`secret_mask`，不含明文密钥。宿主机与 inbox 的提示词仍用机主 Token 占位符 `<AH_API_TOKEN>`（`ah join` 认的是机主钥匙），并说明这是 `ah daemon` 出站常驻长连接，接入后到「节点 → 待接纳」接纳。定时检查的提示词是脚本门控版：每 5 分钟跑检查脚本，`IDLE` 立即结束，`WORK` 才执行【处理流程】；跑不了脚本时也是每 5 分钟。Leader 的提示词同时包含接单和跟单。常驻长连接的提示词是进程内循环 `poll?timeout=25`（Leader 每轮再拉 `updates?new=1`），断线按 1 / 3 / 8 / 30 秒退避，不建定时任务。Webhook 提示词说明中台用接收端配置的密钥调用 URL，自建接收端可以验签（5 分钟时间窗），并每 30 分钟跑一次检查脚本兜底；不要保存 `A2A_HUB_WEBHOOK_SECRET`。Token 优先存进平台安全密钥空间，名称 `A2A_HUB_TOKEN`，明文只在提示词里出现一次。每次运行无上下文；worker 与接单中的 leader 须在同一次运行内做完所认领任务。接收方式只在添加时选定，控制台不再提供切换。HTTP 节点卡片副标题写上接收方式（如「云端 HTTP 节点 · Webhook 推送 · 执行方 (Worker)」）。所有节点只保留一行「接收方式」。Webhook 这一行右侧是投递徽标和「管理」；弹窗里看 URL、请求头、密钥掩码、最近投递时间与状态、最近错误，以及「Agent 每 30 分钟用检查脚本兜底一次，防止漏推，这不是第二种接收方式」。可改 URL、密钥（留空不变）和请求头，并有「测试」。`DELETE /api/v1/admin/webhooks/:node` 去掉推送配置，并把名片改回 `http-poll`。宿主与 inbox 固定为 ah daemon 常驻长连接。Hub 启动时给 `agent_tokens.json` 里还没有名片的 leader / hybrid 补建那张可派单身份名片，已有名片的 `Admission` 不覆盖。Hub 地址优先取 `node.json` 的 `publicUrl`；未配置时取本次请求的 `Host` 头（`http://<Host>`），没有 `Host` 时回退本机监听地址。在 Hub 本机用 `127.0.0.1` 打开控制台时，务必配置 `publicUrl`，否则远端拿到的地址不可达。Hub 放在 Cloudflare 之后时，浏览器完整性检查会以 `403` / `error code: 1010` 拦下 curl、python-requests、node 等默认 UA，所以云端 HTTP 提示词与 `a2a-leader` / `a2a-worker` Skill 都要求每个请求带浏览器 `User-Agent`，远端节点的 `HttpBus` 与 Webhook 出站也固定发送同一串浏览器 UA。

「定时任务」页只读，调用 `GET /api/v1/schedules`，按节点分组展示 cron、下次触发、指向的能力、启用状态、上次任务（可进任务详情）和异常标记。页顶说明：计划在各节点本地管理，用 `ah schedule` 修改。HTTP Agent 自报的计划 `source` 为 `http-agent`，中台不据此触发。

管理 API（与其他 `/api/v1/*` 一样要 Bearer Token）：

| 方法与路径 | 作用 |
|---|---|
| `POST /api/v1/admin/cards/:capId/admission` | 单卡设为 `admitted` / `pending` / `rejected` |
| `POST /api/v1/admin/nodes/:node/admission` | 该节点全部名片设为同一状态 |
| `PATCH` 或 `POST /api/v1/admin/cards/:capId/profile` | 改 `display_name`（≤64）与 `admin_note`（≤500），只更新传入的键 |
| `POST /api/v1/admin/cards` | 给已存在的 http 节点加一张已接纳能力。body：`node`、`skill_id`（规则同节点名，不能是保留键 `workers`）、可选 `worker`、`skill_name`、`description`、`side_effect`（`read`/`write`，默认 `write`）、`approval_class`（`auto`/`notify`/`approve`，默认 `auto`）、`display_name`、`admin_note`。`Cap_ID` 与 `register` 相同。`Receive_Mode`、Availability 沿用该节点现有名片。Metadata 含 `kind:"agent"`、`manual:true`、`preset:true`。已存在 409；节点不存在 404；宿主节点 409，并尽量附上 `snippet` / `text` / `hint`。成功 201 |
| `DELETE /api/v1/admin/cards/:capId` | 只删 `Metadata.manual` 或 `preset` 的 http 名片，响应 `{ok:true}`。宿主名片 409。仅机主 |
| `POST /api/v1/admin/commands-snippet` | 生成可合并进 `commands.json` 的片段，不下发。有 `worker` 时条目含 `workers`；否则必须有 `command`，`mode` 为 `agent` 或 `json`。响应 `{snippet, text, hint}`。仅机主 |
| `POST /api/v1/admin/agents` | 添加 Agent。`access=http` 时可选 `template`（`generic`/`muse`/`grok-bot`，默认 `generic`；`muse` 强制长轮询、`grok-bot` 强制 Webhook）、`receive`（`poll`/`longpoll`/`webhook`，默认 `poll`）与 `poll_interval_min`（`1–1440` 整数分钟，默认 `poll` 为 `5`、`webhook` 为 `30`、`longpoll` 为 `null`）。`receive=webhook` 时 `webhook_url` 与 `webhook_key` 必填，`webhook_header` 可选（默认 `Authorization`）。角色 `worker` 或 `leader`；传入 `hybrid` 时按 `leader` 签发。一并签发 Token，并预建已接纳的 `CAP-<node>-agent`（`Dispatchable=Yes`，`Metadata.poll_interval_min` 同步写入并通知 Broker）。响应含一次性明文 `token` 与 `onboarding`；Webhook 另含 `webhook:{url, header, secret_mask, legacy}`，不含明文。该节点已有 Token 则 `409`，改走轮换。`access` 不是 `http` 时忽略 `receive`。接收方式在这里选定，没有单独的切换接口 |
| `DELETE /api/v1/admin/agents/:node` | 删除 Agent：先吊销该节点 Token，再删 Webhook 与全部名片，并从在线名册移除。响应含 `tokenRevoked`、`webhookRemoved`、`cardsRemoved`。历史任务与消息保留；`openTasks` 是仍指向它的未结束任务数，需要另行撤销。不能删 Hub 本机；宿主节点要先停掉它的 `ah` 服务，否则下次对账会重新登记名片。什么都没找到时 `404` |
| `GET /api/v1/admin/onboarding` | 只生成接入提示词，不写表。查询参数支持 `template`（仅 `access=http`，默认 `generic`）、`receive`（仅 `access=http`，默认 `poll`）、`poll_interval_min`（`1–1440` 整数分钟）与 `role`（`worker` / `leader`；`hybrid` 按 leader 生成，返回的 `role` 仍是请求值）。未附带刚签发的 Token 时，提示词里是占位符 `<AH_API_TOKEN>`。提示词不包含 Webhook 密钥 |
| `GET /api/v1/admin/webhooks` | 仅机主。`{webhooks:[{node, url, header, secret_mask, legacy, created_at, updated_at, last_status, last_error, last_delivered_at, last_attempt_at}]}`，无明文。`last_attempt_at` 是最近一次尝试（含失败）；`last_delivered_at` 只在 2xx 时更新 |
| `PUT /api/v1/admin/webhooks/:node` | 仅机主。当前 `Receive_Mode` 不是 `webhook` 时 `409`（该节点的接收方式不是 Webhook，不能登记推送）。是 `webhook` 时 body `{url, key? 或 webhook_key?, header? 或 webhook_header?}` 可改 URL 或密钥。新建必须带密钥。更新时密钥留空表示不变。没有 `header` 字段的旧记录只改头名不会开始发送 `Authorization`。`rotate_secret` 忽略。响应 `{ok, webhook}` 用列表同一形状，不含明文 |
| `DELETE /api/v1/admin/webhooks/:node` | 仅机主。没有记录则 404，成功 `{ok:true}`。同时把该节点名片的接收方式改回 `http-poll` |
| `POST /api/v1/admin/webhooks/:node/test` | 仅机主。同步发一次 `ping`，返回 `{ok, status, error}` |
| `GET /api/v1/schedules` | 仅机主。见 §7.6 |

`POST /api/v1/admin/agents`、删除 Agent、Token 管理、`/api/v1/admin/webhooks*`、`commands-snippet`、`DELETE /api/v1/admin/cards/:capId` 与 `GET /api/v1/schedules` 只允许机主。名片接纳、改显示名、`GET /api/v1/admin/onboarding`，以及 `POST /api/v1/admin/cards`，也允许 `scopes` 含 `admin` 的 leader（旧值 `hybrid` 同样）；其中 `onboarding` 的查询参数 `node` 可以是别的节点。协议 Skill 按接入方式对应，URL 为 `<Hub>/api/v1/skills/<name>`，**需要鉴权**：云端 HTTP 的 `worker` → `a2a-worker`，`leader`（含旧值 `hybrid`）→ `a2a-worker` 与 `a2a-leader`；`inbox` → `ah-inbox`；宿主机 Worker 不需要协议 Skill（回执约定由内核写进调度指令）。领域技能放在各 Agent 自己的技能目录（如 `~/.claude/skills`、`~/.agents/skills`），中台不登记、不展示。

远端节点上升级前没有 `Admission` 的老名片，仍按待接纳，要在控制台接纳后才能派单。Hub 本机的空 `Admission` 由对账补成已接纳。

### 7.5 分 Agent Token

外部 HTTP Agent 每人一把 Token，与机主 `apiToken` 分开。账本是配置目录 `agent_tokens.json`（0600）。文件里是 `version: 1` 和 `tokens[]`：`node`、`role`、`scopes`、`hash`（`sha256:` 前缀）、`prefix`（展示用，不含完整密钥）、`created_at`、`last_used_at`。`last_used_at` 同一节点同一分钟最多写一次。明文格式为 `aht_` 加 32 字节 base64url，只在签发或轮换的 JSON 里出现一次。

未配置机主 `apiToken` 时拒绝签发：否则账本里一有 Token，鉴权就会打开，机主自己进不了管理接口。一份机主 Token 和 Agent Token 都没有时，`/api/*` 仍免鉴权。有了任一种钥匙之后，除 `/`、`/api/v1/health`、`/.well-known/agent.json` 外都要 Bearer，包括 `/api/v1/skills`、`/api/v1/skills/:name` 与 `/api/v1/kit/a2a_check.py|.sh`。

| 方法与路径 | 谁能调用 | 作用 |
|---|---|---|
| `GET /api/v1/admin/tokens` | 仅机主 | 列出节点、角色、scopes、前缀与时间，不含哈希与明文 |
| `GET /api/v1/admin/audit` | 仅机主 | 名录变更只追加日志。查询参数 `table`、`node`、`limit`（1–500）。没有审计表时 `{logs:[]}` |
| `POST /api/v1/admin/tokens/:node/rotate` | 仅机主 | 重新生成。body 可带 `role`、`scopes`、`template`；省略则沿用旧值（`template` 缺省时从该节点名片的 `Metadata.template` 推导，默认 `generic`）。没有旧记录时必须给 `role`。响应含新明文和已嵌入该 Token 的接入提示词 |
| `DELETE /api/v1/admin/tokens/:node` | 仅机主 | 吊销。不存在则 `404` |

控制台添加 HTTP Agent 时 `scopes` 为空。要让某个 Leader 代管接纳，轮换时写 `{"scopes":["admin"]}`。轮换 body 里的 `role=hybrid` 会存成 `leader`；省略 `role` 时保留账本里的旧值（含历史 `hybrid`）。

路由矩阵在 `src/hub/agent-access.mjs`。`hybrid` 为旧值，等同 `leader`：

- 所有 Agent：`GET /api/v1/skills`、`GET /api/v1/skills/:name`、`GET /api/v1/kit/a2a_check.py`、`GET /api/v1/kit/a2a_check.sh`、`POST /api/v1/agents/register`、`GET /api/v1/agents`、自己的 `GET /api/v1/agents/:node/check`。
- worker：自己的 `poll` / `inbox`，以及 `claim`、`heartbeat`、`complete`、`fail`、`ask`、`auth`。不能派单。
- leader：worker 的全部，再加上自己的 `updates`；`GET`/`POST /api/v1/tasks`；自己发起或指向自己的任务详情；答复、撤销只限自己发起的任务；`loops` 的列表与取消只限自己发起的。
- `scopes` 含 `admin` 的 leader：`POST /api/v1/admin/cards/:capId/admission`、`POST /api/v1/admin/nodes/:node/admission`、profile、`GET /api/v1/admin/onboarding`，以及 `POST /api/v1/admin/cards`（给别的节点加能力）。不能 `DELETE` 名片。
- 任何角色：`PUT` / `DELETE /api/v1/agents/:node/schedules/:id`，且只能操作 Token 绑定的节点。这是自报计划，中台不据此触发。
- 一律拒绝：`/api/v1/approvals/*`、`/api/v1/admin/agents`、`/api/v1/admin/tokens*`、`/api/v1/admin/webhooks*`、`/api/v1/admin/commands-snippet`、`GET /api/v1/admin/audit`、`DELETE /api/v1/admin/cards/:capId`、`/api/v1/schedules`、`/api/v1/state`、`/api/v1/tables/*`、`/api/v1/poll`。

`GET /api/v1/agents/:node/check` 是给定时脚本的只读探测。`tasks` 与 `poll` 的可认领任务同一口径，`working` 是本节点已认领且仍为 `working` 的任务。`updates` 是自持久水位以来 `updates?new=1` 会返回的条数（含仍待处理的 `input-required` / `auth-required`）。leader（含旧值 `hybrid`）同时返回这三项。它不写水位，所以随后的 `updates?new=1` 仍能看到这些变化。唯一副作用是刷新该节点在线状态。Agent Token 按绑定角色计算；机主调用可用查询参数 `role`（`worker` / `leader` / `hybrid`，缺省 `leader`，即接单和跟单都算）。空闲时 `{"work":false}`。检查脚本与无脚本回退都是每 5 分钟。

检查脚本由 Hub 按文件返回（`skills/a2a-check/`），正文不含 Token。Token 读取顺序是环境变量 `A2A_HUB_TOKEN`、`--token-file`、`--token`。脚本输出：空闲一行 `IDLE`（`--silent-idle` 则不输出），有事先 `WORK` 再一行 JSON，出错一行 `ERROR ...` 且退出码 2。请求带浏览器 `User-Agent`。

路径上的节点、查询参数 `node`/`from`、请求头 `X-A2A-Node` 与绑定节点不一致返回 403。body 里这两个字段省略时补成绑定节点。`/api/v1/agents/:node/schedules/:id` 的路径节点同样不能冒充。任务列表会藏掉与自己无关的任务。

### 7.6 Webhook 账本与定时任务只读接口

`agent_webhooks.json` 由 `src/hub/webhooks.mjs` 读写。字段见 [标准 §10.3](standard.md)。不要把真实 URL 或 `secret` 写进仓库、日志或提示词以外的回复。

定时任务汇总读 Rules 镜像行（`Rule_ID=<Node>:<Schedule_ID>`），不改本机 `schedules.json`：

| 方法与路径 | 谁能调用 | 作用 |
|---|---|---|
| `GET /api/v1/schedules` | 仅机主 | `{schedules:[{rule_id, node, schedule_id, cron, tz, cap, text, enabled, last_fired, next_fire_at, source, note, last_task, anomaly}]}`。`source` 为 `node`（守护进程镜像）或 `http-agent`（Note 含「http-agent 自报」）。`last_task` 为 `{task_id, status, updated_at}` 或 `null`，按幂等键 `sched:<Node>:<Schedule_ID>:<期次键>`、Note 里的「上次运行」、或同前缀最近一条关联。`next_fire_at` 为 ISO 或空字符串。`anomaly` 先看节点离线（`node-offline`），再看最近任务 `failed`/`rejected`（`failed`），再看启用中的计划该触发却超过 10 分钟没有 `Last_Fired`（`missed`） |
| `PUT /api/v1/agents/:node/schedules/:id` | 该节点自己的 Agent Token（任何角色）或机主 | body `{cron, tz?, cap?, text?, enabled?}`。`id` 只允许字母、数字、短横线或下划线，最长 64。写入 Rules 镜像，Note 为「http-agent 自报」（有时区则加 `tz=`）。响应 `{ok, rule_id, at}`。中台不按这行建单 |
| `DELETE` 同路径 | 同上 | 删除该镜像行。不存在则 404 |

## 8. 附件与文件存储

中台托管附件（`hub://files/<file_id>`）的目录、配置与接口如下（完整协议见 [attachments.md](attachments.md)）：

- **存储目录**：`<configDir>/files/`，内含 `blobs/`（按 `file_id` 前 2 位分片存储原始文件，目录权限 `0700`、文件权限 `0600`）与 `files.db`（`node:sqlite` WAL 索引）。
- **`node.json` 配置**：可选 `maxFileBytes`（单文件字节上限，默认 `104857600`，即 100MB）。
- **HTTP 接口**：需 Bearer Token（下文以 `$A2A_HUB_TOKEN` 占位）；可见性限于机主、上传者或能看到引用任务的 Agent；已清理文件下载返回 `410`。
  - `POST /api/v1/files`：请求体为文件原始字节，`Content-Type` 填 MIME（缺省 `application/octet-stream`），`X-File-Name` 填 URL 编码后的文件名。
  - `GET /api/v1/files/:id`：流式下载（加 `?inline=1` 时常见位图按 `inline` 返回，否则为 `attachment`）。

```bash
# 上传附件（返回 201 JSON，含 file_id 与 uri）
curl -sS -X POST "http://<HUB>:8787/api/v1/files" \
  -H "Authorization: Bearer $A2A_HUB_TOKEN" \
  -H "Content-Type: text/plain" \
  -H "X-File-Name: report.txt" \
  --data-binary @./report.txt

# 下载附件
curl -sS -L "http://<HUB>:8787/api/v1/files/<file_id>" \
  -H "Authorization: Bearer $A2A_HUB_TOKEN" \
  -o ./report.txt
```

- **CLI 新参数**：
  - `ah task create`、`ah task reply`、`ah inbox ask`、`ah inbox auth`：支持可重复的 `--file <路径>`（`task create` 与 `task reply` 在传入 `--file` 时可省略 `--text`）。
  - `ah inbox done`：支持可重复的 `--artifact <路径或URL>`。
