// Webhook 门铃：落盘、HMAC、重试、去重、管理 API。fetch 全部注入，不访问真实网络。

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES, f1 } from "../src/bus/tables.mjs";
import { assertAgentRoute } from "../src/hub/agent-access.mjs";
import { AgentWebhookStore, validateWebhookUrl, WebhookDispatcher, webhookSignature } from "../src/hub/webhooks.mjs";
import { BROWSER_USER_AGENT } from "../src/kernel-util.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { LongPollBroker } from "../src/server/longpoll-broker.mjs";
import { withTemp } from "./helpers.mjs";

const FIXED_NOW = Date.parse("2026-04-01T00:00:00.000Z");

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

function signOf(secret, timestamp, rawBody) {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

test("URL 只允许不带用户信息的 http/https，且不超过 2048", () => {
  assert.equal(validateWebhookUrl(" https://hooks.example/a "), "https://hooks.example/a");
  assert.throws(() => validateWebhookUrl("ftp://hooks.example/a"), /http 或 https/);
  assert.throws(() => validateWebhookUrl("http://user:pass@hooks.example/a"), /用户名或密码/);
  assert.throws(() => validateWebhookUrl("http://user@hooks.example/a"), /用户名或密码/);
  assert.throws(() => validateWebhookUrl(""), /2048/);
  assert.throws(() => validateWebhookUrl(`https://hooks.example/${"a".repeat(2048)}`), /2048/);
});

test("存储：0600、列表不含 secret、轮换才换密钥", async () => {
  await withTemp(async (dir) => {
    const now = new Date("2026-04-01T00:00:00.000Z");
    const store = new AgentWebhookStore(dir, { now: () => now });
    const created = store.put({ node: "grok-bot", url: "https://hooks.example/in" });
    assert.match(created.secret, /^whsec_/);
    const file = path.join(dir, "agent_webhooks.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const raw = fs.readFileSync(file, "utf8");
    assert.equal(raw.includes(created.secret), true);
    assert.equal(JSON.stringify(store.listPublic()).includes(created.secret), false);
    assert.equal(store.listPublic()[0].url, "https://hooks.example/in");
    assert.equal(store.listPublic()[0].last_status, "");

    const renamed = store.put({ node: "grok-bot", url: "https://hooks.example/new" });
    assert.equal(renamed.secret, null);
    assert.equal(store.get("grok-bot").secret, created.secret);
    assert.equal(store.get("grok-bot").created_at, created.hook.created_at);

    const rotated = store.put({ node: "grok-bot", url: "https://hooks.example/new", rotate: true });
    assert.match(rotated.secret, /^whsec_/);
    assert.notEqual(rotated.secret, created.secret);
    assert.equal(store.get("grok-bot").secret, rotated.secret);
    assert.equal(store.remove("grok-bot"), true);
    assert.equal(store.remove("grok-bot"), false);
    assert.equal(store.get("grok-bot"), null);
  });
});

test("签名、门铃不含正文、失败重试、成功去重、working 不推", async () => {
  await withTemp(async (dir) => {
    const store = new AgentWebhookStore(dir, { now: () => new Date(FIXED_NOW) });
    const worker = store.put({ node: "worker-1", url: "https://worker.example/hook" });
    const leader = store.put({ node: "leader-1", url: "https://leader.example/hook" });
    const calls = [];
    const sleeps = [];
    const logs = [];
    let failTimes = 2;
    const dispatcher = new WebhookDispatcher({
      store,
      hubNode: "hub-a",
      taskTable: "tasks",
      now: () => FIXED_NOW,
      sleep: async (ms) => { sleeps.push(ms); },
      log: (line) => logs.push(line),
      fetchImpl: async (_url, opts) => {
        calls.push(opts);
        if (failTimes > 0) {
          failTimes -= 1;
          return { status: 500, ok: false };
        }
        return { status: 204, ok: true };
      },
    });

    const assigned = {
      table: "tasks",
      seq: 7,
      fields: {
        Task_ID: "T-1",
        Target_Node: "worker-1",
        From_Node: "leader-1",
        Status: "submitted",
        Title: "SECRET-INSTRUCTION",
        Text: "do not leak the body",
      },
    };
    const first = await dispatcher.onBusEvent(assigned);
    assert.equal(first.ok, true);
    assert.equal(first.status, 204);
    assert.deepEqual(sleeps, [1000, 3000]);
    assert.equal(calls.length, 3);

    const raw = calls[0].body;
    const payload = JSON.parse(raw);
    assert.deepEqual(Object.keys(payload).sort(), ["at", "event", "hub", "node", "seq", "status", "task_id"]);
    assert.equal(payload.event, "task.assigned");
    assert.equal(payload.node, "worker-1");
    assert.equal(payload.task_id, "T-1");
    assert.equal(payload.status, "submitted");
    assert.equal(payload.seq, 7);
    assert.equal(payload.hub, "hub-a");
    assert.equal(raw.includes("SECRET-INSTRUCTION"), false);
    assert.equal(raw.includes("do not leak"), false);
    assert.equal(calls[0].headers["Content-Type"], "application/json");
    assert.equal(calls[0].headers["User-Agent"], BROWSER_USER_AGENT);
    assert.equal(calls[0].headers["X-A2A-Event"], "task.assigned");
    assert.match(calls[0].headers["X-A2A-Delivery"], /^[0-9a-f-]{36}$/);
    const ts = calls[0].headers["X-A2A-Timestamp"];
    assert.equal(calls[0].headers["X-A2A-Signature"], `sha256=${signOf(worker.secret, ts, raw)}`);
    assert.equal(webhookSignature(worker.secret, ts, raw), signOf(worker.secret, ts, raw));
    assert.notEqual(signOf("wrong-secret", ts, raw), webhookSignature(worker.secret, ts, raw));
    assert.equal(calls.every((c) => c.headers["X-A2A-Signature"].endsWith(signOf(worker.secret, c.headers["X-A2A-Timestamp"], c.body))), true);
    assert.equal(logs.join("\n").includes(worker.secret), false);

    const again = await dispatcher.onBusEvent({ ...assigned, seq: 8 });
    assert.equal(again, null);
    assert.equal(calls.length, 3);

    const working = await dispatcher.onBusEvent({
      table: "tasks",
      seq: 9,
      fields: { Task_ID: "T-1", Target_Node: "worker-1", From_Node: "leader-1", Status: "working" },
    });
    assert.equal(working, null);
    assert.equal(calls.length, 3);

    const updated = await dispatcher.onBusEvent({
      table: "tasks",
      seq: 10,
      fields: {
        Task_ID: "T-1",
        Target_Node: "worker-1",
        From_Node: "leader-1",
        Status: "completed",
        Title: "SECRET-INSTRUCTION",
      },
    });
    assert.equal(updated.ok, true);
    const leaderBody = JSON.parse(calls.at(-1).body);
    assert.equal(leaderBody.event, "task.updated");
    assert.equal(leaderBody.node, "leader-1");
    assert.equal(leaderBody.status, "completed");
    assert.equal(leaderBody.task_id, "T-1");
    assert.equal(calls.at(-1).body.includes("SECRET-INSTRUCTION"), false);
    assert.equal(calls.at(-1).headers["X-A2A-Signature"], `sha256=${signOf(leader.secret, calls.at(-1).headers["X-A2A-Timestamp"], calls.at(-1).body)}`);

    const pub = store.listPublic().find((h) => h.node === "worker-1");
    assert.equal(pub.last_status, "204");
    assert.equal(pub.last_error, "");
    assert.equal(pub.last_delivered_at, "2026-04-01T00:00:00.000Z");
  });
});

test("四次失败后放弃，last_status 与 last_error 留下，不再投递同一状态", async () => {
  await withTemp(async (dir) => {
    const store = new AgentWebhookStore(dir);
    store.put({ node: "worker-1", url: "https://worker.example/hook" });
    const sleeps = [];
    let n = 0;
    const dispatcher = new WebhookDispatcher({
      store,
      sleep: async (ms) => { sleeps.push(ms); },
      fetchImpl: async () => {
        n += 1;
        const err = new Error("socket hang up");
        throw err;
      },
    });
    const ev = {
      table: "tasks",
      seq: 1,
      fields: { Task_ID: "T-9", Target_Node: "worker-1", From_Node: "leader-1", Status: "submitted", Title: "nope" },
    };
    const result = await dispatcher.onBusEvent(ev);
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.equal(result.error, "socket hang up");
    assert.equal(n, 4);
    assert.deepEqual(sleeps, [1000, 3000, 8000]);
    const pub = store.listPublic()[0];
    assert.equal(pub.last_status, "error");
    assert.equal(pub.last_error, "socket hang up");
    assert.equal(pub.last_delivered_at, "");
    assert.equal(await dispatcher.onBusEvent(ev), null);
    assert.equal(n, 4);
  });
});

test("单次超时按失败重试", async () => {
  await withTemp(async (dir) => {
    const store = new AgentWebhookStore(dir);
    store.put({ node: "worker-1", url: "https://worker.example/hook" });
    let n = 0;
    const dispatcher = new WebhookDispatcher({
      store,
      timeoutMs: 30,
      retryDelays: [0, 0],
      sleep: async () => {},
      fetchImpl: (_url, opts) => new Promise((_resolve, reject) => {
        n += 1;
        opts.signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted due to timeout");
          err.name = "TimeoutError";
          reject(err);
        });
      }),
    });
    const result = await dispatcher.ping("worker-1");
    assert.equal(n, 2);
    assert.equal(result.ok, false);
    assert.equal(result.error, "timeout");
    assert.equal(store.listPublic()[0].last_status, "error");
    assert.equal(store.listPublic()[0].last_error, "timeout");
  });
});

test("没有登记 Webhook 的节点不推送；非任务表不推送", async () => {
  await withTemp(async (dir) => {
    const store = new AgentWebhookStore(dir);
    let n = 0;
    const dispatcher = new WebhookDispatcher({
      store,
      fetchImpl: async () => { n += 1; return { status: 200 }; },
    });
    assert.equal(await dispatcher.onBusEvent({
      table: "tasks",
      seq: 1,
      fields: { Task_ID: "T", Target_Node: "missing", Status: "submitted" },
    }), null);
    assert.equal(await dispatcher.onBusEvent({
      table: "messages",
      seq: 2,
      fields: { Task_ID: "T", Target_Node: "missing", Status: "submitted" },
    }), null);
    assert.equal(n, 0);
    const ping = await dispatcher.ping("missing");
    assert.equal(ping.missing, true);
  });
});

test("SqliteBus：attachNotifier 仍是替换，addListener 追加，一边抛错不挡住另一边", async () => {
  const bus = new SqliteBus({ dbPath: ":memory:", tables: DEFAULT_TABLES });
  try {
    const seen = [];
    bus.attachNotifier({
      onBusEvent() { throw new Error("notifier down"); },
    });
    bus.addListener({ onBusEvent(ev) { seen.push(ev.op); } });
    await bus.createRecord(DEFAULT_TABLES.tasks, { Task_ID: "T", Status: "submitted" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(seen, ["create"]);

    const replaced = [];
    bus.attachNotifier({ onBusEvent() { replaced.push("new"); } });
    await bus.createRecord(DEFAULT_TABLES.tasks, { Task_ID: "T2", Status: "submitted" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(replaced, ["new"]);
    assert.deepEqual(seen, ["create", "create"]);
  } finally {
    bus.close();
  }
});

test("总线上的 submitted 会打到已挂上的 Dispatcher，同一条门铃不含正文", async () => {
  await withTemp(async (dir) => {
    const store = new AgentWebhookStore(dir);
    const saved = store.put({ node: "worker-1", url: "https://worker.example/hook" });
    let captured = null;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const dispatcher = new WebhookDispatcher({
      store,
      hubNode: "hub-a",
      taskTable: DEFAULT_TABLES.tasks,
      sleep: async () => {},
      fetchImpl: async (_url, opts) => {
        captured = opts;
        release();
        return { status: 200 };
      },
    });
    const bus = new SqliteBus({ dbPath: ":memory:", tables: DEFAULT_TABLES });
    bus.addListener(dispatcher);
    try {
      await bus.createRecord(DEFAULT_TABLES.tasks, {
        Task_ID: "T-bus",
        Target_Node: "worker-1",
        From_Node: "leader-1",
        Status: "submitted",
        Title: "SECRET-INSTRUCTION",
      });
      await gate;
    } finally {
      bus.close();
    }
    const body = JSON.parse(captured.body);
    assert.equal(body.event, "task.assigned");
    assert.equal(body.task_id, "T-bus");
    assert.equal(captured.body.includes("SECRET-INSTRUCTION"), false);
    const ts = captured.headers["X-A2A-Timestamp"];
    assert.equal(captured.headers["X-A2A-Signature"], `sha256=${webhookSignature(saved.secret, ts, captured.body)}`);
  });
});

test("管理 API：登记、列表无密钥、测试、轮换、删除 Agent 顺带删除", async () => {
  await withTemp(async (rootDir) => {
    const hubDir = path.join(rootDir, "hub");
    fs.mkdirSync(hubDir, { recursive: true });
    const calls = [];
    const store = new AgentWebhookStore(hubDir);
    const dispatcher = new WebhookDispatcher({
      store,
      hubNode: "mac-mini-hub",
      fetchImpl: async (_url, opts) => {
        calls.push(opts);
        return { status: 202 };
      },
      sleep: async () => {},
    });
    const broker = new LongPollBroker({ initialSeq: 0 });
    const bus = new SqliteBus({ dbPath: path.join(hubDir, "hub.db"), tables: DEFAULT_TABLES, broker });
    const httpHandle = await startHubHttpServer({
      cfg: {
        node: "mac-mini-hub",
        configDir: hubDir,
        listen: "127.0.0.1:0",
        apiToken: "owner-token",
      },
      bus,
      broker,
      log: () => {},
      webhookDispatcher: dispatcher,
    });
    const base = httpHandle.localUrl;
    try {
      assert.throws(
        () => assertAgentRoute(
          { kind: "agent", node: "muse", role: "leader", scopes: ["admin"] },
          { method: "GET", pathname: "/api/v1/admin/webhooks", searchParams: new URLSearchParams(), headers: {} },
        ),
        (err) => err.status === 403 && /Webhook/.test(err.message),
      );

      const badReceive = await apiJson(base, "/api/v1/admin/agents", {
        method: "POST",
        token: "owner-token",
        body: { node: "grok-bot", access: "http", role: "worker", receive: "push" },
      });
      assert.equal(badReceive.status, 400);

      const missingUrl = await apiJson(base, "/api/v1/admin/agents", {
        method: "POST",
        token: "owner-token",
        body: { node: "grok-bot", access: "http", role: "worker", receive: "webhook" },
      });
      assert.equal(missingUrl.status, 400);

      const added = await apiJson(base, "/api/v1/admin/agents", {
        method: "POST",
        token: "owner-token",
        body: {
          node: "grok-bot",
          access: "http",
          role: "worker",
          receive: "webhook",
          webhook_url: "https://hooks.example/grok",
        },
      });
      assert.equal(added.status, 200);
      assert.equal(added.data.card.receive_mode, "webhook");
      assert.match(added.data.webhook.secret, /^whsec_/);
      assert.equal(added.data.webhook.url, "https://hooks.example/grok");
      assert.equal(added.data.onboarding.prompt.split(added.data.webhook.secret).length - 1, 1);
      assert.match(added.data.onboarding.prompt, /"receive_mode":"webhook"/);
      const cards = await bus.listRecords(DEFAULT_TABLES.agentCards);
      const meta = JSON.parse(f1(cards.find((c) => f1(c, "Node") === "grok-bot"), "Metadata"));
      assert.equal(meta.mode, "webhook");

      const listed = await apiJson(base, "/api/v1/admin/webhooks", { token: "owner-token" });
      assert.equal(listed.status, 200);
      assert.equal(listed.data.webhooks.length, 1);
      assert.equal(JSON.stringify(listed.data).includes(added.data.webhook.secret), false);

      const asAgent = await apiJson(base, "/api/v1/admin/webhooks", { token: added.data.token });
      assert.equal(asAgent.status, 403);

      const tested = await apiJson(base, "/api/v1/admin/webhooks/grok-bot/test", {
        method: "POST",
        token: "owner-token",
      });
      assert.equal(tested.status, 200);
      assert.deepEqual(tested.data, { ok: true, status: 202, error: "" });
      const ping = JSON.parse(calls[0].body);
      assert.equal(ping.event, "ping");
      assert.equal(ping.node, "grok-bot");
      assert.equal(ping.task_id, "");
      assert.equal(ping.hub, "mac-mini-hub");
      assert.equal(calls[0].body.includes(added.data.webhook.secret), false);

      const afterTest = await apiJson(base, "/api/v1/admin/webhooks", { token: "owner-token" });
      assert.equal(afterTest.data.webhooks[0].last_status, "202");

      const keep = await apiJson(base, "/api/v1/admin/webhooks/grok-bot", {
        method: "PUT",
        token: "owner-token",
        body: { url: "https://hooks.example/grok-2" },
      });
      assert.equal(keep.status, 200);
      assert.equal(keep.data.webhook.secret, undefined);
      assert.equal(keep.data.webhook.url, "https://hooks.example/grok-2");
      assert.equal(store.get("grok-bot").secret, added.data.webhook.secret);

      const rotated = await apiJson(base, "/api/v1/admin/webhooks/grok-bot", {
        method: "PUT",
        token: "owner-token",
        body: { url: "https://hooks.example/grok-2", rotate_secret: true },
      });
      assert.match(rotated.data.webhook.secret, /^whsec_/);
      assert.notEqual(rotated.data.webhook.secret, added.data.webhook.secret);

      const badRotate = await apiJson(base, "/api/v1/admin/webhooks/grok-bot", {
        method: "PUT",
        token: "owner-token",
        body: { url: "https://hooks.example/grok-2", rotate_secret: "yes" },
      });
      assert.equal(badRotate.status, 400);

      const longpoll = await apiJson(base, "/api/v1/admin/agents", {
        method: "POST",
        token: "owner-token",
        body: { node: "stay-up", access: "http", role: "worker", receive: "longpoll" },
      });
      assert.equal(longpoll.status, 200);
      assert.equal(longpoll.data.card.receive_mode, "http-longpoll");
      assert.equal(longpoll.data.webhook, undefined);
      assert.match(longpoll.data.onboarding.prompt, /"receive_mode":"http-longpoll"/);

      const host = await apiJson(base, "/api/v1/admin/agents", {
        method: "POST",
        token: "owner-token",
        body: { node: "mac-host", access: "host", role: "worker", receive: "webhook", webhook_url: "https://hooks.example/ignored" },
      });
      assert.equal(host.status, 200);
      assert.equal(host.data.webhook, undefined);
      assert.match(host.data.onboarding.prompt, /节点 → 待接纳/);
      assert.equal(store.get("mac-host"), null);

      const ob = await apiJson(base, "/api/v1/admin/onboarding?node=fresh&access=http&role=worker&receive=webhook", {
        token: "owner-token",
      });
      assert.equal(ob.status, 200);
      assert.match(ob.data.onboarding.prompt, /"receive_mode":"webhook"/);
      assert.equal(ob.data.onboarding.prompt.includes("这一次的明文 Webhook 密钥"), false);

      const badOb = await apiJson(base, "/api/v1/admin/onboarding?node=fresh&access=http&role=worker&receive=nope", {
        token: "owner-token",
      });
      assert.equal(badOb.status, 400);

      const removed = await apiJson(base, "/api/v1/admin/agents/grok-bot", {
        method: "DELETE",
        token: "owner-token",
      });
      assert.equal(removed.status, 200);
      assert.equal(removed.data.webhookRemoved, true);
      assert.equal(store.get("grok-bot"), null);

      const gone = await apiJson(base, "/api/v1/admin/webhooks/grok-bot/test", {
        method: "POST",
        token: "owner-token",
      });
      assert.equal(gone.status, 404);

      const onlyHook = await apiJson(base, "/api/v1/admin/webhooks/solo", {
        method: "PUT",
        token: "owner-token",
        body: { url: "https://hooks.example/solo" },
      });
      assert.match(onlyHook.data.webhook.secret, /^whsec_/);
      const delSolo = await apiJson(base, "/api/v1/admin/webhooks/solo", {
        method: "DELETE",
        token: "owner-token",
      });
      assert.deepEqual(delSolo.data, { ok: true });
      const delAgain = await apiJson(base, "/api/v1/admin/webhooks/solo", {
        method: "DELETE",
        token: "owner-token",
      });
      assert.equal(delAgain.status, 404);
    } finally {
      await httpHandle.close();
      bus.close();
    }
  });
});
