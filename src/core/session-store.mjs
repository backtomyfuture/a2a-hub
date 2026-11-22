// 跨任务 CLI 会话持久化（按 context_id + worker_key 存储）。
// 同一个 Thread（context_id）下连续多轮派给同一本地 CLI 时，自动续接上次的 CLI Session ID。

import fs from "node:fs";
import path from "node:path";
import { sanitizeSlug, writeJsonAtomic, readJsonIfExists } from "./config.mjs";

export class SessionStore {
  constructor(configDir) {
    this.sessionsDir = path.join(configDir, "sessions");
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  _path(contextId, workerKey) {
    const c = sanitizeSlug(contextId, "default");
    const w = sanitizeSlug(workerKey, "worker");
    return path.join(this.sessionsDir, `${c}__${w}.json`);
  }

  get(contextId, workerKey) {
    if (!contextId || !workerKey) return null;
    return readJsonIfExists(this._path(contextId, workerKey), null);
  }

  save(contextId, workerKey, { sessionId, taskId, model = "" } = {}) {
    if (!contextId || !workerKey || !sessionId) return null;
    const prev = this.get(contextId, workerKey);
    const record = {
      context_id: String(contextId),
      worker_key: String(workerKey),
      session_id: String(sessionId),
      model: String(model || prev?.model || ""),
      last_task_id: String(taskId || ""),
      task_count: (prev?.task_count || 0) + 1,
      updated_at: Date.now(),
    };
    writeJsonAtomic(this._path(contextId, workerKey), record, 0o600);
    return record;
  }
}
