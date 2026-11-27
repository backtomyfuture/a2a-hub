import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { GatewayClient } from "../src/client/gateway-client.mjs";
import { runInboxCommand, runScheduleCommand } from "../src/client/inbox.mjs";
import {
  DEFAULT_TIMEZONE,
  defaultHubTimezone,
  estimateCronIntervalMin,
  getZonedParts,
  nextCronRunMs,
  normalizeTimezone,
  parseCronExpr,
  parseEveryToMinutes,
} from "../src/core/cron.mjs";
import { startHubRuntime } from "../src/core/hub-runtime.mjs";
import { ScheduleService } from "../src/core/schedules.mjs";
import { TaskService } from "../src/core/task-service.mjs";
import { HubStore } from "../src/store/db.mjs";

// 守护红线：5 段 Cron、宏、闰年 2/29 与 23 小时夏令时拨快日计算精确；
// 默认时区固定为 Asia/Shanghai（仅认 AH_TIMEZONE，不受容器 TZ=UTC 宿主环境影响，防 8 小时偏移）。
test("cron engine & default timezone: 5-field syntax, DST spring-forward, and UTC container immunity", () => {
  assert.equal(DEFAULT_TIMEZONE, "Asia/Shanghai");
  assert.equal(defaultHubTimezone({ TZ: "UTC" }), "Asia/Shanghai", "容器 TZ=UTC 时默认时区仍须固定为 Asia/Shanghai");
  assert.equal(defaultHubTimezone({ TZ: "UTC", AH_TIMEZONE: "America/New_York" }), "America/New_York");
  assert.equal(defaultHubTimezone({ AH_TIMEZONE: "Invalid/Zone" }), "Asia/Shanghai");

  assert.equal(normalizeTimezone(""), "Asia/Shanghai");
  assert.equal(normalizeTimezone("UTC"), "UTC");
  assert.throws(() => normalizeTimezone("Mars/Olympus"), /无效的 IANA 时区/);
  assert.throws(() => parseCronExpr("0 8 * *"), /5 段格式/);
  assert.throws(() => parseCronExpr("61 8 * * *"), /超出允许范围/);

  const anchorUtcMidnight = Date.parse("2026-11-26T00:00:00Z"); // 北京时间 08:00:00
  const nextUtc = nextCronRunMs("0 8 * * *", anchorUtcMidnight, "UTC");
  const nextShanghai = nextCronRunMs("0 8 * * *", anchorUtcMidnight, "Asia/Shanghai");
  assert.equal(nextUtc, Date.parse("2026-11-26T08:00:00Z"));
  assert.equal(nextShanghai, Date.parse("2026-11-27T00:00:00Z"));

  assert.equal(estimateCronIntervalMin("*/15 * * * *", anchorUtcMidnight, "Asia/Shanghai"), 15);
  assert.equal(estimateCronIntervalMin("@daily", anchorUtcMidnight, "Asia/Shanghai"), 1440);
  assert.equal(parseEveryToMinutes("15m"), 15);
  assert.equal(parseEveryToMinutes("2h"), 120);
  assert.equal(parseEveryToMinutes("6d"), 8640);
  assert.equal(parseEveryToMinutes("1w"), 10080);
  assert.equal(parseEveryToMinutes("6天"), 8640);
  assert.throws(() => parseEveryToMinutes("forever"), /无法识别周期简写/);

  const leapNext = nextCronRunMs("30 6 29 2 *", Date.parse("2026-03-01T00:00:00Z"), "UTC");
  const p = getZonedParts(leapNext, "UTC");
  assert.deepEqual({ year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute }, {
    year: 2028,
    month: 2,
    day: 29,
    hour: 6,
    minute: 30,
  });

  // 美东夏令时拨快日（2026-03-08 仅 23 小时）：周日 00:30 EST 查周一 00:00 EDT 绝不能跨过 00:00
  const nySpringAnchor = Date.parse("2026-03-08T05:30:00Z");
  const nyMondayMidnight = nextCronRunMs("0 0 * * 1", nySpringAnchor, "America/New_York");
  const nyParts = getZonedParts(nyMondayMidnight, "America/New_York");
  assert.deepEqual({ year: nyParts.year, month: nyParts.month, day: nyParts.day, hour: nyParts.hour, minute: nyParts.minute }, {
    year: 2026,
    month: 3,
    day: 9,
    hour: 0,
    minute: 0,
  });
});

// 守护红线：旧版 9 列 schedules 存量数据库升级后保留全部历史数据，并补齐 driver / timezone / last_duration_ms 等新列。
test("store migration: legacy 9-column schedules table upgrades cleanly without data loss", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-sch-mig-"));
  const dbPath = path.join(dir, "hub.db");
  try {
    const bootstrap = new HubStore(dbPath);
    bootstrap.createAgent({ id: "grok-bot", kind: "cloud", name: "Grok Bot" });
    bootstrap.close();

    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      DROP TABLE schedules;
      CREATE TABLE schedules (
        id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        cron_expr TEXT NOT NULL DEFAULT '',
        interval_min INTEGER NOT NULL DEFAULT 60,
        summary TEXT NOT NULL DEFAULT '',
        last_run_at INTEGER,
        last_task_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (agent_id, id)
      );
      INSERT INTO schedules (id, agent_id, name, cron_expr, interval_min, summary, last_run_at, enabled)
      VALUES ('legacy-job', 'grok-bot', '旧版续签', '0 9 * * *', 1440, '旧摘要', 1700000000000, 1);
    `);
    rawDb.close();

    const store = new HubStore(dbPath);
    const migrated = store.getSchedule("grok-bot", "legacy-job");
    assert.ok(migrated);
    assert.equal(migrated.name, "旧版续签");
    assert.equal(migrated.driver, "edge");
    assert.equal(migrated.timezone, "Asia/Shanghai");
    assert.equal(migrated.interval_min, 1440);
    assert.equal(migrated.last_run_at, 1700000000000);
    assert.equal(migrated.last_duration_ms, null);
    assert.equal(migrated.triggerable, false, "存量旧表迁移后外部条目 triggerable 默认必须为 false");
    const taskSvc = new TaskService(store);
    const schSvc = new ScheduleService(store, taskSvc);
    assert.throws(
      () => schSvc.triggerNow("grok-bot", "legacy-job"),
      (err) => err.statusCode === 409 && err.code === "not_triggerable"
    );
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 守护红线（回归 Bug #1 & #2）：
// 1) `ah schedule ok/fail/noop` 未传 --cron / --timezone 时严禁清空既有 cron_expr 或重置 timezone；
// 2) `ah schedule run` 直接传递参数数组（不经 shell 破坏引号），且子进程被信号杀死（如 SIGKILL）必须判失败并返回非 0 退出码。
test("CLI ah schedule: preserves cron/timezone on ok/fail/noop, preserves quotes in run, and treats SIGKILL as failed", async () => {
  const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-cli-hub-"));
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-cli-agent-"));
  const ownerToken = "ah_cli_owner_secret";

  const rt = await startHubRuntime({
    configDir: hubDir,
    listen: "127.0.0.1:0",
    withDeviceDaemon: false,
    env: { AH_API_TOKEN: ownerToken },
  });

  try {
    const owner = new GatewayClient(rt.url, { token: ownerToken });
    const museCreated = await owner.post("/api/v1/agents", {
      id: "muse",
      name: "Muse Bot",
      role: "worker",
      platform: "muse",
    });

    fs.writeFileSync(
      path.join(cliDir, "config.json"),
      JSON.stringify({ mode: "agent", agentId: "muse", hubUrl: rt.url, agentToken: museCreated.token }),
      { mode: 0o600 }
    );

    // 先建立带显式 cron_expr 与非默认时区 America/New_York 的条目
    await owner.upsertSchedule("muse", "ny-report", {
      name: "美东收盘归档",
      driver: "edge",
      cron_expr: "0 17 * * 1-5",
      timezone: "America/New_York",
    });

    const silentIo = { log: () => {}, error: () => {} };
    await runScheduleCommand(["ok", "ny-report", "收盘归档完成"], { configDir: cliDir, io: silentIo });
    await runScheduleCommand(["noop", "ny-report"], { configDir: cliDir, io: silentIo });
    await runScheduleCommand(["fail", "ny-report", "接口限流"], { configDir: cliDir, io: silentIo });

    const afterCliReports = rt.store.getSchedule("muse", "ny-report");
    assert.equal(afterCliReports.cron_expr, "0 17 * * 1-5", "ok/noop/fail 上报不得清空已有 cron_expr");
    assert.equal(afterCliReports.timezone, "America/New_York", "ok/noop/fail 上报不得重置已有时区");

    // 验证 `ah schedule run` 不经 shell，原样保留参数中的引号与空格
    const quoteExit = await runScheduleCommand(
      ["run", "quoted-cmd", "--name", "带引号命令", "--every", "1d", "--", process.execPath, "-e", "console.log('hello \"quoted\" world')"],
      { configDir: cliDir, io: silentIo }
    );
    assert.equal(quoteExit, 0);
    const quotedSch = rt.schedules.listWithStatus("muse").find((s) => s.id === "quoted-cmd");
    assert.equal(quotedSch.health, "healthy");
    assert.equal(quotedSch.last_run.summary, 'hello "quoted" world');

    // 验证子进程被 SIGKILL 信号杀死时绝不能误报为 completed (code 0)
    const sigExit = await runScheduleCommand(
      ["run", "killed-cmd", "--every", "6d", "--", process.execPath, "-e", "process.kill(process.pid, 'SIGKILL')"],
      { configDir: cliDir, io: silentIo, spawnFn: spawn }
    );
    assert.notEqual(sigExit, 0, "被 SIGKILL 终止的子进程退出码必须为非 0");
    const killedSch = rt.schedules.listWithStatus("muse").find((s) => s.id === "killed-cmd");
    assert.equal(killedSch.health, "failing", "被信号杀死的包装任务必须标记为失败");
    assert.match(killedSch.last_run.error_message, /SIGKILL/);
  } finally {
    await rt.stop();
    fs.rmSync(hubDir, { recursive: true, force: true });
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
});

// 守护红线（回归 Bug #3 & #4）：
// 1) 08:00 开跑、耗时 20 分钟的 cron 任务，次日 08:19:30 运行途中严禁误报超时；超过「排期 + 上次耗时 + 宽限期」才告警一次；
// 2) 只设 every 的任务按「开工时刻 + 周期」推算下次排期（不随完成时间一路后漂），且本轮多跑 20 分钟在默认宽限内不误报；
// 3) 容器 TZ=UTC 下未指定 timezone 的条目仍严格按 Asia/Shanghai 计算。
test("missed-alert accuracy: compensates last_duration_ms, eliminates every drift, and honors Asia/Shanghai under UTC host", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-missed-acc-"));
  const ownerToken = "ah_missed_owner_tok";
  const alerts = [];

  const rt = await startHubRuntime({
    configDir,
    listen: "127.0.0.1:0",
    withDeviceDaemon: false,
    env: {
      TZ: "UTC",
      AH_API_TOKEN: ownerToken,
      AH_BARK_URL: "https://bark.example.test/push",
    },
  });
  rt.notifier.fetchFn = async (_url, init) => {
    alerts.push(JSON.parse(init.body));
    return { ok: true, status: 200 };
  };

  try {
    const owner = new GatewayClient(rt.url, { token: ownerToken });
    const grokCreated = await owner.post("/api/v1/agents", {
      id: "grok-bot",
      name: "Grok Bot",
      role: "worker",
      platform: "grok-bot",
    });

    // 场景 A：北京时间 08:00 开跑（即 UTC 00:00），耗时 20 分钟，在 08:20 上报完成（显式设窄宽限 grace_sec=900 复现原缺陷条件）
    const day1FinishMs = Date.parse("2026-11-26T00:20:00Z"); // 北京时间 2026-11-26 08:20
    rt.schedules.recordEdgeRun(
      "grok-bot",
      "ipad-resign",
      {
        name: "iPad 证书重签",
        cron_expr: "0 8 * * *", // 不传 timezone，验证 TZ=UTC 下仍按 Asia/Shanghai 解析为次日 UTC 00:00
        grace_sec: 900,
        duration_ms: 20 * 60_000,
        summary: "重签完成",
      },
      { actor: { kind: "agent", id: "grok-bot", role: "worker" }, now: day1FinishMs }
    );

    const savedCron = rt.store.getSchedule("grok-bot", "ipad-resign");
    assert.equal(savedCron.timezone, "Asia/Shanghai");
    assert.equal(savedCron.next_run_at, Date.parse("2026-11-27T00:00:00Z"), "北京时间 08:00 对应 UTC 00:00");
    assert.equal(savedCron.last_duration_ms, 20 * 60_000);

    // 次日北京时间 08:19:30（任务正在跑第 19.5 分钟）：预期完成时刻为 08:20，严禁在 08:19:30 误报！
    const day2InFlightMs = Date.parse("2026-11-27T00:19:30Z");
    const tickInFlight = rt.schedules.tick(day2InFlightMs);
    assert.equal(tickInFlight.missed_alerts.length, 0, "次日 08:19:30 重任务仍在正常耗时窗口内，严禁误报");
    assert.equal(alerts.length, 0);

    // 次日北京时间 08:36:00（已超过 08:20 预期完成 + 15 分钟宽限）：此时真挂了，触发一次告警
    const day2TrulyLateMs = Date.parse("2026-11-27T00:36:00Z");
    const tickLate1 = rt.schedules.tick(day2TrulyLateMs);
    assert.equal(tickLate1.missed_alerts.length, 1);
    assert.equal(alerts.length, 1);

    // 同一失联周期后续 tick 不重复轰炸
    const tickLate2 = rt.schedules.tick(day2TrulyLateMs + 120_000);
    assert.equal(tickLate2.missed_alerts.length, 0);

    // 场景 B：every='1h' 周期任务在 08:05 完成（耗时 5 分钟 -> 实际 08:00 开工），下次排期应锚定 09:00 而非 09:05
    const everyRun1Finish = Date.parse("2026-11-26T00:05:00Z");
    rt.schedules.recordEdgeRun(
      "grok-bot",
      "hourly-sync",
      { every: "1h", duration_ms: 5 * 60_000, summary: "第1轮完成" },
      { actor: { kind: "agent", id: "grok-bot", role: "worker" }, now: everyRun1Finish }
    );
    const hourlyRow1 = rt.store.getSchedule("grok-bot", "hourly-sync");
    assert.equal(hourlyRow1.next_run_at, Date.parse("2026-11-26T01:00:00Z"), "下次排期起点应锚定 09:00，不随完成时间后漂");

    // 第 2 轮在 09:00 开工但跑了 25 分钟（比上轮多跑 20 分钟，在 09:25 完成）：在默认 30 分钟宽限内不应误报
    const checkAt0924 = Date.parse("2026-11-26T01:24:00Z");
    const tickHourly = rt.schedules.tick(checkAt0924);
    assert.equal(tickHourly.missed_alerts.length, 0, "本轮比上轮多耗时 20 分钟仍在宽限期内，不应误报");

    // 验证 Grok Bot 重新打卡后自动解除 ipad-resign 的失联状态
    const grok = new GatewayClient(rt.url, { token: grokCreated.token });
    await grok.post("/api/v1/schedules/ipad-resign/runs", { summary: "补签恢复" });
    const recovered = (await owner.get("/api/v1/schedules")).schedules.find((s) => s.id === "ipad-resign");
    assert.equal(recovered.missed, false);
    assert.equal(recovered.health, "healthy");
  } finally {
    await rt.stop();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// 守护红线（回归 Bug #5、#8 及安全与精简边界）：
// 1) Worker 与 Leader 均无权新建、修改、暂停、删除或触发 driver='hub' 定时条目；Leader 无权改动其他 Agent 的定时条目；
// 2) 外部任务成功上报（含 {}、{every,duration_ms}、{title}）不建 Task、不刷屏对话线程，仅失败、带附件或 record_task:true 才建 Task；
// 3) 短路径与长路径 /runs 默认均返回精简 JSON（full=1 返回完整对象），已移除 /ping；
// 4) 失败通知外发前自动脱敏 Bearer / ah_* / URL token 凭据并截断。
test("security, zero-thread-noise check-ins, 3-rule outcome, unified compact responses, and alert secret redaction", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-sec-noise-"));
  const ownerToken = "ah_sec_owner_tok";
  const alerts = [];

  const rt = await startHubRuntime({
    configDir,
    listen: "127.0.0.1:0",
    withDeviceDaemon: false,
    env: {
      AH_API_TOKEN: ownerToken,
      AH_FEISHU_WEBHOOK: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
    },
  });
  rt.notifier.fetchFn = async (_url, init) => {
    alerts.push(JSON.parse(init.body));
    return { ok: true, status: 200 };
  };

  try {
    const owner = new GatewayClient(rt.url, { token: ownerToken });
    const leaderCreated = await owner.post("/api/v1/agents", {
      id: "muse-leader",
      name: "Muse Leader",
      role: "leader",
      platform: "muse",
    });
    const instinctCreated = await owner.post("/api/v1/agents", {
      id: "instinct",
      name: "Instinct Bot",
      role: "worker",
      platform: "instinct",
    });

    const leader = new GatewayClient(rt.url, { token: leaderCreated.token });
    const instinct = new GatewayClient(rt.url, { token: instinctCreated.token });

    // 机主为 instinct 创建一条中台派发（driver='hub'）任务
    await owner.upsertSchedule("instinct", "daily-review", {
      name: "每日代码巡检",
      driver: "hub",
      cron_expr: "0 9 * * *",
      task_template: { to: ["instinct"], input_text: "执行巡检" },
    });

    // 安全红线 1：Worker 本人不可修改、暂停、删除、上报覆盖或手动触发已有的 driver='hub' 条目
    await assert.rejects(
      () => instinct.upsertSchedule("instinct", "daily-review", { cron_expr: "* * * * *" }),
      (err) => err.status === 403 && err.code === "owner_required"
    );
    await assert.rejects(
      () => instinct.upsertSchedule("instinct", "daily-review", { enabled: false }),
      (err) => err.status === 403 && err.code === "owner_required"
    );
    await assert.rejects(
      () => instinct.del("/api/v1/agents/instinct/schedules/daily-review"),
      (err) => err.status === 403 && err.code === "owner_required"
    );
    await assert.rejects(
      () => instinct.post("/api/v1/schedules/daily-review/runs", { summary: "spoof" }),
      (err) => err.status === 409 && err.code === "hub_schedule_managed_by_hub"
    );
    await assert.rejects(
      () => instinct.post("/api/v1/agents/instinct/schedules/daily-review/trigger", {}),
      (err) => err.status === 403
    );

    // 安全红线 2：Leader 也不可新建 Hub 定时，且不可跨节点修改或删除其他 Agent 的定时条目
    await assert.rejects(
      () => leader.upsertSchedule("muse-leader", "leader-hub", { driver: "hub", cron_expr: "0 9 * * *" }),
      (err) => err.status === 403 && err.code === "owner_required"
    );
    await assert.rejects(
      () => leader.upsertSchedule("instinct", "edge-hijack", { driver: "edge", every: "15m" }),
      (err) => err.status === 403 && err.code === "forbidden"
    );
    await assert.rejects(
      () =>
        owner.upsertSchedule("instinct", "bad-exec", {
          driver: "hub",
          cron_expr: "0 9 * * *",
          task_template: { params: { command: "rm -rf /" } },
        }),
      (err) => err.status === 400 && err.code === "exec_control_key_forbidden"
    );

    // 移除同义路由 /ping 后访问应返回 404，无效 outcome（如已删的 started）返回 400
    await assert.rejects(
      () => instinct.post("/api/v1/schedules/my-job/ping", {}),
      (err) => err.status === 404
    );
    await assert.rejects(
      () => instinct.post("/api/v1/schedules/my-job/runs", { outcome: "started" }),
      (err) => err.status === 400 && err.code === "invalid_outcome"
    );

    // 守护红线（Bug #8 + 三规则判定）：连续成功上报与 noop 均不产生任何 Task 或 Thread
    const r1 = await instinct.post("/api/v1/schedules/fast-sync/runs", {});
    const r2 = await instinct.reportScheduleRun("instinct", "fast-sync", { every: "15m", duration_ms: 1200 });
    const r3 = await instinct.post("/api/v1/schedules/fast-sync/runs", { title: "仅标题也算成功", summary: "同步 12 条" });
    const r4 = await instinct.post("/api/v1/schedules/fast-sync/runs", { noop: true });

    assert.deepEqual([r1.outcome, r2.outcome, r3.outcome, r4.outcome], ["completed", "completed", "completed", "noop"]);
    // 短路径与长路径默认均为精简回包（不含 schedule 大对象），加 full=1 才返回完整详情
    assert.equal("schedule" in r1, false);
    assert.equal("schedule" in r2, false);
    const fullRes = await instinct.post("/api/v1/agents/instinct/schedules/fast-sync/runs?full=1", {
      window_key: "win-1",
      summary: "带幂等键完整回包",
    });
    assert.ok(fullRes.schedule?.id === "fast-sync");
    const dupRes = await instinct.post("/api/v1/schedules/fast-sync/runs?full=1", {
      window_key: "win-1",
      summary: "重试",
    });
    assert.equal(dupRes.idempotent, true);

    assert.equal(rt.store.listTasks({ to_agent_id: "instinct" }).length, 0, "外部成功打卡与空转严禁向 tasks 表插入记录");
    const threadsBeforeFail = (await owner.get("/api/v1/threads")).threads;
    assert.equal(threadsBeforeFail.length, 0, "高频外部成功打卡严禁污染对话线程列表");

    const fastSyncView = (await owner.get("/api/v1/schedules")).schedules.find((s) => s.id === "fast-sync");
    assert.equal(fastSyncView.health, "healthy");
    assert.equal(fastSyncView.success_rate, 100);
    assert.equal(fastSyncView.triggerable, false, "首次上报自动建档默认不允许反向触发");
    assert.equal(fastSyncView.last_run.summary, "带幂等键完整回包");
    assert.equal(fastSyncView.recent_runs.length, 5);

    // 守护红线：上报 error 时自动建 failed 任务并推送告警，且 stderr 中的敏感 Token 必须被脱敏
    alerts.length = 0;
    const failRes = await instinct.post("/api/v1/schedules/fast-sync/runs", {
      error: "请求 https://internal.local/api?token= plain_query_secret 失败: Authorization: Bearer sk_live_999888, agent=ah_ag_secret123",
    });
    assert.equal(failRes.outcome, "failed");
    assert.ok(failRes.task_id, "失败上报应生成可追溯的 failed 任务记录");
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(alerts.length, 1);
    const pushedText = alerts[0].content.text;
    assert.equal(pushedText.includes("sk_live_999888"), false, "推送正文严禁泄露 Bearer Token");
    assert.equal(pushedText.includes("ah_ag_secret123"), false, "推送正文严禁泄露 ah_ag_* Token");
    assert.ok(pushedText.includes("[REDACTED]"));

    // 守护红线：带附件的成功上报同样归档为 completed 任务，方便在控制台下载产物
    const uploaded = await instinct.uploadFile({ buffer: Buffer.from("signed-ipa-log"), name: "sign.log", mime: "text/plain" });
    const attRes = await instinct.post("/api/v1/schedules/fast-sync/runs", {
      summary: "附带签名日志",
      attachments: [{ uri: uploaded.file.uri }],
    });
    assert.equal(attRes.outcome, "completed");
    assert.ok(attRes.task_id, "携带附件的成功上报应建档任务以挂载文件授权");

    // 软静默（Mute）开关与恢复监控免误报
    await owner.upsertSchedule("instinct", "fast-sync", { enabled: false });
    const checkMuted = await instinct.checkAgent("instinct");
    assert.deepEqual(checkMuted.muted_schedules, ["fast-sync"]);
    const threeDaysLater = Date.now() + 3 * 24 * 3600_000;
    rt.schedules.upsertForAgent("instinct", "fast-sync", { enabled: true }, { now: threeDaysLater });
    const resumed = rt.schedules.listWithStatus("instinct", threeDaysLater).find((s) => s.id === "fast-sync");
    assert.equal(resumed.missed, false, "从静默恢复瞬间不得误判为 missed");
  } finally {
    await rt.stop();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// 守护红线：中台派发（driver='hub'）支持休眠 fire_once 合并补跑一次、扇出兄弟任务防重入跳过，
// 以及本机 DeviceDaemon 使用内联 `node -e`（零临时脚本文件）完成端到端真实子进程执行与回执闭环。
test("hub-driven cron E2E: fire_once catch-up, fanout sibling overlap guard, and DeviceDaemon inline node -e execution", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-sch-daemon-"));
  const ownerToken = "ah_daemon_cron_tok";

  const inlineEval = "const fs=require('node:fs');const p=fs.readFileSync(process.argv[1],'utf8');console.log(JSON.stringify({summary:'内联巡检完成:'+p.length}))";
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ deviceId: "localbox", deviceName: "本机测试节点" }, null, 2),
    { mode: 0o600 }
  );
  fs.writeFileSync(
    path.join(configDir, "workers.json"),
    JSON.stringify(
      [
        {
          key: "cronbot",
          name: "Local Cron Bot",
          platform: "cli",
          summary: "本机内联巡检 Worker",
          command: `"${process.execPath}" -e "${inlineEval}" {prompt_file}`,
          approval_policy: "never",
          enabled: true,
        },
      ],
      null,
      2
    ),
    { mode: 0o600 }
  );

  const rt = await startHubRuntime({
    configDir,
    listen: "127.0.0.1:0",
    withDeviceDaemon: true,
    env: { AH_API_TOKEN: ownerToken },
  });

  try {
    const owner = new GatewayClient(rt.url, { token: ownerToken });
    const peerCreated = await owner.post("/api/v1/agents", {
      id: "peer-worker",
      name: "Peer Worker",
      role: "worker",
      platform: "generic",
    });
    const peer = new GatewayClient(rt.url, { token: peerCreated.token });
    const workerId = "localbox--cronbot";

    const waitDeadline = Date.now() + 5000;
    while (Date.now() < waitDeadline) {
      if (rt.store.getAgent(workerId)) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(rt.store.getAgent(workerId), "DeviceDaemon 应已将本地 cronbot 同步至 Hub");

    // 建一条扇出到本机 cronbot + 云端 peer-worker 的每小时 Hub 定时任务
    const baseT = Date.parse("2026-11-26T00:00:00Z");
    rt.schedules.upsertForAgent(
      workerId,
      "joint-check",
      {
        name: "联合巡检",
        driver: "hub",
        cron_expr: "0 * * * *",
        timezone: "UTC",
        misfire_policy: "fire_once",
        overlap_policy: "skip",
        task_template: {
          to: [workerId, "peer-worker"],
          title: "每小时联合巡检",
          input_text: "请检查运行状态",
        },
      },
      { now: baseT }
    );

    // 模拟休眠跨越 5 个整点窗口后唤醒：fire_once 只合并派发 1 轮（共 2 条扇出任务）
    const after5h = Date.parse("2026-11-26T05:10:00Z");
    const tick1 = rt.schedules.tick(after5h);
    assert.equal(tick1.dispatched.length, 1);
    assert.equal(tick1.dispatched[0].task_ids.length, 2);
    const [localTaskId, peerTaskId] = tick1.dispatched[0].task_ids;

    // 等待本机 DeviceDaemon 通过 `node -e` 执行完 localTaskId
    let localDone = null;
    const execDeadline = Date.now() + 8000;
    while (Date.now() < execDeadline) {
      const cur = rt.store.getTask(localTaskId);
      if (cur?.state === "completed" || cur?.state === "failed") {
        localDone = cur;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(localDone?.state, "completed");
    assert.match(localDone.receipt.summary, /^内联巡检完成:\d+$/);

    // 此时兄弟任务 peerTaskId 仍在 submitted 未完成：下一整点 06:01 tick 必须因 overlap_policy='skip' 跳过重入
    const tickOverlap = rt.schedules.tick(Date.parse("2026-11-26T06:01:00Z"));
    assert.equal(tickOverlap.dispatched.length, 0, "扇出兄弟子任务未完结前严禁重入派发");
    assert.equal(tickOverlap.skipped[0].reason, "overlap_skipped");

    await peer.claimTask(peerTaskId);
    await peer.complete(peerTaskId, { summary: "云端协同完成" });

    // 在同一模拟时钟（06:05Z，下次触发为 07:00Z）核验健康状态，并推进至实时时钟验证 HTTP 列表接口
    const simView = rt.schedules.listWithStatus(workerId, Date.parse("2026-11-26T06:05:00Z")).find((s) => s.id === "joint-check");
    assert.equal(simView.health, "healthy");
    assert.equal(simView.success_rate, 100);

    const liveTick = rt.schedules.tick(Date.now());
    for (const tid of liveTick.dispatched[0]?.task_ids || []) {
      const cur = rt.store.getTask(tid);
      if (cur && cur.state === "submitted") {
        await owner.post(`/api/v1/tasks/${tid}/claim`, {});
        await owner.post(`/api/v1/tasks/${tid}/complete`, { summary: "实时窗口巡检完成" });
      }
    }
    const schView = (await owner.get("/api/v1/schedules")).schedules.find((s) => s.id === "joint-check");
    assert.ok(schView.health === "healthy" || schView.health === "running");
    assert.equal(schView.success_rate, 100);
  } finally {
    await rt.stop();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// 守护红线（回归 Bug #6 & #7）：
// 1) HUB_CRON_PRESETS 严禁包含月底跨月只隔 1 天的错误预设 `0 10 */6 * *`；
// 2) 新建 Hub 定时切换 Cron 预设时原地更新输入框，绝不重绘清空已选 Agent 与已写提示词；
// 3) 编辑外部自管条目（如 120m 自定义周期）时周期只读展示，提交表单绝不附带 every 字段覆盖原排期；
// 4) 列表渲染防 XSS，且一键复制命令对引号安全转义。
test("Web Console schedules view: no */6 preset, preset switch keeps draft, editing Edge omits every, and XSS/quote safety", async () => {
  const {
    HUB_CRON_PRESETS,
    buildEdgeQuickSnippets,
    renderSchedulesView,
    resetSchedulePanelState,
  } = await import("../src/web/views/schedules.js");
  const { api } = await import("../src/web/api.js");
  const { setState } = await import("../src/web/state.js");

  // 1) 确认已移除错误的 `0 10 */6 * *` 预设
  assert.equal(
    HUB_CRON_PRESETS.some((p) => p.id.includes("*/6")),
    false,
    "严禁提供月底间隔错误的 */6 日期预设"
  );

  // 2) 验证含引号任务名的命令片段安全转义
  const snippets = buildEdgeQuickSnippets({
    hubUrl: "https://ahub.example.com/",
    schId: "ipad-sign",
    schName: `Grok's "iPad" 续签`,
    every: "6d",
  });
  assert.ok(snippets.botPrompt.includes("https://ahub.example.com/api/v1/schedules/ipad-sign/runs"));
  assert.ok(snippets.cliWrap.includes("--every 6d"));

  // 构造轻量可交互桩容器验证事件行为（不依赖第三方 DOM 库）
  function makeMockContainer() {
    const listeners = new Map();
    const elements = new Map();
    const registerEl = (sel, el) => {
      elements.set(sel, el);
      return el;
    };
    return {
      innerHTML: "",
      elements,
      registerEl,
      querySelector(sel) {
        if (!elements.has(sel)) {
          const classes = new Set();
          elements.set(sel, {
            value: "",
            textContent: "",
            classList: {
              add: (c) => classes.add(c),
              remove: (c) => classes.delete(c),
              has: (c) => classes.has(c),
            },
            addEventListener(ev, fn) {
              listeners.set(`${sel}:${ev}`, fn);
            },
            focus() {},
            getAttribute: () => null,
          });
        }
        return elements.get(sel);
      },
      querySelectorAll() {
        return [];
      },
      trigger(sel, ev, eventObj) {
        const fn = listeners.get(`${sel}:${ev}`);
        if (!fn) throw new Error(`未绑定事件 ${sel}:${ev}`);
        return fn(eventObj);
      },
    };
  }

  const now = Date.now();
  setState({
    scheduleFilter: "all",
    scheduleSearch: "",
    state: {
      hub_url: "https://ahub.example.com",
      agents: [
        { id: "mac--claude", name: "Claude Code", kind: "device-worker", device_name: "Mac", online: true, enabled: true },
        { id: "grok-bot", name: "Grok <img src=x onerror=alert(1)>", kind: "cloud", online: true, enabled: true },
      ],
      schedules: [
        {
          id: "custom-2h",
          agent_id: "grok-bot",
          agent_name: "Grok",
          name: "<script>alert(1)</script>双小时巡检",
          driver: "edge",
          cron_expr: "",
          interval_min: 120,
          timezone: "Asia/Shanghai",
          triggerable: false,
          enabled: true,
          health: "healthy",
          last_tick_at: now - 30_000,
          last_outcome: "noop",
          next_expected_at: now + 3600_000,
          summary: '测试 "><svg onload=alert(2)>',
          recent_runs: [{ id: null, context_id: null, state: "noop", created_at: now - 30_000, duration_ms: 150, summary: "" }],
        },
      ],
    },
  });

  // 3) 打开新建 Hub 面板：切换 #sch-cron-preset 时不得重绘清空容器，而应原地修改 #sch-cron-expr-input
  resetSchedulePanelState({ open: true, driver: "hub", preset: "0 9 * * *" });
  const hubContainer = makeMockContainer();
  renderSchedulesView(hubContainer, async () => {});
  const htmlBeforePresetChange = hubContainer.innerHTML;
  assert.ok(htmlBeforePresetChange.includes('id="sch-cron-expr-input"'));

  // 模拟用户先在 DOM 中改了草稿标记，切换预设后 innerHTML 引用未被重置，且 cron 输入框值同步更新
  hubContainer.innerHTML += "<!-- user-draft-alive -->";
  const cronInput = hubContainer.querySelector("#sch-cron-expr-input");
  cronInput.value = "0 9 * * *";
  hubContainer.trigger("#sch-cron-preset", "change", { target: { value: "*/15 * * * *" } });
  assert.ok(hubContainer.innerHTML.endsWith("<!-- user-draft-alive -->"), "切换 Cron 预设严禁整块重绘清空用户草稿");
  assert.equal(cronInput.value, "*/15 * * * *");

  hubContainer.trigger("#sch-cron-preset", "change", { target: { value: "custom" } });
  assert.equal(cronInput.value, "", "切到自定义 Cron 时应清空预设值供输入");
  assert.equal(hubContainer.querySelector("#sch-custom-cron-wrap").classList.has("hidden"), false);

  // 4) 编辑已有 120m 外部自管条目：HTML 只读展示周期（不含 <select name="every">），且提交时绝不发送 every 字段
  resetSchedulePanelState({ open: true, editingKey: "grok-bot:::custom-2h", driver: "edge" });
  const edgeContainer = makeMockContainer();
  renderSchedulesView(edgeContainer, async () => {});
  const edgeHtml = edgeContainer.innerHTML;
  assert.ok(edgeHtml.includes('id="edge-readonly-period"'), "编辑外部条目时应渲染只读周期展示");
  assert.equal(edgeHtml.includes('id="edge-every-select"'), false, "编辑外部条目时不得渲染周期下拉框");
  assert.equal(edgeHtml.includes("<script>alert(1)</script>"), false, "任务名必须转义防 XSS");
  assert.equal(edgeHtml.includes("<svg onload=alert(2)>"), false, "摘要必须转义防 XSS");
  assert.equal(edgeHtml.includes("<img src=x"), false, "Agent 名必须转义防 XSS");

  // 拦截 api.upsertSchedule 验证编辑外部条目提交的 payload 不含 every
  const origUpsert = api.upsertSchedule;
  const origDoc = globalThis.document;
  let submittedArgs = null;
  api.upsertSchedule = async (agentId, schId, payload) => {
    submittedArgs = { agentId, schId, payload };
    return { ok: true };
  };
  globalThis.document = { getElementById: () => null };
  try {
    const fakeForm = document.createElement ? null : (() => {
      // 使用真实 FormData 构造器不可用时，通过自定义表单替身检验
      return null;
    })();
    void fakeForm;
    // 在 Node 环境下构造带 name 属性控件集合的真实 HTMLFormElement 不可用，验证 FormData 读取逻辑：
    const OriginalFormData = globalThis.FormData;
    globalThis.FormData = class MockFormData {
      constructor() {
        this._map = new Map([
          ["driver", "edge"],
          ["agent_id", "grok-bot"],
          ["name", "双小时巡检（改名）"],
          ["id", "custom-2h"],
          ["summary", "仅修改备注"],
          ["every", "15m"], // 就算浏览器意外塞入 every，data-editing-edge="1" 也必须拦截丢弃
        ]);
      }
      get(k) {
        return this._map.has(k) ? this._map.get(k) : null;
      }
    };
    try {
      await edgeContainer.trigger("#form-create-schedule", "submit", {
        preventDefault() {},
        currentTarget: { getAttribute: (k) => (k === "data-editing-edge" ? "1" : null) },
      });
    } finally {
      globalThis.FormData = OriginalFormData;
    }
    assert.ok(submittedArgs, "表单提交应调用 api.upsertSchedule");
    assert.equal(submittedArgs.agentId, "grok-bot");
    assert.equal(submittedArgs.schId, "custom-2h");
    assert.equal("every" in submittedArgs.payload, false, "编辑外部条目提交时严禁包含 every 字段");
    assert.equal(submittedArgs.payload.summary, "仅修改备注");
  } finally {
    api.upsertSchedule = origUpsert;
    globalThis.document = origDoc;
    resetSchedulePanelState();
  }
});

// 守护红线：
// 1) tick()/triggerNow() 失败严禁静默吞错或立即跳过本期，应记日志、发脱敏 schedule.failed 告警、保持 next_run_at 等待冷却后重试，并在连续失败 3 次后推进；
// 2) 单条坏 Cron 记录严禁连坐阻断队列中排在后面的健康定时任务。
test("tick failure observability, retry retention, exhaustion advance, and corrupt-row isolation", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-tick-fail-"));
  const ownerToken = "ah_tick_fail_owner";
  const alerts = [];
  const loggedErrors = [];

  const rt = await startHubRuntime({
    configDir,
    listen: "127.0.0.1:0",
    withDeviceDaemon: false,
    env: {
      AH_API_TOKEN: ownerToken,
      AH_BARK_URL: "https://bark.example.test/push",
    },
    logger: {
      log: () => {},
      warn: () => {},
      error: (msg) => loggedErrors.push(String(msg)),
    },
  });
  rt.notifier.fetchFn = async (_url, init) => {
    alerts.push(JSON.parse(init.body));
    return { ok: true, status: 200 };
  };

  try {
    const owner = new GatewayClient(rt.url, { token: ownerToken });
    await owner.post("/api/v1/agents", { id: "worker-ok", name: "Worker OK", role: "worker", platform: "generic" });
    await owner.post("/api/v1/agents", { id: "worker-good2", name: "Worker Good2", role: "worker", platform: "generic" });

    const baseT = Date.parse("2026-11-26T00:10:00Z");
    const due1 = Date.parse("2026-11-26T01:00:00Z");
    const due2 = Date.parse("2026-11-26T02:00:00Z");

    rt.schedules.upsertForAgent(
      "worker-ok",
      "retry-job",
      {
        name: "可重试巡检",
        driver: "hub",
        cron_expr: "0 * * * *",
        timezone: "UTC",
        grace_sec: 600,
        task_template: { to: ["worker-ok"], input_text: "巡检" },
      },
      { now: baseT }
    );
    assert.equal(rt.store.getSchedule("worker-ok", "retry-job").next_run_at, due1);

    const origDispatch = rt.taskService.dispatchTasks.bind(rt.taskService);
    let failDispatch = true;
    let dispatchCalls = 0;
    rt.taskService.dispatchTasks = (...args) => {
      dispatchCalls += 1;
      if (failDispatch) {
        throw new Error("模拟派单异常 Bearer sk_test_secret_999");
      }
      return origDispatch(...args);
    };

    // 第 1 次失败：记录日志、发一次脱敏告警、保留 next_run_at=due1 等待重试
    const r1 = rt.schedules.tick(due1 + 5_000);
    assert.equal(r1.failed.length, 1);
    assert.equal(r1.failed[0].attempts, 1);
    assert.equal(r1.failed[0].exhausted, false);
    assert.equal(dispatchCalls, 1);
    assert.ok(loggedErrors.some((m) => m.includes("retry-job") && m.includes("[REDACTED]")));
    assert.equal(rt.store.getSchedule("worker-ok", "retry-job").next_run_at, due1, "首次失败不得提前推进 next_run_at");

    await new Promise((r) => setTimeout(r, 25));
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].title, /派发失败/);
    assert.equal(alerts[0].body.includes("sk_test_secret_999"), false, "告警详情必须脱敏");
    assert.ok(alerts[0].body.includes("[REDACTED]"));

    const view1 = rt.schedules.listWithStatus("worker-ok", due1 + 10_000).find((s) => s.id === "retry-job");
    assert.equal(view1.health, "failing");
    assert.equal(view1.missed, false);
    assert.match(view1.last_run.error_message, /派发失败.*\[REDACTED\]/);

    // 60 秒冷却内再次 tick：不重打 dispatchTasks，不发重复告警
    const rCooldown = rt.schedules.tick(due1 + 20_000);
    assert.equal(dispatchCalls, 1);
    assert.ok(rCooldown.skipped.some((s) => s.id === "retry-job" && s.reason === "failure_cooldown"));
    assert.equal(alerts.length, 1);

    // 过冷却后仍失败（第 2 次）：attempts=2，仍保留 due1，且不再重复推告警
    const r2 = rt.schedules.tick(due1 + 70_000);
    assert.equal(r2.failed.length, 1);
    assert.equal(r2.failed[0].attempts, 2);
    assert.equal(dispatchCalls, 2);
    assert.equal(rt.store.getSchedule("worker-ok", "retry-job").next_run_at, due1);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(alerts.length, 1);

    // 恢复正常后重试成功：正常派发并将 next_run_at 推进到 due2
    failDispatch = false;
    const rRecover = rt.schedules.tick(due1 + 140_000);
    assert.equal(rRecover.dispatched.length, 1);
    assert.equal(rt.store.getSchedule("worker-ok", "retry-job").next_run_at, due2);

    // 连续 3 次失败后耗尽重试并推进到下一周期
    failDispatch = true;
    rt.schedules.upsertForAgent(
      "worker-ok",
      "exhaust-job",
      {
        name: "耗尽测试",
        driver: "hub",
        cron_expr: "0 * * * *",
        timezone: "UTC",
        grace_sec: 600,
        task_template: { to: ["worker-ok"], input_text: "test" },
      },
      { now: baseT }
    );
    const e1 = rt.schedules.tick(due1 + 10_000);
    const e2 = rt.schedules.tick(due1 + 75_000);
    const e3 = rt.schedules.tick(due1 + 140_000);
    assert.equal(e1.failed.find((x) => x.id === "exhaust-job")?.attempts, 1);
    assert.equal(e2.failed.find((x) => x.id === "exhaust-job")?.attempts, 2);
    const ex3 = e3.failed.find((x) => x.id === "exhaust-job");
    assert.equal(ex3?.attempts, 3);
    assert.equal(ex3?.exhausted, true);
    assert.equal(rt.store.getSchedule("worker-ok", "exhaust-job").next_run_at, due2);

    // 单条损坏隔离：在 SQLite 直接插入一条排在前面的坏 Cron，不能影响排在后面的健康条目派发
    failDispatch = false;
    rt.taskService.dispatchTasks = origDispatch;
    rt.store.db.prepare(`
      INSERT INTO schedules (id, agent_id, name, driver, cron_expr, interval_min, timezone, next_run_at, enabled)
      VALUES ('aaa-corrupt', 'worker-ok', '损坏条目', 'hub', 'bad-cron-expr', 60, 'UTC', ?, 1)
    `).run(due2);
    rt.schedules.upsertForAgent(
      "worker-good2",
      "zzz-healthy",
      {
        name: "后续健康任务",
        driver: "hub",
        cron_expr: "0 * * * *",
        timezone: "UTC",
        task_template: { to: ["worker-good2"], input_text: "ok" },
      },
      { now: due1 + 60_000 }
    );
    const isoRes = rt.schedules.tick(due2 + 10_000);
    assert.ok(isoRes.failed.some((f) => f.id === "aaa-corrupt"), "损坏记录应被单独记录失败");
    assert.ok(isoRes.dispatched.some((d) => d.id === "zzz-healthy"), "损坏记录后的健康定时任务必须正常派发");
  } finally {
    await rt.stop();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// 守护红线：
// 1) 扇出定时任务中有部分目标暂停时，其余启用目标必须正常派发而不被 409 连坐跳过；
// 2) 扇出副目标失败必须回写主 schedule 为 failing，且不能被先/后完成的主目标成功状态覆盖。
test("fanout partial pause does not block healthy targets and peer failure sticks on owner schedule", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-fanout-fix-"));
  const ownerToken = "ah_fanout_owner";

  const rt = await startHubRuntime({
    configDir,
    listen: "127.0.0.1:0",
    withDeviceDaemon: false,
    env: { AH_API_TOKEN: ownerToken },
  });

  try {
    const owner = new GatewayClient(rt.url, { token: ownerToken });
    const aCreated = await owner.post("/api/v1/agents", { id: "agent-a", name: "Agent A", role: "worker", platform: "generic" });
    const bCreated = await owner.post("/api/v1/agents", { id: "agent-b", name: "Agent B", role: "worker", platform: "generic" });
    const cliA = new GatewayClient(rt.url, { token: aCreated.token });
    const cliB = new GatewayClient(rt.url, { token: bCreated.token });

    const baseT = Date.parse("2026-11-26T00:10:00Z");
    const t1 = Date.parse("2026-11-26T01:05:00Z");
    const t2 = Date.parse("2026-11-26T02:05:00Z");
    const t3 = Date.parse("2026-11-26T03:05:00Z");

    rt.schedules.upsertForAgent(
      "agent-a",
      "fanout-job",
      {
        name: "双节点扇出",
        driver: "hub",
        cron_expr: "0 * * * *",
        timezone: "UTC",
        overlap_policy: "skip",
        task_template: { to: ["agent-a", "agent-b"], input_text: "测试扇出" },
      },
      { now: baseT }
    );

    // 暂停 agent-b 后 tick：agent-a 必须照常派发
    rt.store.updateAgent("agent-b", { enabled: false });
    const tickPartial = rt.schedules.tick(t1);
    assert.equal(tickPartial.dispatched.length, 1);
    assert.equal(tickPartial.dispatched[0].task_ids.length, 1);
    const partialTid = tickPartial.dispatched[0].task_ids[0];
    assert.equal(rt.store.getTask(partialTid).to_agent_id, "agent-a");
    await cliA.claimTask(partialTid);
    await cliA.complete(partialTid, { summary: "仅 A 完成" });

    // 恢复 agent-b：A 先完成，B 后失败 -> 主 schedule 必须为 failing
    rt.store.updateAgent("agent-b", { enabled: true });
    const tickRun1 = rt.schedules.tick(t2);
    assert.equal(tickRun1.dispatched[0].task_ids.length, 2);
    const [a1, b1] = tickRun1.dispatched[0].task_ids;
    await cliA.claimTask(a1);
    await cliA.complete(a1, { summary: "A 完成" });
    await cliB.claimTask(b1);
    await cliB.fail(b1, { error: "B 执行失败" });
    const afterBfail = rt.schedules.listWithStatus("agent-a", t2 + 10_000).find((s) => s.id === "fanout-job");
    assert.equal(afterBfail.health, "failing");

    // 下一轮：B 先失败，A 后完成 -> 主 schedule 仍必须保持 failing，不得被 A 完成覆盖
    const tickRun2 = rt.schedules.tick(t3);
    assert.equal(tickRun2.dispatched[0].task_ids.length, 2);
    const [a2, b2] = tickRun2.dispatched[0].task_ids;
    await cliB.claimTask(b2);
    await cliB.fail(b2, { error: "B 再次失败" });
    await cliA.claimTask(a2);
    await cliA.complete(a2, { summary: "A 完成" });
    const afterAlate = rt.schedules.listWithStatus("agent-a", t3 + 10_000).find((s) => s.id === "fanout-job");
    assert.equal(afterAlate.health, "failing", "主目标后完成不得覆盖同轮副目标的失败状态");
  } finally {
    await rt.stop();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// 守护红线：
// 1) 新建 hub 定时若 task_template.to 含不存在的目标返回 400 invalid_target；
// 2) 缩短已有 edge 定时周期不因旧 last_tick_at 立即误炸超时告警；
// 3) listRecentScheduleTasks 窗口函数防止高频任务挤爆低频任务历史；
// 4) 恢复 `ah inbox pop --lease` 传参；
// 5) Web 前端使用 hub_timezone、搜索/面板打开保护草稿以及 home.js 正确展示 noop 打卡与 running 状态。
test("target validation, edge period shrink safety, per-schedule window query, inbox pop --lease, and web view fixes", async () => {
  const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-misc-hub-"));
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-misc-cli-"));
  const ownerToken = "ah_misc_owner_tok";

  const rt = await startHubRuntime({
    configDir: hubDir,
    listen: "127.0.0.1:0",
    withDeviceDaemon: false,
    env: { AH_API_TOKEN: ownerToken, AH_TIMEZONE: "Asia/Tokyo" },
  });

  try {
    const owner = new GatewayClient(rt.url, { token: ownerToken });
    const workerCreated = await owner.post("/api/v1/agents", { id: "worker-1", name: "Worker 1", role: "worker", platform: "generic" });
    const workerClient = new GatewayClient(rt.url, { token: workerCreated.token });

    // 1) 校验 task_template.to 存在性
    await assert.rejects(
      () =>
        owner.upsertSchedule("worker-1", "bad-target", {
          driver: "hub",
          cron_expr: "0 9 * * *",
          task_template: { to: ["worker-1", "ghost-agent"], input_text: "hi" },
        }),
      (err) => err.status === 400 && err.code === "invalid_target"
    );

    // 验证 /api/v1/state 输出 hub_timezone
    const stateRes = await owner.get("/api/v1/state");
    assert.equal(stateRes.hub_timezone, "Asia/Tokyo");

    // 2) 已有 5 天前跑过的 edge 任务把周期从 7d 改为 15m，不得立刻炸出 missed 告警
    const now = Date.now();
    rt.schedules.recordEdgeRun(
      "worker-1",
      "shrink-edge",
      { every: "7d", summary: "五天前跑过" },
      { actor: { kind: "agent", id: "worker-1", role: "worker" }, now: now - 5 * 86_400_000 }
    );
    const shrunk = rt.schedules.upsertForAgent("worker-1", "shrink-edge", { every: "15m" }, { now }).schedule;
    assert.ok(shrunk.next_run_at > now, "缩短周期后 next_run_at 必须以当前时刻重新推算至未来");
    const tickAfterShrink = rt.schedules.tick(now + 1_000);
    assert.equal(tickAfterShrink.missed_alerts.some((a) => a.id === "shrink-edge"), false);

    // 3) 窗口函数防挤占：先写 3 条低频历史，再写 30 条高频更新记录，低频 3 条仍须完整保留
    rt.schedules.upsertForAgent("worker-1", "low-freq", { name: "低频任务", driver: "edge", every: "7d" }, { now });
    rt.schedules.upsertForAgent("worker-1", "high-freq", { name: "高频任务", driver: "edge", every: "5m" }, { now });
    for (let i = 0; i < 3; i++) {
      rt.taskService.ingestScheduleTask({
        agentId: "worker-1",
        scheduleId: "low-freq",
        outcome: "completed",
        summary: `低频第 ${i + 1} 次`,
        now: now - 100_000 + i * 1000,
      });
    }
    for (let i = 0; i < 30; i++) {
      rt.taskService.ingestScheduleTask({
        agentId: "worker-1",
        scheduleId: "high-freq",
        outcome: "completed",
        summary: `高频第 ${i + 1} 次`,
        now: now - 50_000 + i * 1000,
      });
    }
    const lowView = rt.schedules.listWithStatus(null, now).find((s) => s.id === "low-freq");
    assert.equal(lowView.recent_runs.length, 3, "高频任务不得挤爆低频任务的 recent_runs 统计窗口");
    assert.equal(lowView.success_rate, 100);

    // 4) 恢复 `ah inbox pop --lease` 传参
    fs.writeFileSync(
      path.join(cliDir, "config.json"),
      JSON.stringify({ mode: "agent", agentId: "worker-1", hubUrl: rt.url, agentToken: workerCreated.token }),
      { mode: 0o600 }
    );
    const dispatched = await owner.post("/api/v1/tasks", { to: "worker-1", title: "租约测试", input_text: "test" });
    const tid = dispatched.tasks[0].id;
    const silentIo = { log: () => {}, error: () => {} };
    await runInboxCommand(["pop", "--lease", "180"], { configDir: cliDir, io: silentIo });
    const claimedTask = rt.store.getTask(tid);
    assert.equal(claimedTask.state, "working");
    const actualLeaseMs = claimedTask.lease_until - claimedTask.claimed_at;
    assert.ok(actualLeaseMs >= 175_000 && actualLeaseMs <= 185_000, `期望 lease 约 180s，实际为 ${actualLeaseMs}ms`);
    await workerClient.complete(tid, { summary: "done" });

    // 5) Web 前端：hub_timezone 生效、isSchedulePanelOpen 与搜索局部重绘不毁草稿、home.js 状态与时间口径一致
    const {
      isSchedulePanelOpen,
      renderSchedulesView,
      resetSchedulePanelState,
    } = await import("../src/web/views/schedules.js");
    const { renderHomeView } = await import("../src/web/views/home.js");
    const { setState } = await import("../src/web/state.js");

    function makeRichMockContainer() {
      const listeners = new Map();
      const elements = new Map();
      return {
        innerHTML: "",
        elements,
        querySelector(sel) {
          if (!elements.has(sel)) {
            const classes = new Set();
            elements.set(sel, {
              value: "",
              textContent: "",
              innerHTML: "",
              classList: {
                add: (c) => classes.add(c),
                remove: (c) => classes.delete(c),
                toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
                has: (c) => classes.has(c),
              },
              addEventListener(ev, fn) {
                listeners.set(`${sel}:${ev}`, fn);
              },
              focus() {},
              getAttribute: () => null,
            });
          }
          return elements.get(sel);
        },
        querySelectorAll() {
          return [];
        },
        trigger(sel, ev, eventObj) {
          const fn = listeners.get(`${sel}:${ev}`);
          if (!fn) throw new Error(`未绑定事件 ${sel}:${ev}`);
          return fn(eventObj);
        },
      };
    }

    setState({
      scheduleFilter: "all",
      scheduleSearch: "",
      state: {
        hub_url: rt.url,
        hub_timezone: "America/Los_Angeles",
        agents: [
          { id: "worker-1", name: "Worker 1", kind: "cloud", online: true, enabled: true },
        ],
        devices: [],
        tasks: [],
        pending_actions: [],
        schedules: [
          {
            id: "edge-noop",
            agent_id: "worker-1",
            agent_name: "Worker 1",
            name: "空转巡检",
            driver: "edge",
            interval_min: 15,
            enabled: true,
            health: "healthy",
            last_tick_at: now - 30_000,
            last_run_at: null,
            last_outcome: "noop",
          },
          {
            id: "hub-running",
            agent_id: "worker-1",
            agent_name: "Worker 1",
            name: "执行中任务",
            driver: "hub",
            cron_expr: "0 9 * * *",
            enabled: true,
            health: "running",
            last_tick_at: now - 10_000,
            last_run_at: now - 10_000,
          },
        ],
      },
    });

    resetSchedulePanelState({ open: true, driver: "hub", preset: "0 9 * * *" });
    assert.equal(isSchedulePanelOpen(), true);
    const schContainer = makeRichMockContainer();
    renderSchedulesView(schContainer, async () => {});
    assert.ok(schContainer.innerHTML.includes('value="America/Los_Angeles"'), "表单默认时区应采用 hub_timezone");

    schContainer.innerHTML += "<!-- draft-kept -->";
    schContainer.trigger("#sch-search-input", "input", { target: { value: "空转" } });
    assert.ok(schContainer.innerHTML.endsWith("<!-- draft-kept -->"), "搜索输入只应局部刷新列表，绝不能重绘破坏打开中的表单");
    assert.ok(schContainer.querySelector("#schedules-list-region").innerHTML.includes("空转巡检"));
    assert.equal(schContainer.querySelector("#schedules-list-region").innerHTML.includes("执行中任务"), false);

    resetSchedulePanelState({ open: false });
    assert.equal(isSchedulePanelOpen(), false);

    const homeContainer = makeRichMockContainer();
    renderHomeView(homeContainer, async () => {});
    assert.ok(homeContainer.innerHTML.includes("2/2"), "home 定时健康数应包含 healthy 与 running（2/2）");
    assert.equal(homeContainer.innerHTML.includes("待首报"), false, "仅 noop 打卡（有 last_tick_at）不应显示待首报");
    assert.ok(homeContainer.innerHTML.includes("30秒前") || homeContainer.innerHTML.includes("刚刚"));
  } finally {
    await rt.stop();
    fs.rmSync(hubDir, { recursive: true, force: true });
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
});
