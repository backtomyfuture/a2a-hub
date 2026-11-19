// 幽灵节点、Hub 本机名片自动接纳、Leader 增量更新。
// 状态只写临时目录，不碰 ~/.a2a-hub。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { f1 } from "../src/bus/tables.mjs";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES } from "../src/bus/tables.mjs";
import { Kernel } from "../src/kernel.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { LongPollBroker, NODE_EXPIRE_MS, ROSTER_IDLE_MS } from "../src/server/longpoll-broker.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockBus } from "./mocks/mock-bus.mjs";

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

async function startServer(dir, bus, broker, token = "hygiene-token") {
  return startHubHttpServer({
    cfg: {
      node: "mac-mini-hub",
      configDir: dir,
      listen: "127.0.0.1:0",
      apiToken: token,
    },
    bus,
    broker,
    log: () => {},
    onWake: () => {},
  });
}

async function seedTask(bus, { taskId, from, status }) {
  const msgId = `MSG-${taskId}-01`;
  const message = await bus.createRecord(bus.tables.messages, {
    Msg_ID: msgId,
    Task_ID: taskId,
    Context_ID: "CTX-H",
    From_Node: from,
    To_Node: "worker-a",
    Role: "user",
    Kind: "instruction",
    Created_At: "2026-11-18T00:00:00.000Z",
  });
  const task = await bus.createRecord(bus.tables.tasks, {
    Task_ID: taskId,
    Title: taskId,
    Source: from,
    Target_Node: "worker-a",
    Status: status,
    Context_ID: "CTX-H",
    Skill_ID: "echo",
  });
  // Part 序号故意落在任务行之后，changed_seq 不能把它算进去。
  const part = await bus.createRecord(bus.tables.parts, {
    Part_ID: `${msgId}-P1`,
    Parent_ID: msgId,
    Parent_Type: "message",
    Seq: 1,
    Kind: "text",
    Text: "做一下",
  });
  return { message, task, part };
}

function kernelFor(dir, bus, { role, node, capPrefix }) {
  fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
    echo: { desc: "回声" },
    extra: { desc: "另一张" },
  }), { mode: 0o600 });
  return new Kernel({
    node,
    role,
    kind: "host",
    zone: "test",
    capPrefix,
    events: false,
    configDir: dir,
    bus,
  });
}

test("LongPollBroker：超过 24 小时的节点从内存清除，刚好 24 小时仍保留", () => {
  const broker = new LongPollBroker();
  broker.touchAgent("probe-agent", { kind: "agent", role: "worker" });
  broker.touchAgent("fresh-agent", { kind: "agent" });
  const probe = broker._nodes.get("probe-agent");
  const fresh = broker._nodes.get("fresh-agent");
  probe.lastSeenAt = 1_000_000;
  fresh.lastSeenAt = 1_000_000 + NODE_EXPIRE_MS;

  const atBoundary = broker.connectedNodes(probe.lastSeenAt + NODE_EXPIRE_MS);
  assert.equal(atBoundary.some((n) => n.node === "probe-agent"), true);
  assert.equal(broker._nodes.has("probe-agent"), true);

  const expired = broker.connectedNodes(probe.lastSeenAt + NODE_EXPIRE_MS + 1);
  assert.equal(expired.some((n) => n.node === "probe-agent"), false);
  assert.equal(broker._nodes.has("probe-agent"), false);
  assert.equal(expired.some((n) => n.node === "fresh-agent"), true);
  broker.close();
});

test("名册隐藏无名片且 30 分钟无活动的节点，有名片的离线节点仍在", async () => {
  await withTemp(async (dir) => {
    const broker = new LongPollBroker();
    const bus = new SqliteBus({
      dbPath: path.join(dir, "hub.db"),
      tables: DEFAULT_TABLES,
      broker,
    });
    const token = "hygiene-token";
    const httpHandle = await startServer(dir, bus, broker, token);
    try {
      const now = Date.now();
      broker.touchAgent("probe-agent", { kind: "agent", role: "worker" });
      broker.touchAgent("fresh-probe", { kind: "agent", role: "worker" });
      broker.touchAgent("card-node", { kind: "agent", role: "worker" });
      broker.touchAgent("ancient-probe", { kind: "agent" });
      broker._nodes.get("probe-agent").lastSeenAt = now - ROSTER_IDLE_MS - 1000;
      broker._nodes.get("card-node").lastSeenAt = now - ROSTER_IDLE_MS - 1000;
      broker._nodes.get("ancient-probe").lastSeenAt = now - NODE_EXPIRE_MS - 1000;

      await bus.createRecord(bus.tables.agentCards, {
        Cap_ID: "CAP-card-echo",
        Node: "card-node",
        Skill_ID: "echo",
        Availability: "offline",
        Dispatchable: "Yes",
        Admission: "admitted",
      });
      await bus.createRecord(bus.tables.agentCards, {
        Cap_ID: "CAP-offline-only",
        Node: "offline-card",
        Skill_ID: "echo",
        Availability: "offline",
        Dispatchable: "Yes",
        Admission: "pending",
      });

      const agents = await apiJson(httpHandle.localUrl, "/api/v1/agents", { token });
      assert.equal(agents.status, 200);
      const names = agents.data.agents.map((a) => a.node);
      assert.equal(names.includes("probe-agent"), false);
      assert.equal(names.includes("ancient-probe"), false);
      assert.equal(names.includes("fresh-probe"), true);
      assert.equal(names.includes("card-node"), true);
      assert.equal(names.includes("offline-card"), true);
      assert.equal(broker._nodes.has("probe-agent"), true);
      assert.equal(broker._nodes.has("ancient-probe"), false);

      const state = await apiJson(httpHandle.localUrl, "/api/v1/state", { token });
      assert.equal(state.status, 200);
      const connected = state.data.connectedNodes.map((n) => n.node);
      assert.equal(connected.includes("probe-agent"), false);
      assert.equal(connected.includes("fresh-probe"), true);
      assert.equal(connected.includes("card-node"), true);
      // Hub 自身不经 HTTP 轮询，仍要有在线记录和最近活动时间。
      const self = state.data.connectedNodes.find((n) => n.node === "mac-mini-hub");
      assert.equal(self.online, true);
      assert.ok(Date.now() - self.lastSeenAt < 5000);
      assert.equal(state.data.agentCards.some((c) => c.node === "offline-card"), true);
    } finally {
      await httpHandle.close();
      broker.close();
      bus.close();
    }
  });
});

test("Leader updates：since / new=1 过滤终态，待处理始终返回，水位按 changed_seq 持久化", async () => {
  await withTemp(async (dir) => {
    const dbPath = path.join(dir, "hub.db");
    const token = "hygiene-token";
    const leader = "muse-inc";

    const broker = new LongPollBroker();
    const bus = new SqliteBus({ dbPath, tables: DEFAULT_TABLES, broker });
    const httpHandle = await startServer(dir, bus, broker, token);
    try {
      const pending = await seedTask(bus, { taskId: "TASK-PEND", from: leader, status: "input-required" });
      const done = await seedTask(bus, { taskId: "TASK-DONE", from: leader, status: "completed" });
      await bus.createRecord(bus.tables.agentCards, {
        Cap_ID: "CAP-unrelated",
        Node: "someone",
        Skill_ID: "echo",
        Admission: "admitted",
      });

      const taskSeq = done.task.record.seq;
      const msgSeq = done.message.record.seq;
      const partSeq = done.part.record.seq;
      const expectSeq = Math.max(taskSeq, msgSeq);
      assert.ok(partSeq > expectSeq);

      const plain = await apiJson(httpHandle.localUrl, `/api/v1/agents/${leader}/updates`, { token });
      assert.equal(plain.status, 200);
      assert.equal(plain.data.watermark, 0);
      assert.equal(plain.data.updates.length, 2);
      const doneBrief = plain.data.updates.find((u) => u.task_id === "TASK-DONE");
      const pendBrief = plain.data.updates.find((u) => u.task_id === "TASK-PEND");
      assert.equal(doneBrief.changed_seq, expectSeq);
      assert.ok(doneBrief.changed_seq < plain.data.seq);
      assert.equal(pendBrief.status, "input-required");

      const badSince = await apiJson(httpHandle.localUrl, `/api/v1/agents/${leader}/updates?since=abc`, { token });
      assert.equal(badSince.status, 400);

      const sinceDone = await apiJson(
        httpHandle.localUrl,
        `/api/v1/agents/${leader}/updates?since=${doneBrief.changed_seq}`,
        { token },
      );
      assert.equal(sinceDone.status, 200);
      assert.deepEqual(sinceDone.data.updates.map((u) => u.task_id), ["TASK-PEND"]);
      assert.equal(sinceDone.data.watermark, 0);
      assert.equal(await bus.getMeta(`updates_watermark:${leader}`), null);

      const sliced = await apiJson(
        httpHandle.localUrl,
        `/api/v1/agents/${leader}/updates?new=1&status=completed`,
        { token },
      );
      assert.equal(sliced.status, 200);
      assert.deepEqual(sliced.data.updates.map((u) => u.task_id), ["TASK-DONE"]);
      assert.equal(sliced.data.watermark, 0);
      assert.equal(await bus.getMeta(`updates_watermark:${leader}`), null);

      const firstNew = await apiJson(httpHandle.localUrl, `/api/v1/agents/${leader}/updates?new=1`, { token });
      assert.equal(firstNew.status, 200);
      assert.equal(firstNew.data.updates.length, 2);
      assert.equal(firstNew.data.watermark, doneBrief.changed_seq);
      assert.ok(firstNew.data.watermark < firstNew.data.seq);
      assert.equal(await bus.getMeta(`updates_watermark:${leader}`), String(doneBrief.changed_seq));

      const secondNew = await apiJson(httpHandle.localUrl, `/api/v1/agents/${leader}/updates?new=1`, { token });
      assert.equal(secondNew.status, 200);
      assert.deepEqual(secondNew.data.updates.map((u) => u.task_id), ["TASK-PEND"]);
      assert.equal(secondNew.data.watermark, doneBrief.changed_seq);

      const plainAgain = await apiJson(httpHandle.localUrl, `/api/v1/agents/${leader}/updates`, { token });
      assert.equal(plainAgain.data.updates.length, 2);
      assert.equal(plainAgain.data.watermark, doneBrief.changed_seq);
    } finally {
      await httpHandle.close();
      broker.close();
      bus.close();
    }

    const broker2 = new LongPollBroker();
    const bus2 = new SqliteBus({ dbPath, tables: DEFAULT_TABLES, broker: broker2 });
    const http2 = await startServer(dir, bus2, broker2, token);
    try {
      const afterRestart = await apiJson(http2.localUrl, `/api/v1/agents/${leader}/updates?new=1`, { token });
      assert.equal(afterRestart.status, 200);
      assert.deepEqual(afterRestart.data.updates.map((u) => u.task_id), ["TASK-PEND"]);
      assert.equal(afterRestart.data.watermark, Number(await bus2.getMeta(`updates_watermark:${leader}`)));

      const rows = await bus2.listRecords(bus2.tables.tasks);
      const pendRow = rows.find((r) => f1(r, "Task_ID") === "TASK-PEND");
      await bus2.updateRecord(bus2.tables.tasks, pendRow.record_id, { Status: "completed" });
      const once = await apiJson(http2.localUrl, `/api/v1/agents/${leader}/updates?new=1`, { token });
      assert.deepEqual(once.data.updates.map((u) => u.task_id), ["TASK-PEND"]);
      assert.equal(once.data.updates[0].status, "completed");
      assert.ok(once.data.watermark > afterRestart.data.watermark);
      const twice = await apiJson(http2.localUrl, `/api/v1/agents/${leader}/updates?new=1`, { token });
      assert.equal(twice.data.updates.length, 0);
      assert.equal(twice.data.watermark, once.data.watermark);
    } finally {
      await http2.close();
      broker2.close();
      bus2.close();
    }
  });
});

test("Leader updates：总线没有 meta 时水位落在进程内", async () => {
  await withTemp(async (dir) => {
    const token = "hygiene-token";
    const leader = "muse-mem";
    const broker = new LongPollBroker();
    const bus = new MockBus({ tables: DEFAULT_TABLES });
    assert.equal(typeof bus.getMeta, "undefined");
    const httpHandle = await startServer(dir, bus, broker, token);
    try {
      await seedTask(bus, { taskId: "TASK-MEM", from: leader, status: "completed" });
      const first = await apiJson(httpHandle.localUrl, `/api/v1/agents/${leader}/updates?new=1`, { token });
      assert.equal(first.status, 200);
      assert.equal(first.data.updates.length, 1);
      assert.ok(first.data.watermark > 0);
      const second = await apiJson(httpHandle.localUrl, `/api/v1/agents/${leader}/updates?new=1`, { token });
      assert.equal(second.data.updates.length, 0);
      assert.equal(second.data.watermark, first.data.watermark);
    } finally {
      await httpHandle.close();
      broker.close();
    }

    const broker2 = new LongPollBroker();
    const bus2 = new MockBus({ tables: DEFAULT_TABLES });
    const http2 = await startServer(dir, bus2, broker2, token);
    try {
      const carried = await apiJson(http2.localUrl, `/api/v1/agents/${leader}/updates?new=1`, { token });
      assert.equal(carried.data.updates.length, 0);
      assert.ok(carried.data.watermark > 0);
    } finally {
      await http2.close();
      broker2.close();
    }
  });
});

test("role=hub 的本机名片空 Admission 自动补成 admitted，显式决定和远端名片不动", async () => {
  await withTemp(async (dir) => {
    const bus = new MockBus({ tables: TABLES });
    await bus.createRecord(TABLES.agentCards, {
      Cap_ID: "CAP-hub-echo",
      Node: "hub-node",
      Skill_ID: "echo",
      Dispatchable: "Yes",
      Availability: "online",
    });
    await bus.createRecord(TABLES.agentCards, {
      Cap_ID: "CAP-hub-hold",
      Node: "hub-node",
      Skill_ID: "hold",
      Admission: "pending",
      Dispatchable: "Yes",
    });
    await bus.createRecord(TABLES.agentCards, {
      Cap_ID: "CAP-hub-no",
      Node: "hub-node",
      Skill_ID: "no",
      Admission: "rejected",
      Dispatchable: "Yes",
    });
    await bus.createRecord(TABLES.agentCards, {
      Cap_ID: "CAP-hub-blank",
      Node: "hub-node",
      Skill_ID: "blank",
      Admission: "   ",
      Dispatchable: "Yes",
    });
    await bus.createRecord(TABLES.agentCards, {
      Cap_ID: "CAP-remote-echo",
      Node: "remote-node",
      Skill_ID: "echo",
      Admission: "",
      Dispatchable: "Yes",
    });

    const hub = kernelFor(dir, bus, { role: "hub", node: "hub-node", capPrefix: "hub" });
    await hub.reconcileCards();
    const cards = await bus.listRecords(TABLES.agentCards);
    const byCap = (id) => cards.find((r) => f1(r, "Cap_ID") === id);
    assert.equal(f1(byCap("CAP-hub-echo"), "Admission"), "admitted");
    assert.equal(f1(byCap("CAP-hub-extra"), "Admission"), "admitted");
    assert.equal(f1(byCap("CAP-hub-hold"), "Admission"), "pending");
    assert.equal(f1(byCap("CAP-hub-no"), "Admission"), "rejected");
    assert.equal(f1(byCap("CAP-hub-blank"), "Admission"), "admitted");
    assert.equal(f1(byCap("CAP-remote-echo"), "Admission"), "");

    await hub.reconcileCards();
    const again = await bus.listRecords(TABLES.agentCards);
    assert.equal(f1(again.find((r) => f1(r, "Cap_ID") === "CAP-hub-hold"), "Admission"), "pending");
    assert.equal(f1(again.find((r) => f1(r, "Cap_ID") === "CAP-hub-no"), "Admission"), "rejected");
  });
});

test("role=node 对账不给本机名片写 Admission", async () => {
  await withTemp(async (dir) => {
    const bus = new MockBus({ tables: TABLES });
    await bus.createRecord(TABLES.agentCards, {
      Cap_ID: "CAP-nodea-echo",
      Node: "node-a",
      Skill_ID: "echo",
      Dispatchable: "Yes",
    });
    const node = kernelFor(dir, bus, { role: "node", node: "node-a", capPrefix: "nodea" });
    await node.reconcileCards();
    const cards = await bus.listRecords(TABLES.agentCards);
    for (const row of cards) {
      if (f1(row, "Node") !== "node-a") continue;
      assert.equal(f1(row, "Admission"), "");
    }
    assert.ok(cards.some((r) => f1(r, "Cap_ID") === "CAP-nodea-extra"));
  });
});
