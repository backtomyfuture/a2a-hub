// 接收方式在添加时选定。非 webhook 节点不能登记推送，register 不覆盖机主已配的 Webhook。

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

test("Webhook 门闩、register 不覆盖、删除配置回到定时检查", async () => {
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

      const host = await apiJson(base, "/api/v1/admin/webhooks/mac-host", {
        method: "PUT",
        token: "owner-token",
        body: { url: "https://hooks.example/host", key: "receiver-key-host" },
      });
      assert.equal(host.status, 409);
      assert.match(host.data.error, /该节点的接收方式不是 Webhook/);
      assert.equal(fs.existsSync(path.join(hubDir, "agent_webhooks.json")), false);

      const added = await apiJson(base, "/api/v1/admin/agents", {
        method: "POST",
        token: "owner-token",
        body: {
          node: "bot",
          access: "http",
          role: "worker",
          receive: "webhook",
          webhook_url: "https://hooks.example/bot",
          webhook_key: "receiver-key-bot",
        },
      });
      assert.equal(added.status, 200);
      assert.equal(added.data.card.receive_mode, "webhook");
      assert.equal(added.data.webhook.secret, undefined);
      assert.equal(added.data.webhook.url, "https://hooks.example/bot");
      assert.equal(added.data.onboarding.prompt.includes("receiver-key-bot"), false);

      const extra = await apiJson(base, "/api/v1/admin/cards", {
        method: "POST",
        token: "owner-token",
        body: { node: "bot", skill_id: "translate", skill_name: "翻译" },
      });
      assert.equal(extra.status, 201);
      let modes = modesOf(await bus.listRecords(DEFAULT_TABLES.agentCards), "bot");
      assert.equal(modes.length, 2);
      assert.deepEqual([...new Set(modes.map((row) => row.receive))], ["webhook"]);

      const noKey = await apiJson(base, "/api/v1/admin/agents", {
        method: "POST",
        token: "owner-token",
        body: { node: "nokey", access: "http", role: "worker", receive: "webhook", webhook_url: "https://hooks.example/nokey" },
      });
      assert.equal(noKey.status, 400);
      assert.match(noKey.data.error, /请填写对方提供的密钥/);

      const renamed = await apiJson(base, "/api/v1/admin/webhooks/bot", {
        method: "PUT",
        token: "owner-token",
        body: { url: "https://hooks.example/bot-3" },
      });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.data.webhook.secret, undefined);
      assert.equal(JSON.parse(fs.readFileSync(path.join(hubDir, "agent_webhooks.json"), "utf8")).hooks.find((hook) => hook.node === "bot").secret, "receiver-key-bot");

      const timer = await apiJson(base, "/api/v1/admin/agents", {
        method: "POST",
        token: "owner-token",
        body: { node: "timer", access: "http", role: "leader", receive: "poll" },
      });
      assert.equal(timer.status, 200);
      assert.equal(timer.data.card.dispatchable, "Yes");
      assert.equal(timer.data.card.role, "leader");
      const blocked = await apiJson(base, "/api/v1/admin/webhooks/timer", {
        method: "PUT",
        token: "owner-token",
        body: { url: "https://hooks.example/timer", key: "receiver-key-timer" },
      });
      assert.equal(blocked.status, 409);
      assert.match(blocked.data.error, /该节点的接收方式不是 Webhook/);

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

      const warned = await apiJson(base, "/api/v1/agents/register", {
        method: "POST",
        token: "owner-token",
        body: { node: "lonely", role: "worker", receive_mode: "webhook" },
      });
      assert.equal(warned.status, 200);
      assert.equal(warned.data.receive_mode, "http-poll");
      assert.equal(warned.data.warning, "Webhook 需机主在控制台开启");

      assert.throws(
        () => assertAgentRoute(
          { kind: "agent", node: "bot", role: "worker", scopes: [] },
          { method: "POST", pathname: "/api/v1/admin/nodes/bot/receive", searchParams: new URLSearchParams(), headers: {} },
        ),
        (err) => err.status === 403,
      );
      const asAgent = await apiJson(base, "/api/v1/admin/webhooks/bot", {
        method: "PUT",
        token: added.data.token,
        body: { url: "https://hooks.example/stolen", key: "nope" },
      });
      assert.equal(asAgent.status, 403);

      const removed = await apiJson(base, "/api/v1/admin/webhooks/bot", {
        method: "DELETE",
        token: "owner-token",
      });
      assert.deepEqual(removed.data, { ok: true });
      modes = modesOf(await bus.listRecords(DEFAULT_TABLES.agentCards), "bot");
      assert.deepEqual([...new Set(modes.map((row) => row.receive))], ["http-poll"]);
      const afterDelete = JSON.parse(fs.readFileSync(path.join(hubDir, "agent_webhooks.json"), "utf8"));
      assert.equal(afterDelete.hooks.some((hook) => hook.node === "bot"), false);
    } finally {
      await httpHandle.close();
      bus.close();
    }
  });
});
