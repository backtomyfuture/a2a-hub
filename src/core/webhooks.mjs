// Webhook 门铃派发器（WebhookDispatcher）。
// 当任务状态变化需要通知远程 Agent（新任务待认领、等待结果恢复、或 Leader 需关注的终态/阻塞态）时，
// 发送带 HMAC-SHA256 签名的轻量门铃 POST；严格禁止跟随 HTTP 重定向，屏蔽云元数据地址。

import crypto from "node:crypto";
import { BROWSER_USER_AGENT } from "./config.mjs";

const BLOCKED_METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
  "100.100.100.200",
]);

export function validateWebhookUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s) return { ok: false, error: "Webhook URL 不能为空" };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "Webhook URL 格式无效" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: "Webhook 仅支持 http / https 协议" };
  }
  const host = u.hostname.toLowerCase();
  if (BLOCKED_METADATA_HOSTS.has(host)) {
    return { ok: false, error: "禁止指向云主机元数据保留地址" };
  }
  return { ok: true, url: u.toString() };
}

export function signWebhookPayload(secret, bodyText) {
  const hex = crypto.createHmac("sha256", String(secret)).update(bodyText, "utf8").digest("hex");
  return `sha256=${hex}`;
}

export class WebhookDispatcher {
  constructor(store, { fetchFn = globalThis.fetch, hubUrlResolver = null, timeoutMs = 8000 } = {}) {
    this.store = store;
    this.fetchFn = fetchFn;
    this.hubUrlResolver = hubUrlResolver;
    this.timeoutMs = timeoutMs;
    this._dedupe = new Map();
    this._maxDedupe = 2000;
  }

  _remember(key) {
    if (this._dedupe.has(key)) return false;
    this._dedupe.set(key, Date.now());
    if (this._dedupe.size > this._maxDedupe) {
      const first = this._dedupe.keys().next().value;
      if (first) this._dedupe.delete(first);
    }
    return true;
  }

  _hubBaseUrl() {
    if (typeof this.hubUrlResolver === "function") {
      return String(this.hubUrlResolver() || "").replace(/\/+$/, "");
    }
    return "";
  }

  async sendToAgent(agentId, payload) {
    const cfg = this.store.getAgentWebhookSecret(agentId);
    if (!cfg || !cfg.url) return { ok: false, skipped: true, reason: "no_webhook" };
    const valid = validateWebhookUrl(cfg.url);
    if (!valid.ok) return { ok: false, error: valid.error };

    const bodyText = JSON.stringify(payload);
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": BROWSER_USER_AGENT,
      "X-A2A-Event": String(payload.event || "task.event"),
    };
    if (cfg.secret) {
      const headerName = cfg.header || "X-A2A-Signature";
      headers[headerName] = signWebhookPayload(cfg.secret, bodyText);
    }

    const startedAt = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      try {
        const resp = await this.fetchFn(valid.url, {
          method: "POST",
          headers,
          body: bodyText,
          redirect: "manual",
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (resp.status >= 300 && resp.status < 400) {
          return { ok: false, status: resp.status, latency_ms: Date.now() - startedAt, error: "安全策略拒绝 Webhook 重定向" };
        }
        if (resp.status >= 200 && resp.status < 300) {
          return { ok: true, status: resp.status, latency_ms: Date.now() - startedAt };
        }
        if (resp.status >= 500 && attempt === 0) continue;
        return { ok: false, status: resp.status, latency_ms: Date.now() - startedAt, error: `HTTP ${resp.status}` };
      } catch (err) {
        clearTimeout(timer);
        if (attempt === 0) continue;
        return { ok: false, status: 0, latency_ms: Date.now() - startedAt, error: err?.message || String(err) };
      }
    }
    return { ok: false, error: "unknown_error" };
  }

  async testAgentWebhook(agentId) {
    const agent = this.store.getAgent(agentId);
    if (!agent) return { ok: false, error: "Agent 不存在" };
    return this.sendToAgent(agentId, {
      event: "webhook.test",
      agent_id: agent.id,
      hub_url: this._hubBaseUrl(),
      timestamp: Date.now(),
      message: "来自 a2a-hub 的 Webhook 连通性测试消息",
    });
  }

  handleEvent(event) {
    if (!event || !event.taskId) return;
    const hubUrl = this._hubBaseUrl();
    const targets = [];

    // 1) Worker 侧门铃：新任务入队或暂停后恢复
    if (event.type === "task.created" && event.state === "submitted" && event.agentId) {
      targets.push({ targetId: event.agentId, webhookEvent: "task.submitted" });
    } else if ((event.type === "task.resumed" || event.type === "task.requeued") && event.agentId) {
      targets.push({ targetId: event.agentId, webhookEvent: "task.resumed" });
    }

    // 2) Leader 侧门铃：如果任务发起方是注册在 Hub 上的 Leader Agent，在阻塞或终态时回调通知
    if (
      event.fromNode &&
      event.fromNode !== "owner" &&
      ["task.completed", "task.failed", "task.input_required", "task.auth_required", "task.rejected"].includes(event.type)
    ) {
      targets.push({ targetId: event.fromNode, webhookEvent: event.type });
    }

    for (const item of targets) {
      const dedupeKey = `${item.webhookEvent}:${item.targetId}:${event.taskId}:${event.seq || 0}:${event.messageId || 0}`;
      if (!this._remember(dedupeKey)) continue;
      const payload = {
        event: item.webhookEvent,
        seq: Number(event.seq || 0),
        task_id: event.taskId,
        context_id: event.contextId || "",
        agent_id: event.agentId || "",
        from_node: event.fromNode || "",
        state: event.state || "",
        title: event.title || "",
        hub_url: hubUrl,
        timestamp: Date.now(),
      };
      // 异步发送不阻塞核心请求链路
      void this.sendToAgent(item.targetId, payload).catch(() => {});
    }
  }
}
