// 独立常驻 Agent 守护进程（mode=agent）。
// 适合云端/容器或单独运行某个可执行命令的 Agent，通过 40s HTTP 长轮询接单并回报结果。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clampTimeoutSec, loadConfigJson, sanitizeSlug } from "../core/config.mjs";
import { runDetachedCommand } from "../core/proc.mjs";
import { formatCliFailure, parseCliOutput, renderWorkerCommand } from "../core/receipt.mjs";
import { GatewayClient } from "./gateway-client.mjs";

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
    logger = console,
  } = {}) {
    this.configDir = configDir;
    const cfg = loadConfigJson(configDir);
    this.agentId = agentId || cfg.agentId || "";
    this.hubUrl = String(hubUrl || cfg.hubUrl || "http://127.0.0.1:8787").replace(/\/+$/, "");
    this.token = token || cfg.agentToken || cfg.apiToken || "";
    this.command = command || cfg.command || "";
    this.cwd = cwd || cfg.cwd || os.homedir();
    this.client = client || new GatewayClient(this.hubUrl, { token: this.token });
    this.runner = runner;
    this.pollTimeoutSec = pollTimeoutSec;
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

    const candidate = pollRes.tasks[0];
    let claimed;
    try {
      const r = await this.client.claimTask(candidate.id, { leaseSec: 600 });
      claimed = r?.task;
    } catch {
      return 0;
    }
    if (!claimed) return 0;

    if (!this.command) {
      await this.client.fail(claimed.id, {
        error: "agent-daemon 未配置 command 执行命令",
        retryable: false,
      });
      return 1;
    }

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
    while (this._running) {
      try {
        await this.registerOnline();
        break;
      } catch (err) {
        this.logger.warn?.(`[agent-daemon] 注册失败，3s 后重试: ${err?.message || err}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    while (this._running) {
      try {
        await this.runOnce();
      } catch (err) {
        this.logger.warn?.(`[agent-daemon] 轮询异常，3s 后重试: ${err?.message || err}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  stop() {
    this._running = false;
  }
}
