// Hub HTTP 服务端：承载 REST 总线接口、HTTP 长轮询唤醒端点、Web 控制台、审批签名与 LoopForge SOP API。

import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { f1 } from "../bus/tables.mjs";
import { resolveTableName } from "../bus/tables.mjs";
import { capIdOf, resolveListenAddr } from "../config.mjs";
import { agentCanSeeTask, assertAgentRoute, bindAgentBody } from "../hub/agent-access.mjs";
import { AgentTokenStore } from "../hub/agent-tokens.mjs";
import {
  buildOnboarding,
  admissionOf,
  formatAgentCard,
  httpError,
  receiveModeFor,
  validateAccess,
  validateAdmission,
  validateNodeName,
  validateProfileFields,
  validateReceive,
  validateRole,
} from "../hub/admission.mjs";
import { validateWebhookUrl, WebhookDispatcher } from "../hub/webhooks.mjs";
import {
  alignNodeReceiveMode,
  buildCommandsSnippet,
  createManualCard,
  deleteManualCard,
  listSchedules,
  nodeStoredReceiveMode,
  switchNodeReceive,
} from "../hub/capabilities.mjs";
import { cancelTask } from "../hub/cancel.mjs";
import { createTask } from "../hub/create.mjs";
import { initiatorOf } from "../inbox.mjs";
import { TERMINAL_STATUSES } from "../kernel-util.mjs";
import { BUILTIN_LOOP_TEMPLATES, cancelLoop, createLoop } from "../hub/loop.mjs";
import { getTaskWhy } from "../why.mjs";
import { handleAgentGatewayRequest } from "./agent-gateway.mjs";
import { rosterNodeVisible } from "./longpoll-broker.mjs";
import { renderWebConsoleHtml } from "./web-ui.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-A2A-Node, X-Api-Token",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function safeTokenEqual(provided, expected) {
  const a = Buffer.from(String(provided ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  if (!a.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractToken(req, url) {
  const auth = String(req.headers.authorization ?? "").trim();
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const hdr = String(req.headers["x-api-token"] ?? "").trim();
  if (hdr) return hdr;
  return String(url.searchParams.get("token") ?? "").trim();
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error("请求体超过 2MB 上限");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("请求体不是合法 JSON");
    err.status = 400;
    throw err;
  }
}

function parseJsonField(raw, fallback) {
  if (raw && typeof raw === "object") return raw;
  const s = String(raw ?? "").trim();
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

function nowMinute() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function decodeParam(raw) {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    throw httpError(400, "路径参数编码不合法");
  }
}

function formatTaskSummary(t) {
  return {
    record_id: t.record_id,
    task_id: f1(t, "Task_ID"),
    title: f1(t, "Title"),
    status: f1(t, "Status"),
    target_node: f1(t, "Target_Node"),
    worker_hint: f1(t, "Worker_Hint"),
    skill_id: f1(t, "Skill_ID"),
    source: f1(t, "Source"),
    approval_class: f1(t, "Approval_Class"),
    hop_count: Number(f1(t, "Hop_Count")) || 0,
    claimed_by: f1(t, "Claimed_By"),
    heartbeat_at: f1(t, "Heartbeat_At"),
    retry_count: Number(f1(t, "Retry_Count")) || 0,
    context_id: f1(t, "Context_ID"),
    status_msg: f1(t, "Status_Msg"),
    latest_run: f1(t, "Latest_Run"),
    metadata: parseJsonField(f1(t, "Metadata"), {}),
  };
}

function formatLoopSummary(r) {
  return {
    record_id: r.record_id,
    loop_id: f1(r, "Loop_ID"),
    title: f1(r, "Title"),
    goal: f1(r, "Goal"),
    context_id: f1(r, "Context_ID"),
    status: f1(r, "Status"),
    template: f1(r, "Template"),
    stages: parseJsonField(f1(r, "Stages"), []),
    stage_index: Number(f1(r, "Stage_Index")) || 0,
    iteration: Number(f1(r, "Iteration")) || 1,
    max_iterations: Number(f1(r, "Max_Iterations")) || 5,
    active_task_id: f1(r, "Active_Task_ID"),
    last_result: f1(r, "Last_Result"),
    last_error: f1(r, "Last_Error"),
    history: parseJsonField(f1(r, "History"), []),
    error: f1(r, "Error"),
    created_by: f1(r, "Created_By"),
    created_at: f1(r, "Created_At"),
    updated_at: f1(r, "Updated_At"),
  };
}

export async function startHubHttpServer({
  cfg,
  bus,
  broker,
  approval,
  log = () => {},
  onWake = () => {},
  webhookDispatcher = null,
} = {}) {
  const { host, port } = resolveListenAddr(cfg?.listen ?? "0.0.0.0:8787");
  const apiToken = String(cfg?.apiToken ?? "").trim();
  const tokenStore = cfg?.configDir ? new AgentTokenStore(cfg.configDir) : null;
  const webhooks = webhookDispatcher
    ?? (cfg?.configDir
      ? new WebhookDispatcher({
        configDir: cfg.configDir,
        hubNode: cfg?.node || "hub",
        taskTable: bus?.tables?.tasks || "tasks",
        log,
      })
      : null);
  const runtimePath = cfg?.configDir ? path.join(cfg.configDir, "hub_runtime.json") : "";
  const connectHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  let activePort = port;
  const publicUrl = String(cfg?.publicUrl ?? "").trim().replace(/\/+$/, "");
  // 接入提示词要发给其他机器：优先用配置的对外地址，避免机主在 Hub 本机用 127.0.0.1 打开控制台时生成远端不可达的地址。
  const requestHubUrl = (req) => {
    if (publicUrl) return publicUrl;
    const hostHdr = String(req.headers.host ?? "").trim();
    return hostHdr ? `http://${hostHdr}` : `http://${connectHost}:${activePort}`;
  };

  // 无机主 Token 且尚未签发任何 Agent Token 时保持免鉴权；一旦有任一种钥匙就关闭。
  const resolvePrincipal = (presented) => {
    const ownerOn = Boolean(apiToken);
    const agentsOn = Boolean(tokenStore?.hasAny());
    if (!ownerOn && !agentsOn) return { kind: "open" };
    if (ownerOn && safeTokenEqual(presented, apiToken)) return { kind: "owner" };
    const agent = tokenStore?.authenticate(presented);
    if (agent) return { kind: "agent", ...agent };
    return null;
  };

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = reqUrl.pathname;
    const method = (req.method || "GET").toUpperCase();
    let principal = { kind: "open" };
    // 身份绑定要在读完 body 后做：省略的 node/from 补成绑定节点，冒充则 403。
    const readJsonBodyBound = async () => {
      const body = await readJsonBody(req);
      if (principal.kind === "agent") bindAgentBody(principal, body);
      return body;
    };

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-A2A-Node, X-Api-Token",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      });
      res.end();
      return;
    }

    try {
      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        sendHtml(res, 200, renderWebConsoleHtml());
        return;
      }

      if (method === "GET" && pathname === "/api/v1/health") {
        sendJson(res, 200, {
          ok: true,
          node: cfg?.node || "hub",
          role: cfg?.role || "hub",
          busType: cfg?.busType || "sqlite",
          seq: broker?.latestSeq ?? 0,
          authRequired: Boolean(apiToken) || Boolean(tokenStore?.hasAny()),
          hubPublicKey: cfg?.hubPublicKey || "",
        });
        return;
      }

      // A2A 协议探索名片免鉴权，便于外部 Agent 先发现接入端点
      if (await handleAgentGatewayRequest({
        req, res, reqUrl, pathname, method, bus, broker, approval, cfg, onWake, readJsonBody, sendJson, discoverOnly: true,
      })) {
        return;
      }

      if (pathname.startsWith("/api/")) {
        const next = resolvePrincipal(extractToken(req, reqUrl));
        if (!next) {
          sendJson(res, 401, { error: "Unauthorized: invalid or missing API token" });
          return;
        }
        principal = next;
        if (principal.kind === "agent") {
          assertAgentRoute(principal, {
            method,
            pathname,
            searchParams: reqUrl.searchParams,
            headers: req.headers,
          });
        }
      }

      // 外部 HTTP Agent（Muse / Grok Bot 等）统一网关，优先于通用 /api/v1/tasks/:id 详情路由匹配
      if (await handleAgentGatewayRequest({
        req, res, reqUrl, pathname, method, bus, broker, approval, cfg, onWake,
        readJsonBody: readJsonBodyBound,
        sendJson,
        principal,
        webhookStore: webhooks?.store ?? null,
      })) {
        return;
      }

      // 1) HTTP 长轮询唤醒端点
      if (method === "GET" && pathname === "/api/v1/poll") {
        const node = String(reqUrl.searchParams.get("node") ?? req.headers["x-a2a-node"] ?? "*").trim() || "*";
        const cursor = Number(reqUrl.searchParams.get("cursor") ?? 0) || 0;
        const timeoutSec = Number(reqUrl.searchParams.get("timeout") ?? 25);
        const timeoutMs = Number.isFinite(timeoutSec) ? Math.max(0, Math.min(60, timeoutSec)) * 1000 : 25_000;
        const ac = new AbortController();
        const onClose = () => ac.abort();
        req.on("close", onClose);
        try {
          const remoteAddr = req.socket?.remoteAddress || "";
          const result = await broker.wait({ node, cursor, timeoutMs, signal: ac.signal, remoteAddr });
          if (!res.writableEnded) sendJson(res, 200, result);
        } finally {
          req.off("close", onClose);
        }
        return;
      }

      // 2) 通用总线表读写（供远程 HttpBus 节点调用）
      const tableMatch = pathname.match(/^\/api\/v1\/tables\/([^/]+)\/records(?:\/([^/]+))?$/);
      if (tableMatch) {
        const rawTable = decodeURIComponent(tableMatch[1]);
        const recordId = tableMatch[2] ? decodeURIComponent(tableMatch[2]) : "";
        const table = resolveTableName(bus.tables, rawTable);
        if (!table) {
          sendJson(res, 404, { error: `未知表：${rawTable}` });
          return;
        }

        if (method === "GET" && !recordId) {
          const items = await bus.listRecords(table);
          sendJson(res, 200, { data: { items } });
          return;
        }
        if (method === "GET" && recordId) {
          const record = await bus.getRecord(table, recordId);
          if (!record) {
            sendJson(res, 404, { error: `record not found: ${table}/${recordId}` });
            return;
          }
          sendJson(res, 200, { data: { record } });
          return;
        }
        if (method === "POST" && !recordId) {
          const body = await readJsonBodyBound();
          const clientToken = reqUrl.searchParams.get("client_token") || body.client_token || undefined;
          const result = await bus.createRecord(table, body.fields ?? {}, clientToken);
          onWake();
          sendJson(res, 200, { data: result });
          return;
        }
        if (method === "PUT" && recordId) {
          const body = await readJsonBodyBound();
          try {
            const result = await bus.updateRecord(table, recordId, body.fields ?? {});
            onWake();
            sendJson(res, 200, { data: result });
          } catch (e) {
            if (String(e?.message ?? "").includes("not found")) {
              sendJson(res, 404, { error: e.message });
            } else {
              throw e;
            }
          }
          return;
        }
      }

      // 3) IM 卡片接口（HttpBus 兼容）
      if (method === "POST" && pathname === "/api/v1/im/messages") {
        const body = await readJsonBodyBound();
        const result = await bus.sendMessage(
          body.receive_id,
          body.msg_type || "interactive",
          body.content,
          body.receive_id_type || "owner",
        );
        sendJson(res, 200, { data: result });
        return;
      }
      const patchCardMatch = pathname.match(/^\/api\/v1\/im\/messages\/([^/]+)$/);
      if (method === "PATCH" && patchCardMatch) {
        const msgId = decodeURIComponent(patchCardMatch[1]);
        const body = await readJsonBodyBound();
        const result = await bus.patchInteractiveCard(msgId, body.content);
        sendJson(res, 200, { data: result });
        return;
      }

      // 4) Web 控制台总览数据
      if (method === "GET" && pathname === "/api/v1/state") {
        const [tasks, cards, loops] = await Promise.all([
          bus.listRecords(bus.tables.tasks),
          bus.listRecords(bus.tables.agentCards),
          bus.tables.loops ? bus.listRecords(bus.tables.loops) : Promise.resolve([]),
        ]);
        const cardNodes = new Set();
        for (const c of cards) {
          const node = f1(c, "Node");
          if (node) cardNodes.add(node);
        }
        // 无名片且 30 分钟内没活动的在线记录不进总览。有名片的离线节点仍留在 agentCards 里。
        const connectedNodes = (broker ? broker.connectedNodes() : [])
          .filter((n) => rosterNodeVisible(n, cardNodes.has(n.node)));
        sendJson(res, 200, {
          hubNode: cfg?.node || "hub",
          hubPublicKey: cfg?.hubPublicKey || "",
          seq: broker?.latestSeq ?? 0,
          connectedNodes,
          tasks: tasks.map(formatTaskSummary).reverse(),
          agentCards: cards.map(formatAgentCard),
          loops: loops.map(formatLoopSummary).reverse(),
          cards: typeof bus.listCards === "function" ? bus.listCards() : [],
        });
        return;
      }

      // 5) 单任务详情（含对话流、Runs、Artifacts、Why）
      const taskDetailMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
      if (method === "GET" && taskDetailMatch) {
        const taskId = decodeURIComponent(taskDetailMatch[1]);
        const [tasks, messages, parts, runs, artifacts] = await Promise.all([
          bus.listRecords(bus.tables.tasks),
          bus.listRecords(bus.tables.messages),
          bus.listRecords(bus.tables.parts),
          bus.tables.runs ? bus.listRecords(bus.tables.runs) : Promise.resolve([]),
          bus.tables.artifacts ? bus.listRecords(bus.tables.artifacts) : Promise.resolve([]),
        ]);
        const task = tasks.find((t) => f1(t, "Task_ID") === taskId);
        if (!task) {
          sendJson(res, 404, { error: `任务不存在：${taskId}` });
          return;
        }
        const rawTaskMsgs = messages.filter((m) => f1(m, "Task_ID") === taskId);
        if (!agentCanSeeTask(principal, initiatorOf(task, rawTaskMsgs), f1(task, "Source"), f1(task, "Target_Node"))) {
          sendJson(res, 403, { error: "只能查看本节点发起或指向本节点的任务" });
          return;
        }
        const taskMsgs = messages
          .filter((m) => f1(m, "Task_ID") === taskId)
          .map((m) => {
            const msgId = f1(m, "Msg_ID");
            const msgParts = parts
              .filter((p) => f1(p, "Parent_Type") === "message" && f1(p, "Parent_ID") === msgId)
              .sort((a, b) => (Number(f1(a, "Seq")) || 0) - (Number(f1(b, "Seq")) || 0))
              .map((p) => ({
                part_id: f1(p, "Part_ID"),
                seq: Number(f1(p, "Seq")) || 0,
                kind: f1(p, "Kind"),
                text: f1(p, "Text"),
                file_uri: f1(p, "File_URI"),
                file_name: f1(p, "File_Name"),
                mime_type: f1(p, "Mime_Type"),
                data: f1(p, "Data"),
              }));
            return {
              msg_id: msgId,
              kind: f1(m, "Kind"),
              role: f1(m, "Role"),
              from_node: f1(m, "From_Node"),
              to_node: f1(m, "To_Node"),
              in_reply_to: f1(m, "In_Reply_To"),
              created_at: f1(m, "Created_At"),
              parts: msgParts,
            };
          });
        const taskRuns = runs
          .filter((r) => f1(r, "Task_Ref") === taskId)
          .map((r) => ({
            run_id: f1(r, "Run_ID"),
            node: f1(r, "Node"),
            worker: f1(r, "Worker"),
            outcome: f1(r, "Outcome"),
            error_log: f1(r, "Error_Log"),
            started_at: f1(r, "Started_At"),
            finished_at: f1(r, "Finished_At"),
          }));
        const taskArts = artifacts
          .filter((a) => f1(a, "Task_ID") === taskId)
          .map((a) => {
            const artId = f1(a, "Artifact_ID");
            const files = parts
              .filter((p) => f1(p, "Parent_Type") === "artifact" && f1(p, "Parent_ID") === artId)
              .map((p) => ({
                file_uri: f1(p, "File_URI"),
                file_name: f1(p, "File_Name"),
                mime_type: f1(p, "Mime_Type"),
              }));
            return {
              artifact_id: artId,
              name: f1(a, "Name"),
              description: f1(a, "Description"),
              is_final: f1(a, "Is_Final"),
              created_by: f1(a, "Created_By"),
              created_at: f1(a, "Created_At"),
              files,
            };
          });
        let why = null;
        try {
          why = await getTaskWhy({ bus, configDir: cfg?.configDir, taskId });
        } catch { /* ignore */ }
        sendJson(res, 200, {
          task: formatTaskSummary(task),
          messages: taskMsgs,
          runs: taskRuns,
          artifacts: taskArts,
          why,
        });
        return;
      }

      // 6) 创建任务
      if (method === "POST" && pathname === "/api/v1/tasks") {
        const body = await readJsonBodyBound();
        const taskId = await createTask({
          bus,
          from: body.from || cfg?.node || "hub",
          source: body.source || body.from || "web",
          to: body.to || "",
          worker: body.worker || "",
          cap: body.cap || "",
          text: body.text || "",
          params: body.params,
          criteria: body.criteria,
          context: body.context || "",
          ref: body.ref || "",
          approval: body.approval || "",
          idempotencyKey: body.idempotencyKey || "",
          validateTarget: body.validateTarget !== false,
        });
        onWake();
        sendJson(res, 201, { task_id: taskId });
        return;
      }

      // 7) 网页端答复 input-required
      const replyMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/reply$/);
      if (method === "POST" && replyMatch) {
        const taskId = decodeURIComponent(replyMatch[1]);
        const body = await readJsonBodyBound();
        const text = String(body.text ?? "").trim();
        if (!text) {
          sendJson(res, 400, { error: "答复内容 text 不能为空" });
          return;
        }
        const tasks = await bus.listRecords(bus.tables.tasks);
        const task = tasks.find((t) => f1(t, "Task_ID") === taskId);
        if (!task) {
          sendJson(res, 404, { error: `任务不存在：${taskId}` });
          return;
        }
        const messages = (await bus.listRecords(bus.tables.messages)).filter((m) => f1(m, "Task_ID") === taskId);
        if (principal.kind === "agent") {
          const initiator = initiatorOf(task, messages);
          if (initiator !== principal.node) {
            sendJson(res, 403, { error: `只能答复本节点发起的任务（发起方 ${initiator}）` });
            return;
          }
        }
        if (f1(task, "Status") !== "input-required") {
          sendJson(res, 409, { error: `任务当前状态为 ${f1(task, "Status")}，不是 input-required` });
          return;
        }
        let max = 0;
        for (const m of messages) {
          const matched = String(f1(m, "Msg_ID") ?? "").match(/-(\d+)$/);
          if (matched && Number(matched[1]) > max) max = Number(matched[1]);
        }
        const msgId = `MSG-${taskId.replace("TASK-", "")}-${String(max + 1).padStart(2, "0")}`;
        const d = new Date();
        const p = (n) => String(n).padStart(2, "0");
        const nowMinute = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;

        await bus.createRecord(bus.tables.parts, {
          Part_ID: `${msgId}-P1`,
          Parent_ID: msgId,
          Parent_Type: "message",
          Seq: 1,
          Kind: "text",
          Text: text.slice(0, 4000),
        });
        await bus.createRecord(bus.tables.messages, {
          Msg_ID: msgId,
          Task_ID: taskId,
          Context_ID: f1(task, "Context_ID"),
          From_Node: String(body.from ?? body.node ?? "").trim() || cfg?.node || "hub",
          To_Node: f1(task, "Target_Node"),
          Role: String(body.role ?? "").trim() || "user",
          Kind: "answer",
          In_Reply_To: String(f1(task, "Status_Msg") ?? "").trim(),
          Created_At: nowMinute,
        });
        onWake();
        sendJson(res, 200, { msg_id: msgId });
        return;
      }

      // 8) 取消任务
      const cancelMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/cancel$/);
      if (method === "POST" && cancelMatch) {
        const taskId = decodeURIComponent(cancelMatch[1]);
        const body = await readJsonBodyBound();
        if (principal.kind === "agent") {
          const tasks = await bus.listRecords(bus.tables.tasks);
          const task = tasks.find((t) => f1(t, "Task_ID") === taskId);
          if (!task) {
            sendJson(res, 404, { error: `任务不存在：${taskId}` });
            return;
          }
          const messages = (await bus.listRecords(bus.tables.messages)).filter((m) => f1(m, "Task_ID") === taskId);
          const initiator = initiatorOf(task, messages);
          if (initiator !== principal.node) {
            sendJson(res, 403, { error: `只能撤销本节点发起的任务（发起方 ${initiator}）` });
            return;
          }
        }
        const actor = String(body.from ?? body.node ?? "").trim();
        const hubNode = cfg?.node || "hub";
        const result = await cancelTask({
          bus,
          node: actor || hubNode,
          role: actor && actor !== hubNode ? "node" : "hub",
          taskId,
          text: body.text || "",
        });
        onWake();
        sendJson(res, 200, result);
        return;
      }

      // 9) Web 端审批（走标准 ApprovalService + ed25519 签名）
      const decideMatch = pathname.match(/^\/api\/v1\/approvals\/([^/]+)\/decide$/);
      if (method === "POST" && decideMatch) {
        if (!approval) {
          sendJson(res, 503, { error: "ApprovalService 未就绪" });
          return;
        }
        const taskId = decodeURIComponent(decideMatch[1]);
        const body = await readJsonBodyBound();
        const decision = String(body.decision ?? "").trim();
        if (decision !== "approve" && decision !== "reject") {
          sendJson(res, 400, { error: "decision 只能是 approve 或 reject" });
          return;
        }
        const tasks = await bus.listRecords(bus.tables.tasks);
        const task = tasks.find((t) => f1(t, "Task_ID") === taskId);
        if (!task) {
          sendJson(res, 404, { error: `任务不存在：${taskId}` });
          return;
        }
        if (f1(task, "Status") !== "auth-required") {
          sendJson(res, 409, { error: `任务当前状态为 ${f1(task, "Status")}，不是 auth-required` });
          return;
        }
        const statusMsg = String(f1(task, "Status_Msg") ?? "").trim();
        const opId = String(approval.ownerId ?? "").trim() || "web-owner";
        const resp = await approval.handleCardAction({
          _source: "web",
          event_id: `web_${randomUUID()}`,
          operator: { id: opId },
          action: {
            value: {
              record_id: task.record_id,
              task_id: taskId,
              status_msg: statusMsg,
              decision,
            },
          },
        });
        await approval.whenIdle();
        onWake();
        const toast = resp?.toast ?? {};
        if (toast.type === "error") {
          sendJson(res, 400, { error: toast.content || "审批处理失败" });
          return;
        }
        sendJson(res, 200, { ok: true, message: toast.content || (decision === "approve" ? "已批准" : "已驳回") });
        return;
      }

      // 10) LoopForge SOP 闭环 API
      if (method === "GET" && pathname === "/api/v1/loop-templates") {
        sendJson(res, 200, { templates: Object.values(BUILTIN_LOOP_TEMPLATES) });
        return;
      }
      if (method === "GET" && pathname === "/api/v1/loops") {
        let rows = bus.tables.loops ? await bus.listRecords(bus.tables.loops) : [];
        if (principal.kind === "agent") {
          rows = rows.filter((r) => f1(r, "Created_By") === principal.node);
        }
        sendJson(res, 200, { loops: rows.map(formatLoopSummary).reverse() });
        return;
      }
      if (method === "POST" && pathname === "/api/v1/loops") {
        const body = await readJsonBodyBound();
        const resLoop = await createLoop({
          bus,
          title: body.title || "",
          goal: body.goal || "",
          template: body.stages ? "" : (body.template || "plan-code-verify"),
          stages: body.stages || null,
          stageBindings: body.stageBindings || null,
          to: body.to || "",
          worker: body.worker || "",
          cap: body.cap || "",
          approval: body.approval || "",
          maxIterations: body.maxIterations,
          context: body.context || "",
          from: body.from || cfg?.node || "hub",
          validateTarget: body.validateTarget !== false,
        });
        onWake();
        sendJson(res, 201, resLoop);
        return;
      }
      const cancelLoopMatch = pathname.match(/^\/api\/v1\/loops\/([^/]+)\/cancel$/);
      if (method === "POST" && cancelLoopMatch) {
        const loopId = decodeURIComponent(cancelLoopMatch[1]);
        const body = await readJsonBodyBound();
        if (principal.kind === "agent") {
          const rows = bus.tables.loops ? await bus.listRecords(bus.tables.loops) : [];
          const row = rows.find((r) => f1(r, "Loop_ID") === loopId);
          if (!row) {
            sendJson(res, 404, { error: `Loop 不存在：${loopId}` });
            return;
          }
          if (f1(row, "Created_By") !== principal.node) {
            sendJson(res, 403, { error: `只能取消本节点发起的闭环（发起方 ${f1(row, "Created_By") || "未知"}）` });
            return;
          }
        }
        const resCancel = await cancelLoop({ bus, loopId, reason: body.text || "控制台终止闭环" });
        onWake();
        sendJson(res, 200, resCancel);
        return;
      }

      // 11) 名片接纳与 Agent 接入管理 API（需 Bearer 鉴权）
      const cardAdmissionMatch = pathname.match(/^\/api\/v1\/admin\/cards\/([^/]+)\/admission$/);
      if (method === "POST" && cardAdmissionMatch) {
        const capId = decodeParam(cardAdmissionMatch[1]);
        const body = await readJsonBodyBound();
        const admission = validateAdmission(body?.admission);
        const cards = await bus.listRecords(bus.tables.agentCards);
        const card = cards.find((c) => f1(c, "Cap_ID") === capId);
        if (!card) {
          sendJson(res, 404, { error: `名片不存在：${capId}` });
          return;
        }
        const upd = await bus.updateRecord(bus.tables.agentCards, card.record_id, { Admission: admission });
        onWake();
        sendJson(res, 200, { ok: true, card: formatAgentCard(upd?.record ?? card) });
        return;
      }

      const nodeAdmissionMatch = pathname.match(/^\/api\/v1\/admin\/nodes\/([^/]+)\/admission$/);
      if (method === "POST" && nodeAdmissionMatch) {
        const node = decodeParam(nodeAdmissionMatch[1]);
        const body = await readJsonBodyBound();
        const admission = validateAdmission(body?.admission);
        const cards = await bus.listRecords(bus.tables.agentCards);
        const nodeCards = cards.filter((c) => f1(c, "Node") === node);
        if (!nodeCards.length) {
          sendJson(res, 404, { error: `节点没有名片：${node}` });
          return;
        }
        for (const c of nodeCards) {
          await bus.updateRecord(bus.tables.agentCards, c.record_id, { Admission: admission });
        }
        onWake();
        sendJson(res, 200, { ok: true, node, updated: nodeCards.length });
        return;
      }

      const nodeReceiveMatch = pathname.match(/^\/api\/v1\/admin\/nodes\/([^/]+)\/receive$/);
      if (method === "POST" && nodeReceiveMatch) {
        const result = await switchNodeReceive({
          bus,
          tokenStore,
          webhookStore: webhooks?.store ?? null,
          node: decodeParam(nodeReceiveMatch[1]),
          body: await readJsonBodyBound(),
          hubUrl: requestHubUrl(req),
          authRequired: Boolean(apiToken) || Boolean(tokenStore?.hasAny()),
        });
        if (result.cards_updated) onWake();
        sendJson(res, 200, result);
        return;
      }

      const cardProfileMatch = pathname.match(/^\/api\/v1\/admin\/cards\/([^/]+)\/profile$/);
      if ((method === "PATCH" || method === "POST") && cardProfileMatch) {
        const capId = decodeParam(cardProfileMatch[1]);
        const body = await readJsonBodyBound();
        const patch = validateProfileFields(body);
        const cards = await bus.listRecords(bus.tables.agentCards);
        const card = cards.find((c) => f1(c, "Cap_ID") === capId);
        if (!card) {
          sendJson(res, 404, { error: `名片不存在：${capId}` });
          return;
        }
        let latest = card;
        if (Object.keys(patch).length > 0) {
          const upd = await bus.updateRecord(bus.tables.agentCards, card.record_id, patch);
          latest = upd?.record ?? card;
          onWake();
        }
        sendJson(res, 200, { ok: true, card: formatAgentCard(latest) });
        return;
      }

      if (method === "POST" && pathname === "/api/v1/admin/cards") {
        // body.node 是要添加能力的目标节点，不是调用者身份。带 admin 的 Leader 会给别的节点建名片。
        const body = await readJsonBody(req);
        try {
          const record = await createManualCard({ bus, tokenStore, body });
          onWake();
          sendJson(res, 201, { ok: true, card: formatAgentCard(record) });
        } catch (e) {
          if (Number(e?.status) === 409 && e.snippet) {
            sendJson(res, 409, { error: e.message, snippet: e.snippet, text: e.text, hint: e.hint });
            return;
          }
          throw e;
        }
        return;
      }

      const deleteCardMatch = pathname.match(/^\/api\/v1\/admin\/cards\/([^/]+)$/);
      if (method === "DELETE" && deleteCardMatch) {
        const capId = decodeParam(deleteCardMatch[1]);
        const result = await deleteManualCard({ bus, tokenStore, capId });
        onWake();
        sendJson(res, 200, result);
        return;
      }

      if (method === "POST" && pathname === "/api/v1/admin/commands-snippet") {
        const body = await readJsonBodyBound();
        sendJson(res, 200, buildCommandsSnippet(body));
        return;
      }

      if (method === "GET" && pathname === "/api/v1/schedules") {
        const [rules, tasks, cards] = await Promise.all([
          bus.tables.rules ? bus.listRecords(bus.tables.rules) : Promise.resolve([]),
          bus.listRecords(bus.tables.tasks),
          bus.listRecords(bus.tables.agentCards),
        ]);
        sendJson(res, 200, {
          schedules: listSchedules({
            rules,
            tasks,
            cards,
            connected: broker ? broker.connectedNodes() : [],
            hubNode: cfg?.node || "",
            hubTz: cfg?.tz || "",
          }),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/v1/admin/agents") {
        const body = await readJsonBodyBound();
        const node = validateNodeName(body?.node);
        const access = validateAccess(body?.access);
        const role = validateRole(body?.role);
        const profile = validateProfileFields(body);
        const displayName = profile.Display_Name ?? "";
        const adminNote = profile.Admin_Note ?? "";
        const description = body?.description == null ? "" : String(body.description).trim();
        // receive 只对 HTTP Agent 有意义；host / inbox 的唤醒方式由本机 ah daemon 决定。
        let receive = "poll";
        let webhookUrl = "";
        if (access === "http") {
          receive = validateReceive(body?.receive);
          if (receive === "webhook") webhookUrl = validateWebhookUrl(body?.webhook_url);
        }

        if (access === "http") {
          if (!tokenStore) {
            sendJson(res, 500, { error: "未配置 configDir，无法签发 Agent Token" });
            return;
          }
          // 没有机主 Token 时一旦签发 Agent Token，鉴权就会生效，机主自己将被挡在管理接口之外。
          if (!apiToken) {
            sendJson(res, 400, { error: "请先在 node.json 配置机主 apiToken，再签发 Agent Token" });
            return;
          }
          if (tokenStore.get(node)) {
            sendJson(res, 409, { error: `节点 ${node} 已存在（已有 Token）。如需重新接入，请在「节点」页重新生成 Token（即轮换：POST /api/v1/admin/tokens/${node}/rotate），或先删除该节点再添加` });
            return;
          }
        }

        let card = null;
        if (access === "http" && (role === "worker" || role === "hybrid")) {
          const capId = capIdOf("agent", {}, node);
          const existing = await bus.listRecords(bus.tables.agentCards);
          if (existing.some((r) => f1(r, "Cap_ID") === capId)) {
            const prev = existing.find((r) => f1(r, "Cap_ID") === capId);
            const adm = admissionOf(prev);
            // 被拒绝的名片仍占着 Cap_ID，直接报「已存在」会让人以为节点凭空消失了。
            const where = adm === "rejected" ? "它在「节点 → 已拒绝」里，可以恢复为待接纳" : (adm === "pending" ? "它在「节点 → 待接纳」里" : "它已经接入");
            sendJson(res, 409, { error: `节点 ${node} 已存在：${where}；也可先删除该节点再添加` });
            return;
          }
          const created = await bus.createRecord(bus.tables.agentCards, {
            Cap_ID: capId,
            Node: node,
            Worker: "",
            Skill_ID: "agent",
            Skill_Name: displayName || `${node} Agent`,
            Description: description,
            Side_Effect: "write",
            Approval_Class: "auto",
            Availability: "offline",
            Dispatchable: "Yes",
            Receive_Mode: receiveModeFor(receive),
            Zone: "cloud",
            Daemon_Version: "http-agent",
            Admission: "admitted",
            Display_Name: displayName,
            Admin_Note: adminNote,
            Updated_At: nowMinute(),
            Metadata: JSON.stringify({ kind: "agent", role, mode: receiveModeFor(receive), preset: true }),
          });
          onWake();
          card = formatAgentCard(created?.record);
        }

        let issued = null;
        if (access === "http") {
          issued = tokenStore.issue({ node, role, scopes: [] });
        }
        let webhookPayload = null;
        let webhookSecret = "";
        if (access === "http" && receive === "webhook") {
          if (!webhooks) throw httpError(500, "未配置 configDir，无法保存 Webhook");
          const saved = webhooks.store.put({ node, url: webhookUrl });
          webhookPayload = { url: saved.hook.url };
          // 密钥只在本次新建时出现。节点上已经有 Webhook 时不再把旧密钥交出来。
          if (saved.secret) {
            webhookPayload.secret = saved.secret;
            webhookSecret = saved.secret;
          }
        }
        const onboarding = buildOnboarding({
          hubUrl: requestHubUrl(req),
          node,
          access,
          role,
          authRequired: Boolean(apiToken) || Boolean(issued),
          token: issued?.token || "",
          receive,
          webhookSecret,
        });
        const payload = { ok: true, node, card, onboarding };
        if (issued) payload.token = issued.token;
        if (webhookPayload) payload.webhook = webhookPayload;
        sendJson(res, 200, payload);
        return;
      }

      const deleteAgentMatch = pathname.match(/^\/api\/v1\/admin\/agents\/([^/]+)$/);
      if (method === "DELETE" && deleteAgentMatch) {
        const node = validateNodeName(decodeParam(deleteAgentMatch[1]));
        if (node === (cfg?.node || "hub")) {
          sendJson(res, 400, { error: "不能删除 Hub 本机节点" });
          return;
        }
        if (typeof bus.deleteRecord !== "function") {
          sendJson(res, 501, { error: "当前总线不支持删除名片" });
          return;
        }
        const cards = (await bus.listRecords(bus.tables.agentCards)).filter((c) => f1(c, "Node") === node);
        // 先吊销再删名片：顺序反过来时，对方恰好在这之间注册会把名片写回来。
        const tokenRevoked = tokenStore ? tokenStore.revoke(node) : false;
        const webhookRemoved = webhooks ? webhooks.store.remove(node) : false;
        for (const c of cards) await bus.deleteRecord(bus.tables.agentCards, c.record_id);
        const forgotten = broker?.forgetNode ? broker.forgetNode(node) : false;
        if (!cards.length && !tokenRevoked && !forgotten && !webhookRemoved) {
          sendJson(res, 404, { error: `节点不存在：${node}` });
          return;
        }
        // 未结束的任务不动：它们仍可在任务页撤销，删 Agent 不应顺带改任务状态。
        const tasks = await bus.listRecords(bus.tables.tasks);
        const openTasks = tasks.filter((t) => f1(t, "Target_Node") === node && !TERMINAL_STATUSES.has(f1(t, "Status"))).length;
        if (cards.length) onWake();
        sendJson(res, 200, { ok: true, node, cardsRemoved: cards.length, tokenRevoked, webhookRemoved, openTasks });
        return;
      }

      if (method === "GET" && pathname === "/api/v1/admin/onboarding") {
        const rawNode = reqUrl.searchParams.get("node");
        const node = validateNodeName(
          principal.kind === "agent" && !String(rawNode ?? "").trim() ? principal.node : rawNode,
        );
        const access = validateAccess(reqUrl.searchParams.get("access"));
        const role = validateRole(reqUrl.searchParams.get("role"));
        const receive = access === "http" ? validateReceive(reqUrl.searchParams.get("receive")) : "poll";
        const onboarding = buildOnboarding({
          hubUrl: requestHubUrl(req),
          node,
          access,
          role,
          authRequired: Boolean(apiToken) || Boolean(tokenStore?.hasAny()),
          receive,
        });
        sendJson(res, 200, { onboarding });
        return;
      }

      if (method === "GET" && pathname === "/api/v1/admin/tokens") {
        sendJson(res, 200, { tokens: tokenStore ? tokenStore.listPublic() : [] });
        return;
      }

      const rotateTokenMatch = pathname.match(/^\/api\/v1\/admin\/tokens\/([^/]+)\/rotate$/);
      if (method === "POST" && rotateTokenMatch) {
        if (!tokenStore) throw httpError(500, "未配置 configDir，无法管理 Agent Token");
        if (!apiToken) throw httpError(400, "请先在 node.json 配置机主 apiToken，再签发 Agent Token");
        const node = validateNodeName(decodeParam(rotateTokenMatch[1]));
        const body = await readJsonBodyBound();
        const existing = tokenStore.get(node);
        const role = Object.hasOwn(body, "role") ? body.role : existing?.role;
        const scopes = Object.hasOwn(body, "scopes") ? body.scopes : undefined;
        const issued = tokenStore.rotate({ node, role, scopes });
        const onboarding = buildOnboarding({
          hubUrl: requestHubUrl(req),
          node,
          access: "http",
          role: issued.role,
          authRequired: true,
          token: issued.token,
        });
        sendJson(res, 200, { token: issued.token, onboarding });
        return;
      }

      const revokeTokenMatch = pathname.match(/^\/api\/v1\/admin\/tokens\/([^/]+)$/);
      if (method === "DELETE" && revokeTokenMatch) {
        if (!tokenStore) throw httpError(500, "未配置 configDir，无法管理 Agent Token");
        const node = validateNodeName(decodeParam(revokeTokenMatch[1]));
        if (!tokenStore.revoke(node)) {
          sendJson(res, 404, { error: `节点 ${node} 没有 Token` });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === "/api/v1/admin/webhooks" || pathname.startsWith("/api/v1/admin/webhooks/")) {
        if (!webhooks) throw httpError(500, "未配置 configDir，无法管理 Webhook");
        if (method === "GET" && pathname === "/api/v1/admin/webhooks") {
          sendJson(res, 200, { webhooks: webhooks.store.listPublic() });
          return;
        }
        const webhookTestMatch = pathname.match(/^\/api\/v1\/admin\/webhooks\/([^/]+)\/test$/);
        if (method === "POST" && webhookTestMatch) {
          const node = validateNodeName(decodeParam(webhookTestMatch[1]));
          const result = await webhooks.ping(node);
          if (result.missing) {
            sendJson(res, 404, { error: `节点 ${node} 没有 Webhook` });
            return;
          }
          sendJson(res, 200, { ok: result.ok, status: result.status, error: result.error });
          return;
        }
        const webhookNodeMatch = pathname.match(/^\/api\/v1\/admin\/webhooks\/([^/]+)$/);
        if (webhookNodeMatch && method === "DELETE") {
          const node = validateNodeName(decodeParam(webhookNodeMatch[1]));
          if (!webhooks.store.remove(node)) {
            sendJson(res, 404, { error: `节点 ${node} 没有 Webhook` });
            return;
          }
          // 配置没了就不能再声称是 webhook，否则控制台和投递会各说各话。回到默认定时检查。
          const cardsUpdated = await alignNodeReceiveMode(bus, node, "http-poll");
          if (cardsUpdated) onWake();
          sendJson(res, 200, { ok: true });
          return;
        }
        if (webhookNodeMatch && method === "PUT") {
          const node = validateNodeName(decodeParam(webhookNodeMatch[1]));
          const cards = await bus.listRecords(bus.tables.agentCards);
          if (nodeStoredReceiveMode(cards, node) !== "webhook") {
            throw httpError(409, "先把接收方式切换成 Webhook");
          }
          const body = await readJsonBodyBound();
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw httpError(400, "请求体必须是 JSON 对象");
          }
          const url = validateWebhookUrl(body.url);
          let rotate = false;
          if (Object.hasOwn(body, "rotate_secret") && body.rotate_secret != null && body.rotate_secret !== false) {
            if (body.rotate_secret !== true) throw httpError(400, "rotate_secret 必须是布尔值");
            rotate = true;
          }
          const saved = webhooks.store.put({ node, url, rotate });
          const webhook = { node, url: saved.hook.url };
          if (saved.secret) webhook.secret = saved.secret;
          sendJson(res, 200, { ok: true, webhook });
          return;
        }
      }

      sendJson(res, 404, { error: "Not Found" });
    } catch (e) {
      const status = Number(e?.status) || 400;
      if (!res.writableEnded) sendJson(res, status, { error: e?.message ?? String(e) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  activePort = boundPort;
  const localUrl = `http://${connectHost}:${boundPort}`;

  if (runtimePath) {
    try {
      fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
      fs.writeFileSync(runtimePath, JSON.stringify({
        pid: process.pid,
        url: localUrl,
        listen: `${host}:${boundPort}`,
        startedAt: new Date().toISOString(),
      }, null, 2), { mode: 0o600 });
    } catch (e) {
      log("写入 hub_runtime.json 失败：" + (e?.message ?? e));
    }
  }

  log(`Hub HTTP & Web 控制台已启动：http://${host}:${boundPort} （本机访问：${localUrl}）`);

  return {
    server,
    host,
    port: boundPort,
    localUrl,
    close: async () => {
      if (runtimePath) {
        try {
          const info = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
          if (Number(info?.pid) === process.pid) fs.unlinkSync(runtimePath);
        } catch { /* ignore */ }
      }
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
