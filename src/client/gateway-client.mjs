// 统一 Hub HTTP 客户端（GatewayClient），供电脑设备守护进程、独立 Agent 进程与 ah CLI 共用。

import { BROWSER_USER_AGENT } from "../core/config.mjs";

export class GatewayClient {
  constructor(baseUrl, { token = "", fetchFn = globalThis.fetch, defaultTimeoutMs = 20_000 } = {}) {
    this.baseUrl = String(baseUrl || "http://127.0.0.1:8787").replace(/\/+$/, "");
    this.token = String(token || "").trim();
    this.fetchFn = fetchFn;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async request(method, path, { body = null, rawBuffer = null, headers = {}, timeoutMs, signal = null } = {}) {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const reqHeaders = {
      "User-Agent": BROWSER_USER_AGENT,
      "Accept": "application/json",
      ...headers,
    };
    if (this.token) {
      reqHeaders.Authorization = `Bearer ${this.token}`;
    }
    let payload;
    if (rawBuffer !== null) {
      payload = rawBuffer;
    } else if (body !== null && body !== undefined) {
      reqHeaders["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    const controller = new AbortController();
    const waitMs = Number(timeoutMs || this.defaultTimeoutMs);
    const timer = setTimeout(() => controller.abort(), waitMs);
    if (typeof timer.unref === "function") timer.unref();
    const combinedSignal = signal
      ? (typeof AbortSignal.any === "function" ? AbortSignal.any([controller.signal, signal]) : controller.signal)
      : controller.signal;
    const onExternalAbort = () => controller.abort();
    if (signal && typeof AbortSignal.any !== "function") {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const resp = await this.fetchFn(url, {
        method,
        headers: reqHeaders,
        body: payload,
        signal: combinedSignal,
      });
      const ct = String(resp.headers?.get?.("content-type") || "").toLowerCase();
      if (!resp.ok) {
        let parsed = null;
        if (ct.includes("application/json")) {
          try { parsed = await resp.json(); } catch {}
        } else {
          try { parsed = { message: await resp.text() }; } catch {}
        }
        const err = new Error(parsed?.message || `HTTP ${resp.status}`);
        err.status = resp.status;
        err.code = parsed?.error || `http_${resp.status}`;
        err.payload = parsed;
        throw err;
      }
      if (ct.includes("application/json")) {
        return await resp.json();
      }
      return await resp.text();
    } finally {
      clearTimeout(timer);
      if (signal && typeof AbortSignal.any !== "function") {
        signal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  get(path, opts = {}) {
    return this.request("GET", path, opts);
  }

  post(path, body = {}, opts = {}) {
    return this.request("POST", path, { ...opts, body });
  }

  put(path, body = {}, opts = {}) {
    return this.request("PUT", path, { ...opts, body });
  }

  patch(path, body = {}, opts = {}) {
    return this.request("PATCH", path, { ...opts, body });
  }

  del(path, opts = {}) {
    return this.request("DELETE", path, opts);
  }

  health() {
    return this.get("/api/v1/health");
  }

  wellKnown() {
    return this.get("/.well-known/agent.json");
  }

  // ---- Device 接口 ----

  syncDevice(deviceId, workers, deviceMeta = {}, opts = {}) {
    return this.post(`/api/v1/devices/${encodeURIComponent(deviceId)}/sync`, {
      workers,
      ...deviceMeta,
    }, opts);
  }

  pollDevice(deviceId, { since = 0, timeout = 35, signal = null } = {}) {
    const qs = new URLSearchParams({ since: String(since), timeout: String(timeout) });
    return this.get(`/api/v1/devices/${encodeURIComponent(deviceId)}/poll?${qs}`, {
      timeoutMs: (timeout + 15) * 1000,
      signal,
    });
  }

  // ---- Agent 接口 ----

  listAgents() {
    return this.get("/api/v1/agents");
  }

  registerAgent(payload, opts = {}) {
    return this.post("/api/v1/agents/register", payload, opts);
  }

  checkAgent(agentId) {
    return this.get(`/api/v1/agents/${encodeURIComponent(agentId)}/check`);
  }

  pollAgent(agentId, { since = 0, timeout = 35, signal = null } = {}) {
    const qs = new URLSearchParams({ since: String(since), timeout: String(timeout) });
    return this.get(`/api/v1/agents/${encodeURIComponent(agentId)}/poll?${qs}`, {
      timeoutMs: (timeout + 15) * 1000,
      signal,
    });
  }

  inboxAgent(agentId) {
    return this.get(`/api/v1/agents/${encodeURIComponent(agentId)}/inbox`);
  }

  getAgentUpdates(agentId, { since = null, advance = false } = {}) {
    const qs = new URLSearchParams();
    if (since !== null && since !== undefined && since !== "") qs.set("since", String(since));
    if (advance) qs.set("new", "1");
    return this.get(`/api/v1/agents/${encodeURIComponent(agentId)}/updates?${qs}`);
  }

  upsertSchedule(agentId, scheduleId, payload = {}) {
    return this.put(
      `/api/v1/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`,
      payload
    );
  }

  reportScheduleRun(agentId, scheduleId, payload = {}, idempotencyKey = "") {
    return this.post(
      `/api/v1/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}/runs`,
      payload,
      {
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
      }
    );
  }

  // ---- Task 接口 ----

  listTasks(params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    }
    const q = qs.toString();
    return this.get(`/api/v1/tasks${q ? `?${q}` : ""}`);
  }

  getTask(taskId) {
    return this.get(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  dispatchTask(payload, idempotencyKey = "") {
    return this.post("/api/v1/tasks", payload, {
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
    });
  }

  claimNext({ agentIds = null, leaseSec = 300 } = {}) {
    return this.post("/api/v1/tasks/claim", {
      ...(Array.isArray(agentIds) ? { agent_ids: agentIds } : {}),
      lease_sec: leaseSec,
    });
  }

  claimTask(taskId, { leaseSec = 300 } = {}) {
    return this.post(`/api/v1/tasks/${encodeURIComponent(taskId)}/claim`, {
      lease_sec: leaseSec,
    });
  }

  heartbeat(taskId, { progress = {}, leaseSec = 300 } = {}) {
    return this.post(`/api/v1/tasks/${encodeURIComponent(taskId)}/heartbeat`, {
      progress,
      lease_sec: leaseSec,
    });
  }

  complete(taskId, payload = {}) {
    return this.post(`/api/v1/tasks/${encodeURIComponent(taskId)}/complete`, payload);
  }

  fail(taskId, { error = "execution_failed", retryable = false, data = {} } = {}) {
    return this.post(`/api/v1/tasks/${encodeURIComponent(taskId)}/fail`, {
      error,
      retryable,
      data,
    });
  }

  ask(taskId, { prompt, choices = [], data = {} } = {}) {
    return this.post(`/api/v1/tasks/${encodeURIComponent(taskId)}/ask`, {
      prompt,
      choices,
      data,
    });
  }

  requestAuth(taskId, { reason, commandPreview = "", riskLevel = "high", data = {} } = {}) {
    return this.post(`/api/v1/tasks/${encodeURIComponent(taskId)}/auth`, {
      reason,
      command_preview: commandPreview,
      risk_level: riskLevel,
      data,
    });
  }

  replyTask(taskId, { body, data = {}, attachments = [] } = {}) {
    return this.post(`/api/v1/tasks/${encodeURIComponent(taskId)}/reply`, {
      body,
      data,
      attachments,
    });
  }

  cancelTask(taskId, reason = "") {
    return this.post(`/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { reason });
  }

  decideApproval(taskId, { decision, note = "", requestId = "", channel = "" } = {}) {
    return this.post(`/api/v1/approvals/${encodeURIComponent(taskId)}/decide`, {
      decision,
      note,
      request_id: requestId,
      ...(channel ? { channel } : {}),
    });
  }

  // ---- Files ----

  uploadFile({ buffer, name = "file.bin", mime = "application/octet-stream", taskId = null } = {}) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
    return this.post("/api/v1/files", {
      name,
      mime,
      task_id: taskId,
      content_base64: buf.toString("base64"),
    });
  }

  async downloadFile(fileId) {
    const url = `${this.baseUrl}/api/v1/files/${encodeURIComponent(fileId)}`;
    const headers = { "User-Agent": BROWSER_USER_AGENT };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const resp = await this.fetchFn(url, { headers });
    if (!resp.ok) {
      const err = new Error(`下载文件失败: HTTP ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  }
}
