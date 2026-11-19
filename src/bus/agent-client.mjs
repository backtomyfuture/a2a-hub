// 官方 Agent Gateway 客户端。只出站访问 /api/v1/agents/* 与 /api/v1/tasks/*，
// 给 busType=agent 的 ah daemon / inbox / task 用。分 Agent Token 不能走表接口和 /api/v1/poll。
// 日志与错误里不出现 Token 或代理凭据：URL 上的 userinfo 会先剥掉，正文里的 Token 会替换掉。

import { BROWSER_USER_AGENT } from "../kernel-util.mjs";

function enc(value) {
  return encodeURIComponent(String(value ?? ""));
}

function stripUserinfo(hubUrl) {
  const base = String(hubUrl ?? "").trim();
  if (!base) throw new Error("AgentGatewayClient 需要 hubUrl");
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error("AgentGatewayClient 的 hubUrl 不是合法 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AgentGatewayClient 的 hubUrl 只允许 http 或 https");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export class AgentGatewayError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "AgentGatewayError";
    this.status = status;
  }
}

export class AgentGatewayClient {
  constructor({
    hubUrl,
    apiToken = "",
    node,
    agentRole = "worker",
    receiveMode = "http-longpoll",
    nodeDesc = "",
    longPollSec = 25,
    log = () => {},
    fetchImpl,
  } = {}) {
    this.hubUrl = stripUserinfo(hubUrl);
    this.apiToken = String(apiToken ?? "").trim();
    this.node = String(node ?? "").trim();
    if (!this.node) throw new Error("AgentGatewayClient 需要 node");
    this.agentRole = String(agentRole ?? "").trim().toLowerCase() || "worker";
    this.receiveMode = String(receiveMode ?? "").trim() || "http-longpoll";
    this.nodeDesc = String(nodeDesc ?? "");
    this.longPollSec = Number.isFinite(Number(longPollSec)) ? Number(longPollSec) : 25;
    this.log = typeof log === "function" ? log : () => {};
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") throw new Error("AgentGatewayClient 需要 fetch");
  }

  // 服务端回显 Token 或 fetch 报错带出代理 userinfo 时，都必须抹掉再进日志。
  redact(text) {
    let out = String(text ?? "");
    if (this.apiToken) out = out.split(this.apiToken).join("[redacted]");
    out = out.replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1***:***@");
    return out;
  }

  _headers(hasBody) {
    const headers = {
      "User-Agent": BROWSER_USER_AGENT,
      "X-A2A-Node": this.node,
    };
    if (this.apiToken) headers.Authorization = `Bearer ${this.apiToken}`;
    if (hasBody) headers["Content-Type"] = "application/json";
    return headers;
  }

  async request(method, pathname, { body, query, signal } = {}) {
    const url = new URL(this.hubUrl + pathname);
    if (query && typeof query === "object") {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }
    const hasBody = body !== undefined;
    let res;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: this._headers(hasBody),
        body: hasBody ? JSON.stringify(body) : undefined,
        signal,
        redirect: "error",
      });
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      const err = new AgentGatewayError(this.redact(e?.message ?? e), 0);
      if (e?.code) err.code = e.code;
      throw err;
    }
    const text = await res.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text.slice(0, 300) };
      }
    }
    if (!res.ok) {
      const msg = this.redact(data?.error || data?.msg || `HTTP ${res.status}`);
      throw new AgentGatewayError(msg, res.status);
    }
    return data;
  }

  health() {
    return this.request("GET", "/api/v1/health");
  }

  register({ caps, nodeDesc, receiveMode, role } = {}) {
    const body = {
      node: this.node,
      role: role || this.agentRole || "worker",
      kind: "agent",
      receive_mode: receiveMode || this.receiveMode || "http-longpoll",
      node_desc: nodeDesc ?? this.nodeDesc ?? "",
    };
    if (caps) body.caps = caps;
    return this.request("POST", "/api/v1/agents/register", { body });
  }

  listAgents() {
    return this.request("GET", "/api/v1/agents");
  }

  check() {
    return this.request("GET", `/api/v1/agents/${enc(this.node)}/check`);
  }

  poll({ timeoutSec = this.longPollSec, signal } = {}) {
    return this.request("GET", `/api/v1/agents/${enc(this.node)}/poll`, {
      query: { timeout: timeoutSec },
      signal,
    });
  }

  inbox() {
    return this.request("GET", `/api/v1/agents/${enc(this.node)}/inbox`);
  }

  updates({ since, newOnly = true, timeoutSec = 0, signal } = {}) {
    const query = { timeout: timeoutSec };
    if (since != null && since !== "") query.since = since;
    if (newOnly) query.new = "1";
    return this.request("GET", `/api/v1/agents/${enc(this.node)}/updates`, { query, signal });
  }

  claim(taskId) {
    return this.request("POST", `/api/v1/tasks/${enc(taskId)}/claim`, { body: { node: this.node } });
  }

  heartbeat(taskId, text = "") {
    const body = { node: this.node };
    if (text) body.text = text;
    return this.request("POST", `/api/v1/tasks/${enc(taskId)}/heartbeat`, { body });
  }

  complete(taskId, { text, artifact, artifacts, checks } = {}) {
    const body = { node: this.node };
    if (text != null) body.text = text;
    if (artifact) body.artifact = artifact;
    if (artifacts) body.artifacts = artifacts;
    if (checks) body.checks = checks;
    return this.request("POST", `/api/v1/tasks/${enc(taskId)}/complete`, { body });
  }

  fail(taskId, { text, artifacts } = {}) {
    const body = { node: this.node };
    if (text != null) body.text = text;
    if (artifacts) body.artifacts = artifacts;
    return this.request("POST", `/api/v1/tasks/${enc(taskId)}/fail`, { body });
  }

  ask(taskId, { text, attachments } = {}) {
    return this.request("POST", `/api/v1/tasks/${enc(taskId)}/ask`, {
      body: { node: this.node, text: text ?? "", ...(attachments ? { attachments } : {}) },
    });
  }

  auth(taskId, { text, attachments } = {}) {
    return this.request("POST", `/api/v1/tasks/${enc(taskId)}/auth`, {
      body: { node: this.node, text: text ?? "", ...(attachments ? { attachments } : {}) },
    });
  }

  createTask(payload = {}) {
    return this.request("POST", "/api/v1/tasks", {
      body: { ...payload, from: payload.from || this.node },
    });
  }

  getTask(taskId) {
    return this.request("GET", `/api/v1/tasks/${enc(taskId)}`);
  }

  listTasks(query = {}) {
    return this.request("GET", "/api/v1/tasks", { query });
  }

  replyTask(taskId, { from, text, attachments } = {}) {
    const body = { from: from || this.node };
    if (text != null) body.text = text;
    if (attachments) body.attachments = attachments;
    return this.request("POST", `/api/v1/tasks/${enc(taskId)}/reply`, { body });
  }

  cancelTask(taskId, { from, text } = {}) {
    return this.request("POST", `/api/v1/tasks/${enc(taskId)}/cancel`, {
      body: { from: from || this.node, text: text ?? "" },
    });
  }
}
