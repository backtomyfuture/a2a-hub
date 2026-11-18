// 机主配置的 Webhook 门铃：中台在任务状态变化时 POST 一条不含指令正文的通知。
// secret 明文落盘是因为出站 HMAC 每次都要用；列表和日志不能带出它。

import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BROWSER_USER_AGENT } from "../kernel-util.mjs";
import { httpError } from "./admission.mjs";

const FILE_NAME = "agent_webhooks.json";
const RETRY_DELAYS_MS = Object.freeze([0, 1000, 3000, 8000]);
const TIMEOUT_MS = 10_000;
const LEADER_STATUSES = new Set([
  "completed",
  "failed",
  "canceled",
  "rejected",
  "input-required",
  "auth-required",
]);
// RFC 7230 token，避免把换行或冒号写进请求头名。
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const DOORBELL_TEXT = "a2a-hub 有新任务/更新，请运行检查流程拉取";

export function validateWebhookKey(raw, { required = false } = {}) {
  const key = String(raw ?? "").trim();
  if (!key) {
    if (required) throw httpError(400, "请填写对方提供的密钥");
    return "";
  }
  if (key.length > 512) throw httpError(400, "密钥长度不能超过 512");
  return key;
}

export function validateWebhookHeader(raw) {
  const name = String(raw ?? "").trim();
  if (!name) return "Authorization";
  if (name.length > 64 || !HEADER_NAME.test(name)) throw httpError(400, "请求头名不合法");
  return name;
}

export function maskWebhookSecret(secret) {
  const value = String(secret ?? "");
  if (!value) return "";
  return `${value.slice(0, 6)}…`;
}

function fieldOf(fields, key) {
  const v = fields?.[key];
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v ?? "").trim();
}

function errorText(err) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timeout";
  return String(err?.message ?? err).slice(0, 300);
}

export function validateWebhookUrl(raw) {
  const url = String(raw ?? "").trim();
  if (!url || url.length > 2048) {
    throw httpError(400, "webhook_url 长度须在 1 到 2048 之间");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw httpError(400, "webhook_url 不是合法 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw httpError(400, "webhook_url 只允许 http 或 https");
  }
  if (parsed.username || parsed.password) {
    throw httpError(400, "webhook_url 不能包含用户名或密码");
  }
  return url;
}

export function webhookSignature(secret, timestamp, rawBody) {
  return createHmac("sha256", String(secret)).update(`${timestamp}.${rawBody}`).digest("hex");
}

function isLegacyHook(hook) {
  return !Object.hasOwn(hook, "header");
}

function publicHook(hook) {
  const legacy = isLegacyHook(hook);
  return {
    node: hook.node,
    url: hook.url,
    // 旧记录只有 HMAC 用的 secret，没有接收端请求头。列表用 legacy 提示机主补密钥，不把明文交出去。
    header: legacy ? "" : (hook.header || "Authorization"),
    secret_mask: maskWebhookSecret(hook.secret),
    legacy,
    created_at: hook.created_at,
    updated_at: hook.updated_at,
    last_status: hook.last_status ?? "",
    last_error: hook.last_error ?? "",
    last_delivered_at: hook.last_delivered_at ?? "",
    last_attempt_at: hook.last_attempt_at ?? "",
  };
}

export function publicWebhook(hook) {
  return hook ? publicHook(hook) : null;
}

export class AgentWebhookStore {
  constructor(configDir, { now = () => new Date() } = {}) {
    if (!configDir) throw httpError(500, "未配置 configDir，无法管理 Webhook");
    this.path = path.join(configDir, FILE_NAME);
    this.#now = now;
  }

  #now;
  #cache = null;
  #mtimeMs = -1;

  #load() {
    if (!fs.existsSync(this.path)) {
      this.#cache = { version: 1, hooks: [] };
      this.#mtimeMs = 0;
      return this.#cache;
    }
    const st = fs.statSync(this.path);
    if (this.#cache && st.mtimeMs === this.#mtimeMs) return this.#cache;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.path, "utf8"));
    } catch {
      throw httpError(500, "agent_webhooks.json 无法解析");
    }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.hooks)) {
      throw httpError(500, "agent_webhooks.json 格式不正确");
    }
    this.#cache = parsed;
    this.#mtimeMs = st.mtimeMs;
    return parsed;
  }

  #save(hooks) {
    const json = `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`;
    const tmp = `${this.path}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, json, { mode: 0o600 });
    fs.renameSync(tmp, this.path);
    // writeFile 的 mode 会被 umask 削掉，落盘后再收到 0600。
    fs.chmodSync(this.path, 0o600);
    this.#cache = { version: 1, hooks };
    this.#mtimeMs = fs.statSync(this.path).mtimeMs;
  }

  get(node) {
    const name = String(node ?? "").trim();
    return this.#load().hooks.find((h) => h.node === name) ?? null;
  }

  listPublic() {
    return this.#load().hooks.map((h) => publicHook(h));
  }

  // 密钥由接收端提供。新建必须带 key；更新时留空表示沿用旧密钥。没有 header 字段的是旧记录，只做 HMAC，不拿中台曾经生成的 secret 去填 Authorization。
  put({ node, url, key, header } = {}) {
    const name = String(node ?? "").trim();
    const data = this.#load();
    const nowIso = this.#now().toISOString();
    const idx = data.hooks.findIndex((h) => h.node === name);
    const providedKey = validateWebhookKey(key);
    const headerGiven = header != null && String(header).trim() !== "";
    if (idx < 0) {
      const secret = validateWebhookKey(key, { required: true });
      const hook = {
        node: name,
        url,
        secret,
        header: validateWebhookHeader(header),
        created_at: nowIso,
        updated_at: nowIso,
        last_status: "",
        last_error: "",
        last_delivered_at: "",
      };
      data.hooks.push(hook);
      this.#save(data.hooks);
      return { created: true, hook };
    }
    const prev = data.hooks[idx];
    const next = { ...prev, url, updated_at: nowIso };
    if (providedKey) {
      next.secret = providedKey;
      next.header = headerGiven
        ? validateWebhookHeader(header)
        : (Object.hasOwn(prev, "header") ? (prev.header || "Authorization") : "Authorization");
    } else if (headerGiven && Object.hasOwn(prev, "header")) {
      next.header = validateWebhookHeader(header);
    }
    data.hooks[idx] = next;
    this.#save(data.hooks);
    return { created: false, hook: next };
  }

  remove(node) {
    const name = String(node ?? "").trim();
    const data = this.#load();
    const next = data.hooks.filter((h) => h.node !== name);
    if (next.length === data.hooks.length) return false;
    this.#save(next);
    return true;
  }

  markDelivery(node, { last_status, last_error, last_delivered_at, last_attempt_at } = {}) {
    const name = String(node ?? "").trim();
    const data = this.#load();
    const idx = data.hooks.findIndex((h) => h.node === name);
    if (idx < 0) return null;
    const prev = data.hooks[idx];
    const next = {
      ...prev,
      last_status: String(last_status ?? ""),
      last_error: String(last_error ?? ""),
      last_delivered_at: last_delivered_at == null ? (prev.last_delivered_at ?? "") : String(last_delivered_at),
      // 失败也要留下时间，控制台才能判断这次失败之后还有没有检查或成功投递。
      last_attempt_at: last_attempt_at == null ? (prev.last_attempt_at ?? "") : String(last_attempt_at),
    };
    data.hooks[idx] = next;
    this.#save(data.hooks);
    return publicHook(next);
  }
}

export class WebhookDispatcher {
  constructor({
    store,
    configDir,
    hubNode = "hub",
    taskTable = "tasks",
    fetchImpl,
    log,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    retryDelays = RETRY_DELAYS_MS,
    timeoutMs = TIMEOUT_MS,
    broker = null,
  } = {}) {
    this.store = store ?? new AgentWebhookStore(configDir, { now: () => new Date(now()) });
    this.broker = broker;
    this.hubNode = String(hubNode || "hub");
    this.taskTable = String(taskTable || "tasks");
    this.fetch = fetchImpl ?? globalThis.fetch;
    this.log = log ?? (() => {});
    this.now = now;
    this.sleep = sleep;
    this.retryDelays = retryDelays;
    this.timeoutMs = timeoutMs;
    this.#seen = new Set();
  }

  #seen;

  async onBusEvent(ev) {
    if (!ev || String(ev.table ?? "") !== this.taskTable) return null;
    const fields = ev.fields ?? {};
    const status = fieldOf(fields, "Status");
    const taskId = fieldOf(fields, "Task_ID");
    if (!taskId || !status) return null;
    const seq = Number(ev.seq) || 0;
    // 答复把任务拉回 working 是续跑，不是新门铃。只有首次 submitted 才通知执行节点。
    if (status === "submitted") {
      const node = fieldOf(fields, "Target_Node");
      if (!node) return null;
      return this.#push("task.assigned", node, taskId, status, seq);
    }
    if (LEADER_STATUSES.has(status)) {
      const node = fieldOf(fields, "From_Node");
      if (!node) return null;
      return this.#push("task.updated", node, taskId, status, seq);
    }
    return null;
  }

  async ping(node) {
    const name = String(node ?? "").trim();
    const hook = this.store.get(name);
    if (!hook?.url || !hook.secret) return { missing: true, ok: false, status: 0, error: "not found" };
    return this.deliver(hook, this.#body({ event: "ping", node: name, taskId: "", status: "", seq: 0 }));
  }

  async #push(event, node, taskId, status, seq) {
    const hook = this.store.get(node);
    if (!hook?.url || !hook.secret) return null;
    const key = `${node}\0${taskId}\0${status}`;
    if (this.#seen.has(key)) return null;
    this.#seen.add(key);
    if (this.#seen.size > 4096) this.#seen.delete(this.#seen.values().next().value);
    return this.deliver(hook, this.#body({ event, node, taskId, status, seq }));
  }

  #body({ event, node, taskId, status, seq }) {
    return {
      event,
      node,
      task_id: taskId,
      status,
      seq,
      hub: this.hubNode,
      at: new Date(this.now()).toISOString(),
      // 接收端（如 Cursor Automations）把正文当触发上下文。只给一句提醒，不放指令。
      text: event === "ping" ? "a2a-hub Webhook 测试，请返回 2xx" : DOORBELL_TEXT,
    };
  }

  #headers(hook, payload, timestamp, rawBody) {
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": BROWSER_USER_AGENT,
      "X-A2A-Event": payload.event,
      "X-A2A-Delivery": randomUUID(),
      "X-A2A-Timestamp": timestamp,
      "X-A2A-Signature": `sha256=${webhookSignature(hook.secret, timestamp, rawBody)}`,
    };
    if (Object.hasOwn(hook, "header") && hook.header) {
      const name = String(hook.header);
      headers[name] = name.toLowerCase() === "authorization" ? `Bearer ${hook.secret}` : String(hook.secret);
    }
    return headers;
  }

  async deliver(hook, payload) {
    const rawBody = JSON.stringify(payload);
    let lastStatus = 0;
    let lastError = "";
    for (let i = 0; i < this.retryDelays.length; i++) {
      const delay = this.retryDelays[i];
      if (delay > 0) await this.sleep(delay);
      const timestamp = String(Math.floor(this.now() / 1000));
      try {
        const res = await this.fetch(hook.url, {
          method: "POST",
          headers: this.#headers(hook, payload, timestamp, rawBody),
          body: rawBody,
          // 不跟随重定向：机主核过的是这个地址，3xx 不能把带签名的请求带去别处。
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        lastStatus = Number(res?.status) || 0;
        if (lastStatus >= 200 && lastStatus < 300) {
          const deliveredAt = new Date(this.now()).toISOString();
          this.store.markDelivery(hook.node, {
            last_status: String(lastStatus),
            last_error: "",
            last_delivered_at: deliveredAt,
            last_attempt_at: deliveredAt,
          });
          // 只有 2xx 算活动。noteDelivery 不计入唤醒周期，避免测试和门铃把 intervalMs 拉短。
          this.broker?.noteDelivery?.(hook.node);
          this.log(`webhook ${hook.node} ${payload.event} ok ${lastStatus}`);
          return { ok: true, status: lastStatus, error: "" };
        }
        lastError = `HTTP ${lastStatus}`;
      } catch (err) {
        lastStatus = 0;
        lastError = errorText(err);
      }
    }
    this.store.markDelivery(hook.node, {
      last_status: lastStatus ? String(lastStatus) : "error",
      last_error: lastError,
      last_attempt_at: new Date(this.now()).toISOString(),
    });
    this.log(`webhook ${hook.node} ${payload.event} fail ${lastError}`);
    return { ok: false, status: lastStatus, error: lastError };
  }
}
