# a2a-hub v2.0 协议与数据规范（权威）

## 1. A2A 八态任务生命周期

任何任务记录在其生命周期内严格位于以下八种状态之一：

| 状态 | 含义 | 允许迁移到的下一状态 |
| --- | --- | --- |
| `submitted` | 已提交排队，等待认领 | `working`, `auth-required`, `canceled`, `rejected` |
| `working` | 已由执行者锁定（持有租约 `lease_until`）执行中 | `completed`, `failed`, `submitted` (可重试/租约超时重排), `input-required`, `auth-required`, `canceled` |
| `input-required` | 执行阻塞，等待发起方或机主补充回答 | `submitted` (收到 `reply`), `canceled` |
| `auth-required` | 命中高危规则或预检策略，等待机主签名放行 | `submitted` (机主签名 `approve`), `rejected` (机主 `deny`), `canceled` |
| `completed` | 成功完成（终态，不可重开） | — |
| `failed` | 执行失败且耗尽重试预算（终态） | — |
| `canceled` | 发起方或机主主动取消（终态） | — |
| `rejected` | 审批被拒或参数违反安全策略（终态） | — |

> 例外说明（外部自管定时归档 `source = 'edge_cron'`）：外部 Bot 自管定时任务不由中台派单，平时成功或空转（`noop`）仅更新 `schedules` 打卡账本、不写 `tasks` 表；仅当运行失败（`failed`）、携带附件（`attachments`）或显式指定 `record_task: true` 时，直接写入一条终态任务（`completed` 或 `failed`）及对应的单条 `receipt` / `error` 消息，不经过 `submitted` 与 `dispatch`。

## 2. 只追加消息日志（`messages`）

每条状态跃迁都会在 `messages` 表追加一条不可篡改的记录（`dispatch`、`status`、`question`、`answer`、`auth_request`、`auth_decision`、`receipt`、`error`、`retry`、`cancel`），任何正常流转接口均不得修改或删除历史消息。

> 例外说明（机主清理终态废单 / 废线程）：仅当机主（`owner`）主动调用 `DELETE /api/v1/tasks/:id`（仅限终态任务）或 `DELETE /api/v1/threads/:contextId`（仅限不含活跃任务的线程）清理废单时，允许级联物理删除该任务 / 线程下的历史消息（`messages`）与附件关联（`file_links`）。

## 3. 核心 REST 接口总览

- **健康与发现（免鉴权）**：
  - `GET /api/v1/health`
  - `GET /.well-known/agent.json`
- **认证与控制台状态**：
  - `GET /api/v1/auth/session`, `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`
  - `GET /api/v1/state` (`owner`)
  - `GET /api/v1/poll?since=<seq>&timeout=<sec<=40>` (`owner`)
- **电脑宿主设备**：
  - `POST|GET /api/v1/devices`, `PATCH|DELETE /api/v1/devices/:id`, `POST /api/v1/devices/:id/rotate-token` (`owner`)
  - `POST /api/v1/devices/:id/sync`, `GET /api/v1/devices/:id/poll` (`device` 仅限自身或 `owner`)
- **Agent 管理与协作**：
  - `GET /api/v1/agents`（全网已激活能力目录，不含敏感密钥）
  - `POST /api/v1/agents`, `PATCH|DELETE /api/v1/agents/:id`, `POST /api/v1/agents/:id/rotate-token`, `GET /api/v1/agents/:id/onboarding`, `POST /api/v1/agents/:id/webhook-test` (`owner`)
  - `POST /api/v1/agents/register`, `GET /api/v1/agents/:id/{check,poll,inbox}` (`agent` 仅限自身或 `owner`)
  - `GET /api/v1/agents/:id/updates?since=<seq>&new=1` (`leader` 仅限自身或 `owner`)
- **定时调度与状态报备（`schedules`）**：
  - `GET /api/v1/schedules` (`owner`)
  - `POST /api/v1/schedules/:sid/runs`（`agent` 自动绑定自身身份，或 `owner` 指定 `agent_id`；默认返回精简 JSON，传 `full=1` 返回完整详情）
  - `GET /api/v1/agents/:id/schedules`（`agent` 仅限自身或 `owner`）
  - `POST /api/v1/agents/:id/schedules/:sid/runs`（`agent` 仅限自身或 `owner`；默认返回精简 JSON，传 `full=1` 返回完整详情）
  - `PUT|DELETE /api/v1/agents/:id/schedules/:sid`（`driver='hub'` 严格限 `owner`；`driver='edge'` 限 `owner` 或该 `agent` 本身）
  - `POST /api/v1/agents/:id/schedules/:sid/trigger`（严格限 `owner`，且仅对 `driver='hub'` 或 `triggerable=true` 的条目开放）
  - `POST /api/v1/agents/:id/schedules/:sid/ack`（严格限 `owner`；`failing` 仅消红旧失败不动排期，`missed` 清除超时告警并顺延至下个周期窗口）
- **任务、线程、审批与文件**：
  - `POST /api/v1/tasks`（支持单目标或 `to: [...]` 数组并发扇出，`owner` 或 `leader`）
  - `POST /api/v1/tasks/claim`（Device 跨启用 Worker 批量认领下一条）
  - `POST /api/v1/tasks/resolve-all`（严格限 `owner`，支持可选 `context_id` / `since_ms` 精确范围，批量将未处理的失败/已拒绝任务标为已处理以消红）
  - `POST /api/v1/tasks/:id/{claim,heartbeat,complete,fail,ask,auth,reply,cancel}`
  - `POST /api/v1/tasks/:id/{resolve,retry}`、`DELETE /api/v1/tasks/:id`（严格限 `owner`；`resolve` 标为已处理、`retry` 由机主接管同线程重派并自动消红旧失败且报告过期剔除附件、`DELETE` 仅允许删除已结束的终态任务并级联清理其历史消息）
  - `POST /api/v1/approvals/:taskId/decide`（**严格限 `owner`**，使用 Ed25519 私钥签名）
  - `GET /api/v1/threads`, `GET|DELETE /api/v1/threads/:contextId`（`DELETE` 严格限 `owner`，且仅允许删除不含活跃任务的线程）
  - `POST /api/v1/files`, `GET /api/v1/files/:id`, `GET /api/v1/files/:id/meta`

## 4. 定时任务双模式规范（`hub` / `edge`）

- **默认时区**：未显式指定 `timezone` 时统一使用 Hub 配置的 `AH_TIMEZONE`（默认固定为 `Asia/Shanghai`），不读取运行宿主机系统时区，确保云端容器（UTC）与控制台展示一致。
- **中台派发（`driver = 'hub'`）**：仅 `owner` 可增改删停。由 Hub 内置 5 段 Cron / 间隔引擎到期主动调用 `dispatchTasks` 派发标准任务；默认启用 `overlap_policy = 'skip'`（上轮单点或扇出子任务未终结时跳过重入）与 `misfire_policy = 'fire_once'`（休眠或重启跨越多个周期后合并补跑一次）。
- **外部自管（`driver = 'edge'`）**：由外部 Agent 或脚本自身定时器驱动，跑完单步调用 `runs` 报备（首次上报自动建档且 `triggerable = false`）。结果判定遵循三条确定性规则：非空 `error`（或 `outcome='failed'`）计失败，`noop: true`（或 `outcome='noop'`）计空转，其余均计成功（`completed`）。预期完成窗口按 `next_run_at + last_duration_ms + grace_sec` 计算（未设 `grace_sec` 时取周期的 50%，下限 30 秒、上限 7200 秒），超时未报且本轮未告警时推送一次 `schedule.missed` 告警。
