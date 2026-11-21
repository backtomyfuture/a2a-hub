// 自托管 SQLite 总线后端（基于 Node >= 24 内置 node:sqlite DatabaseSync）。
// 零外部依赖，与内存 MockBus 同一数据面契约，
// 并支持 WAL 并发读写、client_token 幂等建行、单调 seq 游标与长轮询事件发布。

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { f1 } from "./tables.mjs";
import { normalizeTables } from "./tables.mjs";

function scalar(fields, key) {
  const v = fields?.[key];
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v ?? "").trim();
}

function eventNodesFor(table, fields, tables, lookupMessage) {
  const nodes = new Set(["hub", "_web"]);
  if (table === tables.tasks) {
    for (const k of ["Target_Node", "Source", "Claimed_By"]) {
      const v = scalar(fields, k);
      if (v) nodes.add(v);
    }
    if (!scalar(fields, "Target_Node")) nodes.add("*");
  } else if (table === tables.messages) {
    const kind = scalar(fields, "Kind");
    const from = scalar(fields, "From_Node");
    const to = scalar(fields, "To_Node");
    if (from) nodes.add(from);
    // instruction 先于 Tasks 写入；等 Tasks 落库后再唤醒目标节点，避免抢跑读不到 Tasks。
    if (kind !== "instruction") {
      if (to === "all" || !to) nodes.add("*");
      else if (to) nodes.add(to);
    }
  } else if (table === tables.parts) {
    if (scalar(fields, "Parent_Type") === "message" && typeof lookupMessage === "function") {
      const parentId = scalar(fields, "Parent_ID");
      const msg = parentId ? lookupMessage(parentId) : null;
      const kind = scalar(msg, "Kind");
      if (msg && kind !== "instruction") {
        const from = scalar(msg, "From_Node");
        const to = scalar(msg, "To_Node");
        if (from) nodes.add(from);
        if (to === "all" || !to) nodes.add("*");
        else if (to) nodes.add(to);
      }
    }
  } else if (table === tables.agentCards) {
    const n = scalar(fields, "Node");
    if (n) nodes.add(n);
    nodes.add("*");
  }
  return Array.from(nodes);
}

export class SqliteBus {
  constructor({ dbPath = ":memory:", tables, broker = null, notifier = null, log } = {}) {
    this.dbPath = dbPath || ":memory:";
    this.tables = normalizeTables(tables);
    this.broker = broker;
    this.notifier = notifier;
    // attachNotifier 仍只保留一个外部通知器；Webhook 等通过 addListener 追加，互不覆盖。
    this.listeners = [];
    this.log = log ?? (() => {});
    this._stats = { list: 0, get: 0, write: 0, other: 0, backoff: 0 };

    if (this.dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(this.dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(this.dbPath);
    if (this.dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this._initSchema();

    this._stmts = {
      getSeq: this.db.prepare("SELECT v FROM meta WHERE k = 'seq'"),
      setSeq: this.db.prepare("INSERT INTO meta (k, v) VALUES ('seq', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
      getMeta: this.db.prepare("SELECT v FROM meta WHERE k = ?"),
      setMeta: this.db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
      list: this.db.prepare("SELECT record_id, seq, fields_json FROM records WHERE table_name = ? ORDER BY seq ASC, rowid ASC"),
      get: this.db.prepare("SELECT record_id, seq, fields_json FROM records WHERE table_name = ? AND record_id = ?"),
      getToken: this.db.prepare("SELECT record_id FROM idempotency_tokens WHERE table_name = ? AND client_token = ?"),
      putToken: this.db.prepare("INSERT OR IGNORE INTO idempotency_tokens (table_name, client_token, record_id, created_at) VALUES (?, ?, ?, ?)"),
      insert: this.db.prepare("INSERT INTO records (table_name, record_id, seq, fields_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"),
      update: this.db.prepare("UPDATE records SET seq = ?, fields_json = ?, updated_at = ? WHERE table_name = ? AND record_id = ?"),
      remove: this.db.prepare("DELETE FROM records WHERE table_name = ? AND record_id = ?"),
      insertCard: this.db.prepare("INSERT INTO cards (message_id, receive_id, receive_id_type, msg_type, content_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
      updateCard: this.db.prepare("UPDATE cards SET content_json = ?, updated_at = ? WHERE message_id = ?"),
      listCards: this.db.prepare("SELECT * FROM cards ORDER BY rowid DESC"),
      getCard: this.db.prepare("SELECT * FROM cards WHERE message_id = ?"),
      getMessageByMsgId: this.db.prepare("SELECT fields_json FROM records WHERE table_name = ? AND json_extract(fields_json, '$.Msg_ID') = ? LIMIT 1"),
      insertAudit: this.db.prepare("INSERT INTO audit_logs (ts, seq, table_name, op, record_id, node, cap_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      listAuditAll: this.db.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?"),
      listAuditByTable: this.db.prepare("SELECT * FROM audit_logs WHERE table_name = ? ORDER BY id DESC LIMIT ?"),
      listAuditByNode: this.db.prepare("SELECT * FROM audit_logs WHERE node = ? ORDER BY id DESC LIMIT ?"),
      listAuditByTableNode: this.db.prepare("SELECT * FROM audit_logs WHERE table_name = ? AND node = ? ORDER BY id DESC LIMIT ?"),
    };

    if (this.broker && Number(this.broker.latestSeq) < this.currentSeq()) {
      this.broker.latestSeq = this.currentSeq();
    }
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        fields_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (table_name, record_id)
      );
      CREATE INDEX IF NOT EXISTS idx_records_table_seq ON records(table_name, seq);

      CREATE TABLE IF NOT EXISTS idempotency_tokens (
        table_name TEXT NOT NULL,
        client_token TEXT NOT NULL,
        record_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (table_name, client_token)
      );

      CREATE TABLE IF NOT EXISTS cards (
        message_id TEXT PRIMARY KEY,
        receive_id TEXT NOT NULL,
        receive_id_type TEXT NOT NULL,
        msg_type TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        seq INTEGER NOT NULL,
        table_name TEXT NOT NULL,
        op TEXT NOT NULL,
        record_id TEXT NOT NULL,
        node TEXT NOT NULL DEFAULT '',
        cap_id TEXT NOT NULL DEFAULT '',
        before_json TEXT,
        after_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_table_id ON audit_logs(table_name, id DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_node_id ON audit_logs(node, id DESC);
    `);
    this.db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', '0')").run();
  }

  attachBroker(broker) {
    this.broker = broker;
    if (broker && Number(broker.latestSeq) < this.currentSeq()) {
      broker.latestSeq = this.currentSeq();
    }
  }

  attachNotifier(notifier) {
    this.notifier = notifier;
  }

  addListener(listener) {
    if (!listener || typeof listener.onBusEvent !== "function") return;
    if (this.listeners.includes(listener)) return;
    this.listeners.push(listener);
  }

  currentSeq() {
    const row = this._stmts.getSeq.get();
    const n = Number(row?.v ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  // 水位一类的小状态放 meta，不写 records，也就不会把总线 seq 往前推。
  // Leader 增量水位若跟着 latestSeq 走，读表和推进之间插入的写入会被跳过。
  async getMeta(key) {
    const row = this._stmts.getMeta.get(String(key));
    return row ? String(row.v) : null;
  }

  async setMeta(key, value) {
    this._stmts.setMeta.run(String(key), String(value ?? ""));
  }

  _bumpSeq() {
    const next = this.currentSeq() + 1;
    this._stmts.setSeq.run(String(next));
    return next;
  }

  takeStats() {
    const snap = { ...this._stats };
    this._stats = { list: 0, get: 0, write: 0, other: 0, backoff: 0 };
    return snap;
  }

  async tenantToken() {
    return "local-sqlite-token";
  }

  _toRow(row) {
    let fields = {};
    try {
      fields = JSON.parse(row.fields_json || "{}");
    } catch {
      fields = {};
    }
    return {
      record_id: row.record_id,
      // Leader 增量要拿任务行和消息行的变更序号做比较，字段 JSON 里没有这一列。
      seq: Number(row.seq) || 0,
      fields,
    };
  }

  async listRecords(table) {
    this._stats.list += 1;
    const rows = this._stmts.list.all(String(table));
    return rows.map((r) => this._toRow(r));
  }

  async getRecord(table, recordId) {
    this._stats.get += 1;
    const row = this._stmts.get.get(String(table), String(recordId));
    return row ? this._toRow(row) : null;
  }

  async findRecords(table, field, value) {
    const rows = await this.listRecords(table);
    return rows.filter((row) => f1(row, field) === value);
  }

  // 名录（AgentCards）变更审计：同事务写入只追加 audit_logs；仅 Updated_At 变化时不刷屏。
  _recordCardAudit(op, tbl, recordId, seq, beforeFields, afterFields, ts) {
    if (tbl !== this.tables.agentCards) return;
    if (op === "update" && beforeFields && afterFields) {
      const strip = (obj) => {
        const copy = { ...obj };
        delete copy.Updated_At;
        return JSON.stringify(copy);
      };
      if (strip(beforeFields) === strip(afterFields)) return;
    }
    const src = afterFields || beforeFields || {};
    const node = scalar(src, "Node");
    const capId = scalar(src, "Cap_ID");
    this._stmts.insertAudit.run(
      ts,
      seq,
      tbl,
      op,
      recordId,
      node,
      capId,
      beforeFields ? JSON.stringify(beforeFields) : null,
      afterFields ? JSON.stringify(afterFields) : null,
    );
  }

  listAuditLogs({ table = "", node = "", limit = 100 } = {}) {
    const cap = Math.max(1, Math.min(500, Number(limit) || 100));
    const tbl = String(table ?? "").trim();
    const nd = String(node ?? "").trim();
    let rows;
    if (tbl && nd) rows = this._stmts.listAuditByTableNode.all(tbl, nd, cap);
    else if (tbl) rows = this._stmts.listAuditByTable.all(tbl, cap);
    else if (nd) rows = this._stmts.listAuditByNode.all(nd, cap);
    else rows = this._stmts.listAuditAll.all(cap);
    return rows.map((r) => {
      let before = null;
      let after = null;
      try { if (r.before_json) before = JSON.parse(r.before_json); } catch {}
      try { if (r.after_json) after = JSON.parse(r.after_json); } catch {}
      return {
        id: r.id,
        ts: r.ts,
        seq: r.seq,
        table: r.table_name,
        op: r.op,
        record_id: r.record_id,
        node: r.node,
        cap_id: r.cap_id,
        before,
        after,
      };
    });
  }

  async createRecord(table, fields, clientToken) {
    this._stats.write += 1;
    const tbl = String(table);
    const token = clientToken ? String(clientToken) : "";
    const now = new Date().toISOString();

    let created = null;
    let seq = 0;
    let isIdempotentHit = false;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (token) {
        const hit = this._stmts.getToken.get(tbl, token);
        if (hit) {
          const existing = this._stmts.get.get(tbl, hit.record_id);
          if (existing) {
            created = this._toRow(existing);
            seq = existing.seq;
            isIdempotentHit = true;
          }
        }
      }
      if (!created) {
        const recordId = `rec_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        seq = this._bumpSeq();
        const cleanFields = structuredClone(fields ?? {});
        this._stmts.insert.run(tbl, recordId, seq, JSON.stringify(cleanFields), now, now);
        this._recordCardAudit("create", tbl, recordId, seq, null, cleanFields, now);
        if (token) {
          this._stmts.putToken.run(tbl, token, recordId, now);
        }
        created = { record_id: recordId, seq, fields: cleanFields };
      }
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }

    if (!isIdempotentHit) {
      const ev = {
        seq,
        op: "create",
        table: tbl,
        recordId: created.record_id,
        nodes: eventNodesFor(tbl, created.fields, this.tables, (id) => this._lookupMessageFields(id)),
      };
      this.broker?.publish(ev);
      this._notifyAsync(ev, created.fields);
    }
    return { record: structuredClone(created) };
  }

  async updateRecord(table, recordId, fields) {
    this._stats.write += 1;
    const tbl = String(table);
    const id = String(recordId);
    const now = new Date().toISOString();

    let updated = null;
    let seq = 0;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this._stmts.get.get(tbl, id);
      if (!existing) throw new Error(`record not found: ${tbl}/${id}`);
      const prevFields = this._toRow(existing).fields;
      const merged = { ...prevFields, ...structuredClone(fields ?? {}) };
      seq = this._bumpSeq();
      this._stmts.update.run(seq, JSON.stringify(merged), now, tbl, id);
      this._recordCardAudit("update", tbl, id, seq, prevFields, merged, now);
      updated = { record_id: id, seq, fields: merged };
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }

    const ev = {
      seq,
      op: "update",
      table: tbl,
      recordId: id,
      nodes: eventNodesFor(tbl, updated.fields, this.tables, (msgId) => this._lookupMessageFields(msgId)),
    };
    this.broker?.publish(ev);
    this._notifyAsync(ev, updated.fields);
    return { record: structuredClone(updated) };
  }

  // 只给名片这类登记表用。Messages / Parts 只追加，调用方不得对它们删行。
  async deleteRecord(table, recordId) {
    this._stats.write += 1;
    const tbl = String(table);
    const id = String(recordId);
    let fields = null;
    let seq = 0;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this._stmts.get.get(tbl, id);
      if (!existing) throw new Error(`record not found: ${tbl}/${id}`);
      fields = this._toRow(existing).fields;
      seq = this._bumpSeq();
      this._stmts.remove.run(tbl, id);
      this._recordCardAudit("delete", tbl, id, seq, fields, null, new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }

    this.broker?.publish({
      seq,
      op: "delete",
      table: tbl,
      recordId: id,
      nodes: eventNodesFor(tbl, fields, this.tables, (msgId) => this._lookupMessageFields(msgId)),
    });
    return { ok: true };
  }

  async sendMessage(receiveId, msgType, content, receiveIdType = "owner") {
    this._stats.other += 1;
    const messageId = `om_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();
    const contentJson = typeof content === "string" ? content : JSON.stringify(content ?? {});
    let seq = 0;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      seq = this._bumpSeq();
      this._stmts.insertCard.run(
        messageId,
        String(receiveId ?? ""),
        String(receiveIdType ?? "owner"),
        String(msgType ?? "interactive"),
        contentJson,
        now,
        now,
      );
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }

    this.broker?.publish({
      seq,
      op: "card_create",
      table: "cards",
      recordId: messageId,
      nodes: ["hub", "_web"],
    });
    return { message_id: messageId };
  }

  sendCard(receiveId, card) {
    return this.sendMessage(receiveId, "interactive", card, "owner");
  }

  async patchInteractiveCard(messageId, card) {
    this._stats.other += 1;
    const id = String(messageId);
    const now = new Date().toISOString();
    const contentJson = typeof card === "string" ? card : JSON.stringify(card ?? {});
    let seq = 0;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this._stmts.getCard.get(id);
      if (!existing) {
        seq = this._bumpSeq();
        this._stmts.insertCard.run(id, "owner", "owner", "interactive", contentJson, now, now);
      } else {
        seq = this._bumpSeq();
        this._stmts.updateCard.run(contentJson, now, id);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }

    this.broker?.publish({
      seq,
      op: "card_update",
      table: "cards",
      recordId: id,
      nodes: ["hub", "_web"],
    });
    return {};
  }

  listCards() {
    return this._stmts.listCards.all().map((row) => {
      let card = null;
      try { card = JSON.parse(row.content_json); } catch { card = row.content_json; }
      return {
        message_id: row.message_id,
        receive_id: row.receive_id,
        receive_id_type: row.receive_id_type,
        msg_type: row.msg_type,
        card,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    });
  }

  getCard(messageId) {
    const row = this._stmts.getCard.get(String(messageId));
    if (!row) return null;
    let card = null;
    try { card = JSON.parse(row.content_json); } catch { card = row.content_json; }
    return {
      message_id: row.message_id,
      receive_id: row.receive_id,
      receive_id_type: row.receive_id_type,
      msg_type: row.msg_type,
      card,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  _lookupMessageFields(msgId) {
    try {
      const row = this._stmts.getMessageByMsgId.get(this.tables.messages, String(msgId));
      return row ? JSON.parse(row.fields_json || "{}") : null;
    } catch {
      return null;
    }
  }

  _notifyAsync(ev, fields) {
    const targets = [];
    if (this.notifier && typeof this.notifier.onBusEvent === "function") targets.push(this.notifier);
    for (const listener of this.listeners) {
      if (listener !== this.notifier) targets.push(listener);
    }
    if (!targets.length) return;
    const payload = { ...ev, fields: { ...fields } };
    for (const target of targets) {
      // 包进微任务：监听者同步抛错时不会打断其余监听者，也不会冲出写表事务之后的调用方。
      Promise.resolve().then(() => target.onBusEvent(payload)).catch((e) => {
        this.log("notifier error: " + (e?.message ?? e));
      });
    }
  }

  close() {
    try {
      this.db.close();
    } catch { /* ignore */ }
  }
}
