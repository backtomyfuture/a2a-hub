// 统一文件客户端（docs/attachments.md §5）：
// - LocalFileClient：中台本机（busType=sqlite）直接读写 FileStore
// - HttpFileClient：远端节点 / CLI / inbox 经 Bearer HTTP 流式上传下载

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BROWSER_USER_AGENT, log as defaultLog } from "./kernel-util.mjs";
import { FileStore, normalizeMime, parseHubFileUri, sanitizeFileName } from "./hub/files.mjs";

const DEFAULT_DELAYS_MS = [0, 1000, 3000, 8000];

export const MIME_BY_EXT = Object.freeze({
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".sh": "text/x-shellscript",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
});

export function guessMime(filePath) {
  const ext = path.extname(String(filePath ?? "")).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function makeCodedError(message, { status, code, deleted_at, reason } = {}) {
  const err = new Error(message);
  if (status !== undefined) err.status = status;
  if (code !== undefined) err.code = code;
  if (deleted_at !== undefined) err.deleted_at = deleted_at;
  if (reason !== undefined) err.reason = reason;
  return err;
}

function shouldRetryStatus(status) {
  return status === 429 || status >= 500;
}

export class LocalFileClient {
  constructor(fileStoreOrOpts, { ownsStore = false } = {}) {
    if (fileStoreOrOpts && typeof fileStoreOrOpts.putFile === "function") {
      this.store = fileStoreOrOpts;
      this.#ownsStore = ownsStore;
    } else if (fileStoreOrOpts?.fileStore && typeof fileStoreOrOpts.fileStore.putFile === "function") {
      this.store = fileStoreOrOpts.fileStore;
      this.#ownsStore = Boolean(fileStoreOrOpts.ownsStore);
    } else if (fileStoreOrOpts?.configDir) {
      this.store = new FileStore({
        configDir: fileStoreOrOpts.configDir,
        ...(fileStoreOrOpts.maxBytes ? { maxBytes: fileStoreOrOpts.maxBytes } : {}),
      });
      this.#ownsStore = true;
    } else {
      throw new Error("LocalFileClient 需要 FileStore 或 configDir");
    }
  }

  #ownsStore;

  async upload(localPath, { name, mime, uploadedBy } = {}) {
    const filePath = path.resolve(String(localPath ?? ""));
    const resolvedName = sanitizeFileName(name ?? path.basename(filePath), "file");
    const resolvedMime = mime ? normalizeMime(mime) : guessMime(name || filePath);
    return await this.store.putFile(filePath, {
      name: resolvedName,
      mime: resolvedMime,
      uploadedBy: uploadedBy ?? "owner",
    });
  }

  async download(uri, destPath) {
    const fileId = parseHubFileUri(uri);
    if (!fileId) {
      throw makeCodedError(`仅支持 hub://files/<id> 地址：${uri}`, { status: 400, code: "INVALID_URI" });
    }
    const meta = this.store.get(fileId);
    if (!meta) {
      throw makeCodedError(`文件不存在：${uri}`, { status: 404, code: "NOT_FOUND" });
    }
    if (meta.deleted_at) {
      throw makeCodedError("文件已过期清理", {
        status: 410,
        code: "EXPIRED",
        deleted_at: meta.deleted_at,
        reason: this.store.getReason(fileId) || "expired",
      });
    }

    const outPath = path.resolve(String(destPath ?? ""));
    const outDir = path.dirname(outPath);
    fs.mkdirSync(outDir, { recursive: true });
    const tmpPath = path.join(outDir, `.download-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);

    let rs;
    try {
      rs = this.store.openReadStream(fileId);
    } catch (e) {
      if (Number(e?.status) === 410) {
        throw makeCodedError(e.message, {
          status: 410,
          code: "EXPIRED",
          deleted_at: e.deleted_at,
          reason: e.reason,
        });
      }
      if (Number(e?.status) === 404) {
        throw makeCodedError(e.message, { status: 404, code: "NOT_FOUND" });
      }
      throw e;
    }

    try {
      await pipeline(rs, fs.createWriteStream(tmpPath, { mode: 0o600 }));
      await fs.promises.rename(tmpPath, outPath);
      await fs.promises.chmod(outPath, 0o600);
      return { path: outPath, size: meta.size, mime: meta.mime };
    } catch (e) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      throw e;
    }
  }

  close() {
    if (this.#ownsStore) {
      this.store.close();
    }
  }
}

export class HttpFileClient {
  constructor({ hubUrl, apiToken = "", node = "", log, delaysMs } = {}) {
    const base = String(hubUrl ?? "").trim().replace(/\/+$/, "");
    if (!base) throw new Error("HttpFileClient 需要 hubUrl");
    this.hubUrl = base;
    this.apiToken = String(apiToken ?? "").trim();
    this.node = String(node ?? "").trim();
    this.log = log ?? defaultLog;
    this._delays = Array.isArray(delaysMs) && delaysMs.length ? delaysMs : DEFAULT_DELAYS_MS;
  }

  _headers(extra = {}) {
    const h = { "User-Agent": BROWSER_USER_AGENT, ...extra };
    if (this.apiToken) h.Authorization = `Bearer ${this.apiToken}`;
    if (this.node) h["X-A2A-Node"] = this.node;
    return h;
  }

  async upload(localPath, { name, mime } = {}) {
    const filePath = path.resolve(String(localPath ?? ""));
    const st = await fs.promises.stat(filePath);
    if (!st.isFile()) {
      throw makeCodedError(`不是普通文件：${filePath}`, { status: 400 });
    }
    const resolvedName = sanitizeFileName(name ?? path.basename(filePath), "file");
    const resolvedMime = mime ? normalizeMime(mime) : guessMime(name || filePath);

    let lastErr = null;
    for (let i = 0; i < this._delays.length; i++) {
      if (i > 0) {
        this.log(`http file upload backoff retry=${i}/${this._delays.length - 1} wait=${this._delays[i] / 1000}s`);
        if (this._delays[i]) await new Promise((res) => setTimeout(res, this._delays[i]));
      }
      const rs = fs.createReadStream(filePath);
      try {
        const res = await fetch(`${this.hubUrl}/api/v1/files`, {
          method: "POST",
          headers: this._headers({
            "Content-Type": resolvedMime,
            "Content-Length": String(st.size),
            "X-File-Name": encodeURIComponent(resolvedName),
          }),
          body: Readable.toWeb(rs),
          duplex: "half",
        });

        if (shouldRetryStatus(res.status)) {
          await res.body?.cancel().catch(() => {});
          lastErr = makeCodedError(`HTTP ${res.status}`, { status: res.status });
          continue;
        }

        const text = await res.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }

        if (!res.ok) {
          throw makeCodedError(data?.error || `HTTP ${res.status}`, { status: res.status });
        }
        return data;
      } catch (err) {
        if (err?.status && !shouldRetryStatus(err.status)) throw err;
        lastErr = err;
      } finally {
        if (!rs.destroyed) rs.destroy();
      }
    }
    throw lastErr || new Error("http file upload retry exhausted");
  }

  async download(uri, destPath) {
    const fileId = parseHubFileUri(uri);
    if (!fileId) {
      throw makeCodedError(`仅支持 hub://files/<id> 地址：${uri}`, { status: 400, code: "INVALID_URI" });
    }

    const outPath = path.resolve(String(destPath ?? ""));
    const outDir = path.dirname(outPath);
    fs.mkdirSync(outDir, { recursive: true });

    let lastErr = null;
    for (let i = 0; i < this._delays.length; i++) {
      if (i > 0) {
        this.log(`http file download backoff retry=${i}/${this._delays.length - 1} wait=${this._delays[i] / 1000}s`);
        if (this._delays[i]) await new Promise((res) => setTimeout(res, this._delays[i]));
      }
      const tmpPath = path.join(outDir, `.download-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
      try {
        const res = await fetch(`${this.hubUrl}/api/v1/files/${encodeURIComponent(fileId)}`, {
          method: "GET",
          headers: this._headers(),
        });

        if (res.status === 410) {
          const data = await res.json().catch(() => ({}));
          throw makeCodedError(data?.error || "文件已过期清理", {
            status: 410,
            code: "EXPIRED",
            deleted_at: data?.deleted_at ?? null,
            reason: data?.reason ?? "expired",
          });
        }
        if (res.status === 404) {
          const data = await res.json().catch(() => ({}));
          throw makeCodedError(data?.error || `文件不存在：${uri}`, {
            status: 404,
            code: "NOT_FOUND",
          });
        }
        if (shouldRetryStatus(res.status)) {
          await res.body?.cancel().catch(() => {});
          lastErr = makeCodedError(`HTTP ${res.status}`, { status: res.status });
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          let data = {};
          try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
          throw makeCodedError(data?.error || `HTTP ${res.status}`, { status: res.status });
        }

        const mime = normalizeMime(res.headers.get("content-type"));
        if (res.body) {
          await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmpPath, { mode: 0o600 }));
        } else {
          await fs.promises.writeFile(tmpPath, Buffer.alloc(0), { mode: 0o600 });
        }
        const st = await fs.promises.stat(tmpPath);
        await fs.promises.rename(tmpPath, outPath);
        await fs.promises.chmod(outPath, 0o600);
        return { path: outPath, size: st.size, mime };
      } catch (err) {
        await fs.promises.unlink(tmpPath).catch(() => {});
        if (err?.status && !shouldRetryStatus(err.status)) throw err;
        lastErr = err;
      }
    }
    throw lastErr || new Error("http file download retry exhausted");
  }

  close() {}
}

export function createFileClient(cfg = {}) {
  const busType = String(cfg?.busType ?? "").trim().toLowerCase();
  if (busType === "sqlite") {
    if (cfg.fileStore) return new LocalFileClient(cfg.fileStore, { ownsStore: false });
    return new LocalFileClient({
      configDir: cfg.configDir,
      maxBytes: cfg.maxFileBytes,
    });
  }
  if (busType === "http") {
    return new HttpFileClient({
      hubUrl: cfg.hubUrl,
      apiToken: cfg.apiToken,
      node: cfg.node,
      log: cfg.log,
      delaysMs: cfg.delaysMs,
    });
  }
  if (cfg?.fileStore) return new LocalFileClient(cfg.fileStore, { ownsStore: false });
  if (cfg?.hubUrl) {
    return new HttpFileClient({
      hubUrl: cfg.hubUrl,
      apiToken: cfg.apiToken,
      node: cfg.node,
      log: cfg.log,
      delaysMs: cfg.delaysMs,
    });
  }
  if (cfg?.configDir) {
    return new LocalFileClient({
      configDir: cfg.configDir,
      maxBytes: cfg.maxFileBytes,
    });
  }
  throw new Error("createFileClient 需要 busType=sqlite（配 configDir）或 busType=http（配 hubUrl）");
}
