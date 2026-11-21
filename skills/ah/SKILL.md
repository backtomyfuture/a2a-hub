---
name: ah
description: 操作与调度 a2a-hub (ah) 多 Agent 协作中台（控制端/调度者 CLI 版）：查询在册节点与能力名片、派发跨节点异步任务与 Context_ID 多轮会话续接、等待原路返回的结果队列、答复追问、查看任务全链与撤单。仅用于装有 ah CLI 的 Hub 或工作机主控 Agent；接单执行方请用 ah-inbox（本机独立 Agent）或 a2a-worker（纯 HTTP Agent）。
---

# `ah` 控制端调度 Skill（有 CLI 的中控 / 发单方）

你正在装有 `ah`（`a2a-hub`，别名 `ahub`）命令行工具的宿主机器上担任**调度协调者（控制端 / 发单方）**。你的职责是把用户意图拆解并派发给最合适的在册节点/Agent、追踪执行进展与追问、把结果带回给用户。

> **边界守则**：
> - 本 Skill **只负责派单与收单**，不处理 `ah inbox`（执行端收件箱命令）或 `ah setup`/`doctor`（人工运维命令）。
> - **审批红线**：遇到 `auth-required` 时，只转告用户前往 Hub Web 控制台或签名审批接口批准/驳回；**严禁**替机主做审批决定。
> - **原任务闭环**：遇到 `input-required` 追问时，必须用 `ah task reply` 追加到原任务，**严禁**为答复新开任务。

---

## 一、派单前：盘点在线节点与能力 (`ah inventory`)

先查看当前在册节点、Worker、专长技能及在途任务数（三层寻址：`Node → Worker → Skill`）：

```bash
ah inventory [--json]
```

如果开启了远程/云端 HTTP Agent（如 `grok-bot`、`muse`），也可以让用户输入或在 Hub Web 控制台 / `GET /api/v1/agents` 查看实时在线状态。只能向已接纳名片派单：`ah inventory` 每行有 `Admission=`，`GET /api/v1/agents` 看 `caps[].admission`，须为 `admitted`。

---

## 二、派发单次异步任务 (`ah task create`)

```bash
ah task create \
  --to <Target_Node> \
  [--worker <Worker>] \
  [--cap <Skill_ID 或 Cap_ID>] \
  [--schedule <Schedule_ID>] \
  [--text "<清晰可执行的指令说明>"] \
  [--file <本地文件路径>]... \
  [--params '<JSON字符串或@文件>'] \
  [--criteria '<验收清单JSON数组或@文件>'] \
  [--approval auto|notify|approve] \
  [--context <Context_ID>] \
  [--idempotency-key <幂等键>]
```

- `--file` 可重复（单条消息最多 20 个附件），本地文件会先上传为 `hub://files/<file_id>`；传入 `--file` 时 `--text` 可省略。执行器在 `runs/<Task_ID>/input.json` 的 `files[]` 中读取附件（已下载填 `local_path`，失败时 `error` 为 `expired`、`not_found` 或 `download_failed`）。

- **三层寻址**：
  - 只写 `--to <node>`：自动挑选该节点首选 Worker（`Skill_ID=agent`）。
  - 指定 `--to <node> --worker <W>`：硬约束由指定 Worker（如 `claude`、`agy`）执行。
  - 指定 `--cap <skill>`（如 `ops-check`）或完整 `CAP-...`：定位专长技能。
- **验收清单 (`--criteria`)** 示例：
  `--criteria '[{"id":"c1","text":"输出巡检结论","verify":"agent"},{"id":"c2","text":"附上日志摘要","verify":"agent"}]'`
- 命令成功输出 `Task_ID`（如 `TASK-20261115-a1b2c3`）。

---

## 三、多轮上下文续接（`--context` / `Context_ID`）与多阶段串联

当任务已经终态、需要向同一 Worker 继续追问，或要把前一步的结果接力给下一步时，传入同一个 `--context <Context_ID>` 串联上下文（首轮新建任务会分配并输出 `Context_ID`）：

```bash
# 第一步：启动新上下文（查看输出中的 Task_ID 与 Context_ID）
ah task create \
  --to <Target_Node> \
  [--worker <Worker>] \
  --text "<第一轮任务说明>"

# 后续轮次：传入同一 --context，本地 CLI Worker 自动复用上轮 Session_ID 并注入 context_history
ah task create \
  --to <Target_Node> \
  [--worker <Worker>] \
  --context <Context_ID> \
  --text "<追问或下一阶段指示>"
```

- 同一个 `Context_ID` 下，本地 CLI Worker 会自动查找上一轮持久化的 `Session_ID`（如配置了 `resume_command`）继续上下文对话，同时在 `runs/<Task_ID>/input.json` 中获得 `context_history`（历史已完成任务摘要）。
- 如果需要更精细控制验收，可在每轮附带 `--criteria` 与前序结论指针。

---

## 四、等待与消费原路回执 (`ah present`)

任务完成、失败、被拒、取消或提出追问（`input-required`）时，本机 `ah daemon` 会把回执写入本地 `present_queue.jsonl`：

```bash
# 当前会话阻塞等待某张单的结果并消费（建议 --wait 短于宿主命令超时，如 100 秒）
ah present --wait 100 --task <Task_ID> --pop

# 非阻塞读取当前队列
ah present [--pop] [--task <Task_ID>]
```

- 退出码 `0`：拿到了匹配的 NDJSON 回执（关键字段：`task_id`, `status`, `title`, `target_node`, `message`, `outcome`, `error`, `text`）。
- 退出码 `2`：超时未回执，可告知用户任务仍在运行并稍后再查，或再次调用 `--wait`。
- 多个在途任务并发时，**务必**带上 `--task <Task_ID>`，避免提前消费掉其他任务的回执。

---

## 五、答复追问 (`ah task reply`)

当回执状态为 `input-required` 时，向原任务追加答复（目标节点或 HTTP Worker 将自动恢复执行），然后再次等待结果：

```bash
ah task reply --task <Task_ID> [--text "<补充信息或明确选择>"] [--file <本地文件路径>]...
```
- `--file` 可重复（最多 20 个）；传入 `--file` 时 `--text` 可省略。

---

## 六、查详情、全链排障与撤单 (`show` / `why` / `cancel`)

```bash
# 实时查看状态、最新消息与产物
ah task show <Task_ID>

# 全链时间线溯源（Tasks / Messages / Parts / Artifacts / 验收结论）
ah task why <Task_ID> [--json]

# 撤销尚未终态的任务（非 hub 节点只能撤本节点发起的单）
ah task cancel --task <Task_ID> [--text "<取消原因>"]
```
