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

test("刚重启只见过一次的 Agent 用 6 分钟默认窗口；窗口不超过名册保留期", () => {
  withClock(({ advance, now }) => {
    const broker = new LongPollBroker();
    broker.touchAgent("grok-bot", { role: "worker" });
    advance(5 * MIN);
    assert.equal(onlineOf(broker, "grok-bot", now()), true);
    advance(2 * MIN);
    assert.equal(onlineOf(broker, "grok-bot", now()), false);

    broker.touchAgent("slow", {});
    advance(60 * MIN);
    broker.touchAgent("slow", {});
    assert.equal(broker.onlineWindowMs(broker._nodes.get("slow")), ROSTER_IDLE_MS);
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
