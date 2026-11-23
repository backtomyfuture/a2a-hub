// 独立常驻 Agent 守护进程（mode=agent）。
// 适合云端/容器或单独运行某个可执行命令的 Agent，通过 40s HTTP 长轮询接单并回报结果。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clampTimeoutSec, loadConfigJson, loadOwnerToken, sanitizeSlug } from "../core/config.mjs";
import { runDetachedCommand } from "../core/proc.mjs";
import { formatCliFailure, parseCliOutput, renderWorkerCommand } from "../core/receipt.mjs";
import { GatewayClient } from "./gateway-client.mjs";

export const AGENT_RECONNECT_DELAYS_MS = [1000, 3000, 8000, 30_000];

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

    const runDir = path.join(this.configDir, "runs", sanitizeSlug(claimed.id, "task"));
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const promptPath = path.join(runDir, "prompt.txt");
    const promptText = claimed.input_text || claimed.title || "";
    fs.writeFileSync(promptPath, promptText, { mode: 0o600 });

    const usesPromptArg = /\{prompt(?:_file)?\}/.test(String(this.command || ""));
    const cmd = renderWorkerCommand({
      worker: { key: this.agentId, command: this.command, cwd: this.cwd },
      prompt: promptText,
      promptFile: promptPath,
      model: claimed.model || "",
    });
    const timeoutSec = clampTimeoutSec(claimed.timeout_sec);
    const res = await this.runner(cmd, usesPromptArg ? null : promptText, timeoutSec, this.cwd);
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
