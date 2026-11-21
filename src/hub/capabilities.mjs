// 控制台添加能力、宿主 commands.json 片段，以及基于 AgentCards 名片的定时任务观察看板。
// 宿主节点的能力只来自该节点本地 commands.json，这里不下发、不代写。

import { randomBytes, randomUUID } from "node:crypto";
import { normalizeAttachments } from "../attachments.mjs";
import { f1 } from "../bus/tables.mjs";
import { capIdOf } from "../config.mjs";
import { formatCreatedAt } from "./create.mjs";
import {
  httpError,
  validateNodeName,
  validateProfileFields,
} from "./admission.mjs";

const HTTP_RECEIVE_MODES = new Set(["http-poll", "http-longpoll", "webhook"]);
const SIDE_EFFECTS = new Set(["read", "write"]);
const APPROVALS = new Set(["auto", "notify", "approve"]);
const SCHEDULE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_SCHEDULE_TZ = "Asia/Shanghai";
const CRON_BOUNDS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function text(row, name) {
  return String(f1(row, name) ?? "").trim();
}

export function cardMetadata(card) {
  const raw = card?.fields !== undefined ? f1(card, "Metadata") : card?.Metadata;
  if (!raw) return {};
  try {
    const meta = typeof raw === "object" ? raw : JSON.parse(String(raw));
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
    return meta;
  } catch {
    return {};
  }
}

function nodeCards(cards, node) {
  return (cards || []).filter((card) => text(card, "Node") === node);
}

function cardLooksHttp(card) {
  if (text(card, "Daemon_Version") === "http-agent") return true;
  const meta = cardMetadata(card);
  return meta.kind === "agent" && HTTP_RECEIVE_MODES.has(text(card, "Receive_Mode"));
}

// http：任一名片像外部 Agent，或机主已经给这个节点签发过 Token。
// host：其余有名片的节点。两边都没有则节点不存在。
export function classifyNode(node, cards, tokenStore) {
  const mine = nodeCards(cards, node);
  const hasToken = Boolean(tokenStore?.get?.(node));
  if (hasToken || mine.some(cardLooksHttp)) return "http";
  if (mine.length) return "host";
  return "missing";
}

// 节点级单一属性。名片上的取值不一致时返回空，避免把残缺状态当成 webhook 去改 URL。
export function nodeStoredReceiveMode(cards, node) {
  const modes = [...new Set(nodeCards(cards, node).map((card) => text(card, "Receive_Mode")).filter(Boolean))];
  return modes.length === 1 ? modes[0] : "";
}

// 只改接收方式两处，其余 Metadata 原样留下。已经一致的名片不写，避免无意义的序号跳动。
async function writeReceiveMode(bus, cards, receiveMode) {
  let updated = 0;
  for (const card of cards) {
    const meta = cardMetadata(card);
    if (text(card, "Receive_Mode") === receiveMode && meta.mode === receiveMode) continue;
    meta.mode = receiveMode;
    await bus.updateRecord(bus.tables.agentCards, card.record_id, {
      Receive_Mode: receiveMode,
      Metadata: JSON.stringify(meta),
    });
    updated += 1;
  }
  return updated;
}

export async function alignNodeReceiveMode(bus, node, receiveMode) {
  const cards = await bus.listRecords(bus.tables.agentCards);
  return writeReceiveMode(bus, nodeCards(cards, node), receiveMode);
}

export function validateSkillId(raw) {
  const skillId = String(raw ?? "").trim();
  if (skillId === "workers") throw httpError(400, "skill_id 不能是保留键 workers");
  try {
    return validateNodeName(skillId);
  } catch (e) {
    throw httpError(e?.status || 400, "skill_id 不合法（只允许字母、数字、._-，且不能为空或 *）");
  }
}

function validateWorkerName(raw) {
  const worker = String(raw ?? "").trim();
  if (!worker) return "";
  try {
    return validateNodeName(worker);
  } catch (e) {
    throw httpError(e?.status || 400, "worker 不合法（只允许字母、数字、._-，且不能为空或 *）");
  }
}

function validateSideEffect(raw, fallback = "write") {
  const value = String(raw ?? "").trim() || fallback;
  if (!SIDE_EFFECTS.has(value)) throw httpError(400, "side_effect 只能是 read 或 write");
  return value;
}

function validateApproval(raw, fallback = "auto") {
  const value = String(raw ?? "").trim() || fallback;
  if (!APPROVALS.has(value)) throw httpError(400, "approval_class 只能是 auto、notify 或 approve");
  return value;
}

function validateScheduleId(raw) {
  const id = String(raw ?? "").trim();
  if (!SCHEDULE_ID.test(id)) {
    throw httpError(400, "计划 ID 非法（只允许字母、数字、短横线或下划线，且不超过 64 个字符）");
  }
  return id;
}

export function buildCommandsSnippet(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "请求体必须是 JSON 对象");
  }
  const skillId = validateSkillId(body.skill_id);
  const worker = validateWorkerName(body.worker);
  const name = body.name == null ? "" : String(body.name).trim();
  const desc = body.description == null ? "" : String(body.description).trim();
  const side = validateSideEffect(body.side_effect, "write");
  const approval = validateApproval(body.approval_class, "auto");
  let entry;
  if (worker) {
    entry = {
      workers: [worker],
      name,
      desc,
      side_effect: side,
      approval_class: approval,
    };
  } else {
    const command = String(body.command ?? "").trim();
    if (!command) throw httpError(400, "未指定 worker 时必须提供 command");
    const mode = String(body.mode ?? "agent").trim() || "agent";
    if (mode !== "agent" && mode !== "json") throw httpError(400, "mode 只能是 agent 或 json");
    entry = {
      command,
      mode,
      name,
      desc,
      side_effect: side,
      approval_class: approval,
    };
  }
  const snippet = { [skillId]: entry };
  return {
    snippet,
    text: JSON.stringify(snippet, null, 2),
    hint: "复制到节点 <configDir>/commands.json，守护进程会热重载并自动登记名片",
  };
}

function firstFilled(cards, name) {
  for (const card of cards) {
    const value = text(card, name);
    if (value) return value;
  }
  return "";
}

function roleOf(cards, tokenStore, node) {
  const fromToken = tokenStore?.get?.(node)?.role;
  if (fromToken) return String(fromToken);
  for (const card of cards) {
    const role = cardMetadata(card).role;
    if (role) return String(role);
  }
  return "worker";
}

function nowMinute(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function createManualCard({ bus, tokenStore, body, now = new Date() } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "请求体必须是 JSON 对象");
  }
  const node = validateNodeName(body.node);
  const skillId = validateSkillId(body.skill_id);
  const worker = validateWorkerName(body.worker);
  const sideEffect = validateSideEffect(body.side_effect, "write");
  const approvalClass = validateApproval(body.approval_class, "auto");
  const profile = validateProfileFields(body);
  const cards = await bus.listRecords(bus.tables.agentCards);
  const kind = classifyNode(node, cards, tokenStore);
  if (kind === "missing") throw httpError(404, `节点不存在：${node}`);
  if (kind === "host") {
    const err = httpError(409, "宿主节点的能力只能在该节点本地 commands.json 声明");
    try {
      const snippet = buildCommandsSnippet({ ...body, skill_id: skillId, worker });
      err.snippet = snippet.snippet;
      err.text = snippet.text;
      err.hint = snippet.hint;
    } catch {
      // 没给 worker 也没给 command 时仍然拒绝，片段留给 commands-snippet。
    }
    throw err;
  }
  const mine = nodeCards(cards, node);
  const capId = capIdOf(
    worker ? `${worker}/${skillId}` : skillId,
    worker ? { worker, skill: skillId } : {},
    node,
  );
  if (cards.some((card) => text(card, "Cap_ID") === capId)) {
    throw httpError(409, `名片已存在：${capId}`);
  }
  const receiveMode = firstFilled(mine, "Receive_Mode") || "http-poll";
  const role = roleOf(mine, tokenStore, node);
  const created = await bus.createRecord(bus.tables.agentCards, {
    Cap_ID: capId,
    Node: node,
    Worker: worker,
    Skill_ID: skillId,
    Skill_Name: body.skill_name == null || String(body.skill_name).trim() === ""
      ? (profile.Display_Name || skillId)
      : String(body.skill_name).trim(),
    Description: body.description == null ? "" : String(body.description).trim(),
    Side_Effect: sideEffect,
    Approval_Class: approvalClass,
    Availability: firstFilled(mine, "Availability") || "offline",
    Dispatchable: "Yes",
    Receive_Mode: receiveMode,
    Daemon_Version: "http-agent",
    Zone: firstFilled(mine, "Zone") || "cloud",
    Admission: "admitted",
    Display_Name: profile.Display_Name ?? "",
    Admin_Note: profile.Admin_Note ?? "",
    Updated_At: nowMinute(now),
    Metadata: JSON.stringify({
      kind: "agent",
      role,
      mode: receiveMode,
      preset: true,
      manual: true,
      worker,
    }),
  });
  return created?.record ?? created;
}

function manualOrPreset(card) {
  const meta = cardMetadata(card);
  return meta.manual === true || meta.preset === true;
}

export async function deleteManualCard({ bus, tokenStore, capId } = {}) {
  const id = String(capId ?? "").trim();
  if (!id) throw httpError(400, "缺少 capId");
  const cards = await bus.listRecords(bus.tables.agentCards);
  const card = cards.find((row) => text(row, "Cap_ID") === id);
  if (!card) throw httpError(404, `名片不存在：${id}`);
  const node = text(card, "Node");
  if (classifyNode(node, cards, tokenStore) !== "http") {
    throw httpError(409, "宿主节点的能力只能在该节点本地 commands.json 声明");
  }
  if (!manualOrPreset(card)) {
    throw httpError(409, "只能删除控制台添加的 http 节点能力");
  }
  if (typeof bus.deleteRecord !== "function") throw httpError(501, "当前总线不支持删除名片");
  await bus.deleteRecord(bus.tables.agentCards, card.record_id);
  return { ok: true };
}

function parseIsoMs(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return NaN;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : NaN;
}

function validateScheduleTz(raw) {
  const tz = String(raw ?? "").trim() || DEFAULT_SCHEDULE_TZ;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date(0));
    return tz;
  } catch {
    throw httpError(400, `非法时区：${tz}`);
  }
}

function parseCronField(expr, min, max, isDow = false) {
  const raw = String(expr ?? "").trim();
  if (!raw) throw httpError(400, "cron 字段不能为空");
  const values = new Set();
  for (const part of raw.split(",")) {
    const slash = part.indexOf("/");
    const base = slash === -1 ? part : part.slice(0, slash);
    const stepStr = slash === -1 ? "" : part.slice(slash + 1);
    const step = slash === -1 ? 1 : Number(stepStr);
    if (slash !== -1 && (!/^\d+$/.test(stepStr) || step < 1)) {
      throw httpError(400, `cron 步长非法：${part}`);
    }
    let lo;
    let hi;
    if (base === "*") {
      lo = min;
      hi = max;
    } else if (base.includes("-")) {
      const m = /^(\d+)-(\d+)$/.exec(base);
      if (!m) throw httpError(400, `cron 范围非法：${part}`);
      lo = Number(m[1]);
      hi = Number(m[2]);
    } else if (/^\d+$/.test(base)) {
      lo = Number(base);
      hi = slash === -1 ? lo : max;
    } else {
      throw httpError(400, `cron 表达式非法：${part}`);
    }
    if (lo < min || hi > max || lo > hi) throw httpError(400, `cron 取值越界：${part}`);
    for (let v = lo; v <= hi; v += step) values.add(isDow && v === 7 ? 0 : v);
  }
  return values;
}

export function parseBasicCron(raw) {
  const parts = String(raw ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw httpError(400, "cron 必须是 5 段表达式（分 时 日 月 周）");
  return {
    expr: parts.join(" "),
    fields: parts.map((p, idx) => parseCronField(p, CRON_BOUNDS[idx][0], CRON_BOUNDS[idx][1], idx === 4)),
  };
}

function minCircularStep(set, span) {
  const arr = [...set].sort((a, b) => a - b);
  if (arr.length <= 1) return span;
  let best = span - arr[arr.length - 1] + arr[0];
  for (let i = 1; i < arr.length; i++) best = Math.min(best, arr[i] - arr[i - 1]);
  return Math.max(1, best);
}

export function inferIntervalMin(cronSpec) {
  if (!cronSpec?.fields) return 0;
  const [mins, hours, doms, , dows] = cronSpec.fields;
  if (hours.size === 24 && doms.size === 31 && dows.size >= 7) {
    return mins.size >= 60 ? 1 : minCircularStep(mins, 60);
  }
  if (doms.size === 31 && dows.size >= 7) return minCircularStep(hours, 24) * 60;
  if (dows.size < 7) return minCircularStep(dows, 7) * 1440;
  return minCircularStep(doms, 31) * 1440;
}

function tzParts(fmt, ms) {
  const raw = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== "literal") raw[p.type] = p.value;
  }
  return {
    month: Number(raw.month),
    day: Number(raw.day),
    dow: WEEKDAY_MAP[raw.weekday] ?? 0,
    hour: Number(raw.hour) % 24,
    minute: Number(raw.minute),
  };
}

export function nextApproxFireAt(cronSpec, tz, now = new Date()) {
  const [mins, hours, doms, months, dows] = cronSpec.fields;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
  });
  let t = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
  const limit = t + 370 * 86_400_000;
  let guard = 0;
  while (t <= limit && guard++ < 5000) {
    const p = tzParts(fmt, t);
    if (!months.has(p.month) || !doms.has(p.day) || !dows.has(p.dow)) {
      t += Math.max(1, (23 - p.hour) * 60 + (60 - p.minute)) * 60_000;
      continue;
    }
    if (!hours.has(p.hour)) {
      t += Math.max(1, 60 - p.minute) * 60_000;
      continue;
    }
    if (!mins.has(p.minute)) {
      t += 60_000;
      continue;
    }
    return new Date(t).toISOString();
  }
  return "";
}

function findLastScheduledTask(tasks, node, scheduleId, lastFired) {
  const prefix = `sched:${node}:${scheduleId}:`;
  const related = tasks.filter((row) => {
    const meta = cardMetadata({ Metadata: f1(row, "Metadata") });
    const idemp = text(row, "Idempotency_Key");
    if (meta.schedule_id === scheduleId && (text(row, "Target_Node") === node || idemp.startsWith(prefix))) {
      return true;
    }
    return idemp.startsWith(prefix);
  });
  if (!related.length) return null;
  let hit = lastFired ? related.find((row) => text(row, "Idempotency_Key") === `${prefix}${lastFired}`) : null;
  if (!hit) {
    related.sort((a, b) => {
      const tb = text(b, "Updated_At") || text(b, "Created_At");
      const ta = text(a, "Updated_At") || text(a, "Created_At");
      if (tb !== ta) return tb.localeCompare(ta);
      const sb = Number(b?.seq) || 0;
      const sa = Number(a?.seq) || 0;
      if (sb !== sa) return sb - sa;
      return text(b, "Task_ID").localeCompare(text(a, "Task_ID"));
    });
    hit = related[0];
  }
  return {
    task_id: text(hit, "Task_ID"),
    status: text(hit, "Status"),
    updated_at: text(hit, "Updated_At") || text(hit, "Created_At"),
  };
}

export function nodeIsOffline(node, cards, connected) {
  const live = (connected || []).find((item) => item?.node === node);
  if (live) return live.online !== true;
  const mine = nodeCards(cards, node);
  if (!mine.length) return true;
  return mine.every((card) => text(card, "Availability").toLowerCase() === "offline");
}

function scheduleAnomaly({ enabled, intervalMin, lastFired, lastTask, registeredAt, offline, now }) {
  if (offline) return "node-offline";
  if (lastTask && (lastTask.status === "failed" || lastTask.status === "rejected")) return "failed";
  if (!enabled || !(intervalMin > 0)) return "";
  const firedMs = parseIsoMs(lastFired);
  const taskMs = lastTask ? parseIsoMs(lastTask.updated_at) : NaN;
  const anchorMs = Math.max(
    Number.isFinite(firedMs) ? firedMs : -Infinity,
    Number.isFinite(taskMs) ? taskMs : -Infinity,
  );
  const baseMs = Number.isFinite(anchorMs) ? anchorMs : parseIsoMs(registeredAt);
  if (!Number.isFinite(baseMs)) return "";
  if (now.getTime() - baseMs > intervalMin * 1.5 * 60_000) return "missed";
  return "";
}

function normalizeScheduleEntry(raw, { scheduleId, existing, nowIso, defaultTz = DEFAULT_SCHEDULE_TZ } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw httpError(400, "计划配置必须是对象");
  }
  const id = validateScheduleId(scheduleId ?? raw.id ?? raw.schedule_id);
  const cronRaw = String(raw.cron ?? "").trim();
  if (!cronRaw) throw httpError(400, "缺少 cron");
  const cronSpec = parseBasicCron(cronRaw);
  const hasTz = Object.hasOwn(raw, "tz") && String(raw.tz ?? "").trim() !== "";
  const tz = hasTz ? validateScheduleTz(raw.tz) : (existing?.tz || defaultTz);
  if (Object.hasOwn(raw, "enabled") && typeof raw.enabled !== "boolean") {
    throw httpError(400, "enabled 必须是布尔值");
  }
  let intervalMin = existing?.interval_min || 0;
  if (Object.hasOwn(raw, "interval_min") && raw.interval_min !== null && raw.interval_min !== "") {
    const n = Number(raw.interval_min);
    if (!Number.isFinite(n) || n <= 0) throw httpError(400, "interval_min 必须是大于 0 的数字");
    intervalMin = n;
  } else {
    intervalMin = inferIntervalMin(cronSpec);
  }
  return {
    id,
    cron: cronSpec.expr,
    tz,
    interval_min: intervalMin,
    cap: Object.hasOwn(raw, "cap") ? String(raw.cap ?? "").trim() : (existing?.cap ?? ""),
    text: Object.hasOwn(raw, "text") ? String(raw.text ?? "") : (existing?.text ?? ""),
    enabled: Object.hasOwn(raw, "enabled") ? raw.enabled : (existing?.enabled ?? true),
    last_fired: Object.hasOwn(raw, "last_fired")
      ? String(raw.last_fired ?? "").trim()
      : (existing?.last_fired ?? ""),
    note: Object.hasOwn(raw, "note") ? String(raw.note ?? "") : (existing?.note ?? ""),
    source: raw.source === "node" ? "node" : "http-agent",
    updated_at: nowIso,
  };
}

export function normalizeScheduleSpecs(list, { existing = [], now = new Date(), defaultTz = DEFAULT_SCHEDULE_TZ } = {}) {
  if (!Array.isArray(list)) throw httpError(400, "schedules 必须是数组");
  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
  const prevById = new Map((Array.isArray(existing) ? existing : []).map((s) => [s?.id, s]));
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const entry = normalizeScheduleEntry(item, {
      existing: prevById.get(String(item?.id ?? item?.schedule_id ?? "").trim()),
      nowIso,
      defaultTz,
    });
    if (seen.has(entry.id)) throw httpError(400, `重复计划 ID：${entry.id}`);
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

function primaryScheduleCard(cards, node) {
  const mine = nodeCards(cards, node);
  if (!mine.length) return null;
  const agentCap = capIdOf("agent", {}, node);
  return mine.find((c) => text(c, "Cap_ID") === agentCap)
    || mine.find((c) => text(c, "Skill_ID") === "agent")
    || mine[0];
}

export function listSchedules({ tasks = [], cards = [], connected = [], now = new Date(), hubNode = "", hubTz = "" } = {}) {
  const clock = now instanceof Date ? now : new Date(now);
  const byKey = new Map();
  for (const card of cards) {
    const node = text(card, "Node");
    if (!node) continue;
    const rawList = cardMetadata(card).schedules;
    if (!Array.isArray(rawList)) continue;
    for (const raw of rawList) {
      if (!raw || typeof raw !== "object") continue;
      const scheduleId = String(raw.id ?? raw.schedule_id ?? "").trim();
      if (!scheduleId) continue;
      const key = `${node}:${scheduleId}`;
      const prev = byKey.get(key);
      if (!prev || String(raw.updated_at ?? "") >= String(prev.updated_at ?? "")) {
        byKey.set(key, { node, scheduleId, raw });
      }
    }
  }

  const schedules = [];
  for (const { node, scheduleId, raw } of byKey.values()) {
    const cron = String(raw.cron ?? "").trim();
    const enabled = raw.enabled !== false;
    const lastFired = String(raw.last_fired ?? "").trim();
    const source = raw.source === "node" ? "node" : "http-agent";
    let tz = String(raw.tz ?? "").trim();
    if (!tz && hubNode && node === hubNode && hubTz) tz = String(hubTz);
    if (!tz) tz = DEFAULT_SCHEDULE_TZ;
    try {
      tz = validateScheduleTz(tz);
    } catch {
      tz = DEFAULT_SCHEDULE_TZ;
    }
    let cronSpec = null;
    try {
      cronSpec = parseBasicCron(cron);
    } catch {
      cronSpec = null;
    }
    const intervalMin = Number(raw.interval_min) > 0
      ? Number(raw.interval_min)
      : (cronSpec ? inferIntervalMin(cronSpec) : 0);
    const nextFire = cronSpec ? nextApproxFireAt(cronSpec, tz, clock) : "";
    const lastTask = findLastScheduledTask(tasks, node, scheduleId, lastFired);
    const offline = nodeIsOffline(node, cards, connected);
    schedules.push({
      rule_id: `${node}:${scheduleId}`,
      node,
      schedule_id: scheduleId,
      cron,
      tz,
      interval_min: intervalMin,
      cap: String(raw.cap ?? ""),
      text: String(raw.text ?? ""),
      enabled,
      last_fired: lastFired,
      next_fire_at: nextFire,
      source,
      note: String(raw.note ?? ""),
      last_task: lastTask,
      anomaly: scheduleAnomaly({
        enabled,
        intervalMin,
        lastFired,
        lastTask,
        registeredAt: raw.updated_at,
        offline,
        now: clock,
      }),
    });
  }
  return schedules;
}

async function createScheduleRunTask({ bus, node, scheduleId, entry, run, primaryCard, clock, fileStore, hubNode }) {
  const status = String(run.status ?? "completed").trim() || "completed";
  if (!new Set(["submitted", "working", "completed", "failed"]).has(status)) {
    throw httpError(400, "run.status 只能是 submitted、working、completed 或 failed");
  }
  const files = normalizeAttachments(run.artifacts ?? run.artifact, { fileStore });
  const taskId = `TASK-${clock.getFullYear()}${String(clock.getMonth() + 1).padStart(2, "0")}${String(clock.getDate()).padStart(2, "0")}-${randomBytes(3).toString("hex")}`;
  const suffix = taskId.slice("TASK-".length);
  const contextId = String(run.context_id ?? `CTX-${suffix}`).trim();
  const createdAt = formatCreatedAt(clock);
  const firedAt = String(run.fired_at ?? clock.toISOString()).trim() || clock.toISOString();
  const cap = String(run.cap ?? entry.cap ?? text(primaryCard, "Cap_ID")).trim();
  const skill = String(run.skill_id ?? text(primaryCard, "Skill_ID") ?? "agent").trim() || "agent";
  const instrText = String(run.instruction ?? entry.text ?? `定时计划 ${scheduleId}`).slice(0, 4000);
  const instrMsgId = `MSG-${suffix}-01`;

  await bus.createRecord(bus.tables.messages, {
    Msg_ID: instrMsgId,
    Task_ID: taskId,
    Context_ID: contextId,
    From_Node: node,
    To_Node: node,
    Role: "user",
    Kind: "instruction",
    Created_At: createdAt,
  });
  await bus.createRecord(bus.tables.parts, {
    Part_ID: `${instrMsgId}-P1`,
    Parent_ID: instrMsgId,
    Parent_Type: "message",
    Seq: 1,
    Kind: "text",
    Text: instrText,
  });

  let statusMsgId = instrMsgId;
  if (status !== "submitted") {
    statusMsgId = `MSG-${suffix}-02`;
    let artId = "";
    if (files.length && bus.tables.artifacts) {
      artId = `ART-${suffix}-01`;
      await bus.createRecord(bus.tables.artifacts, {
        Artifact_ID: artId,
        Task_ID: taskId,
        Name: String(run.artifact_name ?? `${scheduleId} 交付产物`),
        Description: String(run.text ?? instrText).slice(0, 500),
      });
      for (let i = 0; i < files.length; i++) {
        await bus.createRecord(bus.tables.parts, {
          Part_ID: `${artId}-P${i + 1}`,
          Parent_ID: artId,
          Parent_Type: "artifact",
          Seq: i + 1,
          Kind: "file",
          File_URI: files[i].uri,
          File_Name: files[i].name,
          Mime_Type: files[i].mime,
        });
      }
    }
    await bus.createRecord(bus.tables.messages, {
      Msg_ID: statusMsgId,
      Task_ID: taskId,
      Context_ID: contextId,
      From_Node: node,
      To_Node: hubNode || "hub",
      Role: "agent",
      Kind: status === "failed" ? "error" : "result",
      ...(artId ? { Artifact_Ref: artId } : {}),
      Created_At: createdAt,
    });
    const bodyText = String(run.text ?? (status === "failed" ? "定时任务失败" : "定时任务已完成")).slice(0, 4000);
    await bus.createRecord(bus.tables.parts, {
      Part_ID: `${statusMsgId}-P1`,
      Parent_ID: statusMsgId,
      Parent_Type: "message",
      Seq: 1,
      Kind: "text",
      Text: bodyText,
    });
  }

  await bus.createRecord(bus.tables.tasks, {
    Task_ID: taskId,
    Title: String(run.title ?? entry.text ?? `${scheduleId} @ ${node}`).slice(0, 200),
    Source: "cron",
    Target_Node: node,
    Skill_ID: skill,
    Status: status,
    Status_Msg: statusMsgId,
    Hop_Count: 0,
    Retry_Count: 0,
    Idempotency_Key: String(run.idempotency_key ?? `sched:${node}:${scheduleId}:${firedAt}`),
    Context_ID: contextId,
    Metadata: JSON.stringify({
      schedule_id: scheduleId,
      dispatch_target: { node, worker: text(primaryCard, "Worker"), skill, cap_id: cap },
    }),
  });
  return { taskId, status, firedAt };
}

export async function saveHttpAgentSchedule({ bus, node, scheduleId, body, now = new Date(), fileStore, hubNode = "hub" } = {}) {
  if (!bus?.tables?.agentCards) throw httpError(500, "总线未配置 agentCards 表");
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "请求体必须是 JSON 对象");
  }
  const name = validateNodeName(node);
  const id = validateScheduleId(scheduleId);
  const clock = now instanceof Date ? now : new Date(now);
  const nowIso = clock.toISOString();
  const cards = await bus.listRecords(bus.tables.agentCards);
  const primary = primaryScheduleCard(cards, name);
  if (!primary) throw httpError(404, `节点未注册，请先注册名片：${name}`);

  const meta = cardMetadata(primary);
  const list = Array.isArray(meta.schedules) ? meta.schedules.slice() : [];
  const idx = list.findIndex((s) => s?.id === id);
  const existing = idx >= 0 ? list[idx] : null;
  const entry = normalizeScheduleEntry(body, { scheduleId: id, existing, nowIso });

  const runPayload = body.run ?? body.task;
  let runOut = null;
  if (runPayload !== undefined && runPayload !== null) {
    if (typeof runPayload !== "object" || Array.isArray(runPayload)) {
      throw httpError(400, "run 必须是 JSON 对象");
    }
    runOut = await createScheduleRunTask({
      bus, node: name, scheduleId: id, entry, run: runPayload, primaryCard: primary, clock, fileStore, hubNode,
    });
    entry.last_fired = runOut.firedAt;
  }

  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  await bus.updateRecord(bus.tables.agentCards, primary.record_id, {
    Metadata: JSON.stringify({ ...meta, schedules: list }),
  });
  return {
    ok: true,
    node: name,
    schedule_id: id,
    rule_id: `${name}:${id}`,
    schedule: entry,
    ...(runOut ? { task_id: runOut.taskId, status: runOut.status } : {}),
    at: nowIso,
  };
}

export async function removeHttpAgentSchedule({ bus, node, scheduleId } = {}) {
  if (!bus?.tables?.agentCards) throw httpError(500, "总线未配置 agentCards 表");
  const name = validateNodeName(node);
  const id = validateScheduleId(scheduleId);
  const cards = nodeCards(await bus.listRecords(bus.tables.agentCards), name);
  let removed = false;
  for (const card of cards) {
    const meta = cardMetadata(card);
    if (!Array.isArray(meta.schedules)) continue;
    const next = meta.schedules.filter((s) => s?.id !== id);
    if (next.length === meta.schedules.length) continue;
    const updatedMeta = { ...meta };
    if (next.length) updatedMeta.schedules = next;
    else delete updatedMeta.schedules;
    await bus.updateRecord(bus.tables.agentCards, card.record_id, {
      Metadata: JSON.stringify(updatedMeta),
    });
    removed = true;
  }
  if (!removed) throw httpError(404, `计划不存在：${name}:${id}`);
  return { ok: true };
}
