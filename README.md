<div align="center">

# a2a-hub

**零外部依赖 · 自托管个人多 Agent 编排中台（v2.0）**

把分散在云端的对话 Bot / Leader Agent 与多台电脑上的本机编码 CLI（Claude Code、Codex、Amp、Droid、Antigravity、Grok、Cursor、OpenCode、Qwen、Kimi 等 **26 种主流 CLI**），统一收归到一个极简个人中台——单 SQLite WAL 数据库、40s 纯出站 HTTP 长轮询、Ed25519 审批签名，以及零构建深浅主题 Web 控制台。

<p>
  <a href="README.md"><strong>简体中文</strong></a> ·
  <a href="README.en.md">English</a> ·
  <a href="docs/architecture.md">架构设计</a> ·
  <a href="docs/configuration.md">配置手册</a> ·
  <a href="docs/standard.md">A2A 规范</a> ·
  <a href="SECURITY.md">安全模型</a>
</p>

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D24-339933.svg" alt="Node.js >= 24" />
  <img src="https://img.shields.io/badge/Dependencies-0%20runtime-10b981.svg" alt="Zero Runtime Dependencies" />
  <img src="https://img.shields.io/badge/Local%20CLIs-26%2B%20Auto--Discovery-6366f1.svg" alt="26+ CLIs" />
  <img src="https://img.shields.io/badge/Cloud%20Templates-14%20Presets-0ea5e9.svg" alt="14 Cloud Templates" />
  <img src="https://img.shields.io/badge/Protocol-A2A%208--State-f59e0b.svg" alt="A2A 8-State" />
</p>

</div>

---

![a2a-hub v2.0 多节点与多 Agent 拓扑图](docs/images/topology.svg)

---

## 核心特性

- **真正的一行启动，无需 `git clone`**：无需预先准备仓库或数据库。Mac / Linux / Windows 一行脚本自动安装官方 Node 24 LTS、`ah` 命令、生成机主凭据与 Ed25519 密钥对，并直接打开 Web 控制台。
- **零前置跨电脑融合挂载**：目标电脑什么都没装？控制台生成**一条融合了「安装 Node 24 + 安装 `ah` + 绑定设备 + 自动扫描 CLI + 注册自启」的一行命令**，复制运行（或直接发给对方机器上的 AI 助手）即可上线，纯出站连接，**不需要任何入站端口**。
- **26 种本机 CLI 自动发现 + 多路真并发池**：自动识别 `claude`、`codex`、`opencode`、`amp`、`droid`、`agy`、`grok`、`cursor-agent`、`codebuddy`、`copilot`、`qwen`、`kimi` 等 **26 种编程/终端 CLI**。单台设备默认 `maxConcurrent = 4` 并行调度，同一 `(context_id, worker_key)` 自动串行加锁并 `--resume` 续接上下文。
- **14 套云端与工作流 Agent 预设**：内置 **Muse / OpenClaw（Leader 主协调）**、Hermes、Manus、Kimi、Grok Bot、Coze、Dify、n8n、飞书机器人、豆包、千问等模板，创建即生成包含真实 Token 与注册心跳脚本的自包含接入提示词。
- **严格安全边界与指令数据分离**：任务请求参数严禁夹带 `command` / `cwd` / `env` 等控制键；高危任务经 `auth-required` 由机主使用 Hub 私钥产出 **Ed25519 密码学签名**，远端执行器本地验签通过才允许执行。
- **零构建极简 Web 控制台**：内置浅色 / 深色主题切换、高密度双栏概览、按设备节点折叠收敛的「Agent 与设备」视图、按设备分组的并发扇出派单、`Context_ID` 对话线程时间线，以及 Worker 定时巡检健康看板。

---

## 1 分钟快速启动（无需 `git clone`）

> **零环境依赖前置**：如果目标机器尚未安装 Node.js >= 24，下方安装脚本会在用户目录 `~/.local/node` 自动下载并 SHA-256 校验官方 Node 24 LTS（无需 `root` 权限），不会污染系统环境。

### 方式 1：在本机（Mac mini / Linux / Windows）一行启动独立 Hub

<table>
<tr>
<th>macOS / Linux</th>
<th>Windows PowerShell</th>
</tr>
<tr>
<td>

```sh
curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh -s -- --hub
```

</td>
<td>

```powershell
$env:AH_HUB="1"; irm https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.ps1 | iex
```

</td>
</tr>
</table>

执行完毕后终端会自动输出**带机主口令的一次性免登 Web 控制台地址**（例如 `http://127.0.0.1:8787/?token=<AH_API_TOKEN>`），并默认注册为用户级后台自启服务（macOS LaunchAgent / Linux systemd / Windows 计划任务）。若只想在前台调试，追加 `--no-service`（Windows 设 `$env:AH_NO_SERVICE="1"`）即可。

---

### 方式 2：给本机 Hub 开启公网 HTTPS 入口（免买服务器）

当你想在公司、手机或云端 Agent 上访问家里的 Mac mini / Linux Hub，一条命令即可打通 `443 HTTPS`：

#### A. Tailscale Funnel（零域名 · 零备案 · 一键固定 HTTPS）

只要本机已登录 Tailscale，即可直接把本地 Hub 暴露为 `https://<主机名>.<tailnet>.ts.net` 并自动写入 `AH_PUBLIC_URL`（开启强口令校验）：

```sh
ah expose tailscale --auto-token   # 一键开启 Tailscale Funnel 443 并自动补齐机主 Token
ah expose status                   # 查看当前公网基址与端到端健康探针
ah expose off                      # 关闭公网暴露
```

#### B. Cloudflare Tunnel + Bot Fight Mode 自动探针

如果你绑定了自己的 Cloudflare Tunnel 域名，运行下述命令会在登记公网地址的同时，主动发送拟真请求探测是否被 Cloudflare WAF / Bot Fight Mode 拦截返回 `403` 质询页：

```sh
ah expose cf https://hub.你的域名 --auto-token
```

> 若探针提示被 Cloudflare 拦截：请在 Cloudflare 控制台关闭 **Bot Fight Mode**，或在 **Security → WAF → Custom rules** 中对 `/api/v1/*` 与 `/.well-known/*` 放行 `Skip`。

---

### 方式 3：云平台 60 秒一键部署 7×24 云端 Hub

没有常驻电脑？仓库根目录已为各大 PaaS 备好零依赖 [`Dockerfile`](Dockerfile)（Node 24-slim，无外部 npm 包，自动读取 `$PORT`、`AH_API_TOKEN`、`AH_PUBLIC_URL` 及平台反向代理头）：

| 平台 | 配置文件 | 一键部署 / 命令 | 持久化挂载 |
| --- | --- | --- | --- |
| **Railway** | [`railway.json`](railway.json) | [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template?referralCode=&repo=https://github.com/backtomyfuture/a2a-hub) | 挂载 Volume 到 `/data`，配置 `AH_API_TOKEN` |
| **Render** | [`render.yaml`](render.yaml) | [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/backtomyfuture/a2a-hub) | 自动创建 1GB 持久化盘 `/data` 与随机 `AH_API_TOKEN` |
| **Fly.io** | [`fly.toml`](fly.toml) | `fly launch --copy-config` | 自动挂载卷 `a2a_hub_data -> /data` |
| **Zeabur** | [`zeabur.json`](zeabur.json) | 导入 GitHub 仓库即识别模板 | 挂载 `/data` 目录并填写 `AH_API_TOKEN` |
| **Docker** | [`Dockerfile`](Dockerfile) | 见下方 Docker 一行启动 | `-v a2a_hub_data:/data` |

```sh
docker build -t a2a-hub .
docker run -d --name a2a-hub -p 8787:8787 \
  -v a2a_hub_data:/data \
  -e AH_API_TOKEN="请替换为你的高强度密钥" \
  -e AH_PUBLIC_URL="https://你的公网域名" \
  a2a-hub
```

<details>
<summary>开发者模式：从 GitHub 源码目录运行</summary>

```sh
git clone https://github.com/backtomyfuture/a2a-hub.git
cd a2a-hub
npm link                # 可选：全局注册 ah / a2a-hub / ahub 命令
node bin/ah.mjs up      # 初始化并前台启动 Hub（加 --service 注册开机自启）
```

</details>

---

## 挂载其他电脑 & 接入云端 Agent

### 1. 挂载另一台电脑（零前置融合命令）

无需在另一台电脑提前装 Node 或 `ah`。在 Hub Web 控制台点击顶部 **「+ 接入 Agent / 电脑」 → 「挂载一台电脑」**，输入设备名后会自动生成一条**包含安装 + 凭据 + 自启的一行命令**，直接复制到目标电脑运行（或整段发给目标电脑上的 Claude / Codex 让它代为执行）：

- **macOS / Linux（全新电脑直接跑这行）**：
  ```sh
  curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh -s -- --join "https://<DEVICE_TOKEN>@<HUB_HOST>" --device <设备ID>
  ```
- **Windows PowerShell（全新电脑直接跑这行）**：
  ```powershell
  $env:AH_DEVICE="<设备ID>"; $env:AH_JOIN="https://<DEVICE_TOKEN>@<HUB_HOST>"; irm https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.ps1 | iex
  ```
- **已安装过 `ah` 的电脑快捷接入**：
  ```sh
  ah join "https://<DEVICE_TOKEN>@<HUB_HOST>" --device <设备ID> --service
  ```

挂载后设备只会发起纯出站 40s 长轮询，自动扫描本机 **26 种常见 CLI Agent** 并按设备节点汇聚展示在控制台；后续新装了 CLI 工具时，只需在控制台点 **「扫描 CLI」** 或执行 `ah workers scan` 即可无损增量补齐。

### 2. 接入独立 / 云端 Agent（Muse、OpenClaw、Coze、Dify、n8n、Webhook 等）

在控制台点击 **「+ 接入 Agent / 电脑」 → 「接入独立 Agent」**，从 14 套预设模板中选择平台（或选「通用（自定义参数）」自由组合 Poll / Longpoll / Webhook），创建后控制台会签发独立的分 Agent Token 并生成一份**自包含接入提示词**，发给目标 Agent 即可完成在线注册并接单。

---

## 架构、协作与 A2A 状态机

### 1. 系统核心架构

![a2a-hub 架构图](docs/images/architecture.svg)

### 2. 多节点并行扇出与 `Context_ID` 多轮续接

![多节点并行扇出与协作](docs/images/collaboration.svg)

### 3. A2A 标准八态任务生命周期

![A2A 八态任务生命周期](docs/images/lifecycle.svg)

---

## 内置兼容生态一览

<details>
<summary><strong>点击展开：26 种自动发现本机 CLI Agent + 14 套云端 / 工作流预设模板</strong></summary>

### 自动发现的 26 种本机 CLI Agent（[`src/core/config.mjs`](src/core/config.mjs)）

| CLI Key | 工具名称 | 可执行命令 / 别名 | 非交互免审批模式与能力特点 |
| --- | --- | --- | --- |
| `claude` | Claude Code | `claude` | `-p --output-format json --dangerously-skip-permissions`，支持 `--resume` |
| `codex` | Codex CLI | `codex` | `exec --dangerously-bypass-approvals-and-sandbox --json`，支持 `exec resume` |
| `opencode` | OpenCode | `opencode` | `run --format json`，支持 `-s {session}` 续接 |
| `gemini` | Gemini CLI | `gemini` | `-p {prompt} --yolo` |
| `aider` | Aider | `aider` | `--yes --no-auto-commits --message` |
| `goose` | Goose | `goose` | `run --text` |
| `amp` | Amp CLI | `amp` | `--dangerously-allow-all --stream-json -x`，支持 `threads continue` 续接 |
| `droid` | Factory Droid | `droid` | `exec --output-format json --auto high`，支持 `-s {session}` 续接 |
| `agy` | Antigravity CLI | `agy` | `--output-format json --dangerously-skip-permissions -p`，支持 `--conversation` |
| `grok` | Grok CLI | `grok` | `--output-format json --always-approve -p`，支持 `-r {session}` 续接 |
| `cursor` | Cursor Agent | `cursor-agent` | `-p --output-format json --force --trust`，支持 `--resume` 续接 |
| `codebuddy` | CodeBuddy Code | `codebuddy` / `cbc` | `-p --output-format json -y`，兼容数组事件流与 `-r` 续接 |
| `copilot` | GitHub Copilot CLI | `copilot` | `-p {prompt} --allow-all --silent` |
| `qwen` | Qwen Code | `qwen` | `-p {prompt} --yolo --output-format json`，支持 `--resume` |
| `kimi` | Kimi Code CLI | `kimi` | `-p {prompt} --output-format stream-json`，支持 `-S {session}` 续接 |
| `kiro` | AWS Kiro CLI | `kiro-cli` | `chat --no-interactive --trust-all-tools` |
| `cline` | Cline CLI | `cline` | `-y --json` |
| `kilo` | Kilo Code CLI | `kilo` / `kilocode` | `run --auto --format json` |
| `auggie` | Augment Auggie | `auggie` | `--print`，支持 `--resume` |
| `vibe` | Mistral Vibe | `vibe` | `-p {prompt} --auto-approve --output json`，支持 `--resume` |
| `crush` | Charm Crush | `crush` | `crush run {prompt}` |
| `pi` | Pi Coding Agent | `pi` | `-p --mode json` |
| `devin` | Devin CLI | `devin` | `--permission-mode dangerous --respect-workspace-trust false -p` |
| `openhands` | OpenHands CLI | `openhands` | `--headless --json -t` |
| `iflow` | iFlow CLI | `iflow` | `-p {prompt} --yolo` |
| `qoder` | Qoder CLI | `qodercli` / `qoder` | `-p {prompt} --output-format json --yolo` |

### 14 套独立 / 云端 Agent 接入模板（[`src/core/templates.mjs`](src/core/templates.mjs)）

| 模板 ID | 预设名称 | 角色 | 默认接入模式 | 典型定位 |
| --- | --- | --- | --- | --- |
| `generic` | 通用（自定义参数） | `worker` | `poll` | 自由配置任何协议接入 Agent |
| `muse` | Muse（云端主协调） | `leader` | `longpoll` | 云端主调度 Leader，拆解并扇出编排 |
| `openclaw` | OpenClaw（个人常驻） | `leader` | `longpoll` | 24/7 常驻个人多通道主控 Agent |
| `hermes` | Hermes Agent | `worker` | `poll` | 具备持久化记忆与技能学习的自主执行 Agent |
| `manus` | Manus | `worker` | `poll` | 深度调研、网页操作与复杂报告交付 |
| `kimi-agent` | Kimi（月之暗面） | `worker` | `poll` | 超长文档精读与检索资料汇总 |
| `grok-bot` | Grok Bot | `worker` | `webhook` | 实时联网搜索与 X/Web 舆情分析 |
| `workbuddy` | WorkBuddy | `worker` | `poll` | 办公日程、会议纪要与团队触达 |
| `doubao` | 豆包 | `worker` | `poll` | 中文长文写作、资料总结与创意策划 |
| `qwen` | 千问 | `worker` | `poll` | 结构化数据分析、翻译与代码辅助 |
| `coze` | Coze / 扣子 Bot | `worker` | `webhook` | 扣子工作流与垂直业务插件自动化 |
| `dify` | Dify Workflow Agent | `worker` | `webhook` | 基于 Dify 流程编排与 RAG 知识库问答 |
| `n8n` | n8n 自动化工作流 | `worker` | `webhook` | Webhook 触发多系统集成与自动通知 |
| `feishu-bot` | 飞书机器人 / 多维表格 | `worker` | `webhook` | 飞书群协作、文档审批与多维表格处理 |

</details>

---

## 2×2 Agent Skill 职责矩阵

`a2a-hub` 根据运行形态与职责将内置 Skill 精准隔离，安装与升级会自动同步到 `~/.agents/skills/`：

| 角色 \ 接入形态 | 本机装有 `ah` CLI | 无 CLI 纯 HTTP 接入 |
| --- | --- | --- |
| **控制端 / Leader**（查名册、派单与跟单） | [`skills/ah/SKILL.md`](skills/ah/SKILL.md) | [`skills/a2a-leader/SKILL.md`](skills/a2a-leader/SKILL.md)（`GET /api/v1/skills/a2a-leader`） |
| **执行端 / Worker**（取单、提问、审批、回执） | [`skills/ah-inbox/SKILL.md`](skills/ah-inbox/SKILL.md) | [`skills/a2a-worker/SKILL.md`](skills/a2a-worker/SKILL.md)（`GET /api/v1/skills/a2a-worker`） |

---

## 常用 CLI 命令速查

默认配置目录为 `~/.a2a-hub`（可用 `--config <dir>` 或环境变量 `AH_HOME` 指定，命令别名 `ah` / `a2a-hub` / `ahub`）：

| 分类 | 命令 | 说明 |
| --- | --- | --- |
| **一键部署与暴露** | `ah up [--listen …] [--service]` | 一键初始化独立 SQLite Hub 并启动 |
| | `ah join <url> [--device <id>] [--service]` | 挂载当前电脑到已有 Hub 并自动扫描本地 CLI |
| | `ah expose [tailscale\|cf <url>\|status\|off] [--auto-token]` | 一键开启 Tailscale Funnel 443 或 Cloudflare WAF 探针 |
| | `ah service [--ensure \| --remove]` | 开机自启安装、自愈或卸载（LaunchAgent / systemd / Windows） |
| **Worker 与巡检** | `ah workers <list \| scan \| add \| remove>` | 查看、增量扫描 26 种新 CLI 或自定义本地 Worker |
| | `ah doctor` | 只读体检配置、`0600` 权限、密钥、SQLite 与连通性 |
| | `ah agents [list \| pause <id> \| resume <id>]` | 列出在线能力目录或启停某个 Agent |
| | `ah update [--check]` | 拉取最新代码、刷新 Skill 并热重启后台服务 |
| **派单、呈递与收件箱** | `ah task <create \| list \| show \| reply \| cancel>` | 派单（支持多目标扇出与 `context_id` 续接）与状态查询 |
| | `ah present [list \| approve <id> \| deny <id> \| reply <id>]` | 机主命令行处理 Ed25519 审批与追问回复 |
| | `ah inbox <check \| list \| claim \| complete \| ask \| updates>` | 供无守护进程的独立终端 Agent 读写收件箱 |

---

## 安全红线与信任边界

完整安全模型见 [`SECURITY.md`](SECURITY.md) 与 [`docs/standard.md`](docs/standard.md)：

1. **指令与数据严格分离**：可执行命令、`cwd`、`resume_command`、`approval_policy` 仅读本地 `workers.json`；任何任务请求包含 `command` / `cmd` / `argv` / `cwd` / `env` 等控制字段即返回 `HTTP 400` 拒收。
2. **节点零入站**：电脑节点与独立 Agent Daemon 均只向 Hub 发起纯出站 HTTP/HTTPS 请求，不开放任何入站监听端口。
3. **Ed25519 签名审批**：`auth-required` 状态严格仅允许机主（`owner`）调用 `/api/v1/approvals/:taskId/decide`，由 Hub `0600` 私钥 `approval_key.pem` 签名；远端设备执行前强制验签 `hubPublicKey`。
4. **最小凭据暴露**：`app.env`（`0600`）、`approval_key.pem`、`hub.db*`、`sessions/` 与真实 Token 绝不入库广播或提交版本库。

---

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | 架构分层、SQLite WAL、40s 长轮询与并发锁设计 |
| [`docs/configuration.md`](docs/configuration.md) | 配置目录、`workers.json`、`app.env` 通知推送、Docker / PaaS 变量 |
| [`docs/standard.md`](docs/standard.md) | **权威规范**：A2A 八态机、只追加消息日志与 REST API 总览 |
| [`SECURITY.md`](SECURITY.md) | 信任模型与密码学审批边界 |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本演进历史 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 贡献指南与开发约定 |

## 开发与测试

零外部 npm 依赖，直接使用 Node.js >= 24 内置测试运行器（`node:test`）：

```sh
for f in bin/*.mjs src/*/*.mjs src/web/*.js src/web/*/*.js tests/*.mjs; do node --check "$f" || exit 1; done
npm test
```

## License

[MIT](LICENSE)
