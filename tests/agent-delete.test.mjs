// 删除 Agent：清名片、吊销 Token、名册即时消失、Hub 本机与 Agent 身份不可删。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES, f1 } from "../src/bus/tables.mjs";
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

test("删除 Agent：名片删除、Token 吊销、名册消失，重复删除 404", async () => {
  await withTemp(async (rootDir) => {
    const hubDir = path.join(rootDir, "hub");
    fs.mkdirSync(hubDir, { recursive: true });
    const apiToken = "owner-token-0123456789abcdef";
    const broker = new LongPollBroker({ initialSeq: 0 });
    const bus = new SqliteBus({ dbPath: path.join(hubDir, "hub.db"), tables: DEFAULT_TABLES, broker });
    const http = await startHubHttpServer({
      cfg: { node: "mac-mini-hub", configDir: hubDir, listen: "127.0.0.1:0", apiToken },
      bus,
      broker,
      log: () => {},
      onWake: () => {},
    });
    const base = http.localUrl;
    try {
      const added = await apiJson(base, "/api/v1/admin/agents", {
        method: "POST",
        token: apiToken,
        body: { node: "grok-bot", access: "http", role: "worker", display_name: "Grok Bot" },
      });
      assert.equal(added.status, 200);
      const agentToken = added.data.token;
      assert.ok(agentToken);

      const polled = await apiJson(base, "/api/v1/agents/grok-bot/poll?timeout=0", { token: agentToken });
      assert.equal(polled.status, 200);
      assert.ok(broker.connectedNodes().some((n) => n.node === "grok-bot"));

      const byAgent = await apiJson(base, "/api/v1/admin/agents/grok-bot", { method: "DELETE", token: agentToken });
      assert.equal(byAgent.status, 403);

      const hubSelf = await apiJson(base, "/api/v1/admin/agents/mac-mini-hub", { method: "DELETE", token: apiToken });
      assert.equal(hubSelf.status, 400);

      const del = await apiJson(base, "/api/v1/admin/agents/grok-bot", { method: "DELETE", token: apiToken });
      assert.equal(del.status, 200);
      assert.equal(del.data.cardsRemoved, 1);
      assert.equal(del.data.tokenRevoked, true);
      assert.equal(del.data.openTasks, 0);

      const cards = await bus.listRecords(bus.tables.agentCards);
      assert.equal(cards.some((c) => f1(c, "Node") === "grok-bot"), false);
      assert.equal(broker.connectedNodes().some((n) => n.node === "grok-bot"), false);

      const roster = await apiJson(base, "/api/v1/agents", { token: apiToken });
      assert.equal(roster.status, 200);
      assert.equal(JSON.stringify(roster.data).includes("grok-bot"), false);

      const afterRevoke = await apiJson(base, "/api/v1/agents/grok-bot/poll?timeout=0", { token: agentToken });
      assert.equal(afterRevoke.status, 401);

      const again = await apiJson(base, "/api/v1/admin/agents/grok-bot", { method: "DELETE", token: apiToken });
      assert.equal(again.status, 404);
    } finally {
      await http.close();
      bus.close();
    }
  });
});

test("SqliteBus.deleteRecord 推进 seq 并发布 delete 事件，缺行时报错", async () => {
  const broker = new LongPollBroker({ initialSeq: 0 });
  const bus = new SqliteBus({ tables: DEFAULT_TABLES, broker });
  try {
    const { record } = await bus.createRecord(bus.tables.agentCards, { Cap_ID: "CAP-x-agent", Node: "x" });
    const before = bus.currentSeq();
    await bus.deleteRecord(bus.tables.agentCards, record.record_id);
    assert.equal(bus.currentSeq(), before + 1);
    assert.equal(await bus.getRecord(bus.tables.agentCards, record.record_id), null);
    const r = await broker.wait({ node: "x", cursor: before, timeoutMs: 0 });
    assert.equal(r.events.at(-1).op, "delete");
    await assert.rejects(() => bus.deleteRecord(bus.tables.agentCards, record.record_id), /record not found/);
  } finally {
    bus.close();
  }
});
