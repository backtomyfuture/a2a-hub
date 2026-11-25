// 独立常驻 Agent 守护进程（mode=agent）。
// 适合云端/容器或单独运行某个可执行命令的 Agent，通过 40s HTTP 长轮询接单并回报结果。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clampTimeoutSec, loadConfigJson, loadOwnerToken, sanitizeSlug } from "../core/config.mjs";
import { runDetachedCommand } from "../core/proc.mjs";
import { formatCliFailure, parseCliOutput, renderWorkerCommand } from "../core/receipt.mjs";
import { extractHubFileId } from "../store/files.mjs";
import { GatewayClient } from "./gateway-client.mjs";

export const AGENT_RECONNECT_DELAYS_MS = [1000, 3000, 8000, 30_000];

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

export class AgentDaemon {
  constructor({
    configDir,
    agentId,
    hubUrl,
    token = "",
    command = "",
    cwd = "",
    client = null,
    runner = runDetachedCommand,
    pollTimeoutSec = 35,
    idleWaitMs = 2000,
    reconnectDelaysMs = AGENT_RECONNECT_DELAYS_MS,
    logger = console,
  } = {}) {
    this.configDir = configDir;
    const cfg = loadConfigJson(configDir);
    this.agentId = agentId || cfg.agentId || "";
    this.hubUrl = String(hubUrl || cfg.hubUrl || "http://127.0.0.1:8787").replace(/\/+$/, "");
    this.token = token || loadOwnerToken(configDir) || cfg.agentToken || cfg.apiToken || "";
    this.command = command || cfg.command || "";
    this.cwd = cwd || cfg.cwd || os.homedir();
    this.client = client || new GatewayClient(this.hubUrl, { token: this.token });
    this.runner = runner;
    this.pollTimeoutSec = pollTimeoutSec;
    this.idleWaitMs = idleWaitMs;
    this.reconnectDelaysMs = Array.isArray(reconnectDelaysMs) && reconnectDelaysMs.length
      ? reconnectDelaysMs
      : AGENT_RECONNECT_DELAYS_MS;
    this.logger = logger;
    this._running = false;
    this._seq = 0;
  }

  async registerOnline() {
    return this.client.registerAgent({
      id: this.agentId,
      metadata: { host: os.hostname(), mode: "agent-daemon" },
    });
  }

  _buildPrompt(task, { downloaded = [], failedDownloads = [], externalAttachments = [], inputPath = "" } = {}) {
    const parts = [];
    parts.push("### 当前执行节点身份");
    parts.push(`- 你的 Agent ID：${task.to_agent_id || this.agentId}`);
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
            this.logger.warn?.(`[agent-daemon] 下载任务 ${task.id} 附件 ${fileId} 失败: ${errMsg}`);
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
      to_agent_id: task.to_agent_id || this.agentId,
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

  async runOnce() {
    const pollRes = await this.client.pollAgent(this.agentId, {
      since: this._seq,
      timeout: this.pollTimeoutSec,
    });
    if (pollRes?.seq) this._seq = Math.max(this._seq, Number(pollRes.seq));
    if (pollRes?.paused || !pollRes?.tasks?.length) return 0;

    // 收件箱保活模式（无 command，如 Muse VM）：仅长轮询维持在线，不抢单也不误标记 fail
    if (!this.command) {
      if (this.idleWaitMs > 0) {
        await new Promise((r) => setTimeout(r, this.idleWaitMs));
      }
      return 0;
    }

    const candidate = pollRes.tasks[0];
    let claimed;
    try {
      const r = await this.client.claimTask(candidate.id, { leaseSec: 600 });
      claimed = r?.task;
    } catch {
      return 0;
    }
    if (!claimed) return 0;

    const { runDir, promptPath, promptText } = await this._prepareRunDir(claimed);

    const usesPromptArg = /\{prompt(?:_file)?\}/.test(String(this.command || ""));
    const cmd = renderWorkerCommand({
      worker: { key: this.agentId, command: this.command, cwd: this.cwd },
      prompt: promptText,
      promptFile: promptPath,
      model: claimed.model || "",
    });
    const timeoutSec = clampTimeoutSec(claimed.timeout_sec);
    const res = await this.runner(cmd, usesPromptArg ? null : promptText, timeoutSec, this.cwd, {
      AH_AGENT_ID: claimed.to_agent_id || this.agentId,
      AH_TASK_ID: claimed.id,
      AH_CONTEXT_ID: claimed.context_id,
      AH_RUN_DIR: runDir,
    });
    const parsed = parseCliOutput(res.stdout, res.stderr);
    if (res.code === 0 && !parsed.isError) {
      const text = parsed.text || "(完成)";
      await this.client.complete(claimed.id, {
        summary: text.slice(0, 240),
        text,
        usage: parsed.usage,
      });
    } else {
      await this.client.fail(claimed.id, {
        error: formatCliFailure(parsed, res.stderr, res.code),
        retryable: false,
      });
    }
    return 1;
  }

  async start() {
    this._running = true;
    let delayIdx = 0;
    let needRegister = true;
    while (this._running) {
      try {
        if (needRegister) {
          await this.registerOnline();
          needRegister = false;
        }
        await this.runOnce();
        delayIdx = 0;
      } catch (err) {
        const waitMs = this.reconnectDelaysMs[Math.min(delayIdx, this.reconnectDelaysMs.length - 1)] || 3000;
        delayIdx = Math.min(delayIdx + 1, this.reconnectDelaysMs.length - 1);
        needRegister = true;
        this.logger.warn?.(`[agent-daemon] 轮询异常，${Math.round(waitMs / 1000)}s 后重试: ${err?.message || err}`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  stop() {
    this._running = false;
  }
}
