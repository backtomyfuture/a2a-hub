// 本地 Agent 收件箱与人类接入辅助（`ah inbox` 与 `ah present`）。
// 仅走 Hub REST API，不直接碰 SQLite。

import { GatewayClient } from "./gateway-client.mjs";
import { loadConfigJson, loadOwnerToken, readLiveHubUrl } from "../core/config.mjs";

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
      ...(flags.lease ? { leaseSec: Number(flags.lease) } : {}),
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
    if (!taskId) throw new Error("用法: ah inbox done <task_id> [--summary ...] [--text ...]");
    const r = await client.complete(taskId, {
      summary: flags.summary || flags.text || "完成",
      text: flags.text || flags.summary || "完成",
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
      client.listTasks({ state: "auth-required" }),
      client.listTasks({ state: "input-required" }),
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
    });
    io.log(`已${sub === "approve" ? "签名批准" : "拒绝"}任务 ${taskId} -> 状态 ${r.task.state}`);
    return 0;
  }

  if (sub === "reply") {
    const taskId = pos[0];
    const body = flags.body || flags.text || pos.slice(1).join(" ");
    if (!taskId || !body) throw new Error("用法: ah present reply <task_id> <回复文本>");
    const r = await client.replyTask(taskId, { body });
    io.log(`已回复任务 ${taskId} -> 状态 ${r.task.state}`);
    return 0;
  }

  throw new Error(`未知 present 子命令: ${sub}`);
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
  "pop",
  "json",
  "check",
  "new",
  "advance",
  "retryable",
  "foreground",
]);

export function parseSimpleFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") {
      out.help = true;
    } else if (a === "-v") {
      out.version = true;
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("-")) {
          out[key] = next;
          i++;
        } else {
          out[key] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}
