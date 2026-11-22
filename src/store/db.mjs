// Hub 唯一持久化后端（Node >= 24 内置 node:sqlite + WAL）。
// 把设备、Agent、任务、消息、定时自报、幂等键、水位与文件索引统一在一张 hub.db 中，
// 通过 BEGIN IMMEDIATE 保证状态迁移原子性，并在顶层事务提交后才通知外部监听器。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  id                TEXT NOT NULL,
  agent_id          TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  cron_expr         TEXT NOT NULL DEFAULT '',
  interval_min      INTEGER NOT NULL DEFAULT 60,
  summary           TEXT NOT NULL DEFAULT '',
  last_run_at       INTEGER,
  last_task_id      TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
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
  return {
    id: row.id,
    agent_id: row.agent_id,
    name: row.name,
    cron_expr: row.cron_expr || "",
    interval_min: Number(row.interval_min ?? 60),
    summary: row.summary || "",
    last_run_at: row.last_run_at ?? null,
    last_task_id: row.last_task_id ?? null,
    enabled: Boolean(row.enabled),
  };
}

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
    this.db.exec(SCHEMA_SQL);
    if (dbPath !== ":memory:") {
      try {
        fs.chmodSync(dbPath, 0o600);
      } catch {}
    }
  }

  close() {
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
        sqlStr(patch.name !== undefined ? patch.name : existing.name),
        sqlStr(patch.role !== undefined ? patch.role : existing.role),
        sqlStr(patch.platform !== undefined ? patch.platform : existing.platform),
        sqlStr(patch.summary !== undefined ? patch.summary : existing.summary),
        sqlStr(patch.note !== undefined ? patch.note : existing.note),
        patch.skills !== undefined ? JSON.stringify(patch.skills) : existing.skills_json,
        patch.tools !== undefined ? JSON.stringify(patch.tools) : existing.tools_json,
        patch.models !== undefined ? JSON.stringify(patch.models) : existing.models_json,
        sqlStr(patch.default_model !== undefined ? patch.default_model : existing.default_model),
        sqlStr(patch.approval_policy !== undefined ? patch.approval_policy : existing.approval_policy),
        sqlStr(patch.transport !== undefined ? patch.transport : existing.transport),
        sqlInt(patch.poll_interval_min !== undefined ? patch.poll_interval_min : existing.poll_interval_min, 5),
        sqlStr(patch.webhook_url !== undefined ? patch.webhook_url : existing.webhook_url),
        sqlStr(patch.webhook_secret !== undefined ? patch.webhook_secret : existing.webhook_secret),
        sqlStr(patch.webhook_header !== undefined ? patch.webhook_header : existing.webhook_header),
        patch.scopes !== undefined ? JSON.stringify(patch.scopes) : existing.scopes_json,
        patch.metadata !== undefined ? JSON.stringify(patch.metadata) : existing.metadata_json,
        sqlBool(patch.enabled !== undefined ? patch.enabled : existing.enabled),
        patch.active_task_id !== undefined ? sqlStr(patch.active_task_id) : existing.active_task_id,
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
      if (deviceMeta.os_info || deviceMeta.platform || deviceMeta.max_concurrent || deviceMeta.transport) {
        this.db.prepare(`
          UPDATE devices SET
            platform = ?, os_info = ?, transport = ?, max_concurrent = ?, last_seen_at = ?, updated_at = ?
          WHERE id = ?
        `).run(
          sqlStr(deviceMeta.platform ?? dev.platform),
          sqlStr(deviceMeta.os_info ?? dev.os_info),
          sqlStr(deviceMeta.transport ?? dev.transport),
          sqlInt(deviceMeta.max_concurrent ?? dev.max_concurrent, 4),
          now,
          now,
          String(deviceId)
        );
      } else {
        this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, String(deviceId));
      }

      const existingRows = this.db.prepare("SELECT * FROM agents WHERE device_id = ? AND kind = 'device-worker'").all(String(deviceId));
      const byWorkerKey = new Map(existingRows.map((r) => [r.worker_key, r]));
      const keepIds = new Set();
      const transport = deviceMeta.transport ?? dev.transport ?? "longpoll";

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
          this.db.prepare(`
            UPDATE agents SET
              name = ?, role = ?, platform = ?, summary = ?,
              skills_json = ?, tools_json = ?, models_json = ?, default_model = ?,
              approval_policy = ?, transport = ?, metadata_json = ?, last_seen_at = ?, updated_at = ?
            WHERE id = ?
          `).run(
            sqlStr(w.name || prev.name || key),
            sqlStr(w.role || prev.role || "worker"),
            sqlStr(w.platform || prev.platform || "cli"),
            sqlStr(w.summary !== undefined ? w.summary : prev.summary),
            JSON.stringify(skills),
            JSON.stringify(tools),
            JSON.stringify(models),
            sqlStr(w.default_model ?? prev.default_model ?? ""),
            sqlStr(w.approval_policy || prev.approval_policy || "never"),
            sqlStr(transport),
            JSON.stringify(meta),
            now,
            now,
            prev.id
          );
        } else {
          this.db.prepare(`
            INSERT INTO agents (
              id, kind, device_id, worker_key, name, role, platform, summary, note,
              skills_json, tools_json, models_json, default_model, approval_policy,
              transport, poll_interval_min, webhook_url, webhook_secret, webhook_header,
              token_hash, token_prefix, scopes_json, metadata_json, enabled,
              last_seen_at, active_task_id, created_at, updated_at
            ) VALUES (?, 'device-worker', ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, '', '', 'X-A2A-Signature', NULL, '', '[]', ?, 1, ?, NULL, ?, ?)
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
            sqlStr(transport),
            sqlInt(dev.poll_interval_min, 5),
            JSON.stringify(meta),
            now,
            now,
            now
          );
        }
      }

      for (const prev of existingRows) {
        if (!keepIds.has(prev.id)) {
          this.db.prepare("DELETE FROM agents WHERE id = ?").run(prev.id);
        }
      }

      const seq = this.nextSeq();
      this.emitChange({ type: "device.synced", seq, deviceId: String(deviceId) });
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
    const rows = this.db.prepare(`SELECT * FROM tasks ${where} ${order} LIMIT ?`).all(...args, limit);
    return rows.map((r) => serializeTask(r));
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

  upsertSchedule({ id, agent_id, name, cron_expr = "", interval_min = 60, summary = "", enabled = true, last_run_at = null, last_task_id = null }) {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM schedules WHERE agent_id = ? AND id = ?").get(String(agent_id), String(id));
      this.db.prepare(`
        INSERT INTO schedules (id, agent_id, name, cron_expr, interval_min, summary, last_run_at, last_task_id, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id, id) DO UPDATE SET
          name = excluded.name,
          cron_expr = excluded.cron_expr,
          interval_min = excluded.interval_min,
          summary = excluded.summary,
          last_run_at = COALESCE(excluded.last_run_at, schedules.last_run_at),
          last_task_id = COALESCE(excluded.last_task_id, schedules.last_task_id),
          enabled = excluded.enabled
      `).run(
        String(id),
        String(agent_id),
        sqlStr(name || id),
        sqlStr(cron_expr || ""),
        sqlInt(interval_min, 60),
        sqlStr(summary || ""),
        last_run_at !== null && last_run_at !== undefined ? sqlInt(last_run_at) : (existing?.last_run_at ?? null),
        sqlStr(last_task_id ?? existing?.last_task_id ?? null),
        sqlBool(enabled)
      );
      const seq = this.nextSeq();
      this.emitChange({ type: "schedule.updated", seq, agentId: String(agent_id), scheduleId: String(id) });
      return this.getSchedule(agent_id, id);
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
