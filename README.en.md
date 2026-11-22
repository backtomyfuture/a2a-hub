<div align="center">

# a2a-hub

**Zero-Dependency, Self-Hosted Personal Multi-Agent Orchestration Hub (v2.0)**

Unify cloud chatbots & Leader agents with local coding CLIs across your computers (Claude Code, Codex, Amp, Droid, Antigravity, Grok, Cursor, OpenCode, Qwen, Kimi — **26+ CLIs auto-discovered**) inside one minimal control plane backed by SQLite WAL, 40s outbound HTTP long-polling, Ed25519 approval signing, and a zero-build Web console.

<p>
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md"><strong>English</strong></a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="docs/configuration.md">Configuration</a> ·
  <a href="docs/standard.md">A2A Spec</a> ·
  <a href="SECURITY.md">Security</a>
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

```mermaid
flowchart TB
    HUB["a2a-hub v2.0 Control Plane\nSQLite WAL · REST + 40s Long-Poll · Ed25519 Signing · Web Console"]
    HUB <-->|"ah up (Built-in DeviceDaemon)"| M1["Mac mini (Local Host)\nclaude · codex · amp · droid · agy · grok · cursor · codebuddy"]
    HUB <-->|"install.sh --join (Outbound Only)"| M2["Linux / GPU Workstation\nqwen · kimi · cline · kilo · openhands · opencode"]
    HUB <-->|"install.ps1 AH_JOIN (Outbound Only)"| M3["Windows / Work PC\ncopilot · gemini · devin · custom scripts"]
    HUB <-->|"14 Onboarding Presets\n(Poll / Long-Poll / Webhook)"| C1["Cloud & Leader Agents\nMuse · OpenClaw · Hermes · Manus · Coze · Dify · n8n · Feishu"]
```

---

## Why `a2a-hub`

- **One-Line Start Without `git clone`**: Zero external npm dependencies (`dependencies: {}`). A single installer bootstraps Node.js 24 LTS (if missing, SHA-256 verified into `~/.local/node`), installs `ah`, initializes SQLite + Ed25519 keys, and prints a one-click login console URL.
- **Zero-Prerequisite Machine Onboarding**: Adding a fresh Mac, Linux box, or Windows PC doesn't require pre-installing `ah` or Node. The Web UI generates a **single unified command** that installs Node 24 + `ah`, connects with embedded credentials, scans 26 local CLI tools, and registers a background service — purely outbound, zero open inbound ports.
- **26+ Auto-Discovered CLI Workers & True Concurrency**: Automatically discovers local CLIs (Claude Code, Codex, OpenCode, Amp, Droid, Agy, Grok, Cursor Agent, CodeBuddy, Copilot, Qwen, Kimi, Kiro, Cline, Kilo, Auggie, Vibe, Crush, Pi, Devin, OpenHands, iFlow, Qoder, Gemini, Aider, Goose). Each host executes up to `maxConcurrent = 4` tasks in parallel while serializing per `(context_id, worker_key)` to protect native CLI `--resume` sessions.
- **14 Cloud & Workflow Agent Presets**: Ready-to-use onboarding prompts with scoped per-agent tokens for **Muse / OpenClaw (Leaders)**, Hermes, Manus, Kimi, Grok Bot, WorkBuddy, Doubao, Qwen, Coze, Dify, n8n, and Feishu.
- **Strict Execution Isolation & Ed25519 Signed Approvals**: Task payloads can never inject `command`, `cwd`, or `env` keys (`HTTP 400`). Risk-gated `auth-required` tasks can only be unlocked by the owner's Ed25519 signature, verified locally on the worker host via `hubPublicKey`.
- **Minimalist Zero-Build Web Console**: Light/dark themes, two-column command dashboard, device-grouped collapsible worker view with instant search, grouped fan-out dispatcher, `Context_ID` threads, and scheduled job telemetry.

---

## 1-Minute Quick Start (No `git clone` Needed)

> **Zero prerequisites**: If Node.js >= 24 is not installed yet, the installer automatically downloads and SHA-256 verifies official Node 24 LTS into `~/.local/node` without root privileges.

### Option 1: One-Line Local Hub (Mac mini / Linux / Windows)

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

The installer prints a direct Web console URL with your owner token (`http://127.0.0.1:8787/?token=...`) and registers a user-level background daemon (LaunchAgent / systemd / Windows Scheduled Task). Pass `--no-service` (`$env:AH_NO_SERVICE="1"` on Windows) to run in the foreground instead.

---

### Option 2: Instant Public HTTPS for a Local Hub (Zero Domain Setup)

#### A. Tailscale Funnel (Fixed 443 HTTPS in One Command)

If your Hub runs on a home Mac mini or Linux box signed in to Tailscale, expose it securely at `https://<host>.<tailnet>.ts.net` and populate `AH_PUBLIC_URL` automatically:

```sh
ah expose tailscale --auto-token   # Enable Funnel 443 HTTPS + ensure strong AH_API_TOKEN
ah expose status                   # Inspect public URL and run end-to-end health probe
ah expose off                      # Disable Tailscale Funnel
```

#### B. Cloudflare Tunnel + Bot Fight Mode Probe

Attach your own domain and verify that Cloudflare WAF / Bot Fight Mode is not blocking non-browser agents or long-poll streams:

```sh
ah expose cf https://hub.yourdomain.com --auto-token
```

> If the probe detects a `403` Cloudflare challenge page, disable **Bot Fight Mode** or add a WAF Custom Rule to **Skip** `/api/v1/*` and `/.well-known/*`.

---

### Option 3: 60-Second Cloud PaaS Templates (24/7 Hosted Hub)

Built around [`Dockerfile`](Dockerfile) (Node 24-slim, zero third-party npm packages, automatic `$PORT`, `AH_API_TOKEN`, `AH_PUBLIC_URL`, and `X-Forwarded-Proto` support):

| Platform | Config | One-Click Deploy / Command | Persistent Storage |
| --- | --- | --- | --- |
| **Railway** | [`railway.json`](railway.json) | [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template?referralCode=&repo=https://github.com/backtomyfuture/a2a-hub) | Attach a volume at `/data`, set `AH_API_TOKEN` |
| **Render** | [`render.yaml`](render.yaml) | [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/backtomyfuture/a2a-hub) | Auto-creates 1GB disk `/data` + `AH_API_TOKEN` |
| **Fly.io** | [`fly.toml`](fly.toml) | `fly launch --copy-config` | Mounts `a2a_hub_data -> /data` |
| **Zeabur** | [`zeabur.json`](zeabur.json) | Import repo to deploy template | Mount `/data` and set `AH_API_TOKEN` |
| **Docker** | [`Dockerfile`](Dockerfile) | See Docker command below | `-v a2a_hub_data:/data` |

```sh
docker build -t a2a-hub .
docker run -d --name a2a-hub -p 8787:8787 \
  -v a2a_hub_data:/data \
  -e AH_API_TOKEN="your-strong-secret-token" \
  -e AH_PUBLIC_URL="https://your-public-domain" \
  a2a-hub
```

<details>
<summary>Developer Mode: Run Directly From Cloned Source</summary>

```sh
git clone https://github.com/backtomyfuture/a2a-hub.git
cd a2a-hub
npm link                # Optional: register global ah / a2a-hub / ahub CLI
node bin/ah.mjs up      # Initialize and start Hub (+ --service for background daemon)
```

</details>

---

## Connecting Additional Computers & Cloud Agents

### 1. Mount Another Computer (Unified Zero-Prerequisite Command)

No manual Node or `ah` setup required on the target machine. Open **"+ 接入 Agent / 电脑" → "挂载一台电脑"** in the Web console to copy a self-contained one-liner (or send it directly to an AI assistant on that machine):

- **macOS / Linux (fresh machine)**:
  ```sh
  curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh -s -- --join "https://<DEVICE_TOKEN>@<HUB_HOST>" --device <device-id>
  ```
- **Windows PowerShell (fresh machine)**:
  ```powershell
  $env:AH_DEVICE="<device-id>"; $env:AH_JOIN="https://<DEVICE_TOKEN>@<HUB_HOST>"; irm https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.ps1 | iex
  ```
- **Machines that already have `ah` installed**:
  ```sh
  ah join "https://<DEVICE_TOKEN>@<HUB_HOST>" --device <device-id> --service
  ```

New CLIs installed later can be added anytime without overwriting existing custom settings via the Web console **"扫描 CLI"** button or `ah workers scan`.

### 2. Onboard Cloud / Standalone Agents

In **"+ 接入 Agent / 电脑" → "接入独立 Agent"**, pick any of the **15 presets** (`generic`, `muse`, `openclaw`, `hermes`, `manus`, `kimi-agent`, `grok-bot`, `workbuddy`, `doubao`, `lingguang`, `qwen`, `coze`, `dify`, `n8n`, `feishu-bot`). Submitting generates a scoped per-agent token and a ready-to-paste onboarding prompt with exact REST endpoints.

---

## Architecture & A2A 8-State Lifecycle

```mermaid
flowchart LR
    U["Web Console / ah CLI / Leader"] -->|POST /tasks| GW["Hub HTTP Gateway\nLongPollBroker (40s) + Ed25519"]
    GW <-->|BEGIN IMMEDIATE| DB[("SQLite WAL\nhub.db\ndevices · agents · tasks · messages · schedules · files")]
    GW <-->|Outbound Long-Poll| DEV["DeviceDaemon Pool (maxConcurrent=4)\n26+ Auto-Discovered CLIs + --resume"]
    GW <-->|Poll / Webhook| CLD["Cloud & Standalone Agents\n15 Built-in Presets"]
    GW -.->|Alerts| NTF["Feishu / Bark / Telegram / Webhook"]
```

```mermaid
stateDiagram-v2
    [*] --> submitted
    submitted --> working: claim
    submitted --> auth_required: preflight (always)
    submitted --> rejected: policy violation
    submitted --> canceled: cancel
    working --> completed: complete
    working --> input_required: ask
    working --> auth_required: risk gate
    working --> failed: fail (retries exhausted)
    working --> submitted: retry / stale reclaim (20m)
    working --> canceled: cancel
    input_required --> submitted: reply
    auth_required --> submitted: owner Ed25519 approve
    auth_required --> rejected: owner deny
```

---

## Supported Ecosystem

<details>
<summary><strong>Click to expand: 26 Auto-Discovered Local CLIs + 15 Cloud / Workflow Agent Presets</strong></summary>

- **Local CLIs ([`src/core/config.mjs`](src/core/config.mjs))**: `claude` (Claude Code), `codex` (Codex CLI), `opencode` (OpenCode), `gemini` (Gemini CLI), `aider` (Aider), `goose` (Goose), `amp` (Amp CLI), `droid` (Factory Droid), `agy` (Antigravity CLI), `grok` (Grok CLI), `cursor` (`cursor-agent`), `codebuddy` (`codebuddy`/`cbc`), `copilot` (GitHub Copilot CLI), `qwen` (Qwen Code), `kimi` (Kimi Code CLI), `kiro` (`kiro-cli`), `cline` (Cline CLI), `kilo` (`kilo`/`kilocode`), `auggie` (Augment Auggie), `vibe` (Mistral Vibe), `crush` (Charm Crush), `pi` (Pi Coding Agent), `devin` (Devin CLI), `openhands` (OpenHands CLI), `iflow` (iFlow CLI), `qoder` (`qodercli`/`qoder`).
- **Cloud & Workflow Templates ([`src/core/templates.mjs`](src/core/templates.mjs))**: `generic`, `muse` (Leader), `openclaw` (Leader), `hermes`, `manus`, `kimi-agent`, `grok-bot`, `workbuddy`, `doubao`, `lingguang`, `qwen`, `coze`, `dify`, `n8n`, `feishu-bot`.

</details>

---

## Essential CLI Reference

Default config directory: `~/.a2a-hub` (override with `--config <dir>` or `AH_HOME`; aliases `ah` / `a2a-hub` / `ahub`):

| Command | Description |
| --- | --- |
| `ah up [--listen …] [--service]` | Initialize and start a standalone SQLite Hub |
| `ah join <url> [--device <id>] [--service]` | Attach this machine to an existing Hub and auto-discover CLIs |
| `ah expose [tailscale\|cf <url>\|status\|off] [--auto-token]` | Expose local Hub via Tailscale Funnel 443 or probe Cloudflare WAF |
| `ah workers <list \| scan \| add \| remove>` | List, incrementally scan 26+ CLIs, add, or remove local workers |
| `ah doctor` | Read-only check of config, `0600` permissions, keys, SQLite, and reachability |
| `ah agents [list \| pause <id> \| resume <id>]` | Inspect agent catalog or pause/resume an agent |
| `ah task <create \| list \| show \| reply \| cancel>` | Dispatch tasks (supports fan-out & `context_id`), reply, or cancel |
| `ah present [list \| approve <id> \| deny <id> \| reply <id>]` | Owner CLI for Ed25519 signed approvals and question replies |
| `ah inbox <check \| list \| claim \| complete \| ask \| updates>` | Headless inbox interface for standalone CLI agents |
| `ah service [--ensure \| --remove]` / `ah update` | Manage OS background service or pull updates & refresh skills |

---

## Security Boundaries

See [`SECURITY.md`](SECURITY.md) and [`docs/standard.md`](docs/standard.md) for the complete threat model:

- **Command / Data Separation**: Executable commands, `cwd`, and `approval_policy` live strictly in local `workers.json`; any task request containing execution control keys (`command`, `cwd`, `env`, etc.) is rejected with `HTTP 400`.
- **Zero Inbound Node Ports**: Worker hosts and standalone daemons only initiate outbound HTTP(S) long-polls to the Hub.
- **Ed25519 Signed Approvals**: Only the `owner` role can decide `auth-required` tasks via `/api/v1/approvals/:taskId/decide` using the Hub's `0600` private key (`approval_key.pem`); remote hosts verify signatures with `hubPublicKey` before execution.

---

## Development & Tests

Zero external npm dependencies — powered directly by Node.js >= 24 built-in `node:test`:

```sh
for f in bin/*.mjs src/*/*.mjs src/web/*.js src/web/*/*.js tests/*.mjs; do node --check "$f" || exit 1; done
npm test
```

## License

[MIT](LICENSE)
