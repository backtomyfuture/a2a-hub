// Herdr Socket API 客户端（纯 node:net，零外部依赖）。
// 协议事实来自 `herdr api schema --json`（protocol 22）与对 0.9.5 服务端的实测，不凭记忆：
//   - 控制请求：服务端每条连接只处理第一行请求，应答后立刻关闭连接，多写的行会被丢弃。
//     所以 Control 通道 = 每次调用一条短连接 + id 关联校验；长等待（agent.wait / agent.prompt{wait}）
//     各占一条自己的连接，天然没有队头阻塞。
//   - 事件订阅：events.subscribe 的连接在 subscription_started 之后只读，再写任何一行服务端都会断开它。
//     所以 Event 通道独占一条连接，断线靠带抖动的指数退避重连。
//   - 无参请求必须显式带 params: {}（缺字段服务端按 invalid_request 拒绝）。
//   - 推送事件线上名是下划线形式（pane_moved），订阅请求里是点号形式（pane.moved），此处统一成点号。
import { EventEmitter } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// 本代码依赖的最低协议版本（schema.protocol）。低于它时 doctor 与 runner 都应拒绝工作。
export const HERDR_PROTOCOL_MIN = 22;

const MAX_FRAME_CHARS = 32 * 1024 * 1024;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_ACK_TIMEOUT_MS = 10_000;
const SESSION_NAME = /^[A-Za-z0-9._-]{1,64}$/;

// ---------- 错误归一 ----------
//
// schema 的 ErrorBody.code 只是 string，没有枚举。下表来自官方文档、二进制字符串与实测；
// 认不得的码一律原样保留在 error.code，category 记为 "other"，绝不吞掉。
const CATEGORY_BY_CODE = new Map([
  ["agent_blocked", "blocked"],
  ["agent_prompt_stalled", "prompt_stalled"],
  ["agent_not_running", "not_running"],
  ["agent_not_ready", "not_ready"],
  ["agent_kind_mismatch", "not_ready"],
  // 新窗格的 shell 还没到交互提示符，或终端进程还没起来。启动期可以等，不是永久失败。
  ["agent_pane_busy", "shell_not_ready"],
  ["agent_pane_unavailable", "shell_not_ready"],
  ["timeout", "timeout"],
  ["events_lost", "events_lost"],
  ["invalid_request", "invalid_request"],
  ["invalid_params", "invalid_request"],
  ["invalid_target", "invalid_request"],
  ["invalid_agent_name", "invalid_request"],
  // 以下是客户端本地产生的码。
  ["server_unavailable", "unavailable"],
  ["connection_closed", "closed"],
  ["protocol_error", "protocol"],
  ["protocol_unsupported", "protocol"],
  ["aborted", "aborted"],
]);

export function classifyErrorCode(code) {
  const key = String(code ?? "");
  const hit = CATEGORY_BY_CODE.get(key);
  if (hit) return hit;
  // 实测服务端返回 pane_not_found / agent_not_found / tab_not_found，文档示例写的是 not_found，两种都归一。
  if (key === "not_found" || key.endsWith("_not_found")) return "not_found";
  return "other";
}

export class HerdrError extends Error {
  constructor(code, message, { method = "", local = false, raw = null } = {}) {
    super(String(message ?? code));
    this.name = "HerdrError";
    this.code = String(code);
    this.category = classifyErrorCode(code);
    this.method = method;
    // local=true 表示错误由本客户端产生（超时、断连、Abort），不是服务端返回的。
    this.local = local;
    this.raw = raw;
  }
}

function localError(code, message, method) {
  return new HerdrError(code, message, { method, local: true });
}

function errorFromBody(body, method) {
  const code = typeof body?.code === "string" && body.code ? body.code : "unknown_error";
  return new HerdrError(code, body?.message ?? code, { method, raw: body });
}

function mapNetError(err, method) {
  const code = err?.code;
  if (code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES" || code === "ENOTSOCK") {
    return localError("server_unavailable", `Herdr socket 不可用（${code}）：${err.message}`, method);
  }
  return localError("connection_closed", `Herdr socket 读写失败（${code ?? "unknown"}）：${err?.message ?? err}`, method);
}

// ---------- 路径发现 ----------

// 顺序：显式配置 → HERDR_SOCKET_PATH → 显式 session（参数或 HERDR_SESSION）→ 默认会话。
// 前两项在 Windows 上可直接是 \\.\pipe\… 形式的命名管道；默认路径只在文档化的 Unix 布局下推导。
export function discoverSocketPath({
  socketPath = "",
  session = "",
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
} = {}) {
  const explicit = String(socketPath ?? "").trim();
  if (explicit) return { path: explicit, source: "config" };
  const fromEnv = String(env?.HERDR_SOCKET_PATH ?? "").trim();
  if (fromEnv) return { path: fromEnv, source: "env:HERDR_SOCKET_PATH" };

  if (platform === "win32") {
    throw localError(
      "server_unavailable",
      "Windows 下 Herdr 使用命名管道，路径文档未定义；请设置 HERDR_SOCKET_PATH 指向管道路径",
      "",
    );
  }
  const base = path.join(homedir, ".config", "herdr");
  const sessionName = String(session ?? "").trim() || String(env?.HERDR_SESSION ?? "").trim();
  if (sessionName) {
    if (!SESSION_NAME.test(sessionName)) {
      throw localError("invalid_request", `非法的 Herdr session 名：${JSON.stringify(sessionName)}`, "");
    }
    const from = String(session ?? "").trim() ? "config:session" : "env:HERDR_SESSION";
    return { path: path.join(base, "sessions", sessionName, "herdr.sock"), source: from };
  }
  return { path: path.join(base, "herdr.sock"), source: "default" };
}

// ---------- Control 通道 ----------

export class HerdrControl {
  #socketPath;
  #timeoutMs;
  #connectTimeoutMs;
  #seq = 0;
  #inflight = new Map();
  #closed = false;

  constructor({ socketPath, timeoutMs = DEFAULT_CALL_TIMEOUT_MS, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
    if (!socketPath) throw new TypeError("HerdrControl 需要 socketPath");
    this.#socketPath = socketPath;
    this.#timeoutMs = timeoutMs;
    this.#connectTimeoutMs = connectTimeoutMs;
  }

  get inflightCount() {
    return this.#inflight.size;
  }

  // 一次 RPC：成功返回 result 对象，失败抛 HerdrError。timeoutMs 含建连时间；0 或负数表示不设客户端超时。
  call(method, params = {}, { timeoutMs = this.#timeoutMs, signal } = {}) {
    if (this.#closed) return Promise.reject(localError("connection_closed", "HerdrControl 已关闭", method));
    if (signal?.aborted) return Promise.reject(localError("aborted", `${method} 已被取消`, method));
    const id = `ah-${++this.#seq}`;
    const body = params && typeof params === "object" && !Array.isArray(params) ? params : {};

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.#socketPath);
      socket.setEncoding("utf8");
      let buf = "";
      let settled = false;
      let timer = null;
      let connectTimer = null;

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(connectTimer);
        signal?.removeEventListener("abort", onAbort);
        this.#inflight.delete(id);
        socket.destroy();
        if (err) reject(err);
        else resolve(value);
      };
      const onAbort = () => finish(localError("aborted", `${method} 已被取消`, method));

      this.#inflight.set(id, { method, abort: (err) => finish(err) });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs > 0) {
        timer = setTimeout(() => finish(localError("timeout", `${method} 客户端等待超过 ${timeoutMs}ms`, method)), timeoutMs);
      }
      if (this.#connectTimeoutMs > 0) {
        connectTimer = setTimeout(
          () => finish(localError("server_unavailable", `连接 Herdr socket 超时（${this.#connectTimeoutMs}ms）`, method)),
          this.#connectTimeoutMs,
        );
      }

      socket.on("connect", () => {
        clearTimeout(connectTimer);
        socket.write(JSON.stringify({ id, method, params: body }) + "\n");
      });
      socket.on("data", (chunk) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl < 0) {
          if (buf.length > MAX_FRAME_CHARS) finish(localError("protocol_error", `${method} 应答超过 ${MAX_FRAME_CHARS} 字符仍无换行`, method));
          return;
        }
        const line = buf.slice(0, nl);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (e) {
          finish(localError("protocol_error", `${method} 应答不是合法 JSON：${e.message}`, method));
          return;
        }
        // 服务端对无法解码的请求会回空 id，单请求连接上它只可能是对我们这一条的应答。
        if (typeof msg?.id === "string" && msg.id !== "" && msg.id !== id) {
          finish(localError("protocol_error", `${method} 应答 id 不匹配：期望 ${id}，收到 ${msg.id}`, method));
          return;
        }
        if (msg?.error && typeof msg.error === "object") {
          finish(errorFromBody(msg.error, method));
          return;
        }
        if (!msg || typeof msg.result !== "object" || msg.result === null) {
          finish(localError("protocol_error", `${method} 应答缺少 result`, method));
          return;
        }
        finish(null, msg.result);
      });
      socket.on("error", (e) => finish(mapNetError(e, method)));
      socket.on("close", () => finish(localError("connection_closed", `${method} 在收到应答前连接被关闭`, method)));
    });
  }

  close() {
    this.#closed = true;
    for (const entry of [...this.#inflight.values()]) {
      entry.abort(localError("connection_closed", "HerdrControl 已关闭", entry.method));
    }
  }
}

// ---------- Event 通道 ----------

export function backoffDelay(attempt, { baseMs = 250, maxMs = 8000, factor = 2, jitter = 0.5 } = {}, random = Math.random) {
  const raw = Math.min(maxMs, baseMs * factor ** Math.max(0, attempt));
  return Math.round(raw * (1 - jitter * random()));
}

// 推送事件名 pane_agent_status_changed → pane.agent_status_changed，与订阅请求里的写法一致。
export function normalizeEventName(name) {
  const s = String(name ?? "");
  const i = s.indexOf("_");
  return i < 0 ? s : `${s.slice(0, i)}.${s.slice(i + 1)}`;
}

// 全局拓扑订阅：只当缓存失效信号用，不当增量日志回放。均取自 schema 的订阅类型枚举。
export const LIFECYCLE_SUBSCRIPTIONS = Object.freeze([
  "workspace.created", "workspace.updated", "workspace.closed",
  "worktree.created", "worktree.opened", "worktree.removed",
  "tab.created", "tab.closed",
  "pane.created", "pane.updated", "pane.closed", "pane.moved", "pane.exited", "pane.agent_detected",
  "layout.updated",
].map((type) => Object.freeze({ type })));

// pane 级订阅必须带 pane_id，且只要有一个 pane 不存在整条订阅就被拒绝并断连，所以按活跃 pane 单独拼。
export function paneStatusSubscription(paneId, agentStatus = null) {
  const sub = { type: "pane.agent_status_changed", pane_id: String(paneId) };
  if (agentStatus) sub.agent_status = agentStatus;
  return sub;
}

// 事件：
//   ready({attempts})        首次订阅确认
//   reconnected({downtimeMs}) 之后每次重新订阅确认；消费方此时必须重做 session.snapshot 对账
//   lost(error)              收到 events_lost，缓存已陈旧，随后自动重连
//   event({event, raw, data}) 推送事件（event 为点号写法）
//   disconnected(reason)     连接断开
//   subscribe_error(error)   订阅被拒（如 pane_not_found）；消费方可在退避期内剪掉失效订阅
//   protocol_error(error)    收到无法解析的行，已跳过
//   fatal(error)             订阅请求本身非法（invalid_request），不再重试
export class HerdrEvents extends EventEmitter {
  #socketPath;
  #provider;
  #backoff;
  #random;
  #connectTimeoutMs;
  #ackTimeoutMs;
  #stopped = false;
  #started = false;
  #everReady = false;
  #failures = 0;
  #socket = null;
  #sleepTimer = null;
  #wakeSleep = null;
  #readyPromise = null;
  #readyResolve = null;
  #readyReject = null;
  #lastDownAt = 0;
  #seq = 0;
  #refreshing = false;

  constructor({
    socketPath,
    subscriptions = LIFECYCLE_SUBSCRIPTIONS,
    backoff = {},
    random = Math.random,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
  } = {}) {
    super();
    if (!socketPath) throw new TypeError("HerdrEvents 需要 socketPath");
    this.#socketPath = socketPath;
    this.#provider = subscriptions;
    this.#backoff = backoff;
    this.#random = random;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#ackTimeoutMs = ackTimeoutMs;
  }

  get ready() {
    return this.#everReady && !this.#stopped;
  }

  // 首次订阅确认后 resolve；服务端没起来时持续退避重试，stop() 会让它 reject。
  start() {
    if (this.#readyPromise) return this.#readyPromise;
    this.#stopped = false;
    this.#started = true;
    this.#readyPromise = new Promise((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    this.#readyPromise.catch(() => {});
    void this.#run();
    return this.#readyPromise;
  }

  // 订阅集合变了（新 pane 上线、pane 消失）时调用：立即断开并按最新 provider 重订，不计入失败退避。
  refresh() {
    if (!this.#started || this.#stopped) return;
    if (this.#socket) {
      this.#refreshing = true;
      this.#socket.destroy();
    }
    this.#wakeSleep?.();
  }

  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#socket?.destroy();
    this.#wakeSleep?.();
    if (!this.#everReady) this.#readyReject?.(localError("connection_closed", "HerdrEvents 在订阅确认前被停止", "events.subscribe"));
  }

  async #run() {
    while (!this.#stopped) {
      let outcome;
      try {
        outcome = await this.#session();
      } catch (e) {
        outcome = { reason: "error", error: e };
      }
      if (this.#stopped || outcome.reason === "fatal") break;
      if (outcome.acked) this.#failures = 0;
      if (outcome.reason === "refresh") continue;
      const delay = backoffDelay(this.#failures, this.#backoff, this.#random);
      this.#failures += 1;
      await this.#sleep(delay);
    }
  }

  #sleep(ms) {
    return new Promise((resolve) => {
      this.#wakeSleep = () => {
        clearTimeout(this.#sleepTimer);
        this.#sleepTimer = null;
        this.#wakeSleep = null;
        resolve();
      };
      this.#sleepTimer = setTimeout(() => this.#wakeSleep?.(), ms);
    });
  }

  async #session() {
    const subscriptions = typeof this.#provider === "function" ? await this.#provider() : this.#provider;
    if (this.#stopped) return { reason: "stopped" };
    const id = `ev-${++this.#seq}`;

    return new Promise((resolve) => {
      const socket = net.createConnection(this.#socketPath);
      this.#socket = socket;
      socket.setEncoding("utf8");
      socket.setKeepAlive(true);
      let buf = "";
      let acked = false;
      let done = false;
      let ackTimer = null;
      let connectTimer = null;

      const end = (rawReason) => {
        if (done) return;
        done = true;
        // refresh() 主动断开的连接要立刻重订，不能被当成故障去退避。
        const reason = this.#refreshing && rawReason === "closed" ? "refresh" : rawReason;
        this.#refreshing = false;
        clearTimeout(ackTimer);
        clearTimeout(connectTimer);
        if (this.#socket === socket) this.#socket = null;
        socket.destroy();
        if (acked) this.#lastDownAt = Date.now();
        if (!this.#stopped) this.emit("disconnected", reason);
        resolve({ reason, acked });
      };

      connectTimer = setTimeout(() => end("connect_timeout"), this.#connectTimeoutMs);
      socket.on("connect", () => {
        clearTimeout(connectTimer);
        ackTimer = setTimeout(() => end("ack_timeout"), this.#ackTimeoutMs);
        socket.write(JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } }) + "\n");
      });
      socket.on("data", (chunk) => {
        buf += chunk;
        if (buf.length > MAX_FRAME_CHARS) {
          this.emit("protocol_error", localError("protocol_error", "事件帧超过上限仍无换行", "events.subscribe"));
          end("protocol_error");
          return;
        }
        let nl;
        while (!done && (nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch (e) {
            this.emit("protocol_error", localError("protocol_error", `事件帧不是合法 JSON：${e.message}`, "events.subscribe"));
            continue;
          }
          if (msg?.error) {
            const err = errorFromBody(msg.error, "events.subscribe");
            if (err.category === "events_lost") {
              this.emit("lost", err);
              end("lost");
            } else if (!acked && err.category === "invalid_request") {
              this.emit("fatal", err);
              if (!this.#everReady) this.#readyReject?.(err);
              this.#stopped = true;
              end("fatal");
            } else {
              this.emit("subscribe_error", err);
              end("subscribe_error");
            }
            return;
          }
          if (!acked) {
            if (msg?.id === id && msg?.result?.type === "subscription_started") {
              acked = true;
              clearTimeout(ackTimer);
              if (!this.#everReady) {
                this.#everReady = true;
                this.#readyResolve?.({ attempts: this.#failures + 1 });
                this.emit("ready", { attempts: this.#failures + 1 });
              } else {
                this.emit("reconnected", { downtimeMs: this.#lastDownAt ? Date.now() - this.#lastDownAt : 0 });
              }
            } else {
              this.emit("protocol_error", localError("protocol_error", "订阅确认帧不符合预期", "events.subscribe"));
              end("protocol_error");
              return;
            }
            continue;
          }
          if (typeof msg?.event === "string") {
            this.emit("event", { event: normalizeEventName(msg.event), raw: msg.event, data: msg.data ?? null });
          }
        }
      });
      socket.on("error", () => end("closed"));
      socket.on("close", () => end("closed"));
    });
  }
}

// ---------- 组合入口 ----------

export function createHerdrSocket({
  socketPath = "",
  session = "",
  env = process.env,
  platform = process.platform,
  timeoutMs,
  subscriptions,
  backoff,
  random,
} = {}) {
  const found = discoverSocketPath({ socketPath, session, env, platform });
  const control = new HerdrControl({ socketPath: found.path, timeoutMs });
  const events = new HerdrEvents({ socketPath: found.path, subscriptions, backoff, random });
  return {
    socketPath: found.path,
    source: found.source,
    control,
    events,
    call: (method, params, opts) => control.call(method, params, opts),
    // 返回 {version, protocol, capabilities}；协议低于 HERDR_PROTOCOL_MIN 时抛 protocol_unsupported。
    async ping(opts) {
      const pong = await control.call("ping", {}, opts);
      assertProtocol(pong);
      return pong;
    },
    close() {
      control.close();
      events.stop();
    },
  };
}

export function assertProtocol(pong, min = HERDR_PROTOCOL_MIN) {
  const protocol = Number(pong?.protocol);
  if (!Number.isInteger(protocol) || protocol < min) {
    throw localError(
      "protocol_unsupported",
      `Herdr 协议版本 ${pong?.protocol ?? "未知"}（版本 ${pong?.version ?? "未知"}）低于本程序要求的 ${min}`,
      "ping",
    );
  }
  return pong;
}
