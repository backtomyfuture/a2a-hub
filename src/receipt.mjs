// 回执解析与命令模板占位符。从内核拆出后行为不变；默认日志函数来自 kernel-util，避免和状态机循环引用。
import { normalizeJsonChecks, parseCheckLine } from "./acceptance.mjs";
import { log } from "./kernel-util.mjs";

export function modelAuditOf(rawMetadata) {
  let meta = rawMetadata;
  if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch { return null; } }
  const m = meta?.model;
  if (!m || !["override", "worker_default", "cli_default"].includes(m.model_source)) return null;
  if (!["requested_model", "default_model", "effective_model"].every((k) =>
    Object.hasOwn(m, k) && (m[k] === null || typeof m[k] === "string"))) return null;
  return Object.freeze({ requested_model: m.requested_model, default_model: m.default_model,
    effective_model: m.effective_model, model_source: m.model_source });
}

// 执行适配器只知道原生 CLI 参数，不维护任何模型标识表。
const MODEL_FLAGS = Object.freeze({
  claude: "--model",
  codex: "--model",
  grok: "--model",
  agy: "--model",
  droid: "--model",
  cursor: "--model",
  opencode: "--model",
});
export function modelArgs(harness, model) {
  if (model === null) return [];
  const flag = Object.hasOwn(MODEL_FLAGS, harness) ? MODEL_FLAGS[harness] : null;
  if (!flag) throw new Error(`model_execution_not_supported: ${harness || "unknown harness"}`);
  return [flag, model];
}

function modelArgsSlot(command) {
  const marker = "{model_args}";
  if (typeof command !== "string" || command.split(marker).length !== 2) return false;
  const at = command.indexOf(marker);
  if (!/\s/.test(command[at - 1] || "") || !/^(?:\s|$)/.test(command.slice(at + marker.length))) return false;
  if (/(?:^|\s)['"]?--model(?:[=\s'"]|$)/.test(command)) return false;
  let quote = "";
  for (let i = 0; i < at; i++) {
    const c = command[i];
    if (c === "\\" && quote !== "'") { i++; continue; }
    if (quote) { if (c === quote) quote = ""; }
    else if (c === "'" || c === '"' || c === "`") quote = c;
  }
  return !quote;
}

export function modelArgsSupported(entry, harness) {
  return (!entry.context || entry.context === "direct") && entry.mode !== "inbox"
    && Object.hasOwn(MODEL_FLAGS, harness) && modelArgsSlot(entry.command)
    && (!entry.resume_command || modelArgsSlot(entry.resume_command));
}

const MAX_ARTIFACTS = 20;
const JSON_RECEIPT_KEYS = new Set(["summary", "artifact", "artifacts", "artifact_name", "need_input", "need_auth", "usage", "session", "checks"]);
const USAGE_CAP = 1e12;
export const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const USAGE_NUMBER = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export class NeedInput extends Error {}

// 执行中请求机主批准。与提问一样不是失败，不许按重试再跑一遍。
export class NeedAuth extends Error {}

// 进程已成功退出，但 stdout 不能按回执约定解析。这不是执行失败，不许重跑。
export class InvalidReceipt extends Error {
  constructor(message, raw) {
    super(message);
    this.name = "InvalidReceipt";
    this.raw = raw ?? "";
  }
}

// 费用只留 6 位小数。toFixed 的舍入足够，1e12 以内没有整数精度问题。
function roundCost(n) {
  return Number(Number(n).toFixed(6));
}

function parseLooseNumber(raw) {
  const s = String(raw ?? "").trim();
  if (!USAGE_NUMBER.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > USAGE_CAP) return null;
  return n;
}

function blankUsage() {
  return { input: 0, output: 0, cached: 0, cost: 0, runs: 0, reported: 0 };
}

// 坏的历史值不当作上报，按 0 接着累加，避免一格脏数据让后续轮次写不进去。
function asUsageTotals(raw) {
  const base = blankUsage();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const n = (v, cost = false) => {
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0) return 0;
    return cost ? roundCost(x) : Math.trunc(x);
  };
  base.input = n(raw.input);
  base.output = n(raw.output);
  base.cached = n(raw.cached);
  base.cost = n(raw.cost, true);
  base.runs = n(raw.runs);
  base.reported = Math.min(base.runs, n(raw.reported));
  return base;
}

// report 为 null 表示这一轮没上报：只加 runs。合法对象才加 reported 和四项用量。
export function addUsage(prev, report) {
  const base = asUsageTotals(prev);
  base.runs += 1;
  if (report && typeof report === "object" && !Array.isArray(report)) {
    const add = asUsageTotals(report);
    base.reported += 1;
    base.input += add.input;
    base.output += add.output;
    base.cached += add.cached;
    base.cost = roundCost(base.cost + add.cost);
  }
  return base;
}

function logUsageIgnored(logFn) {
  logFn("usage 整条忽略：非法或超限");
}

// 行文本或 JSON 对象。键可缺，缺的按 0；任一已知键非法则整条作废。未知键不执行。
function parseUsageValue(raw, logFn, fromLine) {
  if (fromLine) {
    const text = String(raw ?? "").trim();
    const usage = { input: 0, output: 0, cached: 0, cost: 0 };
    if (!text) return usage;
    const seen = new Set();
    for (const token of text.split(/\s+/)) {
      const m = /^(input|output|cached|cost)=(.+)$/.exec(token);
      if (!m || seen.has(m[1])) {
        logUsageIgnored(logFn);
        return null;
      }
      seen.add(m[1]);
      const num = parseLooseNumber(m[2]);
      if (num == null) {
        logUsageIgnored(logFn);
        return null;
      }
      usage[m[1]] = m[1] === "cost" ? roundCost(num) : Math.trunc(num);
    }
    return usage;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    logUsageIgnored(logFn);
    return null;
  }
  const usage = { input: 0, output: 0, cached: 0, cost: 0 };
  for (const key of ["input", "output", "cached", "cost"]) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const v = raw[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > USAGE_CAP) {
      logUsageIgnored(logFn);
      return null;
    }
    usage[key] = key === "cost" ? roundCost(v) : Math.trunc(v);
  }
  return usage;
}

function parseSessionValue(raw, logFn) {
  if (typeof raw !== "string" || !SESSION_ID.test(raw.trim())) {
    logFn("session 整条忽略：id 非法");
    return null;
  }
  return raw.trim();
}

function stampSide(err, usage, session) {
  err.usage = usage ?? null;
  err.session = session ?? null;
  return err;
}

// 只认最后一个完整围栏：资料里的示例围栏不能抢先变成提问。
// 产物行必须整行落在围栏外，避免模型复述示例时登记错误路径。
// 输出被截成头尾时，头里未闭合的围栏不能吞掉尾部回执，所以只解析最后一处省略标记之后。
const OUTPUT_OMITTED_LINE = /^…\[中间省略 \d+ 字节\]…$/;

export function parseAgentReceipt(out, logFn = log) {
  const text = String(out ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const all = text.split("\n");
  let cut = 0;
  for (let i = 0; i < all.length; i++) {
    if (OUTPUT_OMITTED_LINE.test(all[i])) cut = i + 1;
  }
  const lines = all.slice(cut);
  const closed = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open) {
      if (/^```\s*$/.test(line)) {
        open.end = i;
        closed.push(open);
        open = null;
      } else {
        open.body.push(line);
      }
    } else if (line.startsWith("```")) {
      open = { start: i, end: -1, lang: line.slice(3).trim(), body: [] };
    }
  }
  const last = closed.length ? closed[closed.length - 1] : null;
  // 提问与执行中审批共用「最后一个完整围栏」：更早的围栏（含另一种中断）不算数。
  const ask = last && /^agent-ask(?:\s|$)/.test(last.lang) ? last.body.join("\n").trim() : null;
  const authLang = last && /^agent-auth(?:\s|$)/.test(last.lang);
  const authBody = authLang ? last.body.join("\n").trim() : null;
  const inside = new Set();
  for (const fence of closed) {
    for (let i = fence.start; i <= fence.end; i++) inside.add(i);
  }
  // 每行 ARTIFACT: 登记一个交付文件；ARTIFACT_NAME: 作用于紧邻的上一条（还没有上一条时留给下一条）。
  const artifacts = [];
  let pendingName = "";
  // 最后一条才算数。非法则整条丢掉，不退回更早的一条。
  let usageBody;
  let sessionBody;
  let checkCount = 0;
  const checks = {};
  const invalidChecks = [];
  const keep = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inside.has(i)) {
      const art = /^ARTIFACT:\s*(.*?)\s*$/.exec(line);
      const name = /^ARTIFACT_NAME:\s*(.*?)\s*$/.exec(line);
      const usage = /^USAGE:\s*(.*)$/.exec(line);
      const session = /^SESSION:\s*(.*)$/.exec(line);
      if (art) {
        if (art[1] && artifacts.length < MAX_ARTIFACTS) {
          artifacts.push(pendingName ? { uri: art[1], name: pendingName } : { uri: art[1] });
          pendingName = "";
        } else if (art[1]) {
          logFn(`ARTIFACT 超过 ${MAX_ARTIFACTS} 个，忽略多余的：${art[1].slice(0, 120)}`);
        }
        continue;
      }
      if (name) {
        if (artifacts.length) artifacts[artifacts.length - 1].name = name[1];
        else pendingName = name[1];
        continue;
      }
      if (usage) { usageBody = usage[1]; continue; }
      if (session) { sessionBody = session[1]; continue; }
      // 围栏外整行 CHECK 同样从摘要里拿掉；合法按 id 取最后一条，不合法只记日志不废整份回执。
      const check = parseCheckLine(line);
      if (check) {
        checkCount += 1;
        if (check.invalid) invalidChecks.push(check.raw);
        else checks[check.id] = { verdict: check.verdict, evidence: check.evidence };
        continue;
      }
    }
    keep.push(line);
  }
  const usage = usageBody === undefined ? null : parseUsageValue(usageBody, logFn, true);
  const session = sessionBody === undefined ? null : parseSessionValue(sessionBody, logFn);
  // 提问和无效回执都不是完成。自检留到完成再写，这里只记一笔，不挂到错误上。
  if (ask != null) {
    if (checkCount) logFn("checks 在 input-required 上忽略");
    throw stampSide(new NeedInput(ask), usage, session);
  }
  if (authLang) {
    if (checkCount) logFn("checks 在 auth-required 上忽略");
    if (!authBody) {
      throw stampSide(new InvalidReceipt("agent-auth 缺少审批说明", text.slice(0, 500)), usage, session);
    }
    throw stampSide(new NeedAuth(authBody), usage, session);
  }
  let summary = keep.join("\n").trim();
  // 进程已经成功退出。没有摘要是回执无效，不是执行失败，不能按重试再跑一遍。
  if (!summary) {
    if (checkCount) logFn("checks 在 failed 上忽略");
    throw stampSide(new InvalidReceipt("agent produced no output", text.slice(0, 500)), usage, session);
  }
  for (const raw of invalidChecks) {
    logFn(`checks 忽略非法行：${raw}`);
  }
  // 未截断时仍从开头留 4000，和原来的回执一致。截断后正文在尾部，从末尾留 4000，避免结论被日志挤掉。
  if (summary.length > 4000) summary = cut > 0 ? summary.slice(-4000) : summary.slice(0, 4000);
  const r = { summary, artifact: artifacts[0]?.uri ?? "", artifacts, usage, session, checks };
  const artName = artifacts[0]?.name || pendingName;
  if (artName) r.artifact_name = artName;
  return r;
}

// JSON 回执的交付文件：旧的 artifact 字符串在前（附 artifact_name），再接 artifacts 数组；
// 数组元素是字符串或 { uri, name?, mime? }。非法元素只记日志跳过，不废整份回执。
function jsonArtifacts(res, logFn) {
  const out = [];
  const seen = new Set();
  const push = (item) => {
    if (seen.has(item.uri)) return;
    if (out.length >= MAX_ARTIFACTS) {
      logFn(`artifacts 超过 ${MAX_ARTIFACTS} 个，忽略多余的`);
      return;
    }
    seen.add(item.uri);
    out.push(item);
  };
  const legacy = String(res.artifact ?? "").trim();
  if (legacy) {
    const legacyName = res.artifact_name ? String(res.artifact_name) : "";
    push(legacyName ? { uri: legacy, name: legacyName } : { uri: legacy });
  }
  if (res.artifacts == null) return out;
  if (!Array.isArray(res.artifacts)) {
    logFn("artifacts 不是数组，已忽略");
    return out;
  }
  for (const raw of res.artifacts) {
    if (typeof raw === "string" && raw.trim()) {
      push({ uri: raw.trim() });
    } else if (raw && typeof raw === "object" && !Array.isArray(raw) && typeof raw.uri === "string" && raw.uri.trim()) {
      const item = { uri: raw.uri.trim() };
      if (raw.name != null && String(raw.name).trim()) item.name = String(raw.name);
      if (raw.mime != null && String(raw.mime).trim()) item.mime = String(raw.mime);
      push(item);
    } else {
      logFn("artifacts 忽略非法元素");
    }
  }
  return out;
}

// json 模式仍只看最后一行对象。未知顶层键不执行，只留一条日志，避免回执里的 command 被当成控制项。
export function parseJsonReceipt(res, logFn = log) {
  if (!res || typeof res !== "object" || Array.isArray(res)) {
    throw new InvalidReceipt("回执不是 JSON 对象", "");
  }
  const unknown = Object.keys(res).filter((k) => !JSON_RECEIPT_KEYS.has(k));
  if (unknown.length) logFn(("json 回执忽略未知顶层键：" + unknown.join(",")).slice(0, 300));
  // 缺键是未上报，不是非法。非法才记日志并整条丢掉。
  const usage = Object.prototype.hasOwnProperty.call(res, "usage")
    ? parseUsageValue(res.usage, logFn, false)
    : null;
  const session = Object.prototype.hasOwnProperty.call(res, "session")
    ? parseSessionValue(res.session, logFn)
    : null;
  const hasChecks = Object.prototype.hasOwnProperty.call(res, "checks") && res.checks != null;
  if (res.need_input && res.need_auth) {
    throw stampSide(new InvalidReceipt("need_input 与 need_auth 不能同时存在", ""), usage, session);
  }
  if (res.need_input) {
    if (hasChecks) logFn("checks 在 input-required 上忽略");
    throw stampSide(new NeedInput(String(res.need_input)), usage, session);
  }
  const authText = res.need_auth == null ? "" : String(res.need_auth).trim();
  if (authText) {
    if (hasChecks) logFn("checks 在 auth-required 上忽略");
    throw stampSide(new NeedAuth(authText), usage, session);
  }
  const checks = hasChecks ? normalizeJsonChecks(res.checks, logFn) : {};
  const artifacts = jsonArtifacts(res, logFn);
  const r = {
    summary: String(res.summary ?? "").slice(0, 4000),
    artifact: artifacts[0]?.uri ?? "",
    artifacts,
    usage,
    session,
    checks,
  };
  const artName = res.artifact_name ? String(res.artifact_name) : (artifacts[0]?.name || "");
  if (artName) r.artifact_name = artName;
  return r;
}

// {prompt} 与 {session} 各替换一次，插入的文本不再扫描，避免会话号或提示里的占位符二次展开。
export function substituteCommand(template, vars = {}) {
  const text = String(template ?? "");
  let out = "";
  let i = 0;
  const seen = new Set();
  while (i < text.length) {
    let hit = "";
    if (!seen.has("prompt") && text.startsWith("{prompt}", i)) hit = "prompt";
    else if (!seen.has("session") && text.startsWith("{session}", i)) hit = "session";
    else if (!seen.has("model_args") && text.startsWith("{model_args}", i)) hit = "model_args";
    if (hit) {
      seen.add(hit);
      const value = vars[hit];
      if (hit === "model_args") {
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error("model_args 必须是字符串数组");
        out += value.map(shellQuote).join(" ");
      } else out += value == null ? `{${hit}}` : shellQuote(value);
      i += hit.length + 2;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}
