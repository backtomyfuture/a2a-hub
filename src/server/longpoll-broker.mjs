// HTTP 长轮询（Long-Polling）事件代理。
// 每次 SqliteBus 写入提交成功后调用 publish() 推送事件，毫秒级唤醒挂起在
// GET /api/v1/poll 的目标节点或 Web 控制台客户端。

const DEFAULT_MAX_HISTORY = 1024;
const DEFAULT_STALE_NODE_MS = 90_000;
// 探针节点只碰一次 poll/register 就会留在内存里。超过一天仍无活动就删掉，避免名册无限增长。
export const NODE_EXPIRE_MS = 24 * 60 * 60 * 1000;
// Leader / Worker 大约 10～15 分钟醒一次。无名片且超过 30 分钟没活动，视为幽灵，不进名册。
export const ROSTER_IDLE_MS = 30 * 60 * 1000;

// 有名片的节点离线也要留在名册里。没有名片时，只保留 30 分钟内活动过的在线记录。
export function rosterNodeVisible(info, hasCard, now = Date.now()) {
  if (hasCard) return true;
  const seen = Number(info?.lastSeenAt ?? info?.last_seen_at ?? 0);
  if (!Number.isFinite(seen) || seen <= 0) return false;
  return now - seen <= ROSTER_IDLE_MS;
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
    const next = {
      ...prev,
      lastSeenAt: Date.now(),
      lastPollAt: Date.now(),
      cursor: Number.isFinite(Number(cursor)) ? Number(cursor) : prev.cursor,
      remoteAddr: remoteAddr || prev.remoteAddr,
      activeWaiters: Math.max(0, (prev.activeWaiters || 0) + deltaWaiter),
      kind: meta?.kind || prev.kind || "host",
      mode: meta?.mode || prev.mode || "longpoll",
      role: meta?.role !== undefined ? meta.role : (prev.role || ""),
    };
    this._nodes.set(key, next);
    return next;
  }

  // 记录外部 HTTP Agent 或客户端心跳/轮询活跃态，方便控制台统一展示连接节点与接入模式。
  touchAgent(node, { remoteAddr = "", mode = "http-poll", kind = "agent", role = "", cursor = undefined } = {}) {
    return this._touchNode(node, cursor, remoteAddr, 0, { mode, kind, role });
  }

  // 删除 Agent 后立刻从名册消失，不必等 24 小时过期。对方若仍在轮询会被重新记上，所以要先吊销 Token。
  forgetNode(node) {
    return this._nodes.delete(String(node ?? "").trim());
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

  connectedNodes(now = Date.now()) {
    this._purgeExpiredNodes(now);
    const out = [];
    for (const info of this._nodes.values()) {
      const polling = info.activeWaiters > 0;
      const online = polling || (now - info.lastSeenAt) <= this.staleNodeMs;
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
