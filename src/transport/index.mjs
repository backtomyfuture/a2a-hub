// 唤醒器（Waker）工厂。支持两种唤醒方式：
// - longpoll：独立中台 HTTP 长轮询（远程节点）或 Hub 进程内直连事件代理（本地 SQLite 模式）
// - poll：纯定时扫表（无事件通道时使用，默认 45 秒）
//
// 契约（hub 与 node 共用，保持稳定）：
//   createWaker(cfg, { onWake, log, onStatus })
//   → { mode: "longpoll" | "poll", start(onWake), stop(), wait(isAwake) }

import { createPollWaker } from "./poll.mjs";
import { createLongPollWaker } from "./longpoll.mjs";

export function wakerMode(cfg) {
  if (cfg?.role !== "hub" && cfg?.events === false && !cfg?.doorbellFile) {
    return "poll";
  }
  return "longpoll";
}

export function createWaker(cfg, opts = {}) {
  const mode = wakerMode(cfg);
  if (mode !== "poll" && cfg?.role === "hub" && cfg?.events === false) {
    (opts.log ?? (() => {}))("hub 角色必须保持实时事件通道，已忽略 events:false");
  }
  if (mode === "poll") return createPollWaker(cfg, opts);
  return createLongPollWaker(cfg, opts);
}
