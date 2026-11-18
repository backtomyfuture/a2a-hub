// 在线判定：长轮询节点 90 秒，定时 HTTP Agent 按观测到的唤醒周期放宽。

import assert from "node:assert/strict";
import test from "node:test";
import { LongPollBroker, ROSTER_IDLE_MS } from "../src/server/longpoll-broker.mjs";

const MIN = 60_000;

function withClock(fn) {
  const real = Date.now;
  let now = Date.parse("2026-11-18T09:00:00.000Z");
  Date.now = () => now;
  try {
    return fn({ advance: (ms) => { now += ms; }, now: () => now });
  } finally {
    Date.now = real;
  }
}

const onlineOf = (broker, node, now) => broker.connectedNodes(now).find((n) => n.node === node)?.online;

test("每 5 分钟检查一次的 Agent 在两次检查之间保持在线，错过两轮后离线", () => {
  withClock(({ advance, now }) => {
    const broker = new LongPollBroker();
    for (let i = 0; i < 4; i++) {
      broker.touchAgent("muse", { role: "leader" });
      advance(2_000);
      broker.touchAgent("muse"); // 同一轮里的第二个请求，不计入周期
      advance(5 * MIN - 2_000);
    }
    const info = broker.connectedNodes(now()).find((n) => n.node === "muse");
    assert.equal(info.intervalSec, 300);
    assert.equal(info.online, true);
    advance(6 * MIN); // 距上次 11 分钟，未超过 2.5 倍周期
    assert.equal(onlineOf(broker, "muse", now()), true);
    advance(2 * MIN); // 13 分钟，超过 12.5 分钟
    assert.equal(onlineOf(broker, "muse", now()), false);
  });
});

test("刚重启只见过一次的 Agent 用 12.5 分钟默认窗口；窗口不超过名册保留期", () => {
  withClock(({ advance, now }) => {
    const broker = new LongPollBroker();
    broker.touchAgent("grok-bot", { role: "worker" });
    advance(12 * MIN);
    assert.equal(onlineOf(broker, "grok-bot", now()), true);
    advance(1 * MIN);
    assert.equal(onlineOf(broker, "grok-bot", now()), false);

    broker.touchAgent("slow", {});
    advance(60 * MIN);
    broker.touchAgent("slow", {});
    assert.equal(broker.onlineWindowMs(broker._nodes.get("slow")), ROSTER_IDLE_MS);
  });
});

test("Webhook 节点重启后 70 分钟仍在线，80 分钟无活动离线；成功投递刷新且不改周期，失败不刷新", () => {
  withClock(({ advance, now }) => {
    const broker = new LongPollBroker();
    broker.touchAgent("hook", { mode: "webhook", role: "worker", receiveFromCard: true });
    assert.equal(broker.onlineWindowMs(broker._nodes.get("hook")), 75 * MIN);
    advance(70 * MIN);
    assert.equal(onlineOf(broker, "hook", now()), true);
    advance(10 * MIN);
    assert.equal(onlineOf(broker, "hook", now()), false);

    broker.noteDelivery("hook");
    assert.equal(broker._nodes.get("hook").intervalMs || 0, 0);
    assert.equal(broker._nodes.get("hook").mode, "webhook");
    advance(70 * MIN);
    assert.equal(onlineOf(broker, "hook", now()), true);
    const seen = broker._nodes.get("hook").lastSeenAt;
    advance(10 * MIN);
    assert.equal(onlineOf(broker, "hook", now()), false);
    assert.equal(broker._nodes.get("hook").lastSeenAt, seen);

    // 观测到 30 分钟兜底后，2.5 倍是 75 分钟，不能被名册 30 分钟上限截断。
    broker.touchAgent("paced", { mode: "webhook", receiveFromCard: true });
    advance(30 * MIN);
    broker.touchAgent("paced", { mode: "webhook", receiveFromCard: true });
    assert.equal(broker._nodes.get("paced").intervalMs, 30 * MIN);
    assert.equal(broker.onlineWindowMs(broker._nodes.get("paced")), 75 * MIN);
    const interval = broker._nodes.get("paced").intervalMs;
    broker.noteDelivery("paced");
    assert.equal(broker._nodes.get("paced").intervalMs, interval);
    broker.touchAgent("paced", { mode: "http-poll" });
    assert.equal(broker._nodes.get("paced").mode, "webhook");
    assert.equal(broker._nodes.get("paced").intervalMs, interval);

    // 门铃触发的 poll 很密，估出的周期很短，也不能把窗口缩到几分钟。
    broker.touchAgent("bell", { mode: "webhook", receiveFromCard: true });
    advance(2 * MIN);
    broker.touchAgent("bell", { mode: "http-poll" });
    advance(2 * MIN);
    broker.touchAgent("bell", { mode: "http-poll" });
    assert.ok(broker._nodes.get("bell").intervalMs < 5 * MIN);
    assert.equal(broker.onlineWindowMs(broker._nodes.get("bell")), 75 * MIN);
    advance(60 * MIN);
    assert.equal(onlineOf(broker, "bell", now()), true);
  });
});

test("长轮询宿主节点仍按 90 秒判离线", () => {
  withClock(({ advance, now }) => {
    const broker = new LongPollBroker();
    broker._touchNode("mac-host", 0, "", 0);
    advance(80_000);
    assert.equal(onlineOf(broker, "mac-host", now()), true);
    advance(20_000);
    assert.equal(onlineOf(broker, "mac-host", now()), false);
  });
});
