// 控制台添加能力、宿主片段，以及已拒绝名片在 register / 对账后仍保留。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES, f1 } from "../src/bus/tables.mjs";
import { capIdOf } from "../src/config.mjs";
import { buildCommandsSnippet, classifyNode } from "../src/hub/capabilities.mjs";
import { Kernel } from "../src/kernel.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { LongPollBroker } from "../src/server/longpoll-broker.mjs";
import { withTemp } from "./helpers.mjs";
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

async function withHub(fn) {
  await withTemp(async (rootDir) => {
    const hubDir = path.join(rootDir, "hub");
    fs.mkdirSync(hubDir, { recursive: true });
    const apiToken = "caps-owner-token";
    const broker = new LongPollBroker({ initialSeq: 0 });
    const bus = new SqliteBus({
      dbPath: path.join(hubDir, "hub.db"),
      tables: DEFAULT_TABLES,
      broker,
    });
    const httpHandle = await startHubHttpServer({
      cfg: { node: "mac-mini-hub", configDir: hubDir, listen: "127.0.0.1:0", apiToken },
      bus,
      broker,
      log: () => {},
      onWake: () => {},
    });
    try {
      await fn({ baseUrl: httpHandle.localUrl, apiToken, bus, hubDir });
    } finally {
      await httpHandle.close();
      bus.close();
      broker.close();
    }
  });
}

test("commands 片段：有 worker 时不需要 command，否则必须给 command", () => {
  const withWorker = buildCommandsSnippet({
    skill_id: "ops-check",
    worker: "agy",
    name: "运维巡检",
    description: "只读巡检",
    side_effect: "read",
    approval_class: "notify",
  });
  assert.deepEqual(withWorker.snippet, {
    "ops-check": {
      workers: ["agy"],
      name: "运维巡检",
      desc: "只读巡检",
      side_effect: "read",
      approval_class: "notify",
    },
  });
  assert.match(withWorker.hint, /commands\.json/);
  assert.equal(JSON.parse(withWorker.text)["ops-check"].workers[0], "agy");

  const direct = buildCommandsSnippet({
    skill_id: "brief",
    command: "node scripts/briefing.js",
    mode: "json",
    name: "早报",
    description: "汇总",
  });
  assert.equal(direct.snippet.brief.command, "node scripts/briefing.js");
  assert.equal(direct.snippet.brief.mode, "json");
  assert.equal(direct.snippet.brief.side_effect, "write");
  assert.throws(() => buildCommandsSnippet({ skill_id: "workers" }), /保留键 workers/);
  assert.throws(() => buildCommandsSnippet({ skill_id: "brief" }), /必须提供 command/);
});

test("节点类型：http-agent 名片、kind=agent 的接收方式，或已签发 Token", () => {
  const host = [{ fields: { Node: "mac", Daemon_Version: "0.9.0", Receive_Mode: "event", Metadata: "{\"kind\":\"host\"}" } }];
  assert.equal(classifyNode("mac", host, null), "host");
  assert.equal(classifyNode("gone", host, null), "missing");
  const httpCard = [{ fields: { Node: "bot", Daemon_Version: "http-agent", Receive_Mode: "http-poll" } }];
  assert.equal(classifyNode("bot", httpCard, null), "http");
  const kindAgent = [{
    fields: {
      Node: "bot2",
      Daemon_Version: "custom",
      Receive_Mode: "webhook",
      Metadata: "{\"kind\":\"agent\"}",
    },
  }];
  assert.equal(classifyNode("bot2", kindAgent, null), "http");
  assert.equal(classifyNode("tok", [], { get: (node) => (node === "tok" ? { node } : null) }), "http");
});

test("控制台添加 http 能力、宿主只给片段、手动名片可删，register 与对账不改回已拒绝", async () => {
  await withHub(async ({ baseUrl, apiToken, bus }) => {
    const added = await apiJson(baseUrl, "/api/v1/admin/agents", {
      method: "POST",
      token: apiToken,
      body: { node: "grok-bot", access: "http", role: "worker", display_name: "Grok" },
    });
    assert.equal(added.status, 200);
    const workerToken = added.data.token;

    const created = await apiJson(baseUrl, "/api/v1/admin/cards", {
      method: "POST",
      token: apiToken,
      body: {
        node: "grok-bot",
        skill_id: "ops-check",
        skill_name: "巡检",
        description: "只读看磁盘",
        side_effect: "read",
        approval_class: "notify",
        display_name: "巡检能力",
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.card.cap_id, capIdOf("ops-check", {}, "grok-bot"));
    assert.equal(created.data.card.admission, "admitted");
    assert.equal(created.data.card.availability, "offline");
    assert.equal(created.data.card.receive_mode, "http-poll");
    assert.equal(created.data.card.skill_id, "ops-check");

    const dup = await apiJson(baseUrl, "/api/v1/admin/cards", {
      method: "POST",
      token: apiToken,
      body: { node: "grok-bot", skill_id: "ops-check" },
    });
    assert.equal(dup.status, 409);

    const missing = await apiJson(baseUrl, "/api/v1/admin/cards", {
      method: "POST",
      token: apiToken,
      body: { node: "no-such", skill_id: "echo" },
    });
    assert.equal(missing.status, 404);

    await bus.createRecord(DEFAULT_TABLES.agentCards, {
      Cap_ID: "CAP-mac-worker-agent",
      Node: "mac-worker",
      Worker: "claude",
      Skill_ID: "agent",
      Daemon_Version: "1.2.0",
      Receive_Mode: "event",
      Availability: "online",
      Dispatchable: "Yes",
      Admission: "admitted",
      Metadata: JSON.stringify({ kind: "host", mode: "agent" }),
    });
    const host = await apiJson(baseUrl, "/api/v1/admin/cards", {
      method: "POST",
      token: apiToken,
      body: { node: "mac-worker", worker: "claude", skill_id: "ops-check", description: "巡检" },
    });
    assert.equal(host.status, 409);
    assert.match(host.data.error, /commands\.json/);
    assert.deepEqual(host.data.snippet["ops-check"].workers, ["claude"]);
    assert.match(host.data.hint, /热重载/);

    const snippet = await apiJson(baseUrl, "/api/v1/admin/commands-snippet", {
      method: "POST",
      token: apiToken,
      body: { skill_id: "brief", command: "node briefing.js", mode: "json", name: "早报" },
    });
    assert.equal(snippet.status, 200);
    assert.equal(snippet.data.snippet.brief.mode, "json");

    const regSkill = await apiJson(baseUrl, "/api/v1/agents/register", {
      method: "POST",
      token: workerToken,
      body: {
        node: "grok-bot",
        role: "worker",
        caps: [{ skill_id: "echo", skill_name: "回声" }],
      },
    });
    assert.equal(regSkill.status, 200);
    const echoId = capIdOf("echo", {}, "grok-bot");
    const cannot = await apiJson(baseUrl, `/api/v1/admin/cards/${encodeURIComponent(echoId)}`, {
      method: "DELETE",
      token: apiToken,
    });
    assert.equal(cannot.status, 409);

    const removed = await apiJson(baseUrl, `/api/v1/admin/cards/${encodeURIComponent(created.data.card.cap_id)}`, {
      method: "DELETE",
      token: apiToken,
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.ok, true);
    const left = await bus.listRecords(DEFAULT_TABLES.agentCards);
    assert.equal(left.some((row) => f1(row, "Cap_ID") === created.data.card.cap_id), false);

    const hostDel = await apiJson(baseUrl, "/api/v1/admin/cards/CAP-mac-worker-agent", {
      method: "DELETE",
      token: apiToken,
    });
    assert.equal(hostDel.status, 409);

    await apiJson(baseUrl, `/api/v1/admin/cards/${encodeURIComponent(echoId)}/admission`, {
      method: "POST",
      token: apiToken,
      body: { admission: "rejected" },
    });
    const again = await apiJson(baseUrl, "/api/v1/agents/register", {
      method: "POST",
      token: workerToken,
      body: { node: "grok-bot", role: "worker", caps: [{ skill_id: "echo" }] },
    });
    assert.equal(again.status, 200);
    assert.equal(again.data.admission[echoId], "rejected");
    const after = (await bus.listRecords(DEFAULT_TABLES.agentCards)).filter((row) => f1(row, "Cap_ID") === echoId);
    assert.equal(after.length, 1);
    assert.equal(f1(after[0], "Admission"), "rejected");

    const leader = await apiJson(baseUrl, "/api/v1/admin/tokens/muse/rotate", {
      method: "POST",
      token: apiToken,
      body: { role: "leader", scopes: ["admin"] },
    });
    assert.equal(leader.status, 200);
    const byLeader = await apiJson(baseUrl, "/api/v1/admin/cards", {
      method: "POST",
      token: leader.data.token,
      body: { node: "grok-bot", skill_id: "digest" },
    });
    assert.equal(byLeader.status, 201);
    const leaderDel = await apiJson(baseUrl, `/api/v1/admin/cards/${encodeURIComponent(byLeader.data.card.cap_id)}`, {
      method: "DELETE",
      token: leader.data.token,
    });
    assert.equal(leaderDel.status, 403);
    const workerPost = await apiJson(baseUrl, "/api/v1/admin/cards", {
      method: "POST",
      token: workerToken,
      body: { node: "grok-bot", skill_id: "nope" },
    });
    assert.equal(workerPost.status, 403);
  });
});

test("守护进程对账不删除、不改回已拒绝且不在 commands.json 里的名片", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
      echo: { desc: "回声" },
    }), { mode: 0o600 });
    const bus = new MockBus({ tables: DEFAULT_TABLES });
    await bus.createRecord(DEFAULT_TABLES.agentCards, {
      Cap_ID: "CAP-node-a-echo",
      Node: "node-a",
      Skill_ID: "echo",
      Dispatchable: "Yes",
      Availability: "online",
      Admission: "rejected",
    });
    await bus.createRecord(DEFAULT_TABLES.agentCards, {
      Cap_ID: "CAP-node-a-secret",
      Node: "node-a",
      Skill_ID: "secret",
      Dispatchable: "Yes",
      Availability: "online",
      Admission: "rejected",
    });
    const kernel = new Kernel({
      node: "node-a",
      role: "node",
      kind: "host",
      zone: "test",
      capPrefix: "node-a",
      events: false,
      configDir: dir,
      bus,
    });
    await kernel.reconcileCards();
    const cards = await bus.listRecords(DEFAULT_TABLES.agentCards);
    const echo = cards.find((row) => f1(row, "Cap_ID") === "CAP-node-a-echo");
    const secret = cards.find((row) => f1(row, "Cap_ID") === "CAP-node-a-secret");
    assert.ok(echo);
    assert.ok(secret);
    assert.equal(f1(echo, "Admission"), "rejected");
    assert.equal(f1(secret, "Admission"), "rejected");
    assert.equal(cards.filter((row) => f1(row, "Node") === "node-a" && f1(row, "Admission") === "rejected").length, 2);
  });
});
