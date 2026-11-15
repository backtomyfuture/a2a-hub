// HTTP 长轮询唤醒器（LongPollWaker）。
// 支持两种工作模式：
// 1. 本地进程模式（Hub 服务端直连 SqliteBus + LongPollBroker）：订阅 broker 本地事件，零网络开销秒级唤醒；
// 2. 远程终端模式（Node 客户端连接 Hub HTTP 服务端）：通过 HttpBus.waitForChanges 发起出站长轮询
//    GET /api/v1/poll?node=<node>&cursor=<seq>&timeout=25，不开任何入站端口。

import fs from "node:fs";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 15_000];

export function createLongPollWaker(cfg, opts = {}) {
  return new LongPollWaker(cfg, opts);
}

class LongPollWaker {
  constructor(cfg, { onWake, log, onStatus, sleep: sleepFn } = {}) {
    this.mode = "longpoll";
    this.cfg = cfg ?? {};
    this.onWake = onWake;
    this.log = log ?? (() => {});
    this.onStatus = onStatus;
    this._sleep = sleepFn ?? sleep;
    this._stopped = false;
    this._started = false;
    this._connected = false;
    this._disconnectEpoch = 0;
    this._cursor = 0;
    this._abort = null;
    this._unsubscribeLocal = null;
    this._wakeResolvers = new Set();
    this._loopPromise = null;
  }

  _notifyWaiters() {
    for (const resolve of Array.from(this._wakeResolvers)) {
      this._wakeResolvers.delete(resolve);
      resolve();
    }
  }

  _triggerWake(ev) {
    if (this._stopped) return;
    this.onWake?.(ev);
    this._notifyWaiters();
  }

  start(onWake) {
    if (typeof onWake === "function") this.onWake = onWake;
    if (this._started) return;
    this._started = true;
    this._stopped = false;

    const broker = this.cfg.bus?.broker;
    if (broker && typeof broker.subscribeLocal === "function") {
      this._unsubscribeLocal = broker.subscribeLocal((ev) => {
        if (this._stopped) return;
        const myNode = String(this.cfg.node ?? "").trim();
        const isHub = this.cfg.role === "hub";
        const nodes = Array.isArray(ev?.nodes) ? ev.nodes : ["*"];
        if (isHub || nodes.includes("*") || (myNode && nodes.includes(myNode))) {
          this._triggerWake({ source: "event", event: ev });
        }
      });
      this._connected = true;
      this.onStatus?.(true);
      return;
    }

    if (typeof this.cfg.bus?.waitForChanges === "function") {
      this._loopPromise = this._runPollLoop();
    }
  }

  async _runPollLoop() {
    let synced = false;
    let hadDisconnect = false;
    let failCount = 0;
    const nodeName = String(this.cfg.node ?? "*");
    const longPollSec = Number(this.cfg.longPollSec) > 0 ? Number(this.cfg.longPollSec) : 25;

    while (!this._stopped) {
      this._abort = new AbortController();
      try {
        const res = await this.cfg.bus.waitForChanges({
          node: nodeName,
          cursor: synced ? this._cursor : 0,
          timeoutSec: synced ? longPollSec : 0,
          signal: this._abort.signal,
        });
        if (this._stopped) break;

        failCount = 0;
        if (res && Number.isFinite(Number(res.cursor))) {
          this._cursor = Number(res.cursor);
        }
        const firstConnect = !this._connected;
        if (!this._connected) {
          this._connected = true;
          this.onStatus?.(true);
        }

        if (!synced) {
          synced = true;
          if (hadDisconnect) {
            hadDisconnect = false;
            this._triggerWake({ source: "event", reconnect: true });
          }
          continue;
        }

        if (firstConnect && hadDisconnect) {
          hadDisconnect = false;
          this._triggerWake({ source: "event", reconnect: true });
        } else if (res?.wake || res?.reset) {
          this._triggerWake({ source: "event", events: res.events ?? [] });
        }
      } catch (e) {
        if (this._stopped || e?.name === "AbortError") break;
        if (this._connected) {
          this._connected = false;
          this._disconnectEpoch += 1;
          this.onStatus?.(false);
        }
        hadDisconnect = true;
        synced = false;
        const delay = RECONNECT_DELAYS_MS[Math.min(failCount, RECONNECT_DELAYS_MS.length - 1)];
        if (failCount === 0 || failCount % 5 === 0) {
          this.log(`longpoll disconnected (${e?.message ?? e}), retry in ${delay / 1000}s`);
        }
        failCount += 1;
        await this._sleep(delay);
      } finally {
        this._abort = null;
      }
    }
  }

  stop() {
    this._stopped = true;
    this._started = false;
    if (this._unsubscribeLocal) {
      try { this._unsubscribeLocal(); } catch { /* ignore */ }
      this._unsubscribeLocal = null;
    }
    if (this._abort) {
      try { this._abort.abort(); } catch { /* ignore */ }
      this._abort = null;
    }
    if (this._connected) {
      this._connected = false;
      this.onStatus?.(false);
    }
    this._notifyWaiters();
  }

  _doorbellSize() {
    if (!this.cfg.doorbellFile) return -1;
    try { return fs.statSync(this.cfg.doorbellFile).size; } catch { return -1; }
  }

  _waitCapMs(doorbellStart, disconnectEpoch) {
    const healthy = this._connected && this._disconnectEpoch === disconnectEpoch;
    const sweepSec = Number(this.cfg.sweepSec) > 0 ? Number(this.cfg.sweepSec) : 900;
    const pollSec = Number(this.cfg.pollSec) > 0 ? Number(this.cfg.pollSec) : 45;
    return (healthy || doorbellStart >= 0 ? sweepSec : pollSec) * 1000;
  }

  async wait(isAwake, { capMs } = {}) {
    const start = this._doorbellSize();
    const disconnectEpoch = this._disconnectEpoch;
    const extraCap = Number.isFinite(capMs) && capMs > 0 ? capMs : Infinity;
    let maxWait = Math.min(extraCap, this._waitCapMs(start, disconnectEpoch));
    let waited = 0;

    while (waited < maxWait) {
      if (this._stopped) return;
      if (isAwake?.()) {
        this.log("event: waking");
        return;
      }
      const step = Math.min(1000, Math.max(10, maxWait - waited));
      const t0 = Date.now();
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          this._wakeResolvers.delete(finish);
          resolve();
        };
        this._wakeResolvers.add(finish);
        Promise.resolve(this._sleep(step)).then(finish, finish);
      });
      waited += Math.max(step, Date.now() - t0);
      maxWait = Math.min(maxWait, this._waitCapMs(start, disconnectEpoch));
      if (this._stopped) return;
      if (isAwake?.()) {
        this.log("event: waking");
        return;
      }
      if (this.cfg.doorbellFile && this._doorbellSize() !== start) {
        this.onWake?.({ source: "doorbell" });
        this.log("doorbell: event arrived, waking");
        return;
      }
    }
  }
}
