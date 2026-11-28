// Hub 唯一持久化后端（Node >= 24 内置 node:sqlite + WAL）。
// 把设备、Agent、任务、消息、定时自报、幂等键、水位与文件索引统一在一张 hub.db 中，
// 通过 BEGIN IMMEDIATE 保证状态迁移原子性，并在顶层事务提交后才通知外部监听器。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_TIMEZONE } from "../core/cron.mjs";
import { FILE_ID_RE, extractHubFileId } from "./files.mjs";

export function hashToken(raw) {
  return crypto.createHash("sha256").update(String(raw ?? ""), "utf8").digest("hex");
}

export function tokenPrefix(raw) {
  const s = String(raw ?? "");
  if (!s) return "";
  return s.length <= 12 ? s : `${s.slice(0, 12)}...`;
}

export function generateToken(prefix = "ah_tok_") {
  return `${prefix}${crypto.randomBytes(24).toString("base64url")}`;
}

export function randomId(prefix = "") {
  const hex = crypto.randomBytes(12).toString("hex");
  return prefix ? `${prefix}_${hex}` : hex;
}

function sqlBool(v) {
  return v ? 1 : 0;
}

function sqlStr(v) {
  return v === undefined || v === null ? null : String(v);
}

function sqlInt(v, fallback = 0) {
  if (v === undefined || v === null || v === "") return fallback;
  const num = Number(v);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

function parseJson(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function deepValuesEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepValuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object") {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, k) || !deepValuesEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

export function maskSecret(raw) {
  const s = String(raw ?? "");
  if (!s) return "";
  if (s.length <= 6) return "******";
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  platform          TEXT NOT NULL DEFAULT '',
  os_info           TEXT NOT NULL DEFAULT '',
  transport         TEXT NOT NULL DEFAULT 'longpoll',
  poll_interval_min INTEGER NOT NULL DEFAULT 5,
  max_concurrent    INTEGER NOT NULL DEFAULT 4,
  summary           TEXT NOT NULL DEFAULT '',
  note              TEXT NOT NULL DEFAULT '',
  token_hash        TEXT,
  token_prefix      TEXT NOT NULL DEFAULT '',
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_seen_at      INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  device_id         TEXT REFERENCES devices(id) ON DELETE CASCADE,
  worker_key        TEXT NOT NULL DEFAULT '',
  name              TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'worker',
  platform          TEXT NOT NULL DEFAULT 'generic',
  summary           TEXT NOT NULL DEFAULT '',
  note              TEXT NOT NULL DEFAULT '',
  skills_json       TEXT NOT NULL DEFAULT '[]',
  tools_json        TEXT NOT NULL DEFAULT '[]',
  models_json       TEXT NOT NULL DEFAULT '[]',
  default_model     TEXT NOT NULL DEFAULT '',
  approval_policy   TEXT NOT NULL DEFAULT 'never',
  transport         TEXT NOT NULL DEFAULT 'poll',
  poll_interval_min INTEGER NOT NULL DEFAULT 5,
  webhook_url       TEXT NOT NULL DEFAULT '',
  webhook_secret    TEXT NOT NULL DEFAULT '',
  webhook_header    TEXT NOT NULL DEFAULT 'X-A2A-Signature',
  token_hash        TEXT,
  token_prefix      TEXT NOT NULL DEFAULT '',
  scopes_json       TEXT NOT NULL DEFAULT '[]',
  metadata_json     TEXT NOT NULL DEFAULT '{}',
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_seen_at      INTEGER,
  active_task_id    TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  context_id        TEXT NOT NULL,
  parent_task_id    TEXT,
  from_node         TEXT NOT NULL,
  to_agent_id       TEXT NOT NULL,
  title             TEXT NOT NULL DEFAULT '',
  input_text        TEXT NOT NULL DEFAULT '',
  params_json       TEXT NOT NULL DEFAULT '{}',
  attachments_json  TEXT NOT NULL DEFAULT '[]',
  model             TEXT NOT NULL DEFAULT '',
  state             TEXT NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 5,
  source            TEXT NOT NULL DEFAULT 'direct',
  schedule_id       TEXT,
  progress_json     TEXT NOT NULL DEFAULT '{}',
  receipt_json      TEXT,
  error_message     TEXT,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  max_retries       INTEGER NOT NULL DEFAULT 2,
  timeout_sec       INTEGER NOT NULL DEFAULT 600,
  claimed_by        TEXT,
  claimed_at        INTEGER,
  lease_until       INTEGER,
  leader_notified   INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  completed_at      INTEGER,
  resolved_at       INTEGER,
  changed_seq       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  context_id        TEXT NOT NULL,
  from_node         TEXT NOT NULL,
  kind              TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',
  data_json         TEXT NOT NULL DEFAULT '{}',
  attachments_json  TEXT NOT NULL DEFAULT '[]',
  signature         TEXT,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  id                  TEXT NOT NULL,
  agent_id            TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  driver              TEXT NOT NULL DEFAULT 'edge',
  cron_expr           TEXT NOT NULL DEFAULT '',
  interval_min        INTEGER NOT NULL DEFAULT 60,
  timezone            TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  grace_sec           INTEGER,
  summary             TEXT NOT NULL DEFAULT '',
  task_template_json  TEXT NOT NULL DEFAULT '{}',
  context_mode        TEXT NOT NULL DEFAULT 'per_run',
  pinned_context_id   TEXT,
  overlap_policy      TEXT NOT NULL DEFAULT 'skip',
  misfire_policy      TEXT NOT NULL DEFAULT 'fire_once',
  triggerable         INTEGER NOT NULL DEFAULT 0,
  next_run_at         INTEGER,
  last_tick_at        INTEGER,
  last_run_at         INTEGER,
  last_duration_ms    INTEGER,
  last_outcome        TEXT,
  last_task_id        TEXT,
  alerted_missed_at   INTEGER,
  recent_ticks_json   TEXT NOT NULL DEFAULT '[]',
  enabled             INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER,
  updated_at          INTEGER,
  PRIMARY KEY (agent_id, id)
);

CREATE TABLE IF NOT EXISTS idempotency (
  scope             TEXT NOT NULL,
  token_key         TEXT NOT NULL,
  result_json       TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (scope, token_key)
);

CREATE TABLE IF NOT EXISTS watermarks (
  actor_id          TEXT PRIMARY KEY,
  last_seq          INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  mime              TEXT NOT NULL,
  size              INTEGER NOT NULL,
  sha256            TEXT NOT NULL,
  owner_node        TEXT NOT NULL DEFAULT '',
  task_id           TEXT,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS file_links (
  file_id           TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  context_id        TEXT NOT NULL,
  message_id        INTEGER,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (file_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(token_hash);
CREATE INDEX IF NOT EXISTS idx_agents_device ON agents(device_id);
CREATE INDEX IF NOT EXISTS idx_agents_token ON agents(token_hash);
CREATE INDEX IF NOT EXISTS idx_tasks_to_state ON tasks(to_agent_id, state, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_tasks_context ON tasks(context_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_tasks_from_seq ON tasks(from_node, changed_seq);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state, lease_until);
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, id ASC);
CREATE INDEX IF NOT EXISTS idx_messages_ctx ON messages(context_id, id ASC);
CREATE INDEX IF NOT EXISTS idx_files_expires ON files(expires_at);
CREATE INDEX IF NOT EXISTS idx_files_task ON files(task_id);
CREATE INDEX IF NOT EXISTS idx_file_links_file ON file_links(file_id);
CREATE INDEX IF NOT EXISTS idx_file_links_task ON file_links(task_id);
CREATE INDEX IF NOT EXISTS idx_file_links_context ON file_links(context_id);
CREATE INDEX IF NOT EXISTS idx_tasks_schedule ON tasks(to_agent_id, schedule_id, created_at DESC);
`;

export function serializeDevice(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    os_info: row.os_info,
    transport: row.transport,
    poll_interval_min: Number(row.poll_interval_min ?? 5),
    max_concurrent: Number(row.max_concurrent ?? 4),
    summary: row.summary,
    note: row.note,
    has_token: Boolean(row.token_hash),
    token_prefix: row.token_prefix || "",
    enabled: Boolean(row.enabled),
    last_seen_at: row.last_seen_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...extra,
  };
}

export function serializeAgent(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    device_id: row.device_id ?? null,
    worker_key: row.worker_key || "",
    name: row.name,
    role: row.role,
    platform: row.platform,
    summary: row.summary,
    note: row.note,
    skills: parseJson(row.skills_json, []),
    tools: parseJson(row.tools_json, []),
    models: parseJson(row.models_json, []),
    default_model: row.default_model || "",
    approval_policy: row.approval_policy || "never",
    transport: row.transport || "poll",
    poll_interval_min: Number(row.poll_interval_min ?? 5),
    webhook_url: row.webhook_url || "",
    webhook_header: row.webhook_header || "X-A2A-Signature",
    webhook_has_secret: Boolean(row.webhook_secret),
    webhook_secret_masked: row.webhook_secret ? maskSecret(row.webhook_secret) : "",
    has_token: Boolean(row.token_hash),
    token_prefix: row.token_prefix || "",
    scopes: parseJson(row.scopes_json, []),
    metadata: parseJson(row.metadata_json, {}),
    enabled: Boolean(row.enabled),
    last_seen_at: row.last_seen_at ?? null,
    active_task_id: row.active_task_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...extra,
  };
}

export function serializeTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    context_id: row.context_id,
    parent_task_id: row.parent_task_id ?? null,
    from_node: row.from_node,
    to_agent_id: row.to_agent_id,
    title: row.title || "",
    input_text: row.input_text || "",
    params: parseJson(row.params_json, {}),
    attachments: parseJson(row.attachments_json, []),
    model: row.model || "",
    state: row.state,
    priority: Number(row.priority ?? 5),
    source: row.source || "direct",
    schedule_id: row.schedule_id ?? null,
    progress: parseJson(row.progress_json, {}),
    receipt: row.receipt_json ? parseJson(row.receipt_json, null) : null,
    error_message: row.error_message ?? null,
    retry_count: Number(row.retry_count ?? 0),
    max_retries: Number(row.max_retries ?? 2),
    timeout_sec: Number(row.timeout_sec ?? 600),
    claimed_by: row.claimed_by ?? null,
    claimed_at: row.claimed_at ?? null,
    lease_until: row.lease_until ?? null,
    leader_notified: Boolean(row.leader_notified),
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at ?? null,
    resolved_at: row.resolved_at ?? null,
    changed_seq: Number(row.changed_seq ?? 0),
  };
}

export function serializeTaskSummary(row) {
  if (!row) return null;
  const hasReceipt = Boolean(row.has_receipt ?? row.receipt_json);
  let receipt = null;
  if (hasReceipt) {
    const summary = row.receipt_summary !== undefined
      ? String(row.receipt_summary || "")
      : String(parseJson(row.receipt_json, null)?.summary || "");
    receipt = { summary };
  }
  const inputAttCount = row.input_attachment_count !== undefined
    ? Number(row.input_attachment_count || 0)
    : (() => {
        const list = parseJson(row.attachments_json, null);
        return Array.isArray(list) ? list.length : 0;
      })();
  const receiptAttCount = row.receipt_attachment_count !== undefined
    ? Number(row.receipt_attachment_count || 0)
    : (() => {
        const rObj = parseJson(row.receipt_json, null);
        return Array.isArray(rObj?.attachments) ? rObj.attachments.length : 0;
      })();
  return {
    id: row.id,
    context_id: row.context_id,
    parent_task_id: row.parent_task_id ?? null,
    from_node: row.from_node,
    to_agent_id: row.to_agent_id,
    title: row.title || "",
    model: row.model || "",
    state: row.state,
    priority: Number(row.priority ?? 5),
    source: row.source || "direct",
    schedule_id: row.schedule_id ?? null,
    attachment_count: inputAttCount + receiptAttCount,
    receipt,
    error_message: row.error_message ?? null,
    retry_count: Number(row.retry_count ?? 0),
    max_retries: Number(row.max_retries ?? 2),
    timeout_sec: Number(row.timeout_sec ?? 600),
    claimed_by: row.claimed_by ?? null,
    claimed_at: row.claimed_at ?? null,
    lease_until: row.lease_until ?? null,
    leader_notified: Boolean(row.leader_notified),
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at ?? null,
    resolved_at: row.resolved_at ?? null,
    changed_seq: Number(row.changed_seq ?? 0),
  };
}

export function serializeMessage(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    task_id: row.task_id,
    context_id: row.context_id,
    from_node: row.from_node,
    kind: row.kind,
    body: row.body || "",
    data: parseJson(row.data_json, {}),
    attachments: parseJson(row.attachments_json, []),
    signature: row.signature ?? null,
    created_at: row.created_at,
  };
}

export function serializeSchedule(row) {
  if (!row) return null;
  const driver = row.driver === "hub" ? "hub" : "edge";
  return {
    id: row.id,
    agent_id: row.agent_id,
    name: row.name,
    driver,
    cron_expr: row.cron_expr || "",
    interval_min: Number(row.interval_min ?? 60),
    timezone: row.timezone || DEFAULT_TIMEZONE,
    grace_sec: row.grace_sec !== null && row.grace_sec !== undefined ? Number(row.grace_sec) : null,
    summary: row.summary || "",
    task_template: parseJson(row.task_template_json, {}),
    context_mode: row.context_mode === "rolling" ? "rolling" : "per_run",
    pinned_context_id: row.pinned_context_id || null,
    overlap_policy: row.overlap_policy === "allow" ? "allow" : "skip",
    misfire_policy: row.misfire_policy === "skip" ? "skip" : "fire_once",
    triggerable: row.triggerable === undefined || row.triggerable === null ? driver === "hub" : Boolean(row.triggerable),
    next_run_at: row.next_run_at ?? null,
    last_tick_at: row.last_tick_at ?? null,
    last_run_at: row.last_run_at ?? null,
    last_duration_ms: row.last_duration_ms !== null && row.last_duration_ms !== undefined ? Number(row.last_duration_ms) : null,
    last_outcome: row.last_outcome || null,
    last_task_id: row.last_task_id ?? null,
    alerted_missed_at: row.alerted_missed_at ?? null,
    recent_ticks: parseJson(row.recent_ticks_json, []),
    enabled: Boolean(row.enabled),
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

const SCHEDULE_MIGRATION_COLUMNS = [
  ["driver", "TEXT NOT NULL DEFAULT 'edge'"],
  ["timezone", "TEXT NOT NULL DEFAULT 'Asia/Shanghai'"],
  ["grace_sec", "INTEGER"],
  ["task_template_json", "TEXT NOT NULL DEFAULT '{}'"],
  ["context_mode", "TEXT NOT NULL DEFAULT 'per_run'"],
  ["pinned_context_id", "TEXT"],
  ["overlap_policy", "TEXT NOT NULL DEFAULT 'skip'"],
  ["misfire_policy", "TEXT NOT NULL DEFAULT 'fire_once'"],
  ["triggerable", "INTEGER NOT NULL DEFAULT 0"],
  ["next_run_at", "INTEGER"],
  ["last_tick_at", "INTEGER"],
  ["last_duration_ms", "INTEGER"],
  ["last_outcome", "TEXT"],
  ["alerted_missed_at", "INTEGER"],
  ["recent_ticks_json", "TEXT NOT NULL DEFAULT '[]'"],
  ["created_at", "INTEGER"],
  ["updated_at", "INTEGER"],
];

export class HubStore {
  constructor(dbPath, { changeHook = null } = {}) {
    this.dbPath = dbPath;
    this.changeHook = changeHook;
    this._inTx = false;
    this._pendingNotifies = [];
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_size_limit = 16777216;");
    this.db.exec(SCHEMA_SQL);
    this.migrateTasksSchema();
    this.migrateSchedulesSchema();
    this.backfillFileLinks();
    if (dbPath !== ":memory:") {
      try {
        fs.chmodSync(dbPath, 0o600);
      } catch {}
    }
  }

  migrateTasksSchema() {
    const cols = new Set(
      this.db.prepare("PRAGMA table_info(tasks)").all().map((c) => String(c.name))
    );
    if (!cols.has("resolved_at")) {
      const now = Date.now();
      const cutoff24h = now - 24 * 3600 * 1000;
      this.db.exec("ALTER TABLE tasks ADD COLUMN resolved_at INTEGER");
      // 老库首次升级平滑回填：24 小时以前的陈年历史失败自动标为已处理，
      // 避免升级后线程页挂满旧红标，同时保留近 24 小时内的故障以便机主处置。
      this.db.prepare(`
        UPDATE tasks
        SET resolved_at = ?
        WHERE state IN ('failed', 'rejected') AND resolved_at IS NULL AND updated_at < ?
      `).run(now, cutoff24h);
    }
  }

  migrateSchedulesSchema() {
    const cols = new Set(
      this.db.prepare("PRAGMA table_info(schedules)").all().map((c) => String(c.name))
    );
    for (const [colName, colDef] of SCHEDULE_MIGRATION_COLUMNS) {
      if (!cols.has(colName)) {
        this.db.exec(`ALTER TABLE schedules ADD COLUMN ${colName} ${colDef}`);
      }
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_schedules_driver_next ON schedules(driver, enabled, next_run_at)"
    );
  }

  checkpointWal(mode = "PASSIVE") {
    const safeMode = ["PASSIVE", "FULL", "RESTART", "TRUNCATE"].includes(String(mode || "").toUpperCase())
      ? String(mode).toUpperCase()
      : "PASSIVE";
    this.db.exec(`PRAGMA wal_checkpoint(${safeMode});`);
  }

  pruneIdempotency(maxAgeMs = 7 * 24 * 3600 * 1000, now = Date.now()) {
    const cutoff = now - Math.max(Number(maxAgeMs || 0), 60_000);
    const res = this.db.prepare("DELETE FROM idempotency WHERE created_at < ?").run(cutoff);
    return res.changes;
  }

  close() {
    try {
      this.checkpointWal("TRUNCATE");
    } catch {}
    this.db.close();
  }

  setChangeHook(hook) {
    this.changeHook = hook;
  }

  // 所有核心写操作共用唯一串行事务封装，且变更事件仅在顶层 COMMIT 成功后才分发。
  transaction(fn) {
    if (this._inTx) return fn();
    this._inTx = true;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      this._inTx = false;
      this._flushNotifies();
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      this._pendingNotifies.length = 0;
      this._inTx = false;
      throw err;
    }
  }

  emitChange(event) {
    if (!event) return;
    if (this._inTx) {
      this._pendingNotifies.push(event);
      return;
    }
    if (typeof this.changeHook === "function") {
      try {
        this.changeHook(event);
      } catch {}
    }
  }

  _flushNotifies() {
    if (!this._pendingNotifies.length) return;
    const events = this._pendingNotifies.splice(0, this._pendingNotifies.length);
    if (typeof this.changeHook !== "function") return;
    for (const ev of events) {
      try {
        this.changeHook(ev);
      } catch {}
    }
  }

  // ---- Meta & 单调序号 ----

  getMeta(key, defaultValue = null) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(String(key));
    return row ? row.value : defaultValue;
  }

  setMeta(key, value) {
    this.db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(String(key), String(value));
  }

  currentSeq() {
    const raw = this.getMeta("seq", "0");
    return Number(raw) || 0;
  }

  nextSeq() {
    const row = this.db.prepare(`
      INSERT INTO meta (key, value) VALUES ('seq', '1')
      ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
      RETURNING CAST(value AS INTEGER) AS seq
    `).get();
    return Number(row.seq);
  }

  // ---- Auth Lookup & Touch ----

  authenticateToken(rawToken) {
    const token = String(rawToken || "").trim();
    if (!token) return null;
    const digest = hashToken(token);
    const dev = this.db.prepare("SELECT * FROM devices WHERE token_hash = ? LIMIT 1").get(digest);
    if (dev) {
      return { actorType: "device", device: serializeDevice(dev) };
    }
    const ag = this.db.prepare("SELECT * FROM agents WHERE token_hash = ? LIMIT 1").get(digest);
    if (ag) {
      return { actorType: "agent", agent: serializeAgent(ag) };
    }
    return null;
  }

  touchDeviceSeen(deviceId, ts = Date.now(), minIntervalMs = 10_000) {
    const row = this.db.prepare("SELECT last_seen_at FROM devices WHERE id = ?").get(String(deviceId));
    if (!row) return;
    if (row.last_seen_at && ts - Number(row.last_seen_at) < minIntervalMs) return;
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(sqlInt(ts), String(deviceId));
  }

  touchAgentSeen(agentId, ts = Date.now(), minIntervalMs = 10_000) {
    const row = this.db.prepare("SELECT last_seen_at FROM agents WHERE id = ?").get(String(agentId));
    if (!row) return;
    if (row.last_seen_at && ts - Number(row.last_seen_at) < minIntervalMs) return;
    this.db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(sqlInt(ts), String(agentId));
  }

  // ---- Devices ----

  upsertDevice(input) {
    return this.transaction(() => {
      const now = Date.now();
      const id = String(input.id).trim();
      const existing = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id);
      let plainToken = null;
      let tokenHash = existing?.token_hash ?? null;
      let tPrefix = existing?.token_prefix ?? "";
      if (input.issueToken || (!existing && input.issueToken !== false && !tokenHash)) {
        plainToken = generateToken("ah_dev_");
        tokenHash = hashToken(plainToken);
        tPrefix = tokenPrefix(plainToken);
      }
      if (existing) {
        this.db.prepare(`
          UPDATE devices SET
            name = ?, platform = ?, os_info = ?, transport = ?,
            poll_interval_min = ?, max_concurrent = ?, summary = ?, note = ?,
            token_hash = ?, token_prefix = ?, enabled = ?, updated_at = ?
          WHERE id = ?
        `).run(
          sqlStr(input.name ?? existing.name),
          sqlStr(input.platform ?? existing.platform),
          sqlStr(input.os_info ?? existing.os_info),
          sqlStr(input.transport ?? existing.transport),
          sqlInt(input.poll_interval_min ?? existing.poll_interval_min, 5),
          sqlInt(input.max_concurrent ?? existing.max_concurrent, 4),
          sqlStr(input.summary ?? existing.summary),
          sqlStr(input.note ?? existing.note),
          sqlStr(tokenHash),
          sqlStr(tPrefix),
          sqlBool(input.enabled !== undefined ? input.enabled : existing.enabled),
          now,
          id
        );
      } else {
        this.db.prepare(`
          INSERT INTO devices (
            id, name, platform, os_info, transport, poll_interval_min, max_concurrent,
            summary, note, token_hash, token_prefix, enabled, last_seen_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          sqlStr(input.name || id),
          sqlStr(input.platform || ""),
          sqlStr(input.os_info || ""),
          sqlStr(input.transport || "longpoll"),
          sqlInt(input.poll_interval_min, 5),
          sqlInt(input.max_concurrent, 4),
          sqlStr(input.summary || ""),
          sqlStr(input.note || ""),
          sqlStr(tokenHash),
          sqlStr(tPrefix),
          sqlBool(input.enabled !== undefined ? input.enabled : true),
          null,
          now,
          now
        );
      }
      const seq = this.nextSeq();
      const device = this.getDevice(id);
      this.emitChange({ type: "device.updated", seq, deviceId: id });
      return { device, ...(plainToken ? { token: plainToken } : {}) };
    });
  }

  getDevice(id) {
    const row = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(String(id));
    return serializeDevice(row);
  }

  listDevices() {
    const rows = this.db.prepare("SELECT * FROM devices ORDER BY created_at ASC").all();
    return rows.map((r) => serializeDevice(r));
  }

  updateDevice(id, patch) {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(String(id));
      if (!existing) return null;
      const now = Date.now();
      this.db.prepare(`
        UPDATE devices SET
          name = ?, platform = ?, os_info = ?, transport = ?,
          poll_interval_min = ?, max_concurrent = ?, summary = ?, note = ?,
          enabled = ?, updated_at = ?
        WHERE id = ?
      `).run(
        sqlStr(patch.name !== undefined ? patch.name : existing.name),
        sqlStr(patch.platform !== undefined ? patch.platform : existing.platform),
        sqlStr(patch.os_info !== undefined ? patch.os_info : existing.os_info),
        sqlStr(patch.transport !== undefined ? patch.transport : existing.transport),
        sqlInt(patch.poll_interval_min !== undefined ? patch.poll_interval_min : existing.poll_interval_min, 5),
        sqlInt(patch.max_concurrent !== undefined ? patch.max_concurrent : existing.max_concurrent, 4),
        sqlStr(patch.summary !== undefined ? patch.summary : existing.summary),
        sqlStr(patch.note !== undefined ? patch.note : existing.note),
        sqlBool(patch.enabled !== undefined ? patch.enabled : existing.enabled),
        now,
        String(id)
      );
      const seq = this.nextSeq();
      this.emitChange({ type: "device.updated", seq, deviceId: String(id) });
      return this.getDevice(id);
    });
  }

  rotateDeviceToken(id) {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(String(id));
      if (!existing) return null;
      const plainToken = generateToken("ah_dev_");
      const now = Date.now();
      this.db.prepare("UPDATE devices SET token_hash = ?, token_prefix = ?, updated_at = ? WHERE id = ?")
        .run(hashToken(plainToken), tokenPrefix(plainToken), now, String(id));
      return { device: this.getDevice(id), token: plainToken };
    });
  }

  deleteDevice(id) {
    return this.transaction(() => {
      const res = this.db.prepare("DELETE FROM devices WHERE id = ?").run(String(id));
      if (res.changes > 0) {
        const seq = this.nextSeq();
        this.emitChange({ type: "device.deleted", seq, deviceId: String(id) });
        return true;
      }
      return false;
    });
  }

  // ---- Agents ----

  createAgent(input) {
    return this.transaction(() => {
      const now = Date.now();
      const id = String(input.id).trim();
      const existing = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
      if (existing) {
        const err = new Error(`Agent 已存在: ${id}`);
        err.statusCode = 409;
        throw err;
      }
      let plainToken = null;
      let tokenHash = null;
      let tPrefix = "";
      if (input.issueToken !== false && input.kind !== "device-worker") {
        plainToken = generateToken("ah_ag_");
        tokenHash = hashToken(plainToken);
        tPrefix = tokenPrefix(plainToken);
      }
      this.db.prepare(`
        INSERT INTO agents (
          id, kind, device_id, worker_key, name, role, platform, summary, note,
          skills_json, tools_json, models_json, default_model, approval_policy,
          transport, poll_interval_min, webhook_url, webhook_secret, webhook_header,
          token_hash, token_prefix, scopes_json, metadata_json, enabled,
          last_seen_at, active_task_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        sqlStr(input.kind || "cloud"),
        sqlStr(input.device_id ?? null),
        sqlStr(input.worker_key || ""),
        sqlStr(input.name || id),
        sqlStr(input.role || "worker"),
        sqlStr(input.platform || "generic"),
        sqlStr(input.summary || ""),
        sqlStr(input.note || ""),
        JSON.stringify(Array.isArray(input.skills) ? input.skills : []),
        JSON.stringify(Array.isArray(input.tools) ? input.tools : []),
        JSON.stringify(Array.isArray(input.models) ? input.models : []),
        sqlStr(input.default_model || ""),
        sqlStr(input.approval_policy || "never"),
        sqlStr(input.transport || "poll"),
        sqlInt(input.poll_interval_min, 5),
        sqlStr(input.webhook_url || ""),
        sqlStr(input.webhook_secret || ""),
        sqlStr(input.webhook_header || "X-A2A-Signature"),
        sqlStr(tokenHash),
        sqlStr(tPrefix),
        JSON.stringify(Array.isArray(input.scopes) ? input.scopes : []),
        JSON.stringify(input.metadata && typeof input.metadata === "object" ? input.metadata : {}),
        sqlBool(input.enabled !== undefined ? input.enabled : true),
        null,
        null,
        now,
        now
      );
      const seq = this.nextSeq();
      this.emitChange({ type: "agent.updated", seq, agentId: id, deviceId: input.device_id ?? null });
      return { agent: this.getAgent(id), ...(plainToken ? { token: plainToken } : {}) };
    });
  }

  getAgent(id) {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(String(id));
    return serializeAgent(row);
  }

  getAgentWebhookSecret(id) {
    const row = this.db.prepare("SELECT webhook_url, webhook_secret, webhook_header FROM agents WHERE id = ?").get(String(id));
    if (!row) return null;
    return {
      url: row.webhook_url || "",
      secret: row.webhook_secret || "",
      header: row.webhook_header || "X-A2A-Signature",
    };
  }

  listAgents(filter = {}) {
    const clauses = [];
    const args = [];
    if (filter.kind) {
      clauses.push("kind = ?");
      args.push(String(filter.kind));
    }
    if (filter.device_id) {
      clauses.push("device_id = ?");
      args.push(String(filter.device_id));
    }
    if (filter.role) {
      clauses.push("role = ?");
      args.push(String(filter.role));
    }
    if (filter.enabled !== undefined) {
      clauses.push("enabled = ?");
      args.push(sqlBool(filter.enabled));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM agents ${where} ORDER BY created_at ASC`).all(...args);
    return rows.map((r) => serializeAgent(r));
  }

  updateAgent(id, patch) {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(String(id));
      if (!existing) return null;

      const nextName = sqlStr(patch.name !== undefined ? patch.name : existing.name);
      const nextRole = sqlStr(patch.role !== undefined ? patch.role : existing.role);
      const nextPlatform = sqlStr(patch.platform !== undefined ? patch.platform : existing.platform);
      const nextSummary = sqlStr(patch.summary !== undefined ? patch.summary : existing.summary);
      const nextNote = sqlStr(patch.note !== undefined ? patch.note : existing.note);
      const nextSkillsVal = patch.skills !== undefined ? patch.skills : parseJson(existing.skills_json, []);
      const nextToolsVal = patch.tools !== undefined ? patch.tools : parseJson(existing.tools_json, []);
      const nextModelsVal = patch.models !== undefined ? patch.models : parseJson(existing.models_json, []);
      const nextDefaultModel = sqlStr(patch.default_model !== undefined ? patch.default_model : existing.default_model);
      const nextApprovalPolicy = sqlStr(patch.approval_policy !== undefined ? patch.approval_policy : existing.approval_policy);
      const nextTransport = sqlStr(patch.transport !== undefined ? patch.transport : existing.transport);
      const nextPollInterval = sqlInt(patch.poll_interval_min !== undefined ? patch.poll_interval_min : existing.poll_interval_min, 5);
      const nextWebhookUrl = sqlStr(patch.webhook_url !== undefined ? patch.webhook_url : existing.webhook_url);
      const nextWebhookSecret = sqlStr(patch.webhook_secret !== undefined ? patch.webhook_secret : existing.webhook_secret);
      const nextWebhookHeader = sqlStr(patch.webhook_header !== undefined ? patch.webhook_header : existing.webhook_header);
      const nextScopesVal = patch.scopes !== undefined ? patch.scopes : parseJson(existing.scopes_json, []);
      const nextMetadataVal = patch.metadata !== undefined ? patch.metadata : parseJson(existing.metadata_json, {});
      const nextEnabled = sqlBool(patch.enabled !== undefined ? patch.enabled : existing.enabled);
      const nextActiveTaskId = patch.active_task_id !== undefined ? sqlStr(patch.active_task_id) : existing.active_task_id;

      // 名片字段完全未变化时不自增 seq，防止 Agent 重连或定时 register 唤醒全部前端拉取 /state。
      const changed =
        nextName !== existing.name ||
        nextRole !== existing.role ||
        nextPlatform !== existing.platform ||
        nextSummary !== existing.summary ||
        nextNote !== existing.note ||
        !deepValuesEqual(nextSkillsVal, parseJson(existing.skills_json, [])) ||
        !deepValuesEqual(nextToolsVal, parseJson(existing.tools_json, [])) ||
        !deepValuesEqual(nextModelsVal, parseJson(existing.models_json, [])) ||
        nextDefaultModel !== existing.default_model ||
        nextApprovalPolicy !== existing.approval_policy ||
        nextTransport !== existing.transport ||
        nextPollInterval !== Number(existing.poll_interval_min ?? 5) ||
        nextWebhookUrl !== existing.webhook_url ||
        nextWebhookSecret !== existing.webhook_secret ||
        nextWebhookHeader !== existing.webhook_header ||
        !deepValuesEqual(nextScopesVal, parseJson(existing.scopes_json, [])) ||
        !deepValuesEqual(nextMetadataVal, parseJson(existing.metadata_json, {})) ||
        nextEnabled !== Number(existing.enabled) ||
        nextActiveTaskId !== (existing.active_task_id ?? null);

      if (!changed) {
        return serializeAgent(existing);
      }

      const now = Date.now();
      this.db.prepare(`
        UPDATE agents SET
          name = ?, role = ?, platform = ?, summary = ?, note = ?,
          skills_json = ?, tools_json = ?, models_json = ?, default_model = ?,
          approval_policy = ?, transport = ?, poll_interval_min = ?,
          webhook_url = ?, webhook_secret = ?, webhook_header = ?,
          scopes_json = ?, metadata_json = ?, enabled = ?,
          active_task_id = ?, updated_at = ?
        WHERE id = ?
      `).run(
        nextName,
        nextRole,
        nextPlatform,
        nextSummary,
        nextNote,
        JSON.stringify(nextSkillsVal),
        JSON.stringify(nextToolsVal),
        JSON.stringify(nextModelsVal),
        nextDefaultModel,
        nextApprovalPolicy,
        nextTransport,
        nextPollInterval,
        nextWebhookUrl,
        nextWebhookSecret,
        nextWebhookHeader,
        JSON.stringify(nextScopesVal),
        JSON.stringify(nextMetadataVal),
        nextEnabled,
        nextActiveTaskId,
        now,
        String(id)
      );
      const seq = this.nextSeq();
      this.emitChange({ type: "agent.updated", seq, agentId: String(id), deviceId: existing.device_id });
      return this.getAgent(id);
    });
  }

  rotateAgentToken(id) {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(String(id));
      if (!existing) return null;
      const plainToken = generateToken("ah_ag_");
      const now = Date.now();
      this.db.prepare("UPDATE agents SET token_hash = ?, token_prefix = ?, updated_at = ? WHERE id = ?")
        .run(hashToken(plainToken), tokenPrefix(plainToken), now, String(id));
      return { agent: this.getAgent(id), token: plainToken };
    });
  }

  deleteAgent(id) {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT device_id FROM agents WHERE id = ?").get(String(id));
      if (!existing) return false;
      this.db.prepare("DELETE FROM agents WHERE id = ?").run(String(id));
      const seq = this.nextSeq();
      this.emitChange({ type: "agent.deleted", seq, agentId: String(id), deviceId: existing.device_id });
      return true;
    });
  }

  // 设备上线/心跳时同步本地 workers.json；保留机主在面板自定义的 note 与启停状态。
  syncDeviceWorkers(deviceId, workers = [], deviceMeta = {}) {
    return this.transaction(() => {
      const dev = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(String(deviceId));
      if (!dev) return null;
      const now = Date.now();
      const wasOffline = !dev.last_seen_at || now - Number(dev.last_seen_at) > 5 * 60_000;

      const nextPlatform = sqlStr(deviceMeta.platform ?? dev.platform);
      const nextOsInfo = sqlStr(deviceMeta.os_info ?? dev.os_info);
      const nextTransport = sqlStr(deviceMeta.transport ?? dev.transport ?? "longpoll");
      const nextMaxConcurrent = sqlInt(deviceMeta.max_concurrent ?? dev.max_concurrent, 4);
      const devMetaChanged =
        nextPlatform !== dev.platform ||
        nextOsInfo !== dev.os_info ||
        nextTransport !== dev.transport ||
        nextMaxConcurrent !== Number(dev.max_concurrent ?? 4);

      if (devMetaChanged) {
        this.db.prepare(`
          UPDATE devices SET
            platform = ?, os_info = ?, transport = ?, max_concurrent = ?, last_seen_at = ?, updated_at = ?
          WHERE id = ?
        `).run(nextPlatform, nextOsInfo, nextTransport, nextMaxConcurrent, now, now, String(deviceId));
      } else if (!dev.last_seen_at || now - Number(dev.last_seen_at) >= 10_000) {
        this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, String(deviceId));
      }

      const existingRows = this.db.prepare("SELECT * FROM agents WHERE device_id = ? AND kind = 'device-worker'").all(String(deviceId));
      const byWorkerKey = new Map(existingRows.map((r) => [r.worker_key, r]));
      const keepIds = new Set();
      let workersChanged = false;

      for (const w of workers) {
        const key = String(w.key || "").trim();
        if (!key) continue;
        const agentId = `${deviceId}--${key}`;
        keepIds.add(agentId);
        const prev = byWorkerKey.get(key) || this.db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
        const skills = Array.isArray(w.skills) ? w.skills : [];
        const tools = Array.isArray(w.tools) ? w.tools : [];
        const models = Array.isArray(w.models) ? w.models : [];
        const meta = w.metadata && typeof w.metadata === "object" ? w.metadata : {};
        if (prev) {
          const wName = sqlStr(w.name || prev.name || key);
          const wRole = sqlStr(w.role || prev.role || "worker");
          const wPlatform = sqlStr(w.platform || prev.platform || "cli");
          const wSummary = sqlStr(w.summary !== undefined ? w.summary : prev.summary);
          const wDefaultModel = sqlStr(w.default_model ?? prev.default_model ?? "");
          const wApproval = sqlStr(w.approval_policy || prev.approval_policy || "never");
          const rowChanged =
            wName !== prev.name ||
            wRole !== prev.role ||
            wPlatform !== prev.platform ||
            wSummary !== prev.summary ||
            !deepValuesEqual(skills, parseJson(prev.skills_json, [])) ||
            !deepValuesEqual(tools, parseJson(prev.tools_json, [])) ||
            !deepValuesEqual(models, parseJson(prev.models_json, [])) ||
            wDefaultModel !== prev.default_model ||
            wApproval !== prev.approval_policy ||
            nextTransport !== prev.transport ||
            !deepValuesEqual(meta, parseJson(prev.metadata_json, {}));

          if (rowChanged) {
            workersChanged = true;
            this.db.prepare(`
              UPDATE agents SET
                name = ?, role = ?, platform = ?, summary = ?,
                skills_json = ?, tools_json = ?, models_json = ?, default_model = ?,
                approval_policy = ?, transport = ?, metadata_json = ?, last_seen_at = ?, updated_at = ?
              WHERE id = ?
            `).run(
              wName,
              wRole,
              wPlatform,
              wSummary,
              JSON.stringify(skills),
              JSON.stringify(tools),
              JSON.stringify(models),
              wDefaultModel,
              wApproval,
              nextTransport,
              JSON.stringify(meta),
              now,
              now,
              prev.id
            );
          } else if (!prev.last_seen_at || now - Number(prev.last_seen_at) >= 10_000) {
            this.db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(now, prev.id);
          }
        } else {
          workersChanged = true;
          this.db.prepare(`
            INSERT INTO agents (
              id, kind, device_id, worker_key, name, role, platform, summary, note,
              skills_json, tools_json, models_json, default_model, approval_policy,
              transport, poll_interval_min, webhook_url, webhook_secret, webhook_header,
              token_hash, token_prefix, scopes_json, metadata_json, enabled,
              last_seen_at, active_task_id, created_at, updated_at
            ) VALUES (?, 'device-worker', ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, '', '', 'X-A2A-Signature', NULL, '', '[]', ?, ?, ?, NULL, ?, ?)
          `).run(
            agentId,
            String(deviceId),
            key,
            sqlStr(w.name || key),
            sqlStr(w.role || "worker"),
            sqlStr(w.platform || "cli"),
            sqlStr(w.summary || ""),
            JSON.stringify(skills),
            JSON.stringify(tools),
            JSON.stringify(models),
            sqlStr(w.default_model || ""),
            sqlStr(w.approval_policy || "never"),
            nextTransport,
            sqlInt(dev.poll_interval_min, 5),
            JSON.stringify(meta),
            sqlBool(w.enabled !== false),
            now,
            now,
            now
          );
        }
      }

      for (const prev of existingRows) {
        if (!keepIds.has(prev.id)) {
          workersChanged = true;
          this.db.prepare("DELETE FROM agents WHERE id = ?").run(prev.id);
        }
      }

      // 仅在配置/设备元信息真变化或设备由离线重连时才递增 seq 广播，避免幂等同步打断长轮询。
      if (devMetaChanged || workersChanged || wasOffline) {
        const seq = this.nextSeq();
        this.emitChange({ type: "device.synced", seq, deviceId: String(deviceId) });
      }
      return {
        device: this.getDevice(deviceId),
        agents: this.listAgents({ device_id: String(deviceId) }),
      };
    });
  }

  // ---- Tasks & Messages ----

  getTask(id) {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(String(id));
    return serializeTask(row);
  }

  listTasks(filter = {}) {
    const clauses = [];
    const args = [];
    if (filter.to_agent_id) {
      clauses.push("to_agent_id = ?");
      args.push(String(filter.to_agent_id));
    }
    if (Array.isArray(filter.to_agent_ids) && filter.to_agent_ids.length) {
      clauses.push(`to_agent_id IN (${filter.to_agent_ids.map(() => "?").join(",")})`);
      args.push(...filter.to_agent_ids.map(String));
    }
    if (filter.from_node) {
      clauses.push("from_node = ?");
      args.push(String(filter.from_node));
    }
    if (filter.context_id) {
      clauses.push("context_id = ?");
      args.push(String(filter.context_id));
    }
    if (filter.state) {
      clauses.push("state = ?");
      args.push(String(filter.state));
    }
    if (Array.isArray(filter.states) && filter.states.length) {
      clauses.push(`state IN (${filter.states.map(() => "?").join(",")})`);
      args.push(...filter.states.map(String));
    }
    if (filter.schedule_id) {
      clauses.push("schedule_id = ?");
      args.push(String(filter.schedule_id));
    }
    if (filter.visible_to) {
      clauses.push("(to_agent_id = ? OR from_node = ?)");
      args.push(String(filter.visible_to), String(filter.visible_to));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(Number(filter.limit || 200), 1), 1000);
    const order = filter.order === "asc"
      ? "ORDER BY created_at ASC"
      : "ORDER BY updated_at DESC, created_at DESC";
    const cols = filter.summaryOnly
      ? `id, context_id, parent_task_id, from_node, to_agent_id, title, model, state, priority, source, schedule_id,
         CASE WHEN attachments_json IS NOT NULL AND json_valid(attachments_json) AND json_type(attachments_json) = 'array' THEN json_array_length(attachments_json) ELSE 0 END AS input_attachment_count,
         CASE WHEN receipt_json IS NOT NULL AND json_valid(receipt_json) AND json_type(json_extract(receipt_json, '$.attachments')) = 'array' THEN json_array_length(json_extract(receipt_json, '$.attachments')) ELSE 0 END AS receipt_attachment_count,
         (receipt_json IS NOT NULL) AS has_receipt,
         CASE WHEN receipt_json IS NOT NULL AND json_valid(receipt_json) THEN json_extract(receipt_json, '$.summary') ELSE NULL END AS receipt_summary,
         error_message, retry_count, max_retries, timeout_sec, claimed_by, claimed_at, lease_until, leader_notified,
         created_at, updated_at, completed_at, resolved_at, changed_seq`
      : "*";
    const rows = this.db.prepare(`SELECT ${cols} FROM tasks ${where} ${order} LIMIT ?`).all(...args, limit);
    return rows.map((r) => (filter.summaryOnly ? serializeTaskSummary(r) : serializeTask(r)));
  }

  listMessages(taskId) {
    const rows = this.db.prepare("SELECT * FROM messages WHERE task_id = ? ORDER BY id ASC").all(String(taskId));
    return rows.map((r) => serializeMessage(r));
  }

  listContextMessages(contextId, excludeTaskId = null) {
    const rows = excludeTaskId
      ? this.db.prepare("SELECT * FROM messages WHERE context_id = ? AND task_id != ? ORDER BY id ASC").all(String(contextId), String(excludeTaskId))
      : this.db.prepare("SELECT * FROM messages WHERE context_id = ? ORDER BY id ASC").all(String(contextId));
    return rows.map((r) => serializeMessage(r));
  }

  appendMessage({ task_id, context_id, from_node, kind, body = "", data = {}, attachments = [], signature = null, created_at = Date.now() }) {
    const res = this.db.prepare(`
      INSERT INTO messages (task_id, context_id, from_node, kind, body, data_json, attachments_json, signature, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      String(task_id),
      String(context_id),
      String(from_node),
      String(kind),
      sqlStr(body || ""),
      JSON.stringify(data && typeof data === "object" ? data : {}),
      JSON.stringify(Array.isArray(attachments) ? attachments : []),
      sqlStr(signature),
      sqlInt(created_at, Date.now())
    );
    return serializeMessage(res);
  }

  // ---- Files & 多对多任务关联 ----

  getFileMeta(id, now = Date.now()) {
    const fid = String(id || "").trim();
    if (!FILE_ID_RE.test(fid)) return null;
    const row = this.db.prepare("SELECT * FROM files WHERE id = ?").get(fid);
    if (!row) return null;
    if (Number(row.expires_at) <= now) return null;
    return {
      id: row.id,
      uri: `hub://files/${row.id}`,
      name: row.name,
      mime: row.mime,
      size: Number(row.size),
      sha256: row.sha256,
      owner_node: row.owner_node,
      task_id: row.task_id ?? null,
      created_at: Number(row.created_at),
      expires_at: Number(row.expires_at),
    };
  }

  linkFileToTask({ fileId, taskId, contextId = "", messageId = null, createdAt = Date.now() }) {
    const fid = String(fileId || "").trim();
    const tid = String(taskId || "").trim();
    if (!FILE_ID_RE.test(fid) || !tid) return false;
    const fileRow = this.db.prepare("SELECT 1 FROM files WHERE id = ?").get(fid);
    if (!fileRow) return false;
    const taskRow = this.db.prepare("SELECT context_id FROM tasks WHERE id = ?").get(tid);
    if (!taskRow) return false;
    const cid = String(contextId || taskRow.context_id || "");
    const res = this.db.prepare(`
      INSERT OR IGNORE INTO file_links (file_id, task_id, context_id, message_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(fid, tid, cid, messageId !== null && messageId !== undefined ? sqlInt(messageId) : null, sqlInt(createdAt, Date.now()));
    return res.changes > 0;
  }

  listFileLinkedTasks(fileId) {
    const fid = String(fileId || "").trim();
    if (!FILE_ID_RE.test(fid)) return [];
    const rows = this.db.prepare(`
      SELECT t.* FROM file_links fl
      JOIN tasks t ON t.id = fl.task_id
      WHERE fl.file_id = ?
      ORDER BY fl.created_at ASC
    `).all(fid);
    return rows.map((r) => serializeTask(r));
  }

  // 为升级前的历史任务/消息附件回填多对多绑定，确保老库中的扇出附件同样可授权下载。
  backfillFileLinks() {
    const fileCount = Number(this.db.prepare("SELECT COUNT(*) AS cnt FROM files").get()?.cnt || 0);
    if (fileCount === 0) return 0;

    return this.transaction(() => {
      let inserted = 0;
      const insertStmt = this.db.prepare(`
        INSERT OR IGNORE INTO file_links (file_id, task_id, context_id, message_id, created_at)
        SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM files WHERE id = ?)
          AND EXISTS (SELECT 1 FROM tasks WHERE id = ?)
      `);

      const linkIfPresent = (fid, tid, cid, mid, ts) => {
        if (!FILE_ID_RE.test(String(fid || "")) || !tid) return;
        const r = insertStmt.run(fid, String(tid), String(cid || ""), mid, sqlInt(ts, Date.now()), fid, String(tid));
        inserted += Number(r.changes || 0);
      };

      const fileRows = this.db.prepare("SELECT id, task_id, created_at FROM files WHERE task_id IS NOT NULL AND task_id != ''").all();
      for (const f of fileRows) {
        const t = this.db.prepare("SELECT context_id FROM tasks WHERE id = ?").get(f.task_id);
        if (t) linkIfPresent(f.id, f.task_id, t.context_id, null, f.created_at);
      }

      const taskRows = this.db.prepare(
        "SELECT id, context_id, attachments_json, receipt_json, created_at FROM tasks WHERE attachments_json != '[]' OR receipt_json IS NOT NULL"
      ).all();
      for (const t of taskRows) {
        for (const att of parseJson(t.attachments_json, [])) {
          const fid = extractHubFileId(att);
          if (fid) linkIfPresent(fid, t.id, t.context_id, null, t.created_at);
        }
        const receipt = parseJson(t.receipt_json, null);
        if (Array.isArray(receipt?.attachments)) {
          for (const att of receipt.attachments) {
            const fid = extractHubFileId(att);
            if (fid) linkIfPresent(fid, t.id, t.context_id, null, t.created_at);
          }
        }
      }

      const msgRows = this.db.prepare("SELECT id, task_id, context_id, attachments_json, created_at FROM messages WHERE attachments_json != '[]'").all();
      for (const m of msgRows) {
        for (const att of parseJson(m.attachments_json, [])) {
          const fid = extractHubFileId(att);
          if (fid) linkIfPresent(fid, m.task_id, m.context_id, m.id, m.created_at);
        }
      }

      return inserted;
    });
  }

  // ---- Idempotency & Watermarks ----

  getIdempotency(scope, tokenKey) {
    if (!tokenKey) return null;
    const row = this.db.prepare("SELECT result_json FROM idempotency WHERE scope = ? AND token_key = ?")
      .get(String(scope), String(tokenKey));
    return row ? parseJson(row.result_json, null) : null;
  }

  saveIdempotency(scope, tokenKey, result) {
    if (!tokenKey) return;
    this.db.prepare(`
      INSERT INTO idempotency (scope, token_key, result_json, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(scope, token_key) DO UPDATE SET result_json = excluded.result_json
    `).run(String(scope), String(tokenKey), JSON.stringify(result), Date.now());
  }

  getWatermark(actorId) {
    const row = this.db.prepare("SELECT last_seq FROM watermarks WHERE actor_id = ?").get(String(actorId));
    return row ? Number(row.last_seq) : 0;
  }

  setWatermark(actorId, seq) {
    this.db.prepare(`
      INSERT INTO watermarks (actor_id, last_seq, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(actor_id) DO UPDATE SET last_seq = MAX(watermarks.last_seq, excluded.last_seq), updated_at = excluded.updated_at
    `).run(String(actorId), sqlInt(seq, 0), Date.now());
  }

  // ---- Schedules ----

  upsertSchedule(input, { eventType = "schedule.updated", includeActorScope = true, silentIfUnchanged = false, eventExtra = {} } = {}) {
    return this.transaction(() => {
      const id = String(input.id).trim();
      const agentId = String(input.agent_id).trim();
      const now = sqlInt(input.now, Date.now());
      const existing = this.db.prepare("SELECT * FROM schedules WHERE agent_id = ? AND id = ?").get(agentId, id);

      const pickNullableInt = (val, prev) =>
        val === undefined ? (prev ?? null) : val === null ? null : sqlInt(val, null);
      const pickNullableStr = (val, prev) =>
        val === undefined ? (prev ?? null) : val === null || val === "" ? null : String(val);

      const nextName = sqlStr(input.name !== undefined ? input.name : (existing?.name || id)) || id;
      const rawDriver = input.driver !== undefined ? input.driver : (existing?.driver || "edge");
      const nextDriver = rawDriver === "hub" ? "hub" : "edge";
      const nextCronExpr = sqlStr(input.cron_expr !== undefined ? input.cron_expr : (existing?.cron_expr || "")) || "";
      const nextIntervalMin = Math.max(1, sqlInt(input.interval_min !== undefined ? input.interval_min : (existing?.interval_min ?? 60), 60));
      const nextTimezone = sqlStr(input.timezone !== undefined ? input.timezone : (existing?.timezone || DEFAULT_TIMEZONE)) || DEFAULT_TIMEZONE;
      const nextGraceSec = pickNullableInt(input.grace_sec, existing?.grace_sec);
      const nextSummary = sqlStr(input.summary !== undefined ? input.summary : (existing?.summary || "")) || "";
      const nextTemplateVal = input.task_template !== undefined
        ? (input.task_template && typeof input.task_template === "object" ? input.task_template : {})
        : parseJson(existing?.task_template_json, {});
      const rawCtxMode = input.context_mode !== undefined ? input.context_mode : (existing?.context_mode || "per_run");
      const nextContextMode = rawCtxMode === "rolling" ? "rolling" : "per_run";
      const nextPinnedCtx = pickNullableStr(input.pinned_context_id, existing?.pinned_context_id);
      const rawOverlap = input.overlap_policy !== undefined ? input.overlap_policy : (existing?.overlap_policy || "skip");
      const nextOverlap = rawOverlap === "allow" ? "allow" : "skip";
      const rawMisfire = input.misfire_policy !== undefined ? input.misfire_policy : (existing?.misfire_policy || "fire_once");
      const nextMisfire = rawMisfire === "skip" ? "skip" : "fire_once";
      const nextTriggerable = sqlBool(
        input.triggerable !== undefined
          ? input.triggerable
          : existing?.triggerable !== undefined && existing?.triggerable !== null
            ? existing.triggerable
            : nextDriver === "hub"
      );
      const nextRunAt = pickNullableInt(input.next_run_at, existing?.next_run_at);
      const nextLastTickAt = pickNullableInt(input.last_tick_at, existing?.last_tick_at);
      const nextLastRunAt = pickNullableInt(input.last_run_at, existing?.last_run_at);
      const nextLastDurationMs = pickNullableInt(input.last_duration_ms, existing?.last_duration_ms);
      const nextLastOutcome = pickNullableStr(input.last_outcome, existing?.last_outcome);
      const nextLastTaskId = pickNullableStr(input.last_task_id, existing?.last_task_id);
      const nextAlertedMissedAt = pickNullableInt(input.alerted_missed_at, existing?.alerted_missed_at);
      const nextRecentTicksVal = input.recent_ticks !== undefined
        ? (Array.isArray(input.recent_ticks) ? input.recent_ticks : [])
        : parseJson(existing?.recent_ticks_json, []);
      const nextEnabled = sqlBool(input.enabled !== undefined ? input.enabled : (existing ? existing.enabled : true));

      if (existing && silentIfUnchanged) {
        const unchanged =
          nextName === existing.name &&
          nextDriver === (existing.driver || "edge") &&
          nextCronExpr === (existing.cron_expr || "") &&
          nextIntervalMin === Number(existing.interval_min ?? 60) &&
          nextTimezone === (existing.timezone || DEFAULT_TIMEZONE) &&
          nextGraceSec === (existing.grace_sec ?? null) &&
          nextSummary === (existing.summary || "") &&
          deepValuesEqual(nextTemplateVal, parseJson(existing.task_template_json, {})) &&
          nextContextMode === (existing.context_mode || "per_run") &&
          nextPinnedCtx === (existing.pinned_context_id ?? null) &&
          nextOverlap === (existing.overlap_policy || "skip") &&
          nextMisfire === (existing.misfire_policy || "fire_once") &&
          nextTriggerable === Number(existing.triggerable ?? (nextDriver === "hub" ? 1 : 0)) &&
          nextEnabled === Number(existing.enabled);
        if (unchanged) {
          return serializeSchedule(existing);
        }
      }

      const createdAt = existing?.created_at ?? now;
      this.db.prepare(`
        INSERT INTO schedules (
          id, agent_id, name, driver, cron_expr, interval_min, timezone, grace_sec,
          summary, task_template_json, context_mode, pinned_context_id,
          overlap_policy, misfire_policy, triggerable,
          next_run_at, last_tick_at, last_run_at, last_duration_ms, last_outcome, last_task_id,
          alerted_missed_at, recent_ticks_json, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id, id) DO UPDATE SET
          name = excluded.name,
          driver = excluded.driver,
          cron_expr = excluded.cron_expr,
          interval_min = excluded.interval_min,
          timezone = excluded.timezone,
          grace_sec = excluded.grace_sec,
          summary = excluded.summary,
          task_template_json = excluded.task_template_json,
          context_mode = excluded.context_mode,
          pinned_context_id = excluded.pinned_context_id,
          overlap_policy = excluded.overlap_policy,
          misfire_policy = excluded.misfire_policy,
          triggerable = excluded.triggerable,
          next_run_at = excluded.next_run_at,
          last_tick_at = excluded.last_tick_at,
          last_run_at = excluded.last_run_at,
          last_duration_ms = excluded.last_duration_ms,
          last_outcome = excluded.last_outcome,
          last_task_id = excluded.last_task_id,
          alerted_missed_at = excluded.alerted_missed_at,
          recent_ticks_json = excluded.recent_ticks_json,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `).run(
        id,
        agentId,
        nextName,
        nextDriver,
        nextCronExpr,
        nextIntervalMin,
        nextTimezone,
        nextGraceSec,
        nextSummary,
        JSON.stringify(nextTemplateVal),
        nextContextMode,
        nextPinnedCtx,
        nextOverlap,
        nextMisfire,
        nextTriggerable,
        nextRunAt,
        nextLastTickAt,
        nextLastRunAt,
        nextLastDurationMs,
        nextLastOutcome,
        nextLastTaskId,
        nextAlertedMissedAt,
        JSON.stringify(nextRecentTicksVal),
        nextEnabled,
        createdAt,
        now
      );

      if (eventType) {
        const seq = this.nextSeq();
        this.emitChange({
          type: eventType,
          seq,
          ...(includeActorScope ? { agentId } : {}),
          scheduleId: id,
          ...eventExtra,
        });
      }
      return this.getSchedule(agentId, id);
    });
  }

  getSchedule(agentId, id) {
    const row = this.db.prepare("SELECT * FROM schedules WHERE agent_id = ? AND id = ?").get(String(agentId), String(id));
    return serializeSchedule(row);
  }

  listSchedules(agentId = null) {
    const rows = agentId
      ? this.db.prepare("SELECT * FROM schedules WHERE agent_id = ? ORDER BY id ASC").all(String(agentId))
      : this.db.prepare("SELECT * FROM schedules ORDER BY agent_id ASC, id ASC").all();
    return rows.map((r) => serializeSchedule(r));
  }

  listMutedScheduleIds(agentId) {
    const rows = this.db
      .prepare("SELECT id FROM schedules WHERE agent_id = ? AND enabled = 0 ORDER BY id ASC")
      .all(String(agentId));
    return rows.map((r) => String(r.id));
  }

  listRecentScheduleTasks(agentId = null, perScheduleLimit = 15) {
    const safeLimit = Math.min(Math.max(sqlInt(perScheduleLimit, 15), 1), 100);
    const taskCols = `id, context_id, from_node, to_agent_id, source, schedule_id, state, title,
      CASE WHEN receipt_json IS NOT NULL AND json_valid(receipt_json) THEN json_extract(receipt_json, '$.summary') ELSE NULL END AS receipt_summary,
      CASE WHEN receipt_json IS NOT NULL AND json_valid(receipt_json) THEN substr(json_extract(receipt_json, '$.text'), 1, 300) ELSE NULL END AS receipt_text_head,
      error_message, created_at, completed_at, resolved_at`;
    const where = agentId
      ? "WHERE schedule_id IS NOT NULL AND to_agent_id = ?"
      : "WHERE schedule_id IS NOT NULL";
    const sql = `
      SELECT id, context_id, from_node, to_agent_id, source, schedule_id, state, title,
             receipt_summary, receipt_text_head, error_message, created_at, completed_at, resolved_at
      FROM (
        SELECT ${taskCols},
               ROW_NUMBER() OVER (PARTITION BY to_agent_id, schedule_id ORDER BY created_at DESC) AS rn
        FROM tasks
        ${where}
      )
      WHERE rn <= ?
      ORDER BY created_at DESC
    `;
    return agentId
      ? this.db.prepare(sql).all(String(agentId), safeLimit)
      : this.db.prepare(sql).all(safeLimit);
  }

  hasActiveScheduleSiblingTask(scheduleId, contextId) {
    const row = this.db.prepare(`
      SELECT id, state FROM tasks
      WHERE schedule_id = ? AND context_id = ? AND source = 'hub_cron'
        AND state IN ('submitted', 'working', 'input-required', 'auth-required')
      LIMIT 1
    `).get(String(scheduleId), String(contextId));
    return row || null;
  }

  hasFailedScheduleSiblingTask(scheduleId, contextId) {
    const row = this.db.prepare(`
      SELECT id, state FROM tasks
      WHERE schedule_id = ? AND context_id = ?
        AND state IN ('failed', 'rejected', 'canceled')
        AND resolved_at IS NULL
      LIMIT 1
    `).get(String(scheduleId), String(contextId));
    return row || null;
  }

  recordScheduleTaskActivity(
    agentId,
    scheduleId,
    { taskId = null, outcome = undefined, durationMs = undefined, touchRunAt = false, clearAlert = false, contextId = null, now = Date.now() } = {}
  ) {
    const sid = String(scheduleId);
    const targetAid = String(agentId);
    let ownerAgentId = null;

    const directRow = this.db
      .prepare("SELECT agent_id FROM schedules WHERE agent_id = ? AND id = ?")
      .get(targetAid, sid);
    if (directRow) {
      ownerAgentId = directRow.agent_id;
    } else if (contextId) {
      const siblingRow = this.db.prepare(`
        SELECT s.agent_id
        FROM schedules s
        JOIN tasks t ON t.id = s.last_task_id
        WHERE s.id = ? AND t.context_id = ?
        LIMIT 1
      `).get(sid, String(contextId));
      if (siblingRow) ownerAgentId = siblingRow.agent_id;
    }

    if (!ownerAgentId) {
      const hubRows = this.db
        .prepare("SELECT agent_id, task_template_json FROM schedules WHERE id = ? AND driver = 'hub'")
        .all(sid);
      const matches = hubRows.filter((r) => {
        const tpl = parseJson(r.task_template_json, {});
        const toRaw = tpl?.to;
        const list = (Array.isArray(toRaw) ? toRaw : toRaw ? [toRaw] : []).map((x) => String(x || "").trim());
        return list.includes(targetAid);
      });
      if (matches.length === 1) {
        ownerAgentId = matches[0].agent_id;
      }
    }

    if (!ownerAgentId) return;

    const sets = [];
    const vals = [];
    if (touchRunAt) {
      sets.push("last_tick_at = ?", "last_run_at = ?");
      vals.push(sqlInt(now), sqlInt(now));
    }
    if (taskId !== null && taskId !== undefined) {
      sets.push("last_task_id = ?");
      vals.push(String(taskId));
    }
    if (outcome !== undefined) {
      sets.push("last_outcome = ?");
      vals.push(outcome === null ? null : String(outcome));
    }
    if (durationMs !== undefined && durationMs !== null && Number.isFinite(Number(durationMs))) {
      sets.push("last_duration_ms = ?");
      vals.push(Math.max(0, Math.trunc(Number(durationMs))));
    }
    if (clearAlert) {
      sets.push("alerted_missed_at = NULL");
    }
    if (!sets.length) return;
    sets.push("updated_at = ?");
    vals.push(sqlInt(now), String(ownerAgentId), sid);
    this.db
      .prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE agent_id = ? AND id = ?`)
      .run(...vals);
  }

  deleteSchedule(agentId, id) {
    return this.transaction(() => {
      const res = this.db.prepare("DELETE FROM schedules WHERE agent_id = ? AND id = ?").run(String(agentId), String(id));
      if (res.changes > 0) {
        const seq = this.nextSeq();
        this.emitChange({ type: "schedule.deleted", seq, agentId: String(agentId), scheduleId: String(id) });
        return true;
      }
      return false;
    });
  }
}
