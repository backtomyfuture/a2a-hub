// 统一配置加载与本地 Agent CLI 发现（v2.0）。
// 仅保留三种极简文件：config.json（身份与连接）、workers.json（本机 CLI 能力）、app.env（机主密钥与通知）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DAEMON_VERSION = "2.0.0";
export const STALE_MIN = 20;
export const MAX_RETRIES = 2;
export const DEFAULT_TIMEOUT_SEC = 600;
export const MAX_TIMEOUT_SEC = 3600;
export const HEARTBEAT_MIN_SEC = 90;

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 指令与数据分离红线：任务参数中严禁夹带任何可执行覆盖字段。
export const EXEC_CONTROL_KEYS = new Set([
  "command",
  "cmd",
  "argv",
  "args",
  "cwd",
  "workdir",
  "shell",
  "env",
  "timeout",
  "timeout_sec",
  "resume_command",
  "approval_policy",
  "verify",
]);

export function controlKeysIn(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  const found = [];
  for (const k of Object.keys(obj)) {
    if (EXEC_CONTROL_KEYS.has(String(k).toLowerCase())) {
      found.push(k);
    }
  }
  return found;
}

export function clampTimeoutSec(raw, maxSec = MAX_TIMEOUT_SEC) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_SEC;
  return Math.min(Math.max(Math.trunc(n), 10), maxSec);
}

export function parseBoolSetting(raw) {
  if (typeof raw === "boolean") return raw;
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return null;
}

// 解析是否禁用 Hub 本机 DeviceDaemon（CLI 显式参数 > 环境变量 AH_NO_DEVICE > config.json.noDevice）。
export function resolveNoDeviceSetting({ flags = null, env = process.env, cfg = null } = {}) {
  if (flags && flags["no-device"] !== undefined) {
    const flagVal = parseBoolSetting(flags["no-device"]);
    if (flagVal !== null) return flagVal;
  }
  if (flags?.device || flags?.node) return false;
  const envVal = parseBoolSetting(env?.AH_NO_DEVICE);
  if (envVal !== null) return envVal;
  return Boolean(cfg?.noDevice);
}

export function defaultConfigDir() {
  if (process.env.AH_HOME && process.env.AH_HOME.trim()) {
    return path.resolve(process.env.AH_HOME.trim());
  }
  return path.join(os.homedir(), ".a2a-hub");
}

export function sanitizeSlug(raw, fallback = "default") {
  const s = String(raw || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || fallback;
}

export function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(filePath, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch {}
}

export function readEnvFile(envPath) {
  const out = {};
  let raw = "";
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function formatEnvValue(val) {
  const s = String(val ?? "");
  if (/^[A-Za-z0-9_./:@-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

export function writeLockedAppEnvVars(configDir, updates = {}) {
  const envPath = path.join(configDir, "app.env");
  fs.mkdirSync(configDir, { recursive: true });
  const cur = readEnvFile(envPath);
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined || v === null) {
      delete cur[k];
    } else {
      cur[k] = String(v);
    }
  }
  const lines = [
    "# a2a-hub 运行时密钥与通知配置（0600 仅机主可读，勿提交到版本库）",
    ...Object.entries(cur).map(([k, v]) => `${k}=${formatEnvValue(v)}`),
  ];
  const tmp = `${envPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, lines.join("\n") + "\n", { mode: 0o600 });
  fs.renameSync(tmp, envPath);
  try {
    fs.chmodSync(envPath, 0o600);
  } catch {}
  return envPath;
}

export function loadAppEnv(configDir) {
  return {
    ...readEnvFile(path.join(configDir, "app.env")),
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined)
    ),
  };
}

export function loadConfigJson(configDir) {
  return readJsonIfExists(path.join(configDir, "config.json"), {});
}

export function saveConfigJson(configDir, cfg) {
  writeJsonAtomic(path.join(configDir, "config.json"), cfg, 0o600);
}

export function loadWorkersJson(configDir) {
  const raw = readJsonIfExists(path.join(configDir, "workers.json"), []);
  return Array.isArray(raw) ? raw : Array.isArray(raw?.workers) ? raw.workers : [];
}

export function saveWorkersJson(configDir, workers) {
  writeJsonAtomic(path.join(configDir, "workers.json"), Array.isArray(workers) ? workers : [], 0o600);
}

export function loadOwnerToken(configDir, env = process.env) {
  if (env.AH_API_TOKEN && String(env.AH_API_TOKEN).trim()) {
    return String(env.AH_API_TOKEN).trim();
  }
  const appEnv = readEnvFile(path.join(configDir, "app.env"));
  if (appEnv.AH_API_TOKEN && String(appEnv.AH_API_TOKEN).trim()) {
    return String(appEnv.AH_API_TOKEN).trim();
  }
  const cfg = loadConfigJson(configDir);
  if (cfg.tokenFile) {
    const tf = path.isAbsolute(cfg.tokenFile) ? cfg.tokenFile : path.resolve(configDir, cfg.tokenFile);
    if (fs.existsSync(tf)) {
      try {
        const fromFile = fs.readFileSync(tf, "utf8").trim();
        if (fromFile) return fromFile;
      } catch {}
    }
  }
  if (cfg.apiToken && String(cfg.apiToken).trim()) {
    return String(cfg.apiToken).trim();
  }
  return "";
}

export function resolveListenAddr(listen = "", env = process.env) {
  const portEnv = Number(env.PORT);
  let raw = String(listen || env.AH_LISTEN || "").trim();
  if (!raw && Number.isFinite(portEnv) && portEnv > 0) {
    raw = `0.0.0.0:${portEnv}`;
  }
  if (!raw) raw = "0.0.0.0:8787";
  if (/^\d+$/.test(raw)) raw = `0.0.0.0:${raw}`;
  const lastColon = raw.lastIndexOf(":");
  const host = lastColon > 0 ? raw.slice(0, lastColon).replace(/^\[|\]$/g, "") : "0.0.0.0";
  const parsedPort = lastColon > 0 ? Number(raw.slice(lastColon + 1)) : NaN;
  const port = Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : 8787;
  const connectHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return {
    listen: `${host}:${port}`,
    host,
    port,
    url: `http://${connectHost}:${port}`,
  };
}

export function inferCloudPublicUrl(env = process.env) {
  if (env.AH_PUBLIC_URL) return String(env.AH_PUBLIC_URL).replace(/\/+$/, "");
  if (env.RENDER_EXTERNAL_URL) return String(env.RENDER_EXTERNAL_URL).replace(/\/+$/, "");
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${String(env.RAILWAY_PUBLIC_DOMAIN).replace(/^https?:\/\//, "")}`;
  if (env.FLY_APP_NAME) return `https://${env.FLY_APP_NAME}.fly.dev`;
  if (env.ZEABUR_URL) return String(env.ZEABUR_URL).replace(/\/+$/, "");
  return "";
}

export function readLiveHubUrl(configDir) {
  const appEnv = loadAppEnv(configDir);
  if (appEnv.AH_PUBLIC_URL) return String(appEnv.AH_PUBLIC_URL).replace(/\/+$/, "");
  const rt = readJsonIfExists(path.join(configDir, "hub_runtime.json"), null);
  if (rt?.public_url) return String(rt.public_url).replace(/\/+$/, "");
  if (rt?.url) return String(rt.url).replace(/\/+$/, "");
  const cfg = loadConfigJson(configDir);
  if (cfg.hubUrl) return String(cfg.hubUrl).replace(/\/+$/, "");
  return resolveListenAddr(cfg.listen, appEnv).url;
}

// ---- 本地 CLI 自动发现与模型探测 ----

export const KNOWN_CLIS = [
  {
    key: "claude",
    bin: "claude",
    name: "Claude Code",
    platform: "claude-code",
    summary: "本机 Anthropic Claude Code 编程与仓库操作 CLI",
    skills: ["coding", "refactor", "debug", "review", "git"],
    tools: ["bash", "files", "git", "web"],
    modelFlag: "--model",
    command: "{bin} -p --output-format json --dangerously-skip-permissions {model_args} {prompt}",
    resumeCommand: "{bin} --resume {session} -p --output-format json --dangerously-skip-permissions {model_args} {prompt}",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: ["claude-sonnet-4-5", "claude-opus-4-5"],
  },
  {
    key: "codex",
    bin: "codex",
    name: "Codex CLI",
    platform: "codex",
    summary: "本机 OpenAI Codex 非交互代码执行与测试 CLI",
    skills: ["coding", "test", "debug", "review"],
    tools: ["bash", "files", "git"],
    modelFlag: "-m",
    command: "{bin} exec --dangerously-bypass-approvals-and-sandbox --json --skip-git-repo-check {model_args} {prompt}",
    resumeCommand: "{bin} exec resume --dangerously-bypass-approvals-and-sandbox --json --skip-git-repo-check {model_args} {session} {prompt}",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: ["gpt-5.3-codex", "o3"],
  },
  {
    key: "opencode",
    bin: "opencode",
    name: "OpenCode",
    platform: "opencode",
    summary: "本机多模型 OpenCode 编程与任务执行 CLI",
    skills: ["coding", "refactor", "analysis"],
    tools: ["bash", "files", "git"],
    modelFlag: "-m",
    command: "{bin} run --format json {model_args} {prompt}",
    resumeCommand: "{bin} run -s {session} --format json {model_args} {prompt}",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "gemini",
    bin: "gemini",
    name: "Gemini CLI",
    platform: "gemini-cli",
    summary: "本机 Google Gemini 终端代理与搜索 CLI",
    skills: ["coding", "research", "analysis"],
    tools: ["bash", "files", "web"],
    modelFlag: "-m",
    command: "{bin} -p {prompt} {model_args} --yolo",
    resumeCommand: "",
    timeoutSec: 600,
    approvalPolicy: "never",
    defaultModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  {
    key: "aider",
    bin: "aider",
    name: "Aider",
    platform: "aider",
    summary: "本机 Aider AI Git 结对编程工具",
    skills: ["coding", "git", "patch"],
    tools: ["files", "git"],
    modelFlag: "--model",
    command: "{bin} --yes --no-auto-commits {model_args} --message {prompt}",
    resumeCommand: "",
    timeoutSec: 600,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "goose",
    bin: "goose",
    name: "Goose",
    platform: "goose",
    summary: "本机 Goose 开源自动化工程助手 CLI",
    skills: ["coding", "automation"],
    tools: ["bash", "files"],
    modelFlag: "",
    command: "{bin} run --text {prompt}",
    resumeCommand: "",
    timeoutSec: 600,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "amp",
    bin: "amp",
    name: "Amp CLI",
    platform: "amp",
    summary: "本机 Sourcegraph Amp 自主编程与多步工程 CLI",
    skills: ["coding", "refactor", "debug", "review", "git"],
    tools: ["bash", "files", "git", "web"],
    modelFlag: "--model",
    command: "{bin} --dangerously-allow-all --stream-json {model_args} -x {prompt}",
    resumeCommand: "{bin} threads continue {session} --dangerously-allow-all --stream-json -x {prompt}",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "droid",
    bin: "droid",
    name: "Factory Droid",
    platform: "droid",
    summary: "本机 Factory Droid 工程代理与多步代码执行 CLI",
    skills: ["coding", "refactor", "test", "debug", "git"],
    tools: ["bash", "files", "git", "web"],
    modelFlag: "-m",
    command: "{bin} exec --output-format json --auto high {model_args} {prompt}",
    resumeCommand: "{bin} exec --output-format json --auto high -s {session} {model_args} {prompt}",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "agy",
    bin: "agy",
    name: "Antigravity CLI",
    platform: "antigravity",
    summary: "本机 Google Antigravity 终端工程与多模态代理 CLI",
    skills: ["coding", "research", "debug", "review", "git"],
    tools: ["bash", "files", "git", "web"],
    modelFlag: "--model",
    // agy 的 -p/--prompt 为带值参数，须紧邻 {prompt} 放在其他 flag 之后
    command: "{bin} --output-format json --dangerously-skip-permissions {model_args} -p {prompt}",
    resumeCommand: "{bin} --conversation {session} --output-format json --dangerously-skip-permissions {model_args} -p {prompt}",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "grok",
    bin: "grok",
    name: "Grok CLI",
    platform: "grok",
    summary: "本机 xAI Grok Build 编程与实时搜索 CLI",
    skills: ["coding", "research", "debug", "web"],
    tools: ["bash", "files", "git", "web"],
    modelFlag: "-m",
    command: "{bin} --output-format json --always-approve {model_args} -p {prompt}",
    resumeCommand: "{bin} --output-format json --always-approve -r {session} {model_args} -p {prompt}",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "cursor",
    bin: "cursor-agent",
    name: "Cursor Agent",
    platform: "cursor",
    summary: "本机 Cursor Agent CLI 代码编辑与终端执行代理",
    skills: ["coding", "refactor", "debug", "review"],
    tools: ["bash", "files", "git"],
    modelFlag: "--model",
    command: "{bin} -p --output-format json --force {model_args} {prompt}",
    resumeCommand: "{bin} -p --output-format json --force --resume {session} {model_args} {prompt}",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "codebuddy",
    bin: "codebuddy",
    bins: ["codebuddy", "cbc"],
    name: "CodeBuddy Code",
    platform: "codebuddy",
    summary: "本机腾讯 CodeBuddy Code 编程与多模型开发 CLI",
    skills: ["coding", "refactor", "debug", "review"],
    tools: ["bash", "files", "git"],
    modelFlag: "--model",
    command: "{bin} -p --output-format json -y {model_args} {prompt}",
    resumeCommand: "{bin} -p --output-format json -y -r {session} {model_args} {prompt}",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "copilot",
    bin: "copilot",
    name: "GitHub Copilot CLI",
    platform: "copilot",
    summary: "本机 GitHub Copilot 终端编程与仓库助手 CLI",
    skills: ["coding", "review", "debug", "git"],
    tools: ["bash", "files", "git"],
    modelFlag: "--model",
    command: "{bin} -p {prompt} --allow-all --silent {model_args}",
    resumeCommand: "",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "qwen",
    bin: "qwen",
    name: "Qwen Code",
    platform: "qwen-code",
    summary: "本机阿里通义千问 Qwen Code 终端编程代理 CLI",
    skills: ["coding", "refactor", "debug", "analysis"],
    tools: ["bash", "files", "git"],
    modelFlag: "-m",
    command: "{bin} -p {prompt} --yolo --output-format json {model_args}",
    resumeCommand: "{bin} --resume {session} -p {prompt} --yolo --output-format json {model_args}",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "kimi",
    bin: "kimi",
    name: "Kimi Code CLI",
    platform: "kimi",
    summary: "本机月之暗面 Kimi Code 终端代理 CLI",
    skills: ["coding", "analysis", "refactor"],
    tools: ["bash", "files", "git"],
    modelFlag: "-m",
    // kimi -p 与 --yolo/-y 互斥，非交互模式无需也不得附带 --yolo
    command: "{bin} -p {prompt} --output-format stream-json {model_args}",
    resumeCommand: "{bin} -S {session} -p {prompt} --output-format stream-json {model_args}",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "kiro",
    bin: "kiro-cli",
    name: "AWS Kiro CLI",
    platform: "kiro",
    summary: "本机 AWS Kiro 规范驱动开发与云资源自动化 CLI",
    skills: ["coding", "cloud", "devops", "spec"],
    tools: ["bash", "files", "git"],
    modelFlag: "--model",
    command: "{bin} chat --no-interactive --trust-all-tools {model_args} {prompt}",
    resumeCommand: "",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "cline",
    bin: "cline",
    name: "Cline CLI",
    platform: "cline",
    summary: "本机 Cline 自主编程与多模型任务执行 CLI",
    skills: ["coding", "refactor", "debug", "automation"],
    tools: ["bash", "files", "git"],
    modelFlag: "-m",
    command: "{bin} -y --json {model_args} {prompt}",
    resumeCommand: "",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "kilo",
    bin: "kilo",
    bins: ["kilo", "kilocode"],
    name: "Kilo Code CLI",
    platform: "kilo",
    summary: "本机 Kilo Code 开源多模型自主开发 CLI",
    skills: ["coding", "refactor", "debug"],
    tools: ["bash", "files", "git"],
    modelFlag: "-m",
    command: "{bin} run --auto --format json {model_args} {prompt}",
    resumeCommand: "",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "auggie",
    bin: "auggie",
    name: "Augment Auggie",
    platform: "auggie",
    summary: "本机 Augment Code 上下文引擎与代码库分析 CLI",
    skills: ["coding", "review", "research", "refactor"],
    tools: ["bash", "files", "git"],
    modelFlag: "--model",
    command: "{bin} --print {model_args} {prompt}",
    resumeCommand: "{bin} --print --resume {session} {model_args} {prompt}",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "vibe",
    bin: "vibe",
    name: "Mistral Vibe",
    platform: "vibe",
    summary: "本机 Mistral Vibe Devstral 轻量终端编程 CLI",
    skills: ["coding", "refactor", "debug"],
    tools: ["bash", "files", "git"],
    modelFlag: "",
    command: "{bin} -p {prompt} --auto-approve --output json",
    resumeCommand: "{bin} --resume {session} -p {prompt} --auto-approve --output json",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "crush",
    bin: "crush",
    name: "Charm Crush",
    platform: "crush",
    summary: "本机 Charmbracelet Crush 终端多模型编程 CLI",
    skills: ["coding", "debug", "analysis"],
    tools: ["bash", "files", "git"],
    modelFlag: "",
    // crush run 默认无交互且不接受 --yolo/--model 参数
    command: "{bin} run {prompt}",
    resumeCommand: "",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "pi",
    bin: "pi",
    name: "Pi Coding Agent",
    platform: "pi",
    summary: "本机 Pi 极简可扩展终端编程 Agent CLI",
    skills: ["coding", "automation", "refactor"],
    tools: ["bash", "files", "git"],
    modelFlag: "--model",
    command: "{bin} -p --mode json {model_args} {prompt}",
    resumeCommand: "",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "devin",
    bin: "devin",
    name: "Devin CLI",
    platform: "devin",
    summary: "本机 Cognition Devin 自主软件工程代理 CLI",
    skills: ["coding", "debug", "test", "git"],
    tools: ["bash", "files", "git", "web"],
    modelFlag: "--model",
    // devin -p 在未信任工作区需 --respect-workspace-trust false 才能无交互运行
    command: "{bin} --permission-mode dangerous --respect-workspace-trust false {model_args} -p {prompt}",
    resumeCommand: "",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "openhands",
    bin: "openhands",
    name: "OpenHands CLI",
    platform: "openhands",
    summary: "本机 OpenHands 开源端到端软件工程代理 CLI",
    skills: ["coding", "automation", "debug", "test"],
    tools: ["bash", "files", "git"],
    modelFlag: "",
    command: "{bin} --headless --json -t {prompt}",
    resumeCommand: "",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "iflow",
    bin: "iflow",
    name: "iFlow CLI",
    platform: "iflow",
    summary: "本机阿里心流 iFlow 终端工程与自动化代理 CLI",
    skills: ["coding", "automation", "analysis"],
    tools: ["bash", "files", "git"],
    modelFlag: "-m",
    command: "{bin} -p {prompt} --yolo {model_args}",
    resumeCommand: "",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
  {
    key: "qoder",
    bin: "qodercli",
    bins: ["qodercli", "qoder"],
    name: "Qoder CLI",
    platform: "qoder",
    summary: "本机阿里 Qoder 终端自主编程与仓库审查 CLI",
    skills: ["coding", "review", "refactor", "git"],
    tools: ["bash", "files", "git"],
    modelFlag: "",
    command: "{bin} -p {prompt} --output-format json --yolo",
    resumeCommand: "",
    timeoutSec: 900,
    approvalPolicy: "never",
    defaultModels: [],
  },
];

function isExecutableFile(filePath) {
  try {
    // statSync 会解引用软链，自动排除指向已删除目标的坏链与目录
    const st = fs.statSync(filePath);
    if (!st.isFile()) return false;
    if (process.platform !== "win32") {
      fs.accessSync(filePath, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export function whichBinary(name, { env = process.env, homeDir = os.homedir() } = {}) {
  const target = String(name || "").trim();
  if (!target) return null;

  const isWin = process.platform === "win32";
  const pathExts = isWin
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((e) => e.trim())
        .filter(Boolean)
    : [""];

  const probe = (basePath) => {
    const candidates = isWin && !path.extname(basePath) ? [basePath, ...pathExts.map((ext) => `${basePath}${ext}`)] : [basePath];
    for (const c of candidates) {
      if (isExecutableFile(c)) return c;
    }
    return null;
  };

  if (target.includes("/") || (isWin && target.includes("\\"))) {
    return probe(target);
  }

  const rawPath = env.PATH || (isWin ? env.Path : "") || "";
  const pathDirs = rawPath.split(path.delimiter).map((d) => d.trim()).filter(Boolean);
  const searchDirs = [...pathDirs];
  if (!isWin) {
    const fallbacks = [
      path.join(homeDir, ".local", "bin"),
      path.join(homeDir, ".amp", "bin"),
      path.join(homeDir, ".grok", "bin"),
      path.join(homeDir, ".bun", "bin"),
      path.join(homeDir, ".cargo", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ];
    for (const dir of fallbacks) {
      searchDirs.push(dir);
    }
  } else {
    const fallbacks = [
      path.join(homeDir, "AppData", "Roaming", "npm"),
      path.join(homeDir, ".local", "bin"),
      path.join(homeDir, ".cargo", "bin"),
      path.join(homeDir, "AppData", "Local", "Programs"),
    ];
    for (const dir of fallbacks) {
      searchDirs.push(dir);
    }
  }

  const seen = new Set();
  for (const dir of searchDirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const hit = probe(path.join(dir, target));
    if (hit) return hit;
  }
  return null;
}

export function resolveSpecBinary(spec, whichFn = whichBinary) {
  const candidates = Array.isArray(spec?.bins) && spec.bins.length ? spec.bins : [spec?.bin];
  for (const bin of candidates) {
    if (!bin) continue;
    const hit = whichFn(bin);
    if (hit) return hit;
  }
  return null;
}

const JSON_MODEL_PATHS = {
  claude: [".claude", "settings.json"],
  opencode: [".config", "opencode", "opencode.json"],
  gemini: [".gemini", "settings.json"],
  qwen: [".qwen", "settings.json"],
  codebuddy: [".codebuddy", "settings.json"],
  agy: [".agy", "settings.json"],
  iflow: [".iflow", "settings.json"],
};

const TOML_MODEL_SPECS = {
  codex: { parts: [".codex", "config.toml"], key: "model" },
  grok: { parts: [".grok", "config.toml"], key: "model" },
  kimi: { parts: [".kimi", "config.toml"], key: "default_model" },
};

export function detectDefaultModel(key, homeDir = os.homedir()) {
  try {
    if (JSON_MODEL_PATHS[key]) {
      const s = readJsonIfExists(path.join(homeDir, ...JSON_MODEL_PATHS[key]), null);
      if (typeof s?.model === "string" && s.model.trim()) return s.model.trim();
    } else if (TOML_MODEL_SPECS[key]) {
      const { parts, key: tomlKey } = TOML_MODEL_SPECS[key];
      const tomlPath = path.join(homeDir, ...parts);
      if (fs.existsSync(tomlPath)) {
        const re = new RegExp(`^\\s*${tomlKey}\\s*=\\s*["']([^"']+)["']`, "m");
        const m = re.exec(fs.readFileSync(tomlPath, "utf8"));
        if (m) return m[1].trim();
      }
    } else if (key === "droid") {
      // 仅读取纯字符串模型字段，避免接触任何自定义 API 配置或密钥
      const f = readJsonIfExists(path.join(homeDir, ".factory", "settings.json"), null);
      if (typeof f?.model === "string" && f.model.trim()) return f.model.trim();
      if (typeof f?.defaultModel === "string" && f.defaultModel.trim()) return f.defaultModel.trim();
    } else if (key === "cursor") {
      const c = readJsonIfExists(path.join(homeDir, ".cursor", "cli-config.json"), null);
      const mid = typeof c?.model === "string" ? c.model : c?.model?.modelId;
      if (typeof mid === "string") {
        const trimmed = mid.trim();
        if (trimmed && trimmed !== "default" && trimmed !== "auto") return trimmed;
      }
    }
  } catch {}
  return "";
}

export function discoverLocalWorkers({ whichFn = whichBinary, homeDir = os.homedir(), defaultCwd = os.homedir() } = {}) {
  const found = [];
  for (const spec of KNOWN_CLIS) {
    const binPath = resolveSpecBinary(spec, whichFn);
    if (!binPath) continue;
    const detectedModel = detectDefaultModel(spec.key, homeDir);
    const models = [...spec.defaultModels];
    if (detectedModel && !models.includes(detectedModel)) {
      models.unshift(detectedModel);
    }
    const safeBin = binPath.includes(" ") ? `"${binPath}"` : binPath;
    found.push({
      key: spec.key,
      name: spec.name,
      role: "worker",
      platform: spec.platform,
      summary: spec.summary,
      skills: [...spec.skills],
      tools: [...spec.tools],
      models,
      default_model: detectedModel || models[0] || "",
      model_flag: spec.modelFlag,
      command: spec.command.replace(/\{bin\}/g, safeBin),
      resume_command: spec.resumeCommand ? spec.resumeCommand.replace(/\{bin\}/g, safeBin) : "",
      cwd: defaultCwd,
      timeout_sec: spec.timeoutSec,
      approval_policy: spec.approvalPolicy,
      enabled: true,
    });
  }
  return found;
}

export function mergeDiscoveredWorkers(existingWorkers = [], discoveredWorkers = [], { force = false } = {}) {
  const existing = Array.isArray(existingWorkers) ? existingWorkers.filter((w) => w && w.key) : [];
  const discovered = Array.isArray(discoveredWorkers) ? discoveredWorkers.filter((w) => w && w.key) : [];
  const discoveredByKey = new Map(discovered.map((w) => [w.key, w]));

  const workers = [];
  const added = [];
  const updated = [];
  const seenKeys = new Set();

  for (const w of existing) {
    seenKeys.add(w.key);
    if (force && discoveredByKey.has(w.key)) {
      const next = { ...discoveredByKey.get(w.key) };
      workers.push(next);
      updated.push(next);
    } else {
      workers.push({ ...w });
    }
  }

  for (const w of discovered) {
    if (seenKeys.has(w.key)) continue;
    seenKeys.add(w.key);
    const next = { ...w };
    workers.push(next);
    added.push(next);
  }

  return { workers, added, updated };
}
