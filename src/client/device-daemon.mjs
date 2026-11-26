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
import {
  extractLastAuthRequest,
  extractSignedDecisions,
  isHubPublicKey,
  pickSignedDecision,
} from "../core/approval-sign.mjs";
import { runDetachedCommand } from "../core/proc.mjs";
import { formatCliFailure, parseCliOutput, renderWorkerCommand } from "../core/receipt.mjs";
import { SessionStore } from "../core/session-store.mjs";
import { extractHubFileId } from "../store/files.mjs";
import { GatewayClient } from "./gateway-client.mjs";

const DEFAULT_RISK_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\bgit\s+push\s+--force\b/i,
  /\bdrop\s+table\b/i,
];

function collectTaskAttachments(task) {
  const all = [];
  if (Array.isArray(task?.attachments)) {
    for (const att of task.attachments) {
      if (att) all.push(att);
    }
  }
  if (Array.isArray(task?.messages)) {
    for (const m of task.messages) {
      if (!Array.isArray(m?.attachments)) continue;
      for (const att of m.attachments) {
        if (att) all.push(att);
      }
    }
  }
  const seen = new Set();
  const deduped = [];
  for (const att of all) {
    const fid = extractHubFileId(att);
    const key = fid
      ? `hub:${fid}`
      : typeof att === "string"
        ? `str:${att.trim()}`
        : String(att?.uri || att?.url || JSON.stringify(att));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(att);
  }
  return deduped;
}


function sleepAbortable(ms, signal) {
  if (!ms || ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
    this._pollAbort = new AbortController();
    this._taskAbort = new AbortController();
  }

  _loadWorkersIfChanged() {
    const filePath = path.join(this.configDir, "workers.json");
    let mtime = 0;
    try {
      mtime = fs.statSync(filePath).mtimeMs;
    } catch {
      mtime = 0;
    }
    // workers 为空时也要比较 mtime，否则每轮都判定“已变更”并重复同步，形成热循环
    if (mtime === this._workersMtime) return false;
    this._workersMtime = mtime;
    this.workers = loadWorkersJson(this.configDir);
    return true;
  }

  async syncNow() {
    this._loadWorkersIfChanged();
    const payload = this.workers
      .filter((w) => w && w.key)
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
        enabled: w.enabled !== false,
      }));

    const res = await this.client.syncDevice(
      this.deviceId,
      payload,
      {
        platform: os.platform(),
        os_info: `${os.type()} ${os.release()} (${os.arch()})`,
        transport: "longpoll",
        max_concurrent: this.maxConcurrent,
      },
      { signal: this._pollAbort.signal }
    );
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

  _buildPrompt(task, { downloaded = [], failedDownloads = [], externalAttachments = [], inputPath = "" } = {}) {
    const parts = [];
    // 在指令开头固定写入当前执行节点的真实身份，防止同 Thread 多节点并发扇出时自报身份错位。
    parts.push("### 当前执行节点身份");
    parts.push(`- 你的 Agent ID：${task.to_agent_id}`);
    parts.push(`- 所属设备：${this.deviceId}`);
    parts.push(`- 任务 ID：${task.id}`);
    parts.push(`- 线程 ID：${task.context_id}`);
    parts.push(`- 发起方：${task.from_node}`);
    parts.push("");

    if (Array.isArray(task.context_history) && task.context_history.length > 0) {
      parts.push("### 同线程其他/前序任务记录（仅供参考，非你本节点身份）");
      for (const h of task.context_history) {
        parts.push(`- [${h.to_agent_id} | ${h.state}] ${h.title}: ${h.summary || h.input_text}`);
      }
      parts.push("");
    }
    const msgs = Array.isArray(task.messages) ? task.messages : [];
    const extraNotes = msgs.filter((m) => m.kind === "answer" || m.kind === "auth_decision");
    parts.push("### 当前任务目标");
    if (task.title) parts.push(`标题：${task.title}`);
    if (task.input_text) {
      parts.push(task.input_text);
    } else if (!task.title) {
      parts.push("(未提供具体任务文本)");
    }
    if (extraNotes.length > 0) {
      parts.push("");
      parts.push("### 机主/发起方最新补充说明");
      for (const n of extraNotes) {
        parts.push(`- [${n.kind}] ${n.body}`);
      }
    }
    if (downloaded.length > 0 || failedDownloads.length > 0 || externalAttachments.length > 0) {
      parts.push("");
      parts.push("### 任务附件");
      for (const d of downloaded) {
        const sizePart = Number.isFinite(Number(d.size)) ? `${d.size} bytes` : "未知大小";
        const mimePart = d.mime ? `, ${d.mime}` : "";
        parts.push(`- [已下载] ${d.name} (${sizePart}${mimePart}) | URI: ${d.uri} | 本机绝对路径: ${d.local_path}`);
      }
      for (const f of failedDownloads) {
        parts.push(`- [下载失败] ${f.name} | URI: ${f.uri} | 原因: ${f.error}（如任务依赖该附件，请在回执中如实说明读取失败及原因）`);
      }
      for (const ex of externalAttachments) {
        parts.push(`- [外部附件] ${ex.name} | URL: ${ex.uri}`);
      }
      if (downloaded.length > 0) {
        parts.push("提示：以上 [已下载] 附件已自动落盘到本机上述绝对路径，请直接使用本地文件读取工具查看内容。");
      }
      if (inputPath) {
        parts.push(`完整任务输入元数据 JSON：${inputPath}`);
      }
    }
    return parts.join("\n");
  }

  async _prepareRunDir(task) {
    const runDir = path.join(this.configDir, "runs", sanitizeSlug(task.id, "task"));
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });

    const downloaded = [];
    const failedDownloads = [];
    const externalAttachments = [];
    const attachments = collectTaskAttachments(task);
    if (attachments.length > 0) {
      const filesDir = path.join(runDir, "files");
      fs.mkdirSync(filesDir, { recursive: true });
      const usedNames = new Set();
      for (let idx = 0; idx < attachments.length; idx++) {
        const att = attachments[idx];
        const fileId = extractHubFileId(att);
        if (fileId) {
          const uri = (typeof att === "object" && att?.uri) || `hub://files/${fileId}`;
          const displayName = path.basename(String((typeof att === "object" && att?.name) || `${fileId}.bin`)).slice(0, 200) || `${fileId}.bin`;
          try {
            const buf = await this.client.downloadFile(fileId);
            const fname = usedNames.has(displayName) ? `${idx + 1}_${displayName}` : displayName;
            usedNames.add(fname);
            const dest = path.join(filesDir, fname);
            fs.writeFileSync(dest, buf, { mode: 0o600 });
            downloaded.push({
              id: fileId,
              uri,
              name: displayName,
              mime: (typeof att === "object" && att?.mime) || "",
              size: buf.byteLength,
              local_path: dest,
            });
          } catch (err) {
            const errMsg = err?.message || String(err);
            this.logger.warn?.(`[device-daemon] 下载任务 ${task.id} 附件 ${fileId} 失败: ${errMsg}`);
            failedDownloads.push({
              id: fileId,
              uri,
              name: displayName,
              error: errMsg,
            });
          }
        } else {
          const extUri = typeof att === "string" ? att.trim() : String(att?.uri || att?.url || "").trim();
          if (extUri) {
            externalAttachments.push({
              uri: extUri,
              name: (typeof att === "object" && att?.name) || extUri.split("/").pop() || "attachment",
              ...(typeof att === "object" && att?.mime ? { mime: att.mime } : {}),
              ...(typeof att === "object" && Number.isFinite(Number(att?.size)) ? { size: Number(att.size) } : {}),
            });
          }
        }
      }
    }

    const inputObj = {
      task_id: task.id,
      context_id: task.context_id,
      from_node: task.from_node,
      to_agent_id: task.to_agent_id,
      device_id: this.deviceId,
      run_dir: runDir,
      title: task.title,
      input_text: task.input_text,
      params: task.params || {},
      attachments,
      downloaded_files: downloaded,
      failed_downloads: failedDownloads,
      external_attachments: externalAttachments,
      context_history: task.context_history || [],
      messages: task.messages || [],
    };
    const inputPath = path.join(runDir, "input.json");
    fs.writeFileSync(inputPath, JSON.stringify(inputObj, null, 2), { mode: 0o600 });
    try { fs.chmodSync(inputPath, 0o600); } catch {}

    const promptText = this._buildPrompt(task, {
      downloaded,
      failedDownloads,
      externalAttachments,
      inputPath,
    });
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

    const { runDir, promptPath, promptText } = await this._prepareRunDir(task);
    const prevSess = this.sessionStore.get(task.context_id, worker.key);
    const activeTpl = prevSess?.session_id && worker.resume_command ? worker.resume_command : worker.command;
    // 命令模板已通过参数传入提示词时，不再向 stdin 重复注入 promptText
    const usesPromptArg = /\{prompt(?:_file)?\}/.test(String(activeTpl || ""));
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
      const res = await this.runner(
        cmd,
        usesPromptArg ? null : promptText,
        timeoutSec,
        cwd,
        {
          AH_AGENT_ID: task.to_agent_id,
          AH_DEVICE_ID: this.deviceId,
          AH_WORKER_KEY: worker.key,
          AH_TASK_ID: task.id,
          AH_CONTEXT_ID: task.context_id,
          AH_RUN_DIR: runDir,
        },
        { signal: this._taskAbort.signal }
      );
      const parsed = parseCliOutput(res.stdout, res.stderr);
      if (parsed.sessionId) {
        this.sessionStore.save(task.context_id, worker.key, {
          sessionId: parsed.sessionId,
          taskId: task.id,
          model: task.model || worker.default_model || "",
        });
      }

      if (res.code === 0 && !parsed.isError) {
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
        const errMsg = formatCliFailure(parsed, res.stderr, res.code);
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

    const enabledAgentIds = this.workers
      .filter((w) => w && w.enabled !== false)
      .map((w) => `${this.deviceId}--${w.key}`);
    if (enabledAgentIds.length === 0) return 0;

    const list = Array.isArray(candidates) ? candidates : [];
    if (list.length === 0) return 0;

    let started = 0;
    // 仅认领 poll 返回的候选任务，避免空轮询或短队列末尾多打一次无意义的 POST /tasks/claim。
    for (const candidate of list) {
      if (started >= capacity) break;
      if (!candidate?.id) continue;
      try {
        const r = await this.client.claimTask(candidate.id, { leaseSec: 600 });
        if (r?.task) {
          started += 1;
          this._enqueueExecution(r.task);
        }
      } catch {
        // 已被并发认领或状态已变化时跳过，继续尝试下一条候选任务
      }
    }

    // 仅当服务端单次 /poll 返回达到上限（50 条）且仍有空闲槽位时，再兜底 claimNext 补抓余量。
    if (started < capacity && list.length >= 50) {
      while (started < capacity) {
        const r = await this.client.claimNext({ agentIds: enabledAgentIds, leaseSec: 600 });
        if (!r?.task) break;
        started += 1;
        this._enqueueExecution(r.task);
      }
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
      signal: this._pollAbort.signal,
    });
    if (pollRes?.seq) this._seq = Math.max(this._seq, Number(pollRes.seq));
    if (pollRes?.paused) return 0;
    return this.drainPendingTasks(pollRes?.tasks || []);
  }

  async start() {
    if (this._running) return;
    if (this._pollAbort.signal.aborted) this._pollAbort = new AbortController();
    if (this._taskAbort.signal.aborted) this._taskAbort = new AbortController();
    this._running = true;

    // 启动期等待 Hub 就绪并完成首次名片同步（不因暂时连不上而崩溃退出）
    while (this._running) {
      try {
        await this.syncNow();
        break;
      } catch (err) {
        if (!this._running || this._pollAbort.signal.aborted) break;
        this.logger.warn?.(`[device-daemon] 同步失败，3s 后重试: ${err?.message || err}`);
        await sleepAbortable(3000, this._pollAbort.signal);
      }
    }

    while (this._running) {
      try {
        await this.runOnce();
      } catch (err) {
        if (!this._running || this._pollAbort.signal.aborted) break;
        this.logger.warn?.(`[device-daemon] 轮询异常，3s 后重试: ${err?.message || err}`);
        await sleepAbortable(3000, this._pollAbort.signal);
      }
    }
  }

  async stop({ graceMs = 3000 } = {}) {
    this._running = false;
    // 立刻中止挂起中的长轮询和重试退避，避免系统关机或服务重启卡死 35 秒。
    this._pollAbort.abort();
    const pending = [...this._activeTasks.values()];
    if (pending.length === 0) return;

    const allDone = Promise.allSettled(pending);
    if (!Number.isFinite(graceMs) || graceMs <= 0) {
      this._taskAbort.abort();
      await Promise.race([allDone, sleepAbortable(500)]);
      return;
    }

    let timedOut = false;
    await Promise.race([
      allDone,
      sleepAbortable(graceMs).then(() => {
        timedOut = true;
      }),
    ]);
    if (timedOut && this._activeTasks.size > 0) {
      this._taskAbort.abort();
      await Promise.race([allDone, sleepAbortable(500)]);
    }
  }
}
