// HTTP 总线客户端（供远程接入节点与远程 CLI 连接独立 Hub 服务端）。
// 只发起出站 HTTP 请求（REST 读写 + 长轮询唤醒），节点本身不开任何监听端口。

import { randomUUID } from "node:crypto";
import { f1 } from "./tables.mjs";
import { normalizeTables } from "./tables.mjs";
import { log as defaultLog } from "../kernel-util.mjs";

const DEFAULT_DELAYS_MS = [0, 1000, 3000, 8000];
const STAT_KINDS = new Set(["list", "get", "write", "other"]);

function netReason(e) {
  const code = e?.cause?.code ?? e?.code;
  if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return `net-${code}`;
  return "error";
}

export class HttpBus {
  constructor({ hubUrl, apiToken = "", node = "", tables, log, delaysMs } = {}) {
    const base = String(hubUrl ?? "").trim().replace(/\/+$/, "");
    if (!base) throw new Error("HttpBus 需要 hubUrl");
    this.hubUrl = base;
    this.apiToken = String(apiToken ?? "").trim();
    this.node = String(node ?? "").trim();
    this.tables = normalizeTables(tables);
    this.log = log ?? defaultLog;
    this._delays = Array.isArray(delaysMs) && delaysMs.length ? delaysMs : DEFAULT_DELAYS_MS;
    this._stats = { list: 0, get: 0, write: 0, other: 0, backoff: 0 };
  }

  takeStats() {
    const snap = { ...this._stats };
    this._stats = { list: 0, get: 0, write: 0, other: 0, backoff: 0 };
    return snap;
  }

  async tenantToken() {
    return this.apiToken || "http-bus";
  }

  _headers(hasBody = false) {
    const h = {};
    if (this.apiToken) h.Authorization = `Bearer ${this.apiToken}`;
    if (this.node) h["X-A2A-Node"] = this.node;
    if (hasBody) h["Content-Type"] = "application/json";
    return h;
  }

  async api(method, path, payload, kind = "other") {
    if (!STAT_KINDS.has(kind)) kind = "other";
    let reason = "error";
    const delays = this._delays;
    for (let i = 0; i < delays.length; i++) {
      if (i > 0) {
        this._stats.backoff += 1;
        this.log(`http bus backoff reason=${reason} kind=${kind} retry=${i}/${delays.length - 1} wait=${delays[i] / 1000}s`);
        if (delays[i]) await new Promise((res) => setTimeout(res, delays[i]));
      }
      try {
        this._stats[kind] += 1;
        const r = await fetch(`${this.hubUrl}${path}`, {
          method,
          headers: this._headers(payload !== undefined),
          body: payload !== undefined ? JSON.stringify(payload) : undefined,
        });
        if (r.status === 429 || r.status === 500 || r.status === 502 || r.status === 503) {
          reason = `http-${r.status}`;
          continue;
        }
        const text = await r.text();
        let d = {};
        try { d = text ? JSON.parse(text) : {}; } catch { d = { error: text }; }
        if (!r.ok) {
          const msg = d?.error || d?.msg || `HTTP ${r.status}`;
          throw new Error(`api code ${r.status}: ${msg}`);
        }
        return d?.data !== undefined ? d.data : d;
      } catch (e) {
        if (String(e?.message ?? "").startsWith("api code")) throw e;
        reason = netReason(e);
      }
    }
    throw new Error("http bus retry exhausted: " + reason);
  }

  async listRecords(table) {
    const d = await this.api("GET", `/api/v1/tables/${encodeURIComponent(table)}/records`, undefined, "list");
    return d.items ?? [];
  }

  async getRecord(table, recordId) {
    try {
      const d = await this.api("GET", `/api/v1/tables/${encodeURIComponent(table)}/records/${encodeURIComponent(recordId)}`, undefined, "get");
      return d.record ?? null;
    } catch (e) {
      if (String(e?.message ?? "").startsWith("api code 404:")) return null;
      throw e;
    }
  }

  async findRecords(table, field, value) {
    const rows = await this.listRecords(table);
    return rows.filter((row) => f1(row, field) === value);
  }

  createRecord(table, fields, clientToken) {
    const token = clientToken || randomUUID();
    const q = "client_token=" + encodeURIComponent(token);
    return this.api(
      "POST",
      `/api/v1/tables/${encodeURIComponent(table)}/records?${q}`,
      { fields },
      "write",
    );
  }

  updateRecord(table, recordId, fields) {
    return this.api(
      "PUT",
      `/api/v1/tables/${encodeURIComponent(table)}/records/${encodeURIComponent(recordId)}`,
      { fields },
      "write",
    );
  }

  sendMessage(receiveId, msgType, content, receiveIdType = "open_id") {
    return this.api("POST", "/api/v1/im/messages", {
      receive_id: receiveId,
      receive_id_type: receiveIdType,
      msg_type: msgType,
      content: typeof content === "string" ? content : JSON.stringify(content),
    }, "other");
  }

  sendCard(openId, card) {
    return this.sendMessage(openId, "interactive", card, "open_id");
  }

  patchInteractiveCard(messageId, card) {
    const content = typeof card === "string" ? card : JSON.stringify(card);
    return this.api("PATCH", `/api/v1/im/messages/${encodeURIComponent(String(messageId))}`, { content }, "other");
  }

  // 供长轮询唤醒器调用，不计入表读写统计。
  async waitForChanges({ node, cursor = 0, timeoutSec = 25, signal } = {}) {
    const target = encodeURIComponent(String(node ?? this.node ?? "*"));
    const cur = encodeURIComponent(String(Number(cursor) || 0));
    const sec = encodeURIComponent(String(Math.max(0, Math.min(60, Number(timeoutSec) || 25))));
    const r = await fetch(`${this.hubUrl}/api/v1/poll?node=${target}&cursor=${cur}&timeout=${sec}`, {
      method: "GET",
      headers: this._headers(false),
      signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      const err = new Error(`poll HTTP ${r.status}: ${body || r.statusText}`);
      err.status = r.status;
      throw err;
    }
    return await r.json();
  }
}
