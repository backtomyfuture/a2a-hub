// 节点配置、执行控制键拒收与超时夹紧。凭据只从本机 node.json、tokenFile 或 env 文件读取。
import { modelArgsSupported } from "./receipt.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentGatewayClient } from "./bus/agent-client.mjs";
import { SqliteBus } from "./bus/sqlite-bus.mjs";
import { HttpBus } from "./bus/http-bus.mjs";
import { normalizeTables } from "./bus/tables.mjs";

// 任务参数里唯一允许影响执行的键是 timeout_sec。其余执行控制键一律拒收（标准 §9）：
// 命令、目录、语境、Agent、权限只来自本机 commands.json，不能从总线上改。
const EXEC_CONTROL_KEYS = new Set([
  "command", "cmd", "cwd", "context", "agent", "worker", "mode",
  "side_effect", "approval_class", "permissions", "permission",
  "shell", "env", "executable", "argv", "bin", "max_timeout_sec",
  "verify", "verify_timeout_sec", "model", "requested_model", "default_model", "effective_model", "model_source", "active_model", "supports_model_override", "harness", "skills", "dispatch_target",
  "herdr_kind", "herdr_args", "herdr_env", "herdr_session", "herdr_workspace",
]);

export function controlKeysIn(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return [];
  const bad = [];
  for (const k of Object.keys(params)) {
    const lk = String(k).trim().toLowerCase();
    if (lk === "timeout_sec") continue;
    if (EXEC_CONTROL_KEYS.has(lk)) bad.push(k);
  }
  return bad;
}

// 模型标识是不透明字符串，配置与 API 边界只做结构校验。
export function modelString(value, label = "model") {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} 必须是非空模型字符串（最多 512 字符，无控制字符），或 null`);
  }
  return value;
}

export function canExecuteModel(entry = {}) {
  return modelArgsSupported(entry, String(entry.harness || inferHarness(entry)).trim());
}

export function workerModelFields(entry = {}, { remote = false } = {}) {
  const harness = String(entry.harness || inferHarness(entry)).trim();
  return {
    harness,
    default_model: modelString(entry.default_model, "default_model"),
    active_model: null,
    supports_model_override: remote ? entry.supports_model_override === true : canExecuteModel(entry) && entry.supports_model_override !== false,
    skills: Array.isArray(entry.skills) ? [...entry.skills] : [],
  };
}

// 先要求有限正数，否则回退条目默认；再收紧到 [1, max]，避免 NaN 或超长超时占住主循环。
export function clampTimeoutSec(raw, entry) {
  const fallbackNum = Number(entry?.timeout_sec);
  const fallback = Number.isFinite(fallbackNum) && fallbackNum > 0 ? fallbackNum : 600;
  const capNum = Number(entry?.max_timeout_sec ?? entry?.timeout_sec ?? 600);
  const cap = Number.isFinite(capNum) && capNum >= 1 ? capNum : Math.max(1, fallback);
  const n = Number(raw);
  const chosen = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.min(cap, Math.max(1, chosen));
}

// ---------- 能力表归一（标准 v3.7 §9：Node / Worker / Skill） ----------
//
// commands.json 根上的保留键 workers 定义本机的 Worker（Agent CLI 的启动模板），其余键是 Skill。
// 归一后得到一张平表：键是「能力键」，节点本尊的能力就是技能名，Worker 的能力是 <worker>/<skill>，
// 条目上带 worker 与 skill 两个字段。没有 workers 键的旧配置原样通过，含义不变。

const WORKER_NAME = /^[A-Za-z0-9._-]+$/;
// 启动方式只归 Worker 管，技能条目不能改写。
const LAUNCH_KEYS = new Set([
  "command", "resume_command", "mode", "context", "cwd", "workers", "cap_id", "worker", "skill",
  "harness", "default_model", "supports_model_override", "skills",
  "env", "herdr_kind", "herdr_args", "herdr_env", "herdr_session", "herdr_workspace",
]);
const APPROVAL_RANK = { "": 0, auto: 0, notify: 1, auto_notify: 1, approve: 2 };
const KNOWN_HARNESSES = new Set([
  "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline",
  "omp", "mastracode", "opencode", "copilot", "kimi", "kiro", "droid",
  "amp", "grok", "hermes", "kilo", "qodercli", "qwen", "letta", "maki", "muse",
]);

function normalizeHarnessToken(raw) {
  const t = String(raw ?? "").trim().toLowerCase();
  if (!t) return "";
  if (t === "cursor-agent") return "cursor";
  return t;
}

function commandExecutableName(command) {
  const s = String(command ?? "").trim();
  if (!s) return "";
  let tok = "";
  if (s[0] === "'" || s[0] === '"') {
    const q = s[0];
    const end = s.indexOf(q, 1);
    tok = end > 1 ? s.slice(1, end) : s.slice(1);
  } else {
    tok = s.split(/\s+/)[0] || "";
  }
  return tok ? path.basename(tok) : "";
}

// 推导 harness：显式配置优先，其次识别知名 Worker 名，再回退 command 首词可执行文件名（cursor-agent 映射为 cursor）。
export function inferHarness(entry, workerName = "") {
  if (!isEntry(entry)) return "";
  const explicitRaw = String(entry.harness ?? "").trim();
  if (explicitRaw) return explicitRaw.toLowerCase() === "cursor-agent" ? "cursor" : explicitRaw;
  const workerToken = normalizeHarnessToken(entry.worker || workerName);
  if (workerToken && KNOWN_HARNESSES.has(workerToken)) return workerToken;
  const binToken = normalizeHarnessToken(commandExecutableName(entry.command));
  if (binToken) return binToken;
  return workerToken || "";
}

export const inferHerdrKind = inferHarness;

function isEntry(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function capKey(worker, skill) {
  return worker ? `${worker}/${skill}` : String(skill);
}

// 本地审批下限取 Worker 与 Skill 中更严者：Worker 的无头权限不能被技能条目放松。
function stricterApproval(a, b) {
  const rank = (v) => APPROVAL_RANK[String(v ?? "").trim()] ?? 2;
  if (a == null && b == null) return undefined;
  return rank(a) >= rank(b) ? (a ?? b) : b;
}

function workerSkillEntry(workerEntry, skillEntry, worker, skill) {
  const merged = { ...workerEntry };
  // Worker 名片代表 Worker 本身，名称说明默认取 Worker；显式 agent 条目写了才覆盖；专长技能不借 Worker 的名字。
  if (skillEntry) {
    if (skill !== "agent") {
      delete merged.name;
      delete merged.desc;
    }
    for (const [k, v] of Object.entries(skillEntry)) {
      if (LAUNCH_KEYS.has(k) || k === "approval_class") continue;
      // 技能未写 verify / verify_timeout_sec 时继承 Worker 条目，不能被 null/undefined 覆盖。
      if ((k === "verify" || k === "verify_timeout_sec") && v == null) continue;
      merged[k] = v;
    }
    const approval = stricterApproval(workerEntry.approval_class, skillEntry.approval_class);
    if (approval !== undefined) merged.approval_class = approval;
  }
  merged.worker = worker;
  merged.skill = skill;
  return merged;
}

// onProblem 收到一句人话。出问题的那一项能力不进平表，其余照常（失败要响，但不连坐）。
export function normalizeCommands(raw, onProblem = () => {}) {
  if (!isEntry(raw)) return {};
  const workers = {};
  if (raw.workers !== undefined) {
    if (!isEntry(raw.workers)) {
      onProblem("workers 是保留键，必须是对象（Worker 名 -> 启动模板）");
    } else {
      for (const [name, w] of Object.entries(raw.workers)) {
        if (!WORKER_NAME.test(name)) {
          onProblem(`Worker ${name}：名字只能含字母、数字、. _ -`);
        } else if (!isEntry(w)) {
          onProblem(`Worker ${name} 缺 command 模板`);
        } else if (w.context === "herdr") {
          onProblem(`Worker ${name}：herdr 执行语境已移除，请改为 direct 并提供 command 模板`);
        } else {
          const hasCmd = typeof w.command === "string" && w.command.trim();
          if (!hasCmd) {
            onProblem(`Worker ${name} 缺 command 模板`);
          } else if (w.mode != null && w.mode !== "agent" && w.mode !== "json") {
            onProblem(`Worker ${name}：mode=${JSON.stringify(w.mode)} 非法（Worker 只认 agent / json）`);
          } else {
            try {
              const model = workerModelFields({ ...w, worker: name });
              workers[name] = { ...w, harness: model.harness, default_model: model.default_model, skills: model.skills };
            } catch (e) { onProblem(`Worker ${name}：${e.message}`); }
          }
        }
      }
    }
  }
  const out = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (key === "workers") continue;
    if (!isEntry(entry) || !Array.isArray(entry.workers)) {
      // 节点本尊的能力（或坏条目）：原样留给既有校验。
      out[key] = entry;
      continue;
    }
    if (typeof entry.command === "string" && entry.command.trim()) {
      onProblem(`能力 ${key}：不能同时写 command 与 workers`);
      continue;
    }
    for (const item of entry.workers) {
      const name = String(item ?? "").trim();
      if (!workers[name]) {
        onProblem(`能力 ${key}：引用了未定义的 Worker ${name || "(空)"}`);
        continue;
      }
      out[capKey(name, key)] = workerSkillEntry(workers[name], entry, name, key);
    }
  }
  // 每个 Worker 自带一项通用执行 agent（名册里就是它的 Worker 名片，标准 v3.8 §6）。条目里显式列过的不重复生成，顺序以显式的为先。
  for (const [name, w] of Object.entries(workers)) {
    const key = capKey(name, "agent");
    if (!out[key]) out[key] = workerSkillEntry(w, null, name, "agent");
  }
  return out;
}

// 任务行的 Worker × Skill 在归一后的能力表里对应哪一项；空串表示本机没有这项能力。
// 指定了 Worker 就是硬约束，不换别的 Worker 代跑。没指定时节点本尊优先，否则取第一个登记了该技能的 Worker。
export function resolveCapKey(commands, skill, worker = "") {
  const w = String(worker ?? "").trim();
  const s = String(skill ?? "").trim() || (w ? "agent" : "");
  if (!s || !isEntry(commands)) return "";
  if (w) {
    const key = capKey(w, s);
    return isEntry(commands[key]) && commands[key].worker === w ? key : "";
  }
  if (isEntry(commands[s]) && !commands[s].worker) return s;
  for (const [key, entry] of Object.entries(commands)) {
    if (isEntry(entry) && entry.worker && entry.skill === s) return key;
  }
  return "";
}

// 能力 Cap_ID 的唯一推导口径（标准 §6）。节点本尊：条目显式 cap_id 优先，否则 CAP-<capPrefix>-<能力名>；
// Worker 的能力固定 CAP-<capPrefix>-<worker>-<skill>。
// 老配置没有 cap_id 字段，名片却一直按兜底值登记；内核登记、本地调度校验、doctor 必须共用这一份，
// 否则校验认不得线上已有的名片。
export function capIdOf(skill, entry, capPrefix) {
  if (isEntry(entry) && entry.worker) return `CAP-${capPrefix}-${entry.worker}-${entry.skill}`;
  const explicit = entry && typeof entry === "object" ? String(entry.cap_id ?? "").trim() : "";
  return explicit || `CAP-${capPrefix}-${skill}`;
}

export function capIdsOf(commands, capPrefix) {
  const caps = new Set();
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) return caps;
  for (const [skill, entry] of Object.entries(normalizeCommands(commands))) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    caps.add(capIdOf(skill, entry, capPrefix));
  }
  return caps;
}

// 不走 loadConfig（它要凭据），只取推导 Cap_ID 需要的前缀，与 loadConfig 的 capPrefix 缺省同口径。
export function capPrefixFromNodeJson(configDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, "node.json"), "utf8"));
    return raw?.capPrefix ?? raw?.node ?? "";
  } catch {
    return "";
  }
}

export function readEnvFile(p) {
  const kv = {};
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return kv;
}

function expandHome(raw) {
  const s = String(raw ?? "").trim();
  if (s === "~") return os.homedir();
  if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2));
  return s;
}

export function resolveTokenFilePath(configDir, raw) {
  const expanded = expandHome(raw);
  if (!expanded) return "";
  return path.isAbsolute(expanded) ? expanded : path.resolve(configDir, expanded);
}

function unquote(value) {
  const v = String(value ?? "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

// tokenFile 可以是一行 Token，也可以是 KEY=VALUE（忽略空行和 # 注释）。错误信息只含路径，绝不回显文件内容。
export function readTokenFile(rawPath, configDir) {
  const trimmed = String(rawPath ?? "").trim();
  if (!trimmed) {
    throw new Error("tokenFile 路径不能为空");
  }
  const file = resolveTokenFilePath(configDir || process.cwd(), trimmed);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    const err = new Error(`无法读取 tokenFile（${file}）：${e?.code || "读取失败"}`);
    err.code = e?.code;
    throw err;
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  const prefer = ["AH_API_TOKEN", "A2A_HUB_TOKEN"];
  const kv = new Map();
  const bare = [];
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq > 0) kv.set(line.slice(0, eq).trim(), unquote(line.slice(eq + 1)));
    else bare.push(unquote(line));
  }
  for (const key of prefer) {
    if (kv.get(key)) return kv.get(key);
  }
  if (bare[0]) return bare[0];
  throw new Error(`tokenFile 未包含有效 Token（${file}）`);
}

export function resolveListenAddr(raw = "0.0.0.0:8787") {
  const s = String(raw ?? "").trim() || "0.0.0.0:8787";
  if (/^\d+$/.test(s)) return { host: "0.0.0.0", port: Number(s) };
  const idx = s.lastIndexOf(":");
  if (idx > 0) {
    const host = s.slice(0, idx).replace(/^\[|\]$/g, "") || "0.0.0.0";
    const port = Number(s.slice(idx + 1));
    if (Number.isFinite(port) && port >= 0 && port <= 65535) {
      return { host, port };
    }
  }
  throw new Error(`非法 listen 地址：${s}（期望 host:port 或 port）`);
}

export function readLiveHubUrl(configDir) {
  try {
    const runtimePath = path.join(configDir, "hub_runtime.json");
    const info = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
    const pid = Number(info?.pid);
    const url = String(info?.url ?? "").trim();
    if (!url || !Number.isSafeInteger(pid) || pid <= 0) return "";
    process.kill(pid, 0);
    return url;
  } catch {
    return "";
  }
}

export function loadConfig(configDir, opts = {}) {
  const cfgPath = path.join(configDir, "node.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  if (!cfg.node) throw new Error("node.json missing 'node'");

  let kv = {};
  if (cfg.appEnv) {
    try {
      kv = readEnvFile(cfg.appEnv.replace(/^~/, os.homedir()));
    } catch (e) {
      if (!cfg.hubUrl && !cfg.dbPath && cfg.busType !== "sqlite" && cfg.busType !== "http" && cfg.busType !== "agent" && cfg.role !== "hub") {
        throw e;
      }
    }
  }

  const hubUrl = String(cfg.hubUrl ?? kv.HUB_URL ?? process.env.HUB_URL ?? "").trim();
  const tokenFileRaw = String(cfg.tokenFile ?? cfg.token_file ?? "").trim();
  let apiToken = String(cfg.apiToken ?? "").trim();
  if (!apiToken && tokenFileRaw) {
    // 显式 tokenFile 优先于环境变量，避免临时 VM 上残留的 AH_API_TOKEN / A2A_HUB_TOKEN 盖住 0600 凭据。
    apiToken = readTokenFile(tokenFileRaw, configDir);
  }
  if (!apiToken) {
    apiToken = String(kv.AH_API_TOKEN ?? kv.A2A_HUB_TOKEN ?? process.env.AH_API_TOKEN ?? process.env.A2A_HUB_TOKEN ?? "").trim();
  }

  let busType = String(cfg.busType ?? "").trim().toLowerCase();
  if (!busType) {
    if (hubUrl) busType = "http";
    else if (cfg.dbPath || cfg.listen || cfg.role === "hub") busType = "sqlite";
    else busType = "http";
  }

  const tables = normalizeTables(cfg.tables);
  const dbPathRaw = cfg.dbPath ? String(cfg.dbPath).replace(/^~/, os.homedir()) : path.join(configDir, "hub.db");
  const resolvedDbPath = dbPathRaw === ":memory:" ? ":memory:" : path.resolve(configDir, dbPathRaw);
  const effectiveHubUrl = hubUrl;

  let bus;
  if (busType === "http") {
    if (!effectiveHubUrl) throw new Error("node.json 缺少 hubUrl：请运行 ah join http://<hub-ip>:8787 或配置 hubUrl");
    bus = new HttpBus({
      hubUrl: effectiveHubUrl,
      apiToken,
      node: cfg.node,
      tables,
      longPollSec: cfg.longPollSec ?? 25,
    });
  } else if (busType === "sqlite") {
    // CLI 命令在 Hub 本机执行时，若守护进程在线则优先经 HTTP 写入，保证实时唤醒长轮询节点。
    const liveUrl = opts.forCli ? readLiveHubUrl(configDir) : "";
    if (liveUrl) {
      bus = new HttpBus({
        hubUrl: liveUrl,
        apiToken,
        node: cfg.node,
        tables,
        longPollSec: cfg.longPollSec ?? 25,
      });
    } else {
      bus = new SqliteBus({
        dbPath: resolvedDbPath,
        tables,
      });
    }
  } else if (busType === "agent") {
    if (!effectiveHubUrl) throw new Error("node.json 缺少 hubUrl：busType=agent 需要 Hub 地址");
    bus = null;
  } else {
    throw new Error(`不支持的 busType: ${busType}（仅支持 sqlite / http / agent）`);
  }

  const agentRoleRaw = String(cfg.agentRole ?? cfg.agent_role ?? "worker").trim().toLowerCase() || "worker";
  const agentRole = agentRoleRaw === "hybrid" ? "leader" : agentRoleRaw;
  const receiveMode = String(cfg.receiveMode ?? cfg.receive_mode ?? "").trim();

  const out = {
    node: cfg.node,
    role: cfg.role || (busType === "agent" ? "node" : cfg.role),
    kind: busType === "agent" ? "agent" : (cfg.kind || "host"),
    zone: cfg.zone ?? "",
    nodeDesc: cfg.nodeDesc ?? "",
    pollSec: cfg.pollSec ?? 45,
    sweepSec: cfg.sweepSec ?? 900,
    longPollSec: cfg.longPollSec ?? 25,
    events: cfg.events !== false,
    doorbellFile: cfg.doorbellFile ? cfg.doorbellFile.replace(/^~/, os.homedir()) : null,
    capPrefix: cfg.capPrefix ?? cfg.node,
    // hub 的审批签名公钥（base64）。配了就只认签名对得上的 auth_decision（标准 §8.3 第 5 条）。
    hubPublicKey: cfg.hubPublicKey,
    // 只给节点本地定时调度读。缺省由 resolveScheduleTz 解释成 Asia/Shanghai，这里不套宿主机时区。
    tz: cfg.tz,
    maxConcurrent: Number.isInteger(Number(cfg.maxConcurrent)) && Number(cfg.maxConcurrent) >= 1 ? Number(cfg.maxConcurrent) : 4,
    busType,
    bus,
    configDir,
  };
  if ((busType === "http" || busType === "agent") && effectiveHubUrl) out.hubUrl = effectiveHubUrl;
  if (busType === "agent") {
    out.agentRole = agentRole;
    out.receiveMode = receiveMode || "http-longpoll";
    if (tokenFileRaw) out.tokenFile = resolveTokenFilePath(configDir, tokenFileRaw);
    out.agentClient = new AgentGatewayClient({
      hubUrl: effectiveHubUrl,
      apiToken,
      node: cfg.node,
      agentRole: out.agentRole,
      receiveMode: out.receiveMode,
      nodeDesc: cfg.nodeDesc ?? "",
      longPollSec: cfg.longPollSec ?? 25,
    });
  }
  if (busType === "sqlite") {
    out.dbPath = resolvedDbPath;
    out.listen = cfg.listen ?? "0.0.0.0:8787";
  }
  if (apiToken) out.apiToken = apiToken;
  if (cfg.publicUrl) out.publicUrl = String(cfg.publicUrl).trim();
  if (cfg.notifications && typeof cfg.notifications === "object") {
    out.notifications = cfg.notifications;
  }
  return out;
}


export function receiveModeOf(cfg) {
  // 独立长轮询、SQLite 本地模式、长连接、门铃文件均视为事件驱动（event）。
  if (cfg?.events === false && !cfg?.doorbellFile && cfg?.role !== "hub") return "poll";
  if (
    cfg?.events
    || cfg?.doorbellFile
    || cfg?.hubUrl
    || cfg?.busType === "sqlite"
    || cfg?.busType === "http"
    || cfg?.bus?.waitForChanges
    || cfg?.bus?.broker
  ) {
    return "event";
  }
  return "poll";
}
