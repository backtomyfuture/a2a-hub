// 统一配置加载与本地 Agent CLI 发现（v2.0）。
// 仅保留三种极简文件：config.json（身份与连接）、workers.json（本机 CLI 能力）、app.env（机主密钥与通知）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

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
];

export function whichBinary(name) {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(cmd, [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const first = out.split(/\r?\n/).find((l) => l.trim());
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

export function detectDefaultModel(key, homeDir = os.homedir()) {
  try {
    if (key === "claude") {
      const s = readJsonIfExists(path.join(homeDir, ".claude", "settings.json"), null);
      if (s?.model) return String(s.model);
    } else if (key === "codex") {
      const tomlPath = path.join(homeDir, ".codex", "config.toml");
      if (fs.existsSync(tomlPath)) {
        const m = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(fs.readFileSync(tomlPath, "utf8"));
        if (m) return m[1];
      }
    } else if (key === "opencode") {
      const oc = readJsonIfExists(path.join(homeDir, ".config", "opencode", "opencode.json"), null);
      if (oc?.model) return String(oc.model);
    } else if (key === "gemini") {
      const gm = readJsonIfExists(path.join(homeDir, ".gemini", "settings.json"), null);
      if (gm?.model) return String(gm.model);
    }
  } catch {}
  return "";
}

export function discoverLocalWorkers({ whichFn = whichBinary, homeDir = os.homedir(), defaultCwd = os.homedir() } = {}) {
  const found = [];
  for (const spec of KNOWN_CLIS) {
    const binPath = whichFn(spec.bin);
    if (!binPath) continue;
    const detectedModel = detectDefaultModel(spec.key, homeDir);
    const models = [...spec.defaultModels];
    if (detectedModel && !models.includes(detectedModel)) {
      models.unshift(detectedModel);
    }
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
      command: spec.command.replace(/\{bin\}/g, binPath),
      resume_command: spec.resumeCommand ? spec.resumeCommand.replace(/\{bin\}/g, binPath) : "",
      cwd: defaultCwd,
      timeout_sec: spec.timeoutSec,
      approval_policy: spec.approvalPolicy,
      enabled: true,
    });
  }
  return found;
}
