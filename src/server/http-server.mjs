// Hub HTTP 服务端：承载 REST 总线接口、HTTP 长轮询唤醒端点、Web 控制台与审批签名。

import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { f1 } from "../bus/tables.mjs";
import { resolveTableName } from "../bus/tables.mjs";
import { resolveListenAddr } from "../config.mjs";
import { agentCanSeeTask, assertAgentRoute, bindAgentBody } from "../hub/agent-access.mjs";
import { AgentTokenStore } from "../hub/agent-tokens.mjs";
import {
  buildOnboarding,
  admissionOf,
  ensureLeaderIdentityCards,
  formatAgentCard,
  httpError,
  issuedRole,
  parseCardMetadata,
  presetHttpCardFields,
  receiveForTemplate,
  receiveModeFor,
  resolveHttpOnboardingChoice,
  templatePresetById,
  knownTemplateId,
  inferTemplateId,
  validateAccess,
  validateAdmission,
  validateNodeName,
  validatePollIntervalMin,
  validateProfileFields,
  validateReceive,
  validateRole,
  validateTemplate,
} from "../hub/admission.mjs";
import { consoleTemplatePresets, loadAgentTemplates } from "../hub/agent-templates.mjs";
import { publicWebhook, validateWebhookHeader, validateWebhookKey, validateWebhookUrl, WebhookDispatcher } from "../hub/webhooks.mjs";
import {
  alignNodeReceiveMode,
  buildCommandsSnippet,
  createManualCard,
  deleteManualCard,
  listSchedules,
  nodeStoredReceiveMode,
} from "../hub/capabilities.mjs";
import { cancelTask } from "../hub/cancel.mjs";
import { appendFileParts, attachmentsView, normalizeAttachments } from "../attachments.mjs";
import { createTask } from "../hub/create.mjs";
import { FileStore, findFileRefs, normalizeMime, sanitizeFileName } from "../hub/files.mjs";
import { initiatorOf } from "../inbox.mjs";
import { TERMINAL_STATUSES } from "../kernel-util.mjs";
import { getTaskWhy } from "../why.mjs";
import { handleAgentGatewayRequest } from "./agent-gateway.mjs";
import { rosterNodeVisible } from "./longpoll-broker.mjs";
import { renderWebConsoleHtml } from "./web-ui.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const INLINE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function encodeRFC5987(str) {
  return encodeURIComponent(String(str ?? "file")).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-A2A-Node, X-Api-Token, X-File-Name",
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
    metadata: parseJsonField(f1(t, "Metadata"), {}),
  };
}

async function canPrincipalSeeFile({ principal, meta, bus, fileId }) {
  if (principal?.kind !== "agent") {
    return { visible: true, refs: null };
  }
  if (meta.uploaded_by === principal.node) {
    return { visible: true, refs: null };
  }
  const rawRefs = await findFileRefs(bus, fileId);
  const taskIds = [...new Set(rawRefs.map((r) => r.task_id).filter(Boolean))];
  if (!taskIds.length || !bus?.tables?.tasks) {
    return { visible: false, refs: taskIds };
  }
  const [tasks, messages] = await Promise.all([
    bus.listRecords(bus.tables.tasks),
    bus.tables.messages ? bus.listRecords(bus.tables.messages) : Promise.resolve([]),
  ]);
  for (const tid of taskIds) {
    const task = tasks.find((t) => f1(t, "Task_ID") === tid);
    if (!task) continue;
    const taskMsgs = messages.filter((m) => f1(m, "Task_ID") === tid);
    if (agentCanSeeTask(principal, initiatorOf(task, taskMsgs), f1(task, "Source"), f1(task, "Target_Node"))) {
      return { visible: true, refs: taskIds };
    }
  }
  return { visible: false, refs: taskIds };
}

export async function startHubHttpServer({
  cfg,
  bus,
  broker,
  approval,
  fileStore = null,
  log = () => {},
  onWake = () => {},
  webhookDispatcher = null,
} = {}) {
  const { host, port } = resolveListenAddr(cfg?.listen ?? "0.0.0.0:8787");
  const apiToken = String(cfg?.apiToken ?? "").trim();
  const tokenStore = cfg?.configDir ? new AgentTokenStore(cfg.configDir) : null;
  const ownFileStore = !fileStore && cfg?.configDir
    ? new FileStore({
      configDir: cfg.configDir,
      ...(Number.isFinite(Number(cfg?.maxFileBytes)) && Number(cfg.maxFileBytes) > 0
        ? { maxBytes: Number(cfg.maxFileBytes) }
        : {}),
    })
    : null;
  const activeFileStore = fileStore ?? ownFileStore;
  const webhooks = webhookDispatcher
    ?? (cfg?.configDir
      ? new WebhookDispatcher({
        configDir: cfg.configDir,
        hubNode: cfg?.node || "hub",
        taskTable: bus?.tables?.tasks || "tasks",
        messageTable: bus?.tables?.messages || "messages",
        bus,
        broker,
        log,
      })
      : null);
  // 调用方先建好的 dispatcher 也要能在投递成功时刷新在线，不能只靠自己 new 的那条路径。
  if (webhooks && broker && !webhooks.broker) webhooks.broker = broker;
  // 答复门铃要靠 bus 反查 Target_Node。hub 启动路径已经 addListener，这里只给自己 new 出来的那份注册，避免双推。
  if (webhooks && bus) {
    if (!webhooks.bus) webhooks.bus = bus;
    if (bus.tables?.messages) webhooks.messageTable = bus.tables.messages;
  }
  if (!webhookDispatcher && webhooks && typeof bus?.addListener === "function") bus.addListener(webhooks);
  if (tokenStore && bus) {
    try {
      const created = await ensureLeaderIdentityCards({
        bus,
        tokenStore,
        webhookStore: webhooks?.store ?? null,
      });
      if (created) log(`已为 ${created} 个 leader 补建身份名片`);
    } catch (err) {
      // 补建失败不能挡住 Hub 起来；下一轮启动会再试，已有名片不会被覆盖。
      log(`补建 leader 身份名片失败：${err?.message ?? err}`);
    }
  }
  // 启动时将名片已保存的 poll_interval_min 预同步到 Broker，避免重启后首次 Webhook 投递回落到默认窗口。
  if (broker?.setNodePollInterval && bus?.tables?.agentCards && typeof bus.listRecords === "function") {
    try {
      const bootCards = await bus.listRecords(bus.tables.agentCards);
      for (const card of bootCards) {
        const nodeName = f1(card, "Node");
        const intervalMin = parseCardMetadata(card).poll_interval_min;
        if (nodeName && intervalMin > 0) broker.setNodePollInterval(nodeName, intervalMin);
      }
    } catch (err) {
      log(`同步名片轮询间隔失败：${err?.message ?? err}`);
    }
  }
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
  // 节点模板以配置目录的文件为准。没有文件时写入初始四条；之后每次请求重读，改文件不用重启。
  const agentTemplates = () => loadAgentTemplates(cfg?.configDir || "", { writeIfMissing: Boolean(cfg?.configDir) });

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
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-A2A-Node, X-Api-Token, X-File-Name",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      });
      res.end();
      return;
    }

    try {
      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const loaded = agentTemplates();
        sendHtml(res, 200, renderWebConsoleHtml({
          presets: consoleTemplatePresets(loaded.presets),
          templateError: loaded.errors.join("；"),
        }));
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
        hubUrl: requestHubUrl(req),
        fileStore: activeFileStore,
      })) {
        return;
      }

      // 0) 附件上传与下载（§3：流式上传不走 readJsonBody，agent 无权或不存在统一 404）
      if (method === "POST" && pathname === "/api/v1/files") {
        if (!activeFileStore) {
          sendJson(res, 503, { error: "文件存储未配置" });
          return;
        }
        const clRaw = req.headers["content-length"];
        if (clRaw !== undefined) {
          const cl = Number(clRaw);
          if (Number.isFinite(cl) && cl > activeFileStore.maxBytes) {
            if (!req.readableEnded) res.setHeader("Connection", "close");
            sendJson(res, 413, { error: `文件大小超过上限（${activeFileStore.maxBytes} 字节）` });
            return;
          }
        }
        let fileName = "file";
        const rawName = req.headers["x-file-name"];
        if (rawName !== undefined && String(rawName).trim() !== "") {
          let decoded;
          try {
            decoded = decodeURIComponent(String(rawName));
          } catch {
            throw httpError(400, "X-File-Name 编码不合法");
          }
          fileName = sanitizeFileName(decoded, "file");
        }
        const mime = normalizeMime(req.headers["content-type"]);
        const uploadedBy = principal.kind === "agent"
          ? principal.node
          : (principal.kind === "owner" ? "owner" : "open");
        const meta = await activeFileStore.putStream(req, { name: fileName, mime, uploadedBy });
        sendJson(res, 201, {
          file_id: meta.file_id,
          uri: meta.uri,
          name: meta.name,
          mime: meta.mime,
          size: meta.size,
          sha256: meta.sha256,
        });
        return;
      }

      const fileMetaMatch = pathname.match(/^\/api\/v1\/files\/([^/]+)\/meta$/);
      if (method === "GET" && fileMetaMatch) {
        if (!activeFileStore) {
          sendJson(res, 503, { error: "文件存储未配置" });
          return;
        }
        const fileId = decodeParam(fileMetaMatch[1]);
        const meta = activeFileStore.get(fileId);
        if (!meta) {
          sendJson(res, 404, { error: "文件不存在" });
          return;
        }
        const { visible, refs: checkedRefs } = await canPrincipalSeeFile({ principal, meta, bus, fileId });
        if (!visible) {
          sendJson(res, 404, { error: "文件不存在" });
          return;
        }
        if (meta.deleted_at) {
          sendJson(res, 410, {
            error: "文件已过期清理",
            deleted_at: meta.deleted_at,
            reason: activeFileStore.getReason(fileId) || "expired",
          });
          return;
        }
        const refs = checkedRefs ?? [...new Set((await findFileRefs(bus, fileId)).map((r) => r.task_id).filter(Boolean))];
        sendJson(res, 200, { meta, refs });
        return;
      }

      const fileDownloadMatch = pathname.match(/^\/api\/v1\/files\/([^/]+)$/);
      if (method === "GET" && fileDownloadMatch) {
        if (!activeFileStore) {
          sendJson(res, 503, { error: "文件存储未配置" });
          return;
        }
        const fileId = decodeParam(fileDownloadMatch[1]);
        const meta = activeFileStore.get(fileId);
        if (!meta) {
          sendJson(res, 404, { error: "文件不存在" });
          return;
        }
        const { visible } = await canPrincipalSeeFile({ principal, meta, bus, fileId });
        if (!visible) {
          sendJson(res, 404, { error: "文件不存在" });
          return;
        }
        if (meta.deleted_at) {
          sendJson(res, 410, {
            error: "文件已过期清理",
            deleted_at: meta.deleted_at,
            reason: activeFileStore.getReason(fileId) || "expired",
          });
          return;
        }
        const stream = activeFileStore.openReadStream(fileId);
        const baseMime = normalizeMime(meta.mime);
        const wantsInline = reqUrl.searchParams.get("inline") === "1" && INLINE_IMAGE_MIMES.has(baseMime);
        const disposition = wantsInline ? "inline" : "attachment";
        res.writeHead(200, {
          "Content-Type": meta.mime || "application/octet-stream",
          "Content-Length": String(meta.size),
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, max-age=0",
          "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeRFC5987(meta.name)}`,
          "Access-Control-Allow-Origin": "*",
        });
        const cleanup = () => { if (!stream.destroyed) stream.destroy(); };
        res.on("close", cleanup);
        stream.on("error", () => {
          if (!res.writableEnded) res.destroy();
        });
        stream.pipe(res);
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
        const [tasks, cards] = await Promise.all([
          bus.listRecords(bus.tables.tasks),
          bus.listRecords(bus.tables.agentCards),
        ]);
        const cardNodes = new Set();
        for (const c of cards) {
          const node = f1(c, "Node");
          if (node) cardNodes.add(node);
        }
        // 无名片且 30 分钟内没活动的在线记录不进总览。有名片的离线节点仍留在 agentCards 里。
        const connectedNodes = (broker ? broker.connectedNodes() : [])
          .filter((n) => rosterNodeVisible(n, cardNodes.has(n.node)));
        // Hub 自己的工作内核在进程内直连 Broker，从不经 HTTP 轮询，Broker 里没有它的连接记录。
        // 能响应本请求就说明它在线，不补的话控制台「最近活动」永远是「暂无记录」。
        const selfNode = cfg?.node || "";
        if (selfNode && !connectedNodes.some((n) => n.node === selfNode)) {
          connectedNodes.push({
            node: selfNode,
            online: true,
            polling: true,
            activeWaiters: 0,
            cursor: broker?.latestSeq ?? 0,
            remoteAddr: "",
            lastSeenAt: Date.now(),
            firstSeenAt: Date.now(),
            kind: "host",
            mode: "longpoll",
            role: "",
            intervalSec: null,
            lastDeliveredAt: null,
          });
        }
        sendJson(res, 200, {
          hubNode: cfg?.node || "hub",
          hubPublicKey: cfg?.hubPublicKey || "",
          seq: broker?.latestSeq ?? 0,
          connectedNodes,
          tasks: tasks.map(formatTaskSummary).reverse(),
          agentCards: cards.map(formatAgentCard),
          cards: typeof bus.listCards === "function" ? bus.listCards() : [],
        });
        return;
      }

      // 5) 单任务详情（含对话流、Artifacts、Why）
      const taskDetailMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
      if (method === "GET" && taskDetailMatch) {
        const taskId = decodeURIComponent(taskDetailMatch[1]);
        const [tasks, messages, parts, artifacts] = await Promise.all([
          bus.listRecords(bus.tables.tasks),
          bus.listRecords(bus.tables.messages),
          bus.listRecords(bus.tables.parts),
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
              .map((p) => {
                const base = {
                  part_id: f1(p, "Part_ID"),
                  seq: Number(f1(p, "Seq")) || 0,
                  kind: f1(p, "Kind"),
                  text: f1(p, "Text"),
                  file_uri: f1(p, "File_URI"),
                  file_name: f1(p, "File_Name"),
                  mime_type: f1(p, "Mime_Type"),
                  data: f1(p, "Data"),
                };
                // 文件块补下载地址、大小与过期标记（docs/attachments.md §7）。
                if (base.kind === "file") {
                  const [view] = attachmentsView([p], requestHubUrl(req), activeFileStore);
                  Object.assign(base, { download_url: view.download_url, size: view.size, deleted: view.deleted });
                }
                return base;
              });
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
        const taskRuns = [];
        const taskArts = artifacts
          .filter((a) => f1(a, "Task_ID") === taskId)
          .map((a) => {
            const artId = f1(a, "Artifact_ID");
            const files = attachmentsView(
              parts.filter((p) => f1(p, "Parent_Type") === "artifact" && f1(p, "Parent_ID") === artId),
              requestHubUrl(req),
              activeFileStore,
            );
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

      // 6) 创建任务（支持单个 to 字符串，或 to: [...] 同 Context_ID 批量群派）
      if (method === "POST" && pathname === "/api/v1/tasks") {
        const body = await readJsonBodyBound();
        const attachments = normalizeAttachments(body.attachments, { fileStore: activeFileStore });
        // 有附件时 text 可以为空，但两者不能同时为空。
        if (!String(body.text ?? "").trim() && !attachments.length) {
          sendJson(res, 400, { error: "text 与 attachments 不能同时为空" });
          return;
        }
        const commonOpts = {
          bus,
          from: body.from || cfg?.node || "hub",
          source: body.source || ((body.schedule_id || body.scheduleId) ? "cron" : "") || body.from || "web",
          worker: body.worker || "",
          requested_model: body.requested_model ?? null,
          cap: body.cap || "",
          text: body.text || "",
          params: body.params,
          criteria: body.criteria,
          ref: body.ref || "",
          approval: body.approval || "",
          idempotencyKey: body.idempotencyKey || "",
          scheduleId: body.schedule_id || body.scheduleId || "",
          validateTarget: body.validateTarget !== false,
          attachments,
          fileStore: activeFileStore,
          queueTimeoutSec: body.queue_timeout_sec,
          leaseTtlSec: body.lease_ttl_sec,
          waitTimeoutSec: body.wait_timeout_sec,
        };
        if (Array.isArray(body.to)) {
          if (!body.to.length) {
            sendJson(res, 400, { error: "to 数组不能为空" });
            return;
          }
          const targets = body.to.map((item) => validateNodeName(item));
          const sharedContext = String(body.context ?? "").trim() || `CTX-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
          const taskIds = [];
          for (let i = 0; i < targets.length; i++) {
            const targetNode = targets[i];
            const perKey = commonOpts.idempotencyKey ? `${commonOpts.idempotencyKey}:${targetNode}:${i}` : "";
            const taskId = await createTask({
              ...commonOpts,
              to: targetNode,
              context: sharedContext,
              idempotencyKey: perKey,
            });
            taskIds.push(taskId);
          }
          onWake();
          sendJson(res, 201, { task_ids: taskIds, context_id: sharedContext });
          return;
        }
        const taskId = await createTask({
          ...commonOpts,
          to: body.to || "",
          context: body.context || "",
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
        const attachments = normalizeAttachments(body.attachments, { fileStore: activeFileStore });
        if (!text && !attachments.length) {
          sendJson(res, 400, { error: "答复内容 text 与 attachments 不能同时为空" });
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
        // 同一 Status_Msg 已有 answer 就停在写表之前。新问题会换 Status_Msg，多轮追问不受影响。
        const statusMsg = String(f1(task, "Status_Msg") ?? "").trim();
        if (body.append !== true && statusMsg && messages.some((m) =>
          f1(m, "Kind") === "answer" && String(f1(m, "In_Reply_To") ?? "").trim() === statusMsg)) {
          sendJson(res, 409, { error: "该问题已有答复；如需再补一条请传 append:true" });
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

        // 没有文字就不写 text 块，文件块从 Seq 1 开始。
        let nextSeq = 1;
        if (text) {
          await bus.createRecord(bus.tables.parts, {
            Part_ID: `${msgId}-P1`,
            Parent_ID: msgId,
            Parent_Type: "message",
            Seq: 1,
            Kind: "text",
            Text: text.slice(0, 4000),
          });
          nextSeq = 2;
        }
        await appendFileParts(bus, msgId, nextSeq, attachments);
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

      // 10) 名片接纳与 Agent 接入管理 API（需 Bearer 鉴权）
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
        const [tasks, cards] = await Promise.all([
          bus.listRecords(bus.tables.tasks),
          bus.listRecords(bus.tables.agentCards),
        ]);
        sendJson(res, 200, {
          schedules: listSchedules({
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
        const role = issuedRole(validateRole(body?.role));
        const profile = validateProfileFields(body);
        const displayName = profile.Display_Name ?? "";
        const adminNote = profile.Admin_Note ?? "";
        const description = body?.description == null ? "" : String(body.description).trim();
        // receive 只对 HTTP Agent 有意义；host / inbox 的唤醒方式由本机 ah daemon 决定。
        let receive = "poll";
        let webhookUrl = "";
        let webhookKey = "";
        let webhookHeader = "Authorization";
        let pollIntervalMin = null;
        let template = "generic";
        let templateId = "";
        const { presets } = agentTemplates();
        if (access === "http") {
          const choice = resolveHttpOnboardingChoice({
            template: Object.hasOwn(body ?? {}, "template") ? body.template : undefined,
            receive: Object.hasOwn(body ?? {}, "receive") ? body.receive : undefined,
            templateId: body?.template_id,
            presets,
          });
          template = choice.template;
          receive = choice.receive;
          templateId = choice.templateId;
          pollIntervalMin = validatePollIntervalMin(body?.poll_interval_min, receive);
          if (receive === "webhook") {
            webhookUrl = validateWebhookUrl(body?.webhook_url);
            webhookKey = validateWebhookKey(body?.webhook_key ?? body?.key, { required: true });
            webhookHeader = validateWebhookHeader(body?.webhook_header ?? body?.header);
          }
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
        if (access === "http") {
          const fields = presetHttpCardFields({
            node,
            role,
            receiveMode: receiveModeFor(receive),
            displayName,
            description,
            adminNote,
            availability: "offline",
            updatedAt: nowMinute(),
            pollIntervalMin,
            template,
            templateId,
            model: templateId ? templatePresetById(templateId, presets) : {},
          });
          const existing = await bus.listRecords(bus.tables.agentCards);
          if (existing.some((r) => f1(r, "Cap_ID") === fields.Cap_ID)) {
            const prev = existing.find((r) => f1(r, "Cap_ID") === fields.Cap_ID);
            const adm = admissionOf(prev);
            // 被拒绝的名片仍占着 Cap_ID，直接报「已存在」会让人以为节点凭空消失了。
            const where = adm === "rejected" ? "它在「节点 → 已拒绝」里，可以恢复为待接纳" : (adm === "pending" ? "它在「节点 → 待接纳」里" : "它已经接入");
            sendJson(res, 409, { error: `节点 ${node} 已存在：${where}；也可先删除该节点再添加` });
            return;
          }
          const created = await bus.createRecord(bus.tables.agentCards, fields);
          onWake();
          card = formatAgentCard(created?.record);
        }

        let issued = null;
        if (access === "http") {
          issued = tokenStore.issue({ node, role, scopes: [] });
        }
        let webhookPayload = null;
        if (access === "http" && receive === "webhook") {
          if (!webhooks) throw httpError(500, "未配置 configDir，无法保存 Webhook");
          const saved = webhooks.store.put({
            node,
            url: webhookUrl,
            key: webhookKey,
            header: webhookHeader,
          });
          webhookPayload = publicWebhook(saved.hook);
        }
        const onboarding = buildOnboarding({
          hubUrl: requestHubUrl(req),
          node,
          access,
          role,
          authRequired: Boolean(apiToken) || Boolean(issued),
          token: issued?.token || "",
          receive,
          pollIntervalMin,
          template,
          templateId,
          presets,
        });
        if (access === "http") broker?.setNodePollInterval?.(node, pollIntervalMin);
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
        const { presets } = agentTemplates();
        const choice = access === "http"
          ? resolveHttpOnboardingChoice({
            template: reqUrl.searchParams.get("template"),
            receive: reqUrl.searchParams.get("receive"),
            templateId: reqUrl.searchParams.get("template_id"),
            presets,
          })
          : { template: "generic", receive: "poll", templateId: "" };
        const pollIntervalMin = reqUrl.searchParams.has("poll_interval_min")
          ? validatePollIntervalMin(reqUrl.searchParams.get("poll_interval_min"), choice.receive)
          : undefined;
        const onboarding = buildOnboarding({
          hubUrl: requestHubUrl(req),
          node,
          access,
          role,
          authRequired: Boolean(apiToken) || Boolean(tokenStore?.hasAny()),
          receive: choice.receive,
          pollIntervalMin,
          template: choice.template,
          templateId: choice.templateId,
          presets,
        });
        sendJson(res, 200, { onboarding });
        return;
      }

      if (method === "GET" && pathname === "/api/v1/admin/tokens") {
        sendJson(res, 200, { tokens: tokenStore ? tokenStore.listPublic() : [] });
        return;
      }

      // 名录变更只追加。Agent 身份在 assertAgentRoute 已被拒绝，这里只对机主和 open 开放。
      if (method === "GET" && pathname === "/api/v1/admin/audit") {
        const logs = typeof bus.listAuditLogs === "function"
          ? bus.listAuditLogs({
            table: String(reqUrl.searchParams.get("table") ?? "").trim(),
            node: String(reqUrl.searchParams.get("node") ?? "").trim(),
            limit: reqUrl.searchParams.get("limit"),
          })
          : [];
        sendJson(res, 200, { logs });
        return;
      }

      const rotateTokenMatch = pathname.match(/^\/api\/v1\/admin\/tokens\/([^/]+)\/rotate$/);
      if (method === "POST" && rotateTokenMatch) {
        if (!tokenStore) throw httpError(500, "未配置 configDir，无法管理 Agent Token");
        if (!apiToken) throw httpError(400, "请先在 node.json 配置机主 apiToken，再签发 Agent Token");
        const node = validateNodeName(decodeParam(rotateTokenMatch[1]));
        const body = await readJsonBodyBound();
        const existing = tokenStore.get(node);
        const cards = bus?.tables?.agentCards ? await bus.listRecords(bus.tables.agentCards) : [];
        let role = Object.hasOwn(body, "role") ? body.role : existing?.role;
        // 吊销后再点「生成密钥」或历史节点首次签发时，若调用方未显式传 role，则从该节点已有名片的 Metadata.role 推导。
        if (!role) {
          let inferred = "";
          for (const card of cards) {
            if (f1(card, "Node") !== node) continue;
            const cardRole = parseCardMetadata(card).role;
            if (cardRole === "leader" || cardRole === "hybrid") {
              inferred = "leader";
              break;
            }
            if (cardRole === "worker") inferred = "worker";
          }
          if (inferred) role = inferred;
        }
        const scopes = Object.hasOwn(body, "scopes") ? body.scopes : undefined;
        const issued = tokenStore.rotate({ node, role, scopes });
        const { presets } = agentTemplates();
        // 节点模板 id 优先于粗 template：WorkBuddy 和通用的粗分类都是 generic，只靠后者会生成同一段提示词。
        let templateId = "";
        if (Object.hasOwn(body, "template_id") && String(body.template_id ?? "").trim()) {
          templateId = templatePresetById(body.template_id, presets).id;
        } else {
          for (const card of cards) {
            if (f1(card, "Node") !== node) continue;
            const id = knownTemplateId(parseCardMetadata(card).template_id, presets);
            if (id) { templateId = id; break; }
          }
        }
        let templateFromCard = "";
        for (const card of cards) {
          if (f1(card, "Node") !== node) continue;
          const t = parseCardMetadata(card).template;
          if (t) { templateFromCard = t; break; }
        }
        let template = "generic";
        if (Object.hasOwn(body, "template")) template = validateTemplate(body.template);
        else if (templateFromCard) template = validateTemplate(templateFromCard);
        const storedReceive = nodeStoredReceiveMode(cards, node);
        let receive = storedReceive === "http-longpoll" ? "longpoll" : (storedReceive === "webhook" ? "webhook" : "poll");
        if (templateId && !Object.hasOwn(body, "template")) {
          const preset = templatePresetById(templateId, presets);
          // 名片接收方式已经和建单时的模板不一致时，不再套用那套提示词。
          if (!storedReceive || preset.receive === receive) {
            template = preset.template;
            receive = preset.receive;
          } else {
            templateId = "";
          }
        }
        if (!templateId) templateId = inferTemplateId(template, receive, presets);
        receive = receiveForTemplate(template, receive);
        let pollIntervalMin = null;
        for (const card of cards) {
          if (f1(card, "Node") !== node) continue;
          const stored = parseCardMetadata(card).poll_interval_min;
          if (!stored) continue;
          pollIntervalMin = stored;
          if (f1(card, "Receive_Mode") === storedReceive) break;
        }
        const onboarding = buildOnboarding({
          hubUrl: requestHubUrl(req),
          node,
          access: "http",
          role: issued.role,
          authRequired: true,
          token: issued.token,
          receive,
          pollIntervalMin,
          template,
          templateId,
          presets,
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
            throw httpError(409, "该节点的接收方式不是 Webhook，不能登记推送");
          }
          const body = await readJsonBodyBound();
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw httpError(400, "请求体必须是 JSON 对象");
          }
          const url = validateWebhookUrl(body.url);
          const saved = webhooks.store.put({
            node,
            url,
            key: body.key ?? body.webhook_key,
            header: body.header ?? body.webhook_header,
          });
          sendJson(res, 200, { ok: true, webhook: publicWebhook(saved.hook) });
          return;
        }
      }

      sendJson(res, 404, { error: "Not Found" });
    } catch (e) {
      const status = Number(e?.status) || 400;
      if (!res.writableEnded) {
        if (status === 413 && !req.readableEnded) res.setHeader("Connection", "close");
        sendJson(res, status, { error: e?.message ?? String(e) });
      }
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

  try {
    const seeded = loadAgentTemplates(cfg?.configDir || "", { writeIfMissing: Boolean(cfg?.configDir) });
    for (const err of seeded.errors) log(err);
  } catch (e) {
    log("节点模板初始化失败：" + (e?.message ?? e));
  }

  log(`Hub HTTP & Web 控制台已启动：http://${host}:${boundPort} （本机访问：${localUrl}）`);

  return {
    server,
    host,
    port: boundPort,
    localUrl,
    fileStore: activeFileStore,
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
      ownFileStore?.close?.();
    },
  };
}
