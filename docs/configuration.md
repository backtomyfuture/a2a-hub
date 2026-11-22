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
- `hub.db`（`0600`）：SQLite WAL 主库（仅 Hub 模式）。
- `approval_key.pem`（`0600`）：Hub Ed25519 审批签名私钥（仅 Hub 模式）。
- `agent_templates.json`（`0600`）：新增独立 Agent 的 15 套平台模板目录，首次启动由 Hub 写入并在升级时无损增量合并。
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

## 浏览器免口令直达与登录安全

控制台支持通过 `?token=<AH_API_TOKEN>` 首次直达，服务端校验通过后立即种入 `HttpOnly; SameSite=Lax` 的 HMAC 签名会话 Cookie（`ah_session`），并通过 `302 Location: /` 将地址栏敏感参数剥离，防止 Token 泄露到浏览器历史或 Referer 中。
