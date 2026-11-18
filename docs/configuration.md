# 配置与命令参考

本文承接 [README](../README.md) 里放不下的细节：配置目录、`node.json` / `commands.json`、机器类型、CLI 速查、本机状态文件。
规范性约定以 [中台标准](standard.md) 为准，这里只讲怎么配、怎么用。

## 1. 配置目录

配置目录取 `--config <dir>` > 环境变量 `HUB_NODE_HOME` > `~/.hub-node`（Windows 为 `%USERPROFILE%\.hub-node`）。已安装旧版 lark-a2a-hub 时，请把新 Hub 放到独立目录（例如 `HUB_NODE_HOME="$HOME/.a2a-hub"`），不要覆盖仍在运行的 `~/.hub-node`。里面有：

| 文件 | 作用 | 能否提交仓库 |
|---|---|---|
| `node.json` | 节点身份、总线参数（`sqlite` / `http`）、长轮询与对账周期、角色 | 否 |
| `commands.json` | 能力表：本机能干什么、怎么干 | 否 |
| `schedules.json` | 定时调度表：本机定时任务计划（`id`, `cron`, `cap`, `text` 等） | 否 |
| `app.env` | HTTP Bearer 访问口令 `LAH_API_TOKEN`，权限 600 | 绝不 |
| `approval_key.pem` | `role=hub` 的 ed25519 审批签名私钥，权限 600 | 绝不 |
| `hub.db` / `hub.db-wal` / `hub.db-shm` | `role=hub` SQLite WAL 主数据库文件 | 绝不 |
| `runs/<Task_ID>/` | 每次执行的输入、输出与在途账本（`entry.json`） | 否 |
| `retry_state.json` `approval_state.json` `present_state.json` `stale_state.json` `schedule_local_state.json` | 节点私有状态与水位，非协议字段 | 否 |
| `present_queue.jsonl` `present_bell` `present_queue.jsonl.lock` | 发给本机 Agent 的回执队列、门铃，以及队列锁。锁是临时文件；没有 `ah present` 在跑且守护进程空闲时可以删 | 否 |
| `agent_inbox.jsonl` | `kind=agent` 节点的收件箱 | 否 |

仓库里只有占位符样例：[`config/hub.standalone.example.json`](../config/hub.standalone.example.json)、[`config/node.remote.example.json`](../config/node.remote.example.json)、[`config/commands.example.json`](../config/commands.example.json)、[`config/schedules.example.json`](../config/schedules.example.json)。

## 2. node.json

节点身份（`node` / `zone`）、总线模式（`busType`: `sqlite` 或 `http`）、访问口令来源（`appEnv` 指向 `0600` 的 `LAH_API_TOKEN`）、长轮询与对账周期。

- `role`：`node` 或 `hub`，缺省 `node`。`ah daemon`、`doctor`、`service` 省略 `--role` 时读它。
- `busType`：`sqlite`（Hub 主中枢）或 `http`（远端长轮询节点）。
- `longPollSec`：长轮询单次挂起秒数（默认 `25`）；`pollSec`（默认 `45`）是 `poll` 模式的定时轮询间隔；`sweepSec`（默认 `900`，即 15 分钟）是对账兜底。
- `hubPublicKey`：hub 的审批签名公钥（base64）。`ah join` 会从 `GET /api/v1/health` 自动拉取写入；配了它，本节点只认 hub 私钥签过的 `auth_decision`。hub 自己私钥在配置目录 `approval_key.pem`（600，首次启动自动生成），公钥由私钥推出。详见 [SECURITY.md](../SECURITY.md)。
- `tz`：IANA 时区名，缺省 `Asia/Shanghai`。决定本地定时调度的 cron 墙钟与期次键偏移，与宿主机时区及系统 `TZ` 环境变量无关。

## 3. 机器类型：host 与 agent

`ah setup [--kind host|agent]` 的向导支持：

- **`kind: host`（电脑宿主，默认）**：扫描识别本机已装的 Agent（Claude Code、Codex、agy、Paseo、Grok CLI 等），把它们登记为 `commands.json` 里的 Worker；守护进程认领任务后拉起本机命令干活。
- **`kind: agent`（本机独立 Agent，有守护进程壳）**：Agent 自己就是干活的人。setup 不扫描 PATH、不注册外部 CLI，只登记一张本尊 Worker 名片 `agent`（`mode: inbox`）。守护进程认领任务后写入本地 `agent_inbox.jsonl` 并刷新心跳，由本尊调 `ah inbox` 接单、办完回执。

> [!IMPORTANT]
> **Skill 自动匹配安装**：`ah setup` / `ah update` 会按当前节点 `role` 与 `kind` 向 `~/.agents/skills/` 精确写入本地 CLI Skill（`kind=host` 仅安装主控端 `ah`；`role=node, kind=agent` 仅安装执行端 `ah-inbox`；`role=hub, kind=agent` 两者都装）。云端或定时唤醒、无法运行守护进程的外部 Agent（如 **Muse Leader**、**Grok Bot**）无需跑 `ah setup`，直接通过 Hub 的 HTTP Agent 网关（`GET /.well-known/agent.json`、`GET /api/v1/skills/a2a-leader|a2a-worker`、`POST /api/v1/agents/register`、`GET /api/v1/agents/{node}/poll|updates`）接入即可，详见 [外部 HTTP Agent 运行手册](protocol-node-runbook.md)。

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
| `context` | 只有 `direct`（默认，可省略，守护进程直接拉起）。取值非法时任务直接 `rejected`，不静默降级。旧配置写了 `carrier` 的能力已移除，需改为 `direct` 或删除 |
| `timeout_sec` | 单次执行上限，默认 600 |
| `verify` | 可选。一条本机 shell 命令，与 `command` 同一可信等级，原样执行，不做 `{prompt}` / `{session}` 替换。只支持 `context=direct` 的 `json` / `agent`。Skill 条目优先，Skill 未写时用其 Worker 条目的值。`mode=inbox` 写了是配置错误：认领预检 `rejected` + notice，`ah doctor` 报问题，不静默忽略。命令必须只读、可重复。执行者的数据不拼进命令，只经两条通道：stdin 一行 JSON `{"task_id","summary","artifact","artifact_name","checks"}`，以及环境变量 `LAH_TASK_ID`、`LAH_ARTIFACT`、`LAH_RUN_DIR`、`LAH_MAIN_STDOUT` |
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
2. **清空在途任务**：`ah inventory --config <dir>` 确认本节点没有 `submitted`、`working`、`input-required`、`auth-required` 的任务，有就等它们结束、答复或撤掉。不清空的后果：以旧 Skill_ID 寻址的任务迁移后会被拒收并带 notice（不会静默跑错），但会白丢一次执行或一轮问答。另外到 Base 的 Tasks 表看一下有没有目标是本节点、已 `completed`、`Metadata` 里有 `later` 但还没有 `later_fired` 的任务，有就等它触发后再迁，否则 hub 会因为找不到旧 Skill_ID 而一直建单失败。
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
- **Agent 类节点（`kind: agent`，如 Muse、Grok 等）**：使用 Agent 自身定时器到点调用 `ah task begin` 建单，由本机守护进程认领写入收件箱，Agent 处理完后调用 `ah inbox done`。

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

具有内置定时调度能力（如 Muse 或常驻 Grok 任务）的独立 Agent，接入流程：
1. **登记镜像**：`ah schedule register --id AGENT-MORNING --cron "0 9 * * *" --cap agent --text "每日早间同步"`
2. **到点建单**：Agent 定时器触发时运行 `ah task begin --schedule AGENT-MORNING --text "每日早间同步"`
3. **认领接单**：本节点 `ah daemon` 认领该任务写入 `agent_inbox.jsonl`
4. **处理并交付**：Agent 读取收件箱，完成后调用 `ah inbox done --task <Task_ID> --text "已完成同步"`

### 5.6 Rules 观察镜像与自检

- **单向观察镜像**：节点将本机每条计划镜像为 Rules 一行（`Rule_ID=<Node_ID>:<Schedule_ID>`）。任何节点**绝不从 Rules 读计划触发任务**，手动修改 Rules **不影响本地实际执行**。
- **升级顺序：先升级 hub，再升级各节点。** 旧版本 hub 仍会把 Rules 里 `Enabled=Yes` 且 `Schedule` 非空的行当成计划建单；新版节点一旦写入镜像行，就会被旧 hub 误触发，造成同一计划双跑。迁移存量计划（如 `SCHED-HUB-MORNING`）时，先把 Rules 旧行 `Enabled` 置 No，再用 `ah schedule add` 在对应节点落计划。
- **已知限制：定时任务中途提问需要人答复。** 本地定时任务的发起方是本节点自己，`question` 会原路回给本节点并进入 `present_queue.jsonl`，需要本机 Agent 消费后执行 `ah task reply`。无人值守时任务会停在 `input-required`，hub 的陈旧告警只处理 `working` 与无人认领的 `submitted`，不会提醒。无人值守的计划请选不会提问的能力。
- **`ah doctor` 增检**：存在 `schedules.json` 时，自检会逐条验证 cap 存在性、cron 表达式合法性、时区 `tz` 合法性与控制键拦截。若有异常仅打印告警，不改变 doctor 退出码，不阻断守护进程启动。时区检查放开至所有含有 `schedules.json` 的节点。

## 6. CLI 速查

`ah` 是主入口（兼容别名 `a2a-hub`、`ahub`、`lah` 与 `hub-node`）。以下 `--config <dir>` 均可省略（见第 1 节）。

| 命令 | 作用 |
|---|---|
| `ah up` / `ah join <url>` | 一键初始化 SQLite Hub 或接入远端 HTTP 节点，自动配置 Token、公钥与自启 |
| `ah setup [--role node\|hub] [--bus sqlite\|http] [--kind host\|agent] [--wake longpoll\|poll] [--skip-skill]` | 交互/非交互初始化：写 `app.env` 与 `node.json`、生成 `commands.json`、自检、可选注册自启 |
| `ah daemon [--role node\|hub]` | 常驻守护进程 |
| `ah doctor [--role node\|hub]` | 只读自检：配置合法性、连通性、能力登记、本地计划 |
| `ah service [--role node\|hub] [--remove]` | 注册（或卸载）开机自启：macOS LaunchAgent / Linux systemd 用户服务 / Windows 当前用户的任务计划程序（登录时启动，无需管理员）。日志在配置目录 `daemon.log` |
| `ah update [--check] [--skip-skill]` | 自更新程序本体：git pull、依赖重装、入口与 Skill 补齐；不碰配置目录。`--check` 只看远端有没有新版本。tarball 安装请重跑 install.sh（Windows 为 install.ps1） |
| `ah reconcile` | 单次回表认领与对账后退出 |
| `ah inventory` | 只读盘点本节点名片与任务 |
| `ah task create --to <node> [--worker <worker>] [--cap <cap_id 或技能名>] [--text …] [--params <json 或 @文件>] [--criteria <json 或 @文件>] [--idempotency-key <键>] [--from <node>]` | 派单。写表前按 AgentCards 名册校验 `--to` 与 `--cap`。`--criteria` 写入首条 instruction 的验收清单 |
| `ah task reply --task <id> --text …` | 答复 `input-required` 的追问，原任务续跑 |
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
| `ah inbox [--pop] [--json]` | `kind=agent` 接单 |
| `ah inbox done\|ask\|fail\|auth --task <id> --text …` | 完单（可带 `--artifact`，可重复 `--check <id>=<pass\|fail\|blocked>[:证据]`）、追问、失败、执行中请求审批回执 |

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

口径：一行里的 `list` / `get` / `write` / `other` / `backoff` 是自上一次这样的行以来的增量。把一天里的 `sweep end` 和 `scan` 行相加，就是该进程当天发出的记录请求，包含扫表间隙里 60 秒定时心跳，不含 `ah task create` 这类一次性进程，也不含进程启动到第一行之间的请求。四个分类是实际发出的 HTTP 请求数（含重试的那几次），`backoff` 是其中因退避而重发的次数。换票用的 tenant token 请求不进这些数。日志不写凭据、Base token、table_id、record_id 和请求路径。

`api backoff` 通常用于请求退避与重发定位，一般日志不写凭据、Token 与隐私字段。

## 7. 独立中台（SQLite Hub）、长轮询节点与外部 HTTP Agent / LoopForge SOP

`a2a-hub` 统一采用 `sqlite`（Hub 主中枢）+ `http`（远端宿主长轮询 / 纯外部 HTTP Agent）运行。配置样例见 [`config/hub.standalone.example.json`](../config/hub.standalone.example.json) 与 [`config/node.remote.example.json`](../config/node.remote.example.json)。

### 7.1 `node.json` 独立中台与长轮询字段

| 字段 | 适用角色 | 说明 |
|---|---|---|
| `busType` | 全部 | 总线类型：`sqlite`（`role=hub` 默认）或 `http`（填写了 `hubUrl` 时的远端节点） |
| `dbPath` | Hub (`sqlite`) | SQLite WAL 数据库文件路径，支持相对配置目录路径，默认 `hub.db` |
| `listen` | Hub (`sqlite`) | HTTP API 与 Web 控制台绑定地址，格式 `<host>:<port>`，默认 `0.0.0.0:8787` |
| `publicUrl` | Hub (`sqlite`) | 可选外部访问地址（如 `http://192.168.1.10:8787` 或 Tailscale 地址），用于生成外部通知跳转链接 |
| `apiToken` | Hub / 远端 `http` 节点 | 接口鉴权 Bearer Token。建议放在 0600 权限的 `app.env` 环境变量 `LAH_API_TOKEN` 中，不直接提交到代码库 |
| `hubUrl` | 远端节点 (`http`) | 中台 HTTP 根地址，如 `http://192.168.1.10:8787` |
| `longPollSec` | 全部模式 | 长轮询单次挂起秒数，默认 `25`（服务端安全夹紧在 5–60 秒） |
| `notifications` | Hub (`sqlite`) | 可选外部提醒配置对象：`feishuWebhookUrl`（群自定义机器人）、`barkUrl`、`telegramBotToken`、`telegramChatId`、`webhookUrl`、`events`（默认 `auth-required`、`input-required`、`completed`、`failed`、`rejected`，另可加 `stale`） |

### 7.2 快速启动与接入方式

- 一键启动主中台 Hub：`ah up [--listen 0.0.0.0:8787] [--service]`（自动生成 SQLite 库、`app.env` 随机口令与 `approval_key.pem` ed25519 密钥对）
- 一键接入远端电脑：`ah join http://<TOKEN>@<HUB>:8787 [--service]`（自动抽离口令至 `app.env`、拉取 `hubPublicKey` 并启动只出站长轮询守护）
- 手动非交互配置：
  - `ah setup --role hub --bus sqlite [--listen 0.0.0.0:8787] [--db-path ./hub.db] [--public-url http://...] [--api-token <token>] [--yes]`
  - `ah setup --role node --bus http --hub-url http://<HUB>:8787 --api-token <token> [--hub-key <pubkey>] [--yes]`
- **纯 HTTP 外部 Agent（Muse Leader / Grok Bot 等无守护进程 Agent）**：直接访问 Hub HTTP 网关（`GET /.well-known/agent.json`、`POST /api/v1/agents/register`、`GET /api/v1/agents/{node}/poll|updates`），无需安装本地 `ah` 进程，完整接口规范见 [外部 HTTP Agent 手册](protocol-node-runbook.md)。

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
