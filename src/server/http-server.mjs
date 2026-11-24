// Hub 统一 HTTP 网关（REST + Longpoll + Web 控制台静态资源）。
// 所有业务状态写入都经由 TaskService / HubStore 单事务落库，并在提交后唤醒挂起的长轮询连接。

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import {
  DAEMON_VERSION,
  KNOWN_CLIS,
  detectDefaultModel,
  discoverLocalWorkers,
  loadAppEnv,
  loadWorkersJson,
  mergeDiscoveredWorkers,
  resolveSpecBinary,
  sanitizeSlug,
  saveWorkersJson,
  writeLockedAppEnvVars,
} from "../core/config.mjs";
import { shellQuote } from "../core/receipt.mjs";
import {
  MCP_PROTOCOL_VERSION,
  handleMcpRpcMessage,
  resolveMcpActorContext,
} from "../core/mcp-server.mjs";
import {
  buildAgentMcpOnboarding,
  buildAgentOnboardingPrompt,
  buildDeviceJoinCommands,
  findTemplate,
  loadAgentTemplates,
} from "../core/templates.mjs";
import { validateWebhookUrl } from "../core/webhooks.mjs";
import {
  actorCanControlTaskAsSender,
  actorCanOperateTaskAsWorker,
  actorCanSeeTask,
  buildSetSessionCookieHeader,
  checkSpoofedHeader,
  createSessionCookieValue,
  deviceOwnsAgent,
  resolveRequestActor,
  timingSafeEqualStr,
} from "./auth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WEB_ROOT = path.resolve(REPO_ROOT, "src", "web");
const SKILLS_ROOT = path.resolve(REPO_ROOT, "skills");

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const COMPRESSIBLE_EXTS = new Set([".html", ".css", ".js", ".mjs", ".json", ".svg"]);
const GZIP_MIN_BYTES = 1024;

function acceptsGzip(res) {
  return /\bgzip\b/i.test(String(res?._acceptEncoding || ""));
}

function sendJson(res, status, data, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(data);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  };
  if (body.length >= GZIP_MIN_BYTES && acceptsGzip(res)) {
    const gz = zlib.gzipSync(Buffer.from(body, "utf8"), { level: 6 });
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
    headers["Content-Length"] = gz.byteLength;
    res.writeHead(status, headers);
    res.end(gz);
    return;
  }
  res.writeHead(status, headers);
  res.end(body);
}

function sendError(res, status, message, code = "error") {
  sendJson(res, status, { ok: false, error: code, message });
}

function readRawBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const err = new Error("请求体过大");
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const buf = await readRawBody(req, MAX_JSON_BODY_BYTES);
  const raw = buf.toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      const err = new Error("请求体必须是 JSON 对象");
      err.statusCode = 400;
      throw err;
    }
    return parsed;
  } catch (err) {
    if (err.statusCode) throw err;
    const parseErr = new Error("JSON 解析失败");
    parseErr.statusCode = 400;
    throw parseErr;
  }
}

function serveStaticFile(res, rootDir, relPath) {
  const safeRel = String(relPath || "").replace(/^\/+/, "");
  const fullPath = path.resolve(rootDir, safeRel);
  if (!fullPath.startsWith(rootDir + path.sep) && fullPath !== rootDir) {
    sendError(res, 403, "Forbidden", "forbidden");
    return;
  }
  let stat;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }
  const ext = path.extname(fullPath).toLowerCase();
  const contentType = MIME_BY_EXT[ext] || "application/octet-stream";
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  };
  if (COMPRESSIBLE_EXTS.has(ext) && stat.size >= GZIP_MIN_BYTES && acceptsGzip(res)) {
    const gz = zlib.gzipSync(fs.readFileSync(fullPath), { level: 6 });
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
    headers["Content-Length"] = gz.byteLength;
    res.writeHead(200, headers);
    res.end(gz);
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(fullPath).pipe(res);
}

export function startHubHttpServer({
  configDir,
  hubDeviceId = "",
  store,
  taskService,
  broker,
  fileStore,
  webhooks,
  notifier,
  schedules,
  approvalPublicKey = "",
  approvalPrivateKey = null,
  ownerToken = "",
  listen = "0.0.0.0:8787",
  hubUrlResolver = null,
} = {}) {
  const getOwnerToken = () => (typeof ownerToken === "function" ? ownerToken() : String(ownerToken || ""));
  const getHubUrl = () => {
    if (typeof hubUrlResolver === "function") return String(hubUrlResolver() || "");
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 8787;
    return `http://127.0.0.1:${port}`;
  };

  function enrichStateSnapshot(now = Date.now()) {
    const devicesRaw = store.listDevices();
    const agentsRaw = store.listAgents();
    const devMap = new Map(devicesRaw.map((d) => [d.id, d]));
    const localWorkerMap = new Map(
      (loadWorkersJson(configDir) || []).filter((w) => w && w.key).map((w) => [String(w.key), w])
    );

    const devices = devicesRaw.map((d) => {
      const devAgents = agentsRaw.filter((a) => a.device_id === d.id);
      return {
        ...d,
        is_local: Boolean(hubDeviceId && d.id === hubDeviceId),
        online: broker.isDeviceOnline(d, now),
        connected: broker.isDeviceConnected(d.id),
        worker_count: devAgents.length,
        active_count: devAgents.filter((a) => Boolean(a.active_task_id)).length,
      };
    });

    const agents = agentsRaw.map((a) => {
      const dev = a.device_id ? devMap.get(a.device_id) : null;
      const isLocalWorker = Boolean(hubDeviceId && a.kind === "device-worker" && a.device_id === hubDeviceId);
      const localCfg = isLocalWorker ? localWorkerMap.get(a.worker_key) : null;
      return {
        ...a,
        device_name: dev?.name || "",
        is_local_worker: isLocalWorker,
        ...(localCfg
          ? {
              worker_config: {
                command: localCfg.command || "",
                resume_command: localCfg.resume_command || "",
                cwd: localCfg.cwd || "",
                model_flag: localCfg.model_flag || "",
                timeout_sec: Number(localCfg.timeout_sec || 600),
              },
            }
          : {}),
        online: broker.isAgentOnline(a, devMap, now),
        connected: a.kind === "device-worker" && a.device_id ? broker.isDeviceConnected(a.device_id) : broker.isAgentConnected(a.id),
      };
    });

    const tasks = store.listTasks({ limit: 300, summaryOnly: true });
    const threads = taskService.listThreads({ limit: 80, includeTasks: false });
    const pendingActions = tasks.filter((t) => t.state === "auth-required" || t.state === "input-required").map((t) => ({
      ...t,
      messages: store.listMessages(t.id),
    }));
    const scheduleList = schedules ? schedules.listWithStatus(null, now) : [];

    return {
      seq: broker.currentSeq(),
      version: DAEMON_VERSION,
      hub_url: getHubUrl(),
      hub_device_id: hubDeviceId,
      public_key: approvalPublicKey,
      auth_required: Boolean(getOwnerToken()),
      notifier: notifier ? notifier.configuredChannels() : {},
      devices,
      agents,
      tasks,
      threads,
      pending_actions: pendingActions,
      schedules: scheduleList,
    };
  }

  function formatAgentsPublicList(actor, now = Date.now()) {
    const devicesRaw = store.listDevices();
    const devMap = new Map(devicesRaw.map((d) => [d.id, d]));
    return store.listAgents().map((a) => {
      const dev = a.device_id ? devMap.get(a.device_id) : null;
      const base = {
        id: a.id,
        kind: a.kind,
        device_id: a.device_id,
        device_name: dev?.name || "",
        worker_key: a.worker_key,
        name: a.name,
        role: a.role,
        platform: a.platform,
        summary: a.summary,
        skills: a.skills,
        tools: a.tools,
        models: a.models,
        default_model: a.default_model,
        transport: a.transport,
        enabled: a.enabled,
        online: broker.isAgentOnline(a, devMap, now),
        active_task_id: a.active_task_id,
        last_seen_at: a.last_seen_at,
      };
      if (actor.kind === "owner") {
        return {
          ...a,
          device_name: dev?.name || "",
          online: base.online,
        };
      }
      return base;
    });
  }

  async function handleApi(req, res, url) {
    const method = req.method || "GET";
    const pathname = url.pathname;
    const curOwnerToken = getOwnerToken();

    // ---- 1. 免鉴权探针与会话状态检查 ----
    if (method === "GET" && pathname === "/api/v1/health") {
      return sendJson(res, 200, {
        ok: true,
        version: DAEMON_VERSION,
        seq: broker.currentSeq(),
        auth_required: Boolean(curOwnerToken),
      });
    }

    if (method === "GET" && pathname === "/.well-known/agent.json") {
      return sendJson(res, 200, {
        name: "a2a-hub",
        version: DAEMON_VERSION,
        protocol: "a2a-hub-v2",
        approval_public_key: approvalPublicKey,
        auth_required: Boolean(curOwnerToken),
      });
    }

    if (method === "GET" && pathname === "/api/v1/auth/session") {
      const actor = resolveRequestActor(req, {
        ownerToken: curOwnerToken,
        store,
        approvalPrivateKey,
      });
      return sendJson(res, 200, {
        ok: true,
        authenticated: actor.authenticated && actor.kind === "owner",
        auth_required: Boolean(curOwnerToken),
        actor_kind: actor.kind,
      });
    }

    if (method === "POST" && pathname === "/api/v1/auth/login") {
      if (!curOwnerToken) {
        return sendJson(res, 200, { ok: true, authenticated: true, open: true });
      }
      const body = await readJsonBody(req);
      const token = String(body.token || "").trim();
      if (!token || !timingSafeEqualStr(token, curOwnerToken)) {
        return sendError(res, 401, "机主密钥不正确", "invalid_credentials");
      }
      const cookieVal = createSessionCookieValue(curOwnerToken, approvalPrivateKey);
      return sendJson(
        res,
        200,
        { ok: true, authenticated: true },
        { "Set-Cookie": buildSetSessionCookieHeader(req, cookieVal) }
      );
    }

    if (method === "POST" && pathname === "/api/v1/auth/logout") {
      return sendJson(
        res,
        200,
        { ok: true },
        { "Set-Cookie": buildSetSessionCookieHeader(req, "", { clear: true }) }
      );
    }

    // ---- 2. 全局鉴权与防冒充校验 ----
    const actor = resolveRequestActor(req, {
      ownerToken: curOwnerToken,
      store,
      approvalPrivateKey,
      allowQueryToken: pathname === "/api/v1/mcp",
    });
    if (!actor.authenticated) {
      return sendError(res, 401, actor.invalidToken ? "无效的访问令牌" : "未登录或缺少 Bearer Token", "unauthorized");
    }
    const spoofErr = checkSpoofedHeader(req, actor);
    if (spoofErr) {
      return sendError(res, 403, spoofErr, "impersonation_forbidden");
    }

    const requireOwner = () => {
      if (actor.kind !== "owner") {
        sendError(res, 403, "仅机主可访问此接口", "owner_required");
        return false;
      }
      return true;
    };

    // ---- 2.5 原生 Streamable HTTP MCP 网关入口 (JSON-RPC 2.0) ----
    if (pathname === "/api/v1/mcp") {
      const requestedAgentId = req.headers["x-a2a-node"] || url.searchParams.get("agent") || "";
      const requestedRole = req.headers["x-a2a-role"] || url.searchParams.get("role") || "";
      const mcpCtx = resolveMcpActorContext(actor, store, {
        requestedAgentId,
        requestedRole,
      });

      if (method === "GET") {
        const accept = String(req.headers.accept || "").toLowerCase();
        // 按 MCP Streamable HTTP 规范：无状态网关不提供下行 SSE 事件流时，
        // 对明确请求 text/event-stream 的 GET 必须返回 405，避免客户端（如 Gemini 桌面端 Swift SDK）每 3s 无限重连。
        if (accept.includes("text/event-stream") && !accept.includes("application/json")) {
          res.writeHead(405, {
            Allow: "POST, DELETE",
            "Cache-Control": "no-store",
          });
          res.end();
          return;
        }
        return sendJson(res, 200, {
          ok: true,
          protocol: "mcp",
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: { name: "a2a-hub", version: DAEMON_VERSION },
          actor: {
            kind: mcpCtx.actorKind,
            agent_id: mcpCtx.agentId,
            role: mcpCtx.role,
          },
        });
      }

      if (method === "DELETE") {
        return sendJson(res, 200, { ok: true });
      }

      if (method !== "POST") {
        res.writeHead(405, {
          Allow: "GET, POST, DELETE",
          "Cache-Control": "no-store",
        });
        res.end();
        return;
      }

      if (method === "POST") {
        const buf = await readRawBody(req, MAX_JSON_BODY_BYTES);
        const raw = buf.toString("utf8").trim();
        let rpcPayload;
        try {
          rpcPayload = raw ? JSON.parse(raw) : null;
        } catch {
          return sendJson(res, 200, {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          });
        }
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        req.once("close", onAbort);
        let rpcRes;
        try {
          rpcRes = await handleMcpRpcMessage(rpcPayload, {
            ...mcpCtx,
            store,
            taskService,
            broker,
            formatAgentsPublicList,
            signal: ac.signal,
          });
        } finally {
          req.off("close", onAbort);
        }
        if (ac.signal.aborted || res.destroyed || res.writableEnded) return;
        if (rpcRes === null) {
          res.writeHead(202, { "Cache-Control": "no-store" });
          res.end();
          return;
        }
        return sendJson(res, 200, rpcRes);
      }
    }

    // ---- 3. Web 控制台状态与长轮询 ----
    if (method === "GET" && pathname === "/api/v1/state") {
      if (!requireOwner()) return;
      return sendJson(res, 200, { ok: true, ...enrichStateSnapshot() });
    }

    if (method === "GET" && pathname === "/api/v1/poll") {
      if (!requireOwner()) return;
      const since = Number(url.searchParams.get("since") || 0);
      const timeout = Number(url.searchParams.get("timeout") || 30);
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      req.once("close", onAbort);
      let resWait;
      try {
        resWait = await broker.waitForChange({
          scope: "web",
          sinceSeq: since,
          timeoutSec: timeout,
          signal: ac.signal,
        });
      } finally {
        req.off("close", onAbort);
      }
      if (resWait.aborted || ac.signal.aborted || res.destroyed || res.writableEnded) return;
      return sendJson(res, 200, { ok: true, ...resWait });
    }

    // ---- 4. Skills 与脚本套件 ----
    if (method === "GET" && pathname === "/api/v1/skills") {
      const names = ["ah", "ah-inbox", "a2a-leader", "a2a-worker"].filter((n) =>
        fs.existsSync(path.join(SKILLS_ROOT, n, "SKILL.md"))
      );
      return sendJson(res, 200, { ok: true, skills: names });
    }

    let m = /^\/api\/v1\/skills\/([A-Za-z0-9._-]+)$/.exec(pathname);
    if (method === "GET" && m) {
      const skillFile = path.resolve(SKILLS_ROOT, m[1], "SKILL.md");
      if (!skillFile.startsWith(SKILLS_ROOT + path.sep) || !fs.existsSync(skillFile)) {
        return sendError(res, 404, "Skill 不存在", "not_found");
      }
      const md = fs.readFileSync(skillFile, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(md);
      return;
    }

    m = /^\/api\/v1\/kit\/(a2a_check\.(?:py|sh))$/.exec(pathname);
    if (method === "GET" && m) {
      const kitPath = path.resolve(SKILLS_ROOT, "a2a-check", m[1]);
      if (!kitPath.startsWith(SKILLS_ROOT + path.sep) || !fs.existsSync(kitPath)) {
        return sendError(res, 404, "脚本不存在", "not_found");
      }
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(fs.readFileSync(kitPath, "utf8"));
      return;
    }

    // ---- 5. Templates & Settings & Notifier（仅机主） ----
    if (method === "GET" && pathname === "/api/v1/templates") {
      if (!requireOwner()) return;
      return sendJson(res, 200, { ok: true, templates: loadAgentTemplates(configDir) });
    }

    if (method === "GET" && pathname === "/api/v1/schedules") {
      if (!requireOwner()) return;
      return sendJson(res, 200, { ok: true, schedules: schedules ? schedules.listWithStatus() : [] });
    }

    if (method === "GET" && pathname === "/api/v1/admin/settings") {
      if (!requireOwner()) return;
      const appEnv = loadAppEnv(configDir);
      return sendJson(res, 200, {
        ok: true,
        hub_url: getHubUrl(),
        public_key: approvalPublicKey,
        auth_required: Boolean(curOwnerToken),
        notifier: {
          feishu_webhook: appEnv.AH_FEISHU_WEBHOOK || "",
          bark_url: appEnv.AH_BARK_URL || "",
          telegram_bot_token_set: Boolean(appEnv.AH_TELEGRAM_BOT_TOKEN),
          telegram_chat_id: appEnv.AH_TELEGRAM_CHAT_ID || "",
          notify_webhook: appEnv.AH_NOTIFY_WEBHOOK || "",
          notify_on: appEnv.AH_NOTIFY_ON || "action",
        },
      });
    }

    if (method === "POST" && pathname === "/api/v1/admin/settings") {
      if (!requireOwner()) return;
      const body = await readJsonBody(req);
      const updates = {};
      if (body.feishu_webhook !== undefined) updates.AH_FEISHU_WEBHOOK = String(body.feishu_webhook || "").trim();
      if (body.bark_url !== undefined) updates.AH_BARK_URL = String(body.bark_url || "").trim();
      if (body.telegram_bot_token !== undefined && body.telegram_bot_token !== "") {
        updates.AH_TELEGRAM_BOT_TOKEN = String(body.telegram_bot_token).trim();
      }
      if (body.telegram_chat_id !== undefined) updates.AH_TELEGRAM_CHAT_ID = String(body.telegram_chat_id || "").trim();
      if (body.notify_webhook !== undefined) updates.AH_NOTIFY_WEBHOOK = String(body.notify_webhook || "").trim();
      if (body.notify_on !== undefined) updates.AH_NOTIFY_ON = body.notify_on === "all" ? "all" : "action";
      if (body.public_url !== undefined) updates.AH_PUBLIC_URL = String(body.public_url || "").trim().replace(/\/+$/, "");

      for (const k of ["AH_FEISHU_WEBHOOK", "AH_BARK_URL", "AH_NOTIFY_WEBHOOK", "AH_PUBLIC_URL"]) {
        if (updates[k]) {
          const chk = validateWebhookUrl(updates[k]);
          if (!chk.ok) return sendError(res, 400, `${k}: ${chk.error}`, "invalid_url");
        }
      }

      writeLockedAppEnvVars(configDir, updates);
      if (notifier) notifier.updateEnv(updates);
      return sendJson(res, 200, { ok: true, notifier: notifier ? notifier.configuredChannels() : {} });
    }

    if (method === "POST" && pathname === "/api/v1/admin/notifier-test") {
      if (!requireOwner()) return;
      if (!notifier) return sendError(res, 400, "Notifier 未初始化", "no_notifier");
      const r = await notifier.sendAlert({
        title: "a2a-hub · 通知测试",
        body: "如果你收到这条消息，说明机主推送通道配置成功。",
        link: getHubUrl(),
      });
      return sendJson(res, 200, { ok: true, result: r });
    }

    // ---- 6. 电脑设备 Device 接口 ----
    if (method === "GET" && pathname === "/api/v1/devices") {
      if (!requireOwner()) return;
      const now = Date.now();
      const devices = store.listDevices().map((d) => ({
        ...d,
        online: broker.isDeviceOnline(d, now),
        connected: broker.isDeviceConnected(d.id),
      }));
      return sendJson(res, 200, { ok: true, devices });
    }

    if (method === "POST" && pathname === "/api/v1/devices") {
      if (!requireOwner()) return;
      const body = await readJsonBody(req);
      const name = String(body.name || body.id || "").trim();
      if (!name) return sendError(res, 400, "请填写设备名称 name", "missing_name");
      const id = sanitizeSlug(body.id || name, "device");
      const { device, token } = store.upsertDevice({
        id,
        name,
        platform: String(body.platform || ""),
        os_info: String(body.os_info || ""),
        transport: body.transport === "poll" ? "poll" : "longpoll",
        poll_interval_min: Number(body.poll_interval_min || 5),
        max_concurrent: Number(body.max_concurrent || 4),
        summary: String(body.summary || ""),
        note: String(body.note || ""),
        enabled: true,
        issueToken: true,
      });
      const join_commands = buildDeviceJoinCommands({
        hubUrl: getHubUrl(),
        deviceToken: token,
        deviceId: device.id,
      });
      return sendJson(res, 201, {
        ok: true,
        device,
        token,
        hub_url: getHubUrl(),
        join_command: join_commands.unix,
        join_commands,
      });
    }

    m = /^\/api\/v1\/devices\/([A-Za-z0-9._-]+)$/.exec(pathname);
    if (m) {
      if (!requireOwner()) return;
      const devId = m[1];
      if (method === "PATCH") {
        const body = await readJsonBody(req);
        const updated = store.updateDevice(devId, body);
        if (!updated) return sendError(res, 404, "设备不存在", "not_found");
        return sendJson(res, 200, { ok: true, device: updated });
      }
      if (method === "DELETE") {
        const ok = store.deleteDevice(devId);
        if (!ok) return sendError(res, 404, "设备不存在", "not_found");
        return sendJson(res, 200, { ok: true });
      }
    }

    m = /^\/api\/v1\/devices\/([A-Za-z0-9._-]+)\/rotate-token$/.exec(pathname);
    if (method === "POST" && m) {
      if (!requireOwner()) return;
      const rotated = store.rotateDeviceToken(m[1]);
      if (!rotated) return sendError(res, 404, "设备不存在", "not_found");
      const join_commands = buildDeviceJoinCommands({
        hubUrl: getHubUrl(),
        deviceToken: rotated.token,
        deviceId: rotated.device.id,
      });
      return sendJson(res, 200, { ok: true, ...rotated, join_command: join_commands.unix, join_commands });
    }

    if (method === "GET" && pathname === "/api/v1/worker-presets") {
      if (!requireOwner()) return;
      const presets = KNOWN_CLIS.map((spec) => {
        const binPath = resolveSpecBinary(spec) || "";
        const detected = detectDefaultModel(spec.key);
        const binExpr = binPath || spec.bin;
        return {
          key: spec.key,
          name: spec.name,
          platform: spec.platform,
          summary: spec.summary,
          skills: spec.skills,
          tools: spec.tools,
          models: spec.defaultModels,
          default_model: detected || spec.defaultModels?.[0] || "",
          model_flag: spec.modelFlag,
          command: spec.command.replace(/\{bin\}/g, binExpr),
          resume_command: spec.resumeCommand ? spec.resumeCommand.replace(/\{bin\}/g, binExpr) : "",
          timeout_sec: spec.timeoutSec,
          approval_policy: spec.approvalPolicy,
          installed: Boolean(binPath),
        };
      }).sort((a, b) => Number(b.installed) - Number(a.installed));
      return sendJson(res, 200, { ok: true, presets });
    }

    m = /^\/api\/v1\/devices\/([A-Za-z0-9._-]+)\/workers\/scan$/.exec(pathname);
    if (method === "POST" && m) {
      if (!requireOwner()) return;
      const devId = m[1];
      const dev = store.getDevice(devId);
      if (!dev) return sendError(res, 404, "设备不存在", "not_found");

      const body = await readJsonBody(req);
      if (hubDeviceId && devId === hubDeviceId) {
        const discovered = discoverLocalWorkers();
        const existing = loadWorkersJson(configDir);
        const merged = mergeDiscoveredWorkers(existing, discovered, { force: Boolean(body.force) });
        if (merged.added.length || merged.updated.length || !fs.existsSync(path.join(configDir, "workers.json"))) {
          saveWorkersJson(configDir, merged.workers);
        }
        const synced = store.syncDeviceWorkers(devId, merged.workers, {});
        return sendJson(res, 200, {
          ok: true,
          local: true,
          discovered_count: discovered.length,
          added: merged.added.map((w) => w.key),
          updated: merged.updated.map((w) => w.key),
          total: merged.workers.length,
          ...synced,
        });
      }

      return sendJson(res, 200, {
        ok: true,
        local: false,
        cli_command: "ah workers scan",
      });
    }

    m = /^\/api\/v1\/devices\/([A-Za-z0-9._-]+)\/workers$/.exec(pathname);
    if (method === "POST" && m) {
      if (!requireOwner()) return;
      const devId = m[1];
      const dev = store.getDevice(devId);
      if (!dev) return sendError(res, 404, "设备不存在", "not_found");

      const body = await readJsonBody(req);
      const name = String(body.name || body.key || "").trim();
      const command = String(body.command || "").trim();
      const key = sanitizeSlug(body.key || name, "");
      if (!key) return sendError(res, 400, "请填写有效的 Worker Key（英文标识）", "missing_key");
      if (!name) return sendError(res, 400, "请填写 Worker 名称", "missing_name");
      if (!command) return sendError(res, 400, "请填写可执行命令 command", "missing_command");

      const skills = Array.isArray(body.skills)
        ? body.skills.map((s) => String(s).trim()).filter(Boolean)
        : String(body.skills || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
      const workerObj = {
        key,
        name,
        role: body.role === "leader" ? "leader" : "worker",
        platform: String(body.platform || "cli").trim() || "cli",
        summary: String(body.summary || "").trim(),
        skills,
        tools: Array.isArray(body.tools) ? body.tools.map((s) => String(s).trim()).filter(Boolean) : [],
        models: Array.isArray(body.models) ? body.models.map((s) => String(s).trim()).filter(Boolean) : [],
        default_model: String(body.default_model || "").trim(),
        model_flag: String(body.model_flag || "").trim(),
        command,
        resume_command: String(body.resume_command || "").trim(),
        cwd: String(body.cwd || "").trim() || "~",
        timeout_sec: Math.min(Math.max(Number(body.timeout_sec || 600) || 600, 10), 3600),
        approval_policy: ["never", "always", "risk"].includes(body.approval_policy) ? body.approval_policy : "never",
        enabled: true,
      };

      if (hubDeviceId && devId === hubDeviceId) {
        const workers = loadWorkersJson(configDir);
        const idx = workers.findIndex((w) => w && w.key === key);
        if (idx >= 0) workers[idx] = { ...workers[idx], ...workerObj };
        else workers.push(workerObj);
        saveWorkersJson(configDir, workers);
        const synced = store.syncDeviceWorkers(devId, workers, {});
        return sendJson(res, 201, {
          ok: true,
          local: true,
          worker: workerObj,
          ...synced,
        });
      }

      const cliParts = [
        "ah workers add",
        `--key ${shellQuote(workerObj.key)}`,
        `--name ${shellQuote(workerObj.name)}`,
        `--command ${shellQuote(workerObj.command)}`,
      ];
      if (workerObj.resume_command) cliParts.push(`--resume ${shellQuote(workerObj.resume_command)}`);
      if (workerObj.cwd && workerObj.cwd !== "~") cliParts.push(`--cwd ${shellQuote(workerObj.cwd)}`);
      if (workerObj.summary) cliParts.push(`--summary ${shellQuote(workerObj.summary)}`);
      if (workerObj.default_model) cliParts.push(`--model ${shellQuote(workerObj.default_model)}`);
      if (workerObj.model_flag) cliParts.push(`--model-flag ${shellQuote(workerObj.model_flag)}`);
      if (workerObj.skills.length) cliParts.push(`--skills ${shellQuote(workerObj.skills.join(","))}`);
      if (workerObj.approval_policy !== "never") cliParts.push(`--approval ${shellQuote(workerObj.approval_policy)}`);

      return sendJson(res, 200, {
        ok: true,
        local: false,
        worker: workerObj,
        cli_command: cliParts.join(" "),
      });
    }

    m = /^\/api\/v1\/devices\/([A-Za-z0-9._-]+)\/sync$/.exec(pathname);
    if (method === "POST" && m) {
      const devId = m[1];
      if (actor.kind !== "owner" && (actor.kind !== "device" || actor.id !== devId)) {
        return sendError(res, 403, "无权同步其他设备", "forbidden");
      }
      const body = await readJsonBody(req);
      const isLocalHubDevice = Boolean(hubDeviceId && devId === hubDeviceId && fs.existsSync(path.join(configDir, "workers.json")));
      const workers = isLocalHubDevice
        ? loadWorkersJson(configDir)
        : Array.isArray(body.workers)
          ? body.workers
          : [];
      const synced = store.syncDeviceWorkers(devId, workers, {
        platform: body.platform,
        os_info: body.os_info,
        transport: body.transport || "longpoll",
        max_concurrent: body.max_concurrent,
      });
      if (!synced) return sendError(res, 404, "设备不存在", "not_found");
      return sendJson(res, 200, {
        ok: true,
        ...synced,
        approval_public_key: approvalPublicKey,
      });
    }

    m = /^\/api\/v1\/devices\/([A-Za-z0-9._-]+)\/poll$/.exec(pathname);
    if (method === "GET" && m) {
      const devId = m[1];
      if (actor.kind !== "owner" && (actor.kind !== "device" || actor.id !== devId)) {
        return sendError(res, 403, "无权轮询其他设备", "forbidden");
      }
      const dev = store.getDevice(devId);
      if (!dev) return sendError(res, 404, "设备不存在", "not_found");
      store.touchDeviceSeen(devId);
      const since = Number(url.searchParams.get("since") || 0);
      const timeout = Number(url.searchParams.get("timeout") || 30);
      if (!dev.enabled) {
        return sendJson(res, 200, {
          ok: true,
          seq: broker.currentSeq(),
          woke: false,
          paused: true,
          pending_count: 0,
          tasks: [],
        });
      }
      const devAgents = store.listAgents({ device_id: devId });
      const enabledIds = devAgents.filter((a) => a.enabled).map((a) => a.id);
      const allIds = devAgents.map((a) => a.id);

      const pendingNow = enabledIds.length
        ? store.listTasks({ to_agent_ids: enabledIds, state: "submitted", order: "asc", limit: 50 })
        : [];
      if (pendingNow.length > 0 || timeout <= 0) {
        return sendJson(res, 200, {
          ok: true,
          seq: broker.currentSeq(),
          woke: pendingNow.length > 0,
          pending_count: pendingNow.length,
          tasks: pendingNow,
        });
      }

      const ac = new AbortController();
      const onAbort = () => ac.abort();
      req.once("close", onAbort);
      let waitRes;
      try {
        waitRes = await broker.waitForChange({
          scope: "device",
          sinceSeq: since,
          timeoutSec: timeout,
          deviceId: devId,
          agentIds: allIds,
          signal: ac.signal,
        });
      } finally {
        req.off("close", onAbort);
      }
      if (waitRes.aborted || ac.signal.aborted || res.destroyed || res.writableEnded) return;
      store.touchDeviceSeen(devId);
      const devAgentsAfter = store.listAgents({ device_id: devId });
      const enabledAfter = devAgentsAfter.filter((a) => a.enabled).map((a) => a.id);
      const tasksAfter = enabledAfter.length
        ? store.listTasks({ to_agent_ids: enabledAfter, state: "submitted", order: "asc", limit: 50 })
        : [];
      return sendJson(res, 200, {
        ok: true,
        ...waitRes,
        pending_count: tasksAfter.length,
        tasks: tasksAfter,
      });
    }

    // ---- 7. Agent 管理与协议接口 ----
    if (method === "GET" && pathname === "/api/v1/agents") {
      return sendJson(res, 200, { ok: true, agents: formatAgentsPublicList(actor) });
    }

    if (method === "POST" && pathname === "/api/v1/agents") {
      if (!requireOwner()) return;
      const body = await readJsonBody(req);
      const name = String(body.name || body.id || "").trim();
      if (!name) return sendError(res, 400, "请填写 Agent 名称 name", "missing_name");
      const platform = String(body.platform || "generic-poll").trim();
      const tpl = findTemplate(configDir, platform);
      const id = sanitizeSlug(body.id || name, "agent");
      const webhookUrl = String(body.webhook_url || "").trim();
      if (webhookUrl) {
        const chk = validateWebhookUrl(webhookUrl);
        if (!chk.ok) return sendError(res, 400, chk.error, "invalid_webhook_url");
      }

      const { agent, token } = store.createAgent({
        id,
        kind: body.kind === "independent" ? "independent" : "cloud",
        name,
        role: body.role || tpl.role || "worker",
        platform: tpl.id,
        summary: String(body.summary || tpl.summary_hint || ""),
        note: String(body.note || ""),
        skills: Array.isArray(body.skills) ? body.skills : [],
        tools: Array.isArray(body.tools) ? body.tools : [],
        models: Array.isArray(body.models) ? body.models : [],
        default_model: String(body.default_model || ""),
        approval_policy: ["never", "always", "risk"].includes(body.approval_policy) ? body.approval_policy : "never",
        transport: body.transport || tpl.transport || "poll",
        poll_interval_min: Number(body.poll_interval_min || tpl.poll_interval_min || 5),
        webhook_url: webhookUrl,
        webhook_secret: String(body.webhook_secret || ""),
        webhook_header: String(body.webhook_header || tpl.webhook_header || "X-A2A-Signature"),
        enabled: body.enabled !== undefined ? Boolean(body.enabled) : true,
        issueToken: true,
      });

      const onboarding_prompt = buildAgentOnboardingPrompt({
        hubUrl: getHubUrl(),
        agent,
        token,
        template: tpl,
      });
      const mcp_onboarding = buildAgentMcpOnboarding({
        hubUrl: getHubUrl(),
        agent,
        token,
        template: tpl,
      });

      return sendJson(res, 201, {
        ok: true,
        agent,
        token,
        hub_url: getHubUrl(),
        onboarding_prompt,
        mcp_onboarding,
      });
    }

    if (method === "POST" && pathname === "/api/v1/agents/register") {
      if (actor.kind !== "agent" && actor.kind !== "owner") {
        return sendError(res, 403, "仅独立 Agent 或机主可调用 register", "forbidden");
      }
      const body = await readJsonBody(req);
      const requestedId = String(body.id || body.node || "").trim();
      if (actor.kind === "agent" && requestedId && requestedId !== actor.id) {
        return sendError(res, 403, `禁止冒充其他 Agent (${requestedId})`, "impersonation_forbidden");
      }
      const targetId = actor.kind === "agent" ? actor.id : requestedId;
      if (!targetId) return sendError(res, 400, "缺少 agent id", "missing_id");
      const existing = store.getAgent(targetId);
      if (!existing) return sendError(res, 404, "Agent 尚未在 Hub 创建，请先在控制台添加", "not_found");

      const patch = {};
      if (body.name) patch.name = String(body.name);
      if (body.summary !== undefined) patch.summary = String(body.summary);
      if (Array.isArray(body.skills)) patch.skills = body.skills;
      if (Array.isArray(body.tools)) patch.tools = body.tools;
      if (Array.isArray(body.models)) patch.models = body.models;
      if (body.default_model !== undefined) patch.default_model = String(body.default_model);
      if (body.metadata && typeof body.metadata === "object") {
        patch.metadata = { ...(existing.metadata || {}), ...body.metadata };
      }
      const wasOnline = broker.isAgentOnline(existing);
      const updated = store.updateAgent(targetId, patch);
      store.touchAgentSeen(targetId, Date.now(), 0);
      if (!wasOnline && updated.updated_at === existing.updated_at) {
        const seq = store.nextSeq();
        store.emitChange({ type: "agent.updated", seq, agentId: targetId, deviceId: existing.device_id });
      }
      return sendJson(res, 200, { ok: true, agent: store.getAgent(updated.id) });
    }

    m = /^\/api\/v1\/agents\/([A-Za-z0-9._-]+)$/.exec(pathname);
    if (m) {
      const agentId = m[1];
      if (method === "GET") {
        if (actor.kind !== "owner" && (actor.kind !== "agent" || actor.id !== agentId)) {
          return sendError(res, 403, "无权查看该 Agent 详情", "forbidden");
        }
        const ag = store.getAgent(agentId);
        if (!ag) return sendError(res, 404, "Agent 不存在", "not_found");
        return sendJson(res, 200, { ok: true, agent: ag });
      }
      if (method === "PATCH") {
        if (!requireOwner()) return;
        const body = await readJsonBody(req);
        if (body.webhook_url) {
          const chk = validateWebhookUrl(body.webhook_url);
          if (!chk.ok) return sendError(res, 400, chk.error, "invalid_webhook_url");
        }
        const existing = store.getAgent(agentId);
        if (!existing) return sendError(res, 404, "Agent 不存在", "not_found");
        const updated = store.updateAgent(agentId, body);
        if (hubDeviceId && existing.kind === "device-worker" && existing.device_id === hubDeviceId) {
          const workers = loadWorkersJson(configDir);
          const idx = workers.findIndex((w) => w && w.key === existing.worker_key);
          if (idx >= 0) {
            const cur = workers[idx];
            if (body.name !== undefined) cur.name = String(body.name);
            if (body.summary !== undefined) cur.summary = String(body.summary);
            if (body.role !== undefined) cur.role = String(body.role);
            if (Array.isArray(body.skills)) cur.skills = body.skills;
            if (body.default_model !== undefined) cur.default_model = String(body.default_model);
            if (body.approval_policy !== undefined) cur.approval_policy = String(body.approval_policy);
            if (body.enabled !== undefined) cur.enabled = Boolean(body.enabled);
            if (body.command !== undefined && String(body.command).trim()) cur.command = String(body.command).trim();
            if (body.resume_command !== undefined) cur.resume_command = String(body.resume_command).trim();
            if (body.cwd !== undefined && String(body.cwd).trim()) cur.cwd = String(body.cwd).trim();
            if (body.model_flag !== undefined) cur.model_flag = String(body.model_flag).trim();
            if (body.timeout_sec !== undefined && Number(body.timeout_sec) > 0) cur.timeout_sec = Number(body.timeout_sec);
            saveWorkersJson(configDir, workers);
          }
        }
        return sendJson(res, 200, { ok: true, agent: updated });
      }
      if (method === "DELETE") {
        if (!requireOwner()) return;
        const existing = store.getAgent(agentId);
        const ok = store.deleteAgent(agentId);
        if (!ok) return sendError(res, 404, "Agent 不存在", "not_found");
        if (hubDeviceId && existing?.kind === "device-worker" && existing.device_id === hubDeviceId) {
          const workers = loadWorkersJson(configDir).filter((w) => w && w.key !== existing.worker_key);
          saveWorkersJson(configDir, workers);
        }
        return sendJson(res, 200, { ok: true });
      }
    }

    m = /^\/api\/v1\/agents\/([A-Za-z0-9._-]+)\/rotate-token$/.exec(pathname);
    if (method === "POST" && m) {
      if (!requireOwner()) return;
      const rotated = store.rotateAgentToken(m[1]);
      if (!rotated) return sendError(res, 404, "Agent 不存在", "not_found");
      const tpl = findTemplate(configDir, rotated.agent.platform);
      const onboarding_prompt = buildAgentOnboardingPrompt({
        hubUrl: getHubUrl(),
        agent: rotated.agent,
        token: rotated.token,
        template: tpl,
      });
      const mcp_onboarding = buildAgentMcpOnboarding({
        hubUrl: getHubUrl(),
        agent: rotated.agent,
        token: rotated.token,
        template: tpl,
      });
      return sendJson(res, 200, { ok: true, ...rotated, onboarding_prompt, mcp_onboarding });
    }

    m = /^\/api\/v1\/agents\/([A-Za-z0-9._-]+)\/onboarding$/.exec(pathname);
    if (method === "GET" && m) {
      if (!requireOwner()) return;
      const ag = store.getAgent(m[1]);
      if (!ag) return sendError(res, 404, "Agent 不存在", "not_found");
      const tpl = findTemplate(configDir, ag.platform);
      const placeholderTok = `<使用已有 Token(${ag.token_prefix})；若遗忘请点击「重新生成 Token」>`;
      const onboarding_prompt = buildAgentOnboardingPrompt({
        hubUrl: getHubUrl(),
        agent: ag,
        token: placeholderTok,
        template: tpl,
      });
      const mcp_onboarding = buildAgentMcpOnboarding({
        hubUrl: getHubUrl(),
        agent: ag,
        token: placeholderTok,
        template: tpl,
      });
      return sendJson(res, 200, { ok: true, agent: ag, onboarding_prompt, mcp_onboarding });
    }

    m = /^\/api\/v1\/agents\/([A-Za-z0-9._-]+)\/webhook-test$/.exec(pathname);
    if (method === "POST" && m) {
      if (!requireOwner()) return;
      const resTest = await webhooks.testAgentWebhook(m[1]);
      return sendJson(res, resTest.ok ? 200 : 400, { ok: resTest.ok, result: resTest });
    }

    m = /^\/api\/v1\/agents\/([A-Za-z0-9._-]+)\/check$/.exec(pathname);
    if (method === "GET" && m) {
      const agentId = m[1];
      if (actor.kind !== "owner" && (actor.kind !== "agent" || actor.id !== agentId)) {
        return sendError(res, 403, "无权检查其他 Agent 的收件箱", "forbidden");
      }
      const checked = taskService.checkAgentInbox(agentId);
      if (!checked) return sendError(res, 404, "Agent 不存在", "not_found");
      store.touchAgentSeen(agentId);
      return sendJson(res, 200, checked);
    }

    m = /^\/api\/v1\/agents\/([A-Za-z0-9._-]+)\/poll$/.exec(pathname);
    if ((method === "GET" || method === "POST") && m) {
      const agentId = m[1];
      if (actor.kind !== "owner" && (actor.kind !== "agent" || actor.id !== agentId)) {
        return sendError(res, 403, "无权轮询其他 Agent", "forbidden");
      }
      const ag = store.getAgent(agentId);
      if (!ag) return sendError(res, 404, "Agent 不存在", "not_found");
      store.touchAgentSeen(agentId);
      const since = Number(url.searchParams.get("since") || 0);
      const timeout = Number(url.searchParams.get("timeout") || 30);

      const pendingNow = ag.enabled ? store.listTasks({ to_agent_id: agentId, state: "submitted", order: "asc", limit: 30 }) : [];
      if (pendingNow.length > 0 || timeout <= 0) {
        return sendJson(res, 200, {
          ok: true,
          seq: broker.currentSeq(),
          woke: pendingNow.length > 0,
          paused: !ag.enabled,
          tasks: pendingNow,
        });
      }

      const ac = new AbortController();
      const onAbort = () => ac.abort();
      req.once("close", onAbort);
      let waitRes;
      try {
        waitRes = await broker.waitForChange({
          scope: "agent",
          sinceSeq: since,
          timeoutSec: timeout,
          agentId,
          signal: ac.signal,
        });
      } finally {
        req.off("close", onAbort);
      }
      if (waitRes.aborted || ac.signal.aborted || res.destroyed || res.writableEnded) return;
      store.touchAgentSeen(agentId);
      const refreshed = store.getAgent(agentId);
      const tasksAfter = refreshed?.enabled
        ? store.listTasks({ to_agent_id: agentId, state: "submitted", order: "asc", limit: 30 })
        : [];
      return sendJson(res, 200, {
        ok: true,
        ...waitRes,
        paused: !refreshed?.enabled,
        tasks: tasksAfter,
      });
    }

    m = /^\/api\/v1\/agents\/([A-Za-z0-9._-]+)\/inbox$/.exec(pathname);
    if (method === "GET" && m) {
      const agentId = m[1];
      if (actor.kind !== "owner" && (actor.kind !== "agent" || actor.id !== agentId)) {
        return sendError(res, 403, "无权读取其他 Agent 的收件箱", "forbidden");
      }
      const ag = store.getAgent(agentId);
      if (!ag) return sendError(res, 404, "Agent 不存在", "not_found");
      store.touchAgentSeen(agentId);
      const tasks = store.listTasks({ to_agent_id: agentId, limit: 100 });
      return sendJson(res, 200, { ok: true, agent: ag, tasks });
    }

    m = /^\/api\/v1\/agents\/([A-Za-z0-9._-]+)\/updates$/.exec(pathname);
    if (method === "GET" && m) {
      const agentId = m[1];
      if (actor.kind !== "owner") {
        if (actor.kind !== "agent" || actor.id !== agentId) {
          return sendError(res, 403, "无权读取其他 Leader 的增量更新", "forbidden");
        }
        if (actor.role !== "leader") {
          return sendError(res, 403, "仅 Leader 角色可使用 updates 水位增量拉取", "leader_required");
        }
      }
      const since = url.searchParams.get("since");
      const advance = url.searchParams.get("new") === "1" || url.searchParams.get("advance") === "1";
      store.touchAgentSeen(agentId);
      const resUpd = taskService.getLeaderUpdates(agentId, { sinceSeq: since, advance });
      return sendJson(res, 200, { ok: true, ...resUpd });
    }

    m = /^\/api\/v1\/agents\/([A-Za-z0-9._-]+)\/schedules\/([A-Za-z0-9._-]+)$/.exec(pathname);
    if (m) {
      const [, agentId, scheduleId] = m;
      if (actor.kind !== "owner" && (actor.kind !== "agent" || actor.id !== agentId)) {
        return sendError(res, 403, "无权修改其他 Agent 的定时自报", "forbidden");
      }
      if (method === "PUT") {
        const body = await readJsonBody(req);
        const resSch = schedules.upsertForAgent(agentId, scheduleId, body);
        return sendJson(res, 200, { ok: true, ...resSch });
      }
      if (method === "DELETE") {
        const ok = schedules.deleteForAgent(agentId, scheduleId);
        if (!ok) return sendError(res, 404, "定时条目不存在", "not_found");
        return sendJson(res, 200, { ok: true });
      }
    }

    // ---- 8. Tasks 与 Thread 协作协议 ----
    if (method === "GET" && pathname === "/api/v1/tasks") {
      const filter = {
        state: url.searchParams.get("state") || undefined,
        to_agent_id: url.searchParams.get("agent") || url.searchParams.get("to") || undefined,
        context_id: url.searchParams.get("context_id") || undefined,
        summaryOnly: url.searchParams.get("summary") === "1",
        limit: Number(url.searchParams.get("limit") || 150),
      };
      if (actor.kind === "agent") {
        filter.visible_to = actor.id;
      } else if (actor.kind === "device") {
        const devAgents = store.listAgents({ device_id: actor.id }).map((a) => a.id);
        const tasks = store.listTasks(filter).filter((t) => devAgents.includes(t.to_agent_id) || devAgents.includes(t.from_node));
        return sendJson(res, 200, { ok: true, tasks });
      }
      return sendJson(res, 200, { ok: true, tasks: store.listTasks(filter) });
    }

    if (method === "POST" && pathname === "/api/v1/tasks") {
      if (actor.kind === "device") {
        return sendError(res, 403, "电脑宿主凭据不可发起派单", "forbidden");
      }
      if (actor.kind === "agent" && actor.role !== "leader") {
        return sendError(res, 403, "仅 Leader Agent 或机主可发起派单", "leader_required");
      }
      const body = await readJsonBody(req);
      const requestedFrom = String(body.from_node || body.from || "").trim();
      if (actor.kind === "agent" && requestedFrom && requestedFrom !== actor.id) {
        return sendError(res, 403, `禁止伪造任务发起方 (${requestedFrom})`, "impersonation_forbidden");
      }
      const fromNode = actor.kind === "agent" ? actor.id : requestedFrom || "owner";
      const result = taskService.dispatchTasks({
        fromNode,
        to: body.to || body.to_agent_id || body.agent_id,
        title: body.title || "",
        inputText: body.input_text ?? body.prompt ?? body.input ?? "",
        params: body.params || {},
        attachments: body.attachments || [],
        model: body.model || "",
        priority: body.priority,
        contextId: body.context_id || "",
        parentTaskId: body.parent_task_id || null,
        source: body.source || "direct",
        scheduleId: body.schedule_id || null,
        idempotencyKey: body.client_token || body.idempotency_key || req.headers["idempotency-key"] || "",
        timeoutSec: body.timeout_sec,
        maxRetries: body.max_retries,
      });
      return sendJson(res, 201, { ok: true, ...result });
    }

    if (method === "POST" && pathname === "/api/v1/tasks/claim") {
      if (actor.kind === "anonymous") return sendError(res, 401, "未认证", "unauthorized");
      const body = await readJsonBody(req);
      let candidateIds = [];
      if (actor.kind === "agent") {
        candidateIds = [actor.id];
      } else if (actor.kind === "device") {
        const devIds = store.listAgents({ device_id: actor.id }).filter((a) => a.enabled).map((a) => a.id);
        if (Array.isArray(body.agent_ids) && body.agent_ids.length) {
          candidateIds = body.agent_ids.filter((id) => devIds.includes(id));
        } else {
          candidateIds = devIds;
        }
      } else if (actor.kind === "owner") {
        candidateIds = Array.isArray(body.agent_ids) ? body.agent_ids : store.listAgents({ enabled: true }).map((a) => a.id);
      }
      const task = taskService.claimNext({
        agentIds: candidateIds,
        claimant: actor.id,
        leaseSec: body.lease_sec,
      });
      return sendJson(res, 200, { ok: true, task });
    }

    m = /^\/api\/v1\/tasks\/([A-Za-z0-9._-]+)$/.exec(pathname);
    if (method === "GET" && m) {
      const detail = taskService.getTaskDetail(m[1], { includeContextHistory: true });
      if (!detail) return sendError(res, 404, "任务不存在", "not_found");
      if (!actorCanSeeTask(actor, detail, store)) {
        return sendError(res, 403, "无权查看该任务", "forbidden");
      }
      return sendJson(res, 200, { ok: true, task: detail });
    }

    m = /^\/api\/v1\/tasks\/([A-Za-z0-9._-]+)\/(claim|heartbeat|complete|fail|ask|auth|reply|cancel)$/.exec(pathname);
    if (method === "POST" && m) {
      const [, taskId, action] = m;
      const existing = store.getTask(taskId);
      if (!existing) return sendError(res, 404, "任务不存在", "not_found");
      const body = await readJsonBody(req);

      if (["claim", "heartbeat", "complete", "fail", "ask", "auth"].includes(action)) {
        if (!actorCanOperateTaskAsWorker(actor, existing, store)) {
          return sendError(res, 403, "无权以执行方操作此任务", "forbidden");
        }
        const actorId = actor.kind === "device" ? existing.to_agent_id : actor.id;
        if (action === "claim") {
          const allowed = actor.kind === "owner" ? null : actor.kind === "agent" ? [actor.id] : store.listAgents({ device_id: actor.id }).map((a) => a.id);
          const task = taskService.claimTaskById(taskId, { claimant: actorId, allowedAgentIds: allowed, leaseSec: body.lease_sec });
          return sendJson(res, 200, { ok: true, task });
        }
        if (action === "heartbeat") {
          const task = taskService.heartbeat(taskId, { actorId, progress: body.progress || {}, leaseSec: body.lease_sec });
          return sendJson(res, 200, { ok: true, task });
        }
        if (action === "complete") {
          const task = taskService.complete(taskId, {
            actorId,
            summary: body.summary || "",
            text: body.text || body.output || "",
            artifacts: body.artifacts || [],
            data: body.data || {},
            usage: body.usage || null,
            attachments: body.attachments || [],
          });
          return sendJson(res, 200, { ok: true, task });
        }
        if (action === "fail") {
          const task = taskService.fail(taskId, {
            actorId,
            error: body.error || body.message || "execution_failed",
            retryable: Boolean(body.retryable),
            data: body.data || {},
          });
          return sendJson(res, 200, { ok: true, task });
        }
        if (action === "ask") {
          const task = taskService.ask(taskId, {
            actorId,
            prompt: body.prompt || body.question || "",
            choices: body.choices || [],
            data: body.data || {},
          });
          return sendJson(res, 200, { ok: true, task });
        }
        if (action === "auth") {
          const task = taskService.requestAuth(taskId, {
            actorId,
            reason: body.reason || "",
            commandPreview: body.command_preview || "",
            riskLevel: body.risk_level || "high",
            data: body.data || {},
          });
          return sendJson(res, 200, { ok: true, task });
        }
      }

      if (action === "reply") {
        if (!actorCanControlTaskAsSender(actor, existing)) {
          return sendError(res, 403, "仅机主或任务发起方可补充回复", "forbidden");
        }
        const task = taskService.reply(taskId, {
          fromNode: actor.id,
          body: body.body ?? body.text ?? body.answer ?? "",
          data: body.data || {},
          attachments: body.attachments || [],
        });
        return sendJson(res, 200, { ok: true, task });
      }

      if (action === "cancel") {
        if (!actorCanControlTaskAsSender(actor, existing)) {
          return sendError(res, 403, "仅机主或任务发起方可取消任务", "forbidden");
        }
        const task = taskService.cancel(taskId, { fromNode: actor.id, reason: body.reason || "" });
        return sendJson(res, 200, { ok: true, task });
      }
    }

    m = /^\/api\/v1\/approvals\/([A-Za-z0-9._-]+)\/decide$/.exec(pathname);
    if (method === "POST" && m) {
      if (!requireOwner()) return;
      const body = await readJsonBody(req);
      const task = taskService.decideApproval(m[1], {
        fromNode: "owner",
        decision: body.decision,
        note: body.note || "",
        requestId: body.request_id || "",
      });
      return sendJson(res, 200, { ok: true, task });
    }

    if (method === "GET" && pathname === "/api/v1/threads") {
      if (actor.kind === "device") return sendError(res, 403, "forbidden", "forbidden");
      const threads = taskService.listThreads({
        limit: Number(url.searchParams.get("limit") || 60),
        agentId: url.searchParams.get("agent") || null,
        visibleTo: actor.kind === "agent" ? actor.id : null,
      });
      return sendJson(res, 200, { ok: true, threads });
    }

    m = /^\/api\/v1\/threads\/([A-Za-z0-9._-]+)$/.exec(pathname);
    if (method === "GET" && m) {
      const thread = taskService.getThread(m[1]);
      if (!thread) return sendError(res, 404, "Thread 不存在", "not_found");
      if (actor.kind === "agent") {
        const visible = thread.tasks.some((t) => actorCanSeeTask(actor, t, store));
        if (!visible) return sendError(res, 403, "无权查看该 Thread", "forbidden");
      }
      return sendJson(res, 200, { ok: true, thread });
    }

    // ---- 9. 文件中转存储 ----
    if (method === "POST" && pathname === "/api/v1/files") {
      if (!fileStore) return sendError(res, 500, "FileStore 未就绪", "no_file_store");
      const ct = String(req.headers["content-type"] || "").toLowerCase();
      let buf;
      let name = String(req.headers["x-file-name"] || "file.bin");
      let mime = String(req.headers["x-file-mime"] || ct || "application/octet-stream");
      let taskId = req.headers["x-task-id"] ? String(req.headers["x-task-id"]) : null;
      if (ct.includes("application/json")) {
        const body = await readJsonBody(req);
        if (!body.content_base64 && body.content === undefined) {
          return sendError(res, 400, "缺少 content_base64 或 content", "missing_content");
        }
        buf = body.content_base64
          ? Buffer.from(String(body.content_base64), "base64")
          : Buffer.from(String(body.content), "utf8");
        if (body.name) name = String(body.name);
        if (body.mime) mime = String(body.mime);
        if (body.task_id) taskId = String(body.task_id);
      } else {
        buf = await readRawBody(req, MAX_UPLOAD_BYTES);
        try {
          name = decodeURIComponent(name);
        } catch {}
      }
      const meta = fileStore.put({
        buffer: buf,
        name,
        mime: mime.split(";")[0].trim() || "application/octet-stream",
        ownerNode: actor.id,
        taskId,
      });
      return sendJson(res, 201, { ok: true, file: meta });
    }

    m = /^\/api\/v1\/files\/([a-f0-9]{16,64})$/.exec(pathname);
    if (method === "GET" && m) {
      const read = fileStore.readBuffer(m[1]);
      if (!read) return sendError(res, 404, "文件不存在或已过期", "not_found");
      if (actor.kind !== "owner") {
        const allowed =
          read.meta.owner_node === actor.id ||
          (actor.kind === "device" && deviceOwnsAgent(store, actor.id, read.meta.owner_node)) ||
          (read.meta.task_id && actorCanSeeTask(actor, store.getTask(read.meta.task_id), store));
        if (!allowed) return sendError(res, 403, "无权下载该文件", "forbidden");
      }
      res.writeHead(200, {
        "Content-Type": read.meta.mime || "application/octet-stream",
        "Content-Length": read.buffer.byteLength,
        "Content-Disposition": `attachment; filename="${encodeURIComponent(read.meta.name)}"`,
        "X-Content-Type-Options": "nosniff",
      });
      res.end(read.buffer);
      return;
    }

    return sendError(res, 404, `未知接口: ${method} ${pathname}`, "not_found");
  }

  const server = http.createServer(async (req, res) => {
    res._acceptEncoding = String(req.headers["accept-encoding"] || "");
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const pathname = url.pathname;

      // 根路径携带 ?token= 时核验机主 Token 并种入 HttpOnly 会话 Cookie，302 剥离 URL 敏感参数。
      if ((req.method || "GET") === "GET" && pathname === "/") {
        const qToken = url.searchParams.get("token");
        const curOwnerToken = getOwnerToken();
        if (qToken && curOwnerToken && timingSafeEqualStr(qToken, curOwnerToken)) {
          const cookieVal = createSessionCookieValue(curOwnerToken, approvalPrivateKey);
          res.writeHead(302, {
            Location: "/",
            "Set-Cookie": buildSetSessionCookieHeader(req, cookieVal),
            "Cache-Control": "no-store",
          });
          res.end();
          return;
        }
        return serveStaticFile(res, WEB_ROOT, "index.html");
      }

      if (pathname.startsWith("/api/") || pathname === "/.well-known/agent.json") {
        await handleApi(req, res, url);
        return;
      }

      if ((req.method || "GET") === "GET") {
        return serveStaticFile(res, WEB_ROOT, pathname);
      }

      sendError(res, 404, "Not Found", "not_found");
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      const code = err?.code || "internal_error";
      sendError(res, status, err?.message || "服务器内部错误", code);
    }
  });

  // 长轮询hold最高 40s，Node HTTP requestTimeout 设充裕但不过长。
  server.requestTimeout = 90_000;
  server.keepAliveTimeout = 65_000;

  return { server, listen, enrichStateSnapshot };
}
