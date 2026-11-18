// 控制台添加能力、宿主 commands.json 片段，以及定时任务只读汇总。
// 宿主节点的能力只来自该节点本地 commands.json，这里不下发、不代写。

import { f1 } from "../bus/tables.mjs";
import { capIdOf } from "../config.mjs";
import {
  DEFAULT_SCHEDULE_TZ,
  formatOccurrenceKey,
  latestOccurrence,
  nextOccurrence,
  parseCron,
  resolveScheduleTz,
} from "../schedule-cron.mjs";
import {
  buildOnboarding,
  httpError,
  receiveModeFor,
  validateNodeName,
  validateProfileFields,
  validateReceive,
} from "./admission.mjs";
import { validateWebhookUrl } from "./webhooks.mjs";

const HTTP_RECEIVE_MODES = new Set(["http-poll", "http-longpoll", "webhook"]);
const SIDE_EFFECTS = new Set(["read", "write"]);
const APPROVALS = new Set(["auto", "notify", "approve"]);
const SCHEDULE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const MISS_MS = 10 * 60 * 1000;

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

function roleFromCardsOrToken(cards, tokenStore, node) {
  for (const card of cards) {
    const role = cardMetadata(card).role;
    if (role) return String(role);
  }
  const fromToken = tokenStore?.get?.(node)?.role;
  if (fromToken) return String(fromToken);
  return "worker";
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

const HOST_RECEIVE_ERROR = "宿主节点由 ah daemon 常驻长连接，不能切换接收方式";

// 接收方式是节点级三选一。切到 webhook 才允许有推送配置，切走必须删掉，避免名片和门铃各说各话。
export async function switchNodeReceive({
  bus,
  tokenStore,
  webhookStore,
  node: rawNode,
  body,
  hubUrl,
  authRequired = false,
} = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "请求体必须是 JSON 对象");
  }
  const node = validateNodeName(rawNode);
  const rawReceive = String(body.receive ?? "").trim();
  if (!rawReceive) throw httpError(400, "receive 只能是 poll / longpoll / webhook");
  const receive = validateReceive(rawReceive);
  const cards = await bus.listRecords(bus.tables.agentCards);
  if (classifyNode(node, cards, tokenStore) !== "http") {
    throw httpError(409, HOST_RECEIVE_ERROR);
  }
  const receiveMode = receiveModeFor(receive);
  const mine = nodeCards(cards, node);

  let webhookPayload = null;
  let webhookSecret = "";
  if (receive === "webhook") {
    if (!webhookStore) throw httpError(500, "未配置 configDir，无法保存 Webhook");
    const url = validateWebhookUrl(body.webhook_url);
    const saved = webhookStore.put({ node, url });
    webhookPayload = { url: saved.hook.url };
    // 密钥只在新建时交出来。节点上已经有 Webhook 时，换 URL 不轮换、也不再显示旧密钥。
    if (saved.secret) {
      webhookPayload.secret = saved.secret;
      webhookSecret = saved.secret;
    }
  } else if (webhookStore) {
    webhookStore.remove(node);
  }

  const cardsUpdated = await writeReceiveMode(bus, mine, receiveMode);
  const onboarding = buildOnboarding({
    hubUrl,
    node,
    access: "http",
    role: roleFromCardsOrToken(mine, tokenStore, node),
    authRequired,
    receive,
    webhookSecret,
  });
  const payload = {
    ok: true,
    node,
    receive,
    receive_mode: receiveMode,
    cards_updated: cardsUpdated,
    onboarding,
  };
  if (webhookPayload) payload.webhook = webhookPayload;
  return payload;
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

function minuteKey(value) {
  const matched = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(String(value ?? "").trim());
  return matched ? matched[1] : "";
}

function noteTz(note) {
  const matched = /(?:^|[；;])tz=([^\s；;]+)/.exec(String(note ?? ""));
  return matched ? matched[1] : "";
}

function splitRule(ruleId, target) {
  const id = String(ruleId ?? "");
  const node = String(target ?? "").trim();
  if (node && id.startsWith(`${node}:`)) {
    return { node, scheduleId: id.slice(node.length + 1) };
  }
  const cut = id.indexOf(":");
  if (cut > 0) return { node: node || id.slice(0, cut), scheduleId: id.slice(cut + 1) };
  return { node, scheduleId: id };
}

function findLastTask(tasks, node, scheduleId, lastFired, note) {
  const prefix = `sched:${node}:${scheduleId}:`;
  let hit = null;
  if (lastFired) {
    hit = tasks.find((row) => text(row, "Idempotency_Key") === `${prefix}${lastFired}`);
  }
  if (!hit) {
    const mentioned = /上次运行\s+(\S+)/.exec(String(note ?? ""));
    if (mentioned) hit = tasks.find((row) => text(row, "Task_ID") === mentioned[1]);
  }
  if (!hit) {
    const related = tasks.filter((row) => text(row, "Idempotency_Key").startsWith(prefix));
    related.sort((a, b) => text(b, "Idempotency_Key").localeCompare(text(a, "Idempotency_Key")));
    hit = related[0] ?? null;
  }
  if (!hit) return null;
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

function scheduleAnomaly({ enabled, cron, tz, lastFired, lastTask, offline, now }) {
  if (offline) return "node-offline";
  if (lastTask && (lastTask.status === "failed" || lastTask.status === "rejected")) return "failed";
  if (!enabled) return "";
  let parsed;
  try {
    parsed = parseCron(cron);
  } catch {
    return "";
  }
  let due = null;
  try {
    due = latestOccurrence(parsed, new Date(now.getTime() - MISS_MS), tz);
  } catch {
    return "";
  }
  if (!due) return "";
  let dueKey = "";
  try {
    dueKey = minuteKey(formatOccurrenceKey(due, tz));
  } catch {
    return "";
  }
  const fired = minuteKey(lastFired);
  if (!fired || fired < dueKey) return "missed";
  return "";
}

export function listSchedules({ rules = [], tasks = [], cards = [], connected = [], now = new Date(), hubNode = "", hubTz = "" } = {}) {
  const clock = now instanceof Date ? now : new Date(now);
  const schedules = [];
  for (const row of rules) {
    const { node, scheduleId } = splitRule(f1(row, "Rule_ID"), f1(row, "Target_Node"));
    if (!node || !scheduleId) continue;
    const note = String(f1(row, "Note") ?? "");
    const cron = String(f1(row, "Schedule") ?? "");
    const enabled = text(row, "Enabled") === "Yes";
    const lastFired = String(f1(row, "Last_Fired") ?? "");
    const source = note.includes("http-agent 自报") ? "http-agent" : "node";
    let tz = noteTz(note);
    if (!tz && hubNode && node === hubNode && hubTz) tz = String(hubTz);
    if (!tz) tz = DEFAULT_SCHEDULE_TZ;
    let zone = DEFAULT_SCHEDULE_TZ;
    try {
      zone = resolveScheduleTz(tz);
    } catch {
      zone = DEFAULT_SCHEDULE_TZ;
      tz = DEFAULT_SCHEDULE_TZ;
    }
    let nextFire = "";
    try {
      const parsed = parseCron(cron);
      const at = nextOccurrence(parsed, clock, zone);
      nextFire = at ? at.toISOString() : "";
    } catch {
      nextFire = "";
    }
    const lastTask = findLastTask(tasks, node, scheduleId, lastFired, note);
    const offline = nodeIsOffline(node, cards, connected);
    schedules.push({
      rule_id: text(row, "Rule_ID") || `${node}:${scheduleId}`,
      node,
      schedule_id: scheduleId,
      cron,
      tz: zone,
      cap: String(f1(row, "Skill_ID") ?? ""),
      text: String(f1(row, "Text") ?? ""),
      enabled,
      last_fired: lastFired,
      next_fire_at: nextFire,
      source,
      note,
      last_task: lastTask,
      anomaly: scheduleAnomaly({
        enabled,
        cron,
        tz: zone,
        lastFired,
        lastTask,
        offline,
        now: clock,
      }),
    });
  }
  return schedules;
}

function scheduleNote(tz) {
  return tz ? `http-agent 自报；tz=${tz}` : "http-agent 自报";
}

export async function saveHttpAgentSchedule({ bus, node, scheduleId, body, now = new Date() } = {}) {
  if (!bus?.tables?.rules) throw httpError(500, "总线未配置 rules 表");
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "请求体必须是 JSON 对象");
  }
  const name = validateNodeName(node);
  const id = validateScheduleId(scheduleId);
  const cron = String(body.cron ?? "").trim();
  if (!cron) throw httpError(400, "缺少 cron");
  try {
    parseCron(cron);
  } catch (e) {
    throw httpError(400, `cron 表达式非法：${e?.message ?? e}`);
  }
  const rows = await bus.listRecords(bus.tables.rules);
  const ruleId = `${name}:${id}`;
  const existing = rows.find((row) => text(row, "Rule_ID") === ruleId);
  const prevTz = existing ? noteTz(f1(existing, "Note")) : "";
  let tz = prevTz;
  if (Object.hasOwn(body, "tz") && String(body.tz ?? "").trim()) {
    try {
      tz = resolveScheduleTz(body.tz);
    } catch (e) {
      throw httpError(400, `非法时区：${e?.message ?? e}`);
    }
  }
  const hasCap = Object.hasOwn(body, "cap");
  const hasText = Object.hasOwn(body, "text");
  const hasEnabled = Object.hasOwn(body, "enabled");
  if (hasEnabled && typeof body.enabled !== "boolean") throw httpError(400, "enabled 必须是布尔值");
  const fields = {
    Rule_ID: ruleId,
    Target_Node: name,
    Skill_ID: hasCap ? String(body.cap ?? "") : (existing ? String(f1(existing, "Skill_ID") ?? "") : ""),
    Schedule: cron,
    Text: hasText ? String(body.text ?? "") : (existing ? String(f1(existing, "Text") ?? "") : ""),
    Enabled: hasEnabled
      ? (body.enabled ? "Yes" : "No")
      : (existing ? (text(existing, "Enabled") === "Yes" ? "Yes" : "No") : "Yes"),
    Last_Fired: existing ? String(f1(existing, "Last_Fired") ?? "") : "",
    Note: scheduleNote(tz),
  };
  if (existing) await bus.updateRecord(bus.tables.rules, existing.record_id, fields);
  else await bus.createRecord(bus.tables.rules, fields);
  return { ok: true, rule_id: ruleId, at: (now instanceof Date ? now : new Date(now)).toISOString() };
}

export async function removeHttpAgentSchedule({ bus, node, scheduleId } = {}) {
  if (!bus?.tables?.rules) throw httpError(500, "总线未配置 rules 表");
  const name = validateNodeName(node);
  const id = validateScheduleId(scheduleId);
  const ruleId = `${name}:${id}`;
  const rows = await bus.listRecords(bus.tables.rules);
  const existing = rows.find((row) => text(row, "Rule_ID") === ruleId && text(row, "Target_Node") === name);
  if (!existing) throw httpError(404, `计划不存在：${ruleId}`);
  if (typeof bus.deleteRecord !== "function") throw httpError(501, "当前总线不支持删除计划");
  await bus.deleteRecord(bus.tables.rules, existing.record_id);
  return { ok: true };
}
