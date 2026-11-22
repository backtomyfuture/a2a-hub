// 零外部依赖原生 MCP (Model Context Protocol) 服务端与 Stdio 桥接器（JSON-RPC 2.0）。
// 同时支撑：
// 1. 网关 Streamable HTTP 入口：`POST /api/v1/mcp`（由 Bearer Token 自动绑定 Agent 身份与角色，对大模型上下文零暴露凭据）
// 2. 本机 Stdio 子命令入口：`ah mcp`（从环境变量 AH_URL/AH_TOKEN 或本地 configDir 读取凭据转发至 Hub）

import readline from "node:readline";
import { DAEMON_VERSION, loadConfigJson, loadOwnerToken, readLiveHubUrl } from "./config.mjs";
import { TERMINAL_STATES } from "./task-service.mjs";
import { GatewayClient } from "../client/gateway-client.mjs";
import { parseSimpleFlags } from "../client/inbox.mjs";
import { actorCanControlTaskAsSender, actorCanOperateTaskAsWorker } from "../server/auth.mjs";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MAX_MCP_WAIT_SEC = 25;

const TOOL_REGISTER = {
  name: "a2a_register",
  description:
    "向 a2a-hub 编排中台签到上线并刷新当前 Agent 的名片信息（显示名称、一句话能力定位 summary、技能标签 skills、默认模型）。",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Agent ID（使用专属 Agent Token 连接时已自动绑定，无需传入；仅机主 Token 代操作时需指定）",
      },
      name: { type: "string", description: "显示名称（可选）" },
      summary: { type: "string", description: "一句话能力定位与擅长任务说明（可选）" },
      skills: {
        type: "array",
        items: { type: "string" },
        description: "技能标签列表，如 ['coding', 'search']（可选）",
      },
      default_model: { type: "string", description: "默认模型名称（可选）" },
    },
    additionalProperties: false,
  },
};

const LEADER_TOOLS = [
  {
    name: "a2a_list_agents",
    description:
      "查看 a2a-hub 全网可用 Agent 节点（含本机 CLI Worker 与云端/独立 Agent）的 ID、能力定位 summary、技能、在线状态与当前负载。派单前请先调用此工具。",
    inputSchema: {
      type: "object",
      properties: {
        only_enabled: {
          type: "boolean",
          description: "是否仅返回已启用 (enabled=true) 的 Agent，默认 true",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "a2a_dispatch_task",
    description:
      "向单个或多个目标 Agent 派发协作任务（支持并发扇出 to: ['agent1', 'agent2']，自动共享同一 context_id 多轮对话上下文）。支持 wait_sec 原地等待快速任务结果。",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" }, minItems: 1 },
          ],
          description: "目标 Agent ID 或 ID 数组（如 ['mac-mini--claude', 'grok-bot']）",
        },
        title: { type: "string", description: "简明任务标题" },
        input_text: { type: "string", description: "完整的任务指令、背景上下文与期望交付格式" },
        context_id: {
          type: "string",
          description: "沿用已有对话线程 context_id 以共享跨轮次历史上下文；留空自动新建线程",
        },
        priority: { type: "number", description: "优先级 1-10，默认 5" },
        model: { type: "string", description: "可选指定目标节点使用的模型" },
        wait_sec: {
          type: "number",
          description: "派单后原地挂起等待子任务回执的秒数（0-25 秒，默认 0 立即返回；设 15-25 可在快速任务完成时一次调用直接拿到结果）",
        },
      },
      required: ["to", "title", "input_text"],
      additionalProperties: false,
    },
  },
  {
    name: "a2a_check_updates",
    description:
      "增量拉取当前 Leader 已派发任务的最新进度、完成回执（completed）、失败原因（failed）或阻塞追问（input-required），并自动推进服务端消费水位。",
    inputSchema: {
      type: "object",
      properties: {
        wait_sec: {
          type: "number",
          description: "若当前无新回执，原地长轮询等待的秒数（0-25 秒，默认 0）",
        },
        advance: {
          type: "boolean",
          description: "是否自动推进服务端消费水位，默认 true",
        },
        context_id: {
          type: "string",
          description: "可选：附带读取指定 context_id 线程的完整任务列表",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "a2a_reply_task",
    description:
      "当派发的子任务处于 input-required（追问待复）时补充回答使其恢复执行，或取消（cancel）未终结的子任务。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "目标任务 ID" },
        action: {
          type: "string",
          enum: ["reply", "cancel"],
          description: "动作类型：reply（回答追问并恢复任务，默认）或 cancel（取消任务）",
        },
        body: { type: "string", description: "补充回复内容或取消原因" },
      },
      required: ["task_id", "body"],
      additionalProperties: false,
    },
  },
];

const WORKER_TOOLS = [
  {
    name: "a2a_poll_inbox",
    description:
      "检查当前 Worker Agent 的待办收件箱（同时自动刷新在线心跳）。支持 wait_sec 长轮询挂起等待新任务，空闲等待不消耗 Token，有新任务时立即唤醒返回。",
    inputSchema: {
      type: "object",
      properties: {
        wait_sec: {
          type: "number",
          description: "若当前无待办任务，原地挂起等待新任务的秒数（0-25 秒，默认 0；交互式循环接单建议设 20-25）",
        },
        auto_claim: {
          type: "boolean",
          description: "发现 submitted 待办时是否自动认领第一条并直接返回完整上下文（默认 false）",
        },
        agent_id: {
          type: "string",
          description: "Agent ID（持专属 Agent Token 时已自动绑定，无需传入）",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "a2a_claim_task",
    description:
      "认领并锁定一条待办任务（状态由 submitted 转为 working），返回完整任务指令 input_text、追问消息列表 messages 与同线程历史前情 context_history。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "要认领的任务 ID；若留空则自动按优先级认领自己收件箱中的下一条 submitted 任务",
        },
        lease_sec: {
          type: "number",
          description: "执行租约秒数（30-3600，默认 300）",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "a2a_submit_receipt",
    description:
      "提交任务执行结果或状态变更：完成交付（completed）、追问补充信息（input-required）、申请机主高危签名审批（auth-required）、报错（failed）或心跳续租（heartbeat）。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "任务 ID" },
        status: {
          type: "string",
          enum: ["completed", "input-required", "auth-required", "failed", "heartbeat"],
          description: "目标状态动作",
        },
        summary: {
          type: "string",
          description: "简短结论摘要（status='completed' 时必填）",
        },
        text: {
          type: "string",
          description: "完整详细交付内容或 Markdown 报告（status='completed' 时推荐填写，原生 JSON 传输无需转义）",
        },
        prompt: {
          type: "string",
          description: "需要向机主或 Leader 追问的问题（status='input-required' 时必填）",
        },
        reason: {
          type: "string",
          description: "高危操作申请机主签名审批的原因说明（status='auth-required' 时必填）",
        },
        command_preview: {
          type: "string",
          description: "可选：拟执行的高危命令或动作预览（status='auth-required' 时可用）",
        },
        error: {
          type: "string",
          description: "失败原因说明（status='failed' 时必填）",
        },
        retryable: {
          type: "boolean",
          description: "status='failed' 时是否允许自动重试（默认 false）",
        },
      },
      required: ["task_id", "status"],
      additionalProperties: false,
    },
  },
];

export function getMcpToolsForRole(role = "all") {
  const r = String(role || "all").toLowerCase();
  if (r === "leader") {
    return [TOOL_REGISTER, ...LEADER_TOOLS];
  }
  if (r === "worker") {
    return [TOOL_REGISTER, ...WORKER_TOOLS];
  }
  return [TOOL_REGISTER, ...LEADER_TOOLS, ...WORKER_TOOLS];
}

export function resolveMcpActorContext(actor, store, { requestedAgentId = "", requestedRole = "" } = {}) {
  const reqId = String(requestedAgentId || "").trim();
  const reqRole = String(requestedRole || "").trim().toLowerCase();

  if (actor.kind === "agent") {
    if (reqId && reqId !== actor.id) {
      const err = new Error(`禁止冒充其他 Agent (${reqId})`);
      err.statusCode = 403;
      err.code = "impersonation_forbidden";
      throw err;
    }
    return {
      actorKind: "agent",
      agentId: actor.id,
      role: actor.role || "worker",
      agent: actor.agent,
      rawActor: actor,
    };
  }

  if (actor.kind === "owner") {
    if (reqId && reqId !== "owner") {
      const ag = store.getAgent(reqId);
      const effectiveRole = ["leader", "worker", "all"].includes(reqRole)
        ? reqRole
        : ag?.role || "all";
      return {
        actorKind: "owner",
        agentId: reqId,
        role: effectiveRole,
        agent: ag || null,
        rawActor: actor,
      };
    }
    return {
      actorKind: "owner",
      agentId: "owner",
      role: ["leader", "worker", "all"].includes(reqRole) ? reqRole : "all",
      agent: null,
      rawActor: actor,
    };
  }

  return {
    actorKind: actor.kind,
    agentId: reqId || actor.id,
    role: "worker",
    agent: null,
    rawActor: actor,
  };
}

function clampWaitSec(val) {
  const n = Number(val || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.max(Math.round(n), 1), MAX_MCP_WAIT_SEC);
}

function makeToolError(message, code = "bad_request", statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

async function executeMcpTool(toolName, rawArgs, ctx) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
  const { store, taskService, broker, formatAgentsPublicList, signal } = ctx;

  if (toolName === "a2a_register") {
    const requestedId = String(args.id || "").trim();
    if (ctx.actorKind === "agent" && requestedId && requestedId !== ctx.agentId) {
      throw makeToolError(`禁止冒充其他 Agent (${requestedId})`, "impersonation_forbidden", 403);
    }
    const targetId = ctx.actorKind === "agent" ? ctx.agentId : requestedId || (ctx.agentId !== "owner" ? ctx.agentId : "");
    if (!targetId) {
      throw makeToolError("请使用专属 Agent Token 连接，或在参数中提供 id", "missing_id", 400);
    }
    const existing = store.getAgent(targetId);
    if (!existing) {
      throw makeToolError(`Agent (${targetId}) 尚未在 Hub 创建，请先在控制台添加`, "not_found", 404);
    }
    const patch = {};
    if (args.name) patch.name = String(args.name).trim();
    if (args.summary !== undefined) patch.summary = String(args.summary).trim();
    if (Array.isArray(args.skills)) patch.skills = args.skills.map((s) => String(s).trim()).filter(Boolean);
    if (Array.isArray(args.tools)) patch.tools = args.tools.map((s) => String(s).trim()).filter(Boolean);
    if (args.default_model !== undefined) patch.default_model = String(args.default_model).trim();

    store.updateAgent(targetId, patch);
    store.touchAgentSeen(targetId, Date.now(), 0);
    const updated = store.getAgent(targetId);
    return {
      ok: true,
      agent_id: updated.id,
      name: updated.name,
      role: updated.role,
      summary: updated.summary,
      skills: updated.skills,
      online: true,
    };
  }

  if (toolName === "a2a_list_agents") {
    if (ctx.agentId && ctx.agentId !== "owner") {
      store.touchAgentSeen(ctx.agentId);
    }
    const allAgents = typeof formatAgentsPublicList === "function"
      ? formatAgentsPublicList(ctx.rawActor)
      : store.listAgents();
    const onlyEnabled = args.only_enabled !== undefined ? Boolean(args.only_enabled) : true;
    const agents = onlyEnabled ? allAgents.filter((a) => a.enabled) : allAgents;
    return {
      ok: true,
      count: agents.length,
      agents,
    };
  }

  if (toolName === "a2a_dispatch_task") {
    if (ctx.actorKind === "device" || (ctx.actorKind === "agent" && ctx.role !== "leader")) {
      throw makeToolError("仅 Leader Agent 或机主可发起派单", "leader_required", 403);
    }
    const fromNode = ctx.actorKind === "agent"
      ? ctx.agentId
      : ctx.agentId && ctx.agentId !== "owner"
        ? ctx.agentId
        : "owner";
    if (fromNode !== "owner") store.touchAgentSeen(fromNode);

    const dispatched = taskService.dispatchTasks({
      fromNode,
      to: args.to,
      title: args.title || "",
      inputText: args.input_text ?? args.prompt ?? "",
      contextId: args.context_id || "",
      priority: args.priority,
      model: args.model || "",
      params: args.params || {},
    });

    const waitSec = clampWaitSec(args.wait_sec);
    if (waitSec > 0 && broker) {
      const deadline = Date.now() + waitSec * 1000;
      const taskIds = dispatched.tasks.map((t) => t.id);
      while (Date.now() < deadline) {
        const latest = taskIds.map((id) => store.getTask(id)).filter(Boolean);
        const allSettledOrBlocked = latest.every(
          (t) => TERMINAL_STATES.has(t.state) || t.state === "input-required" || t.state === "auth-required"
        );
        if (allSettledOrBlocked) break;
        const remainSec = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
        const waitRes = await broker.waitForChange({
          scope: "agent",
          sinceSeq: broker.currentSeq(),
          timeoutSec: remainSec,
          agentId: fromNode,
          signal,
        });
        if (waitRes.aborted || waitRes.timeout) break;
      }
      const refreshedTasks = dispatched.tasks.map((t) => taskService.getTaskDetail(t.id, { includeContextHistory: false }));
      return {
        ok: true,
        context_id: dispatched.context_id,
        tasks: refreshedTasks,
      };
    }

    return {
      ok: true,
      ...dispatched,
    };
  }

  if (toolName === "a2a_check_updates") {
    if (ctx.actorKind === "agent" && ctx.role !== "leader") {
      throw makeToolError("仅 Leader 角色可使用 updates 水位增量拉取", "leader_required", 403);
    }
    const leaderId = ctx.actorKind === "agent"
      ? ctx.agentId
      : String(args.leader_id || (ctx.agentId !== "owner" ? ctx.agentId : "owner")).trim();
    if (leaderId !== "owner") store.touchAgentSeen(leaderId);

    const advance = args.advance !== undefined ? Boolean(args.advance) : true;
    let resUpd = taskService.getLeaderUpdates(leaderId, {
      sinceSeq: args.since_seq,
      advance,
    });

    const waitSec = clampWaitSec(args.wait_sec);
    if (resUpd.updates.length === 0 && waitSec > 0 && broker) {
      await broker.waitForChange({
        scope: "agent",
        sinceSeq: broker.currentSeq(),
        timeoutSec: waitSec,
        agentId: leaderId,
        signal,
      });
      if (leaderId !== "owner") store.touchAgentSeen(leaderId);
      resUpd = taskService.getLeaderUpdates(leaderId, {
        sinceSeq: args.since_seq,
        advance,
      });
    }

    const out = { ok: true, ...resUpd };
    if (args.context_id) {
      out.thread = taskService.getThread(String(args.context_id));
    }
    return out;
  }

  if (toolName === "a2a_reply_task") {
    const taskId = String(args.task_id || "").trim();
    const body = String(args.body || "").trim();
    const action = String(args.action || "reply").toLowerCase();
    if (!taskId) throw makeToolError("缺少 task_id", "missing_task_id", 400);
    if (!body && action === "reply") throw makeToolError("回复内容 body 不能为空", "missing_body", 400);

    const existing = store.getTask(taskId);
    if (!existing) throw makeToolError("任务不存在", "not_found", 404);
    if (!actorCanControlTaskAsSender(ctx.rawActor, existing)) {
      throw makeToolError("仅机主或任务发起方可回复或取消该任务", "forbidden", 403);
    }

    const fromNode = ctx.actorKind === "agent" ? ctx.agentId : existing.from_node || "owner";
    if (action === "cancel") {
      const task = taskService.cancel(taskId, { fromNode, reason: body || "canceled via mcp" });
      return { ok: true, task };
    }
    const task = taskService.reply(taskId, { fromNode, body });
    return { ok: true, task };
  }

  if (toolName === "a2a_poll_inbox") {
    const requestedId = String(args.agent_id || "").trim();
    if (ctx.actorKind === "agent" && requestedId && requestedId !== ctx.agentId) {
      throw makeToolError("无权检查其他 Agent 的收件箱", "forbidden", 403);
    }
    const targetId = ctx.actorKind === "agent"
      ? ctx.agentId
      : requestedId || (ctx.agentId !== "owner" ? ctx.agentId : "");
    if (!targetId) {
      throw makeToolError("请使用专属 Agent Token 连接，或在参数中指定 agent_id", "missing_agent_id", 400);
    }

    store.touchAgentSeen(targetId);
    let checked = taskService.checkAgentInbox(targetId);
    if (!checked) throw makeToolError(`Agent (${targetId}) 不存在`, "not_found", 404);

    const waitSec = clampWaitSec(args.wait_sec);
    if (checked.pending_count === 0 && !checked.paused && waitSec > 0 && broker) {
      await broker.waitForChange({
        scope: "agent",
        sinceSeq: broker.currentSeq(),
        timeoutSec: waitSec,
        agentId: targetId,
        signal,
      });
      store.touchAgentSeen(targetId);
      checked = taskService.checkAgentInbox(targetId);
    }

    if (args.auto_claim && checked.tasks?.length > 0) {
      try {
        const claimed = taskService.claimTaskById(checked.tasks[0].id, {
          claimant: targetId,
          allowedAgentIds: [targetId],
        });
        return {
          ...checked,
          claimed_task: claimed,
        };
      } catch {
        // 若并发被抢先认领则退回普通列表结果
      }
    }
    return checked;
  }

  if (toolName === "a2a_claim_task") {
    const taskId = String(args.task_id || "").trim();
    const targetId = ctx.actorKind === "agent"
      ? ctx.agentId
      : ctx.agentId !== "owner"
        ? ctx.agentId
        : "";
    if (targetId) store.touchAgentSeen(targetId);

    if (taskId) {
      const existing = store.getTask(taskId);
      if (!existing) throw makeToolError("任务不存在", "not_found", 404);
      if (!actorCanOperateTaskAsWorker(ctx.rawActor, existing, store)) {
        throw makeToolError("无权以执行方认领此任务", "forbidden", 403);
      }
      const allowed = ctx.actorKind === "owner" ? null : ctx.actorKind === "agent" ? [ctx.agentId] : null;
      const task = taskService.claimTaskById(taskId, {
        claimant: targetId || existing.to_agent_id,
        allowedAgentIds: allowed,
        leaseSec: args.lease_sec,
      });
      return { ok: true, task };
    }

    const candidateIds = targetId
      ? [targetId]
      : store.listAgents({ enabled: true }).map((a) => a.id);
    const task = taskService.claimNext({
      agentIds: candidateIds,
      claimant: targetId || "owner",
      leaseSec: args.lease_sec,
    });
    return { ok: true, task };
  }

  if (toolName === "a2a_submit_receipt") {
    const taskId = String(args.task_id || "").trim();
    const status = String(args.status || "").trim().toLowerCase();
    if (!taskId) throw makeToolError("缺少 task_id", "missing_task_id", 400);
    if (!status) throw makeToolError("缺少 status", "missing_status", 400);

    const existing = store.getTask(taskId);
    if (!existing) throw makeToolError("任务不存在", "not_found", 404);
    if (!actorCanOperateTaskAsWorker(ctx.rawActor, existing, store)) {
      throw makeToolError("无权以执行方操作此任务", "forbidden", 403);
    }
    const actorId = ctx.actorKind === "agent"
      ? ctx.agentId
      : ctx.agentId && ctx.agentId !== "owner"
        ? ctx.agentId
        : existing.to_agent_id;

    if (status === "completed" || status === "complete") {
      const summary = String(args.summary || args.text || "").trim();
      const text = String(args.text || args.summary || "").trim();
      if (!summary && !text) {
        throw makeToolError("status=completed 时请提供 summary 或 text", "missing_summary", 400);
      }
      const task = taskService.complete(taskId, {
        actorId,
        summary: summary || text.slice(0, 200),
        text: text || summary,
      });
      return { ok: true, task };
    }

    if (status === "input-required" || status === "ask") {
      const prompt = String(args.prompt || args.text || args.summary || "").trim();
      const task = taskService.ask(taskId, {
        actorId,
        prompt,
      });
      return { ok: true, task };
    }

    if (status === "auth-required" || status === "auth") {
      const reason = String(args.reason || args.prompt || args.summary || "").trim();
      const task = taskService.requestAuth(taskId, {
        actorId,
        reason,
        commandPreview: String(args.command_preview || ""),
        riskLevel: "high",
      });
      return { ok: true, task };
    }

    if (status === "failed" || status === "fail") {
      const errText = String(args.error || args.reason || args.summary || "execution_failed").trim();
      const task = taskService.fail(taskId, {
        actorId,
        error: errText,
        retryable: Boolean(args.retryable),
      });
      return { ok: true, task };
    }

    if (status === "heartbeat") {
      const task = taskService.heartbeat(taskId, {
        actorId,
        progress: args.progress || {},
        leaseSec: args.lease_sec,
      });
      return { ok: true, task };
    }

    throw makeToolError(`不支持的 status 动作: ${status}`, "invalid_status", 400);
  }

  const notFoundErr = new Error(`未知 MCP 工具: ${toolName}`);
  notFoundErr.rpcCode = -32602;
  throw notFoundErr;
}

async function handleSingleRpc(msg, ctx) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return {
      jsonrpc: "2.0",
      id: msg?.id ?? null,
      error: { code: -32600, message: "Invalid JSON-RPC 2.0 Request" },
    };
  }

  const method = String(msg.method || "");
  const hasId = msg.id !== undefined && msg.id !== null;

  // MCP 通知帧（如 notifications/initialized, notifications/cancelled）无需返回响应体
  if (!hasId && method.startsWith("notifications/")) {
    return null;
  }

  if (method === "initialize") {
    if (ctx.agentId && ctx.agentId !== "owner") {
      ctx.store.touchAgentSeen(ctx.agentId);
    }
    const clientProto = msg.params?.protocolVersion;
    const protocolVersion = typeof clientProto === "string" && clientProto.trim()
      ? clientProto.trim()
      : MCP_PROTOCOL_VERSION;
    const identityHint = ctx.agentId && ctx.agentId !== "owner"
      ? `当前会话已通过凭据安全绑定 Agent「${ctx.agentId}」（角色: ${ctx.role}），调用工具无需传入 Token 或 URL。`
      : `当前会话以机主权限连接（角色视图: ${ctx.role}）。`;
    return {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      result: {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: "a2a-hub",
          version: DAEMON_VERSION,
        },
        instructions: `a2a-hub 个人多 Agent 编排中台 MCP 服务。${identityHint}`,
      },
    };
  }

  if (method === "ping") {
    return {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      result: {},
    };
  }

  if (method === "tools/list") {
    if (ctx.agentId && ctx.agentId !== "owner") {
      ctx.store.touchAgentSeen(ctx.agentId);
    }
    return {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      result: {
        tools: getMcpToolsForRole(ctx.role),
      },
    };
  }

  if (method === "tools/call") {
    const toolName = String(msg.params?.name || "").trim();
    if (!toolName) {
      return {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: { code: -32602, message: "缺少工具名称 params.name" },
      };
    }
    try {
      const result = await executeMcpTool(toolName, msg.params?.arguments || {}, ctx);
      return {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result,
          isError: false,
        },
      };
    } catch (err) {
      if (err?.rpcCode) {
        return {
          jsonrpc: "2.0",
          id: msg.id ?? null,
          error: { code: err.rpcCode, message: err.message },
        };
      }
      const errPayload = {
        ok: false,
        error: err?.code || "tool_error",
        message: err?.message || String(err),
      };
      return {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(errPayload, null, 2),
            },
          ],
          structuredContent: errPayload,
          isError: true,
        },
      };
    }
  }

  if (!hasId) return null;
  return {
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: -32601, message: `未知 MCP 方法: ${method}` },
  };
}

export async function handleMcpRpcMessage(payload, ctx) {
  if (Array.isArray(payload)) {
    if (!payload.length) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Empty batch" },
      };
    }
    const results = (await Promise.all(payload.map((item) => handleSingleRpc(item, ctx)))).filter(Boolean);
    return results.length ? results : null;
  }
  return await handleSingleRpc(payload, ctx);
}

// 本机 Stdio MCP 入口（`ah mcp`）：通过标准输入输出接收 JSON-RPC 2.0，携带本地或环境变量凭据转发给 Hub `/api/v1/mcp`。
export async function runMcpStdioCommand(
  args = [],
  { configDir, stdin = process.stdin, stdout = process.stdout } = {}
) {
  const flags = parseSimpleFlags(args);
  const cfg = loadConfigJson(configDir);

  const hubUrl = String(
    flags.hub ||
      process.env.AH_URL ||
      process.env.AH_HUB_URL ||
      readLiveHubUrl(configDir) ||
      cfg.hubUrl ||
      "http://127.0.0.1:8787"
  ).replace(/\/+$/, "");

  const token = String(
    flags.token ||
      process.env.AH_TOKEN ||
      process.env.AH_API_TOKEN ||
      loadOwnerToken(configDir) ||
      cfg.agentToken ||
      cfg.deviceToken ||
      ""
  ).trim();

  const agentId = String(flags.agent || process.env.AH_AGENT || process.env.AH_AGENT_ID || cfg.agentId || "").trim();
  const role = String(flags.role || process.env.AH_ROLE || "").trim();

  const client = new GatewayClient(hubUrl, {
    token,
    defaultTimeoutMs: 45_000,
  });

  const extraHeaders = {};
  if (agentId) extraHeaders["X-A2A-Node"] = agentId;
  if (role) extraHeaders["X-A2A-Role"] = role;

  const rl = readline.createInterface({
    input: stdin,
    terminal: false,
  });

  const writeLine = (obj) => {
    if (!obj) return;
    stdout.write(JSON.stringify(obj) + "\n");
  };

  for await (const rawLine of rl) {
    const line = String(rawLine || "").trim();
    if (!line) continue;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      writeLine({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      continue;
    }

    const isNotification =
      !Array.isArray(parsed) &&
      (parsed.id === undefined || parsed.id === null) &&
      String(parsed.method || "").startsWith("notifications/");

    try {
      const resp = await client.post("/api/v1/mcp", parsed, {
        headers: extraHeaders,
        timeoutMs: 45_000,
      });
      if (!isNotification && resp && typeof resp === "object" && (resp.jsonrpc === "2.0" || Array.isArray(resp))) {
        writeLine(resp);
      }
    } catch (err) {
      if (isNotification) continue;
      writeLine({
        jsonrpc: "2.0",
        id: parsed?.id ?? null,
        error: {
          code: err?.status === 401 || err?.status === 403 ? -32001 : -32603,
          message: err?.message || "Hub MCP 请求失败",
        },
      });
    }
  }

  return 0;
}
