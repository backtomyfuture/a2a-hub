# a2a-hub v2.0 配置与接入说明

## 配置目录结构（默认 `~/.a2a-hub`，可用 `AH_HOME` 或 `--config` 覆盖）

- `config.json`：运行身份（`mode: "hub" | "device" | "agent"`）、设备 ID、监听地址或上行 `hubUrl`、`maxConcurrent`、Hub 验签公钥 `hubPublicKey`。
- `workers.json`：本机自动发现与自定义的可执行 CLI 列表（权限边界、工作目录 `cwd`、模型选项与 `--resume` 模板完全由本文件决定，任务参数不可覆盖）。
- `app.env`（`0600`）：机主 Token `AH_API_TOKEN`、公网基址 `AH_PUBLIC_URL` 及外部告警推送环境变量：
  - `AH_FEISHU_WEBHOOK`
  - `AH_BARK_URL`
  - `AH_TELEGRAM_BOT_TOKEN` + `AH_TELEGRAM_CHAT_ID`
  - `AH_NOTIFY_WEBHOOK`
  - `AH_NOTIFY_ON=action|all`
- 审批渠道（`app.env` 或控制台「设置 → 审批渠道」，改后无需重启）：
  - `AH_APPROVAL_LINKS=1`：通知里附带一次性审批链接
  - `AH_APPROVAL_LINK_TTL_MIN`：链接有效期，默认 30，上限 1440
  - `AH_APPROVAL_TIMEOUT_MIN`：审批超时自动拒绝，默认 1440，`0` 关闭
  - `AH_FEISHU_APP_ID` / `AH_FEISHU_APP_SECRET` / `AH_FEISHU_APPROVERS` / `AH_FEISHU_CHAT_ID` / `AH_FEISHU_DOMAIN`：飞书应用审批，见下文
- `hub.db`（`0600`）：SQLite WAL 主库（仅 Hub 模式）。

- `approval_key.pem`（`0600`）：Hub Ed25519 审批签名私钥（仅 Hub 模式）。
- `agent_templates.json`（`0600`）：新增独立 Agent 的平台模板目录（内置 10 套），首次启动由 Hub 写入并在升级时无损增量合并。
- `files/blobs/`：通过 `/api/v1/files` 中转的附件与产物，默认 7 天自动清理（`AH_FILE_TTL_MS`、`AH_FILE_MAX_BYTES` 可调）。

## 一行无前置安装与增量扫描

- **macOS / Linux 一行启动或挂载**：
  - `curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh -s -- --hub`
  - `curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh -s -- --join "https://<token>@<hub-host>" --device <id>`
- **增量发现本机 26 种 CLI**：新装 CLI 工具后执行 `ah workers scan`（加 `--force` 可刷新同名内置命令模板）或在控制台点击设备行的「扫描 CLI」。

## 容器与 PaaS 云端部署（Docker / Railway / Render / Fly.io / Zeabur）

镜像内置 Node 24 与零依赖源码，启动命令为：
```sh
node bin/ah.mjs up --config /data --skip-skill
```
推荐环境变量：
- `PORT` / `AH_LISTEN=0.0.0.0:8787`
- `AH_API_TOKEN=<强随机口令>`
- `AH_PUBLIC_URL=https://你的公网域名`（若平台提供了 `RAILWAY_PUBLIC_DOMAIN` 等变量也会自动推断）
- `AH_NO_DEVICE=1`：镜像默认值，只运行中台，不在容器里挂载空的本机执行池。

### Railway

Railway 读取 [`.railway/railway.ts`](../.railway/railway.ts)（Infrastructure as Code），不再读取 `railway.json`。

- 文件里写的是作者项目的卷名、区域和容量，部署到自己的项目前请改成实际值。
- 必须保留 `/data` 的卷挂载声明（`volumeMounts: { "/data": data }`），否则 `railway config apply` 会把数据卷从服务上摘掉。
- 在服务变量里显式设置 `PORT=8787`，否则健康检查可能连不上服务。
- 变量不由该文件管理（`variables: { managed: false }`），`AH_API_TOKEN` 等仍在 Railway 控制台或 `railway variables` 里设置。
- 改动前先用 `railway config plan` 预览，确认没有删除数据卷之类的破坏性变更，再 `railway config apply`。预览和应用需要 Railway 的 TypeScript SDK，可用 `npm install --no-save --no-package-lock railway` 临时安装，不改动 `package.json`。

## 浏览器免口令直达与登录安全

控制台支持通过 `?token=<AH_API_TOKEN>` 首次直达，服务端校验通过后立即种入 `HttpOnly; SameSite=Lax` 的 HMAC 签名会话 Cookie（`ah_session`），并通过 `302 Location: /` 将地址栏敏感参数剥离，防止 Token 泄露到浏览器历史或 Referer 中。

## 审批渠道

所有渠道最终都调用同一个 `decideApproval`，由 Hub 私钥签名。执行端（DeviceDaemon、AgentDaemon）只认签名，不关心审批是从哪里点的。

| 渠道 | 身份证明 | 适用场景 |
|---|---|---|
| 控制台 / `ah present approve` | 机主 Token 或会话 Cookie | 默认 |
| 一次性审批链接 | 持有链接（HMAC 令牌、限时、只能用一次） | Bark、Telegram 私聊、邮件等只有机主能看到的通知 |
| 飞书应用卡片 | 飞书长连接回调里的操作人在白名单内 | 团队或手机上处理 |

### 一次性审批链接

1. 设置 `AH_PUBLIC_URL`，确保手机能打开这个地址。
2. 开启 `AH_APPROVAL_LINKS=1`。之后 `auth-required` 通知会多出一行「一键审批」链接。
3. 打开链接只会看到确认页；点「签名并放行」或「拒绝」才生效。链接过期、已用过，或任务出现了更新的审批请求时，页面会提示失效。

飞书群机器人 Webhook 是群内所有人可见的，开启链接后群成员都能审批。只给机主自己时再开启。

### 飞书应用审批（长连接）

1. 在飞书开放平台的企业自建应用里开通机器人能力，并申请「以应用身份发消息」权限（`im:message:send_as_bot`）。
2. 「事件与回调 → 回调配置」选择「使用长连接接收回调」，添加回调 `card.action.trigger`（卡片回传交互）。Hub 需要先以正确的 App ID / Secret 运行起来，保存长连接配置时才能检测到在线客户端。
3. 在 `app.env` 或控制台填写 `AH_FEISHU_APP_ID`、`AH_FEISHU_APP_SECRET`、`AH_FEISHU_APPROVERS`（审批人 `open_id`，逗号分隔；也接受 `user_id` / `union_id`）。审批人需要在应用的可用范围内，才能收到私聊卡片。可选 `AH_FEISHU_CHAT_ID`，把卡片同时发到某个群（机器人需在群里），群里只有白名单用户的点击有效。
4. 国际版 Lark 设置 `AH_FEISHU_DOMAIN=https://open.larksuite.com`。

控制台「审批渠道」会显示长连接状态（已连接、重连中、异常）和最近一次错误。
