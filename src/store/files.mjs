// 文件中转存储与过期清理（共享 HubStore 的 hub.db files 表，Blob 落盘 <configDir>/files/blobs）。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const DEFAULT_FILE_TTL_MS = 7 * 24 * 3600 * 1000;
export const FILE_ID_RE = /^[a-f0-9]{16,64}$/;

export function parseHubFileUri(uri) {
  const m = /^hub:\/\/files\/([a-f0-9]{16,64})$/.exec(String(uri || "").trim());
  return m ? m[1] : null;
}

export class FileStore {
  constructor(store, configDir, { maxFileBytes = DEFAULT_MAX_FILE_BYTES, defaultTtlMs = DEFAULT_FILE_TTL_MS } = {}) {
    this.store = store;
    this.configDir = configDir;
    this.blobsDir = path.join(configDir, "files", "blobs");
    this.maxFileBytes = Number(process.env.AH_FILE_MAX_BYTES || maxFileBytes) || DEFAULT_MAX_FILE_BYTES;
    this.defaultTtlMs = Number(process.env.AH_FILE_TTL_MS || defaultTtlMs) || DEFAULT_FILE_TTL_MS;
    fs.mkdirSync(this.blobsDir, { recursive: true });
  }

  _blobPath(id) {
    if (!FILE_ID_RE.test(String(id || ""))) {
      const err = new Error("非法 file_id");
      err.statusCode = 400;
      throw err;
    }
    return path.join(this.blobsDir, id.slice(0, 2), id);
  }

  put({ buffer, name = "file.bin", mime = "application/octet-stream", ownerNode = "", taskId = null, ttlMs } = {}) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
    if (buf.byteLength > this.maxFileBytes) {
      const err = new Error(`文件超出大小限制 (${this.maxFileBytes} bytes)`);
      err.statusCode = 413;
      throw err;
    }
    const id = crypto.randomBytes(16).toString("hex");
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const now = Date.now();
    const effectiveTtl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : this.defaultTtlMs;
    const expiresAt = now + effectiveTtl;
    const safeName = path.basename(String(name || "file.bin")).slice(0, 200) || "file.bin";
    const safeMime = String(mime || "application/octet-stream").slice(0, 120);
    const dest = this._blobPath(id);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, dest);
    try {
      fs.chmodSync(dest, 0o600);
    } catch {}

    this.store.db.prepare(`
      INSERT INTO files (id, name, mime, size, sha256, owner_node, task_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, safeName, safeMime, buf.byteLength, sha256, String(ownerNode || ""), taskId ? String(taskId) : null, now, expiresAt);

    return {
      id,
      uri: `hub://files/${id}`,
      name: safeName,
      mime: safeMime,
      size: buf.byteLength,
      sha256,
      owner_node: String(ownerNode || ""),
      task_id: taskId ? String(taskId) : null,
      created_at: now,
      expires_at: expiresAt,
    };
  }

  getMeta(id) {
    if (!FILE_ID_RE.test(String(id || ""))) return null;
    const row = this.store.db.prepare("SELECT * FROM files WHERE id = ?").get(String(id));
    if (!row) return null;
    if (Number(row.expires_at) <= Date.now()) {
      this.delete(id);
      return null;
    }
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

  readBuffer(id) {
    const meta = this.getMeta(id);
    if (!meta) return null;
    const p = this._blobPath(id);
    if (!fs.existsSync(p)) return null;
    return { meta, buffer: fs.readFileSync(p) };
  }

  delete(id) {
    if (!FILE_ID_RE.test(String(id || ""))) return false;
    const res = this.store.db.prepare("DELETE FROM files WHERE id = ?").run(String(id));
    try {
      fs.unlinkSync(this._blobPath(id));
    } catch {}
    return res.changes > 0;
  }

  sweepExpired(now = Date.now()) {
    const rows = this.store.db.prepare("SELECT id FROM files WHERE expires_at <= ?").all(now);
    let removed = 0;
    for (const r of rows) {
      if (this.delete(r.id)) removed++;
    }
    return removed;
  }
}

export class FileRetentionService {
  constructor(fileStore, { intervalMs = 3600 * 1000 } = {}) {
    this.fileStore = fileStore;
    this.intervalMs = intervalMs;
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      try {
        this.fileStore.sweepExpired();
      } catch {}
    }, this.intervalMs);
    if (typeof this._timer.unref === "function") this._timer.unref();
  }

  stop() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }
}
