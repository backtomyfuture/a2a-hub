// Herdr 运行时（L2）：Socket API 事件驱动的拓扑缓存、Per-Agent 串行派发、异常分级与文件信封门禁。
//
// 分层与铁律（本文件只负责「执行与传输」，任务状态与产物真相源在 a2a-hub 本地持久化层）：
//   - 终端只传指针：agent.prompt 的文本必须是 <=300 字节的单行指针，上下文与验收契约全部落盘为文件信封。
//   - 事件只是缓存失效信号：启动/重连严格 events.subscribe -> session.snapshot，之后只做定向 agent.get / pane.get。
//   - idle/done 只是「交卷」：本层只报告 settled，是否通过由 checkResultGate 的确定性门禁（含 attempt_id）决定。
//   - agent.read 仅用于 blocked 弹窗送审与失败诊断，输出绝不流入下游业务。
//
// 不 fork herdr CLI。进程保活、隔离和事件都走 Herdr Socket。
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { safeTaskId } from "./direct-ledger.mjs";
import {
  assertProtocol, backoffDelay, createHerdrSocket, HerdrError, LIFECYCLE_SUBSCRIPTIONS, paneStatusSubscription,
} from "./herdr-socket.mjs";

const RESERVED_AH_ENV = new Set([
  "AH_TASK_ID",
  "AH_NODE",
  "AH_WORKER",
  "AH_RUN_DIR",
  "AH_INPUT_PATH",
  "AH_RECEIPT_PATH",
]);

export function herdrRunDir(configDir, taskId) {
  return path.join(configDir, "runs", safeTaskId(taskId));
}

export function herdrLedgerPath(configDir, taskId) {
  return path.join(herdrRunDir(configDir, taskId), "herdr.json");
}

export function herdrReceiptPath(configDir, taskId) {
  return path.join(herdrRunDir(configDir, taskId), "receipt.txt");
}

// Herdr 要求 agent name 匹配 ^[a-z][a-z0-9_-]{0,31}$ 且唯一。
export function herdrAgentName(taskId) {
  const body = String(taskId ?? "")
    .toLowerCase()
    .replace(/^task-/, "")
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+/, "");
  return `ah-${body || "task"}`.slice(0, 32);
}

export function readHerdrLedger(configDir, taskId) {
  let file;
  try {
    file = herdrLedgerPath(configDir, taskId);
  } catch {
    return { broken: true };
  }
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    return { broken: true };
  }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return { broken: true };
    return data;
  } catch {
    return { broken: true };
  }
}

export function saveHerdrLedger(configDir, ledger) {
  const dest = herdrLedgerPath(configDir, ledger.task_id);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(dest), 0o700); } catch { /* 目录权限失败不挡住账本 */ }
  const tmp = dest + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o600);
  return dest;
}

export function deleteHerdrLedger(configDir, taskId) {
  let file;
  try {
    file = herdrLedgerPath(configDir, taskId);
  } catch {
    return;
  }
  for (const p of [file, `${file}.tmp`]) {
    try { fs.unlinkSync(p); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  }
}

export function listHerdrLedgers(configDir) {
  const runsRoot = path.join(configDir, "runs");
  let names;
  try {
    names = fs.readdirSync(runsRoot);
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const taskId of names) {
    if (!/^[\w-]+$/.test(taskId)) continue;
    const ledger = readHerdrLedger(configDir, taskId);
    if (ledger) out.push({ taskId, ledger });
  }
  return out;
}

// ======================================================================
// 文件信封与确定性门禁（纯函数 + 原子落盘）
// ======================================================================

// macOS PTY 的 canonical 行长度上限很小，长正文会被截断或卡在行缓冲里，所以终端只传指针。
export const MAX_POINTER_PROMPT_BYTES = 300;
export const ENVELOPE_SCHEMA = "a2a-hub/herdr-envelope@1";
export const RESULT_SCHEMA = "a2a-hub/herdr-result@1";
const MAX_RESULT_BYTES = 8 * 1024 * 1024;

export class PointerPromptError extends Error {
  constructor(message) {
    super(message);
    this.name = "PointerPromptError";
  }
}

// 超限一律报错而不是截断：截断的指针会让 Agent 读到半截路径，比失败更难排查。
export function assertPointerPrompt(text) {
  const s = String(text ?? "");
  if (!s.trim()) throw new PointerPromptError("指针 prompt 不能为空");
  if (/[\r\n]/.test(s)) throw new PointerPromptError("指针 prompt 必须是单行，换行可能在终端里被提前当作提交");
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes > MAX_POINTER_PROMPT_BYTES) {
    throw new PointerPromptError(`指针 prompt 为 ${bytes} 字节，超过 ${MAX_POINTER_PROMPT_BYTES} 字节上限`);
  }
  return bytes;
}

export function herdrAttemptPaths(configDir, taskId, attemptNo) {
  const n = Number(attemptNo);
  if (!Number.isInteger(n) || n < 1) throw new Error("attemptNo 必须是 >=1 的整数");
  const dir = path.join(herdrRunDir(configDir, taskId), "herdr", `attempt-${n}`);
  return {
    dir,
    envelope: path.join(dir, "envelope.json"),
    result: path.join(dir, "result.json"),
    repair: path.join(dir, "repair.json"),
  };
}

// attempt_id 每次派发唯一。Agent 回写时必须原样带回，旧 attempt 的残留文件因此无法冒充本次结果。
export function newAttemptId(attemptNo, random = randomBytes) {
  return `att_${Number(attemptNo)}_${random(4).toString("hex")}`;
}

// 先写 .tmp 再 rename：读取方要么看到完整文件，要么看不到，不会读到半截 JSON。
export function atomicWriteFile(dest, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  try { fs.chmodSync(tmp, mode); } catch { /* 权限收紧失败不挡写入 */ }
  fs.renameSync(tmp, dest);
  return dest;
}

// 写 Attempt 信封。envelope 的业务内容（输入路径、验收清单、修复违规项）由 L3 决定，这里只落盘并固定标识字段。
export function writeAttemptEnvelope({ configDir, taskId, runId, attemptNo, attemptId, envelope = {} }) {
  const paths = herdrAttemptPaths(configDir, taskId, attemptNo);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(paths.dir, 0o700); } catch { /* 目录权限失败不挡信封落盘 */ }
  const body = {
    ...envelope,
    schema: ENVELOPE_SCHEMA,
    task_id: String(taskId),
    run_id: String(runId ?? ""),
    attempt_no: Number(attemptNo),
    attempt_id: String(attemptId),
    result_path: paths.result,
    result_schema: {
      schema: RESULT_SCHEMA,
      required: ["schema", "attempt_id", "receipt_text"],
      note: "原子写入：先写 result.json.tmp 再 rename 为 result.json；attempt_id 必须原样回填",
    },
    created_at: new Date().toISOString(),
  };
  atomicWriteFile(paths.envelope, JSON.stringify(body, null, 2));
  return { ...paths, attemptId: body.attempt_id };
}

// 单行指针：只含信封绝对路径与 attempt_id，其余约束都在信封文件里。
export function buildPointerPrompt({ envelopePath, attemptId, repair = false }) {
  const lead = repair ? "A2A repair" : "A2A task";
  const text = `${lead}: read ${envelopePath} and follow it exactly. attempt_id=${attemptId}. Write result.json atomically (tmp+rename).`;
  assertPointerPrompt(text);
  return text;
}

// 确定性门禁：文件原子落盘（无 .tmp 残留）+ JSON/Schema 合法 + attempt_id 匹配。
// 返回 violations 供 Repair Loop 写进下一轮信封；本函数只读文件，不看终端屏幕。
export function checkResultGate({ resultPath, attemptId, runId = "", taskId = "" }) {
  const violations = [];
  const fail = (code, message) => violations.push({ code, message });
  const tmpExists = fs.existsSync(`${resultPath}.tmp`);
  if (tmpExists) fail("tmp_residue", "result.json.tmp 仍然存在：写入未以 rename 收尾");

  let text = null;
  try {
    const st = fs.statSync(resultPath);
    if (st.size > MAX_RESULT_BYTES) fail("too_large", `result.json 为 ${st.size} 字节，超过 ${MAX_RESULT_BYTES}`);
    else text = fs.readFileSync(resultPath, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") fail("missing", "result.json 不存在");
    else throw e;
  }
  if (text === null) return { ok: false, violations, result: null };

  let result;
  try {
    result = JSON.parse(text);
  } catch (e) {
    fail("not_json", `result.json 不是合法 JSON：${e.message}`);
    return { ok: false, violations, result: null };
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    fail("bad_schema", "result.json 顶层必须是对象");
    return { ok: false, violations, result: null };
  }
  if (result.schema !== RESULT_SCHEMA) fail("bad_schema", `schema 必须是 ${RESULT_SCHEMA}`);
  if (typeof result.receipt_text !== "string" || !result.receipt_text.trim()) {
    fail("empty_receipt", "receipt_text 必须是非空字符串");
  }
  if (result.attempt_id !== attemptId) {
    fail("attempt_mismatch", `attempt_id 不匹配：期望 ${attemptId}，实际 ${String(result.attempt_id ?? "").slice(0, 64) || "缺失"}`);
  }
  if (runId && result.run_id !== undefined && result.run_id !== runId) fail("run_mismatch", "run_id 不匹配");
  if (taskId && result.task_id !== undefined && result.task_id !== taskId) fail("task_mismatch", "task_id 不匹配");
  return { ok: violations.length === 0, violations, result: violations.length === 0 ? result : null };
}

// Herdr 在 tab/pane 创建时自己注入 HERDR_*，冲突时它说了算；A2A_*、AH_* 是本系统追踪元数据，用户 env 不得覆盖。
export function buildLaunchEnv({
  taskId, runId = "", attemptId = "", node = "", worker = "", runDir = "",
  inputPath = "", receiptPath = "", envelopePath = "", extra = {},
}) {
  const out = {};
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const [k, v] of Object.entries(extra)) {
      const key = String(k ?? "").trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (key.startsWith("HERDR_") || key.startsWith("A2A_") || RESERVED_AH_ENV.has(key)) continue;
      if (v === undefined || v === null) continue;
      out[key] = String(v);
    }
  }
  Object.assign(out, {
    A2A_TASK_ID: String(taskId ?? ""),
    A2A_RUN_ID: String(runId ?? ""),
    A2A_ATTEMPT_ID: String(attemptId ?? ""),
    A2A_NODE: String(node ?? ""),
    A2A_ENVELOPE_PATH: String(envelopePath ?? ""),
    AH_TASK_ID: String(taskId ?? ""),
    AH_NODE: String(node ?? ""),
    AH_WORKER: String(worker ?? ""),
    AH_RUN_DIR: String(runDir ?? ""),
    AH_INPUT_PATH: String(inputPath ?? ""),
    AH_RECEIPT_PATH: String(receiptPath ?? ""),
  });
  return out;
}

// ======================================================================
// HerdrRuntime：拓扑缓存 + 派发 + 异常矩阵
// ======================================================================

const SETTLED_STATES = ["idle", "done"];
const SETTLE_UNTIL = ["idle", "done", "blocked"];
const LEAVE_BLOCKED_UNTIL = ["working", "idle", "done"];
// 订阅类事件里这些只触发整张快照刷新（低频、结构性变化）；pane 级事件走定向刷新。
const STRUCTURAL_EVENT = /^(workspace|worktree|tab|layout)\./;

const DEFAULT_OPTIONS = Object.freeze({
  waitSliceMs: 60_000,        // 单次 agent.wait 的服务端等待片，超时不等于失败
  guardWaitMs: 30_000,        // 派发前等待旧 turn 收尾的上限，超过返回 busy 交调用方排队
  leaveBlockedMs: 15_000,     // 注入审批按键后等待离开 blocked 的上限
  stallRetryMax: 2,
  stallBackoff: Object.freeze({ baseMs: 400, maxMs: 3000, jitter: 0.25 }),
  popupLines: 80,
  startTimeoutMs: 45_000,
  invalidateDebounceMs: 20,
  subscriptionRefreshDebounceMs: 50,
});

export class HerdrRuntime extends EventEmitter {
  #socket;
  #opts;
  #log;
  #now;
  #random;
  #bindings = new Map();
  #workspaces = new Map();
  #tabs = new Map();
  #panes = new Map();
  #agents = new Map(); // pane_id -> AgentInfo
  #stale = true;
  #started = false;
  #stopped = false;
  #chain = Promise.resolve();
  #snapshotInFlight = null;
  #snapshotAgain = false;
  #dirtyPanes = new Set();
  #flushTimer = null;
  #subTimer = null;
  #locks = new Map();
  #waiters = new Map();
  #workspaceIds = new Map(); // label -> workspace_id

  constructor({ socket, log = () => {}, now = Date.now, random = Math.random, ...opts } = {}) {
    super();
    if (!socket?.call || !socket?.events) throw new TypeError("HerdrRuntime 需要 createHerdrSocket 的返回值");
    this.#socket = socket;
    this.#log = log;
    this.#now = now;
    this.#random = random;
    this.#opts = { ...DEFAULT_OPTIONS, ...opts };
    socket.events.on("event", (ev) => this.#onEvent(ev));
    socket.events.on("reconnected", () => this.#onReconnected());
    socket.events.on("lost", () => { this.#stale = true; });
    socket.events.on("disconnected", () => { this.#stale = true; });
    socket.events.on("subscribe_error", (err) => this.#onSubscribeError(err));
    socket.events.on("fatal", (err) => this.#note("事件订阅被服务端拒绝且不会重试", err));
  }

  get stale() { return this.#stale; }

  // 拓扑只读视图（给 doctor / 诊断用）。派发路径从不依赖它，全部走实时 agent.get。
  topology() {
    return {
      stale: this.#stale,
      workspaces: [...this.#workspaces.values()],
      tabs: [...this.#tabs.values()],
      panes: [...this.#panes.values()],
      agents: [...this.#agents.values()],
    };
  }

  binding(agentName) { return this.#bindings.get(agentName) ?? null; }
  pendingDispatches(agentName) { return this.#waiters.get(agentName) ?? 0; }

  // ---------- 生命周期 ----------

  // 严格顺序：先订阅（避免漏掉快照之后的变化）→ 再快照。
  async start() {
    if (this.#started) return;
    this.#started = true;
    await this.#socket.events.start();
    await this.refreshSnapshot();
    this.emit("ready");
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#flushTimer);
    clearTimeout(this.#subTimer);
    this.#socket.close();
  }

  // ---------- 拓扑缓存 ----------

  #serial(fn) {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  // 合并并发请求：快照进行中再来请求只标记「再刷一次」，保证事件在读取过程中到达也不会被漏掉。
  refreshSnapshot() {
    if (this.#snapshotInFlight) {
      this.#snapshotAgain = true;
      return this.#snapshotInFlight;
    }
    const run = this.#serial(async () => {
      do {
        this.#snapshotAgain = false;
        const res = await this.#call("session.snapshot", {});
        const snap = res?.snapshot ?? res;
        assertProtocol(snap);
        this.#workspaces = new Map((snap.workspaces ?? []).map((w) => [w.workspace_id, w]));
        this.#tabs = new Map((snap.tabs ?? []).map((t) => [t.tab_id, t]));
        this.#panes = new Map((snap.panes ?? []).map((p) => [p.pane_id, p]));
        this.#agents = new Map((snap.agents ?? []).map((a) => [a.pane_id, a]));
        this.#stale = false;
      } while (this.#snapshotAgain && !this.#stopped);
    }).finally(() => { this.#snapshotInFlight = null; });
    this.#snapshotInFlight = run;
    return run;
  }

  #invalidatePane(paneId) {
    if (!paneId) return;
    this.#dirtyPanes.add(String(paneId));
    if (this.#flushTimer || this.#stopped) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.#flushDirtyPanes();
    }, this.#opts.invalidateDebounceMs);
    this.#flushTimer.unref?.();
  }

  // 定向刷新：只对失效的 pane 做 pane.get / agent.get。刷新期间新到的失效继续落在 dirty 集合里，循环到清空。
  #flushDirtyPanes() {
    return this.#serial(async () => {
      while (this.#dirtyPanes.size && !this.#stopped) {
        const batch = [...this.#dirtyPanes];
        this.#dirtyPanes.clear();
        for (const paneId of batch) {
          try {
            await this.#refreshPaneNow(paneId);
          } catch (err) {
            this.#note(`定向刷新 ${paneId} 失败，改做整张快照`, err);
            this.#stale = true;
            void this.refreshSnapshot().catch((e) => this.#note("兜底快照失败", e));
          }
        }
      }
    }).catch((err) => this.#note("pane 刷新队列异常", err));
  }

  async #refreshPaneNow(paneId) {
    try {
      const res = await this.#call("pane.get", { pane_id: paneId });
      const pane = res?.pane;
      if (pane) this.#panes.set(paneId, pane);
    } catch (err) {
      if (err?.category !== "not_found") throw err;
      this.#panes.delete(paneId);
      this.#agents.delete(paneId);
      this.emit("pane_gone", { paneId });
      return;
    }
    try {
      const res = await this.#call("agent.get", { target: paneId });
      if (res?.agent) this.#agents.set(paneId, res.agent);
    } catch (err) {
      if (err?.category !== "not_found") throw err;
      this.#agents.delete(paneId);
    }
  }

  #onEvent({ event, data }) {
    if (this.#stopped) return;
    try {
      if (event === "pane.moved") {
        this.#onPaneMoved(data);
        return;
      }
      if (event === "pane.closed" || event === "pane.exited") {
        const paneId = data?.pane_id;
        this.#panes.delete(paneId);
        this.#agents.delete(paneId);
        this.emit("pane_gone", { paneId, event });
        this.#scheduleSubscriptionRefresh();
        return;
      }
      if (event === "pane.agent_status_changed") {
        const paneId = data?.pane_id;
        const b = [...this.#bindings.values()].find((x) => x.paneId === paneId);
        this.#invalidatePane(paneId);
        // 仅作唤醒提示：消费方被叫醒后必须自己 agent.get / agent.wait 复核，不能直接信这里的 status。
        this.emit("agent_status", { paneId, agentName: b?.agentName ?? "", hint: data?.agent_status ?? null });
        return;
      }
      if (event.startsWith("pane.")) {
        this.#invalidatePane(data?.pane?.pane_id ?? data?.pane_id);
        this.#scheduleSubscriptionRefresh();
        return;
      }
      if (STRUCTURAL_EVENT.test(event)) {
        this.#stale = true;
        void this.refreshSnapshot().catch((e) => this.#note("结构事件后的快照失败", e));
      }
    } catch (err) {
      this.#note(`处理事件 ${event} 失败`, err);
    }
  }

  // pane.moved：事件只提供「谁挪到了哪」，绑定原地刷新 pane_id；缓存仍通过定向 pane.get 校正。
  #onPaneMoved(data) {
    const prev = data?.previous_pane_id;
    const next = data?.pane;
    if (!prev || !next?.pane_id) {
      this.#stale = true;
      void this.refreshSnapshot().catch((e) => this.#note("pane.moved 载荷不全，快照失败", e));
      return;
    }
    for (const b of this.#bindings.values()) {
      if (b.paneId !== prev) continue;
      b.paneId = next.pane_id;
      b.workspaceId = next.workspace_id ?? b.workspaceId;
      b.tabId = next.tab_id ?? b.tabId;
      this.emit("binding_changed", b, { reason: "pane_moved", previousPaneId: prev });
    }
    this.#panes.delete(prev);
    this.#agents.delete(prev);
    this.#invalidatePane(next.pane_id);
    this.#scheduleSubscriptionRefresh();
  }

  #onReconnected() {
    this.#stale = true;
    void this.#resync("reconnected");
  }

  // 重连后事件可能已经丢失：整张快照 + 对账全部绑定，之后才重新相信缓存。
  async #resync(reason) {
    try {
      await this.refreshSnapshot();
      const results = await this.reconcile([...this.#bindings.values()]);
      this.emit("resynced", { reason, results });
    } catch (err) {
      this.#note(`重连后对账失败（${reason}）`, err);
    }
  }

  // pane 级订阅只要有一个 pane 不存在，整条订阅就会被拒并断连：先刷新拓扑，下一次退避重订时就会剪掉失效 pane。
  #onSubscribeError(err) {
    this.#note("事件订阅被拒，刷新拓扑后重订", err);
    void this.refreshSnapshot().catch((e) => this.#note("订阅被拒后的快照失败", e));
  }

  // 订阅集合 = 全局拓扑事件 + 已绑定且确实存在的 pane 状态事件。
  subscriptions() {
    const subs = [...LIFECYCLE_SUBSCRIPTIONS];
    const seen = new Set();
    for (const b of this.#bindings.values()) {
      if (!b.paneId || seen.has(b.paneId) || !this.#panes.has(b.paneId)) continue;
      seen.add(b.paneId);
      subs.push(paneStatusSubscription(b.paneId));
    }
    return subs;
  }

  #scheduleSubscriptionRefresh() {
    if (this.#subTimer || this.#stopped) return;
    this.#subTimer = setTimeout(() => {
      this.#subTimer = null;
      this.#socket.events.refresh();
    }, this.#opts.subscriptionRefreshDebounceMs);
    this.#subTimer.unref?.();
  }

  // ---------- 绑定与对账 ----------

  track(binding) {
    this.#bindings.set(binding.agentName, binding);
    this.#scheduleSubscriptionRefresh();
    return binding;
  }

  untrack(agentName) {
    this.#bindings.delete(agentName);
    this.#scheduleSubscriptionRefresh();
  }

  // 启动 / 重连对账。稳定语义名 agent_name 优先（pane 被移动后名字跟着占用者走），
  // 找不到再按 pane_id 判断是「Agent 已退出但 pane 还在」还是「整块丢了」。
  async reconcile(persisted = []) {
    const results = [];
    for (const item of persisted) {
      const agentName = String(item?.agentName ?? item?.agent_name ?? "");
      if (!agentName) continue;
      const known = {
        taskId: item.taskId ?? item.task_id ?? "",
        agentName,
        paneId: item.paneId ?? item.pane_id ?? "",
        workspaceId: item.workspaceId ?? item.workspace_id ?? "",
        tabId: item.tabId ?? item.tab_id ?? "",
        worktreePath: item.worktreePath ?? item.worktree_path ?? "",
        branch: item.branch ?? "",
        kind: item.kind ?? "",
      };
      const live = this.#bindings.get(agentName) ?? known;
      let state;
      const agent = await this.#findAgent(agentName);
      if (agent) {
        const moved = agent.pane_id !== live.paneId;
        const prev = live.paneId;
        live.paneId = agent.pane_id;
        live.workspaceId = agent.workspace_id ?? live.workspaceId;
        live.tabId = agent.tab_id ?? live.tabId;
        this.#agents.set(agent.pane_id, agent);
        state = moved ? "moved" : "alive";
        if (moved) this.emit("binding_changed", live, { reason: "reconcile", previousPaneId: prev });
        this.#bindings.set(agentName, live);
      } else {
        let paneAlive = false;
        if (live.paneId) {
          try {
            await this.#call("pane.get", { pane_id: live.paneId });
            paneAlive = true;
          } catch (err) {
            if (err?.category !== "not_found") throw err;
          }
        }
        state = paneAlive ? "agent_gone" : "lost";
        if (state === "lost") this.#bindings.delete(agentName);
      }
      results.push({ taskId: live.taskId, agentName, state, binding: live });
    }
    this.#scheduleSubscriptionRefresh();
    return results;
  }

  // ---------- 启动 / 关闭 Agent ----------

  async ensureWorkspace(label = "a2a-hub") {
    const wsLabel = String(label ?? "").trim() || "a2a-hub";
    const cached = this.#workspaceIds.get(wsLabel);
    if (cached && this.#workspaces.has(cached)) return cached;
    const listed = await this.#call("workspace.list", {});
    const hit = (listed?.workspaces ?? []).find((w) => w?.label === wsLabel);
    if (hit?.workspace_id) {
      this.#workspaceIds.set(wsLabel, hit.workspace_id);
      return hit.workspace_id;
    }
    const created = await this.#call("workspace.create", { label: wsLabel, focus: false });
    const id = created?.workspace?.workspace_id;
    if (!id) throw new Error("workspace.create 未返回 workspace_id");
    this.#workspaceIds.set(wsLabel, id);
    return id;
  }

  // 在独立 Tab（或独立 Worktree）里起一个 Agent。pane_id 一律取自 Herdr 返回值，绝不硬编码。
  // 并行写任务用 worktree.create 原子隔离；worktree.create / agent.start 都不收 env，
  // 所以 env 统一经 tab.create 注入（Herdr 自己的 HERDR_* 在冲突时优先）。
  async launchAgent({
    configDir, taskId, runId = "", attemptId = "", node = "", worker = "", kind, args = [],
    env = {}, cwd = "", inputPath = "", receiptPath = "", envelopePath = "",
    workspaceLabel = "a2a-hub", workspaceId = "", worktree = null, agentName = "",
  }) {
    const name = agentName || herdrAgentName(taskId);
    const runDir = herdrRunDir(configDir, taskId);
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(runDir, 0o700); } catch { /* 权限失败不挡启动 */ }
    const launchEnv = buildLaunchEnv({
      taskId, runId, attemptId, node, worker, runDir, inputPath, receiptPath, envelopePath, extra: env,
    });

    let wsId = workspaceId;
    let worktreeInfo = null;
    let defaultTabId = "";
    if (worktree) {
      const branch = String(worktree.branch || `a2a/${safeTaskId(taskId)}`);
      const params = { cwd: String(worktree.cwd || cwd), branch, label: String(taskId), focus: false };
      if (worktree.base) params.base = String(worktree.base);
      const made = await this.#call("worktree.create", params);
      wsId = made?.workspace?.workspace_id;
      defaultTabId = made?.tab?.tab_id ?? "";
      worktreeInfo = { path: made?.worktree?.path ?? "", branch };
      if (!wsId || !worktreeInfo.path) throw new Error("worktree.create 未返回 workspace_id 或 worktree.path");
    } else if (!wsId) {
      wsId = await this.ensureWorkspace(workspaceLabel);
    }

    let tabId = "";
    let paneId = "";
    try {
      const tabParams = {
        workspace_id: wsId,
        label: String(taskId),
        focus: false,
        env: launchEnv,
      };
      const tabCwd = worktreeInfo ? worktreeInfo.path : cwd;
      if (tabCwd) tabParams.cwd = tabCwd;
      const created = await this.#call("tab.create", tabParams);
      tabId = created?.tab?.tab_id ?? "";
      paneId = created?.root_pane?.pane_id ?? "";
      if (!paneId) throw new Error("tab.create 未返回 root_pane.pane_id");

      const startParams = {
        name,
        kind: String(kind),
        pane_id: paneId,
        timeout_ms: this.#opts.startTimeoutMs,
      };
      if (Array.isArray(args) && args.length) startParams.args = args.map((a) => String(a));
      try {
        await this.#call("agent.start", startParams, { timeoutMs: this.#opts.startTimeoutMs + 5000 });
      } catch (err) {
        // agent_not_ready 且 Agent 已在启动期被拦成 blocked 时，名字仍然有效：保留，交给派发守卫按 blocked 送审。
        if (err?.category !== "not_ready") throw err;
        const live = await this.#findAgent(name);
        if (!live || statusOf(live) !== "blocked") throw err;
      }
      if (defaultTabId && defaultTabId !== tabId) {
        await this.#call("tab.close", { tab_id: defaultTabId }).catch((e) => this.#note("关闭 worktree 默认 Tab 失败", e));
      }
    } catch (err) {
      // 起不来就把刚开的空壳清掉，避免泄漏占窗口；Worktree 此时还没有产出，force=false 删除不会丢东西。
      if (tabId) await this.#call("tab.close", { tab_id: tabId }).catch(() => {});
      else if (paneId) await this.#call("pane.close", { pane_id: paneId }).catch(() => {});
      if (worktreeInfo) await this.#call("worktree.remove", { workspace_id: wsId, force: false }).catch(() => {});
      throw err;
    }

    const binding = {
      taskId: String(taskId),
      agentName: name,
      kind: String(kind),
      workspaceId: wsId,
      tabId,
      paneId,
      worktreePath: worktreeInfo?.path ?? "",
      branch: worktreeInfo?.branch ?? "",
    };
    await this.#refreshPaneNow(paneId).catch((e) => this.#note("启动后定向刷新失败", e));
    this.track(binding);
    return binding;
  }

  // 收尾。隔离 Worktree 只做 force=false 删除：Agent 在里面留下未提交改动时 Herdr 会拒绝，
  // 此时保留检出目录只关掉 Tab，绝不替用户丢弃产出。
  async closeAgent(binding) {
    const out = { closed: false, worktreeRemoved: false, worktreeKept: false, reason: "" };
    if (!binding) return out;
    this.untrack(binding.agentName);
    if (binding.worktreePath && binding.workspaceId) {
      try {
        await this.#call("worktree.remove", { workspace_id: binding.workspaceId, force: false });
        out.worktreeRemoved = true;
        out.closed = true;
        return out;
      } catch (err) {
        if (err?.category === "not_found") {
          out.closed = true;
          return out;
        }
        out.worktreeKept = true;
        out.reason = String(err?.message ?? err);
      }
    }
    try {
      if (binding.tabId) await this.#call("tab.close", { tab_id: binding.tabId });
      else if (binding.paneId) await this.#call("pane.close", { pane_id: binding.paneId });
      out.closed = true;
    } catch (err) {
      if (err?.category === "not_found") out.closed = true;
      else out.reason = out.reason || String(err?.message ?? err);
    }
    return out;
  }

  // ---------- 派发 ----------

  // Per-Agent 串行锁：同一个 Agent 的派发、审批续接排成一条链，后来者等前者结束。
  #withLock(name, fn) {
    const prev = this.#locks.get(name) ?? Promise.resolve();
    let release;
    const gate = new Promise((r) => { release = r; });
    const tail = prev.then(() => gate);
    this.#locks.set(name, tail);
    this.#waiters.set(name, (this.#waiters.get(name) ?? 0) + 1);
    return prev.then(fn).finally(() => {
      release();
      const left = (this.#waiters.get(name) ?? 1) - 1;
      if (left <= 0) this.#waiters.delete(name);
      else this.#waiters.set(name, left);
      if (this.#locks.get(name) === tail) this.#locks.delete(name);
    });
  }

  // 只把指针交出去，不等待本轮结束。调用方随后用 waitForTurn / 自己的扫表看门禁。
  // 返回 accepted / blocked / busy / stalled / dead。blocked 时 prompt 没有发出。
  async #acceptPrompt(name, text, signal) {
    const guarded = await this.#guard(name, { deadlineAt: this.#now() + this.#opts.guardWaitMs, signal });
    if (guarded.outcome) return guarded.outcome;
    try {
      await this.#call("agent.prompt", { target: name, text }, { timeoutMs: 30_000, signal });
    } catch (err) {
      if (!(err instanceof HerdrError)) throw err;
      if (err.category === "blocked") return this.#blockedOutcome(name, await this.#findAgent(name, signal), signal);
      if (err.category === "not_found" || err.category === "not_running") return { status: "dead", reason: err.code };
      if (err.category === "prompt_stalled" || err.category === "timeout") {
        return { status: "stalled", reason: err.code };
      }
      throw err;
    }
    return { status: "accepted" };
  }

  // 不等派发锁：等待与下一次 prompt 可以交错，调用方用 AbortSignal 或 flight 状态避免把旧 turn 当成新结果。
  async waitForTurn(agentName, { timeoutMs = 60_000, signal } = {}) {
    const deadlineAt = this.#now() + timeoutMs;
    return this.#awaitSettled(agentName, { deadlineAt, signal });
  }

  async sendKeys(agentName, keys, { signal } = {}) {
    if (!Array.isArray(keys) || !keys.length || keys.length > 8 || keys.some((k) => typeof k !== "string" || !k.trim())) {
      throw new TypeError("审批按键必须是 1~8 个非空字符串");
    }
    await this.#call("agent.send_keys", { target: agentName, keys }, { signal });
  }

  // 派发一条指针 prompt 并等到「交卷」。wait:false 时只负责投递。返回 outcome：
  //   settled  Agent 回到 idle/done（只是交卷，通过与否由 checkResultGate 判）
  //   blocked  Agent 卡在审批弹窗，popup 为 agent.read 抓回的送审文本；未重复 prompt
  //   busy     等了 guardWaitMs 旧 turn 仍未结束，没有发送，调用方稍后重排
  //   stalled  重投达上限仍没有任何活动迹象
  //   deadline 到达 timeoutMs，alive 说明前台是否仍活跃
  //   dead     Agent / pane 已不存在
  async dispatchPrompt(agentName, text, { timeoutMs = 600_000, signal, wait = true } = {}) {
    assertPointerPrompt(text);
    if (wait === false) return this.#withLock(agentName, () => this.#acceptPrompt(agentName, text, signal));
    return this.#withLock(agentName, async () => {
      const deadlineAt = this.#now() + timeoutMs;
      const guarded = await this.#guard(agentName, { deadlineAt, signal });
      if (guarded.outcome) return guarded.outcome;
      return this.#submit(agentName, text, guarded.agent, { deadlineAt, signal });
    });
  }

  // 状态前置守卫：只有 idle/done 且就绪才允许发 prompt。
  // 对 working 的 Agent 直接 agent.prompt(wait) 会让「旧 turn 结束」误满足等待，把别人的结果当成本次的。
  async #guard(name, { deadlineAt, signal }) {
    const limit = Math.min(deadlineAt, this.#now() + this.#opts.guardWaitMs);
    for (let i = 0; ; i++) {
      const agent = await this.#findAgent(name, signal);
      if (!agent) return { outcome: { status: "dead", reason: "agent_not_found" } };
      const st = statusOf(agent);
      if (st === "blocked") return { outcome: await this.#blockedOutcome(name, agent, signal) };
      const ready = agent.interactive_ready !== false && !agent.launch_pending;
      if (SETTLED_STATES.includes(st) && ready) return { agent };
      if (this.#now() >= limit) return { outcome: { status: "busy", agent } };
      if (st === "working") {
        const r = await this.#awaitSettled(name, { deadlineAt: limit, signal });
        if (r.status === "deadline") return { outcome: { status: "busy", agent: r.agent ?? agent } };
        if (r.status !== "settled") return { outcome: r };
        continue;
      }
      await sleepMs(Math.min(200 * (i + 1), 1000), signal);
    }
  }

  async #submit(name, text, agent0, { deadlineAt, signal }) {
    let agent = agent0;
    let stalls = 0;
    for (;;) {
      const baseline = Number(agent?.state_change_seq ?? -1);
      const remaining = deadlineAt - this.#now();
      if (remaining <= 0) return this.#deadlineOutcome(name, signal);
      const slice = Math.min(this.#opts.waitSliceMs, remaining);
      let diagnosis = null;
      let promptErr = null;
      try {
        // agent.prompt(wait) 成功返回的形态没有完整实测（需要真实被识别的 Agent），
        // 所以不解析返回体，成功后一律用定向 agent.get 复核实际状态。
        await this.#call(
          "agent.prompt",
          { target: name, text, wait: { until: SETTLE_UNTIL, timeout_ms: slice } },
          { timeoutMs: slice + 5000, signal },
        );
      } catch (err) {
        if (!(err instanceof HerdrError)) throw err;
        promptErr = err;
      }

      if (!promptErr) {
        const fresh = await this.#findAgent(name, signal);
        if (!fresh) return { status: "dead", reason: "agent_not_found" };
        const st = statusOf(fresh);
        if (st === "blocked") return this.#blockedOutcome(name, fresh, signal);
        if (!SETTLED_STATES.includes(st)) return this.#awaitSettled(name, { deadlineAt, signal, stalls });
        // 返回 idle/done 但 state_change_seq 没动 = 等待可能被提交前的旧状态满足，不能当交卷。
        if (Number(fresh.state_change_seq) > baseline) return { status: "settled", agent: fresh, stalls };
        diagnosis = { reason: "wait_satisfied_by_stale_state", agent: fresh };
      } else {
        switch (promptErr.category) {
          case "blocked": // 发送前就已是 blocked，服务端没有投递；绝不重试 prompt
            return this.#blockedOutcome(name, await this.#findAgent(name, signal), signal);
          case "not_found":
            return { status: "dead", reason: promptErr.code };
          case "not_running": {
            const rec = await this.#recoverNotRunning(name, signal);
            if (rec.dead) return { status: "dead", reason: "agent_not_running" };
            const g = await this.#guard(name, { deadlineAt, signal });
            if (g.outcome) return g.outcome;
            agent = g.agent;
            continue; // prompt 未被接受，守卫通过后重新投
          }
          case "prompt_stalled":
          case "timeout": {
            const fresh = await this.#findAgent(name, signal);
            if (!fresh) return { status: "dead", reason: "agent_not_found" };
            const st = statusOf(fresh);
            if (st === "blocked") return this.#blockedOutcome(name, fresh, signal);
            // 已出现活动 = prompt 已投递（可能很快就跑完），此后只等，不再重投。
            if (st === "working" || Number(fresh.state_change_seq) > baseline) {
              return this.#awaitSettled(name, { deadlineAt, signal, stalls });
            }
            diagnosis = { reason: promptErr.code, agent: fresh };
            break;
          }
          default:
            throw promptErr;
        }
      }
      // 没有任何活动迹象：agent.get + agent.explain 复核后退避重投，且不超过上限，绝不当作完成。
      const why = await this.#explain(name, signal);
      if (stalls >= this.#opts.stallRetryMax) {
        return { status: "stalled", agent: diagnosis?.agent ?? agent, explain: why, stalls, reason: diagnosis?.reason ?? "" };
      }
      await sleepMs(backoffDelay(stalls, this.#opts.stallBackoff, this.#random), signal);
      stalls += 1;
      const g = await this.#guard(name, { deadlineAt, signal });
      if (g.outcome) return g.outcome;
      agent = g.agent;
    }
  }

  async #explain(name, signal) {
    try {
      const res = await this.#call("agent.explain", { target: name }, { signal });
      return res ?? null;
    } catch (err) {
      this.#note("agent.explain 失败", err);
      return null;
    }
  }

  // ---------- 审批续接 ----------

  // 审批通过/拒绝后注入精确按键并重新挂起等待。始终不重复 agent.prompt：
  // 弹窗属于同一个 turn，重发 prompt 会把任务指针当成弹窗答案打进去。
  async resumeAfterApproval(agentName, keys, { timeoutMs = 600_000, prevPopup = "", signal } = {}) {
    if (!Array.isArray(keys) || !keys.length || keys.length > 8 || keys.some((k) => typeof k !== "string" || !k.trim())) {
      throw new TypeError("审批按键必须是 1~8 个非空字符串");
    }
    return this.#withLock(agentName, async () => {
      const deadlineAt = this.#now() + timeoutMs;
      const agent = await this.#findAgent(agentName, signal);
      if (!agent) return { status: "dead", reason: "agent_not_found" };
      const st = statusOf(agent);
      if (st !== "blocked") {
        // 用户可能已在终端里自己点掉了：不再注入按键，直接顺着当前状态往下等。
        if (SETTLED_STATES.includes(st)) return { status: "settled", agent, notBlocked: true };
        return { ...(await this.#awaitSettled(agentName, { deadlineAt, signal })), notBlocked: true };
      }
      await this.#call("agent.send_keys", { target: agentName, keys }, { signal });
      // 刚注入完状态还是旧的 blocked，直接等 idle/done/blocked 会被旧状态立刻满足；先等「离开 blocked」。
      const leave = await this.#awaitStatus(agentName, LEAVE_BLOCKED_UNTIL, {
        deadlineAt: Math.min(deadlineAt, this.#now() + this.#opts.leaveBlockedMs), signal,
      });
      if (leave.status === "dead") return leave;
      if (leave.status !== "matched") {
        const popup = await this.#readPopup(agentName, signal);
        // 按键没生效或弹出了形态相同的新弹窗：返回 blocked 并标记 stuck，由上层决定是否升级人工。
        return { status: "blocked", popup, agent: await this.#findAgent(agentName, signal), stuck: popup === prevPopup };
      }
      return this.#awaitSettled(agentName, { deadlineAt, signal });
    });
  }

  // ---------- 等待与异常矩阵 ----------

  async #awaitSettled(name, { deadlineAt, signal, stalls = 0 }) {
    const r = await this.#awaitStatus(name, SETTLE_UNTIL, { deadlineAt, signal });
    if (r.status !== "matched") return { ...r, stalls };
    if (r.agentStatus === "blocked") return this.#blockedOutcome(name, r.agent, signal);
    return { status: "settled", agent: r.agent, stalls };
  }

  // 低层等待：agent.wait 切片循环。slice 超时不是失败，先核查前台是否仍活跃再继续，避免误杀长任务。
  async #awaitStatus(name, until, { deadlineAt, signal }) {
    let recoveries = 0;
    let inactive = 0;
    let netFailures = 0;
    for (;;) {
      const remaining = deadlineAt - this.#now();
      if (remaining <= 0) return this.#deadlineOutcome(name, signal);
      const slice = Math.min(this.#opts.waitSliceMs, remaining);
      try {
        await this.#call(
          "agent.wait",
          { target: name, until, timeout_ms: slice },
          { timeoutMs: slice + 5000, signal },
        );
        netFailures = 0;
        // wait 命中只代表命中过一次，真实状态以定向 agent.get 为准。
        const agent = await this.#findAgent(name, signal);
        if (!agent) return { status: "dead", reason: "agent_not_found" };
        const st = statusOf(agent);
        if (until.includes(st)) return { status: "matched", agentStatus: st, agent };
        // wait 命中后状态又变了（例如 working→idle 之间的抖动），继续等。
      } catch (err) {
        if (!(err instanceof HerdrError)) throw err;
        switch (err.category) {
          case "timeout": {
            const alive = await this.#checkAlive(name, signal);
            if (alive.state === "dead") return { status: "dead", reason: "agent_not_found" };
            if (alive.state === "inactive") inactive += 1;
            else inactive = 0;
            if (inactive >= 2) return { status: "inactive", agent: alive.agent };
            if (alive.agent && until.includes(statusOf(alive.agent))) {
              return { status: "matched", agentStatus: statusOf(alive.agent), agent: alive.agent };
            }
            break;
          }
          case "not_running": {
            if (recoveries++ >= 2) return { status: "dead", reason: "agent_not_running" };
            const rec = await this.#recoverNotRunning(name, signal);
            if (rec.dead) return { status: "dead", reason: "agent_not_running" };
            break;
          }
          case "not_found":
            return { status: "dead", reason: err.code };
          case "unavailable":
          case "closed":
            if (++netFailures >= 3) return { status: "unavailable", reason: err.code };
            await sleepMs(backoffDelay(netFailures, this.#opts.stallBackoff, this.#random), signal);
            break;
          default:
            throw err;
        }
      }
    }
  }

  // agent_not_running 不等于 Agent 死了：它可能被挪到别的 workspace。先按稳定名 agent.get 排除跨区移动，
  // 找得到就原地刷新 pane_id 继续等，找不到才判退出。
  async #recoverNotRunning(name, signal) {
    const agent = await this.#findAgent(name, signal);
    if (!agent) return { dead: true };
    const b = this.#bindings.get(name);
    if (b && b.paneId !== agent.pane_id) {
      const prev = b.paneId;
      b.paneId = agent.pane_id;
      b.workspaceId = agent.workspace_id ?? b.workspaceId;
      b.tabId = agent.tab_id ?? b.tabId;
      this.emit("binding_changed", b, { reason: "agent_not_running_recovery", previousPaneId: prev });
      this.#scheduleSubscriptionRefresh();
    }
    return { dead: false, agent };
  }

  // 超时核查：agent.get 的状态是主依据；状态 unknown 时再看 pane.process_info 里前台是否有 shell 之外的进程。
  async #checkAlive(name, signal) {
    const agent = await this.#findAgent(name, signal);
    if (!agent) return { state: "dead" };
    const st = statusOf(agent);
    if (st === "working") return { state: "alive", agent };
    if (st === "blocked") return { state: "alive", agent };
    if (SETTLED_STATES.includes(st)) return { state: "settled", agent };
    try {
      const res = await this.#call("pane.process_info", { pane_id: agent.pane_id }, { signal });
      const info = res?.process_info;
      const busy = (info?.foreground_processes ?? []).some((p) => p?.pid !== info?.shell_pid);
      return { state: busy ? "alive" : "inactive", agent };
    } catch (err) {
      if (err?.category === "not_found") return { state: "dead" };
      throw err;
    }
  }

  async #deadlineOutcome(name, signal) {
    const alive = await this.#checkAlive(name, signal);
    if (alive.state === "dead") return { status: "dead", reason: "agent_not_found" };
    if (alive.state === "settled") return { status: "settled", agent: alive.agent };
    if (alive.agent && statusOf(alive.agent) === "blocked") return this.#blockedOutcome(name, alive.agent, signal);
    return { status: "deadline", alive: alive.state === "alive", agent: alive.agent };
  }

  // 弹窗只为送审而读：recent_unwrapped 去掉软换行，便于完整展示命令；socket 里的枚举是下划线形式。
  async #blockedOutcome(name, agent, signal) {
    const popup = await this.#readPopup(name, signal);
    return { status: "blocked", popup, agent };
  }

  async #readPopup(name, signal) {
    try {
      const res = await this.#call(
        "agent.read",
        { target: name, source: "recent_unwrapped", lines: this.#opts.popupLines, strip_ansi: true },
        { signal },
      );
      return String(res?.read?.text ?? "");
    } catch (err) {
      this.#note("读取 blocked 弹窗失败", err);
      return "";
    }
  }

  // 仅供失败诊断落日志。调用方不得把返回文本解析成业务结果或喂给下游。
  async readDiagnostics(agentName, { lines = 200, signal } = {}) {
    try {
      const res = await this.#call(
        "agent.read",
        { target: agentName, source: "recent_unwrapped", lines, strip_ansi: true },
        { signal },
      );
      return String(res?.read?.text ?? "");
    } catch (err) {
      return `（诊断读取失败：${err?.message ?? err}）`;
    }
  }

  async getAgent(agentName, signal) {
    return this.#findAgent(agentName, signal);
  }

  async #findAgent(name, signal) {
    try {
      const res = await this.#call("agent.get", { target: name }, { signal });
      const agent = res?.agent ?? null;
      if (agent?.pane_id) this.#agents.set(agent.pane_id, agent);
      return agent;
    } catch (err) {
      if (err?.category === "not_found") return null;
      throw err;
    }
  }

  #call(method, params, opts) {
    return this.#socket.call(method, params, opts);
  }

  #note(message, err) {
    const text = err ? `${message}：${err?.message ?? err}` : message;
    try { this.#log(`herdr: ${text}`); } catch { /* 日志失败不影响运行时 */ }
    this.emit("runtime_note", { message: text });
  }
}

function statusOf(agent) {
  return String(agent?.agent_status ?? "unknown").toLowerCase();
}

function sleepMs(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new HerdrError("aborted", "已被取消", { local: true }));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new HerdrError("aborted", "已被取消", { local: true })); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// 生产入口：socket 路径按「显式配置 → HERDR_SOCKET_PATH → 会话名 → 默认」发现。
// cfg.herdrSocketPath 只在直接构造 Kernel 时可用（loadConfig 会丢弃未知键），生产走环境变量与 herdrSession。
export function createHerdrRuntime(cfg = {}, { socketOptions = {}, ...runtimeOpts } = {}) {
  let runtime = null;
  const socket = createHerdrSocket({
    socketPath: String(cfg?.herdrSocketPath ?? "").trim(),
    session: String(cfg?.herdrSession ?? "").trim(),
    ...socketOptions,
    subscriptions: () => runtime.subscriptions(),
  });
  runtime = new HerdrRuntime({ socket, ...runtimeOpts });
  return runtime;
}
