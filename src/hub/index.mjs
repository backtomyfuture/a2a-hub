// hub 角色主循环：node 能力的超集（单进程承载能力登记与执行、SQLite + HTTP 长轮询网关、
// Web 控制台、ed25519 审批发卡、结果呈递、陈旧告警与 later 复查）。
// 唤醒通道走 src/transport/index.mjs 的 createWaker（longpoll，hub 进程内直连 Broker）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Kernel } from "../kernel.mjs";
import { formatStats } from "../kernel-util.mjs";
import { readEnvFile, resolveListenAddr } from "../config.mjs";
import { ApprovalService } from "./approval.mjs";
import { PresentService } from "./present.mjs";
import { StaleService } from "./stale.mjs";
import { ScheduleService } from "./schedule.mjs";
import { FileRetentionService, FileStore } from "./files.mjs";
import { ExternalNotifier } from "./notifier.mjs";
import { WebhookDispatcher } from "./webhooks.mjs";
import { readOwnerFromConfigDir } from "./owner.mjs";
import { loadOrCreateHubKey } from "../approval-sign.mjs";
import { LongPollBroker } from "../server/longpoll-broker.mjs";
import { startHubHttpServer } from "../server/http-server.mjs";

function logLine(msg) {
  console.log(new Date().toISOString().slice(0, 19), msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 在线记录在内存里，进程一退就没了。节流写入 meta（不推进总线 seq），失败只记日志，不能因此退出。
async function bindPresence(broker, bus, log) {
  if (!broker || !bus) return;
  if (typeof broker.attachPresenceSink === "function" && typeof bus.setMeta === "function") {
    broker.attachPresenceSink((snap) => Promise.resolve()
      .then(() => bus.setMeta("presence", JSON.stringify(snap)))
      .catch((e) => log("在线快照写入失败：" + (e?.message ?? e))));
  }
  if (typeof bus.getMeta !== "function" || typeof broker.loadPresence !== "function") return;
  let raw = null;
  try {
    raw = await bus.getMeta("presence");
  } catch (e) {
    log("在线快照读取失败，按空名册继续：" + (e?.message ?? e));
    return;
  }
  if (!raw) return;
  try {
    const n = broker.loadPresence(JSON.parse(raw));
    if (n > 0) log(`已恢复 ${n} 条在线记录`);
  } catch (e) {
    log("在线快照无法解析，按空名册继续：" + (e?.message ?? e));
  }
}

async function importWakerModule() {
  const base = new URL("../transport/index.mjs", import.meta.url);
  try {
    return await import(base.href);
  } catch (first) {
    // 失败的 import 会被 Node 缓存。文件稍后写好时，用新的 URL 再试一次。
    const bust = new URL("../transport/index.mjs", import.meta.url);
    bust.searchParams.set("hubRetry", String(Date.now()));
    try {
      return await import(bust.href);
    } catch {
      throw first;
    }
  }
}

export async function hubDoctor(configDir) {
  let problems = 0;
  const ok = (msg) => console.log("  ✓ " + msg);
  const bad = (msg) => console.log("  ✗ " + msg);
  const info = (msg) => console.log("  · " + msg);
  console.log("hub 角色检查");
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(configDir, "node.json"), "utf8"));
  } catch (e) {
    bad("hub 读 node.json 失败：" + e.message);
    problems++;
  }
  let owner = "";
  try {
    owner = readOwnerFromConfigDir(configDir);
  } catch (e) {
    bad("hub 读取机主配置失败：" + e.message);
    problems++;
  }
  try {
    const addr = resolveListenAddr(raw?.listen ?? "0.0.0.0:8787");
    ok(`独立中台模式（SQLite + HTTP 长轮询 + Web 控制台），监听 ${addr.host}:${addr.port}`);
  } catch (e) {
    bad("listen 地址配置非法：" + e.message);
    problems++;
  }
  let kv = {};
  if (raw?.appEnv) {
    try { kv = readEnvFile(String(raw.appEnv).replace(/^~/, os.homedir())); } catch {}
  } else {
    try { kv = readEnvFile(path.join(configDir, "app.env")); } catch {}
  }
  const hasApiToken = Boolean(
    raw?.apiToken
    || kv.AH_API_TOKEN
    || process.env.AH_API_TOKEN,
  );
  if (!hasApiToken) {
    info("未配置 apiToken：若要暴露到公网或不可信局域网，建议在 node.json 或 app.env 设置 apiToken");
  } else {
    ok("apiToken 已配置（不显示明文）");
  }
  if (!owner) {
    info("使用内置 Web 控制台执行 ed25519 签名审批");
  } else {
    ok("机主标识已配置（不显示明文）");
  }
  const sweep = Number(raw?.sweepSec);
  const sweepSec = Number.isFinite(sweep) && sweep > 0 ? sweep : 900;
  info(`唤醒：进程内事件代理（LongPollBroker）＋ HTTP 长轮询网关 ＋ ${sweepSec}s 对账扫表。`);
  try {
    const mod = await importWakerModule();
    if (typeof mod.createWaker !== "function") {
      bad("src/transport/index.mjs 未导出 createWaker。");
      problems++;
    } else {
      ok("事件唤醒模块 createWaker 可加载");
    }
  } catch (e) {
    bad("事件唤醒模块不可用（" + e.message + "）。");
    problems++;
  }
  try {
    const present = await import("./present.mjs");
    const stale = await import("./stale.mjs");
    const schedule = await import("./schedule.mjs");
    if (typeof present.PresentService !== "function" || typeof present.presentKey !== "function") {
      bad("结果呈递模块不可用");
      problems++;
    } else {
      ok("结果呈递：归属于本节点或主节点的任务回执（completed / failed / rejected / input-required）写入 present_queue.jsonl，由本机 Agent 经 ah present（可 --wait）取走，去重键记在 present_state.json 与线上 Metadata");
    }
    if (typeof stale.StaleService !== "function") {
      bad("陈旧告警模块不可用");
      problems++;
    } else {
      ok("陈旧告警与回收：working 心跳超过 20 分钟或为空先告警，告警后宽限 30 分钟无心跳则置 failed；Metadata 里的租约到期、排队超时与挂起超时也会回收。没写这些秒数时，submitted 超过 20 分钟只告警。约每 60 秒巡检一次，状态在 stale_state.json");
    }
    if (typeof schedule.ScheduleService !== "function" || typeof schedule.parseCron !== "function") {
      bad("定时调度模块不可用");
      problems++;
    } else {
      ok("定时调度由各节点本地执行（schedules.json＋本地时钟），hub 不再按 Rules 建单；hub 只处理 later 复查。Rules 的计划行是节点写的只读观察镜像。");
    }
    if (!raw?.tables?.rules) {
      info("Rules 观察镜像将跳过");
    }
  } catch (e) {
    bad("呈递或告警模块加载失败：" + e.message);
    problems++;
  }
  try {
    fs.accessSync(configDir, fs.constants.W_OK);
    ok("配置目录可写，呈递与告警状态可以落盘");
  } catch {
    bad("配置目录不可写，呈递去重和陈旧告警无法记住已发送项");
    problems++;
  }
  info("建单：ah task create --to <node> --cap <cap_id>。先写 instruction 与 Parts，最后写 Tasks 行。doctor 不写表。");
  return problems;
}

export async function runHub(cfg, log = logLine, hooks = {}) {
  // 工厂只在 role===hub 时强制实时事件通道。loadConfig 不带这个字段。
  cfg.role = "hub";
  let ownerId = "";
  try {
    ownerId = readOwnerFromConfigDir(cfg.configDir);
  } catch (e) {
    log("读取机主配置失败（进程不退出）：" + (e?.message ?? e));
  }
  const isStandalone = cfg.busType === "sqlite" || typeof cfg.bus?.attachBroker === "function";
  if (cfg.events === false) {
    log("hub 角色忽略 events=false：保持实时事件唤醒通道，不退化为纯轮询。");
  }
  // 审批签名密钥：没有就生成。hub 自己认领任务时也按这把公钥验签，不认没签名的决定。
  let signKey = null;
  try {
    const key = loadOrCreateHubKey(cfg.configDir);
    signKey = key.privateKey;
    cfg.hubPublicKey = key.publicKey;
    log(`hubPublicKey=${key.publicKey}`);
  } catch (e) {
    log("审批签名密钥不可用，决定将不带签名（配了 hubPublicKey 的节点不会认）：" + (e?.message ?? e));
  }

  let broker = null;
  let notifier = null;
  let webhookDispatcher = null;
  if (isStandalone) {
    broker = new LongPollBroker({ initialSeq: cfg.bus?.currentSeq?.() ?? 0 });
    cfg.bus?.attachBroker?.(broker);
    // 先装回上次的 last_seen，再让内核 touch。loadPresence 会跳过已经在内存里的节点。
    await bindPresence(broker, cfg.bus, log);
    if (cfg.notifications) {
      notifier = new ExternalNotifier({
        config: cfg.notifications,
        publicUrl: cfg.publicUrl || cfg.notifications.publicUrl || "",
        log,
      });
      cfg.bus?.attachNotifier?.(notifier);
    }
    // 门铃与外部通知器同时挂在总线上。attachNotifier 只保留一个，Webhook 走 addListener。
    if (cfg.configDir) {
      try {
        webhookDispatcher = new WebhookDispatcher({
          configDir: cfg.configDir,
          hubNode: cfg.node || "hub",
          taskTable: cfg.bus?.tables?.tasks || "tasks",
          messageTable: cfg.bus?.tables?.messages || "messages",
          bus: cfg.bus,
          broker,
          log,
        });
        cfg.bus?.addListener?.(webhookDispatcher);
      } catch (e) {
        log("Webhook 门铃不可用（进程不退出）：" + (e?.message ?? e));
      }
    }
  }

  const approval = new ApprovalService({
    bus: cfg.bus,
    ownerId,
    allowLocalOwner: isStandalone,
    statePath: path.join(cfg.configDir, "approval_state.json"),
    log,
    signKey,
  });
  const present = new PresentService({
    bus: cfg.bus,
    ownerId,
    nodeName: cfg.node,
    role: "hub",
    statePath: path.join(cfg.configDir, "present_state.json"),
    queuePath: path.join(cfg.configDir, "present_queue.jsonl"),
    log,
  });
  const stale = new StaleService({
    bus: cfg.bus,
    ownerId,
    allowLocalAlert: isStandalone,
    notifier,
    statePath: path.join(cfg.configDir, "stale_state.json"),
    log,
  });
  const schedule = new ScheduleService({
    bus: cfg.bus,
    log,
  });

  const runtime = new HubRuntime({ cfg, approval, present, stale, schedule, log });
  let httpHandle = null;
  let fileStore = null;
  let fileRetention = null;
  if (isStandalone) {
    if (cfg.configDir) {
      try {
        fileStore = new FileStore({
          configDir: cfg.configDir,
          ...(Number.isFinite(Number(cfg?.maxFileBytes)) && Number(cfg.maxFileBytes) > 0
            ? { maxBytes: Number(cfg.maxFileBytes) }
            : {}),
        });
        fileRetention = new FileRetentionService({
          fileStore,
          bus: cfg.bus,
          log,
        });
        fileRetention.start();
      } catch (e) {
        log("初始化文件存储与清理服务失败（进程不退出）：" + (e?.message ?? e));
      }
    }
    try {
      httpHandle = await startHubHttpServer({
        cfg,
        bus: cfg.bus,
        broker,
        approval,
        fileStore,
        log,
        onWake: () => runtime.wakeNow(),
        webhookDispatcher,
      });
    } catch (e) {
      log("启动 Hub HTTP 服务失败（将继续主循环）：" + (e?.message ?? e));
    }
    runtime._onStop = async () => {
      fileRetention?.stop();
      broker?.close();
      await httpHandle?.close();
      fileStore?.close();
      cfg.bus?.close?.();
    };
  }

  if (typeof hooks.onRuntime === "function") hooks.onRuntime(runtime);
  runtime.startWsLoop();
  await runtime.run();
}

export class HubRuntime {
  constructor({ cfg, approval, present, stale, schedule, log, createWaker, retryMs }) {
    this.cfg = cfg;
    this.approval = approval;
    this.present = present;
    this.stale = stale;
    this.schedule = schedule;
    this.log = log;
    this.createWaker = createWaker ?? null;
    this.kernel = new Kernel(this.cfg);
    // direct 命令结束时内核只抬自己的标志。hub 的等待看的是这一层的标志。
    this.kernel._notifyWake = () => this.wakeNow();
    const retry = Number(retryMs);
    this._retryBase = Number.isFinite(retry) && retry >= 0 ? retry : 5000;
    this._delay = this._retryBase;
    this._wakeFlag = false;
    this._wakeResolvers = new Set();
    this._wsUp = false;
    this._stopped = false;
    this._waker = null;
    this._kickTimer = null;
    this._staleTimer = null;
    this._onStop = null;
  }

  noteHubPresence() {
    try { this.kernel?.touchLocalPresence?.(); }
    catch (e) { this.log("本机在线登记失败：" + (e?.message ?? e)); }
  }

  // 陈旧巡检跟 15 分钟对账解开。链式 setTimeout，退出时清掉，不改 sweepSec。
  startStaleWatch() {
    this.stopStaleWatch();
    const arm = () => {
      if (this._stopped) return;
      this._staleTimer = setTimeout(() => {
        this._staleTimer = null;
        if (this._stopped) return;
        this.noteHubPresence();
        Promise.resolve(this.stale?.scan?.()).catch((e) => {
          this.log("陈旧巡检失败（下一分钟再试）：" + (e?.message ?? e));
        }).finally(() => arm());
      }, 60_000);
      this._staleTimer.unref?.();
    };
    arm();
  }

  stopStaleWatch() {
    if (this._staleTimer) {
      clearTimeout(this._staleTimer);
      this._staleTimer = null;
    }
  }

  wakeNow() {
    this._wakeFlag = true;
    for (const resolve of Array.from(this._wakeResolvers)) {
      this._wakeResolvers.delete(resolve);
      resolve();
    }
  }

  sweepSec() {
    const n = Number(this.cfg.sweepSec);
    return Number.isFinite(n) && n > 0 ? n : 900;
  }

  refreshOwner() {
    let owner = "";
    try {
      owner = readOwnerFromConfigDir(this.cfg.configDir);
    } catch (e) {
      this.log("读取机主配置失败：" + (e?.message ?? e));
    }
    if (this.approval) this.approval.ownerId = owner;
    if (this.present) this.present.ownerId = owner;
    if (this.stale) this.stale.ownerId = owner;
  }

  startWsLoop() {
    this.kick(0);
  }

  stop() {
    this._stopped = true;
    this.stopStaleWatch();
    clearTimeout(this._kickTimer);
    this._kickTimer = null;
    // 分钟定时器挂在内核上。这里清掉，避免 hub 退出后它还握着进程。
    try { this.kernel?.stopMinuteTimer(); }
    catch (e) { this.log("停止分钟定时器失败：" + (e?.message ?? e)); }
    this.closeConnection();
    this.wakeNow();
    if (typeof this._onStop === "function") {
      Promise.resolve(this._onStop()).catch((e) => {
        this.log("停止 HTTP 服务失败：" + (e?.message ?? e));
      });
    }
  }

  kick(delayMs) {
    if (this._stopped) return;
    clearTimeout(this._kickTimer);
    this._kickTimer = setTimeout(() => {
      this._kickTimer = null;
      if (this._stopped) return;
      this.openConnection().catch((e) => {
        if (this._stopped) return;
        this._wsUp = false;
        this.log("hub 长连接失败，不允许退化为纯轮询，将重试：" + (e?.message ?? e));
        const wait = this._delay;
        this._delay = Math.min(this._delay * 2, 60_000);
        this.kick(wait);
      });
    }, delayMs);
  }

  closeConnection() {
    const waker = this._waker;
    // 先摘掉引用，stop() 里若再回调 onStatus(false) 不会再开一条。
    this._waker = null;
    this._wsUp = false;
    if (this.kernel) this.kernel._wsUp = false;
    if (!waker) return;
    try { waker.stop?.(); } catch (e) {
      this.log("hub 长连接关闭失败：" + (e?.message ?? e));
    }
  }

  scheduleRetry() {
    const wait = this._delay;
    this._delay = Math.min(this._delay * 2, 60_000);
    this.kick(wait);
  }

  // 运输层把 SDK 的 onError 转成 onStatus(false)。SDK 只在不再重连时才走 onError
  // （首次连接不可恢复，或重试次数用尽）。start() 自己抛错也算没连上。
  // 这两种都不能干等，也不能再开第二条：先停掉当前实例，退避后再建一条。
  async openConnection() {
    if (this._stopped) return;
    this.closeConnection();
    this.cfg.role = "hub";
    const factory = this.createWaker ?? (await importWakerModule()).createWaker;
    if (this._stopped) return;
    if (typeof factory !== "function") throw new Error("src/transport/index.mjs 未导出 createWaker");
    let mine = null;
    const waker = await factory(this.cfg, {
      onWake: () => this.wakeNow(),
      onStatus: (up) => {
        if (this._stopped || !mine || this._waker !== mine) return;
        this._wsUp = !!up;
        if (this.kernel) this.kernel._wsUp = !!up;
        if (up) {
          this._delay = this._retryBase;
          this.log("hub 实时事件通道已就绪");
          return;
        }
        this.log("hub 实时事件通道未就绪，将退避后重连。");
        this.closeConnection();
        this.scheduleRetry();
      },
      log: (msg) => this.log(String(msg ?? "")),
    });
    if (this._stopped) {
      try { waker?.stop?.(); } catch { /* 退出时拆掉刚建的实例 */ }
      return;
    }
    if (waker?.mode !== "longpoll" || typeof waker.start !== "function") {
      try { waker?.stop?.(); } catch { /* 退路实例不要留着 */ }
      throw new Error(`hub 角色需要 longpoll 唤醒器，实际是 ${waker?.mode ?? "未知"}。`);
    }
    mine = waker;
    this._waker = waker;
    try {
      waker.start();
    } catch (e) {
      if (this._waker === waker) this.closeConnection();
      throw e;
    }
    if (this._waker === waker) {
      this.log(`hub 事件唤醒器已挂载（longpoll）。对账间隔 ${this.sweepSec()}s。`);
    }
  }

  async waitWake() {
    const pendingCap = this.kernel?.pendingWaitCapMs?.() ?? Infinity;
    const maxWait = Math.min(pendingCap, this.sweepSec() * 1000);
    let waited = 0;
    while (waited < maxWait) {
      if (this._stopped) return;
      if (this._wakeFlag) {
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
        sleep(step).then(finish, finish);
      });
      waited += Math.max(step, Date.now() - t0);
      if (this._stopped) return;
      if (this._wakeFlag) {
        this.log("event: waking");
        return;
      }
    }
  }

  // 分段记，这样某一段失败仍能看出另外几段发了多少请求。
  // kernel 的扫表由 Kernel.sweepOnce 自己打 sweep end，这里不再加一行。
  async scanSections() {
    const jobs = [
      ["approval", () => this.approval?.scan()],
      ["present", () => this.present?.scan()],
      ["stale", () => this.stale?.scan()],
      ["schedule", () => this.schedule?.scan()],
    ];
    for (const [name, job] of jobs) {
      const t0 = Date.now();
      let ok = false;
      try {
        await job();
        ok = true;
      } catch (e) {
        this.log(name + " scan failed: " + (e?.message ?? e));
      } finally {
        this.log(formatStats(`scan ${name}`, Date.now() - t0, ok, this.cfg.bus?.takeStats?.()));
      }
    }
  }

  async run() {
    this.log(`hub daemon starting on ${this.cfg.node}（对账 ${this.sweepSec()}s，SQLite + HTTP 长轮询事件驱动；含能力登记与接单、审批、呈递、陈旧告警、later 复查；本机计划由内核本地调度）`);
    // hub 不走 Kernel.run。分钟定时器仍要起：到点经 kernel._notifyWake 抬这里的 _wakeFlag。
    this.kernel?.startMinuteTimer();
    this.noteHubPresence();
    this.startStaleWatch();
    try {
    try {
      await this.cfg.bus.tenantToken();
    } catch (e) {
      this.log("initial token failed (will retry in loop): " + (e?.message ?? e));
    }
    for (;;) {
      if (this._stopped) return;
      this._wakeFlag = false;
      this.refreshOwner();
      if (!this._wsUp) {
        this.log("hub 事件唤醒器尚未就绪：本轮先执行对账扫表，同时继续等待/重连事件通道。");
      }
      try {
        await this.kernel.sweepOnce();
      } catch (e) {
        this.log("kernel sweep error: " + (e?.message ?? e));
      }
      await this.scanSections();
      if (this._wakeFlag) continue;
      await this.waitWake();
    }
    } finally {
      this.stopStaleWatch();
      try { this.kernel?.stopMinuteTimer(); }
      catch (e) { this.log("停止分钟定时器失败：" + (e?.message ?? e)); }
    }
  }
}
