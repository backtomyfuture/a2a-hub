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

## 2. 只追加消息日志（`messages`）

每条状态跃迁都会在 `messages` 表追加一条不可篡改的记录（`dispatch`、`status`、`question`、`answer`、`auth_request`、`auth_decision`、`receipt`、`error`、`retry`、`cancel`），任何接口均不得修改或删除历史消息。

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
  - `PUT|DELETE /api/v1/agents/:id/schedules/:sid`
- **任务、线程、审批与文件**：
  - `POST /api/v1/tasks`（支持单目标或 `to: [...]` 数组并发扇出，`owner` 或 `leader`）
  - `POST /api/v1/tasks/claim`（Device 跨启用 Worker 批量认领下一条）
  - `POST /api/v1/tasks/:id/{claim,heartbeat,complete,fail,ask,auth,reply,cancel}`
  - `POST /api/v1/approvals/:taskId/decide`（**严格限 `owner`**，使用 Ed25519 私钥签名）
  - `GET /api/v1/threads`, `GET /api/v1/threads/:contextId`
  - `POST /api/v1/files`, `GET /api/v1/files/:id`
