// 本地 Agent 收件箱、人类审批与定时打卡 CLI（`ah inbox`、`ah present` 与 `ah schedule`）。
// 仅走 Hub REST API，不直接碰 SQLite。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GatewayClient } from "./gateway-client.mjs";
import { loadConfigJson, loadOwnerToken, readLiveHubUrl } from "../core/config.mjs";
import { DEFAULT_TIMEZONE } from "../core/cron.mjs";
import { guessMimeByFilename } from "../store/files.mjs";

export async function uploadLocalAttachments(client, rawAttach, { taskId = null } = {}) {
  if (!rawAttach) return [];
  const list = (Array.isArray(rawAttach) ? rawAttach : [rawAttach])
    .flatMap((v) => String(v || "").split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  const uploaded = [];
  for (const filePath of list) {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`附件文件不存在: ${filePath}`);
    }
    const st = fs.statSync(absPath);
    if (!st.isFile()) {
      throw new Error(`附件路径不是普通文件: ${filePath}`);
    }
    const buf = fs.readFileSync(absPath);
    const name = path.basename(absPath);
    const mime = guessMimeByFilename(name);
    const res = await client.uploadFile({ buffer: buf, name, mime, taskId });
    const f = res.file;
    uploaded.push({
      id: f.id,
      uri: f.uri,
      name: f.name,
      mime: f.mime,
      size: f.size,
      sha256: f.sha256,
    });
  }
  return uploaded;
}

export function makeClientForConfig(configDir, { hubUrl, token } = {}) {
  const cfg = loadConfigJson(configDir);
  const url = hubUrl || readLiveHubUrl(configDir) || cfg.hubUrl || "http://127.0.0.1:8787";
  const tok = token || loadOwnerToken(configDir) || cfg.agentToken || cfg.deviceToken || "";
  return {
    client: new GatewayClient(url, { token: tok }),
    cfg,
    agentId: cfg.agentId || "",
  };
}

export async function runInboxCommand(args, { configDir, io = console } = {}) {
  const flags = parseSimpleFlags(args);
  const sub = flags._[0] || (flags.pop ? "pop" : "list");
  const pos = flags._.slice(1);
  const { client, agentId } = makeClientForConfig(configDir, { hubUrl: flags.hub, token: flags.token });
  const targetAgent = (typeof flags.agent === "string" ? flags.agent : "") || agentId;

  if (sub === "check") {
    if (!targetAgent) throw new Error("请指定 --agent <id> 或在 agent 模式下配置 agentId");
    const r = await client.checkAgent(targetAgent);
    io.log(JSON.stringify(r, null, 2));
    return 0;
  }

  if (sub === "pop") {
    const r = await client.claimNext({
      agentIds: targetAgent ? [targetAgent] : null,
    });
    if (r?.task) {
      io.log(JSON.stringify(r.task, null, 2));
    }
    return 0;
  }

  if (sub === "list") {
    if (targetAgent) {
      const r = await client.inboxAgent(targetAgent);
      io.log(JSON.stringify(r.tasks || [], null, 2));
      return 0;
    }
    const r = await client.listTasks({ state: flags.state || "" });
    io.log(JSON.stringify(r.tasks || [], null, 2));
    return 0;
  }

  if (sub === "show" || sub === "read") {
    const taskId = pos[0];
    if (!taskId) throw new Error("用法: ah inbox show <task_id>");
    const r = await client.getTask(taskId);
    io.log(JSON.stringify(r.task, null, 2));
    return 0;
  }

  if (sub === "claim") {
    const taskId = pos[0];
    if (!taskId) throw new Error("用法: ah inbox claim <task_id>");
    const r = await client.claimTask(taskId, {});
    io.log(JSON.stringify(r.task, null, 2));
    return 0;
  }

  if (sub === "complete" || sub === "done") {
    const taskId = pos[0];
    if (!taskId) throw new Error("用法: ah inbox done <task_id> [--summary ...] [--text ...] [--attach <file>]");
    const attachments = await uploadLocalAttachments(client, flags.attach, { taskId });
    const r = await client.complete(taskId, {
      summary: flags.summary || flags.text || "完成",
      text: flags.text || flags.summary || "完成",
      ...(attachments.length ? { attachments } : {}),
    });
    io.log(JSON.stringify(r.task, null, 2));
    return 0;
  }

  if (sub === "fail") {
    const taskId = pos[0];
    if (!taskId) throw new Error("用法: ah inbox fail <task_id> [--error ... | --text ...]");
    const r = await client.fail(taskId, {
      error: flags.error || flags.text || "failed",
      retryable: Boolean(flags.retryable),
    });
    io.log(JSON.stringify(r.task, null, 2));
    return 0;
  }

  if (sub === "ask") {
    const taskId = pos[0];
    if (!taskId) throw new Error("用法: ah inbox ask <task_id> --prompt <问题>");
    const r = await client.ask(taskId, { prompt: flags.prompt || flags.text || "" });
    io.log(JSON.stringify(r.task, null, 2));
    return 0;
  }

  if (sub === "auth") {
    const taskId = pos[0];
    if (!taskId) throw new Error("用法: ah inbox auth <task_id> --reason <原因>");
    const r = await client.requestAuth(taskId, {
      reason: flags.reason || flags.text || "需要机主审批",
      riskLevel: flags.risk || "high",
    });
    io.log(JSON.stringify(r.task, null, 2));
    return 0;
  }

  if (sub === "updates") {
    if (!targetAgent) throw new Error("请指定 --agent <leader_id>");
    const r = await client.getAgentUpdates(targetAgent, {
      since: flags.since,
      advance: Boolean(flags.new || flags.advance),
    });
    io.log(JSON.stringify(r, null, 2));
    return 0;
  }

  throw new Error(`未知 inbox 子命令: ${sub}`);
}

export async function runPresentCommand(args, { configDir, io = console } = {}) {
  const flags = parseSimpleFlags(args);
  const sub = flags._[0] || "list";
  const pos = flags._.slice(1);
  const { client } = makeClientForConfig(configDir, { hubUrl: flags.hub, token: flags.token });

  if (sub === "list") {
    const [a, q] = await Promise.all([
      client.listTasks({ state: "auth-required", summary: 1 }),
      client.listTasks({ state: "input-required", summary: 1 }),
    ]);
    const items = [...(a.tasks || []), ...(q.tasks || [])].sort((x, y) => x.created_at - y.created_at);
    if (!items.length) {
      io.log("暂无待我处理的审批或追问。");
      return 0;
    }
    for (const t of items) {
      io.log(`[${t.state}] ${t.id} -> ${t.to_agent_id} | ${t.title}`);
    }
    return 0;
  }

  if (sub === "approve" || sub === "deny") {
    const taskId = pos[0];
    if (!taskId) throw new Error(`用法: ah present ${sub} <task_id> [--note ...]`);
    const r = await client.decideApproval(taskId, {
      decision: sub === "approve" ? "approve" : "deny",
      note: flags.note || "",
      channel: "cli",
    });
    io.log(`已${sub === "approve" ? "签名批准" : "拒绝"}任务 ${taskId} -> 状态 ${r.task.state}`);
    return 0;
  }

  if (sub === "reply") {
    const taskId = pos[0];
    const body = flags.body || flags.text || pos.slice(1).join(" ");
    const attachments = await uploadLocalAttachments(client, flags.attach, { taskId });
    if (!taskId || (!body && !attachments.length)) {
      throw new Error("用法: ah present reply <task_id> <回复文本> [--attach <file>]");
    }
    const r = await client.replyTask(taskId, { body: body || "", attachments });
    io.log(`已回复任务 ${taskId} -> 状态 ${r.task.state}`);
    return 0;
  }

  throw new Error(`未知 present 子命令: ${sub}`);
}

export async function runScheduleCommand(args, { configDir, io = console, spawnFn = spawn } = {}) {
  // 切分 `--` 之后的被包裹命令（供 `ah schedule run <id> --every 6d -- ./my-job.sh` 零侵入包裹执行）
  const dashIdx = args.indexOf("--");
  const headArgs = dashIdx >= 0 ? args.slice(0, dashIdx) : args;
  const wrappedCmd = dashIdx >= 0 ? args.slice(dashIdx + 1) : [];

  const flags = parseSimpleFlags(headArgs);
  const sub = flags._[0] || "list";
  const pos = flags._.slice(1);
  const { client, agentId } = makeClientForConfig(configDir, { hubUrl: flags.hub, token: flags.token });
  const targetAgent = (typeof flags.agent === "string" ? flags.agent : "") || agentId;

  const postRun = (scheduleId, payload) => {
    if (targetAgent) {
      return client.reportScheduleRun(targetAgent, scheduleId, payload);
    }
    return client.post(`/api/v1/schedules/${encodeURIComponent(scheduleId)}/runs`, payload);
  };

  if (sub === "list") {
    const pathUrl = targetAgent
      ? `/api/v1/agents/${encodeURIComponent(targetAgent)}/schedules`
      : "/api/v1/schedules";
    const r = await client.get(pathUrl);
    if (flags.json) {
      io.log(JSON.stringify(r.schedules || [], null, 2));
      return 0;
    }
    for (const s of r.schedules || []) {
      const expr = s.cron_expr ? `${s.cron_expr} (${s.timezone || DEFAULT_TIMEZONE})` : `every ${s.interval_min}m`;
      io.log(
        `${s.agent_id}/${s.id}  [${(s.driver || "edge").padEnd(4)} | ${(s.health || "idle").padEnd(8)}]  ${expr}  | ${s.name}`
      );
    }
    return 0;
  }

  // 零 Token 包裹执行任意本地命令：直接传参数数组不经 shell（防引号丢失与注入），收到信号终止一律判失败。
  if (sub === "run") {
    const scheduleId = pos[0];
    const cmdParts = wrappedCmd.length ? wrappedCmd : pos.slice(1);
    if (!scheduleId || !cmdParts.length) {
      throw new Error("用法: ah schedule run <schedule_id> [--every 6d] [--name 名称] -- <原命令与参数...>");
    }
    const outStream = io === console ? process.stdout : io?.stdout;
    const errStream = io === console ? process.stderr : io?.stderr;
    const startedAt = Date.now();
    const execRes = await new Promise((resolve) => {
      let outTail = "";
      let errTail = "";
      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        resolve(val);
      };
      const child = spawnFn(cmdParts[0], cmdParts.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdout?.on("data", (chunk) => {
        outStream?.write?.(chunk);
        outTail = (outTail + chunk.toString("utf8")).slice(-1200);
      });
      child.stderr?.on("data", (chunk) => {
        errStream?.write?.(chunk);
        errTail = (errTail + chunk.toString("utf8")).slice(-1200);
      });
      child.on("error", (err) => finish({ code: 1, signal: null, outTail, errTail: err.message }));
      child.on("close", (code, signal) => {
        if (signal) {
          const sigNum = os.constants?.signals?.[signal] || 0;
          finish({ code: sigNum ? 128 + sigNum : 1, signal, outTail, errTail });
          return;
        }
        finish({ code: typeof code === "number" ? code : 1, signal: null, outTail, errTail });
      });
    });

    const durationMs = Math.max(0, Date.now() - startedAt);
    const lastLine = (txt) =>
      String(txt || "")
        .trim()
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .pop() || "";

    const ok = execRes.code === 0 && !execRes.signal;
    try {
      await postRun(scheduleId, {
        outcome: ok ? "completed" : "failed",
        ...(flags.name ? { name: String(flags.name) } : {}),
        ...(flags.every ? { every: String(flags.every) } : {}),
        ...(flags.cron ? { cron_expr: String(flags.cron) } : {}),
        ...(flags.timezone ? { timezone: String(flags.timezone) } : {}),
        ...(flags.window ? { window_key: String(flags.window) } : {}),
        duration_ms: durationMs,
        ...(ok
          ? { summary: flags.summary || lastLine(execRes.outTail) || "执行成功" }
          : {
              error:
                flags.error ||
                lastLine(execRes.errTail) ||
                (execRes.signal ? `进程被信号终止 (${execRes.signal})` : lastLine(execRes.outTail) || `命令退出码 ${execRes.code}`),
            }),
      });
    } catch (err) {
      io.error?.(`[ah schedule] 上报状态失败: ${err?.message || err}`);
    }
    return execRes.code;
  }

  if (sub === "ok" || sub === "fail" || sub === "noop") {
    const scheduleId = pos[0];
    const positionalMsg = pos.slice(1).join(" ").trim();
    if (!scheduleId) {
      throw new Error(`用法: ah schedule ${sub} <schedule_id> [简短说明] [--every 6d] [--name 名称]`);
    }
    const outcome = sub === "fail" ? "failed" : sub === "noop" ? "noop" : "completed";
    const attachments = outcome === "completed" ? await uploadLocalAttachments(client, flags.attach) : [];
    const msg = flags.summary || flags.text || positionalMsg;
    const payload = {
      outcome,
      ...(flags.name ? { name: String(flags.name) } : {}),
      ...(flags.every ? { every: String(flags.every) } : {}),
      ...(flags.cron ? { cron_expr: String(flags.cron) } : {}),
      ...(flags.timezone ? { timezone: String(flags.timezone) } : {}),
      ...(flags.window ? { window_key: String(flags.window) } : {}),
      ...(flags.title ? { title: String(flags.title) } : {}),
      ...(outcome === "completed"
        ? {
            summary: msg || "完成",
            ...(flags.text ? { text: String(flags.text) } : {}),
          }
        : {}),
      ...(outcome === "failed" ? { error: String(flags.error || msg || "执行失败") } : {}),
      ...(outcome === "noop" && msg ? { summary: msg } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
    const r = await postRun(scheduleId, payload);
    io.log(JSON.stringify(r, null, 2));
    return 0;
  }

  throw new Error(`未知 schedule 子命令: ${sub}（支持 list | run | ok | fail | noop）`);
}

const BOOLEAN_FLAGS = new Set([
  "yes",
  "help",
  "version",
  "service",
  "system",
  "user",
  "ensure",
  "remove",
  "uninstall",
  "force",
  "skip-skill",
  "auto-token",
  "no-token",
  "init-only",
  "setup-only",
  "no-daemon",
  "no-device",
  "pop",
  "json",
  "check",
  "new",
  "advance",
  "retryable",
  "foreground",
]);

const REPEATABLE_FLAGS = new Set(["attach"]);

export function parseSimpleFlags(argv) {
  const out = { _: [] };
  const assignFlag = (key, val) => {
    if (REPEATABLE_FLAGS.has(key)) {
      if (!Array.isArray(out[key])) out[key] = out[key] ? [out[key]] : [];
      out[key].push(val);
    } else {
      out[key] = val;
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") {
      out.help = true;
    } else if (a === "-v") {
      out.version = true;
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) {
        assignFlag(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("-")) {
          assignFlag(key, next);
          i++;
        } else {
          assignFlag(key, true);
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}
