// 分 Agent Token：明文只在签发响应里出现一次，落盘只留 sha256 与展示用前缀。
// last_used_at 按节点按分钟合并，避免每次 API 调用都写 agent_tokens.json。

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { httpError, issuedRole, validateRole } from "./admission.mjs";

const FILE_NAME = "agent_tokens.json";

function hashToken(token) {
  return `sha256:${createHash("sha256").update(String(token), "utf8").digest("hex")}`;
}

function hashEqual(stored, computed) {
  const a = Buffer.from(String(stored ?? ""), "utf8");
  const b = Buffer.from(String(computed ?? ""), "utf8");
  if (!a.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function normalizeScopes(raw) {
  if (raw == null) return null;
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string")) {
    throw httpError(400, "scopes 必须是字符串数组");
  }
  return [...new Set(raw.map((s) => s.trim()).filter(Boolean))];
}

function minuteKey(date) {
  return date.toISOString().slice(0, 16);
}

export class AgentTokenStore {
  constructor(configDir, { now = () => new Date() } = {}) {
    if (!configDir) throw httpError(500, "未配置 configDir，无法管理 Agent Token");
    this.path = path.join(configDir, FILE_NAME);
    this.#now = now;
    this.#touchMinute = new Map();
  }

  #now;
  #touchMinute;
  #cache = null;
  #mtimeMs = -1;

  #load() {
    if (!fs.existsSync(this.path)) {
      this.#cache = { version: 1, tokens: [] };
      this.#mtimeMs = 0;
      return this.#cache;
    }
    const st = fs.statSync(this.path);
    if (this.#cache && st.mtimeMs === this.#mtimeMs) return this.#cache;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.path, "utf8"));
    } catch {
      throw httpError(500, "agent_tokens.json 无法解析");
    }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tokens)) {
      throw httpError(500, "agent_tokens.json 格式不正确");
    }
    this.#cache = parsed;
    this.#mtimeMs = st.mtimeMs;
    return parsed;
  }

  #save(tokens) {
    const json = `${JSON.stringify({ version: 1, tokens }, null, 2)}\n`;
    const tmp = `${this.path}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, json, { mode: 0o600 });
    fs.renameSync(tmp, this.path);
    // writeFile 的 mode 会被 umask 削掉，落盘后再收到 0600，避免组/其他可读。
    fs.chmodSync(this.path, 0o600);
    this.#cache = { version: 1, tokens };
    this.#mtimeMs = fs.statSync(this.path).mtimeMs;
  }

  hasAny() {
    return this.#load().tokens.length > 0;
  }

  get(node) {
    const name = String(node ?? "").trim();
    return this.#load().tokens.find((t) => t.node === name) ?? null;
  }

  listPublic() {
    return this.#load().tokens.map((t) => ({
      node: t.node,
      role: t.role,
      scopes: Array.isArray(t.scopes) ? [...t.scopes] : [],
      prefix: t.prefix,
      created_at: t.created_at,
      last_used_at: t.last_used_at ?? null,
    }));
  }

  #mint(node, role, scopes) {
    const secret = `aht_${randomBytes(32).toString("base64url")}`;
    return {
      token: secret,
      record: {
        node,
        role,
        scopes: [...scopes],
        hash: hashToken(secret),
        prefix: secret.slice(0, 10),
        created_at: this.#now().toISOString(),
        last_used_at: null,
      },
    };
  }

  issue({ node, role, scopes = [] } = {}) {
    const name = String(node ?? "").trim();
    const normalizedRole = issuedRole(role);
    const normalizedScopes = normalizeScopes(scopes) ?? [];
    const data = this.#load();
    if (data.tokens.some((t) => t.node === name)) {
      throw httpError(409, `节点 ${name} 已有 Token，请使用 POST /api/v1/admin/tokens/${name}/rotate 轮换`);
    }
    const minted = this.#mint(name, normalizedRole, normalizedScopes);
    this.#save([...data.tokens, minted.record]);
    return { token: minted.token, ...this.#publicOf(minted.record) };
  }

  rotate({ node, role, scopes } = {}) {
    const name = String(node ?? "").trim();
    const data = this.#load();
    const idx = data.tokens.findIndex((t) => t.node === name);
    const existing = idx >= 0 ? data.tokens[idx] : null;
    // 不传 role 时保留旧记录（含历史 hybrid）。显式传入 hybrid 时收成 leader，避免新轮换再写出 hybrid。
    const normalizedRole = role == null || role === ""
      ? existing?.role
      : issuedRole(role);
    if (!normalizedRole) throw httpError(400, "新建 Token 需要 role");
    const normalizedScopes = scopes === undefined
      ? (Array.isArray(existing?.scopes) ? existing.scopes : [])
      : (normalizeScopes(scopes) ?? []);
    const minted = this.#mint(name, normalizedRole, normalizedScopes);
    const next = data.tokens.slice();
    if (idx >= 0) next[idx] = minted.record;
    else next.push(minted.record);
    this.#touchMinute.delete(name);
    this.#save(next);
    return { token: minted.token, ...this.#publicOf(minted.record) };
  }

  revoke(node) {
    const name = String(node ?? "").trim();
    const data = this.#load();
    const next = data.tokens.filter((t) => t.node !== name);
    if (next.length === data.tokens.length) return false;
    this.#touchMinute.delete(name);
    this.#save(next);
    return true;
  }

  authenticate(presented) {
    const raw = String(presented ?? "").trim();
    if (!raw) return null;
    const data = this.#load();
    const computed = hashToken(raw);
    let found = null;
    for (const record of data.tokens) {
      if (hashEqual(record.hash, computed) && !found) found = record;
    }
    if (!found) return null;
    this.#touch(found);
    return {
      node: found.node,
      role: found.role,
      scopes: Array.isArray(found.scopes) ? [...found.scopes] : [],
    };
  }

  #touch(record) {
    const minute = minuteKey(this.#now());
    if (this.#touchMinute.get(record.node) === minute) return;
    const prev = record.last_used_at ? String(record.last_used_at).slice(0, 16) : "";
    if (prev === minute) {
      this.#touchMinute.set(record.node, minute);
      return;
    }
    record.last_used_at = this.#now().toISOString();
    this.#touchMinute.set(record.node, minute);
    this.#save(this.#load().tokens);
  }

  #publicOf(record) {
    return {
      node: record.node,
      role: record.role,
      scopes: [...record.scopes],
      prefix: record.prefix,
      created_at: record.created_at,
      last_used_at: record.last_used_at,
    };
  }
}
