// 排队超时、执行租约、挂起超时、重复答复、名录审计与在线快照。状态只写临时目录。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";
import { f1 } from "../src/bus/tables.mjs";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES } from "../src/bus/tables.mjs";
import { createTask, defaultTaskPolicy } from "../src/hub/create.mjs";
import { HubRuntime } from "../src/hub/index.mjs";
import { StaleService } from "../src/hub/stale.mjs";
import { AgentTokenStore } from "../src/hub/agent-tokens.mjs";
import { heartbeatFields } from "../src/kernel-util.mjs";
import { LongPollBroker } from "../src/server/longpoll-broker.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { TABLES, withTemp } from "./helpers.mjs";
import { MockBus } from "./mocks/mock-bus.mjs";

const NOW = Date.parse("2026-06-01T00:10:00.000Z");

function card(node, receive, meta) {
  return { fields: { Node: node, Receive_Mode: receive, Metadata: JSON.stringify(meta) } };
}

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

function metaOf(row) {
  return JSON.parse(String(f1(row, "Metadata")));
}

test("建单按接收方式写默认超时，显式秒数优先", async () => {
  assert.deepEqual(defaultTaskPolicy([], "none"), {
    queueTimeoutSec: 900, leaseTtlSec: 300, waitTimeoutSec: 900,
  });
  assert.deepEqual(defaultTaskPolicy([
    card("host-a", "poll", { kind: "host", mode: "agent" }),
  ], "host-a"), {
    queueTimeoutSec: 900, leaseTtlSec: 300, waitTimeoutSec: 900,
  });
  assert.deepEqual(defaultTaskPolicy([
    card("slow", "http-poll", { kind: "agent", mode: "http-poll", poll_interval_min: 10 }),
  ], "slow"), {
    queueTimeoutSec: 3900, leaseTtlSec: 1200, waitTimeoutSec: 3900,
  });
  assert.equal(defaultTaskPolicy([
    card("hourly", "http-poll", { kind: "agent", mode: "http-poll", poll_interval_min: 60 }),
  ], "hourly").queueTimeoutSec, 3900);
  assert.equal(defaultTaskPolicy([
    card("slower", "http-poll", { kind: "agent", mode: "http-poll", poll_interval_min: 90 }),
  ], "slower").queueTimeoutSec, 5700);
  assert.deepEqual(defaultTaskPolicy([
    card("wiz", "poll", { kind: "agent", mode: "poll", poll_interval_min: 10 }),
  ], "wiz").queueTimeoutSec, 3900);
  assert.deepEqual(defaultTaskPolicy([
    card("hook", "webhook", { kind: "agent", mode: "webhook" }),
  ], "hook"), {
    queueTimeoutSec: 3600, leaseTtlSec: 1200, waitTimeoutSec: 3600,
  });
  assert.equal(defaultTaskPolicy([
    card("long", "http-longpoll", { kind: "agent", mode: "http-longpoll" }),
  ], "long").leaseTtlSec, 1200);
  assert.equal(defaultTaskPolicy([
    card("mix", "event", { kind: "host", mode: "agent" }),
    card("mix", "webhook", { kind: "agent", mode: "webhook" }),
  ], "mix").queueTimeoutSec, 3600);

  const bus = new MockBus({ tables: TABLES });
  await bus.createRecord(TABLES.agentCards, {
    Cap_ID: "CAP-hook",
    Node: "wh",
    Skill_ID: "agent",
    Dispatchable: "Yes",
    Admission: "admitted",
    Receive_Mode: "webhook",
    Metadata: JSON.stringify({ kind: "agent", mode: "webhook" }),
  });
  const id = await createTask({ bus, to: "wh", text: "hi" });
  const row = (await bus.findRecords(TABLES.tasks, "Task_ID", id))[0];
  assert.deepEqual(metaOf(row), {
    queue_timeout_sec: 3600, lease_ttl_sec: 1200, wait_timeout_sec: 3600,
  });
  const custom = await createTask({
    bus, to: "wh", text: "override", queueTimeoutSec: 42, leaseTtlSec: 7, waitTimeoutSec: 9,
  });
  const customRow = (await bus.findRecords(TABLES.tasks, "Task_ID", custom))[0];
  assert.deepEqual(metaOf(customRow), {
    queue_timeout_sec: 42, lease_ttl_sec: 7, wait_timeout_sec: 9,
  });
});

test("坏 JSON 不刷新租约，避免把 Metadata 写成空对象", () => {
  const fields = heartbeatFields("not-json", new Date("2026-06-01T00:00:00.000Z"));
  assert.equal(Object.hasOwn(fields, "Metadata"), false);
  assert.match(fields.Heartbeat_At, /^2026-06-01T/);
  const leased = heartbeatFields(JSON.stringify({ lease_ttl_sec: 300, note: "keep" }), new Date("2026-06-01T00:00:00.000Z"));
  const meta = JSON.parse(leased.Metadata);
  assert.equal(meta.note, "keep");
  assert.equal(meta.lease_ttl_sec, 300);
  assert.ok(meta.lease_expires_at);
});

test("排队超时、租约到期与挂起超时会回收，刚恢复的心跳和刚到达的答复不回收", async () => {
  await withTemp(async (dir) => {
    const bus = new MockBus({ tables: TABLES });
    const stale = new StaleService({
      bus,
      statePath: path.join(dir, "stale_state.json"),
      allowLocalAlert: true,
      log: () => {},
      now: () => NOW,
    });
    const old = "2026-06-01T00:00:00.000Z";
    const fresh = "2026-06-01T00:09:40.000Z";
    async function task(fields, instructionAt) {
      const id = fields.Task_ID;
      await bus.createRecord(TABLES.messages, {
        Msg_ID: `MSG-${id}`,
        Task_ID: id,
        From_Node: "leader",
        To_Node: "worker",
        Role: "user",
        Kind: "instruction",
        Created_At: instructionAt,
      });
      const created = await bus.createRecord(TABLES.tasks, {
        Title: id,
        Source: "leader",
        Target_Node: "worker",
        Skill_ID: "agent",
        ...fields,
      });
      return created.record.record_id;
    }
    await task({
      Task_ID: "Q-OLD", Status: "submitted",
      Metadata: JSON.stringify({ queue_timeout_sec: 60 }),
    }, old);
    await task({
      Task_ID: "Q-NEW", Status: "submitted",
      Metadata: JSON.stringify({ queue_timeout_sec: 600 }),
    }, fresh);
    await task({
      Task_ID: "LEASE-DEAD", Status: "working", Claimed_By: "worker",
      Heartbeat_At: old,
      Metadata: JSON.stringify({ lease_ttl_sec: 300, lease_expires_at: "2026-06-01T00:05:00.000Z" }),
    }, old);
    await task({
      Task_ID: "LEASE-LIVE", Status: "working", Claimed_By: "worker",
      Heartbeat_At: fresh,
      Metadata: JSON.stringify({ lease_ttl_sec: 300, lease_expires_at: "2026-06-01T00:09:00.000Z", note: "keep" }),
    }, old);
    await task({
      Task_ID: "WAIT-OLD", Status: "input-required", Status_Msg: "MSG-Q1",
      Metadata: JSON.stringify({ wait_timeout_sec: 60 }),
    }, old);
    await bus.createRecord(TABLES.messages, {
      Msg_ID: "MSG-Q1", Task_ID: "WAIT-OLD", Kind: "question", Created_At: old,
      From_Node: "worker", To_Node: "leader", Role: "agent",
    });
    await task({
      Task_ID: "WAIT-ANS", Status: "input-required", Status_Msg: "MSG-Q2",
      Metadata: JSON.stringify({ wait_timeout_sec: 60 }),
    }, old);
    await bus.createRecord(TABLES.messages, {
      Msg_ID: "MSG-Q2", Task_ID: "WAIT-ANS", Kind: "question", Created_At: old,
      From_Node: "worker", To_Node: "leader", Role: "agent",
    });
    await bus.createRecord(TABLES.messages, {
      Msg_ID: "MSG-A2", Task_ID: "WAIT-ANS", Kind: "answer", In_Reply_To: "MSG-Q2", Created_At: fresh,
      From_Node: "leader", To_Node: "worker", Role: "user",
    });
    await task({
      Task_ID: "WORK-25", Status: "working", Claimed_By: "worker",
      Heartbeat_At: "2026-05-31T23:45:00.000Z",
    }, old);

    await stale.scan();
    async function status(id) {
      const rows = await bus.findRecords(TABLES.tasks, "Task_ID", id);
      return f1(rows[0], "Status");
    }
    assert.equal(await status("Q-OLD"), "failed");
    assert.equal(await status("Q-NEW"), "submitted");
    assert.equal(await status("LEASE-DEAD"), "failed");
    assert.equal(await status("LEASE-LIVE"), "working");
    assert.equal(await status("WAIT-OLD"), "failed");
    assert.equal(await status("WAIT-ANS"), "input-required");
    assert.equal(await status("WORK-25"), "working");
  });
});

test("同一问题重复 reply 为 409，append 和新问题仍可追加；认领与心跳刷新租约", async () => {
  await withTemp(async (dir) => {
    const token = "owner-token-0123456789abcdef";
    const broker = new LongPollBroker();
    const bus = new SqliteBus({ dbPath: path.join(dir, "hub.db"), tables: DEFAULT_TABLES, broker });
    const http = await startHubHttpServer({
      cfg: { node: "hub", configDir: dir, listen: "127.0.0.1:0", apiToken: token },
      bus,
      broker,
      log: () => {},
      onWake: () => {},
    });
    try {
      const task = await bus.createRecord(DEFAULT_TABLES.tasks, {
        Task_ID: "TASK-ASK",
        Title: "ask",
        Source: "muse",
        Target_Node: "grok-bot",
        Status: "input-required",
        Status_Msg: "MSG-Q",
        Context_ID: "CTX-ASK",
        Skill_ID: "agent",
        Metadata: JSON.stringify({ lease_ttl_sec: 300, note: "keep" }),
      });
      await bus.createRecord(DEFAULT_TABLES.messages, {
        Msg_ID: "MSG-Q", Task_ID: "TASK-ASK", Context_ID: "CTX-ASK",
        From_Node: "grok-bot", To_Node: "muse", Role: "agent", Kind: "question",
        Created_At: "2026-06-01 00:00",
      });
      const first = await apiJson(http.localUrl, "/api/v1/tasks/TASK-ASK/reply", {
        method: "POST", token, body: { text: "第一次" },
      });
      assert.equal(first.status, 200);
      const dup = await apiJson(http.localUrl, "/api/v1/tasks/TASK-ASK/reply", {
        method: "POST", token, body: { text: "再来一次" },
      });
      assert.equal(dup.status, 409);
      assert.match(dup.data.error, /append:true/);
      const extra = await apiJson(http.localUrl, "/api/v1/tasks/TASK-ASK/reply", {
        method: "POST", token, body: { text: "补充", append: true },
      });
      assert.equal(extra.status, 200);
      await bus.updateRecord(DEFAULT_TABLES.tasks, task.record.record_id, { Status_Msg: "MSG-Q2" });
      const next = await apiJson(http.localUrl, "/api/v1/tasks/TASK-ASK/reply", {
        method: "POST", token, body: { text: "新问题" },
      });
      assert.equal(next.status, 200);
      const answers = (await bus.listRecords(DEFAULT_TABLES.messages))
        .filter((m) => f1(m, "Task_ID") === "TASK-ASK" && f1(m, "Kind") === "answer");
      assert.equal(answers.length, 3);

      const submitted = await bus.createRecord(DEFAULT_TABLES.tasks, {
        Task_ID: "TASK-RUN",
        Title: "run",
        Source: "muse",
        Target_Node: "grok-bot",
        Status: "submitted",
        Context_ID: "CTX-RUN",
        Skill_ID: "agent",
        Metadata: JSON.stringify({ lease_ttl_sec: 300, note: "keep" }),
      });
      const claim = await apiJson(http.localUrl, "/api/v1/tasks/TASK-RUN/claim", {
        method: "POST", token, body: { node: "grok-bot" },
      });
      assert.equal(claim.status, 200);
      let run = await bus.getRecord(DEFAULT_TABLES.tasks, submitted.record.record_id);
      let runMeta = metaOf(run);
      assert.equal(runMeta.note, "keep");
      assert.equal(runMeta.lease_ttl_sec, 300);
      assert.ok(Date.parse(runMeta.lease_expires_at) > Date.now() + 200_000);
      const before = runMeta.lease_expires_at;
      await new Promise((r) => setTimeout(r, 1100));
      const hb = await apiJson(http.localUrl, "/api/v1/tasks/TASK-RUN/heartbeat", {
        method: "POST", token, body: { node: "grok-bot" },
      });
      assert.equal(hb.status, 200);
      run = await bus.getRecord(DEFAULT_TABLES.tasks, submitted.record.record_id);
      runMeta = metaOf(run);
      assert.equal(runMeta.note, "keep");
      assert.ok(runMeta.lease_expires_at > before);

      const bad = await bus.createRecord(DEFAULT_TABLES.tasks, {
        Task_ID: "TASK-BAD",
        Title: "bad",
        Source: "muse",
        Target_Node: "grok-bot",
        Status: "working",
        Claimed_By: "grok-bot",
        Context_ID: "CTX-BAD",
        Skill_ID: "agent",
        Metadata: "not-json",
      });
      const badHb = await apiJson(http.localUrl, "/api/v1/tasks/TASK-BAD/heartbeat", {
        method: "POST", token, body: { node: "grok-bot" },
      });
      assert.equal(badHb.status, 200);
      const badRow = await bus.getRecord(DEFAULT_TABLES.tasks, bad.record.record_id);
      assert.equal(f1(badRow, "Metadata"), "not-json");
    } finally {
      await http.close();
      bus.close();
    }
  });
});

test("名片变更写入 audit_logs，机主可 GET，Agent Token 不可", async () => {
  await withTemp(async (dir) => {
    const token = "owner-token-0123456789abcdef";
    const bus = new SqliteBus({ dbPath: path.join(dir, "hub.db"), tables: DEFAULT_TABLES });
    const http = await startHubHttpServer({
      cfg: { node: "hub", configDir: dir, listen: "127.0.0.1:0", apiToken: token },
      bus,
      log: () => {},
      onWake: () => {},
    });
    try {
      const created = await bus.createRecord(DEFAULT_TABLES.agentCards, {
        Cap_ID: "CAP-n", Node: "n1", Skill_ID: "agent", Availability: "offline",
      });
      await bus.updateRecord(DEFAULT_TABLES.agentCards, created.record.record_id, {
        Availability: "online",
      });
      await bus.updateRecord(DEFAULT_TABLES.agentCards, created.record.record_id, {
        Updated_At: "2026-06-01 00:01",
      });
      await bus.deleteRecord(DEFAULT_TABLES.agentCards, created.record.record_id);
      const owner = await apiJson(http.localUrl, "/api/v1/admin/audit?table=agentCards", { token });
      assert.equal(owner.status, 200);
      assert.deepEqual(owner.data.logs.map((row) => row.op), ["delete", "update", "create"]);
      const store = new AgentTokenStore(dir);
      const issued = store.issue({ node: "muse", role: "leader" });
      const denied = await apiJson(http.localUrl, "/api/v1/admin/audit", { token: issued.token });
      assert.equal(denied.status, 403);
      assert.equal(denied.data.error, "Agent 身份不能查看名录变更审计日志");
    } finally {
      await http.close();
      bus.close();
    }
  });
});

test("presence 快照能装回，超过 24 小时的记录丢掉", async () => {
  await withTemp(async (dir) => {
    const bus = new SqliteBus({ dbPath: path.join(dir, "hub.db"), tables: DEFAULT_TABLES });
    try {
      const broker = new LongPollBroker();
      broker.attachPresenceSink((snap) => bus.setMeta("presence", JSON.stringify(snap)));
      broker.touchAgent("worker-1", { kind: "agent", mode: "http-poll" });
      await new Promise((resolve) => setImmediate(resolve));
      const raw = await bus.getMeta("presence");
      const restored = new LongPollBroker();
      assert.equal(restored.loadPresence(JSON.parse(raw)), 1);
      assert.ok(restored.exportPresence()["worker-1"].lastSeenAt > 0);
      assert.equal(restored.loadPresence({
        ancient: { node: "ancient", lastSeenAt: Date.now() - 25 * 60 * 60 * 1000 },
      }), 0);
      assert.equal(restored.exportPresence().ancient, undefined);
    } finally {
      bus.close();
    }
  });
});

test("陈旧巡检约 60 秒一次，对账 sweepSec 仍是 900，退出后停表", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "commands.json"), "{}\n", { mode: 0o600 });
    const bus = new MockBus({ tables: TABLES });
    let scans = 0;
    let touches = 0;
    const rt = new HubRuntime({
      cfg: { node: "hub", role: "hub", configDir: dir, bus, tables: TABLES },
      stale: { async scan() { scans += 1; } },
      log: () => {},
    });
    rt.kernel.touchLocalPresence = () => { touches += 1; };
    assert.equal(rt.sweepSec(), 900);
    // clearTimeout 随 setTimeout 一起被替换，不能单独列进 apis。
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      rt.startStaleWatch();
      assert.equal(scans, 0);
      mock.timers.tick(59_000);
      assert.equal(scans, 0);
      mock.timers.tick(1_000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(scans, 1);
      assert.equal(touches, 1);
      rt.stop();
      assert.equal(rt._staleTimer, null);
      mock.timers.tick(120_000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(scans, 1);
    } finally {
      mock.timers.reset();
    }
  });
});
