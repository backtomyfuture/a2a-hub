async function apiFetch(path, { method = "GET", body = null } = {}) {
  const opts = {
    method,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  };
  if (body !== null && body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(path, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.ok === false) {
    const err = new Error(data?.message || `HTTP ${resp.status}`);
    err.status = resp.status;
    err.code = data?.error || "";
    throw err;
  }
  return data;
}

export const api = {
  session: () => apiFetch("/api/v1/auth/session"),
  login: (token) => apiFetch("/api/v1/auth/login", { method: "POST", body: { token } }),
  logout: () => apiFetch("/api/v1/auth/logout", { method: "POST", body: {} }),
  state: () => apiFetch("/api/v1/state"),
  poll: (since, timeout = 30) => apiFetch(`/api/v1/poll?since=${since}&timeout=${timeout}`),
  templates: () => apiFetch("/api/v1/templates"),

  createDevice: (payload) => apiFetch("/api/v1/devices", { method: "POST", body: payload }),
  updateDevice: (id, patch) => apiFetch(`/api/v1/devices/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
  deleteDevice: (id) => apiFetch(`/api/v1/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
  rotateDeviceToken: (id) => apiFetch(`/api/v1/devices/${encodeURIComponent(id)}/rotate-token`, { method: "POST", body: {} }),
  workerPresets: () => apiFetch("/api/v1/worker-presets"),
  addDeviceWorker: (deviceId, payload) =>
    apiFetch(`/api/v1/devices/${encodeURIComponent(deviceId)}/workers`, { method: "POST", body: payload }),
  scanDeviceWorkers: (deviceId, payload = {}) =>
    apiFetch(`/api/v1/devices/${encodeURIComponent(deviceId)}/workers/scan`, { method: "POST", body: payload }),

  createAgent: (payload) => apiFetch("/api/v1/agents", { method: "POST", body: payload }),
  updateAgent: (id, patch) => apiFetch(`/api/v1/agents/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
  deleteAgent: (id) => apiFetch(`/api/v1/agents/${encodeURIComponent(id)}`, { method: "DELETE" }),
  rotateAgentToken: (id) => apiFetch(`/api/v1/agents/${encodeURIComponent(id)}/rotate-token`, { method: "POST", body: {} }),
  agentOnboarding: (id) => apiFetch(`/api/v1/agents/${encodeURIComponent(id)}/onboarding`),
  testWebhook: (id) => apiFetch(`/api/v1/agents/${encodeURIComponent(id)}/webhook-test`, { method: "POST", body: {} }),

  dispatchTask: (payload) => apiFetch("/api/v1/tasks", { method: "POST", body: payload }),
  getTask: (id) => apiFetch(`/api/v1/tasks/${encodeURIComponent(id)}`),
  replyTask: (id, bodyText, attachments = []) =>
    apiFetch(`/api/v1/tasks/${encodeURIComponent(id)}/reply`, {
      method: "POST",
      body: {
        body: bodyText,
        ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
      },
    }),
  cancelTask: (id, reason = "") => apiFetch(`/api/v1/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST", body: { reason } }),
  resolveTask: (id) => apiFetch(`/api/v1/tasks/${encodeURIComponent(id)}/resolve`, { method: "POST", body: {} }),
  resolveAllFailed: (opts = {}) => {
    const body = {};
    if (typeof opts === "string") {
      if (opts) body.context_id = opts;
    } else if (opts && typeof opts === "object") {
      if (opts.contextId || opts.context_id) body.context_id = opts.contextId || opts.context_id;
      if (opts.sinceMs || opts.since_ms) body.since_ms = opts.sinceMs || opts.since_ms;
    }
    return apiFetch("/api/v1/tasks/resolve-all", { method: "POST", body });
  },
  retryTask: (id, payload = {}) => apiFetch(`/api/v1/tasks/${encodeURIComponent(id)}/retry`, { method: "POST", body: payload }),
  deleteTask: (id) => apiFetch(`/api/v1/tasks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  decideApproval: (id, decision, note = "") =>
    apiFetch(`/api/v1/approvals/${encodeURIComponent(id)}/decide`, { method: "POST", body: { decision, note } }),

  uploadFile: async (file, { taskId = null } = {}) => {
    const headers = {
      Accept: "application/json",
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name || "file.bin"),
      "X-File-Mime": file.type || "application/octet-stream",
    };
    if (taskId) headers["X-Task-Id"] = String(taskId);
    const resp = await fetch("/api/v1/files", {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: file,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data?.ok === false) {
      const err = new Error(data?.message || `HTTP ${resp.status}`);
      err.status = resp.status;
      err.code = data?.error || "";
      throw err;
    }
    return data;
  },
  fetchFileText: async (fileId) => {
    const resp = await fetch(`/api/v1/files/${encodeURIComponent(fileId)}?inline=1`, {
      method: "GET",
      credentials: "same-origin",
    });
    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`;
      try {
        const j = await resp.json();
        if (j?.message) msg = j.message;
      } catch {}
      throw new Error(msg);
    }
    return await resp.text();
  },

  getThread: (contextId) => apiFetch(`/api/v1/threads/${encodeURIComponent(contextId)}`),
  deleteThread: (contextId) => apiFetch(`/api/v1/threads/${encodeURIComponent(contextId)}`, { method: "DELETE" }),

  upsertSchedule: (agentId, scheduleId, payload) =>
    apiFetch(`/api/v1/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`, {
      method: "PUT",
      body: payload,
    }),
  triggerSchedule: (agentId, scheduleId, payload = {}) =>
    apiFetch(`/api/v1/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}/trigger`, {
      method: "POST",
      body: payload,
    }),
  ackSchedule: (agentId, scheduleId) =>
    apiFetch(`/api/v1/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}/ack`, {
      method: "POST",
      body: {},
    }),
  deleteSchedule: (agentId, scheduleId) =>
    apiFetch(`/api/v1/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`, {
      method: "DELETE",
    }),

  getSettings: () => apiFetch("/api/v1/admin/settings"),
  saveSettings: (payload) => apiFetch("/api/v1/admin/settings", { method: "POST", body: payload }),
  testNotifier: () => apiFetch("/api/v1/admin/notifier-test", { method: "POST", body: {} }),
};
