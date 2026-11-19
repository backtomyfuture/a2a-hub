// busType=agent 的常驻进程：只向 Hub 出站，不开监听端口。
// 长轮询认领写入 agent_inbox.jsonl，Leader 把动态追加到 present_queue.jsonl。
// 断线按 1s/3s/8s/30s 退避，重连成功后重新 register，避免 Hub 把节点判离线。

import fs from "node:fs";
import path from "node:path";
import { createFileClient } from "./files-client.mjs";
import { parseHubFileUri, sanitizeFileName } from "./hub/files.mjs";
import { presentKey } from "./hub/present.mjs";
import { enqueueOrUpdateInbox, markInboxStatus, readInbox } from "./inbox.mjs";
import { log as defaultLog } from "./kernel-util.mjs";
import { appendQueueItem } from "./present-queue.mjs";

export const AGENT_RECONNECT_DELAYS_MS = [1000, 3000, 8000, 30_000];

const PRESENT_STATUSES = new Set([
  "completed", "failed", "rejected", "canceled", "input-required", "auth-required",
]);

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err) {
  return err?.name === "AbortError";
}

function taskIdOf(task) {
  return String(task?.task_id ?? task?.id ?? "").trim();
}

function latestMsgIdOf(task) {
  const answers = Array.isArray(task?.answers) ? task.answers : [];
  for (let i = answers.length - 1; i >= 0; i--) {
    const id = String(answers[i]?.msg_id ?? "").trim();
    if (id) return id;
  }
  return String(task?.status_msg ?? "");
}

// pending/acked 且水位没变就不要盖回 pending，否则 ah inbox --pop 的 acked 会被下一轮冲掉。
// 发起方答复或机主批准后，要么 status_msg / 最新消息变了，要么本地还停在 waiting-* 而 Hub 已回到 working。
export function shouldRefreshInbox(existing, task) {
  if (!existing) return true;
  const local = String(existing.status ?? "");
  const hubStatus = String(task?.status ?? "");
  const prevMsg = String(existing.status_msg ?? "");
  const nextMsg = String(task?.status_msg ?? "");
  const prevLatest = String(existing.latest_msg_id ?? "");
  const nextLatest = latestMsgIdOf(task);
  const msgChanged = nextMsg !== prevMsg || (nextLatest && nextLatest !== prevLatest);
  if (local === "waiting-answer" || local === "waiting-auth") {
    return hubStatus === "working" || task?.action === "resume" || msgChanged
      || (Array.isArray(task?.answers) && task.answers.length > 0);
  }
  if (local === "pending" || local === "acked") return msgChanged;
  return false;
}

function collectFileViews(task) {
  const views = [];
  const push = (list) => {
    if (!Array.isArray(list)) return;
    for (const item of list) if (item && typeof item === "object") views.push(item);
  };
  push(task?.instruction_attachments);
  push(task?.question_attachments);
  push(task?.answer_attachments);
  push(task?.auth_attachments);
  if (Array.isArray(task?.answers)) {
    for (const answer of task.answers) push(answer?.attachments);
  }
  return views;
}

function hubStatusFromHeartbeatError(err) {
  const msg = String(err?.message ?? "");
  const matched = /任务状态是\s*([^，,\s]+)/.exec(msg);
  return matched ? matched[1] : "";
}

function inboxStatusForHub(status) {
  if (status === "input-required") return "waiting-answer";
  if (status === "auth-required") return "waiting-auth";
  if (status === "completed") return "done";
  return status || "closed";
}

export class AgentDaemon {
  constructor(cfg, opts = {}) {
    if (!cfg?.agentClient) throw new Error("AgentDaemon 需要 busType=agent 的配置（缺少 agentClient）");
    this.cfg = cfg;
    this.client = cfg.agentClient;
    this.log = opts.log ?? defaultLog;
    this.sleep = opts.sleep ?? sleepDefault;
    this.heartbeatMs = opts.heartbeatMs ?? 120_000;
    this._fileClient = opts.fileClient ?? null;
    this._stop = false;
    this._abort = null;
    this._timer = null;
    this._delayIdx = 0;
  }

  requestStop() {
    this._stop = true;
    if (this._abort) this._abort.abort();
    this.#clearHeartbeat();
  }

  fileClient() {
    if (!this._fileClient) this._fileClient = createFileClient(this.cfg);
    return this._fileClient;
  }

  isLeader() {
    const role = String(this.cfg.agentRole ?? this.client.agentRole ?? "").trim().toLowerCase();
    return role === "leader" || role === "hybrid";
  }

  async run({ once = false } = {}) {
    this._stop = false;
    if (!once) this.#startHeartbeat();
    try {
      if (once) {
        await this.#cycle(0);
        await this.sweepHeartbeats();
        return;
      }
      let needRegister = true;
      while (!this._stop) {
        try {
          await this.#cycle(this.cfg.longPollSec ?? this.client.longPollSec ?? 25, { register: needRegister });
          needRegister = false;
          this._delayIdx = 0;
        } catch (err) {
          if (this._stop || isAbortError(err)) break;
          needRegister = true;
          const wait = AGENT_RECONNECT_DELAYS_MS[Math.min(this._delayIdx, AGENT_RECONNECT_DELAYS_MS.length - 1)];
          this._delayIdx = Math.min(this._delayIdx + 1, AGENT_RECONNECT_DELAYS_MS.length - 1);
          this.log(`agent daemon 断线，${wait}ms 后重连：${this.client.redact?.(err?.message ?? err) ?? err?.message ?? err}`);
          await this.sleep(wait);
        }
      }
    } finally {
      this.#clearHeartbeat();
    }
  }

  async #cycle(timeoutSec, { register = true } = {}) {
    if (register) {
      await this.client.register({
        receiveMode: this.cfg.receiveMode || this.client.receiveMode || "http-longpoll",
        role: this.cfg.agentRole || this.client.agentRole,
        nodeDesc: this.cfg.nodeDesc || this.client.nodeDesc,
      });
    }
    const ac = new AbortController();
    this._abort = ac;
    let res;
    try {
      res = await this.client.poll({ timeoutSec, signal: ac.signal });
    } finally {
      if (this._abort === ac) this._abort = null;
    }
    const tasks = [];
    const seen = new Set();
    for (const item of [...(res?.tasks ?? []), ...(res?.items ?? [])]) {
      const id = taskIdOf(item);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      tasks.push(item);
    }
    await this.ingestTasks(tasks);
    if (this.isLeader()) await this.ingestUpdates();
  }

  async ingestTasks(tasks) {
    for (const task of tasks ?? []) {
      try {
        await this.#ingestOne(task);
      } catch (err) {
        if (this._stop || isAbortError(err)) throw err;
        const id = taskIdOf(task) || "?";
        this.log(`agent daemon 处理任务失败 ${id}：${this.client.redact?.(err?.message ?? err) ?? err?.message ?? err}`);
      }
    }
  }

  async #ingestOne(task) {
    const taskId = taskIdOf(task);
    if (!taskId) return;
    let current = task;
    const status = String(task.status ?? "");
    // poll 的 actionable 不含仍在 working 的租约。列表里若已经是 working，直接续接，避免重复认领。
    if (status !== "working") {
      const claimed = await this.client.claim(taskId);
      current = { ...task, ...claimed, status: claimed.status || task.status, task_id: taskId };
    }
    const existing = readInbox(this.cfg.configDir).find((item) => item.task_id === taskId);
    if (!shouldRefreshInbox(existing, current)) return;
    const answers = Array.isArray(current.answers) ? current.answers : [];
    const baseItem = {
      task_id: taskId,
      from_node: current.from_node || current.source || "",
      title: current.title || "",
      text: current.instruction || "",
      params: current.params && typeof current.params === "object" ? current.params : {},
      criteria: Array.isArray(current.criteria) ? current.criteria : [],
      answers: answers.map((a) => ({
        msg_id: a.msg_id || "",
        from_node: a.from_node || "",
        text: a.text || "",
      })),
      status_msg: String(current.status_msg ?? ""),
      latest_msg_id: latestMsgIdOf(current),
      claimed_at: Date.now(),
    };
    // 先落盘骨架再下载附件：即使下载途中进程崩溃，本地已有 working 追踪记录可续心跳，不会孤儿化。
    const hasFiles = collectFileViews(current).length > 0;
    if (hasFiles) {
      enqueueOrUpdateInbox(this.cfg.configDir, { ...baseItem, files: [] });
    }
    const files = hasFiles ? await this.#downloadFiles(taskId, current) : [];
    enqueueOrUpdateInbox(this.cfg.configDir, { ...baseItem, files });
  }

  async #downloadFiles(taskId, task) {
    if (!/^[\w-]+$/.test(taskId)) return [];
    const views = collectFileViews(task);
    const dir = path.join(this.cfg.configDir, "runs", taskId, "files");
    const files = [];
    for (let i = 0; i < views.length; i++) {
      const view = views[i];
      const uri = String(view.file_uri ?? view.uri ?? "").trim();
      if (!uri) continue;
      const file = {
        uri,
        name: String(view.file_name ?? view.name ?? ""),
        mime: String(view.mime_type ?? view.mime ?? ""),
      };
      const fileId = parseHubFileUri(uri);
      if (!fileId) {
        files.push(file);
        continue;
      }
      const dest = path.join(dir, `${String(i + 1).padStart(2, "0")}-${sanitizeFileName(file.name, "file")}`);
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        try { fs.chmodSync(path.dirname(dir), 0o700); fs.chmodSync(dir, 0o700); } catch { /* 目录权限失败不挡下载 */ }
        const got = await this.fileClient().download(uri, dest);
        file.local_path = got.path;
        if (!file.mime && got.mime) file.mime = got.mime;
      } catch (err) {
        file.error = err?.code === "EXPIRED" ? "expired" : err?.code === "NOT_FOUND" ? "not_found" : "download_failed";
        this.log(`附件下载失败 ${fileId}（${file.error}）`);
      }
      files.push(file);
    }
    return files;
  }

  async ingestUpdates() {
    const res = await this.client.updates({ newOnly: true, timeoutSec: 0 });
    const list = Array.isArray(res?.updates) ? res.updates : [];
    if (!list.length) return;
    const queuePath = path.join(this.cfg.configDir, "present_queue.jsonl");
    const seen = this.#seenPresentKeys(queuePath);
    for (const item of list) {
      const status = String(item?.status ?? "");
      if (!PRESENT_STATUSES.has(status)) continue;
      const taskId = taskIdOf(item);
      if (!taskId) continue;
      const key = presentKey(taskId, status, item.status_msg || "");
      if (seen.has(key)) continue;
      const message = item.result_text || item.question_text || item.auth_text || item.notice_text || "";
      await appendQueueItem(queuePath, {
        ts: new Date().toISOString(),
        present_key: key,
        task_id: taskId,
        title: item.title || "",
        source: item.source || "",
        from_node: item.from_node || "",
        target_node: item.target_node || "",
        status,
        status_msg: item.status_msg || "",
        message,
        artifact_ref: "",
        outcome: "",
        error: "",
        text: [`任务 ${taskId}`, `状态 ${status}`, item.title || "", message].filter(Boolean).join("\n"),
      });
      seen.add(key);
    }
  }

  #seenPresentKeys(queuePath) {
    const keys = new Set();
    let raw = "";
    try {
      raw = fs.readFileSync(queuePath, "utf8");
    } catch {
      return keys;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.present_key) keys.add(obj.present_key);
        else if (obj.task_id) keys.add(presentKey(obj.task_id, obj.status, obj.status_msg));
      } catch { /* 坏行留给 ah present 自己跳过 */ }
    }
    return keys;
  }

  async sweepHeartbeats() {
    const open = readInbox(this.cfg.configDir).filter((item) => item.status === "pending" || item.status === "acked");
    for (const item of open) {
      if (this._stop) return;
      const taskId = String(item.task_id ?? "");
      if (!taskId) continue;
      try {
        await this.client.heartbeat(taskId);
      } catch (err) {
        if (this._stop || isAbortError(err)) return;
        const status = Number(err?.status);
        if (status === 404) {
          markInboxStatus(this.cfg.configDir, taskId, "missing");
          continue;
        }
        if (status === 409) {
          const hubStatus = hubStatusFromHeartbeatError(err);
          markInboxStatus(this.cfg.configDir, taskId, inboxStatusForHub(hubStatus));
          continue;
        }
        // 401/403 可能是凭据轮换或临时鉴权失败，只记日志，绝不误关本地挂起任务。
        this.log(`heartbeat 失败 ${taskId}：${this.client.redact?.(err?.message ?? err) ?? err?.message ?? err}`);
      }
    }
  }

  #startHeartbeat() {
    if (this._timer || !this.heartbeatMs || this.heartbeatMs <= 0) return;
    this._timer = setInterval(() => {
      this.sweepHeartbeats().catch((err) => {
        this.log(`heartbeat 扫描失败：${this.client.redact?.(err?.message ?? err) ?? err?.message ?? err}`);
      });
    }, this.heartbeatMs);
    this._timer.unref?.();
  }

  #clearHeartbeat() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }
}
