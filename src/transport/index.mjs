// 唤醒器（Waker）工厂。支持三种唤醒方式：
// - longpoll：独立中台 HTTP 长轮询（远程节点）或 Hub 进程内直连事件代理（本地模式）
// - ws：飞书 SDK 长连接（兼容传统 FeishuBus 配置）
// - poll：纯定时扫表（无事件通道时使用，默认 45 秒）
//
// 契约（hub 与 node 共用，保持稳定）：
//   createWaker(cfg, { onWake, extraHandlers, log, onStatus })
//   → { mode: "ws" | "longpoll" | "poll", start(onWake), stop(), wait(isAwake) }

import { createPollWaker } from "./poll.mjs";
import { createWsWaker } from "./ws.mjs";
import { createLongPollWaker } from "./longpoll.mjs";

export function wakerMode(cfg) {
  if (cfg?.role !== "hub" && cfg?.events === false && !cfg?.doorbellFile) {
    return "poll";
  }
  if (
    cfg?.hubUrl
    || cfg?.busType === "sqlite"
    || cfg?.busType === "http"
    || typeof cfg?.bus?.waitForChanges === "function"
    || Boolean(cfg?.bus?.broker)
    || (!cfg?.appId && !cfg?.bus?.appId)
  ) {
    return "longpoll";
  }
  return "ws";
}

export function createWaker(cfg, opts = {}) {
  const mode = wakerMode(cfg);
  if (mode !== "poll" && cfg?.role === "hub" && cfg?.events === false) {
    (opts.log ?? (() => {}))("hub 角色必须保持实时事件通道，已忽略 events:false");
  }
  if (mode === "poll") return createPollWaker(cfg, opts);
  if (mode === "longpoll") return createLongPollWaker(cfg, opts);
  return createWsWaker(cfg, opts);
}
