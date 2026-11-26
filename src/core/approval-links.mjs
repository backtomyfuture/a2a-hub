// 一次性审批链接：把「机主本人点了批准」从控制台搬到任意推送渠道（Bark / 飞书群 / Telegram / 邮件）。
// 链接只是证明点击来自持有链接的人，真正的放行签名仍由 TaskService 用 Hub 私钥完成，执行端验签逻辑不变。
// 令牌 = base64url(JSON{t,r,e,n}) + "." + HMAC-SHA256，绑定任务、审批请求与过期时间；nonce 记入 idempotency 表保证只能用一次。

import crypto from "node:crypto";
import { extractLastAuthRequest } from "./approval-sign.mjs";

const LINK_SCOPE = "approval_link";
const DEFAULT_LINK_TTL_MIN = 30;
const MAX_LINK_TTL_MIN = 24 * 60;
const DEFAULT_APPROVAL_TIMEOUT_MIN = 24 * 60;

function truthy(v) {
  return ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());
}

function clampInt(v, fallback, min, max) {
  const raw = String(v ?? "").trim();
  if (!raw) return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export function resolveApprovalSettings(env = {}) {
  return {
    linksEnabled: truthy(env.AH_APPROVAL_LINKS),
    linkTtlMin: clampInt(env.AH_APPROVAL_LINK_TTL_MIN, DEFAULT_LINK_TTL_MIN, 1, MAX_LINK_TTL_MIN),
    // 0 关闭超时；上限 30 天
    timeoutMin: clampInt(env.AH_APPROVAL_TIMEOUT_MIN, DEFAULT_APPROVAL_TIMEOUT_MIN, 0, 30 * 24 * 60),
  };
}

// 链接密钥从 Hub 审批私钥派生：不新增需要保管的密钥文件，私钥轮换后旧链接自然全部失效。
function deriveLinkKey(privateKey) {
  const der = privateKey && typeof privateKey === "object" && typeof privateKey.export === "function"
    ? privateKey.export({ type: "pkcs8", format: "der" })
    : Buffer.from(String(privateKey || ""), "utf8");
  return crypto.createHash("sha256").update("ah-approval-link-v1\n").update(der).digest();
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export class ApprovalLinkService {
  constructor({ store, privateKey, hubUrlResolver = null, envResolver = () => ({}) } = {}) {
    this.store = store;
    this.key = deriveLinkKey(privateKey);
    this.hubUrlResolver = hubUrlResolver;
    this.envResolver = envResolver;
  }

  settings() {
    return resolveApprovalSettings(this.envResolver() || {});
  }

  isEnabled() {
    return this.settings().linksEnabled;
  }

  _sign(payloadB64) {
    return crypto.createHmac("sha256", this.key).update(payloadB64).digest("base64url");
  }

  issue({ taskId, requestId, now = Date.now(), ttlMin } = {}) {
    const minutes = Number(ttlMin) > 0 ? Number(ttlMin) : this.settings().linkTtlMin;
    const exp = now + minutes * 60_000;
    const payload = b64url(JSON.stringify({
      t: String(taskId),
      r: String(requestId || "default"),
      e: exp,
      n: crypto.randomBytes(12).toString("base64url"),
    }));
    const token = `${payload}.${this._sign(payload)}`;
    const base = typeof this.hubUrlResolver === "function" ? String(this.hubUrlResolver() || "").replace(/\/+$/, "") : "";
    return { token, url: base ? `${base}/approve/${token}` : `/approve/${token}`, expiresAt: exp };
  }

  // 为任务当前最新的审批请求签发链接；任务不在 auth-required 时返回 null。
  issueForTask(taskId, opts = {}) {
    const task = this.store.getTask(taskId);
    if (!task || task.state !== "auth-required") return null;
    const authReq = extractLastAuthRequest({ messages: this.store.listMessages(taskId) });
    return this.issue({ taskId, requestId: authReq?.data?.request_id || "default", ...opts });
  }

  verify(token, now = Date.now()) {
    const parts = String(token || "").split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, code: "invalid_link", message: "链接格式不正确" };
    const [payloadB64, sig] = parts;
    const expected = Buffer.from(this._sign(payloadB64));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      return { ok: false, code: "invalid_link", message: "链接签名无效" };
    }
    let data;
    try {
      data = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    } catch {
      return { ok: false, code: "invalid_link", message: "链接内容无法解析" };
    }
    if (!data?.t || !data?.n || !Number.isFinite(Number(data.e))) {
      return { ok: false, code: "invalid_link", message: "链接内容不完整" };
    }
    if (Number(data.e) <= now) return { ok: false, code: "link_expired", message: "链接已过期" };
    if (this.isUsed(data.n)) return { ok: false, code: "link_used", message: "链接已被使用" };
    return { ok: true, taskId: String(data.t), requestId: String(data.r || "default"), expiresAt: Number(data.e), nonce: String(data.n) };
  }

  isUsed(nonce) {
    return Boolean(this.store.getIdempotency(LINK_SCOPE, nonce));
  }

  // 原子占用 nonce：并发的两次提交只有一次返回 true。
  consume(nonce, info = {}) {
    const res = this.store.db.prepare(`
      INSERT INTO idempotency (scope, token_key, result_json, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(scope, token_key) DO NOTHING
    `).run(LINK_SCOPE, String(nonce), JSON.stringify({ used_at: Date.now(), ...info }), Date.now());
    return res.changes > 0;
  }
}
