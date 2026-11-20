// setup —— 一键配置向导：独立 Hub（SQLite + HTTP 网关 + Web 控制台）与远端节点（HTTP 长轮询）。

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { AgentGatewayClient } from "./bus/agent-client.mjs";
import { HttpBus } from "./bus/http-bus.mjs";
import { SqliteBus } from "./bus/sqlite-bus.mjs";
import { normalizeTables } from "./bus/tables.mjs";
import { normalizeCommands, readEnvFile, readTokenFile, resolveListenAddr } from "./config.mjs";
import { isHubPublicKey, loadOrCreateHubKey } from "./approval-sign.mjs";
import { doctor } from "./doctor.mjs";
import { service } from "./service.mjs";

// 按角色与宿主形态决定本机应安装的本地 CLI Skill，避免把打工接单指令混进普通 host 子进程全局目录。
export function resolveSkillsForHost({ role = "node", kind = "host", agentRole = "" } = {}) {
  // agentRole 只在官方 Gateway 客户端（busType=agent）传入。不传时保持原来的 role × kind 矩阵。
  const gatewayRole = String(agentRole ?? "").trim().toLowerCase();
  if (gatewayRole === "leader" || gatewayRole === "hybrid") return ["ah", "ah-inbox"];
  if (gatewayRole === "worker") return ["ah-inbox"];
  const isAgent = String(kind).trim().toLowerCase() === "agent";
  const isHub = String(role).trim().toLowerCase() === "hub";
  if (isAgent) {
    return isHub ? ["ah", "ah-inbox"] : ["ah-inbox"];
  }
  return ["ah"];
}

export function installLocalSkills(appDir, {
  role = "node",
  kind = "host",
  agentRole = "",
  skipSkill = false,
  skillsRoot = path.join(os.homedir(), ".agents", "skills"),
  log = console.log,
} = {}) {
  if (skipSkill) {
    log("  · 跳过安装本机 Skill（--skip-skill）");
    return [];
  }
  const names = resolveSkillsForHost({ role, kind, agentRole });
  const installed = [];
  for (const name of names) {
    const skillSrc = path.join(appDir, "skills", name, "SKILL.md");
    const skillDestDir = path.join(skillsRoot, name);
    if (!fs.existsSync(skillSrc)) continue;
    fs.mkdirSync(skillDestDir, { recursive: true });
    const destPath = path.join(skillDestDir, "SKILL.md");
    fs.copyFileSync(skillSrc, destPath);
    log(`  ✓ 已自动安装 ${name} Skill 至 ${destPath}`);
    installed.push({ name, path: destPath });
  }
  return installed;
}

export function parseFlags(argv) {
  const f = { yes: false, force: false, service: false, role: "node", kind: "", skipSkill: false, autoToken: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") f.yes = true;
    else if (a === "--force") f.force = true;
    else if (a === "--service") f.service = true;
    else if (a === "--skip-skill") f.skipSkill = true;
    else if (a === "--auto-token") f.autoToken = true;
    else if (a === "--hub") {
      f.role = "hub";
      if (!f.bus) f.bus = "sqlite";
      f.autoToken = true;
    }
    else if (a === "--join") {
      f.role = "node";
      f.bus = "http";
      f.hubUrl = argv[++i];
    }
    else if (a.startsWith("--join=")) {
      f.role = "node";
      f.bus = "http";
      f.hubUrl = a.slice("--join=".length);
    }
    else if (a === "--help" || a === "-h") f.help = true;
    else if (a === "--role") f.role = argv[++i] || "node";
    else if (a.startsWith("--role=")) f.role = a.slice("--role=".length);
    else if (a === "--kind") f.kind = argv[++i] || "host";
    else if (a.startsWith("--kind=")) f.kind = a.slice("--kind=".length);
    else if (a === "--agent") {
      f.agent = true;
      f.bus = "agent";
      if (!f.kind) f.kind = "agent";
    }
    else if (a === "--agent-role") f.agentRole = argv[++i] || "";
    else if (a.startsWith("--agent-role=")) f.agentRole = a.slice("--agent-role=".length);
    else if (a === "--token-file") f.tokenFile = argv[++i] || "";
    else if (a.startsWith("--token-file=")) f.tokenFile = a.slice("--token-file=".length);
    else if (a === "--hub-key") f.hubKey = argv[++i];
    else if (a.startsWith("--hub-key=")) f.hubKey = a.slice("--hub-key=".length);
    else if (a === "--node") f.node = argv[++i];
    else if (a === "--zone") f.zone = argv[++i];
    else if (a === "--prefix") f.prefix = argv[++i];
    else if (a === "--desc") f.desc = argv[++i];
    else if (a === "--bus") f.bus = argv[++i];
    else if (a.startsWith("--bus=")) f.bus = a.slice("--bus=".length);
    else if (a === "--hub-url") f.hubUrl = argv[++i];
    else if (a.startsWith("--hub-url=")) f.hubUrl = a.slice("--hub-url=".length);
    else if (a === "--api-token") f.apiToken = argv[++i];
    else if (a.startsWith("--api-token=")) f.apiToken = a.slice("--api-token=".length);
    else if (a === "--listen") f.listen = argv[++i];
    else if (a.startsWith("--listen=")) f.listen = a.slice("--listen=".length);
    else if (a === "--db-path") f.dbPath = argv[++i];
    else if (a.startsWith("--db-path=")) f.dbPath = a.slice("--db-path=".length);
    else if (a === "--public-url") f.publicUrl = argv[++i];
    else if (a.startsWith("--public-url=")) f.publicUrl = a.slice("--public-url=".length);
  }
  return f;
}

function richPath() {
  const extra = [
    path.join(os.homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(os.homedir(), ".npm-global/bin"),
    path.join(os.homedir(), ".bun/bin"),
    path.join(os.homedir(), ".cargo/bin"),
    path.join(os.homedir(), ".antigravity/antigravity/bin"),
    path.join(os.homedir(), ".amp/bin"),
    path.join(os.homedir(), ".grok/bin"),
  ];
  const cur = (process.env.PATH || "").split(path.delimiter);
  return [...new Set([...extra, ...cur])].join(path.delimiter);
}

function findExecutable(binName) {
  const dirs = richPath().split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const fullPath = path.join(dir, binName);
    try {
      if (fs.existsSync(fullPath)) {
        fs.accessSync(fullPath, fs.constants.X_OK);
        return fullPath;
      }
    } catch { /* 不可执行或不存在 */ }
  }
  return null;
}

function isPlaceholderToken(v) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s) return false;
  return s.startsWith("<") || s.includes("REPLACE");
}

function isUnfinishedExample(raw) {
  if (!raw || typeof raw !== "object") return false;
  const fields = [raw.hubUrl, raw.node];
  if (raw.tables && typeof raw.tables === "object") fields.push(...Object.values(raw.tables));
  return fields.some(isPlaceholderToken);
}

// 只认安装脚本种下的那份示例：相对路径 echo 指错，lan-exec 这类旧示例能力已不可用。
// 用户事后自己写的能力表不在这里替换。
function isExampleCommands(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  if (Object.hasOwn(obj, "lan-exec")) return true;
  return Object.values(obj).some((e) => typeof e?.command === "string" && e.command.includes("../src/executors/echo.mjs"));
}

const KNOWN_AGENTS = [
  {
    bin: "claude",
    skill: "claude-agent",
    herdrKind: "claude",
    name: "Claude Code Agent",
    // 无头 -p 会停在权限确认，没人点就卡住；跳过权限必须写进模板。
    cmdTemplate: (b) => `${b} -p --dangerously-skip-permissions {prompt}`,
    desc: "以 Claude Code (claude) 为执行主体，带本机终端与文件工具面处理开发、排障与自动化任务",
  },
  {
    bin: "codex",
    skill: "codex-agent",
    herdrKind: "codex",
    name: "Codex Agent",
    // 默认沙箱是只读档，写类任务必失败，所以模板钉 workspace-write。
    cmdTemplate: (b) => `${b} exec --sandbox workspace-write {prompt}`,
    desc: "以 OpenAI Codex CLI (codex) 为执行主体，处理代码编写、终端排障与自动化任务",
  },
  {
    bin: "agy",
    skill: "agy-agent",
    herdrKind: "agy",
    name: "Antigravity Agent",
    // --print 会把紧随其后的参数当成 prompt 吞掉，批准参数必须放在 --print 前面（本机实测）。
    cmdTemplate: (b) => `${b} --dangerously-skip-permissions --print {prompt}`,
    desc: "以 Antigravity (agy) 为执行主体，带本机终端与工具面处理开放式开发与运维任务",
  },
  {
    bin: "gemini",
    skill: "gemini-agent",
    herdrKind: "gemini",
    name: "Gemini Agent",
    // 批准模式必须放在 -p 前面，否则 -p 会把后面的参数当成 prompt；-y / --yolo 已废弃。
    cmdTemplate: (b) => `${b} --approval-mode yolo -p {prompt}`,
    desc: "以 Gemini CLI (gemini) 为执行主体，处理本地分析、脚本与开发任务",
  },
  {
    bin: "amp",
    skill: "amp-agent",
    herdrKind: "amp",
    name: "Amp Agent",
    // 无头 -x 默认会停在权限确认，全批准开关写进模板。
    cmdTemplate: (b) => `${b} --dangerously-allow-all -x {prompt}`,
    desc: "以 Sourcegraph Amp (amp) 为执行主体，处理代码分析、终端操作与工程任务",
  },
  {
    bin: "droid",
    skill: "droid-agent",
    herdrKind: "droid",
    name: "Factory Droid Agent",
    // 分级自治取中档，避免默认停在确认，也不放到最高档。
    cmdTemplate: (b) => `${b} exec --auto medium {prompt}`,
    desc: "以 Factory Droid (droid) 为执行主体，处理本地开发、重构与终端自动化任务",
  },
  {
    bin: "grok",
    skill: "grok-agent",
    herdrKind: "grok",
    name: "Grok CLI Agent",
    cmdTemplate: (b) => `${b} -p {prompt}`,
    herdrKind: "grok",
    desc: "以本机 Grok CLI (grok) 为执行主体，处理调研、分析与本地工具执行任务",
  },
  {
    bin: "hermes",
    skill: "hermes-agent",
    herdrKind: "hermes",
    name: "Hermes Agent",
    cmdTemplate: (b) => `${b} -z {prompt}`,
    desc: "以 Hermes Agent (hermes) 为执行主体，带本机工具面处理自动化与创作任务",
  },
  {
    bin: "cursor-agent",
    skill: "cursor-agent",
    herdrKind: "cursor",
    name: "Cursor Agent",
    cmdTemplate: (b) => `${b} -p {prompt}`,
    desc: "以 Cursor Agent (cursor-agent) 为执行主体，处理代码编辑与本机终端任务",
  },
  {
    bin: "opencode",
    skill: "opencode-agent",
    herdrKind: "opencode",
    name: "OpenCode Agent",
    // 无头 run 需要显式放开权限。参数名有版本差异，以目标机 opencode --help 为准：
    // 本机较新版本 --help 可见的是 --auto；--dangerously-skip-permissions 是旧名/隐藏别名。
    cmdTemplate: (b) => `${b} run --dangerously-skip-permissions {prompt}`,
    desc: "以 OpenCode (opencode) 为执行主体，处理本地编程与自动化任务",
  },
  {
    bin: "aider",
    skill: "aider-agent",
    name: "Aider Agent",
    cmdTemplate: (b) => `${b} --message {prompt} --yes`,
    desc: "以 Aider (aider) 为执行主体，处理本地代码修改任务",
  },
  {
    bin: "paseo",
    skill: "paseo-agent",
    name: "Paseo Agent",
    // 不写 --provider 时没有默认执行主体，运行必失败（mba/mini 两台因此集体翻车）。
    // 非交互沿用 antigravity；交互模式在选中后再问，并回填这条命令。
    cmdTemplate: (b) => paseoRunCommand(b),
    desc: "以 Paseo (paseo) 为执行主体，调度 Paseo 宿主或 Agent 执行复杂编排任务",
  },
  {
    bin: "orca",
    skill: "orca-agent",
    name: "Orca Agent",
    cmdTemplate: (b) => `${b} task run {prompt}`,
    desc: "以 Orca CLI (orca) 为执行主体，带多 Agent 与工作区环境执行终端与协同任务",
  },
];

export function discoverLocalAgents({ useHerdr } = {}) {
  const herdrEnabled = useHerdr === undefined ? Boolean(findExecutable("herdr")) : Boolean(useHerdr);
  const discovered = [];
  for (const item of KNOWN_AGENTS) {
    const fullPath = findExecutable(item.bin);
    if (fullPath) {
      const entry = {
        command: item.cmdTemplate(fullPath),
        desc: item.desc,
        mode: "agent",
        name: item.name,
        side_effect: "write",
        approval_class: "auto",
        timeout_sec: 900,
      };
      if (herdrEnabled && item.herdrKind) {
        entry.context = "herdr";
        entry.herdr_kind = item.herdrKind;
      }
      discovered.push({
        ...item,
        // Worker 名取旧能力名去掉 -agent 后缀，这样 Worker 名片的 Cap_ID 仍是 CAP-<前缀>-<x>-agent。
        worker: item.skill.replace(/-agent$/, ""),
        path: fullPath,
        entry,
      });
    }
  }
  return discovered;
}

// 本机 Agent 登记为 Worker（标准 §9）。每个 Worker 自带一项通用执行 agent（即 Worker 名片），不用另写技能条目。
// 旧版把它们写成名叫 <x>-agent 的扁平条目：同名 Worker 取代它，否则两者的 Cap_ID 会撞。
export function buildAgentCommands(selectedAgents, existingCommands = {}) {
  const result = { ...existingCommands };
  const old = result.workers;
  const workers = old && typeof old === "object" && !Array.isArray(old) ? { ...old } : {};
  for (const a of selectedAgents) {
    workers[a.worker] = a.entry;
    delete result[a.skill];
  }
  if (Object.keys(workers).length) result.workers = workers;
  return result;
}

// provider 空则 antigravity：paseo 没有默认执行主体时运行必失败。
// model 空只写 --provider <p>；非空写成 --provider <p>/<model>，钉在节点本地模板里。
export function formatPaseoProviderSpec(provider, model) {
  const p = String(provider ?? "").trim() || "antigravity";
  const m = String(model ?? "").trim();
  return m ? `${p}/${m}` : p;
}

export function paseoRunCommand(binPath, provider, model) {
  return `${binPath} agent run --provider ${formatPaseoProviderSpec(provider, model)} {prompt}`;
}

// 问题发生在「选了哪些 Agent」之后：没选 paseo 就不问。答案回填 command，
// 不改 cmdTemplate 的一元形状（discover 时还没有用户答案）。
async function applyPaseoInteractive(selectedAgents, ask) {
  const out = [];
  for (const agent of selectedAgents) {
    if (agent.skill !== "paseo-agent") {
      out.push(agent);
      continue;
    }
    const provider = await ask("Worker paseo 默认 provider", "antigravity");
    const model = await ask("Worker paseo 默认 model（可留空）", "");
    out.push({
      ...agent,
      entry: {
        ...agent.entry,
        command: paseoRunCommand(agent.path, provider, model),
      },
    });
  }
  return out;
}

function readLockedAppEnv(configDir) {
  const p = path.join(configDir, "app.env");
  let st;
  try { st = fs.lstatSync(p); } catch { return null; }
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o600) return { insecure: true };
  const kv = readEnvFile(p);
  return {
    apiToken: kv.AH_API_TOKEN || "",
  };
}

function detectLanIp() {
  try {
    const nets = os.networkInterfaces();
    for (const ifaces of Object.values(nets)) {
      for (const iface of (ifaces || [])) {
        if ((iface.family === "IPv4" || iface.family === 4) && !iface.internal && iface.address) {
          return iface.address;
        }
      }
    }
  } catch { /* 获取网卡失败则退回 127.0.0.1 */ }
  return "127.0.0.1";
}

function parseJoinHubUrl(rawUrl) {
  let raw = String(rawUrl ?? "").trim();
  if (!raw) throw new Error("缺少 Hub 访问地址");
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `http://${raw}`;
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("--hub-url / --join 必须是 http:// 或 https:// 地址");
  }
  let embeddedToken = "";
  if (parsed.username) {
    embeddedToken = decodeURIComponent(parsed.username);
  } else if (parsed.password) {
    embeddedToken = decodeURIComponent(parsed.password);
  } else if (parsed.searchParams.has("token")) {
    embeddedToken = String(parsed.searchParams.get("token") ?? "").trim();
  }
  parsed.username = "";
  parsed.password = "";
  parsed.searchParams.delete("token");
  return {
    hubUrl: parsed.toString().replace(/\/+$/, ""),
    embeddedToken: String(embeddedToken ?? "").trim(),
  };
}

export function setupHelpText() {
  return `用法：
  # 0. 一键启动独立中台 / 一键接入远端节点（推荐）
  ah up   [--node mac-mini] [--listen 0.0.0.0:8787] [--service]
  ah join http://[<token>@]<hub-ip>:8787 [--node worker-1] [--agent] [--agent-role worker|leader] [--token-file <path>] [--service]

  # 1. 独立自建主枢纽（Mac mini / SQLite + HTTP 长轮询 + Web 控制台）
  ah setup --hub [--node mac-mini] [--listen 0.0.0.0:8787] [--api-token <token>]
           [--db-path <path>] [--public-url <url>] [--kind host|agent] [--yes]

  # 2. 远程接入节点（通过 HTTP 长轮询接入主枢纽，自动同步 hubPublicKey）
  ah setup --join http://[<token>@]<hub-ip>:8787 [--node worker-1]
           [--api-token <token>] [--hub-key <hub 审批公钥>] [--kind host|agent] [--yes]

  --bus         显式指定总线模式：sqlite（独立 Hub）、http（远程长轮询节点）或 agent（官方 Agent Gateway 客户端）
  --agent       快捷等价于 --bus agent --kind agent。配合 --agent-role worker|leader 与 --token-file
  --agent-role  busType=agent 时的网关角色：worker（只接单）或 leader（派单并接单）
  --token-file  0600 凭据文件路径。只把路径写入 node.json，明文 Token 不进 node.json / app.env
  --hub         快捷等价于 --role hub --bus sqlite --auto-token
  --join        快捷接入地址（支持内嵌 token：http://<token>@<host>:8787），自动拉取公钥
  --auto-token  若未传口令，自动生成高强度随机 API Token
  --force       覆盖已有 node.json。未加时，已完成的配置会保留，不会静默改写
  --help        打印本帮助并退出`;
}

function writeLockedAppEnvVars(configDir, vars) {
  const appEnvPath = path.join(configDir, "app.env");
  const merged = {};
  try {
    for (const line of fs.readFileSync(appEnvPath, "utf8").split("\n")) {
      const idx = line.indexOf("=");
      if (idx > 0) merged[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  } catch { /* 文件不存在 */ }
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined && v !== null && String(v) !== "") merged[k] = String(v);
  }
  const content = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  fs.writeFileSync(appEnvPath, content, { mode: 0o600 });
  fs.chmodSync(appEnvPath, 0o600);
  return appEnvPath;
}

async function confirmOverwriteNodeJson(configDir, flags, interactive, ask) {
  fs.mkdirSync(configDir, { recursive: true });
  const nodeJsonPath = path.join(configDir, "node.json");
  const nodeExisted = fs.existsSync(nodeJsonPath);
  let existingRaw = null;
  let parsed = false;
  if (nodeExisted) {
    try {
      existingRaw = JSON.parse(fs.readFileSync(nodeJsonPath, "utf8"));
      parsed = true;
    } catch { /* 解析不了就按已有配置保护 */ }
  }
  const placeholder = parsed && isUnfinishedExample(existingRaw);
  if (nodeExisted && !flags.force) {
    if (placeholder) {
      if (interactive) {
        const ow = await ask("node.json 仍是示例占位符，覆盖并完成首装？(Y/n)", "Y");
        if (!/^y/i.test(ow)) { console.error("  ✗ 已保留现有 node.json，未做任何修改（--force 可强制覆盖）。"); return { ok: false, code: 4 }; }
      } else {
        console.log("  · 现有 node.json 仍是示例占位符，视为首装未完成，将覆盖");
      }
    } else {
      const ow = interactive ? await ask("node.json 已存在，覆盖？(y/N)", "N") : "N";
      if (!/^y/i.test(ow)) { console.error("  ✗ 已保留现有 node.json，未做任何修改（--force 可强制覆盖）。"); return { ok: false, code: 4 }; }
    }
  }
  return { ok: true, nodeJsonPath };
}

async function selectKind(flags, interactive, ask) {
  let kind = flags.kind || "";
  if (!kind) {
    if (interactive) {
      const k = await ask("这台机器是：1=电脑（宿主：拉起本机已装的 CLI Agent 干活），2=独立 Agent（本身就是 Agent，如 Muse，接单后交给它自己处理）", "1");
      return (k === "2" || /agent/i.test(k)) ? "agent" : "host";
    }
    return "host";
  }
  return /agent/i.test(kind) ? "agent" : "host";
}

async function finalizeSetup({ configDir, appDir, role, kind, node, prefix, bus, tables, flags, interactive, ask, busType = "", agentRole = "" }) {
  const cmdPath = path.join(configDir, "commands.json");
  if (busType === "agent") {
    // 官方 Gateway 客户端的能力在 Hub 名片上，本机不维护 commands.json，也不扫 PATH。
    console.log("  · busType=agent：能力由 Hub 名片登记，本机不写 commands.json");
    console.log("  ✓ 已写入 node.json");
    try { bus?.close?.(); } catch {}
    const shouldSkipSkill = flags.skipSkill || ["1", "true"].includes(String(process.env.AH_SKIP_SKILL || "").toLowerCase());
    try {
      installLocalSkills(appDir, { role, kind, agentRole, skipSkill: shouldSkipSkill });
    } catch {}
    let dc = await doctor(configDir, appDir, { role });
    if (dc !== 0) {
      console.error("  ✗ 自检未全过，按上面清单修完后运行 `ah doctor` 复查。");
      return dc;
    }
    let wantService = flags.service;
    if (!wantService && interactive) wantService = /^y/i.test(await ask("现在注册开机自启并启动守护？(Y/n)", "Y"));
    if (wantService) {
      const sc = await service(configDir, { role }, appDir);
      if (sc !== 0) { console.error("  ✗ 自启注册失败，看上面输出。"); return sc; }
      console.log("  ✓ 自启已注册、守护已启动。");
    } else {
      console.log(`  · 未注册自启；手动运行守护：ah daemon --config ${configDir}`);
    }
    console.log(`setup 完成：Agent Gateway 节点 ${node}（${agentRole || "worker"}）就绪，可通过 ah daemon 常驻。`);
    return 0;
  }
  const cmdExisted = fs.existsSync(cmdPath);
  let existingCmds = {};
  let isExample = false;
  if (cmdExisted) {
    try {
      existingCmds = JSON.parse(fs.readFileSync(cmdPath, "utf8"));
      isExample = isExampleCommands(existingCmds);
    } catch { /* 留着，下面不覆盖 */ }
  }

  let finalCmds;
  if (kind === "agent") {
    console.log("  · 节点类型为独立 Agent (kind=agent)：跳过本机 CLI Agent 扫描，配置专属能力 agent (mode: inbox)");
    finalCmds = (!cmdExisted || isExample) ? {
      agent: {
        desc: "以本 Agent 为执行主体的专属任务接入通道",
        mode: "inbox",
        name: node,
        side_effect: "write",
        approval_class: "auto",
        inbox_timeout_sec: 86400,
      },
    } : existingCmds;
  } else {
    const discoveredAgents = discoverLocalAgents();
    let selectedAgents = [];
    if (discoveredAgents.length > 0) {
      console.log(`\n  · 扫描到本机已安装 ${discoveredAgents.length} 个终端 Agent：`);
      discoveredAgents.forEach((a, idx) => {
        console.log(`    ${idx + 1}. [${a.worker}] ${a.name} (${a.path})`);
      });

      let pick = "all";
      if (interactive) {
        pick = await ask("选择要登记为 Worker 的本地 Agent（all=全部添加，none=都不添加，或填序号如 1,2,3）", "all");
      }
      const p = String(pick).trim().toLowerCase();
      if (p === "none" || p === "0") {
        selectedAgents = [];
      } else if (p === "all" || p === "" || p === "y" || p === "yes") {
        selectedAgents = discoveredAgents;
      } else {
        const indices = p.split(/[,，\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= discoveredAgents.length);
        selectedAgents = indices.map((i) => discoveredAgents[i - 1]);
      }
    } else {
      console.log("  · 未扫描到常见本机终端 Agent（本机暂无可接单能力，装好后重跑 ah setup 或手写 commands.json）");
    }

    if (interactive) selectedAgents = await applyPaseoInteractive(selectedAgents, ask);
    const baseCmds = (!cmdExisted || isExample) ? {} : existingCmds;
    finalCmds = buildAgentCommands(selectedAgents, baseCmds);
  }

  fs.writeFileSync(cmdPath, JSON.stringify(finalCmds, null, 1) + "\n");
  const names = Object.keys(normalizeCommands(finalCmds));
  console.log(`  ✓ 已写入 node.json、commands.json（共 ${names.length} 项能力：${names.join(", ") || "无"}）`);

  // 建立存量任务结果呈递水位线（baseline）：
  const presentStateFile = path.join(configDir, "present_state.json");
  try {
    if (!fs.existsSync(presentStateFile) && bus) {
      try {
        const { f1 } = await import("./bus/tables.mjs");
        const existingTasks = await bus.listRecords(tables.tasks);
        const baseKeys = [];
        for (const t of existingTasks) {
          const st = String(f1(t, "Status") ?? "");
          const tid = String(f1(t, "Task_ID") ?? "");
          if (!tid) continue;
          let hasPresentedKeys = false;
          try {
            const meta = JSON.parse(String(f1(t, "Metadata") ?? ""));
            hasPresentedKeys = Array.isArray(meta?.presented_keys) && meta.presented_keys.length > 0;
          } catch { /* Metadata 脏数据按未呈递处理 */ }
          const isTerm = ["completed", "failed", "rejected", "canceled"].includes(st);
          if (isTerm || hasPresentedKeys) {
            const smsg = String(f1(t, "Status_Msg") ?? "");
            const k = (["completed", "failed", "rejected"].includes(st)) ? `${tid}\t${st}\t${smsg}` : `${tid}\t${smsg}`;
            if (!baseKeys.includes(k)) baseKeys.push(k);
          }
        }
        fs.writeFileSync(presentStateFile, JSON.stringify({ keys: baseKeys }, null, 1), { mode: 0o600 });
        fs.chmodSync(presentStateFile, 0o600);
        if (baseKeys.length > 0) {
          console.log(`  ✓ 已建立存量任务结果呈递水位线（共 ${baseKeys.length} 项历史任务，避免首次启动重放）`);
        }
      } catch (e) {
        console.log("  · 存量任务水位线建立跳过：" + e.message);
      }
    }
  } finally {
    try { bus?.close?.(); } catch {}
  }

  // 按本机角色/形态自动安装对应 CLI Skill（支持 --skip-skill 或 AH_SKIP_SKILL=1 跳过）
  const shouldSkipSkill = flags.skipSkill || ["1", "true"].includes(String(process.env.AH_SKIP_SKILL || "").toLowerCase());
  try {
    installLocalSkills(appDir, { role, kind, agentRole, skipSkill: shouldSkipSkill });
  } catch {}

  // 自检
  let dc = await doctor(configDir, appDir, { role });
  if (role === "hub") {
    try {
      const { hubDoctor } = await import("./hub/index.mjs");
      const extra = await hubDoctor(configDir);
      if (extra) dc = 1;
    } catch (e) {
      console.error("  ✗ hub 自检模块加载失败：" + e.message);
      dc = 1;
    }
  }
  if (dc !== 0) {
    console.error(`  ✗ 自检未全过，按上面清单修完后运行 \`ah doctor${role === "hub" ? " --role hub" : ""}\` 复查。`);
    return dc;
  }

  // 自启（可选）
  let wantService = flags.service;
  if (!wantService && interactive) wantService = /^y/i.test(await ask("现在注册开机自启并启动守护？(Y/n)", "Y"));
  if (wantService) {
    const sc = await service(configDir, { role }, appDir);
    if (sc !== 0) { console.error("  ✗ 自启注册失败，看上面输出。"); return sc; }
    console.log("  ✓ 自启已注册、守护已启动。");
  } else {
    console.log(`  · 未注册自启；手动运行守护：ah daemon${role === "hub" ? " --role hub" : ""} --config ${configDir}`);
  }
  if (role === "hub") {
    console.log(`setup 完成：主枢纽 ${node} 就绪（带 ${names.length} 项本地能力），可通过 ah daemon --role hub 常驻。`);
  } else {
    console.log(`setup 完成：节点 ${node}（能力前缀 CAP-${prefix}-，带 ${names.length} 项本地能力），可通过 ah daemon 常驻。`);
  }
  return 0;
}

export async function runSetup(configDir, argv, appDir) {
  const flags = parseFlags(argv);
  if (flags.help) {
    console.log(setupHelpText());
    return 0;
  }
  const role = flags.role || "node";
  if (role !== "node" && role !== "hub") {
    console.error(`  ✗ --role 只能是 node 或 hub，收到：${role}`);
    return 2;
  }
  const interactive = !!process.stdin.isTTY && !flags.yes;
  let rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (q, def) => {
    if (!interactive) {
      if (def !== undefined) return def;
      throw new Error(`非交互模式缺少参数：${q}（请用命令行参数提供，或在终端里交互运行）`);
    }
    if (!rl) {
      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }
    const a = (await rl.question(def !== undefined && def !== "" ? `${q} [${def}] ` : `${q} `)).trim();
    return a || def || "";
  };

  try {
    console.log(`ah setup —— 一键配置${role === "hub" ? "主枢纽（hub，SQLite + HTTP 网关 + Web 控制台）" : "节点（node，HTTP 长轮询接入 Hub）"}`);
    console.log(`role: ${role}`);
    console.log(`config dir: ${configDir}`);

    // hub 的审批签名公钥：节点靠它验 auth_decision。
    let hubPublicKey = String(flags.hubKey ?? "").trim();
    if (!hubPublicKey) {
      try { hubPublicKey = String(JSON.parse(fs.readFileSync(path.join(configDir, "node.json"), "utf8")).hubPublicKey ?? "").trim(); }
      catch { /* 还没有 node.json */ }
    }
    if (hubPublicKey && !isHubPublicKey(hubPublicKey)) {
      throw new Error("--hub-key 不是有效的 hub 审批公钥（应为 hub 上 ah doctor 打印的那串 base64）");
    }

    const busFlag = String(flags.bus ?? "").trim().toLowerCase();
    if (busFlag && !["sqlite", "http", "agent"].includes(busFlag)) {
      console.error(`  ✗ --bus 只能是 sqlite、http 或 agent，收到：${busFlag}`);
      return 2;
    }
    const envHubUrl = String(process.env.HUB_URL ?? "").trim();
    const explicitHubUrl = String(flags.hubUrl ?? "").trim();
    let existingRaw = null;
    try { existingRaw = JSON.parse(fs.readFileSync(path.join(configDir, "node.json"), "utf8")); } catch {}

    let setupBus = busFlag;
    if (!setupBus) {
      if (explicitHubUrl || envHubUrl) setupBus = "http";
      else if (flags.listen || flags.dbPath || role === "hub") setupBus = "sqlite";
      else if (existingRaw && !isUnfinishedExample(existingRaw) && (existingRaw.busType === "sqlite" || existingRaw.busType === "http" || existingRaw.busType === "agent")) {
        setupBus = existingRaw.busType;
      } else if (existingRaw?.hubUrl) {
        setupBus = "http";
      } else if (interactive) {
        setupBus = "http";
      } else {
        console.error("  ✗ 非交互节点 setup 缺少 Hub 地址：请运行 `ah join http://<hub-ip>:8787` 或 `ah setup --hub`");
        return 2;
      }
    }

    if (setupBus === "agent" && role === "hub") {
      console.error("  ✗ busType=agent 的 role 必须是 node。网关里的 worker / leader 用 --agent-role 指定");
      return 2;
    }
    let agentRole = "";
    if (setupBus === "agent") {
      agentRole = String(flags.agentRole || "worker").trim().toLowerCase() || "worker";
      if (agentRole === "hybrid") agentRole = "leader";
      if (agentRole !== "worker" && agentRole !== "leader") {
        console.error(`  ✗ --agent-role 只能是 worker 或 leader，收到：${flags.agentRole}`);
        return 2;
      }
    }
    console.log(`  ✓ 总线模式：${setupBus === "sqlite" ? "独立主枢纽（SQLite + HTTP 长轮询服务端 + Web 控制台）" : setupBus === "agent" ? "官方 Agent Gateway 客户端（分 Agent Token，只出站）" : "远程节点（HTTP 长轮询接入独立 Hub）"}`);
    const kind = setupBus === "agent" ? "agent" : await selectKind(flags, interactive, ask);
    const hostDefault = os.hostname().split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-") || (role === "hub" ? "mac-mini" : "node");
    const nodeDefault = role === "hub" ? (flags.node || hostDefault || "hub") : (flags.node || hostDefault);
    const node = flags.node || (interactive ? await ask("给当前节点起个名字（中台按此名称派单）", nodeDefault) : nodeDefault);
    let zone = flags.zone || "";
    if (!zone) {
      if (role === "hub" || !interactive) zone = role === "hub" ? "work" : "home";
      else {
        const z = await ask("这台机器主要在哪用？输 1=家里，2=公司", "1");
        zone = (z === "2" || /work/i.test(z)) ? "work" : "home";
      }
    }
    const prefix = flags.prefix || (node === "hub" ? "hub" : (node.split("-").filter(Boolean).pop() || node));
    const nodeDesc = flags.desc ?? (role === "hub" ? "独立主枢纽节点（调度＋Web控制台＋审批呈递）" : (kind === "agent" ? `${node} 独立 Agent` : ""));

    let resolvedHubUrl = "";
    let embeddedToken = "";
    if (setupBus === "http" || setupBus === "agent") {
      const rawUrl = explicitHubUrl || envHubUrl || existingRaw?.hubUrl || await ask("输入独立 Hub 的访问地址（例如 http://192.168.1.10:8787 或 http://<token>@192.168.1.10:8787）");
      const parsedJoin = parseJoinHubUrl(rawUrl);
      resolvedHubUrl = parsedJoin.hubUrl;
      embeddedToken = parsedJoin.embeddedToken;
    }

    const appEnvCreds = readLockedAppEnv(configDir);
    let apiToken = (
      String(flags.apiToken ?? "").trim()
      || embeddedToken
      || String(process.env.AH_API_TOKEN ?? "").trim()
      || String(existingRaw?.apiToken ?? "").trim()
      || String(appEnvCreds?.apiToken ?? "").trim()
    );
    if (!apiToken) {
      if (setupBus === "sqlite" && flags.autoToken) {
        apiToken = crypto.randomBytes(18).toString("base64url");
      } else if (interactive) {
        apiToken = (await ask("设置访问口令 AH_API_TOKEN（留空不设口令；暴露局域网/公网建议设置）", "")).trim();
      }
    }

    const owRes = await confirmOverwriteNodeJson(configDir, flags, interactive, ask);
    if (!owRes.ok) return owRes.code;

    const tables = normalizeTables(existingRaw?.tables);
    const hasHerdr = kind === "host" && Boolean(findExecutable("herdr"));
    let bus = null;
    const nodeJson = {
      node,
      role,
      kind,
      busType: setupBus,
      zone: zone || "work",
      nodeDesc,
      capPrefix: prefix,
      pollSec: 45,
      sweepSec: 900,
      longPollSec: 25,
      events: true,
      tables,
    };
    if (hasHerdr) {
      nodeJson.maxConcurrent = Number(existingRaw?.maxConcurrent) > 0 ? Number(existingRaw.maxConcurrent) : 4;
      console.log(`  ✓ 检测到 herdr：本机 Agent 将默认使用 context=herdr 调度（maxConcurrent=${nodeJson.maxConcurrent}）`);
    }

    // tokenFile 只记路径。明文留在那份 0600 文件里，不复制进 node.json 或 app.env。
    if (apiToken && !(setupBus === "agent" && flags.tokenFile)) {
      const appEnvPath = writeLockedAppEnvVars(configDir, {
        AH_API_TOKEN: apiToken,
      });
      nodeJson.appEnv = appEnvPath;
      console.log("  ✓ 已保存访问口令至 app.env（600）");
    }

    let listenAddr = null;
    let publicUrl = "";
    if (setupBus === "sqlite") {
      const listenRaw = flags.listen || existingRaw?.listen || (interactive ? await ask("HTTP 监听地址", "0.0.0.0:8787") : "0.0.0.0:8787");
      listenAddr = resolveListenAddr(listenRaw);
      const listen = `${listenAddr.host}:${listenAddr.port}`;
      const dbPath = flags.dbPath || existingRaw?.dbPath || path.join(configDir, "hub.db");
      publicUrl = String(flags.publicUrl ?? existingRaw?.publicUrl ?? "").trim();
      nodeJson.listen = listen;
      nodeJson.dbPath = dbPath;
      if (publicUrl) nodeJson.publicUrl = publicUrl;
      bus = new SqliteBus({ dbPath, tables });
    } else if (setupBus === "agent") {
      nodeJson.hubUrl = resolvedHubUrl;
      nodeJson.kind = "agent";
      nodeJson.agentRole = agentRole;
      nodeJson.receiveMode = "http-longpoll";
      if (flags.tokenFile) nodeJson.tokenFile = flags.tokenFile;
      if (hubPublicKey) nodeJson.hubPublicKey = hubPublicKey;
      let probeToken = "";
      if (flags.tokenFile) {
        try { probeToken = readTokenFile(flags.tokenFile, configDir); }
        catch (e) { console.log(`  · ${e.message}，探活将不带凭据`); }
      } else {
        probeToken = apiToken;
      }
      const client = new AgentGatewayClient({
        hubUrl: resolvedHubUrl,
        apiToken: probeToken,
        node,
        agentRole,
        receiveMode: "http-longpoll",
        nodeDesc,
      });
      try {
        const health = await client.health();
        console.log(`  ✓ 远程 Hub 在线（${health?.node ?? resolvedHubUrl}，seq=${health?.seq ?? 0}）`);
        if (!hubPublicKey && health?.hubPublicKey && isHubPublicKey(health.hubPublicKey)) {
          hubPublicKey = health.hubPublicKey;
          nodeJson.hubPublicKey = hubPublicKey;
          console.log("  ✓ 已从远程 Hub 自动同步 ed25519 审批公钥");
        }
        const check = await client.check();
        console.log(`  ✓ Agent Gateway /check 可达（work=${check?.work ? "yes" : "no"}）`);
      } catch (e) {
        console.log(`  · 暂未连上 Agent Gateway（${e.message}），将继续写入本地配置`);
      }
    } else {
      nodeJson.hubUrl = resolvedHubUrl;
      if (role !== "hub" && hubPublicKey) nodeJson.hubPublicKey = hubPublicKey;
      bus = new HttpBus({ hubUrl: resolvedHubUrl, apiToken, node, tables });
      try {
        const health = await bus.api("GET", "/api/v1/health");
        console.log(`  ✓ 远程 Hub 在线（${health?.node ?? resolvedHubUrl}，seq=${health?.seq ?? 0}）`);
        if (!hubPublicKey && health?.hubPublicKey && isHubPublicKey(health.hubPublicKey)) {
          hubPublicKey = health.hubPublicKey;
          if (role !== "hub") nodeJson.hubPublicKey = hubPublicKey;
          console.log("  ✓ 已从远程 Hub 自动同步 ed25519 审批公钥");
        }
      } catch (e) {
        console.log(`  · 暂未连上远程 Hub（${e.message}），将继续写入本地配置`);
      }
    }

    fs.writeFileSync(owRes.nodeJsonPath, JSON.stringify(nodeJson, null, 1) + "\n");
    if (role === "hub") {
      const key = loadOrCreateHubKey(configDir);
      console.log(`  ✓ 审批签名密钥就绪（approval_key.pem，600），公钥：\n    ${key.publicKey}`);
      if (listenAddr) {
        const displayHost = (listenAddr.host === "0.0.0.0" || listenAddr.host === "::") ? detectLanIp() : listenAddr.host;
        const baseDisplay = publicUrl ? publicUrl.replace(/\/+$/, "") : `http://${displayHost}:${listenAddr.port}`;
        const joinHostUrl = new URL(baseDisplay);
        if (apiToken) joinHostUrl.username = encodeURIComponent(apiToken);
        const joinStr = joinHostUrl.toString().replace(/\/+$/, "");
        const consoleUrl = apiToken ? `${baseDisplay}/?token=${encodeURIComponent(apiToken)}` : baseDisplay;
        console.log(`  ✓ Web 控制台地址：${consoleUrl}`);
        console.log(`  ✓ 其他机器一行接入命令（已安装 ah）：\n    ah join ${joinStr}`);
        console.log(`  ✓ 全新机器一行安装并接入：\n    curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh -s -- --join ${joinStr}`);
      }
    } else if (!hubPublicKey) {
      console.log("  · 未配置 hubPublicKey：Hub 在线时执行 ah join 或 ah setup --hub-key <公钥> 可开启 ed25519 审批验签。");
    }

    return await finalizeSetup({ configDir, appDir, role, kind, node, prefix, bus, tables, flags, interactive, ask, busType: setupBus, agentRole });
  } finally {
    if (rl) {
      try { rl.close(); } catch {}
      rl = null;
    }
  }
}
