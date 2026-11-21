// Herdr Socket API 客户端（纯 node:net，零外部依赖）。
// 协议事实来自 `herdr api schema --json`（protocol 22）与对 0.9.5 服务端的实测，不凭记忆：
//   - 控制请求：服务端每条连接只处理第一行请求，应答后立刻关闭连接，多写的行会被丢弃。
//     所以 Control 通道 = 每次调用一条短连接 + id 关联校验；长等待（agent.wait / agent.prompt{wait}）
//     各占一条自己的连接，天然没有队头阻塞。
//   - 事件订阅：events.subscribe 的连接在 subscription_started 之后只读，再写任何一行服务端都会断开它。
//     所以 Event 通道独占一条连接，断线靠带抖动的指数退避重连。
//   - 无参请求必须显式带 params: {}（缺字段服务端按 invalid_request 拒绝）。
//   - 全局推送用下划线名（pane_moved）；pane 专属订阅事件本就用点号（pane.agent_status_changed）。统一时保留已有点号。
import { EventEmitter } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

// 本代码依赖的最低协议版本（schema.protocol）。低于它时 doctor 与 runner 都应拒绝工作。
export const HERDR_PROTOCOL_MIN = 22;

const DEFAULT_MAX_FRAME_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_INFLIGHT = 128;
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
  ["socket_path_unverified", "unavailable"],
  ...["server_start_failed", "server_start_timeout", "server_start_locked", "server_start_limit", "server_start_cooldown", "server_start_unsupported"].map(code => [code, "unavailable"]),
  ["client_overloaded", "overloaded"],
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
  constructor(code, message, { method = "", local = false, raw = null, delivery = "unknown" } = {}) {
    super(String(message ?? code));
    this.name = "HerdrError";
    this.code = String(code);
    this.category = classifyErrorCode(code);
    this.method = method;
    // local=true 表示错误由本客户端产生（超时、断连、Abort），不是服务端返回的。
    this.local = local;
    this.raw = raw;
    // response_received 不保证没有副作用；unknown 绝不能当作未发送去自动重投。
    this.delivery = delivery;
    this.deliveryUnknown = delivery === "unknown";
  }
}

function localError(code, message, method, delivery = "not_sent", raw = null) {
  return new HerdrError(code, message, { method, local: true, delivery, raw });
}

function errorFromBody(body, method) {
  const code = typeof body?.code === "string" && body.code ? body.code : "unknown_error";
  return new HerdrError(code, body?.message ?? code, { method, raw: body, delivery: "response_received" });
}

function mapNetError(err, method, delivery = "not_sent") {
  const code = err?.code;
  if (code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES" || code === "ENOTSOCK") {
    return localError("server_unavailable", `Herdr socket 不可用（${code}）：${err.message}`, method, delivery, err);
  }
  return localError("connection_closed", `Herdr socket 读写失败（${code ?? "unknown"}）：${err?.message ?? err}`, method, delivery, err);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} 必须是正安全整数`);
  return value;
}

// 只保留一条未完成帧；容量倍增且不超过上限，避免按字符计数及小块累加的无界碎片。
class NdjsonReader {
  #max;
  #buffer;
  #size = 0;
  #decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  constructor(max) {
    this.#max = max;
    this.#buffer = Buffer.allocUnsafe(Math.min(4096, max));
  }
  push(chunk, onMessage) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let cursor = 0;
    while (cursor < bytes.length) {
      const nl = bytes.indexOf(10, cursor);
      const end = nl < 0 ? bytes.length : nl;
      const size = this.#size + end - cursor;
      if (size > this.#max) throw new Error(`NDJSON 帧超过 ${this.#max} bytes`);
      if (size > this.#buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(this.#max, Math.max(size, this.#buffer.length * 2)));
        this.#buffer.copy(grown, 0, 0, this.#size);
        this.#buffer = grown;
      }
      bytes.copy(this.#buffer, this.#size, cursor, end);
      this.#size = size;
      if (nl < 0) return;
      const length = size && this.#buffer[size - 1] === 13 ? size - 1 : size;
      const text = this.#decoder.decode(this.#buffer.subarray(0, length));
      this.#size = 0;
      const msg = JSON.parse(text);
      if (!isRecord(msg)) throw new Error("NDJSON 帧必须是 JSON 对象");
      if (onMessage(msg) === false) return;
      cursor = nl + 1;
    }
  }
}

function encodeRequest(id, method, params, max) {
  try {
    if (typeof method !== "string" || !method || !isRecord(params) || typeof params.toJSON === "function") throw new Error("method 必须是非空字符串，params 必须是对象");
    const frame = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(frame) > max) throw new Error(`请求帧超过 ${max} bytes`);
    return frame + "\n";
  } catch (err) {
    throw localError("invalid_request", `无法编码 Herdr 请求：${err.message}`, method, "not_sent", err);
  }
}

function responseResult(msg, id, method) {
  const error = Object.hasOwn(msg, "error");
  const result = Object.hasOwn(msg, "result");
  const validError = isRecord(msg.error) && typeof msg.error.code === "string" && msg.error.code.length > 0 && typeof msg.error.message === "string";
  // 唯一实测空 id 特例：服务端无法解码请求时返回 invalid_request 错误，不能放宽成功/其它错误。
  const invalidRequest = msg.id === "" && error && validError && msg.error.code === "invalid_request";
  if (typeof msg.id !== "string" || (msg.id !== id && !invalidRequest) || error === result
    || (error && !validError) || (result && (!isRecord(msg.result) || typeof msg.result.type !== "string" || !msg.result.type))) {
    throw localError("protocol_error", `${method} 应答 id / result / error 包络不合法`, method, "unknown");
  }
  if (error) throw errorFromBody(msg.error, method);
  return msg.result;
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
    throw localError("socket_path_unverified", "named-session 的 Socket 布局尚未核验；请显式配置 socketPath 或 HERDR_SOCKET_PATH", "");
  }
  return { path: path.join(base, "herdr.sock"), source: "default" };
}

// ---------- Lazy server readiness (transport probes never recurse) ----------

const serverStarts = new Map();
function canStartAfter(error) {
  return error instanceof HerdrError && error.local && error.delivery === "not_sent"
    && error.code === "server_unavailable" && ["ENOENT", "ECONNREFUSED"].includes(error.raw?.code);
}

function waitForStartup(promise, { signal, timeoutMs = 0, method = "ensureServerRunning" } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (err, result) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (err) reject(err); else resolve(result);
    };
    const abort = () => finish(localError("aborted", "只取消本地等待；共享 Herdr 启动不受影响", method, "not_sent"));
    promise.then(value => finish(null, value), finish);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => finish(localError("timeout", "等待 Herdr 自愈超时；原请求未送达", method, "not_sent")), timeoutMs);
  });
}

async function probeServer(socketPath, timeoutMs) {
  const probe = new HerdrControl({ socketPath, timeoutMs, connectTimeoutMs: timeoutMs });
  try {
    const pong = await probe.call("ping");
    if (pong.type !== "pong") throw localError("protocol_error", "Herdr readiness 必须返回 pong", "ping", "response_received");
    return assertProtocol(pong);
  } finally { probe.close(); }
}

// Herdr v0.9.5: session.rs:175-183 honors this environment override server-side;
// an explicit CLI --session would override it, so never append that flag here.
// ipc.rs:83-109 is check/remove/bind, NOT a single-instance lock. Serialize our
// starters with wx; never steal another owner's lock or unlink its socket.
export async function ensureServerRunning({
  socketPath, session = "", env = process.env, platform = process.platform,
  autoStart = true, signal, timeoutMs = 1000, startTimeoutMs = 5000,
  pollMs = 50, cooldownMs = 30_000, executable = "herdr", spawn = spawnProcess,
} = {}) {
  positiveInteger(timeoutMs, "timeoutMs"); positiveInteger(startTimeoutMs, "startTimeoutMs");
  positiveInteger(pollMs, "pollMs"); positiveInteger(cooldownMs, "cooldownMs");
  socketPath = discoverSocketPath({ socketPath, session, env, platform }).path;
  try { return await waitForStartup(probeServer(socketPath, timeoutMs), { signal }); }
  catch (error) { if (!autoStart || !canStartAfter(error)) throw error; }
  if (platform === "win32" || !path.isAbsolute(socketPath)) {
    throw localError("server_start_unsupported", "仅对已核验的绝对 Unix Socket 启动 Herdr；不猜 Windows/相对路径", "ensureServerRunning", "not_sent");
  }
  // Preserve the exact endpoint: lexical normalization changes symlink/.. semantics.
  if (signal?.aborted) throw localError("aborted", "已取消启动等待", "ensureServerRunning", "not_sent");
  let state = serverStarts.get(socketPath);
  if (!state) {
    state = { done: false, error: null, promise: null };
    serverStarts.set(socketPath, state);
    state.promise = startServer({ socketPath, session, env, startTimeoutMs, pollMs, cooldownMs, executable, spawn })
      .catch(error => { state.error = error; throw error; }).finally(() => { state.done = true; });
    state.promise.catch(() => {});
  } else if (state.done) {
    throw state.error ?? localError("server_start_limit", "该 Socket 在本进程已尝试启动一次；不因持续重连无限 spawn", "ensureServerRunning", "not_sent");
  }
  return waitForStartup(state.promise, { signal });
}

async function startServer({ socketPath, session, env, startTimeoutMs, pollMs, cooldownMs, executable, spawn }) {
  const deadline = performance.now() + startTimeoutMs;
  const lockPath = socketPath + ".ah-start.lock", attemptPath = socketPath + ".ah-start.attempt.json";
  let fd, identity, child, childFailure, lastError, lockBusy = false;
  const failed = (code, message, raw) => localError(code, message, "ensureServerRunning", "not_sent", raw);
  const childError = error => { childFailure = error; };
  const childExit = (code, signal) => { childFailure = { code: "CHILD_EXIT", exitCode: code, signal }; };
  try {
    try {
      const existing = fs.lstatSync(socketPath);
      if (!existing.isSocket()) throw failed("server_start_unsupported", "目标已存在但不是普通 Unix Socket；不让 Herdr 清理文件或符号链接", { code: "NOT_A_SOCKET" });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    try {
      fd = fs.openSync(lockPath, "wx", 0o600); identity = fs.fstatSync(fd);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    } catch (error) { if (error.code !== "EEXIST") throw error; lockBusy = true; }
    if (!lockBusy) {
      // Recheck after the exclusive claim: another starter may have just finished.
      try { return await probeServer(socketPath, Math.min(500, Math.max(1, deadline - performance.now()))); }
      catch (error) { if (!canStartAfter(error)) throw error; }
      let previous;
      try { previous = JSON.parse(fs.readFileSync(attemptPath, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (previous && (!Number.isFinite(previous.at) || Date.now() - previous.at < cooldownMs)) {
        throw failed("server_start_cooldown", "其它进程刚尝试过启动；冷却期间不再次 spawn", previous);
      }
      const sessionName = String(session || env?.HERDR_SESSION || "default").trim();
      if (!SESSION_NAME.test(sessionName)) throw failed("server_start_unsupported", "无法固定合法的 Herdr session", { sessionInvalid: true });
      const childEnv = { ...env, HERDR_SOCKET_PATH: socketPath, HERDR_SESSION: sessionName };
      delete childEnv.HERDR_CLIENT_SOCKET_PATH; delete childEnv.HERDR_STARTUP_CWD;
      // Persist before spawning; a failure still consumes the cooldown/budget.
      const temporary = attemptPath + "." + randomUUID();
      const attemptFd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(attemptFd, JSON.stringify({ at: Date.now(), pid: process.pid }));
        fs.fsyncSync(attemptFd);
        fs.renameSync(temporary, attemptPath); // replace a symlink, never follow it
      } finally { fs.closeSync(attemptFd); fs.rmSync(temporary, { force: true }); }
      if (performance.now() >= deadline) throw failed("server_start_timeout", "Herdr 启动总时限已到", { code: "DEADLINE" });
      child = spawn(executable, ["server"], { env: childEnv, detached: true, stdio: "ignore", shell: false });
      child.on("error", childError); child.once("exit", childExit); child.unref();
    }
    let pause = pollMs;
    while (performance.now() < deadline) {
      try { return await probeServer(socketPath, Math.min(500, Math.max(1, deadline - performance.now()))); }
      catch (error) {
        lastError = error;
        if (error.code === "timeout") throw failed("server_start_timeout", "Herdr readiness ping 未在启动时限内应答", error);
        if (!canStartAfter(error)) throw error;
      }
      if (childFailure) throw failed("server_start_failed", "Herdr 子进程启动失败或就绪前退出", childFailure);
      await new Promise(resolve => setTimeout(resolve, Math.min(pause, Math.max(1, deadline - performance.now()))));
      pause = Math.min(pause * 2, 250);
    }
    throw failed(lockBusy ? "server_start_locked" : "server_start_timeout",
      lockBusy ? "其它启动者持有锁且未就绪；可能为崩溃残留，请检查 owner 后处理，不自动抢锁" : "Herdr 未在总时限内 ping 就绪；不终止可能仍在启动的服务", lockBusy ? { lockPath, cause: lastError } : lastError);
  } catch (error) {
    if (error instanceof HerdrError) throw error;
    throw failed("server_start_failed", "Herdr 启动准备/执行失败", error);
  } finally {
    child?.removeListener("exit", childExit);
    // Keep the error observer: a detached child can report an asynchronous error.
    if (fd != null) {
      try { const current = fs.lstatSync(lockPath); if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(lockPath); } catch { /* never remove an unverified owner */ }
      fs.closeSync(fd);
    }
  }
}

// ---------- Control 通道 ----------

export class HerdrControl {
  #socketPath;
  #timeoutMs;
  #connectTimeoutMs;
  #maxFrameBytes;
  #maxInflight;
  #seq = 0;
  #inflight = new Map();
  #closed = false;
  #recover;
  #pendingCalls = 0;
  #lifetime = new AbortController();

  constructor({ socketPath, timeoutMs = DEFAULT_CALL_TIMEOUT_MS, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES, maxInflight = DEFAULT_MAX_INFLIGHT, recover } = {}) {
    if (!socketPath) throw new TypeError("HerdrControl 需要 socketPath");
    this.#socketPath = socketPath;
    this.#recover = recover;
    this.#maxFrameBytes = positiveInteger(maxFrameBytes, "maxFrameBytes");
    this.#maxInflight = positiveInteger(maxInflight, "maxInflight");
    this.#timeoutMs = timeoutMs;
    this.#connectTimeoutMs = connectTimeoutMs;
  }

  get inflightCount() {
    return this.#recover ? this.#pendingCalls : this.#inflight.size;
  }

  // 一次 RPC：成功返回 result 对象，失败抛 HerdrError。timeoutMs 含建连时间；0 或负数表示不设客户端超时。
  async call(method, params = {}, { timeoutMs = this.#timeoutMs, signal } = {}) {
    if (!this.#recover) return this.#callOnce(method, params, { timeoutMs, signal });
    if (this.#pendingCalls >= this.#maxInflight) throw localError("client_overloaded", "Herdr Control 在途请求达到上限", method);
    this.#pendingCalls++;
    const started = performance.now();
    signal = AbortSignal.any([this.#lifetime.signal, ...(signal ? [signal] : [])]);
    const remaining = () => timeoutMs > 0 ? Math.max(0, timeoutMs - (performance.now() - started)) : 0;
    try {
      if (this.#closed) throw localError("connection_closed", "HerdrControl 已关闭", method);
      if (signal.aborted) throw localError("aborted", "已取消", method);
      const id = `ah-${++this.#seq}`;
      const request = { id, frame: encodeRequest(id, method, params, this.#maxFrameBytes) };
      try { return await this.#callOnce(method, params, { timeoutMs, signal }, request); }
      catch (error) { if (!canStartAfter(error)) throw error; }
      if (timeoutMs > 0 && remaining() === 0) throw localError("timeout", "原请求等待时限已到", method, "not_sent");
      if (signal.aborted) throw localError("aborted", "已取消，不再请求自愈", method, "not_sent");
      try { await waitForStartup(this.#recover(), { signal, timeoutMs: remaining(), method }); }
      catch (error) { throw localError(error.code, error.message, method, "not_sent", error); }
      if (timeoutMs > 0 && remaining() === 0) throw localError("timeout", "原请求等待时限已到", method, "not_sent");
      // Exactly one retry, only after the first attempt was provably not sent.
      return await this.#callOnce(method, params, { timeoutMs: remaining(), signal }, request);
    } finally { this.#pendingCalls--; }
  }

  #callOnce(method, params = {}, { timeoutMs = this.#timeoutMs, signal } = {}, request) {
    if (this.#closed) return Promise.reject(localError("connection_closed", "HerdrControl 已关闭", method));
    if (signal?.aborted) return Promise.reject(localError("aborted", `${method} 已被取消`, method));
    if (this.#inflight.size >= this.#maxInflight) return Promise.reject(localError("client_overloaded", "Herdr Control 在途请求达到上限", method));
    const id = request?.id ?? `ah-${++this.#seq}`;
    let frame;
    try { frame = request?.frame ?? encodeRequest(id, method, params, this.#maxFrameBytes); }
    catch (err) { return Promise.reject(err); }

    return new Promise((resolve, reject) => {
      let socket;
      try { socket = net.createConnection(this.#socketPath); }
      catch (err) { reject(mapNetError(err, method)); return; }
      const reader = new NdjsonReader(this.#maxFrameBytes);
      let settled = false, sent = false;
      let timer = null, connectTimer = null;
      const delivery = () => sent ? "unknown" : "not_sent";
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(connectTimer);
        signal?.removeEventListener("abort", onAbort);
        this.#inflight.delete(id);
        socket.destroy();
        if (err) reject(err); else resolve(value);
      };
      const onAbort = () => finish(localError("aborted", `${method} 本地等待已取消（不代表远端取消）`, method, delivery()));
      this.#inflight.set(id, { method, abort: () => finish(localError("connection_closed", "HerdrControl 已关闭", method, delivery())) });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      if (timeoutMs > 0) timer = setTimeout(() => finish(localError("timeout", `${method} 客户端等待超过 ${timeoutMs}ms（远端可能仍执行）`, method, delivery())), timeoutMs);
      if (this.#connectTimeoutMs > 0) connectTimer = setTimeout(() => finish(localError("server_unavailable", `连接 Herdr socket 超时（${this.#connectTimeoutMs}ms）`, method, delivery())), this.#connectTimeoutMs);
      socket.on("connect", () => {
        if (settled) return;
        clearTimeout(connectTimer);
        // write 开始即不能证明未送达；不因超时/断连重试任何 Control 请求。
        sent = true;
        try { socket.write(frame); } catch (err) { finish(mapNetError(err, method, delivery())); }
      });
      socket.on("data", (chunk) => {
        if (settled) return;
        try {
          reader.push(chunk, (msg) => { finish(null, responseResult(msg, id, method)); return false; });
        } catch (err) {
          finish(err instanceof HerdrError ? err : localError("protocol_error", `${method} NDJSON 应答无效：${err.message}`, method, delivery(), err));
        }
      });
      socket.on("error", (err) => finish(mapNetError(err, method, delivery())));
      socket.on("close", () => finish(localError("connection_closed", `${method} 在收到完整应答前连接被关闭`, method, delivery())));
    });
  }

  close() {
    this.#closed = true;
    this.#lifetime.abort();
    for (const entry of [...this.#inflight.values()]) {
      entry.abort();
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
  if (s.includes(".")) return s;
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
//   ready({generation, attempts}) 首次订阅确认
//   reconnected({generation, downtimeMs}) 重新确认；L2 必须以代际 fence session.snapshot/定向读取
//   lost(error)              收到 events_lost，缓存已陈旧，随后自动重连
//   event({event, raw, data, generation}) 推送事件，仅作失效信号；不在协议层实现快照合并
//   disconnected(reason)     连接断开
//   subscribe_error(error)   订阅被拒（如 pane_not_found）；消费方可在退避期内剪掉失效订阅
//   protocol_error(error)    非法帧后断开；消费方必须失效缓存并在重连后对账
//   fatal(error)             订阅请求本身非法（invalid_request），不再重试
export class HerdrEvents extends EventEmitter {
  #socketPath;
  #provider;
  #recover;
  #lifetime = new AbortController();
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
  #generation = 0;
  #activeReady = false;
  #endSession = null;
  #maxFrameBytes;

  constructor({
    socketPath,
    recover,
    subscriptions = LIFECYCLE_SUBSCRIPTIONS,
    backoff = {},
    random = Math.random,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  } = {}) {
    super();
    if (!socketPath) throw new TypeError("HerdrEvents 需要 socketPath");
    this.#socketPath = socketPath;
    this.#provider = subscriptions;
    this.#recover = recover;
    this.#backoff = backoff;
    this.#random = random;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#ackTimeoutMs = positiveInteger(ackTimeoutMs, "ackTimeoutMs");
    this.#maxFrameBytes = positiveInteger(maxFrameBytes, "maxFrameBytes");
  }

  get ready() {
    return this.#activeReady && !this.#stopped;
  }

  get generation() { return this.#generation; }

  // 首次订阅确认后 resolve；服务端没起来时持续退避重试，stop() 会让它 reject。
  start() {
    if (this.#stopped) return Promise.reject(localError("connection_closed", "HerdrEvents 已停止，不能重新启动", "events.subscribe"));
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
    this.#generation++;
    this.#activeReady = false;
    this.#endSession?.("refresh");
    this.#wakeSleep?.();
  }

  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#lifetime.abort();
    this.#generation++;
    this.#activeReady = false;
    this.#endSession?.("stopped");
    this.#wakeSleep?.();
    if (!this.#everReady) this.#readyReject?.(localError("connection_closed", "HerdrEvents 在订阅确认前被停止", "events.subscribe"));
  }

  async #run() {
    while (!this.#stopped) {
      let outcome;
      try {
        outcome = await this.#session();
      } catch (e) {
        if (this.#stopped) break;
        const err = e instanceof HerdrError ? e : localError("subscription_provider_failed", `订阅 provider 失败：${e.message}`, "events.subscribe", "not_sent", e);
        if (err.code === "invalid_request") {
          this.#stopped = true;
          this.#readyReject?.(err);
          this.emit("fatal", err);
          break;
        }
        this.emit("subscribe_error", err);
        outcome = { reason: "error", error: err };
      }
      if (this.#stopped || outcome.reason === "fatal") break;
      if (this.#recover && canStartAfter(outcome.error)) {
        try { await waitForStartup(this.#recover(), { signal: this.#lifetime.signal, method: "events.subscribe" }); }
        catch (error) {
          if (this.#stopped) break;
          this.#stopped = true; this.#readyReject?.(error); this.emit("fatal", error); break;
        }
        continue;
      }
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
    const generation = ++this.#generation;
    let subscriptions;
    try { subscriptions = typeof this.#provider === "function" ? await this.#provider() : this.#provider; }
    catch (err) { if (this.#stopped || generation !== this.#generation) return { reason: "refresh" }; throw err; }
    if (this.#stopped || generation !== this.#generation) return { reason: "refresh" };
    if (!Array.isArray(subscriptions)) throw localError("invalid_request", "subscriptions 必须是数组", "events.subscribe");
    const id = `ev-${++this.#seq}`;
    const frame = encodeRequest(id, "events.subscribe", { subscriptions }, this.#maxFrameBytes);
    return new Promise((resolve, reject) => {
      let socket;
      try { socket = net.createConnection(this.#socketPath); }
      catch (err) { reject(mapNetError(err, "events.subscribe")); return; }
      this.#socket = socket;
      socket.setKeepAlive(true);
      const reader = new NdjsonReader(this.#maxFrameBytes);
      let acked = false, done = false, sent = false;
      let ackTimer = null, connectTimer = null;
      const current = () => !done && !this.#stopped && generation === this.#generation;
      const delivery = () => sent ? "unknown" : "not_sent";
      const end = (reason, error = null) => {
        if (done) return;
        done = true;
        clearTimeout(ackTimer);
        clearTimeout(connectTimer);
        if (this.#socket === socket) { this.#socket = null; this.#activeReady = false; }
        if (this.#endSession === end) this.#endSession = null;
        socket.destroy();
        if (acked) this.#lastDownAt = Date.now();
        if (!this.#stopped) this.emit("disconnected", reason, { generation, error });
        resolve({ reason, acked, error });
      };
      this.#endSession = end;
      const protocolFailure = (error) => {
        if (!current()) return;
        const err = error instanceof HerdrError ? error : localError("protocol_error", `事件 NDJSON 帧无效：${error.message}`, "events.subscribe", delivery(), error);
        // 先 fence，再通知外部；listener 同步 stop/refresh 也不能放出同包后续帧。
        end("protocol_error", err);
        if (!this.#stopped) this.emit("protocol_error", err);
      };
      if (this.#connectTimeoutMs > 0) connectTimer = setTimeout(() => {
        if (!current()) return;
        const err = localError("server_unavailable", "事件连接超时", "events.subscribe", delivery());
        end("connect_timeout", err);
        if (!this.#stopped) this.emit("subscribe_error", err);
      }, this.#connectTimeoutMs);
      socket.on("connect", () => {
        if (!current()) return;
        clearTimeout(connectTimer);
        ackTimer = setTimeout(() => {
          if (!current()) return;
          const err = localError("timeout", "events.subscribe ACK 超时；仅结束本地订阅等待", "events.subscribe", delivery());
          end("ack_timeout", err);
          if (!this.#stopped) this.emit("subscribe_error", err);
        }, this.#ackTimeoutMs);
        sent = true;
        try { socket.write(frame); } catch (err) { end("closed", mapNetError(err, "events.subscribe", delivery())); }
      });
      socket.on("data", (chunk) => {
        if (!current()) return;
        try {
          reader.push(chunk, (msg) => {
            if (!current()) return false;
            if (!acked || Object.hasOwn(msg, "error")) {
              let result;
              try { result = responseResult(msg, id, "events.subscribe"); }
              catch (err) {
                if (err.local) { protocolFailure(err); return false; }
                if (err.category === "events_lost") {
                  end("lost", err);
                  if (!this.#stopped && generation === this.#generation) this.emit("lost", err);
                } else if (!acked && err.category === "invalid_request") {
                  this.#stopped = true;
                  end("fatal", err);
                  this.#readyReject?.(err);
                  this.emit("fatal", err);
                } else {
                  end("subscribe_error", err);
                  if (!this.#stopped && generation === this.#generation) this.emit("subscribe_error", err);
                }
                return false;
              }
              if (acked || result.type !== "subscription_started") { protocolFailure(new Error("订阅 ACK 类型不匹配")); return false; }
              acked = true;
              this.#activeReady = true;
              clearTimeout(ackTimer);
              const info = { generation, attempts: this.#failures + 1 };
              if (!this.#everReady) {
                this.#everReady = true;
                this.#readyResolve?.(info);
                this.emit("ready", info);
              } else {
                this.emit("reconnected", { generation, downtimeMs: this.#lastDownAt ? Date.now() - this.#lastDownAt : 0 });
              }
            } else {
              if (typeof msg.event !== "string" || !msg.event || !isRecord(msg.data)
                || (msg.event.includes("_") && !msg.event.includes(".") && msg.data.type !== msg.event)
                || Object.hasOwn(msg, "id") || Object.hasOwn(msg, "result")) {
                protocolFailure(new Error("事件包络／全局 EventData.type 不匹配")); return false;
              }
              this.emit("event", { event: normalizeEventName(msg.event), raw: msg.event, data: msg.data, generation });
            }
            return current();
          });
        } catch (err) { protocolFailure(err); }
      });
      socket.on("error", (err) => { if (current()) end("closed", mapNetError(err, "events.subscribe", delivery())); });
      socket.on("close", () => { if (current()) end("closed", localError("connection_closed", "事件连接在完整帧前关闭", "events.subscribe", delivery())); });
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
  maxFrameBytes,
  maxInflight,
  connectTimeoutMs,
  ackTimeoutMs,
  autoStart = true,
  serverOptions = {},
} = {}) {
  const found = discoverSocketPath({ socketPath, session, env, platform });
  const ensure = (opts = {}) => ensureServerRunning({ ...serverOptions, ...opts, socketPath: found.path, session, env, platform, autoStart: autoStart && opts.autoStart !== false });
  const recover = autoStart ? () => ensure() : undefined;
  const control = new HerdrControl({ socketPath: found.path, timeoutMs, maxFrameBytes, maxInflight, connectTimeoutMs, recover });
  const events = new HerdrEvents({ socketPath: found.path, subscriptions, backoff, random, maxFrameBytes, connectTimeoutMs, ackTimeoutMs, recover });
  return {
    socketPath: found.path,
    source: found.source,
    ensureServerRunning: ensure,
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
