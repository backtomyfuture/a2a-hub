// 长轮询与在线状态中心（LongPollBroker）。
// 维护单调事件流（上限 40 秒 hold，防止 Cloudflare/Nginx 60 秒断连），
// 并依据活跃连接与名片轮询间隔 × 1.5 动态计算 Agent 与电脑设备的在线状态。

export const MAX_LONGPOLL_SEC = 40;

export class LongPollBroker {
  constructor(store) {
    this.store = store;
    this._lastSeq = 0;
    this._waiters = new Set();
    // scopeKey -> count（当前正挂在 /poll 上的连接数）
    this._liveDevices = new Map();
    this._liveAgents = new Map();
  }

  currentSeq() {
    try {
      if (!this.store) return this._lastSeq;
      const seq = this.store.currentSeq();
      this._lastSeq = seq;
      return seq;
    } catch {
      // 服务优雅关闭阶段 store 可能先于 socket close 回调关闭，此时回退最近已知 seq 避免未捕获异常
      return this._lastSeq;
    }
  }

  _incMap(map, key) {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + 1);
  }

  _decMap(map, key) {
    if (!key) return;
    const next = (map.get(key) || 0) - 1;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  }

  isDeviceConnected(deviceId) {
    return (this._liveDevices.get(deviceId) || 0) > 0;
  }

  isAgentConnected(agentId) {
    return (this._liveAgents.get(agentId) || 0) > 0;
  }

  isDeviceOnline(device, now = Date.now()) {
    if (!device) return false;
    if (this.isDeviceConnected(device.id)) return true;
    if (!device.last_seen_at) return false;
    const minPoll = device.transport === "longpoll" ? Math.max(Number(device.poll_interval_min || 5), 2) : Math.max(Number(device.poll_interval_min || 5), 1);
    const windowMs = minPoll * 60_000 * 1.5;
    return now - Number(device.last_seen_at) <= windowMs;
  }

  isAgentOnline(agent, deviceMap = new Map(), now = Date.now()) {
    if (!agent) return false;
    if (agent.kind === "device-worker" && agent.device_id) {
      const dev = deviceMap.get(agent.device_id);
      if (dev) return this.isDeviceOnline(dev, now);
    }
    if (this.isAgentConnected(agent.id)) return true;
    if (!agent.last_seen_at) return false;
    const defaultMin = agent.transport === "webhook" ? 30 : agent.transport === "longpoll" ? 2 : 5;
    const pollMin = Number(agent.poll_interval_min || defaultMin) || defaultMin;
    const windowMs = pollMin * 60_000 * 1.5;
    return now - Number(agent.last_seen_at) <= windowMs;
  }

  _matchesEvent(waiter, event) {
    if (!event) return false;
    const evSeq = Number(event.seq || 0);
    if (evSeq <= waiter.sinceSeq) return false;
    if (waiter.scope === "all" || waiter.scope === "web") return true;
    if (waiter.scope === "device") {
      if (event.deviceId && event.deviceId === waiter.deviceId) return true;
      if (event.agentId && waiter.agentIds?.has(event.agentId)) return true;
      return false;
    }
    if (waiter.scope === "agent") {
      if (event.agentId && event.agentId === waiter.agentId) return true;
      if (event.fromNode && event.fromNode === waiter.agentId) return true;
      return false;
    }
    return true;
  }

  publish(event) {
    if (!event) return;
    for (const waiter of [...this._waiters]) {
      if (this._matchesEvent(waiter, event)) {
        waiter.resolve({ woke: true, seq: event.seq || this.currentSeq(), event });
      }
    }
  }

  waitForChange({
    scope = "all",
    sinceSeq = 0,
    timeoutSec = 30,
    deviceId = null,
    agentId = null,
    agentIds = null,
    signal = null,
  } = {}) {
    const curSeq = this.currentSeq();
    if (curSeq > Number(sinceSeq || 0)) {
      return Promise.resolve({ woke: true, seq: curSeq, immediate: true });
    }
    const clampedSec = Math.min(Math.max(Number(timeoutSec || 30), 1), MAX_LONGPOLL_SEC);
    if (clampedSec <= 0) {
      return Promise.resolve({ woke: false, seq: curSeq, timeout: true });
    }

    return new Promise((resolve) => {
      let settled = false;
      const agentIdSet = agentIds ? new Set(agentIds) : null;

      if (deviceId) this._incMap(this._liveDevices, deviceId);
      if (agentId) this._incMap(this._liveAgents, agentId);

      const cleanup = () => {
        if (deviceId) this._decMap(this._liveDevices, deviceId);
        if (agentId) this._decMap(this._liveAgents, agentId);
        this._waiters.delete(waiter);
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      };

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(payload);
      };

      const waiter = {
        scope,
        sinceSeq: Number(sinceSeq || 0),
        deviceId,
        agentId,
        agentIds: agentIdSet,
        resolve: finish,
      };
      this._waiters.add(waiter);

      const onAbort = () => finish({ woke: false, seq: this.currentSeq(), aborted: true });
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const timer = setTimeout(() => {
        finish({ woke: false, seq: this.currentSeq(), timeout: true });
      }, clampedSec * 1000);
      if (typeof timer.unref === "function") timer.unref();
    });
  }
}
