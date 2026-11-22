# a2a-hub v2.0 架构设计

## 设计目标
从第一性原理重构多 Agent 编排中台，消灭传统双总线同步裂脑与复杂配置包袱，做到：
1. **单一协议栈**：所有端（Web 控制台、云端 Leader Agent、本地/远端 DeviceDaemon、独立 Worker 脚本）全部统一走清晰的 REST + 40s HTTP 长轮询协议，彻底移除底表透传与冗余状态镜像。
2. **真实关系型 SQLite 持久化**：使用 Node >= 24 内置 `node:sqlite` + WAL 模式，所有实体（`devices`、`agents`、`tasks`、`messages`、`schedules`、`idempotency`、`watermarks`、`files`）直接映射结构化列与索引，依托 `BEGIN IMMEDIATE` 事务保证状态迁移零竞态，且**仅在事务成功提交后**才唤醒长轮询与外部通知。
3. **无准入摩擦**：机主主动颁发的设备 / Agent Token 即刻生效（`enabled = 1`），无需二次去「待准入列表」审批；日常提供轻量级「启用 / 暂停」开关。
4. **DeviceDaemon 多路并发池**：本地 CLI（Claude Code / Codex / OpenCode / Gemini）默认支持 `maxConcurrent = 4` 并行调度不同工作区/任务，同时对相同 `(context_id, worker_key)` 施加串行顺序锁，保护 CLI `--resume` 会话文件不发生并发损坏。
5. **严格的执行隔离与密码学审批边界**：
   - 任务请求参数若包含 `EXEC_CONTROL_KEYS`（如 `command`、`cwd`、`env`）立刻拒绝。
   - 当任务进入 `auth-required` 时，**唯有持有 Hub 私钥的机主（`owner`）**可通过控制台或 `ah present approve` 产出 Ed25519 签名；远端设备在启动高危命令前必须通过本地预置的 `hubPublicKey` 验签放行。

## 数据流与通信拓扑

```text
  [云端 Leader / Bot]               [Web 控制台]                [远端 Mac / Linux / VPS]
  GET /agents/:id/poll              GET /api/v1/poll            DeviceDaemon (并发池 <= 4)
  POST /tasks (to fan-out)          HttpOnly Cookie 鉴权         GET /devices/:id/poll (<=40s)
             \                            |                            /
              \                           v                           /
               +----------------> [ Hub HTTP 网关 ] <----------------+
                                  src/server/http-server.mjs
                                          |
                          +---------------+---------------+
                          |               |               |
                          v               v               v
                     TaskService    LongPollBroker   WebhookDispatcher
                     (唯一状态机)    (在线窗口+唤醒)   & ExternalNotifier
                          |
                          v
                   HubStore + FileStore (hub.db SQLite WAL)
```
