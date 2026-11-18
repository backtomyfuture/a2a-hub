// 接收方式是节点级三选一：切换接口、Webhook 门闩、register 不再覆盖机主配置。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES, f1 } from "../src/bus/tables.mjs";
import { assertAgentRoute } from "../src/hub/agent-access.mjs";
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

function modesOf(cards, node) {
  return cards
    .filter((card) => f1(card, "Node") === node)
    .map((card) => ({
      cap: f1(card, "Cap_ID"),
      receive: f1(card, "Receive_Mode"),
      mode: JSON.parse(f1(card, "Metadata") || "{}").mode,
    }));
}

test("切换接收方式、Webhook 门闩、register 不覆盖、Agent 403", async () => {
  await withTemp(async (rootDir) => {
    const hubDir = path.join(rootDir, "hub");
    fs.mkdirSync(hubDir, { recursive: true });
    const broker = new LongPollBroker({ initialSeq: 0 });
    const bus = new SqliteBus({ dbPath: path.join(hubDir, "hub.db"), tables: DEFAULT_TABLES, broker });
    const httpHandle = await startHubHttpServer({
      cfg: {
        node: "mac-mini-hub",
        configDir: hubDir,
        listen: "127.0.0.1:0",
        apiToken: "owner-token",
        publicUrl: "https://hub.example",
      },
      bus,
      broker,
      log: () => {},
    });
    const base = httpHandle.localUrl;
    try {
      await bus.createRecord(DEFAULT_TABLES.agentCards, {
        Cap_ID: "CAP-mac-host-echo",
        Node: "mac-host",
        Worker: "",
        Skill_ID: "echo",
        Skill_Name: "Echo",
        Receive_Mode: "event",
        Availability: "online",
        Dispatchable: "Yes",
        Admission: "admitted",
        Daemon_Version: "node-1.0.0",
        Metadata: JSON.stringify({ kind: "host", role: "worker", mode: "event" }),
      });

      const host = await apiJson(base, "/api/v1/admin/nodes/mac-host/receive", {
        method: "POST",
        token: "owner-token",
        body: { receive: "webhook", webhook_url: "https://hooks.example/host" },
      });
      assert.equal(host.status, 409);
      assert.match(host.data.error, /宿主节点由 ah daemon 常驻长连接/);
      assert.equal(fs.existsSync(path.join(hubDir, "agent_webhooks.json")), false);

      const missing = await apiJson(base, "/api/v1/admin/nodes/no-such/receive", {
        method: "POST",
        token: "owner-token",
        body: { receive: "poll" },
      });
      assert.equal(missing.status, 409);

      const added = await apiJson(base, "/api/v1/admin/agents", {
        method: "POST",
        token: "owner-token",
        body: { node: "bot", access: "http", role: "worker", receive: "poll" },
      });
      assert.equal(added.status, 200);
      assert.equal(added.data.card.receive_mode, "http-poll");

      const extra = await apiJson(base, "/api/v1/admin/cards", {
        method: "POST",
        token: "owner-token",
        body: { node: "bot", skill_id: "translate", skill_name: "翻译" },
      });
      assert.equal(extra.status, 201);

      const toLong = await apiJson(base, "/api/v1/admin/nodes/bot/receive", {
        method: "POST",
        token: "owner-token",
        body: { receive: "longpoll" },
      });
      assert.equal(toLong.status, 200);
      assert.equal(toLong.data.receive, "longpoll");
      assert.equal(toLong.data.receive_mode, "http-longpoll");
      assert.equal(toLong.data.cards_updated, 2);
      assert.equal(toLong.data.webhook, undefined);
      assert.match(toLong.data.onboarding.prompt, /"receive_mode":"http-longpoll"/);
      assert.equal(toLong.data.onboarding.prompt.includes("http-poll"), false);
      let modes = modesOf(await bus.listRecords(DEFAULT_TABLES.agentCards), "bot");
      assert.equal(modes.length, 2);
      assert.deepEqual(modes.map((row) => row.receive), ["http-longpoll", "http-longpoll"]);
      assert.deepEqual(modes.map((row) => row.mode), ["http-longpoll", "http-longpoll"]);

      const noUrl = await apiJson(base, "/api/v1/admin/nodes/bot/receive", {
        method: "POST",
        token: "owner-token",
        body: { receive: "webhook" },
      });
      assert.equal(noUrl.status, 400);

      const toHook = await apiJson(base, "/api/v1/admin/nodes/bot/receive", {
        method: "POST",
        token: "owner-token",
        body: { receive: "webhook", webhook_url: "https://hooks.example/bot" },
      });
      assert.equal(toHook.status, 200);
      assert.equal(toHook.data.receive_mode, "webhook");
      assert.equal(toHook.data.cards_updated, 2);
      assert.match(toHook.data.webhook.secret, /^whsec_/);
      assert.equal(toHook.data.webhook.url, "https://hooks.example/bot");
      assert.equal(toHook.data.onboarding.prompt.split(toHook.data.webhook.secret).length - 1, 1);
      assert.match(toHook.data.onboarding.prompt, /"receive_mode":"webhook"/);
      const secretOnce = toHook.data.webhook.secret;

      const again = await apiJson(base, "/api/v1/admin/nodes/bot/receive", {
        method: "POST",
        token: "owner-token",
        body: { receive: "webhook", webhook_url: "https://hooks.example/bot-2" },
      });
      assert.equal(again.status, 200);
      assert.equal(again.data.webhook.secret, undefined);
      assert.equal(again.data.webhook.url, "https://hooks.example/bot-2");
      assert.equal(again.data.cards_updated, 0);
      const stored = JSON.parse(fs.readFileSync(path.join(hubDir, "agent_webhooks.json"), "utf8"));
      assert.equal(stored.hooks.find((hook) => hook.node === "bot").secret, secretOnce);
      assert.equal(stored.hooks.find((hook) => hook.node === "bot").url, "https://hooks.example/bot-2");

      const renamed = await apiJson(base, "/api/v1/admin/webhooks/bot", {
        method: "PUT",
        token: "owner-token",
        body: { url: "https://hooks.example/bot-3" },
      });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.data.webhook.secret, undefined);

      const timer = await apiJson(base, "/api/v1/admin/agents", {
        method: "POST",
        token: "owner-token",
        body: { node: "timer", access: "http", role: "leader", receive: "poll" },
      });
      assert.equal(timer.status, 200);
      const blocked = await apiJson(base, "/api/v1/admin/webhooks/timer", {
        method: "PUT",
        token: "owner-token",
        body: { url: "https://hooks.example/timer" },
      });
      assert.equal(blocked.status, 409);
      assert.match(blocked.data.error, /先把接收方式切换成 Webhook/);

      const kept = await apiJson(base, "/api/v1/agents/register", {
        method: "POST",
        token: added.data.token,
        body: { node: "bot", role: "worker", receive_mode: "http-poll" },
      });
      assert.equal(kept.status, 200);
      assert.equal(kept.data.receive_mode, "webhook");
      assert.equal(kept.data.warning, undefined);
      modes = modesOf(await bus.listRecords(DEFAULT_TABLES.agentCards), "bot");
      assert.deepEqual([...new Set(modes.map((row) => row.receive))], ["webhook"]);
      assert.deepEqual([...new Set(modes.map((row) => row.mode))], ["webhook"]);

      const badMode = await apiJson(base, "/api/v1/agents/register", {
        method: "POST",
        token: "owner-token",
        body: { node: "bot", role: "worker", receive_mode: "push" },
      });
      assert.equal(badMode.status, 400);

      const warned = await apiJson(base, "/api/v1/agents/register", {
        method: "POST",
        token: "owner-token",
        body: { node: "lonely", role: "worker", receive_mode: "webhook" },
      });
      assert.equal(warned.status, 200);
      assert.equal(warned.data.receive_mode, "http-poll");
      assert.equal(warned.data.warning, "Webhook 需机主在控制台开启");
      const lonely = modesOf(await bus.listRecords(DEFAULT_TABLES.agentCards), "lonely");
      assert.deepEqual(lonely.map((row) => row.receive), ["http-poll"]);
      const afterWarn = JSON.parse(fs.readFileSync(path.join(hubDir, "agent_webhooks.json"), "utf8"));
      assert.equal(afterWarn.hooks.some((hook) => hook.node === "lonely"), false);

      assert.throws(
        () => assertAgentRoute(
          { kind: "agent", node: "bot", role: "leader", scopes: ["admin"] },
          { method: "POST", pathname: "/api/v1/admin/nodes/bot/receive", searchParams: new URLSearchParams(), headers: {} },
        ),
        (err) => err.status === 403 && /接收方式/.test(err.message),
      );
      const asAgent = await apiJson(base, "/api/v1/admin/nodes/bot/receive", {
        method: "POST",
        token: added.data.token,
        body: { receive: "poll" },
      });
      assert.equal(asAgent.status, 403);

      const removed = await apiJson(base, "/api/v1/admin/webhooks/bot", {
        method: "DELETE",
        token: "owner-token",
      });
      assert.deepEqual(removed.data, { ok: true });
      modes = modesOf(await bus.listRecords(DEFAULT_TABLES.agentCards), "bot");
      assert.deepEqual([...new Set(modes.map((row) => row.receive))], ["http-poll"]);
      assert.deepEqual([...new Set(modes.map((row) => row.mode))], ["http-poll"]);
      const afterDelete = JSON.parse(fs.readFileSync(path.join(hubDir, "agent_webhooks.json"), "utf8"));
      assert.equal(afterDelete.hooks.some((hook) => hook.node === "bot"), false);

      const toPoll = await apiJson(base, "/api/v1/admin/nodes/bot/receive", {
        method: "POST",
        token: "owner-token",
        body: { receive: "poll" },
      });
      assert.equal(toPoll.status, 200);
      assert.match(toPoll.data.onboarding.prompt, /"receive_mode":"http-poll"/);
      assert.equal(toPoll.data.onboarding.prompt.includes('"receive_mode":"webhook"'), false);
    } finally {
      await httpHandle.close();
      bus.close();
    }
  });
});
