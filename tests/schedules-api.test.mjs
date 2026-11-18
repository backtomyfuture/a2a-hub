// 定时任务只读列表，以及 HTTP Agent 自报计划（中台不触发）。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES, f1 } from "../src/bus/tables.mjs";
import { listSchedules } from "../src/hub/capabilities.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { LongPollBroker } from "../src/server/longpoll-broker.mjs";
import { formatOccurrenceKey, latestOccurrence, parseCron } from "../src/schedule-cron.mjs";
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

test("列表异常：离线优先，其次最近任务失败，再其次超过 10 分钟未触发", () => {
  const now = new Date("2026-11-18T04:30:00.000Z");
  const tz = "Asia/Shanghai";
  const due = latestOccurrence(parseCron("0 * * * *"), new Date(now.getTime() - 10 * 60 * 1000), tz);
  const dueKey = formatOccurrenceKey(due, tz);
  const rules = [
    {
      fields: {
        Rule_ID: "bot:hourly",
        Target_Node: "bot",
        Skill_ID: "agent",
        Schedule: "0 * * * *",
        Text: "巡检",
        Enabled: "Yes",
        Last_Fired: "",
        Note: "http-agent 自报；tz=Asia/Shanghai",
      },
    },
    {
      fields: {
        Rule_ID: "bot:bad",
        Target_Node: "bot",
        Skill_ID: "agent",
        Schedule: "0 * * * *",
        Text: "失败的一轮",
        Enabled: "Yes",
        Last_Fired: dueKey,
        Note: "http-agent 自报；tz=Asia/Shanghai",
      },
    },
    {
      fields: {
        Rule_ID: "desk:night",
        Target_Node: "desk",
        Skill_ID: "brief",
        Schedule: "0 9 * * *",
        Text: "早报",
        Enabled: "Yes",
        Last_Fired: dueKey,
        Note: "尚未运行；同步于 2026-11-18T12:00:00+0800",
      },
    },
  ];
  const tasks = [
    {
      fields: {
        Task_ID: "TASK-BAD",
        Status: "failed",
        Idempotency_Key: `sched:bot:bad:${dueKey}`,
        Updated_At: "2026-11-18T04:00:00.000Z",
      },
    },
  ];
  const cards = [
    { fields: { Node: "bot", Availability: "online" } },
    { fields: { Node: "desk", Availability: "offline" } },
  ];
  const listed = listSchedules({ rules, tasks, cards, connected: [], now, hubNode: "mac-mini-hub" });
  const byId = Object.fromEntries(listed.map((item) => [item.schedule_id, item]));
  assert.equal(byId.hourly.anomaly, "missed");
  assert.equal(byId.hourly.source, "http-agent");
  assert.equal(byId.hourly.tz, "Asia/Shanghai");
  assert.ok(byId.hourly.next_fire_at);
  assert.equal(byId.bad.anomaly, "failed");
  assert.equal(byId.bad.last_task.task_id, "TASK-BAD");
  assert.equal(byId.bad.last_task.status, "failed");
  assert.equal(byId.bad.last_task.updated_at, "2026-11-18T04:00:00.000Z");
  assert.equal(byId.night.anomaly, "node-offline");
  assert.equal(byId.night.source, "node");
});

test("机主只读列表；Agent 只能写自己的计划，不能看总表", async () => {
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
    const ruleRow = (await bus.listRecords(DEFAULT_TABLES.rules)).find((row) => f1(row, "Rule_ID") === "grok-bot:daily");
    await bus.updateRecord(DEFAULT_TABLES.rules, ruleRow.record_id, {
      Last_Fired: formatOccurrenceKey(new Date(), "Asia/Shanghai"),
    });

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

    const leader = await apiJson(baseUrl, "/api/v1/admin/tokens/muse/rotate", {
      method: "POST",
      token: apiToken,
      body: { role: "leader" },
    });
    const leaderPut = await apiJson(baseUrl, "/api/v1/agents/muse/schedules/watch", {
      method: "PUT",
      token: leader.data.token,
      body: { cron: "*/15 * * * *", cap: "agent", text: "看更新", enabled: false },
    });
    assert.equal(leaderPut.status, 200);

    const listed = await apiJson(baseUrl, "/api/v1/schedules", { token: apiToken });
    assert.equal(listed.status, 200);
    const daily = listed.data.schedules.find((item) => item.rule_id === "grok-bot:daily");
    assert.ok(daily);
    assert.equal(daily.source, "http-agent");
    assert.equal(daily.cron, "0 9 * * *");
    assert.equal(daily.tz, "Asia/Shanghai");
    assert.equal(daily.cap, "agent");
    assert.equal(daily.text, "早报");
    assert.equal(daily.enabled, true);
    assert.equal(daily.node, "grok-bot");
    assert.equal(daily.anomaly, "");
    assert.ok(daily.next_fire_at);
    const watch = listed.data.schedules.find((item) => item.schedule_id === "watch");
    assert.equal(watch.enabled, false);
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
