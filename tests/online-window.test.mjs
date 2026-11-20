// 在线判定：长轮询节点 90 秒，定时 HTTP Agent 按观测到的唤醒周期放宽。

import assert from "node:assert/strict";
import test from "node:test";
import { LongPollBroker, ROSTER_IDLE_MS, rosterNodeVisible } from "../src/server/longpoll-broker.mjs";

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

test("每 5 分钟检查一次的 Agent 在 1.5 倍周期内保持在线", () => {
  withClock(({ advance, now }) => {
    const broker = new LongPollBroker();
    for (let i = 0; i < 4; i++) {
      broker.touchAgent("muse", { role: "leader" });
      advance(2_000);
      broker.touchAgent("muse"); // 同一轮里的第二个请求，不计入周期
      if (i < 3) advance(5 * MIN - 2_000);
    }
    const info = broker.connectedNodes(now()).find((n) => n.node === "muse");
    assert.equal(info.intervalSec, 300);
    assert.equal(info.online, true);
    assert.equal(info.pollIntervalMin, null);
    // 观测到 5 分钟，窗口是 7.5 分钟，不再用 2.5 倍。
    assert.equal(broker.onlineWindowMs(broker._nodes.get("muse")), 7.5 * MIN);
    advance(7 * MIN);
    assert.equal(onlineOf(broker, "muse", now()), true);
    advance(1 * MIN);
    assert.equal(onlineOf(broker, "muse", now()), false);
  });
});

test("刚重启只见过一次的 Agent 用 7.5 分钟默认窗口；未配置间隔时观测窗口不超过名册保留期", () => {
  withClock(({ advance, now }) => {
    const broker = new LongPollBroker();
    broker.touchAgent("grok-bot", { role: "worker" });
    assert.equal(broker.onlineWindowMs(broker._nodes.get("grok-bot")), 7.5 * MIN);
    advance(7 * MIN);
    assert.equal(onlineOf(broker, "grok-bot", now()), true);
    advance(1 * MIN);
    assert.equal(onlineOf(broker, "grok-bot", now()), false);

    broker.touchAgent("slow", {});
    advance(60 * MIN);
    broker.touchAgent("slow", {});
    assert.equal(broker.onlineWindowMs(broker._nodes.get("slow")), ROSTER_IDLE_MS);
  });
});

test("Webhook 未配置间隔时窗口是 45 分钟；成功投递刷新且不改周期，失败不刷新", () => {
  withClock(({ advance, now }) => {
    const broker = new LongPollBroker();
    broker.touchAgent("hook", { mode: "webhook", role: "worker", receiveFromCard: true });
    assert.equal(broker.onlineWindowMs(broker._nodes.get("hook")), 45 * MIN);
    advance(40 * MIN);
    assert.equal(onlineOf(broker, "hook", now()), true);
    advance(10 * MIN);
    assert.equal(onlineOf(broker, "hook", now()), false);

    broker.noteDelivery("hook");
    assert.equal(broker._nodes.get("hook").intervalMs || 0, 0);
    assert.equal(broker._nodes.get("hook").mode, "webhook");
    advance(40 * MIN);
    assert.equal(onlineOf(broker, "hook", now()), true);
    const seen = broker._nodes.get("hook").lastSeenAt;
    advance(10 * MIN);
    assert.equal(onlineOf(broker, "hook", now()), false);
    assert.equal(broker._nodes.get("hook").lastSeenAt, seen);

    // 没写 poll_interval_min 时，Webhook 固定 30 × 1.5 = 45 分钟，不拿观测周期去估，也不被 30 分钟截断。
    broker.touchAgent("paced", { mode: "webhook", receiveFromCard: true });
    advance(30 * MIN);
    broker.touchAgent("paced", { mode: "webhook", receiveFromCard: true });
    assert.equal(broker._nodes.get("paced").intervalMs, 30 * MIN);
    assert.equal(broker.onlineWindowMs(broker._nodes.get("paced")), 45 * MIN);
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
    assert.equal(broker.onlineWindowMs(broker._nodes.get("bell")), 45 * MIN);
    advance(40 * MIN);
    assert.equal(onlineOf(broker, "bell", now()), true);
    advance(10 * MIN);
    assert.equal(onlineOf(broker, "bell", now()), false);
  });
});

test("自定义 pollIntervalMin 按 1.5 倍开窗口，60 分钟不被 30 分钟名册期限截断", () => {
  withClock(({ advance, now }) => {
    const broker = new LongPollBroker();
    assert.equal(broker.setNodePollInterval("missing", 60), null);

    broker.touchAgent("hourly", { mode: "http-poll", pollIntervalMin: 60 });
    assert.equal(broker.connectedNodes(now()).find((n) => n.node === "hourly").pollIntervalMin, 60);
    assert.equal(broker.onlineWindowMs(broker._nodes.get("hourly")), 90 * MIN);
    advance(80 * MIN);
    assert.equal(onlineOf(broker, "hourly", now()), true);
    const hourly = broker._nodes.get("hourly");
    assert.equal(rosterNodeVisible({ lastSeenAt: hourly.lastSeenAt, pollIntervalMin: 60 }, false, now()), true);
    advance(15 * MIN);
    assert.equal(onlineOf(broker, "hourly", now()), false);
    assert.equal(rosterNodeVisible({ lastSeenAt: hourly.lastSeenAt, pollIntervalMin: 60 }, false, now()), false);

    broker.touchAgent("late", { mode: "http-poll" });
    broker.setNodePollInterval("late", 60);
    assert.equal(broker.onlineWindowMs(broker._nodes.get("late")), 90 * MIN);
    // 1 分钟间隔 × 1.5 是 1.5 分钟，不能被 3 分钟下限拉长；仍不低于长轮询的 90 秒。
    broker.touchAgent("tiny", { mode: "http-poll", pollIntervalMin: 1 });
    assert.equal(broker.onlineWindowMs(broker._nodes.get("tiny")), 90_000);

    broker.touchAgent("hook-hour", { mode: "webhook", receiveFromCard: true, pollIntervalMin: 60 });
    assert.equal(broker.onlineWindowMs(broker._nodes.get("hook-hour")), 90 * MIN);
    broker.noteDelivery("hook-hour");
    assert.equal(broker._nodes.get("hook-hour").pollIntervalMin, 60);
    assert.equal(broker.onlineWindowMs(broker._nodes.get("hook-hour")), 90 * MIN);

    // Hub 重启预同步：未活动前先 setNodePollInterval，随后直接触发 noteDelivery 也应套用 60 × 1.5 = 90 分钟窗口。
    assert.equal(broker.setNodePollInterval("cold-hook", 60), null);
    broker.noteDelivery("cold-hook");
    assert.equal(broker._nodes.get("cold-hook").pollIntervalMin, 60);
    assert.equal(broker.onlineWindowMs(broker._nodes.get("cold-hook")), 90 * MIN);
    broker.forgetNode("cold-hook");
    broker.noteDelivery("cold-hook");
    assert.equal(broker._nodes.get("cold-hook").pollIntervalMin, 0);
    assert.equal(broker.onlineWindowMs(broker._nodes.get("cold-hook")), 45 * MIN);
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
