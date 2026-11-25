// 统一身份认证与路由级访问控制（v2.0）。
// 区分四种上下文：
// - owner：持机主 Bearer Token 或已验签 HttpOnly 会话 Cookie（全权限，含审批签名）
// - open：Hub 未设置 AH_API_TOKEN 时的免密直连（同样视为 owner，若显式带错 Bearer 仍拒收 401）
// - device：持电脑设备 Token（仅可同步自身 workers.json、长轮询并操作所属 worker 任务）
// - agent：持独立 Agent Token（仅可读写自己身份与名下任务；仅 role=leader 允许派单与拉取 updates）

import crypto from "node:crypto";
import { hashToken } from "../store/db.mjs";

export const SESSION_COOKIE_NAME = "ah_session";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

export function timingSafeEqualStr(a, b) {
  const ha = crypto.createHash("sha256").update(String(a ?? ""), "utf8").digest();
  const hb = crypto.createHash("sha256").update(String(b ?? ""), "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sessionSigningKey(ownerToken, privateKey) {
  const material = ownerToken ? `sess:${ownerToken}` : `sess:${privateKey || "open"}`;
  return crypto.createHash("sha256").update(material, "utf8").digest();
}

export function createSessionCookieValue(ownerToken, privateKey, now = Date.now()) {
  const exp = now + SESSION_TTL_MS;
  const payload = String(exp);
  const sig = crypto
    .createHmac("sha256", sessionSigningKey(ownerToken, privateKey))
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySessionCookieValue(rawValue, ownerToken, privateKey, now = Date.now()) {
  if (!ownerToken) return false;
  const parts = String(rawValue || "").split(".");
  if (parts.length !== 2) return false;
  const [expStr, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= now) return false;
  const expectedSig = crypto
    .createHmac("sha256", sessionSigningKey(ownerToken, privateKey))
    .update(expStr)
    .digest("base64url");
  return timingSafeEqualStr(sig, expectedSig);
}

export function parseCookies(req) {
  const raw = String(req.headers.cookie || "");
  const out = {};
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function extractBearerToken(req, { allowQueryToken = false } = {}) {
  const auth = String(req.headers.authorization || "");
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m) return m[1].trim();
  if (allowQueryToken && req.url) {
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      const q = String(u.searchParams.get("token") || "").trim();
      if (q) return q;
    } catch {}
  }
  return "";
}

export function resolveRequestActor(req, { ownerToken = "", store, approvalPrivateKey = null, allowQueryToken = false } = {}) {
  const bearer = extractBearerToken(req, { allowQueryToken });
  if (bearer) {
    if (ownerToken && timingSafeEqualStr(bearer, ownerToken)) {
      return { kind: "owner", id: "owner", authenticated: true };
    }
    const dbMatch = store.authenticateToken(bearer);
    if (dbMatch?.actorType === "device") {
      return {
        kind: "device",
        id: dbMatch.device.id,
        device: dbMatch.device,
        authenticated: true,
      };
    }
    if (dbMatch?.actorType === "agent") {
      return {
        kind: "agent",
        id: dbMatch.agent.id,
        role: dbMatch.agent.role,
        agent: dbMatch.agent,
        authenticated: true,
      };
    }
    return { kind: "anonymous", authenticated: false, invalidToken: true };
  }

  if (!ownerToken) {
    return { kind: "owner", id: "owner", open: true, authenticated: true };
  }

  const cookies = parseCookies(req);
  if (cookies[SESSION_COOKIE_NAME] && verifySessionCookieValue(cookies[SESSION_COOKIE_NAME], ownerToken, approvalPrivateKey)) {
    return { kind: "owner", id: "owner", viaCookie: true, authenticated: true };
  }

  return { kind: "anonymous", authenticated: false, invalidToken: false };
}

export function checkSpoofedHeader(req, actor) {
  const xNode = req.headers["x-a2a-node"];
  if (!xNode) return null;
  if (actor.kind === "owner") return null;
  if (String(xNode).trim() !== actor.id) {
    return `X-A2A-Node (${xNode}) 与当前凭据 (${actor.id}) 不符`;
  }
  return null;
}

export function deviceOwnsAgent(store, deviceId, agentId) {
  const ag = store.getAgent(agentId);
  return Boolean(ag && ag.device_id === deviceId);
}

export function actorCanSeeTask(actor, task, store) {
  if (!task) return false;
  if (actor.kind === "owner") return true;
  if (actor.kind === "agent") {
    return task.to_agent_id === actor.id || task.from_node === actor.id;
  }
  if (actor.kind === "device") {
    return deviceOwnsAgent(store, actor.id, task.to_agent_id) || deviceOwnsAgent(store, actor.id, task.from_node);
  }
  return false;
}

export function actorCanOperateTaskAsWorker(actor, task, store) {
  if (!task) return false;
  if (actor.kind === "owner") return true;
  if (actor.kind === "agent") return task.to_agent_id === actor.id;
  if (actor.kind === "device") return deviceOwnsAgent(store, actor.id, task.to_agent_id);
  return false;
}

export function actorCanControlTaskAsSender(actor, task) {
  if (!task) return false;
  if (actor.kind === "owner") return true;
  if (actor.kind === "agent") return task.from_node === actor.id;
  return false;
}

// 统一文件访问鉴权：兼容旧的 files.task_id 与多对多 file_links（扇出子任务/追问/回执）。
export function actorCanAccessFile(actor, fileMeta, store) {
  if (!actor || !fileMeta) return false;
  if (actor.kind === "owner") return true;
  if (fileMeta.owner_node && fileMeta.owner_node === actor.id) return true;
  if (actor.kind === "device" && fileMeta.owner_node && deviceOwnsAgent(store, actor.id, fileMeta.owner_node)) {
    return true;
  }
  if (fileMeta.task_id && actorCanSeeTask(actor, store.getTask(fileMeta.task_id), store)) {
    return true;
  }
  if (typeof store.listFileLinkedTasks === "function") {
    const linkedTasks = store.listFileLinkedTasks(fileMeta.id);
    for (const t of linkedTasks) {
      if (actorCanSeeTask(actor, t, store)) return true;
    }
  }
  return false;
}

export function buildSetSessionCookieHeader(req, tokenValue, { clear = false } = {}) {
  const isHttps = req.socket?.encrypted || String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";
  const parts = [
    `${SESSION_COOKIE_NAME}=${clear ? "" : encodeURIComponent(tokenValue)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    clear ? "Max-Age=0" : `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isHttps) parts.push("Secure");
  return parts.join("; ");
}

export { hashToken };
