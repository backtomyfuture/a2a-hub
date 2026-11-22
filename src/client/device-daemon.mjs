// 电脑设备守护进程（DeviceDaemon，v2.0）。
// 核心改进：
// 1. 真正的多 Worker 并发调度池（maxConcurrent，默认 4）：不同 Worker 或不同 Thread 并行执行，互不阻塞。
// 2. 同 (context_id, worker_key) 严格串行，防止同一 CLI --resume 会话并发冲突。
// 3. 本地 workers.json 变动自动同步到 Hub，且高危/预检任务执行前校验 Hub ed25519 审批签名。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clampTimeoutSec,
  HEARTBEAT_MIN_SEC,
  loadConfigJson,
  loadWorkersJson,
  sanitizeSlug,
} from "../core/config.mjs";
import { isHubPublicKey, pickSignedDecision } from "../core/approval-sign.mjs";
import { runDetachedCommand } from "../core/proc.mjs";
import { parseCliOutput, renderWorkerCommand } from "../core/receipt.mjs";
import { SessionStore } from "../core/session-store.mjs";
import { parseHubFileUri } from "../store/files.mjs";
import { GatewayClient } from "./gateway-client.mjs";

const DEFAULT_RISK_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\bgit\s+push\s+--force\b/i,
  /\bdrop\s+table\b/i,
];

function extractLastAuthRequest(task) {
  const msgs = Array.isArray(task?.messages) ? task.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].kind === "auth_request") return msgs[i];
  }
  return null;
}

function extractSignedDecisions(task) {
  const msgs = Array.isArray(task?.messages) ? task.messages : [];
  return msgs
    .filter((m) => m.kind === "auth_decision")
    .reverse()
    .map((m) => ({
      decision: m.data?.decision || m.body,
      sig: m.signature || m.data?.signature || "",
    }));
}

export class DeviceDaemon {
  constructor({
    configDir,
    deviceId,
    hubUrl,
    token = "",
    client = null,
    maxConcurrent = 4,
    hubPublicKey = "",
    runner = runDetachedCommand,
    pollTimeoutSec = 35,
    logger = console,
  } = {}) {
    this.configDir = configDir;
    const cfg = loadConfigJson(configDir);
    this.deviceId = sanitizeSlug(deviceId || cfg.deviceId || os.hostname(), "device");
    this.hubUrl = String(hubUrl || cfg.hubUrl || "http://127.0.0.1:8787").replace(/\/+$/, "");
    this.token = token || cfg.deviceToken || cfg.apiToken || "";
    this.client = client || new GatewayClient(this.hubUrl, { token: this.token });
    this.maxConcurrent = Math.max(Number(maxConcurrent || cfg.maxConcurrent || 4) || 4, 1);
    this.hubPublicKey = hubPublicKey || cfg.hubPublicKey || "";
    this.runner = runner;
    this.pollTimeoutSec = pollTimeoutSec;
    this.logger = logger;

    this.sessionStore = new SessionStore(configDir);
    this.workers = [];
    this._workersMtime = -1;
    this._activeTasks = new Map(); // taskId -> Promise
    this._contextTail = new Map(); // `${context_id}::${worker_key}` -> Promise
    this._running = false;
    this._seq = 0;
  }

  _loadWorkersIfChanged() {
    const filePath = path.join(this.configDir, "workers.json");
    let mtime = 0;
    try {
      mtime = fs.statSync(filePath).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (mtime === this._workersMtime && this.workers.length > 0) return false;
    this._workersMtime = mtime;
    this.workers = loadWorkersJson(this.configDir);
    return true;
  }

  async syncNow() {
    this._loadWorkersIfChanged();
    const payload = this.workers
      .filter((w) => w && w.enabled !== false)
      .map((w) => ({
        key: w.key,
        name: w.name || w.key,
        role: w.role || "worker",
        platform: w.platform || "cli",
        summary: w.summary || "",
        skills: Array.isArray(w.skills) ? w.skills : [],
        tools: Array.isArray(w.tools) ? w.tools : [],
        models: Array.isArray(w.models) ? w.models : [],
        default_model: w.default_model || "",
        approval_policy: w.approval_policy || "never",
      }));

    const res = await this.client.syncDevice(this.deviceId, payload, {
      platform: os.platform(),
      os_info: `${os.type()} ${os.release()} (${os.arch()})`,
      transport: "longpoll",
      max_concurrent: this.maxConcurrent,
    });
    if (res?.approval_public_key && isHubPublicKey(res.approval_public_key)) {
      this.hubPublicKey = res.approval_public_key;
    }
    return res;
  }

  _findWorkerByAgentId(agentId) {
    const prefix = `${this.deviceId}--`;
    const key = agentId.startsWith(prefix) ? agentId.slice(prefix.length) : agentId;
    return this.workers.find((w) => w.key === key) || null;
  }

  _buildPrompt(task) {
    const parts = [];
    if (Array.isArray(task.context_history) && task.context_history.length > 0) {
      parts.push("### 同会话历史前情");
      for (const h of task.context_history) {
        parts.push(`- [${h.to_agent_id} | ${h.state}] ${h.title}: ${h.summary || h.input_text}`);
      }
      parts.push("");
    }
    const msgs = Array.isArray(task.messages) ? task.messages : [];
    const extraNotes = msgs.filter((m) => m.kind === "answer" || m.kind === "auth_decision");
    parts.push("### 当前任务目标");
    if (task.title) parts.push(`标题：${task.title}`);
    parts.push(task.input_text || task.title || "");
    if (extraNotes.length > 0) {
      parts.push("");
      parts.push("### 机主/发起方最新补充说明");
      for (const n of extraNotes) {
        parts.push(`- [${n.kind}] ${n.body}`);
      }
    }
    return parts.join("\n");
  }

  async _prepareRunDir(task) {
    const runDir = path.join(this.configDir, "runs", sanitizeSlug(task.id, "task"));
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });

    const downloaded = [];
    const attachments = Array.isArray(task.attachments) ? task.attachments : [];
    if (attachments.length > 0) {
      const filesDir = path.join(runDir, "files");
      fs.mkdirSync(filesDir, { recursive: true });
      for (const att of attachments) {
        const uri = typeof att === "string" ? att : att?.uri || att?.url || "";
        const fileId = parseHubFileUri(uri);
        if (!fileId) continue;
        try {
          const buf = await this.client.downloadFile(fileId);
          const fname = path.basename(String(att?.name || `${fileId}.bin`)) || `${fileId}.bin`;
          const dest = path.join(filesDir, fname);
          fs.writeFileSync(dest, buf, { mode: 0o600 });
          downloaded.push({ uri, name: fname, local_path: dest });
        } catch {}
      }
    }

    const inputObj = {
      task_id: task.id,
      context_id: task.context_id,
      from_node: task.from_node,
      to_agent_id: task.to_agent_id,
      title: task.title,
      input_text: task.input_text,
      params: task.params || {},
      attachments,
      downloaded_files: downloaded,
      context_history: task.context_history || [],
      messages: task.messages || [],
    };
    const inputPath = path.join(runDir, "input.json");
    fs.writeFileSync(inputPath, JSON.stringify(inputObj, null, 2), { mode: 0o600 });
    try { fs.chmodSync(inputPath, 0o600); } catch {}

    const promptText = this._buildPrompt(task);
    const promptPath = path.join(runDir, "prompt.txt");
    fs.writeFileSync(promptPath, promptText, { mode: 0o600 });
    try { fs.chmodSync(promptPath, 0o600); } catch {}

    return { runDir, inputPath, promptPath, promptText };
  }

  async executeTask(task) {
    const worker = this._findWorkerByAgentId(task.to_agent_id);
    if (!worker) {
      await this.client.fail(task.id, { error: `本地未找到 Worker 配置: ${task.to_agent_id}`, retryable: false });
      return;
    }

    // 校验高危审批或预检签名
    const authReq = extractLastAuthRequest(task);
    const decisions = extractSignedDecisions(task);
    const needApproval = worker.approval_policy === "always" || Boolean(authReq);

    if (needApproval) {
      if (!authReq) {
        await this.client.requestAuth(task.id, {
          reason: `本地 Worker「${worker.name || worker.key}」要求机主确认后执行`,
          riskLevel: "preflight",
        });
        return;
      }
      if (!isHubPublicKey(this.hubPublicKey)) {
        await this.client.fail(task.id, { error: "缺少有效 Hub 审批验签公钥 (hubPublicKey)", retryable: false });
        return;
      }
      const reqId = String(authReq.data?.request_id || "default");
      const approved = pickSignedDecision(this.hubPublicKey, task.id, reqId, decisions);
      if (approved !== "approved") {
        await this.client.fail(task.id, { error: "审批签名无效或未批准", retryable: false });
        return;
      }
    } else if (worker.approval_policy === "risk") {
      const hitRisk = DEFAULT_RISK_PATTERNS.some((re) => re.test(task.input_text || ""));
      if (hitRisk && decisions.length === 0) {
        await this.client.requestAuth(task.id, {
          reason: "任务文本命中高危命令关键词，等待机主确认放行",
          commandPreview: String(task.input_text || "").slice(0, 200),
          riskLevel: "high",
        });
        return;
      }
    }

    const { promptPath, promptText } = await this._prepareRunDir(task);
    const prevSess = this.sessionStore.get(task.context_id, worker.key);
    const cmd = renderWorkerCommand({
      worker,
      prompt: promptText,
      promptFile: promptPath,
      sessionId: prevSess?.session_id || "",
      model: task.model || worker.default_model || "",
    });
    const timeoutSec = clampTimeoutSec(worker.timeout_sec || task.timeout_sec);
    const cwd = worker.cwd && fs.existsSync(worker.cwd) ? worker.cwd : os.homedir();

    // 执行期间定时发送心跳续约，避免长耗时任务被 Hub 判为陈旧回收
    const hbIntervalMs = Math.min(Math.max(HEARTBEAT_MIN_SEC * 1000, 30_000), 120_000);
    const hbTimer = setInterval(() => {
      void this.client.heartbeat(task.id, { progress: { stage: "running" }, leaseSec: timeoutSec + 120 }).catch(() => {});
    }, hbIntervalMs);
    if (typeof hbTimer.unref === "function") hbTimer.unref();

    try {
      const res = await this.runner(cmd, promptText, timeoutSec, cwd);
      const parsed = parseCliOutput(res.stdout, res.stderr);
      if (parsed.sessionId) {
        this.sessionStore.save(task.context_id, worker.key, {
          sessionId: parsed.sessionId,
          taskId: task.id,
          model: task.model || worker.default_model || "",
        });
      }

      if (res.code === 0) {
        const text = parsed.text || "(执行完成，无输出文本)";
        await this.client.complete(task.id, {
          summary: text.slice(0, 240),
          text,
          usage: parsed.usage,
          data: {
            worker_key: worker.key,
            session_id: parsed.sessionId || prevSess?.session_id || "",
          },
        });
      } else {
        const errMsg = (res.stderr || parsed.text || `exit_code=${res.code}`).trim().slice(0, 1000);
        await this.client.fail(task.id, {
          error: errMsg,
          retryable: false,
          data: { code: res.code, signal: res.signal },
        });
      }
    } catch (err) {
      await this.client.fail(task.id, {
        error: err?.message || String(err),
        retryable: false,
      }).catch(() => {});
    } finally {
      clearInterval(hbTimer);
    }
  }

  _enqueueExecution(task) {
    if (this._activeTasks.has(task.id)) return;
    const workerKey = task.to_agent_id;
    const lockKey = `${task.context_id}::${workerKey}`;
    const prevChain = this._contextTail.get(lockKey) || Promise.resolve();

    const p = prevChain
      .catch(() => {})
      .then(() => this.executeTask(task))
      .catch((err) => {
        this.logger.error?.(`[device-daemon] 任务 ${task.id} 异常:`, err?.message || err);
      })
      .finally(() => {
        this._activeTasks.delete(task.id);
        if (this._contextTail.get(lockKey) === p) {
          this._contextTail.delete(lockKey);
        }
      });

    this._contextTail.set(lockKey, p);
    this._activeTasks.set(task.id, p);
  }

  async drainPendingTasks(candidates = []) {
    const capacity = this.maxConcurrent - this._activeTasks.size;
    if (capacity <= 0) return 0;

    let started = 0;
    const enabledAgentIds = this.workers
      .filter((w) => w && w.enabled !== false)
      .map((w) => `${this.deviceId}--${w.key}`);

    // 尽量并发认领直到槽位满或队列清空
    for (let i = 0; i < capacity; i++) {
      let claimed = null;
      if (candidates[i]) {
        try {
          const r = await this.client.claimTask(candidates[i].id, { leaseSec: 600 });
          claimed = r?.task || null;
        } catch {
          claimed = null;
        }
      }
      if (!claimed) {
        const r = await this.client.claimNext({ agentIds: enabledAgentIds, leaseSec: 600 });
        claimed = r?.task || null;
      }
      if (!claimed) break;
      started += 1;
      this._enqueueExecution(claimed);
    }
    return started;
  }

  async runOnce() {
    if (this._loadWorkersIfChanged()) {
      await this.syncNow();
    }
    const pollRes = await this.client.pollDevice(this.deviceId, {
      since: this._seq,
      timeout: this.pollTimeoutSec,
    });
    if (pollRes?.seq) this._seq = Math.max(this._seq, Number(pollRes.seq));
    if (pollRes?.paused) return 0;
    return this.drainPendingTasks(pollRes?.tasks || []);
  }

  async start() {
    if (this._running) return;
    this._running = true;

    // 启动期等待 Hub 就绪并完成首次名片同步（不因暂时连不上而崩溃退出）
    while (this._running) {
      try {
        await this.syncNow();
        break;
      } catch (err) {
        this.logger.warn?.(`[device-daemon] 同步失败，3s 后重试: ${err?.message || err}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    while (this._running) {
      try {
        await this.runOnce();
      } catch (err) {
        this.logger.warn?.(`[device-daemon] 轮询异常，3s 后重试: ${err?.message || err}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  async stop() {
    this._running = false;
    await Promise.allSettled([...this._activeTasks.values()]);
  }
}
