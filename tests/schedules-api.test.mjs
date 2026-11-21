// 定时任务只读总览、AgentCard.Metadata.schedules 声明与一步写 Task（中台不触发 cron）。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES, f1 } from "../src/bus/tables.mjs";
import { listSchedules } from "../src/hub/capabilities.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { LongPollBroker } from "../src/server/longpoll-broker.mjs";
import { withTemp } from "./helpers.mjs";

async function apiJson(baseUrl, pathname, { method = "GET", token = "", body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function withHub(fn) {
  await withTemp(async (rootDir) => {
    const hubDir = path.join(rootDir, "hub");
    fs.mkdirSync(hubDir, { recursive: true });
    const apiToken = "sched-owner-token";
    const broker = new LongPollBroker({ initialSeq: 0 });
    const bus = new SqliteBus({
      dbPath: path.join(hubDir, "hub.db"),
      tables: DEFAULT_TABLES,
      broker,
    });
    const httpHandle = await startHubHttpServer({
      cfg: {
        node: "mac-mini-hub",
        configDir: hubDir,
        listen: "127.0.0.1:0",
        apiToken,
        tz: "Asia/Shanghai",
      },
      bus,
      broker,
      log: () => {},
      onWake: () => {},
    });
    try {
      await fn({ baseUrl: httpHandle.localUrl, apiToken, bus, broker });
    } finally {
      await httpHandle.close();
      bus.close();
      broker.close();
    }
  });
}

test("列表异常与 interval_min * 1.5：离线优先，其次最近任务失败，再其次超时漏触发", () => {
  const now = new Date("2026-11-18T04:30:00.000Z");
  const cards = [
    {
      fields: {
        Node: "bot",
        Cap_ID: "CAP-bot-agent",
        Availability: "online",
        Metadata: JSON.stringify({
          schedules: [
            {
              id: "hourly",
              cron: "0 * * * *",
              tz: "Asia/Shanghai",
              cap: "agent",
              text: "超时未巡检",
              enabled: true,
              last_fired: "2026-11-18T02:00:00.000Z",
              source: "http-agent",
              updated_at: "2026-11-18T01:00:00.000Z",
            },
            {
              id: "recent",
              cron: "0 * * * *",
              tz: "Asia/Shanghai",
              cap: "agent",
              text: "正常刚跑过",
              enabled: true,
              last_fired: "2026-11-18T03:30:00.000Z",
              source: "http-agent",
              updated_at: "2026-11-18T01:00:00.000Z",
            },
            {
              id: "bad",
              cron: "0 * * * *",
              tz: "Asia/Shanghai",
              cap: "agent",
              text: "失败的一轮",
              enabled: true,
              last_fired: "2026-11-18T04:00:00.000Z",
              source: "http-agent",
              updated_at: "2026-11-18T01:00:00.000Z",
            },
          ],
        }),
      },
    },
    {
      fields: {
        Node: "desk",
        Cap_ID: "CAP-desk-brief",
        Availability: "offline",
        Metadata: JSON.stringify({
          schedules: [
            {
              id: "night",
              cron: "0 9 * * *",
              tz: "Asia/Shanghai",
              cap: "brief",
              text: "早报",
              enabled: true,
              last_fired: "2026-11-18T04:00:00.000Z",
              source: "node",
              updated_at: "2026-11-18T01:00:00.000Z",
            },
          ],
        }),
      },
    },
  ];
  const tasks = [
    {
      fields: {
        Task_ID: "TASK-BAD",
        Target_Node: "bot",
        Status: "failed",
        Idempotency_Key: "sched:bot:bad:2026-11-18T04:00:00.000Z",
        Metadata: JSON.stringify({ schedule_id: "bad" }),
        Updated_At: "2026-11-18T04:00:00.000Z",
      },
    },
  ];
  const listed = listSchedules({ tasks, cards, connected: [], now, hubNode: "mac-mini-hub" });
  const byId = Object.fromEntries(listed.map((item) => [item.schedule_id, item]));
  assert.equal(byId.hourly.anomaly, "missed");
  assert.equal(byId.hourly.source, "http-agent");
  assert.equal(byId.hourly.tz, "Asia/Shanghai");
  assert.equal(byId.hourly.interval_min, 60);
  assert.ok(byId.hourly.next_fire_at);
  assert.equal(byId.recent.anomaly, "");
  assert.equal(byId.bad.anomaly, "failed");
  assert.equal(byId.bad.last_task.task_id, "TASK-BAD");
  assert.equal(byId.bad.last_task.status, "failed");
  assert.equal(byId.bad.last_task.updated_at, "2026-11-18T04:00:00.000Z");
  assert.equal(byId.night.anomaly, "node-offline");
  assert.equal(byId.night.source, "node");
});

test("机主只读总览；Agent 自报进 AgentCard，run 一步生成 Task，register 可带或保留 schedules", async () => {
  await withHub(async ({ baseUrl, apiToken, bus }) => {
    const added = await apiJson(baseUrl, "/api/v1/admin/agents", {
      method: "POST",
      token: apiToken,
      body: { node: "grok-bot", access: "http", role: "worker" },
    });
    assert.equal(added.status, 200);
    const workerToken = added.data.token;
    await bus.updateRecord(
      DEFAULT_TABLES.agentCards,
      (await bus.listRecords(DEFAULT_TABLES.agentCards)).find((row) => f1(row, "Node") === "grok-bot").record_id,
      { Availability: "online" },
    );

    const deniedList = await apiJson(baseUrl, "/api/v1/schedules", { token: workerToken });
    assert.equal(deniedList.status, 403);

    const put = await apiJson(baseUrl, "/api/v1/agents/grok-bot/schedules/daily", {
      method: "PUT",
      token: workerToken,
      body: { cron: "0 9 * * *", tz: "Asia/Shanghai", cap: "agent", text: "早报", enabled: true },
    });
    assert.equal(put.status, 200);
    assert.equal(put.data.rule_id, "grok-bot:daily");
    assert.equal(put.data.schedule_id, "daily");
    assert.equal(put.data.task_id, undefined);

    const other = await apiJson(baseUrl, "/api/v1/agents/other-bot/schedules/daily", {
      method: "PUT",
      token: workerToken,
      body: { cron: "0 9 * * *", text: "不该写成" },
    });
    assert.equal(other.status, 403);

    const badCron = await apiJson(baseUrl, "/api/v1/agents/grok-bot/schedules/daily", {
      method: "PUT",
      token: workerToken,
      body: { cron: "not a cron" },
    });
    assert.equal(badCron.status, 400);

    // 附带 run 时，一步落 Task 并关联 last_task
    const putWithRun = await apiJson(baseUrl, "/api/v1/agents/grok-bot/schedules/daily", {
      method: "PUT",
      token: workerToken,
      body: {
        cron: "0 9 * * *",
        tz: "Asia/Shanghai",
        cap: "agent",
        text: "早报",
        enabled: true,
        run: { status: "completed", text: "今天早报已完成", title: "每日早报 11-21" },
      },
    });
    assert.equal(putWithRun.status, 200);
    assert.match(putWithRun.data.task_id, /^TASK-/);
    assert.equal(putWithRun.data.status, "completed");

    const tasks = await bus.listRecords(DEFAULT_TABLES.tasks);
    const createdTask = tasks.find((row) => f1(row, "Task_ID") === putWithRun.data.task_id);
    assert.ok(createdTask);
    assert.equal(f1(createdTask, "Source"), "cron");
    assert.equal(f1(createdTask, "Status"), "completed");
    assert.equal(JSON.parse(f1(createdTask, "Metadata")).schedule_id, "daily");

    // Leader 通过 /agents/register 带上 schedules，再空着重新注册应保留
    const leaderAdded = await apiJson(baseUrl, "/api/v1/admin/agents", {
      method: "POST",
      token: apiToken,
      body: { node: "muse", access: "http", role: "leader" },
    });
    assert.equal(leaderAdded.status, 200);
    const leaderToken = leaderAdded.data.token;
    const regSched = await apiJson(baseUrl, "/api/v1/agents/register", {
      method: "POST",
      token: leaderToken,
      body: {
        node: "muse",
        role: "leader",
        schedules: [{ id: "watch", cron: "*/15 * * * *", cap: "agent", text: "看更新", enabled: false }],
      },
    });
    assert.equal(regSched.status, 200);
    const regKeep = await apiJson(baseUrl, "/api/v1/agents/register", {
      method: "POST",
      token: leaderToken,
      body: { node: "muse", role: "leader" },
    });
    assert.equal(regKeep.status, 200);

    const listed = await apiJson(baseUrl, "/api/v1/schedules", { token: apiToken });
    assert.equal(listed.status, 200);
    const daily = listed.data.schedules.find((item) => item.rule_id === "grok-bot:daily");
    assert.ok(daily);
    assert.equal(daily.source, "http-agent");
    assert.equal(daily.cron, "0 9 * * *");
    assert.equal(daily.tz, "Asia/Shanghai");
    assert.equal(daily.interval_min, 1440);
    assert.equal(daily.cap, "agent");
    assert.equal(daily.text, "早报");
    assert.equal(daily.enabled, true);
    assert.equal(daily.node, "grok-bot");
    assert.equal(daily.anomaly, "");
    assert.equal(daily.last_task?.task_id, putWithRun.data.task_id);
    assert.equal(daily.last_task?.status, "completed");
    assert.ok(daily.next_fire_at);

    const watch = listed.data.schedules.find((item) => item.schedule_id === "watch");
    assert.ok(watch);
    assert.equal(watch.enabled, false);
    assert.equal(watch.interval_min, 15);
    assert.equal(watch.source, "http-agent");

    const removed = await apiJson(baseUrl, "/api/v1/agents/grok-bot/schedules/daily", {
      method: "DELETE",
      token: workerToken,
    });
    assert.equal(removed.status, 200);
    const after = await apiJson(baseUrl, "/api/v1/schedules", { token: apiToken });
    assert.equal(after.data.schedules.some((item) => item.rule_id === "grok-bot:daily"), false);
    const missing = await apiJson(baseUrl, "/api/v1/agents/grok-bot/schedules/daily", {
      method: "DELETE",
      token: workerToken,
    });
    assert.equal(missing.status, 404);
  });
});
