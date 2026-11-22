# a2a-hub — 个人版多 Agent 编排中台 (v2.0)

把分散在云端的对话 Bot / Leader Agent（如 Muse、Grok Bot、WorkBuddy、豆包、千问）与多台个人电脑上的本地编码 CLI（Claude Code、Codex、OpenCode、Gemini CLI、Aider 等），统一收归到同一个极简、自托管、开箱即用的个人编排中台中，通过单一网页控制台或主协调 Agent（Leader）统一派单、追问、高危审批和结果汇总。

> **第一性原理：简单 · 易用 · 易部署**  
> Node.js >= 24 零第三方运行依赖 · 单 SQLite WAL 数据库 · 40 秒 HTTP 长轮询穿透公网网关 · 零构建原生 Web 控制台

---

## 核心概念（只有 3 个概念）

1. **Agent**：中台调度的一等公民。无论是云端 Bot 还是某台电脑上的 `Claude Code`，都会成为面板上一张清晰的能力卡片，一目了然展示「我是谁、擅长什么、用什么模型、目前是否在线」。
2. **Device（电脑宿主，可选）**：当你运行 `ah join` 挂载一台电脑时，守护进程自动探测本地已安装的 CLI 并并发执行（默认并发 4 路），同时同步该电脑上的所有可用 CLI 为 Agent 卡片。
3. **Thread & Task（对话线程与任务）**：遵循 A2A 标准八态（`submitted` / `working` / `input-required` / `auth-required` / `completed` / `failed` / `canceled` / `rejected`），支持一次向多个 Agent 并发派单（扇出），并在同一个 `context_id` 下共享跨任务历史前情与本地 CLI Session 续接。

---

## 1 分钟快速开始

### 前置要求
- Node.js >= 24（若本机尚未安装，`install.sh` 会自动在 `~/.local/node` 下载校验官方 Node 24 LTS）

### 方式一：本机一键启动 Hub 中台（含控制台 + 本机 CLI 执行池）
```sh
git clone https://github.com/backtomyfuture/a2a-hub.git
cd a2a-hub
node bin/ah.mjs up
```
启动后会打印带机主口令的一次性免登控制台链接，打开浏览器即可使用：
`http://127.0.0.1:8787/?token=<你的令牌>`

如需注册为系统开机自启后台服务：
```sh
node bin/ah.mjs up --service
```

### 方式二：挂载另一台电脑执行任务
在 Hub Web 控制台点击 **「+ 接入 Agent / 电脑」 → 「挂载一台电脑」**，复制生成的 `ah join` 命令到目标电脑运行：
```sh
ah join "http://<DEVICE_TOKEN>@<HUB_HOST>:8787" --service
```
只发起出站 HTTPS/HTTP 长轮询，无需目标电脑开放任何入站端口。

### 方式三：接入独立 / 云端 Agent（Muse、Grok Bot、Webhook 等）
在控制台点击 **「+ 接入 Agent / 电脑」 → 「接入独立 Agent」**，选择对应平台模板并填写能力定位，将自动生成包含真实凭据与完整协议的**自包含接入提示词**直接复制发给对方即可立即上线。

---

## 一键公网暴露与穿透探针

```sh
# 1) 使用 Tailscale Funnel 443 自动开启 HTTPS 并回填公网地址（强制校验已设置机主 Token）
ah expose tailscale --auto-token

# 2) 使用 Cloudflare Tunnel 域名并自动探测 WAF / Bot Fight Mode 拦截情况
ah expose cf https://hub.example.com --auto-token
```

---

## 常用 CLI 命令

| 命令 | 说明 |
| --- | --- |
| `ah up [--service]` | 一键初始化并启动本机独立中台 |
| `ah join <url> [--service]` | 挂载本机电脑到已有 Hub |
| `ah doctor` | 只读巡检配置、0600 权限、SQLite 与连通性 |
| `ah agents list \| pause \| resume` | 查看或临时暂停/恢复某个 Agent |
| `ah task create --to a,b --text "..."` | 通过命令行派单（支持多目标扇出） |
| `ah present list \| approve \| deny \| reply` | 命令行处理待审批或 Agent 追问 |
| `ah inbox check \| list \| claim \| complete` | 供轻量无守护进程的终端 Agent 读写收件箱 |
| `ah service [--ensure \| --remove]` | 自启服务安装、环境漂移自愈或卸载 |
| `ah update` | 拉取最新代码并同步更新本地 Skill |

更多协议细节请参阅：
- [架构设计](docs/architecture.md)
- [配置与接入手册](docs/configuration.md)
- [A2A 状态与协议规范](docs/standard.md)
