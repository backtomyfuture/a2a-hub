// HTTP 长轮询（Long-Polling）事件代理。
// 每次 SqliteBus 写入提交成功后调用 publish() 推送事件，毫秒级唤醒挂起在
// GET /api/v1/poll 的目标节点或 Web 控制台客户端。

const DEFAULT_MAX_HISTORY = 1024;
const DEFAULT_STALE_NODE_MS = 90_000;
// 探针节点只碰一次 poll/register 就会留在内存里。超过一天仍无活动就删掉，避免名册无限增长。
export const NODE_EXPIRE_MS = 24 * 60 * 60 * 1000;
// 检查脚本和跑不了脚本时的回退默认 5 分钟。无名片且超过这段闲置仍无活动，视为幽灵，不进名册。
export const ROSTER_IDLE_MS = 30 * 60 * 1000;
// 定时唤醒的 HTTP Agent 两次报到之间本来就隔几分钟，不能套用长轮询守护进程的 90 秒判离线。
// 一次运行里会连发 check / poll / claim 等请求，间隔短于这个值的视为同一轮，不计入唤醒周期。
const RUN_BURST_MS = 30_000;
// 没写 poll_interval_min、也还没观测到周期时（如 Hub 刚重启），按默认间隔 × 1.5。
// 显式间隔不再套 3 分钟下限，也不再被 30 分钟名册闲置截断，否则 60 分钟一轮会在 31 分钟被判离线。
export const AGENT_WINDOW_FACTOR = 1.5;
export const DEFAULT_POLL_INTERVAL_MIN = 5;
export const DEFAULT_WEBHOOK_INTERVAL_MIN = 30;
const MIN_AGENT_WINDOW_MS = 3 * 60 * 1000;

function configuredWindowMs(pollIntervalMin) {
  const minutes = Number(pollIntervalMin);
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.round(minutes * 60_000 * AGENT_WINDOW_FACTOR);
}

// 有名片的节点离线也要留在名册里。没有名片时，闲置窗口至少 30 分钟；
// 配了更长轮询间隔的，按间隔 × 1.5 放宽，避免慢节奏 Agent 被当成幽灵删掉。
export function rosterNodeVisible(info, hasCard, now = Date.now()) {
  if (hasCard) return true;
  const seen = Number(info?.lastSeenAt ?? info?.last_seen_at ?? 0);
  if (!Number.isFinite(seen) || seen <= 0) return false;
  const idleMs = Math.max(ROSTER_IDLE_MS, configuredWindowMs(info?.pollIntervalMin));
  return now - seen <= idleMs;
}

export class LongPollBroker {
  constructor({ initialSeq = 0, maxHistory = DEFAULT_MAX_HISTORY, staleNodeMs = DEFAULT_STALE_NODE_MS } = {}) {
    this.latestSeq = Number.isFinite(Number(initialSeq)) ? Number(initialSeq) : 0;
    this.maxHistory = maxHistory;
    this.staleNodeMs = staleNodeMs;
    this._history = [];
    this._waiters = new Set();
    this._localListeners = new Set();
    // node -> { node, lastSeenAt, cursor, remoteAddr, activeWaiters, lastPollAt }
    this._nodes = new Map();
    // 记住名片配置的分钟轮询间隔：即便 Hub 重启后首次事件是 Webhook 投递（noteDelivery），也能立刻套用正确窗口。
    this._configuredPollMin = new Map();
    this._closed = false;
  }

  _oldestSeq() {
    if (!this._history.length) return this.latestSeq + 1;
    return this._history[0].seq;
  }

  _matchesNode(event, node) {
    const target = String(node ?? "").trim();
    if (!target || target === "*" || target === "_web") return true;
    const targets = event?.nodes;
    if (!Array.isArray(targets) || !targets.length) return true;
    return targets.includes("*") || targets.includes(target);
  }

  _eventsAfter(cursor, node) {
    const cur = Number(cursor) || 0;
    if (cur >= this.latestSeq) return [];
    // 客户端 cursor 太旧（已被环形缓冲淘汰）时强制唤醒，触发全量对账扫表。
    if (this._history.length && cur < this._oldestSeq() - 1) {
      return [{ seq: this.latestSeq, op: "resync", table: "*", recordId: "", nodes: ["*"], ts: Date.now() }];
    }
    const matched = [];
    for (const ev of this._history) {
      if (ev.seq > cur && this._matchesNode(ev, node)) matched.push(ev);
    }
    return matched;
  }

  publish(event = {}) {
    if (this._closed) return null;
    const seq = Number.isFinite(Number(event.seq)) && Number(event.seq) > this.latestSeq
      ? Number(event.seq)
      : this.latestSeq + 1;
    this.latestSeq = seq;
    const nodes = Array.isArray(event.nodes) && event.nodes.length
      ? Array.from(new Set(event.nodes.map((n) => String(n ?? "").trim()).filter(Boolean)))
      : ["*"];
    const item = {
      seq,
      op: String(event.op ?? "update"),
      table: String(event.table ?? ""),
      recordId: String(event.recordId ?? ""),
      nodes,
      ts: event.ts ?? Date.now(),
    };
    this._history.push(item);
    if (this._history.length > this.maxHistory) {
      this._history.splice(0, this._history.length - this.maxHistory);
    }

    for (const fn of this._localListeners) {
      try { fn(item); } catch { /* 局部监听器异常不影响主流程 */ }
    }

    for (const waiter of Array.from(this._waiters)) {
      if (this._matchesNode(item, waiter.node)) {
        waiter.resolve({ wake: true, cursor: this.latestSeq, events: [item] });
      }
    }
    return item;
  }

  subscribeLocal(fn) {
    if (typeof fn !== "function") return () => {};
    this._localListeners.add(fn);
    return () => this._localListeners.delete(fn);
  }

  // 惰性清理：只有再次触摸或读取名册时才扫，避免为过期单独跑定时器。
  _purgeExpiredNodes(now = Date.now()) {
    for (const [key, info] of this._nodes) {
      const seen = Number(info?.lastSeenAt) || 0;
      if (now - seen > NODE_EXPIRE_MS) this._nodes.delete(key);
    }
  }

  _touchNode(node, cursor, remoteAddr, deltaWaiter = 0, meta = null) {
    this._purgeExpiredNodes();
    const key = String(node ?? "").trim();
    if (!key || key === "*" || key === "_web") return null;
    const prev = this._nodes.get(key) ?? {
      node: key,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      lastPollAt: Date.now(),
      cursor: 0,
      remoteAddr: "",
      activeWaiters: 0,
      kind: "host",
      mode: "longpoll",
      role: "",
    };
    const now = Date.now();
    let intervalMs = prev.intervalMs || 0;
    let runStartAt = prev.runStartAt || now;
    if (prev.deferCycle) {
      // 上一次只是成功投递。投递挤在两次检查之间，不能拿它当周期起点，否则窗口会被估短。
      intervalMs = prev.intervalMs || 0;
      runStartAt = now;
    } else if (this._nodes.has(key) && now - (Number(prev.lastSeenAt) || now) >= RUN_BURST_MS) {
      // 周期按两轮的首个请求相减，一轮里请求多少不影响结果；再取平滑，偶尔晚到不会让窗口大起大落。
      const gap = now - (Number(prev.runStartAt) || Number(prev.lastSeenAt) || now);
      intervalMs = intervalMs ? Math.round((intervalMs + gap) / 2) : gap;
      runStartAt = now;
    }
    const next = {
      ...prev,
      intervalMs,
      runStartAt,
      deferCycle: false,
      lastSeenAt: now,
      lastPollAt: Date.now(),
      cursor: Number.isFinite(Number(cursor)) ? Number(cursor) : prev.cursor,
      remoteAddr: remoteAddr || prev.remoteAddr,
      activeWaiters: Math.max(0, (prev.activeWaiters || 0) + deltaWaiter),
      kind: meta?.kind || prev.kind || "host",
      mode: meta?.mode || prev.mode || "longpoll",
      role: meta?.role !== undefined ? meta.role : (prev.role || ""),
      // 名片上的分钟间隔优先于观测值。没带新值时保留（或继承启动预加载的配置），避免 poll/重启把配置清掉。
      pollIntervalMin: configuredWindowMs(meta?.pollIntervalMin) > 0
        ? Number(meta.pollIntervalMin)
        : (Number(prev.pollIntervalMin) > 0
          ? Number(prev.pollIntervalMin)
          : (this._configuredPollMin.get(key) || 0)),
    };
    if (next.pollIntervalMin > 0) this._configuredPollMin.set(key, next.pollIntervalMin);
    this._nodes.set(key, next);
    return next;
  }

  // 记录外部 HTTP Agent 或客户端心跳/轮询活跃态，方便控制台统一展示连接节点与接入模式。
  // 省略 role 时保留原角色。poll / claim 没带角色，不能把 check 刚写上的角色清成空。
  touchAgent(node, { remoteAddr = "", mode = "http-poll", kind = "agent", role, cursor = undefined, receiveFromCard = false, pollIntervalMin } = {}) {
    const key = String(node ?? "").trim();
    const prev = this._nodes.get(key);
    // poll / updates 不知道名片上的接收方式，缺省报 http-poll 或长轮询。
    // 已经确认是 webhook 的不能因此改用默认定时窗口。检查脚本会带 receiveFromCard，可以按名片改回去。
    let nextMode = mode;
    if (!receiveFromCard && prev?.mode === "webhook" && (mode === "http-poll" || mode === "longpoll")) {
      nextMode = "webhook";
    }
    const meta = { mode: nextMode, kind };
    if (role) meta.role = role;
    if (pollIntervalMin != null) meta.pollIntervalMin = pollIntervalMin;
    return this._touchNode(node, cursor, remoteAddr, 0, meta);
  }

  // 从名片 Metadata 同步轮询间隔。节点还没活动过时不建在线记录，但先缓存间隔，等首次 touchAgent / noteDelivery 生效。
  setNodePollInterval(node, pollIntervalMin) {
    const key = String(node ?? "").trim();
    if (!key || key === "*" || key === "_web") return null;
    const minutes = Number(pollIntervalMin);
    const valid = Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
    if (valid > 0) this._configuredPollMin.set(key, valid);
    else this._configuredPollMin.delete(key);
    const prev = this._nodes.get(key);
    if (!prev) return null;
    const next = {
      ...prev,
      pollIntervalMin: valid,
    };
    this._nodes.set(key, next);
    return next;
  }

  // 2xx 投递（含机主测试）算一次活动。不走 _touchNode，避免把门铃间隔写进 intervalMs。
  noteDelivery(node) {
    this._purgeExpiredNodes();
    const key = String(node ?? "").trim();
    if (!key || key === "*" || key === "_web") return null;
    const prev = this._nodes.get(key);
    const now = Date.now();
    const configured = Number(prev?.pollIntervalMin) > 0
      ? Number(prev.pollIntervalMin)
      : (this._configuredPollMin.get(key) || 0);
    const next = {
      node: key,
      firstSeenAt: prev?.firstSeenAt || now,
      lastSeenAt: now,
      lastPollAt: prev?.lastPollAt || 0,
      lastDeliveredAt: now,
      cursor: prev?.cursor || 0,
      remoteAddr: prev?.remoteAddr || "",
      activeWaiters: prev?.activeWaiters || 0,
      kind: prev?.kind || "agent",
      mode: "webhook",
      role: prev?.role || "",
      intervalMs: prev?.intervalMs || 0,
      runStartAt: prev?.runStartAt || 0,
      pollIntervalMin: configured,
      // 还没有检查锚点时，下次检查才开始记周期。已有锚点就留着，让下一次检查仍相对上次检查计量。
      deferCycle: !prev?.runStartAt,
    };
    this._nodes.set(key, next);
    return next;
  }

  // 删除 Agent 后立刻从名册消失，不必等 24 小时过期。对方若仍在轮询会被重新记上，所以要先吊销 Token。
  forgetNode(node) {
    const key = String(node ?? "").trim();
    this._configuredPollMin.delete(key);
    return this._nodes.delete(key);
  }

  async wait({ node = "*", cursor = 0, timeoutMs = 25_000, signal = null, remoteAddr = "" } = {}) {
    const cur = Number.isFinite(Number(cursor)) ? Number(cursor) : 0;
    const waitMs = Math.max(0, Math.min(60_000, Number(timeoutMs) || 0));

    if (this._closed) {
      return { wake: false, cursor: this.latestSeq, events: [], closed: true };
    }

    this._touchNode(node, cur, remoteAddr, 0);

    // 客户端游标高于服务端最新序列号（例如服务端换了新库）时，触发立即重置同步。
    if (cur > this.latestSeq) {
      return { wake: true, cursor: this.latestSeq, events: [], reset: true };
    }

    const immediate = this._eventsAfter(cur, node);
    if (immediate.length) {
      return { wake: true, cursor: this.latestSeq, events: immediate };
    }

    if (waitMs <= 0) {
      return { wake: false, cursor: this.latestSeq, events: [] };
    }

    return await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const waiter = {
        node,
        resolve: (result) => {
          if (settled) return;
          settled = true;
          this._waiters.delete(waiter);
          if (timer) clearTimeout(timer);
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
          this._touchNode(node, result.cursor ?? cur, remoteAddr, -1);
          resolve(result);
        },
      };
      const onAbort = () => {
        waiter.resolve({ wake: false, cursor: this.latestSeq, events: [], aborted: true });
      };
      if (signal?.aborted) {
        this._touchNode(node, cur, remoteAddr, 0);
        resolve({ wake: false, cursor: this.latestSeq, events: [], aborted: true });
        return;
      }
      this._touchNode(node, cur, remoteAddr, 1);
      this._waiters.add(waiter);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        waiter.resolve({ wake: false, cursor: this.latestSeq, events: [] });
      }, waitMs);
    });
  }

  // 长轮询节点断线就该立刻显示离线。定时与 Webhook 按「间隔 × 1.5」放宽。
  // 名片写了 poll_interval_min 时直接用它，不再套 3 分钟下限，也不再被名册 30 分钟截断。
  // 没写时：Webhook 固定按 30 分钟兜底（窗口 45 分钟），不拿门铃间隔去估；
  // http-poll 才用观测到的 intervalMs，并且仍用 30 分钟封顶。刚重启还没观测到时按默认 5 分钟。
  onlineWindowMs(info) {
    const mode = info?.mode || "longpoll";
    if (mode !== "http-poll" && mode !== "webhook") return this.staleNodeMs;
    const configured = configuredWindowMs(info?.pollIntervalMin);
    if (configured > 0) return Math.max(this.staleNodeMs, configured);
    if (mode === "webhook") {
      return Math.max(this.staleNodeMs, DEFAULT_WEBHOOK_INTERVAL_MIN * 60_000 * AGENT_WINDOW_FACTOR);
    }
    if (info?.intervalMs > 0) {
      const observed = Math.round(info.intervalMs * AGENT_WINDOW_FACTOR);
      return Math.min(ROSTER_IDLE_MS, Math.max(this.staleNodeMs, MIN_AGENT_WINDOW_MS, observed));
    }
    return DEFAULT_POLL_INTERVAL_MIN * 60_000 * AGENT_WINDOW_FACTOR;
  }

  connectedNodes(now = Date.now()) {
    this._purgeExpiredNodes(now);
    const out = [];
    for (const info of this._nodes.values()) {
      const polling = info.activeWaiters > 0;
      const online = polling || (now - info.lastSeenAt) <= this.onlineWindowMs(info);
      out.push({
        node: info.node,
        online,
        polling,
        activeWaiters: info.activeWaiters,
        cursor: info.cursor,
        remoteAddr: info.remoteAddr,
        lastSeenAt: info.lastSeenAt,
        firstSeenAt: info.firstSeenAt,
        kind: info.kind || "host",
        mode: info.mode || "longpoll",
        role: info.role || "",
        intervalSec: info.intervalMs ? Math.round(info.intervalMs / 1000) : null,
        pollIntervalMin: info.pollIntervalMin > 0 ? info.pollIntervalMin : null,
        lastDeliveredAt: info.lastDeliveredAt || null,
      });
    }
    return out.sort((a, b) => a.node.localeCompare(b.node));
  }

  close() {
    this._closed = true;
    for (const waiter of Array.from(this._waiters)) {
      waiter.resolve({ wake: false, cursor: this.latestSeq, events: [], closed: true });
    }
    this._waiters.clear();
  }
}
