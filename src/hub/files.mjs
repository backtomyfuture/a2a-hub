// 中台托管附件存储、URI 解析、引用查询与过期清理服务（docs/attachments.md §2、§4）。
// 内容落 <configDir>/files/blobs/<2位hex>/<file_id>（目录 0700、文件 0600），
// 元数据索引落 <configDir>/files/files.db（node:sqlite WAL）。

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { f1 } from "../bus/tables.mjs";
import { TERMINAL_STATUSES } from "../kernel-util.mjs";
import { httpError } from "./admission.mjs";

export const HUB_FILE_URI_PREFIX = "hub://files/";
export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_UNREFERENCED_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_EXPIRED_MS = 30 * 24 * 60 * 60 * 1000;

const FILE_ID_RE = /^F-[0-9a-f]{32}$/;

function isValidFileId(id) {
  return typeof id === "string" && FILE_ID_RE.test(id);
}

function ensureDir0700(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir 的 mode 会被 umask 削掉，显式收回 0700。
  fs.chmodSync(dir, 0o700);
}

function truncateUtf8Bytes(str, maxBytes = 255) {
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
  let out = "";
  let used = 0;
  for (const ch of str) {
    const b = Buffer.byteLength(ch, "utf8");
    if (used + b > maxBytes) break;
    out += ch;
    used += b;
  }
  return out;
}

// 清洗文件名：去掉路径分隔符与控制字符，按 UTF-8 截到 255 字节（§1）。
export function sanitizeFileName(raw, fallback = "file") {
  const cleaned = String(raw ?? "")
    .replace(/[/\\\x00-\x1f\x7f]+/g, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  const clipped = truncateUtf8Bytes(cleaned, 255).trim();
  if (!clipped || clipped === "." || clipped === "..") return fallback;
  return clipped;
}

// 去掉参数与控制字符，统一小写 media type，缺省 octet-stream。
export function normalizeMime(raw) {
  const clean = String(raw ?? "")
    .replace(/[\r\n\x00-\x1f\x7f]+/g, "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return clean || "application/octet-stream";
}

export function parseHubFileUri(uri) {
  const s = String(uri ?? "").trim();
  if (!s.startsWith(HUB_FILE_URI_PREFIX)) return null;
  const id = s.slice(HUB_FILE_URI_PREFIX.length);
  return isValidFileId(id) ? id : null;
}

function rowToMeta(row) {
  if (!row) return null;
  return {
    file_id: row.file_id,
    uri: `${HUB_FILE_URI_PREFIX}${row.file_id}`,
    name: row.name,
    mime: row.mime,
    size: Number(row.size),
    sha256: row.sha256,
    uploaded_by: row.uploaded_by,
    created_at: row.created_at,
    deleted_at: row.deleted_at ?? null,
  };
}

function toIso(nowFn) {
  const raw = nowFn();
  const d = raw instanceof Date ? raw : new Date(raw);
  return d.toISOString();
}

function toEpochMs(nowFn) {
  const raw = nowFn();
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "number") return raw;
  return Date.parse(String(raw));
}

export class FileStore {
  constructor({ configDir, maxBytes = DEFAULT_MAX_FILE_BYTES, now = () => new Date() } = {}) {
    if (!configDir) throw new Error("FileStore 需要 configDir");
    const limit = Number(maxBytes);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`maxBytes 必须是正数：${maxBytes}`);
    }
    this.configDir = path.resolve(String(configDir));
    this.maxBytes = Math.floor(limit);
    this.#now = now;

    this.filesDir = path.join(this.configDir, "files");
    this.blobsDir = path.join(this.filesDir, "blobs");
    this.tmpDir = path.join(this.blobsDir, ".tmp");
    this.dbPath = path.join(this.filesDir, "files.db");

    ensureDir0700(this.filesDir);
    ensureDir0700(this.blobsDir);
    ensureDir0700(this.tmpDir);

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blobs (
        file_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        uploaded_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_blobs_active ON blobs(deleted_at, created_at);
    `);

    this.#stmts = {
      insert: this.db.prepare(`
        INSERT INTO blobs (file_id, name, mime, size, sha256, uploaded_by, created_at, deleted_at, deleted_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `),
      get: this.db.prepare("SELECT * FROM blobs WHERE file_id = ?"),
      listActive: this.db.prepare("SELECT * FROM blobs WHERE deleted_at IS NULL ORDER BY created_at ASC"),
      markDeleted: this.db.prepare("UPDATE blobs SET deleted_at = ?, deleted_reason = ? WHERE file_id = ?"),
    };
  }

  #now;
  #stmts;

  blobPath(fileId) {
    if (!isValidFileId(fileId)) return "";
    // 取 F- 之后的前 2 位 hex 做分片目录，避免单目录文件过多。
    return path.join(this.blobsDir, fileId.slice(2, 4), fileId);
  }

  async putStream(readable, { name = "file", mime = "application/octet-stream", uploadedBy = "owner" } = {}) {
    if (!readable || typeof readable[Symbol.asyncIterator] !== "function") {
      throw httpError(400, "上传内容必须是可读流");
    }
    const cleanName = sanitizeFileName(name, "file");
    const cleanMime = normalizeMime(mime);
    const uploader = String(uploadedBy ?? "").trim() || "owner";

    ensureDir0700(this.tmpDir);
    const tmpPath = path.join(this.tmpDir, `upload-${process.pid}-${randomBytes(8).toString("hex")}`);
    const hash = createHash("sha256");
    let size = 0;
    let closed = false;
    let moved = false;

    const fh = await fs.promises.open(tmpPath, "wx", 0o600);
    try {
      for await (const rawChunk of readable) {
        const buf = Buffer.isBuffer(rawChunk)
          ? rawChunk
          : (ArrayBuffer.isView(rawChunk)
            ? Buffer.from(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength)
            : Buffer.from(rawChunk));
        size += buf.length;
        if (size > this.maxBytes) {
          const err = new Error(`文件大小超过上限（${this.maxBytes} 字节）`);
          err.status = 413;
          throw err;
        }
        if (buf.length > 0) {
          hash.update(buf);
          await fh.write(buf, 0, buf.length);
        }
      }
      await fh.close();
      closed = true;

      const fileId = `F-${randomBytes(16).toString("hex")}`;
      const shardDir = path.join(this.blobsDir, fileId.slice(2, 4));
      ensureDir0700(shardDir);
      const destPath = path.join(shardDir, fileId);
      await fs.promises.rename(tmpPath, destPath);
      moved = true;
      await fs.promises.chmod(destPath, 0o600);

      const sha256 = hash.digest("hex");
      const createdAt = toIso(this.#now);
      try {
        this.#stmts.insert.run(fileId, cleanName, cleanMime, size, sha256, uploader, createdAt);
      } catch (err) {
        // 写索引失败时回滚已落盘的内容文件，避免留下孤儿文件。
        await fs.promises.unlink(destPath).catch(() => {});
        throw err;
      }

      return {
        file_id: fileId,
        uri: `${HUB_FILE_URI_PREFIX}${fileId}`,
        name: cleanName,
        mime: cleanMime,
        size,
        sha256,
        uploaded_by: uploader,
        created_at: createdAt,
        deleted_at: null,
      };
    } finally {
      if (!closed) {
        await fh.close().catch(() => {});
      }
      if (!moved) {
        await fs.promises.unlink(tmpPath).catch(() => {});
      }
    }
  }

  async putFile(localPath, opts = {}) {
    const filePath = path.resolve(String(localPath ?? ""));
    const st = await fs.promises.stat(filePath);
    if (!st.isFile()) {
      throw httpError(400, `不是普通文件：${filePath}`);
    }
    if (st.size > this.maxBytes) {
      const err = new Error(`文件大小超过上限（${this.maxBytes} 字节）`);
      err.status = 413;
      throw err;
    }
    const name = opts.name ?? path.basename(filePath);
    const rs = fs.createReadStream(filePath);
    return await this.putStream(rs, { ...opts, name });
  }

  #getRow(fileId) {
    const id = String(fileId ?? "").trim();
    if (!isValidFileId(id)) return null;
    return this.#stmts.get.get(id) ?? null;
  }

  get(fileId) {
    return rowToMeta(this.#getRow(fileId));
  }

  getReason(fileId) {
    return this.#getRow(fileId)?.deleted_reason ?? null;
  }

  openReadStream(fileId) {
    const row = this.#getRow(fileId);
    if (!row) throw httpError(404, "文件不存在");
    if (row.deleted_at) {
      const err = httpError(410, "文件已过期清理");
      err.code = "EXPIRED";
      err.deleted_at = row.deleted_at;
      err.reason = row.deleted_reason || "expired";
      throw err;
    }
    const destPath = this.blobPath(row.file_id);
    if (!destPath || !fs.existsSync(destPath)) {
      throw httpError(404, "文件内容不存在");
    }
    return fs.createReadStream(destPath);
  }

  markDeleted(fileId, reason = "deleted") {
    const row = this.#getRow(fileId);
    if (!row) return null;
    const destPath = this.blobPath(row.file_id);
    if (destPath) {
      try {
        fs.unlinkSync(destPath);
      } catch (e) {
        if (e?.code !== "ENOENT") throw e;
      }
    }
    if (!row.deleted_at) {
      const deletedAt = toIso(this.#now);
      const cleanReason = String(reason ?? "").trim() || "deleted";
      this.#stmts.markDeleted.run(deletedAt, cleanReason, row.file_id);
    }
    return this.get(row.file_id);
  }

  listActive() {
    return this.#stmts.listActive.all().map(rowToMeta);
  }

  close() {
    try {
      this.db.close();
    } catch {
      // 重复关闭时忽略
    }
  }
}

// 扫描 Parts 中引用了指定 fileId 的所有记录，回溯到所属 Task_ID（§2）。
export async function findFileRefs(bus, fileId) {
  if (!bus?.tables?.parts) return [];
  const raw = String(fileId ?? "").trim();
  const id = raw.startsWith(HUB_FILE_URI_PREFIX) ? parseHubFileUri(raw) : (isValidFileId(raw) ? raw : null);
  if (!id) return [];

  const targetUri = `${HUB_FILE_URI_PREFIX}${id}`;
  const parts = await bus.listRecords(bus.tables.parts);
  const matching = parts.filter((p) => String(f1(p, "File_URI") ?? "").trim() === targetUri);
  if (!matching.length) return [];

  const needMessages = matching.some((p) => {
    const pt = String(f1(p, "Parent_Type") ?? "").trim();
    return !pt || pt === "message";
  });
  const needArtifacts = matching.some((p) => String(f1(p, "Parent_Type") ?? "").trim() === "artifact");

  const [messages, artifacts] = await Promise.all([
    needMessages && bus.tables.messages ? bus.listRecords(bus.tables.messages) : Promise.resolve([]),
    needArtifacts && bus.tables.artifacts ? bus.listRecords(bus.tables.artifacts) : Promise.resolve([]),
  ]);

  const msgTaskById = new Map();
  for (const m of messages) {
    const mid = String(f1(m, "Msg_ID") ?? "").trim();
    const tid = String(f1(m, "Task_ID") ?? "").trim();
    if (mid && tid) msgTaskById.set(mid, tid);
  }

  const artTaskById = new Map();
  for (const a of artifacts) {
    const aid = String(f1(a, "Artifact_ID") ?? "").trim();
    const tid = String(f1(a, "Task_ID") ?? "").trim();
    if (aid && tid) artTaskById.set(aid, tid);
  }

  const refs = [];
  for (const p of matching) {
    const parentType = String(f1(p, "Parent_Type") ?? "").trim() || "message";
    const parentId = String(f1(p, "Parent_ID") ?? "").trim();
    const taskId = parentType === "artifact"
      ? (artTaskById.get(parentId) || "")
      : (msgTaskById.get(parentId) || "");
    refs.push({
      task_id: taskId,
      parent_type: parentType,
      parent_id: parentId,
    });
  }
  return refs;
}

// 定期清理过期与孤立文件：
// - 无任何 Part 引用且上传 >= 24 小时：删，reason = "unreferenced"
// - 上传 >= 30 天且所有引用任务都已终态：删，reason = "expired"
// - 仍有非终态任务引用的跳过（§4）
export class FileRetentionService {
  constructor({
    fileStore,
    bus,
    now = () => new Date(),
    log = () => {},
    unreferencedMs = DEFAULT_UNREFERENCED_MS,
    expiredMs = DEFAULT_EXPIRED_MS,
  } = {}) {
    if (!fileStore) throw new Error("FileRetentionService 需要 fileStore");
    this.fileStore = fileStore;
    this.bus = bus;
    this.now = now;
    this.log = log;
    this.unreferencedMs = unreferencedMs;
    this.expiredMs = expiredMs;
    this._stopped = false;
    this._running = false;
    this._initialTimer = null;
    this._intervalTimer = null;
  }

  async scan() {
    const active = this.fileStore.listActive();
    if (!active.length) {
      return { scanned: 0, deleted: 0, skipped: 0, unreferenced: 0, expired: 0 };
    }
    const nowMs = toEpochMs(this.now);

    const [parts, messages, artifacts, tasks] = await Promise.all([
      this.bus?.tables?.parts ? this.bus.listRecords(this.bus.tables.parts) : Promise.resolve([]),
      this.bus?.tables?.messages ? this.bus.listRecords(this.bus.tables.messages) : Promise.resolve([]),
      this.bus?.tables?.artifacts ? this.bus.listRecords(this.bus.tables.artifacts) : Promise.resolve([]),
      this.bus?.tables?.tasks ? this.bus.listRecords(this.bus.tables.tasks) : Promise.resolve([]),
    ]);

    const msgTaskById = new Map();
    for (const m of messages) {
      const mid = String(f1(m, "Msg_ID") ?? "").trim();
      const tid = String(f1(m, "Task_ID") ?? "").trim();
      if (mid && tid) msgTaskById.set(mid, tid);
    }
    const artTaskById = new Map();
    for (const a of artifacts) {
      const aid = String(f1(a, "Artifact_ID") ?? "").trim();
      const tid = String(f1(a, "Task_ID") ?? "").trim();
      if (aid && tid) artTaskById.set(aid, tid);
    }
    const taskStatusById = new Map();
    for (const t of tasks) {
      const tid = String(f1(t, "Task_ID") ?? "").trim();
      const st = String(f1(t, "Status") ?? "").trim();
      if (tid) taskStatusById.set(tid, st);
    }

    // uri -> { hasPart: boolean, taskIds: Set<string> }
    const refsByUri = new Map();
    for (const p of parts) {
      const uri = String(f1(p, "File_URI") ?? "").trim();
      if (!uri.startsWith(HUB_FILE_URI_PREFIX)) continue;
      let entry = refsByUri.get(uri);
      if (!entry) {
        entry = { hasPart: true, taskIds: new Set() };
        refsByUri.set(uri, entry);
      }
      const parentType = String(f1(p, "Parent_Type") ?? "").trim() || "message";
      const parentId = String(f1(p, "Parent_ID") ?? "").trim();
      const tid = parentType === "artifact"
        ? artTaskById.get(parentId)
        : msgTaskById.get(parentId);
      if (tid) entry.taskIds.add(tid);
    }

    let deleted = 0;
    let skipped = 0;
    let unreferenced = 0;
    let expired = 0;

    for (const blob of active) {
      const createdMs = Date.parse(blob.created_at);
      if (!Number.isFinite(createdMs)) {
        skipped += 1;
        continue;
      }
      const ageMs = nowMs - createdMs;
      const ref = refsByUri.get(blob.uri);

      if (!ref) {
        if (ageMs >= this.unreferencedMs) {
          this.fileStore.markDeleted(blob.file_id, "unreferenced");
          deleted += 1;
          unreferenced += 1;
        } else {
          skipped += 1;
        }
        continue;
      }

      if (ageMs < this.expiredMs) {
        skipped += 1;
        continue;
      }

      // 只要存在任一引用任务尚未进入终态（或找不到对应任务记录），就不删除。
      const allTerminal = ref.taskIds.size > 0 && Array.from(ref.taskIds).every((tid) => {
        const status = taskStatusById.get(tid);
        return TERMINAL_STATUSES.has(status);
      });

      if (allTerminal) {
        this.fileStore.markDeleted(blob.file_id, "expired");
        deleted += 1;
        expired += 1;
      } else {
        skipped += 1;
      }
    }

    return { scanned: active.length, deleted, skipped, unreferenced, expired };
  }

  async #runTick() {
    if (this._stopped || this._running) return;
    this._running = true;
    try {
      const res = await this.scan();
      if (res.deleted > 0) {
        this.log(`文件清理完成：扫描 ${res.scanned}，删除 ${res.deleted}（未引用 ${res.unreferenced}，过期 ${res.expired}）`);
      }
    } catch (e) {
      this.log(`文件清理失败（下轮重试）：${e?.message ?? e}`);
    } finally {
      this._running = false;
    }
  }

  start({ initialDelayMs = 60_000, intervalMs = 60 * 60_000 } = {}) {
    this.stop();
    this._stopped = false;
    this._initialTimer = setTimeout(async () => {
      this._initialTimer = null;
      if (this._stopped) return;
      await this.#runTick();
      if (this._stopped) return;
      this._intervalTimer = setInterval(() => {
        void this.#runTick();
      }, intervalMs);
      this._intervalTimer.unref?.();
    }, initialDelayMs);
    this._initialTimer.unref?.();
  }

  stop() {
    this._stopped = true;
    if (this._initialTimer) {
      clearTimeout(this._initialTimer);
      this._initialTimer = null;
    }
    if (this._intervalTimer) {
      clearInterval(this._intervalTimer);
      this._intervalTimer = null;
    }
  }
}
