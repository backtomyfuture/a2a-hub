// doctor —— 节点自检：把「装完之后为什么跑不起来」变成一张清单。
// 检查 Node 版本、配置文件、凭据可达性、总线连通、能力登记与自启状态。
// 只读操作；凭据只校验存在与可用，绝不打印明文。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, DAEMON_VERSION } from "./kernel.mjs";
import { capIdOf, capIdsOf, normalizeCommands, resolveListenAddr } from "./config.mjs";
import { isHubPublicKey, readHubPublicKey } from "./approval-sign.mjs";
import { resolveScheduleTz } from "./hub/schedule.mjs";
import { LocalScheduleService } from "./local-schedule.mjs";
import { f1 } from "./bus/tables.mjs";

const ok = (msg) => console.log("  ✓ " + msg);
const bad = (msg) => console.log("  ✗ " + msg);
const info = (msg) => console.log("  · " + msg);
const execFileAsync = promisify(execFile);

function richPath() {
  if (process.env.PATH != null) return process.env.PATH;
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local/bin"), "/usr/bin", "/bin"];
  return extra.join(path.delimiter);
}

// 模板检查只认词法 token。子串会误伤：-p 是 --print 的子串。
function commandTokens(command) {
  return String(command).trim().split(/\s+/).filter(Boolean);
}

function hasFlag(tokens, flag) {
  for (const token of tokens) {
    if (token === flag) return true;
    if (flag.startsWith("--") && token.startsWith(`${flag}=`)) return true;
  }
  return false;
}

// 同一旗标多次出现时取最后一次，与 CLI 覆盖语义一致。没有该旗标返回 null。
function lastFlagValue(tokens, flag) {
  let value = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === flag) {
      const next = tokens[i + 1];
      value = next != null && !next.startsWith("-") ? next : "";
    } else if (token.startsWith(`${flag}=`)) {
      value = token.slice(flag.length + 1);
    }
  }
  return value;
}

function isPaseoRun(bin, tokens) {
  if (bin !== "paseo") return false;
  // 本机是 agent run；较新版本命令名是 run。两条都不带 provider 就会缺执行主体。
  if (tokens[1] === "run") return true;
  return tokens[1] === "agent" && tokens[2] === "run";
}

function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, "");
}

// 本机 `paseo provider models` 打表格，首列是 ID。表头和分隔线不是模型。
function parsePaseoModelIds(text) {
  const ids = new Set();
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^[-+|=\s]+$/.test(trimmed)) continue;
    const id = trimmed.split(/\s+/)[0];
    if (!id || id.toLowerCase() === "id") continue;
    ids.add(id);
  }
  return ids;
}

// 只跑固定命令，参数来自模板里的 provider 名，绝不执行用户模板（指令与数据分离）。
// 同一 provider 只探一次：一张命令表里常有多条钉同一家模型。
async function probePaseoModels(provider, cache) {
  if (cache.has(provider)) return cache.get(provider);
  let result;
  try {
    const { stdout } = await execFileAsync("paseo", ["provider", "models", provider], {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, PATH: richPath() },
    });
    result = { ok: true, ids: parsePaseoModelIds(stdout) };
  } catch {
    result = { ok: false, ids: new Set() };
  }
  cache.set(provider, result);
  return result;
}

// 只看键在不在。文件缺失或解析失败都按「没有」；内容是本机许可策略，不打印。
function readAgyPermissionsAllow() {
  const home = process.env.HOME || os.homedir();
  const file = path.join(home, ".gemini", "antigravity-cli", "settings.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const permissions = parsed?.permissions;
    if (!permissions || typeof permissions !== "object") return false;
    return Object.prototype.hasOwnProperty.call(permissions, "allow");
  } catch {
    return false;
  }
}

const COMMAND_MODES = new Set(["agent", "json", "inbox"]);
const COMMAND_CONTEXTS = new Set(["direct"]);

function hasVerify(entry) {
  return typeof entry?.verify === "string" && entry.verify.trim().length > 0;
}

// commands.json 条目的字段校验。内核对这几类错误都不报错：未知 mode 按 agent 跑、
// 未知 context 按 direct 直跑、非法 timeout_sec 回退 600、
// 重复 Cap_ID 后一条覆盖前一条名片——运行期全是静默降级，只能在自检里拦下（失败要响）。
// Cap_ID 推导与内核 capIdFor 同口径（config.mjs 的 capIdOf）。
// 传进来的是归一后的平表：Worker 的能力键形如 <worker>/<skill>。
function auditCommandsShape(cmds, capPrefix) {
  let problems = 0;
  const capOwner = new Map();
  for (const [name, entry] of Object.entries(cmds)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      bad(`能力 ${name}：条目必须是对象`);
      problems++;
      continue;
    }
    const mode = entry.mode ?? "agent";
    if (!COMMAND_MODES.has(mode)) {
      bad(`能力 ${name}：mode=${JSON.stringify(entry.mode)} 非法（只认 agent / json / inbox；认领时内核会拒收该能力的任务）`);
      problems++;
    }
    if (mode !== "inbox" && (typeof entry.command !== "string" || !entry.command.trim())) {
      bad(`能力 ${name} 缺 command 模板`);
      problems++;
    }
    if (entry.resume_command != null && entry.resume_command !== "") {
      if (typeof entry.resume_command !== "string" || !entry.resume_command.includes("{session}")) {
        bad(`能力 ${name}：resume_command 已配置但缺少 {session}（续接无法把会话号传给命令）`);
        problems++;
      }
    }
    if (entry.context != null && !COMMAND_CONTEXTS.has(entry.context)) {
      const hint = entry.context === "carrier" ? "carrier 语境已在本版本移除，请把该能力改为 direct 或删除；" : "";
      bad(`能力 ${name}：context=${JSON.stringify(entry.context)} 非法（${hint}只认 direct；认领时内核会拒收该能力的任务，不会静默直跑）`);
      problems++;
    }
    if (entry.timeout_sec != null) {
      const v = entry.timeout_sec;
      const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() ? Number(v) : NaN);
      if (!Number.isFinite(n) || n <= 0) {
        bad(`能力 ${name}：timeout_sec=${JSON.stringify(v)} 非法（须为正数秒；内核会静默回退 600）`);
        problems++;
      }
    }
    if (entry.verify != null) {
      if (typeof entry.verify !== "string" || !entry.verify.trim()) {
        bad(`能力 ${name}：verify 必须是非空字符串`);
        problems++;
      }
      if (mode === "inbox") {
        bad(`能力 ${name}：mode=inbox 不支持执行式验收（verify），认领时内核会拒收`);
        problems++;
      }
    }
    if (entry.verify_timeout_sec != null) {
      const v = entry.verify_timeout_sec;
      const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() ? Number(v) : NaN);
      if (!Number.isFinite(n) || n <= 0) {
        bad(`能力 ${name}：verify_timeout_sec=${JSON.stringify(v)} 非法（须为正数秒；内核会夹紧到 1–1800 并默认 120）`);
        problems++;
      }
    }
    if (entry.cap_id != null && entry.cap_id !== "" && typeof entry.cap_id !== "string") {
      bad(`能力 ${name}：cap_id 必须是字符串`);
      problems++;
      continue;
    }
    const capId = capIdOf(name, entry, capPrefix);
    if (capOwner.has(capId)) {
      bad(`能力 ${name} 与 ${capOwner.get(capId)} 的 Cap_ID 重复（${capId}）：总线上只会留一张名片，后一项不登记`);
      problems++;
    } else {
      capOwner.set(capId, name);
    }
  }
  return problems;
}

async function auditAgentTemplates(cmds) {
  let problems = 0;
  let agyAllow;
  const modelCache = new Map();
  const agyAllows = () => {
    if (agyAllow === undefined) agyAllow = readAgyPermissionsAllow();
    return agyAllow;
  };
  for (const [name, entry] of Object.entries(cmds)) {
    if (!entry || typeof entry !== "object" || typeof entry.command !== "string") continue;
    const tokens = commandTokens(entry.command);
    if (!tokens.length) continue;
    const bin = path.basename(tokens[0]);
    if (isPaseoRun(bin, tokens)) {
      const spec = lastFlagValue(tokens, "--provider");
      if (spec == null || spec === "") {
        bad(`能力 ${name}：paseo 模板未带 --provider，没有默认执行主体，运行必失败`);
        problems++;
        continue;
      }
      const slash = spec.indexOf("/");
      const provider = (slash === -1 ? spec : spec.slice(0, slash)).trim();
      const model = (slash === -1 ? "" : spec.slice(slash + 1)).trim();
      if (!provider) {
        bad(`能力 ${name}：paseo 的 --provider 没有 provider 名，运行必失败`);
        problems++;
        continue;
      }
      // 只钉了 provider、没钉 model 时无从核验 slug，不探针。
      if (!model) continue;
      const probed = await probePaseoModels(provider, modelCache);
      if (!probed.ok) {
        info(`能力 ${name}：paseo provider models ${provider} 探针失败，跳过模型在册核验`);
        continue;
      }
      if (!probed.ids.has(model)) {
        bad(`能力 ${name}：paseo 钉了模型 ${model}，不在 paseo provider models ${provider} 的在册 ID 中`);
        problems++;
      }
      continue;
    }
    if (bin === "agy" && (hasFlag(tokens, "--print") || hasFlag(tokens, "-p")) && !hasFlag(tokens, "--dangerously-skip-permissions")) {
      if (!agyAllows()) {
        info(`能力 ${name}：agy 有 --print/-p 但无 --dangerously-skip-permissions，且本机 antigravity settings 没有 permissions.allow，存在 soft-deny 假成功风险`);
      }
      continue;
    }
    if (
      bin === "claude"
      && (hasFlag(tokens, "-p") || hasFlag(tokens, "--print"))
      && !hasFlag(tokens, "--dangerously-skip-permissions")
      && !hasFlag(tokens, "--permission-mode")
      && !hasFlag(tokens, "--allowedTools")
      && !hasFlag(tokens, "--allowed-tools")
    ) {
      info(`能力 ${name}：claude -p 未带 --dangerously-skip-permissions / --permission-mode / --allowedTools，无头权限未显式处理`);
      continue;
    }
    if (bin === "gemini" && (hasFlag(tokens, "-p") || hasFlag(tokens, "--print")) && !hasFlag(tokens, "--approval-mode")) {
      info(`能力 ${name}：gemini -p 未带 --approval-mode，无头权限未显式处理`);
      continue;
    }
    if (bin === "codex" && tokens[1] === "exec" && !hasFlag(tokens, "-s") && !hasFlag(tokens, "--sandbox")) {
      info(`能力 ${name}：codex exec 未带 -s/--sandbox，默认只读档，写类任务会失败`);
    }
  }
  return problems;
}

function capIdsFromCommands(configDir, capPrefix) {
  try {
    return capIdsOf(JSON.parse(fs.readFileSync(path.join(configDir, "commands.json"), "utf8")), capPrefix);
  } catch {
    return new Set();
  }
}

function scheduleBrief(entry, index) {
  const obj = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
  const id = obj && typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : `#${index}`;
  const cron = obj && typeof obj.cron === "string" ? obj.cron.trim() : "";
  const cap = obj && typeof obj.cap === "string" ? obj.cap.trim() : "";
  const enabled = obj?.enabled === true ? "启用" : "未启用";
  return `本地计划 ${id}：cron ${cron || "(空)"}，cap ${cap || "(空)"}，${enabled}`;
}

// 标准 v3.8 能力分组与旧平表迁移提示：
// Worker 名片代表实体与通用执行，专长技能与本尊技能归属清楚；
// 对旧平表写法提示迁到 workers，帮助节点平滑升级到三层架构。
export function describeCommands(cmds, flat, capPrefix, kind) {
  const layout = [];
  const hints = [];
  if (!flat || typeof flat !== "object") return { summary: "", layout, hints };

  // 1. 统计 Worker 数与技能数（汇总行）
  // 标准 v3.8：Worker 名片代表 Worker 实体与通用执行，独立 Agent 节点本尊 agent 也是 Worker 名片。
  const workerSet = new Set();
  const hasSelfAgent = Boolean(flat.agent && typeof flat.agent === "object" && !flat.agent.worker);
  let skillCount = 0;
  for (const [key, entry] of Object.entries(flat)) {
    if (entry?.worker) {
      workerSet.add(entry.worker);
      if (entry.skill !== "agent") skillCount++;
    } else if (key !== "agent") {
      skillCount++;
    }
  }
  const workerCount = workerSet.size + (hasSelfAgent ? 1 : 0);
  const selfSuffix = hasSelfAgent ? "（含本尊）" : "";
  const totalCards = Object.keys(flat).length;
  const summary = `commands.json：${workerCount} 个 Worker${selfSuffix}、${skillCount} 项技能，共 ${totalCards} 张名片`;

  // 2. 按 cmds.workers 的书写顺序，只列 flat 里确实存在的 Worker，每个一行
  const workerEntries = cmds?.workers && typeof cmds.workers === "object" && !Array.isArray(cmds.workers)
    ? Object.entries(cmds.workers)
    : [];

  for (const [wName, wObj] of workerEntries) {
    const agentEntry = flat[`${wName}/agent`];
    // 只有归一后确实存在该 Worker 名片时才输出
    if (!agentEntry || agentEntry.worker !== wName) continue;

    const rawName = wObj?.name != null ? String(wObj.name).trim() : "";
    const namePart = rawName ? `（${rawName}）` : "";
    const capId = capIdOf("agent", agentEntry, capPrefix);
    const agentVerify = hasVerify(agentEntry) ? "（已配 verify）" : "";

    // 专长技能：该 Worker 名下除 agent 之外的技能
    const specials = [];
    for (const entry of Object.values(flat)) {
      if (entry?.worker === wName && entry.skill !== "agent") {
        specials.push(hasVerify(entry) ? `${entry.skill}（已配 verify）` : entry.skill);
      }
    }

    const skillsPart = specials.length > 0
      ? `；专长技能 ${specials.join(", ")}`
      : "；无专长技能";

    layout.push(`Worker ${wName}${namePart}：通用执行 ${capId}${agentVerify}${skillsPart}`);
  }

  // 3. 节点本尊的 agent 条目（flat 里键为 agent、没有 worker 的那项，独立 Agent 节点就是这种）
  const selfAgent = flat.agent;
  if (selfAgent && typeof selfAgent === "object" && !selfAgent.worker) {
    const capId = capIdOf("agent", selfAgent, capPrefix);
    const mode = selfAgent.mode ?? "agent";
    const verifyMark = hasVerify(selfAgent) ? "，已配 verify" : "";
    layout.push(`本尊即 Worker：agent（${capId}，mode ${mode}${verifyMark}）`);
  }

  // 4. 其余没有 worker 的本尊条目合成一行：节点本尊技能（非 Worker）：k1, k2
  const selfSkills = [];
  for (const [key, entry] of Object.entries(flat)) {
    if ((!entry || typeof entry !== "object" || !entry.worker) && key !== "agent") {
      selfSkills.push(hasVerify(entry) ? `${key}（已配 verify）` : key);
    }
  }
  if (selfSkills.length > 0) {
    layout.push(`节点本尊技能（非 Worker）：${selfSkills.join(", ")}`);
  }

  // 5. hints（迁移提示）：对 flat 里满足条件的条目各出一条
  if (kind !== "agent") {
    const definedWorkers = cmds?.workers && typeof cmds.workers === "object" && !Array.isArray(cmds.workers)
      ? cmds.workers
      : {};

    for (const [key, entry] of Object.entries(flat)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      if (entry.worker) continue;
      const mode = entry.mode ?? "agent";
      if (mode !== "agent") continue;
      if (typeof entry.command !== "string" || !entry.command.trim()) continue;

      // 建议的 Worker 名 W：键以 -agent 结尾就去掉这个后缀，否则用键本身
      const rawW = key.endsWith("-agent") ? key.slice(0, -6) : key;
      const isValidName = /^[A-Za-z0-9._-]+$/.test(rawW);
      const isDuplicate = Object.prototype.hasOwnProperty.call(definedWorkers, rawW);
      const giveSuggestion = isValidName && !isDuplicate;

      if (giveSuggestion) {
        const W = rawW;
        const oldCap = capIdOf(key, entry, capPrefix);
        const newCap = `CAP-${capPrefix}-${W}-agent`;
        const capText = oldCap === newCap
          ? `Cap_ID ${oldCap} 不变`
          : `Cap_ID 会由 ${oldCap} 变为 ${newCap}（引用旧 Cap_ID 的本地计划要改 cap）`;

        hints.push(
          `迁移提示：能力 ${key} 是节点本尊执行的 agent 型条目，名册里会被当作技能而不是 Worker。它若是一个 Agent，可迁到 workers.${W}：${capText}；按技能名 --cap ${key} 派单要改成 --worker ${W}。它若只是用某个 Agent 跑的固定任务，改成那个 Worker 的专长技能。迁移前先清空本节点在途任务。见 docs/configuration.md「旧平表迁到 workers」`
        );
      } else {
        hints.push(
          `迁移提示：能力 ${key} 是节点本尊执行的 agent 型条目，名册里会被当作技能而不是 Worker。它若是一个 Agent，可迁到 workers 下（自选 Worker 名）；按技能名 --cap ${key} 派单要改成 --worker <Worker 名>。它若只是用某个 Agent 跑的固定任务，改成那个 Worker 的专长技能。迁移前先清空本节点在途任务。见 docs/configuration.md「旧平表迁到 workers」`
        );
      }
    }
  }

  return { summary, layout, hints };
}

// schedules.json 不存在时什么都不打印。存在时复用 LocalScheduleService 的读取和拒收口径，
// 只告警，不计入 problems：坏计划不能让 doctor 非零退出，也不能挡住守护进程启动。
export function reportLocalSchedules(configDir, raw) {
  const file = path.join(configDir, "schedules.json");
  if (!fs.existsSync(file)) return 0;
  const warn = (msg) => info("告警：" + msg);
  try {
    const configured = raw && Object.prototype.hasOwnProperty.call(raw, "tz") && String(raw.tz ?? "").trim() !== "";
    try {
      const tz = resolveScheduleTz(raw?.tz);
      if (configured) ok(`定时调度时区：${tz}（node.json 的 tz，与宿主机时区无关）`);
      else info(`定时调度时区：${tz}（未配置 tz，默认 Asia/Shanghai）`);
    } catch (e) {
      warn(`定时调度时区非法（node.json 的 tz=${JSON.stringify(raw?.tz)}）：${e.message}。本地调度会整体停用，不回退宿主机时区`);
    }
    const caps = capIdsFromCommands(configDir, raw?.capPrefix ?? raw?.node ?? "");
    const svc = new LocalScheduleService({
      schedulesPath: file,
      tz: raw?.tz,
      commandsOf: () => caps,
      log: () => {},
    });
    const loaded = svc._readFile();
    if (loaded.missing) return 0;
    if (loaded.broken) {
      warn(`schedules.json 损坏，本地调度整体停用：${loaded.broken}`);
      return 0;
    }
    const seen = new Set();
    loaded.list.forEach((entry, index) => {
      const reason = svc._rejectReason(entry, seen, caps);
      const brief = scheduleBrief(entry, index);
      if (reason) {
        warn(`${brief}；${reason}`);
        return;
      }
      seen.add(String(entry.id).trim());
      ok(brief);
    });
  } catch (e) {
    warn(`schedules.json 检查失败（不阻断）：${e?.message ?? e}`);
  }
  return 0;
}

function roleFrom(argv, opts, raw) {
  if (opts?.role === "node" || opts?.role === "hub") return opts.role;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--role") {
      const v = argv[i + 1];
      if (v === "node" || v === "hub") return v;
    } else if (a.startsWith("--role=")) {
      const v = a.slice("--role=".length);
      if (v === "node" || v === "hub") return v;
    }
  }
  if (raw?.role === "hub" || raw?.role === "node") return raw.role;
  return "node";
}

export async function doctor(configDir, appDir, opts = {}) {
  let problems = 0;

  // 读取配置以辅助判断角色（若 CLI 或 opts 未显式给出）
  const nodeJsonPath = path.join(configDir, "node.json");
  let raw = null;
  let rawError = null;
  try {
    raw = JSON.parse(fs.readFileSync(nodeJsonPath, "utf8"));
    // "null" / 数组也能 JSON.parse 成功，但 loadConfig 读字段会出错；按读不了处理，避免误报成「文件不存在」。
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      raw = null;
      rawError = new Error("根必须是对象");
    }
  } catch (e) {
    rawError = e;
  }

  const role = roleFrom(process.argv, opts, raw);
  const kind = raw?.kind || "host";

  let busType = String(raw?.busType ?? "").trim().toLowerCase();
  if (!busType) {
    if (raw?.hubUrl || process.env.HUB_URL) busType = "http";
    else if (raw?.dbPath || raw?.listen || role === "hub") busType = "sqlite";
    else busType = "http";
  }

  console.log(`ah doctor ${DAEMON_VERSION}`);
  console.log(`role: ${role}`);
  console.log(`kind: ${kind}`);
  console.log(`bus: ${busType}`);
  console.log(`config dir: ${configDir}`);

  // 1. Node 版本（package.json engines: >=24）
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 24) ok(`node ${process.versions.node} (>= 24)`);
  else { bad(`node ${process.versions.node} 过低，需要 >= 24`); problems++; }

  // 2. 配置文件
  if (raw) {
    ok("node.json 可解析");
    const placeholder = (v) => typeof v === "string" && v.startsWith("<");
    if (!raw.node || placeholder(raw.node)) { bad("node.json 的 node 未填"); problems++; }
    if (busType === "sqlite") {
      try {
        resolveListenAddr(raw.listen ?? "0.0.0.0:8787");
      } catch (e) {
        bad(`node.json 的 listen 非法：${e.message}`);
        problems++;
      }
      if (raw.tables && typeof raw.tables === "object") {
        for (const [k, v] of Object.entries(raw.tables)) {
          if (placeholder(v)) { bad(`node.json 的 tables.${k} 仍是示例占位符`); problems++; }
        }
      }
    } else if (busType === "http") {
      const effectiveHubUrl = String(raw.hubUrl ?? process.env.HUB_URL ?? "").trim();
      if (!effectiveHubUrl || placeholder(effectiveHubUrl)) {
        bad("node.json 的 hubUrl 未填");
        problems++;
      } else {
        try {
          const u = new URL(effectiveHubUrl);
          if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("协议必须是 http 或 https");
        } catch (e) {
          bad(`node.json 的 hubUrl 非法：${e.message}`);
          problems++;
        }
      }
    } else {
      bad(`node.json 的 busType 非法（${JSON.stringify(raw.busType)}，仅支持 sqlite / http）`);
      problems++;
    }
    // 只核取值，不回显其它字段：node.json 里可能直接写着 appSecret。
    if (raw.role !== undefined && raw.role !== "node" && raw.role !== "hub") {
      bad(`node.json 的 role 只能是 node 或 hub（收到 ${JSON.stringify(raw.role)}）`);
      problems++;
    }
    if (raw.kind !== undefined && raw.kind !== "host" && raw.kind !== "agent") {
      bad(`node.json 的 kind 只能是 host 或 agent（收到 ${JSON.stringify(raw.kind)}）`);
      problems++;
    }
  } else {
    bad(`node.json 读不了：${rawError?.message ?? "文件不存在"}`);
    // 标准 §10.5：node.json 只在启动时读，运行中改坏不影响在跑进程，下次启动才会暴露。
    info("运行中的守护进程不受影响（node.json 只在启动时读取）；但下次启动会记错误、退避后非零退出，修好前不会接单（标准 §10.5）");
    problems++;
  }

  // 没有本地计划时，时区仍只跟 hub 的旧口径有关，非法值计问题。
  // 有 schedules.json 时改由 reportLocalSchedules 覆盖到任何角色，并且只告警。
  const schedulesPresent = fs.existsSync(path.join(configDir, "schedules.json"));
  if (role === "hub" && raw && !schedulesPresent) {
    const configured = Object.prototype.hasOwnProperty.call(raw, "tz") && String(raw.tz ?? "").trim() !== "";
    try {
      const tz = resolveScheduleTz(raw.tz);
      if (configured) ok(`定时调度时区：${tz}（node.json 的 tz，与宿主机时区无关）`);
      else info(`定时调度时区：${tz}（未配置 tz，hub 默认 Asia/Shanghai）`);
    } catch (e) {
      bad(`定时调度时区非法（node.json 的 tz=${JSON.stringify(raw.tz)}）：${e.message}。本轮调度会跳过，直到改成合法 IANA 名`);
      problems++;
    }
  }
  if (schedulesPresent) reportLocalSchedules(configDir, raw);

  // 审批决定签名（标准 §8.3 第 5 条）。公钥不是秘密，可以打印；私钥只报在不在。
  if (role === "hub") {
    const pub = readHubPublicKey(configDir);
    if (pub) info(`hub 审批公钥（各节点 node.json 的 hubPublicKey 填它）：${pub}`);
    else info("审批签名密钥尚未生成：hub 守护进程首次启动或重跑 ah setup --role hub 时生成");
  } else if (raw?.hubPublicKey) {
    if (isHubPublicKey(raw.hubPublicKey)) ok("已配置 hub 审批公钥：只认签名对得上的 auth_decision");
    else { bad("node.json 的 hubPublicKey 不是有效的 ed25519 公钥：所有审批决定都会被当作无效"); problems++; }
  } else {
    info("告警：未配置 hubPublicKey。审批决定只按行上自报字段校验，任何能写总线的身份都能冒写批准；向 hub 要公钥后 ah setup --hub-key <公钥>");
  }

  try {
    const cmdsPath = path.join(configDir, "commands.json");
    if (fs.existsSync(cmdsPath)) {
      const cmds = JSON.parse(fs.readFileSync(cmdsPath, "utf8"));
      // 与内核 loadCommands 同口径：根不是对象，守护进程会当作解析失败处理。
      if (!cmds || typeof cmds !== "object" || Array.isArray(cmds)) throw new Error("根必须是对象（能力名 -> 模板）");
      // 与内核同一份归一：workers 定义 Worker，其余键是 Skill（标准 §9）。
      let layerProblems = 0;
      const flat = normalizeCommands(cmds, (msg) => { bad(msg); layerProblems++; });
      const names = Object.keys(flat);
      const workerNames = cmds.workers && typeof cmds.workers === "object" && !Array.isArray(cmds.workers) ? Object.keys(cmds.workers) : [];
      const capPrefix = raw?.capPrefix ?? raw?.node ?? "";
      if (names.length) {
        const { summary, layout, hints } = describeCommands(cmds, flat, capPrefix, kind);
        ok(summary);
        for (const line of layout) info(line);
        for (const hint of hints) info(hint);
      } else {
        info("commands.json 为空：本节点不登记任何能力，不会认领任务");
      }
      const shapeProblems = layerProblems + auditCommandsShape(flat, capPrefix);
      if (!shapeProblems && names.length) ok("commands.json 字段校验通过（Worker 引用、mode / context / timeout_sec / verify 取值合法，cap_id 无重复）");
      problems += shapeProblems;
      // 模板只查一遍：节点本尊的条目加上每个 Worker 自己的启动模板。
      const templates = {};
      for (const [key, entry] of Object.entries(flat)) if (!entry?.worker) templates[key] = entry;
      for (const name of workerNames) templates[`worker:${name}`] = cmds.workers[name];
      problems += await auditAgentTemplates(templates);
    } else if (role === "hub") {
      info("未配置 commands.json（hub 仍可承担审批/呈递，但不会认领干活任务）");
    } else {
      bad("commands.json 不存在");
      problems++;
    }
  } catch (e) {
    bad(`commands.json 读不了：${e.message}`);
    // 标准 §10.5：运行期坏掉时守护进程不清空能力表、只暂停接新单；提示操作者这不是「已停机」。
    info("运行中的守护进程会保留上一版能力表、暂停认领新任务，每轮记一条错误日志；文件修好后下一轮扫表自动接回（标准 §10.5）");
    problems++;
  }

  // 3. 零外部依赖确认
  ok("零外部依赖模式（Node 内置 sqlite / fetch）");

  // 4-6. 凭据与总线（loadConfig 成功 = 配置/凭据齐备；再实测连通与读表）
  let cfg = null;
  try {
    cfg = loadConfig(configDir);
    cfg.role = role;
    if (cfg.busType === "sqlite") {
      ok(`独立 SQLite 总线可读（${cfg.dbPath}，监听 ${cfg.listen}）`);
    } else {
      ok(`远程 Hub 连接已配置（节点 ${cfg.node} -> ${cfg.hubUrl}）`);
    }
  } catch (e) {
    bad(`凭据/总线配置不可用：${e.message}`);
    problems++;
  }
  if (cfg && cfg.busType === "sqlite") {
    try {
      const cards = await cfg.bus.listRecords(cfg.bus.tables.agentCards);
      const mine = cards.filter((r) => f1(r, "Node") === cfg.node);
      ok(`AgentCards 可读：本节点已登记 ${mine.length} 项能力，总线共 ${cards.length} 项在册`);
      const tasks = await cfg.bus.listRecords(cfg.bus.tables.tasks);
      ok(`Tasks 可读：共 ${tasks.length} 条`);
    } catch (e) {
      bad(`SQLite 总线读写失败：${e.message}`);
      problems++;
    } finally {
      cfg.bus?.close?.();
    }
    info(`唤醒方式：进程内事件总线（LongPollBroker）＋ HTTP 长轮询服务端 ＋ ${cfg.sweepSec}s 对账扫表`);
  } else if (cfg && cfg.busType === "http") {
    try {
      const health = await cfg.bus.api("GET", "/api/v1/health");
      ok(`远程 Hub /api/v1/health 可达（hub=${health?.node ?? "-"}，seq=${health?.seq ?? 0}）`);
      const cards = await cfg.bus.listRecords(cfg.bus.tables.agentCards);
      const mine = cards.filter((r) => f1(r, "Node") === cfg.node);
      ok(`AgentCards 可读：本节点已登记 ${mine.length} 项能力，全网共 ${cards.length} 项在册`);
      const tasks = await cfg.bus.listRecords(cfg.bus.tables.tasks);
      ok(`Tasks 可读：共 ${tasks.length} 条`);
    } catch (e) {
      bad(`连接远程 Hub 失败：${e.message}`);
      problems++;
    }
    info(`唤醒方式：HTTP 长轮询（longpoll，超时 ${cfg.longPollSec}s）＋ ${cfg.sweepSec}s 对账扫表`);
  }

  // 7. 自启状态（只报告，不动手）
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("launchctl", ["list"], { encoding: "utf8" });
      const mine = out.split("\n").filter((l) => l.includes("hub-node") || l.includes("agenthub"));
      if (mine.length) ok(`launchd 自启在册：${mine.map((l) => l.trim().split(/\s+/).pop()).join(", ")}`);
      else info("未发现 launchd 自启（可用 ah service 安装）");
    } else if (process.platform === "linux") {
      const units = fs.existsSync(path.join(os.homedir(), ".config/systemd/user"))
        ? fs.readdirSync(path.join(os.homedir(), ".config/systemd/user")).filter((f) => f.startsWith("hub-node"))
        : [];
      if (units.length) ok(`systemd 用户单元在册：${units.join(", ")}`);
      else info("未发现 systemd 用户单元（可用 ah service 安装）");
    } else if (process.platform === "win32") {
      try {
        const out = execFileSync("schtasks", ["/Query", "/TN", "\\lah\\", "/FO", "LIST"], { encoding: "utf8" });
        const mine = [...new Set(out.split(/\r?\n/).map((line) => {
          const at = line.indexOf("\\lah\\hub-node");
          return at >= 0 ? line.slice(at).trim() : "";
        }).filter(Boolean))];
        if (mine.length) ok(`任务计划程序自启在册：${mine.join(", ")}`);
        else info("未发现任务计划程序自启（可用 ah service 安装）");
      } catch {
        info("未发现任务计划程序自启（可用 ah service 安装）");
      }
    }
  } catch { /* 自启状态查不到不算失败 */ }

  console.log(problems ? `doctor: ${problems} 个问题` : "doctor: 全部通过");
  return problems ? 1 : 0;
}
