// HttpBus 出站请求带浏览器 UA：Hub 在 Cloudflare 之后时，node 默认 UA 会被 403 / 1010 拦截。

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { HttpBus } from "../src/bus/http-bus.mjs";
import { DEFAULT_TABLES } from "../src/bus/tables.mjs";
import { BROWSER_USER_AGENT } from "../src/kernel-util.mjs";

test("HttpBus 的表读写与长轮询都带浏览器 User-Agent", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers["user-agent"]);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url.startsWith("/api/v1/poll") ? '{"wake":false,"cursor":0,"events":[]}' : '{"items":[]}');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const bus = new HttpBus({ hubUrl: `http://127.0.0.1:${server.address().port}`, apiToken: "t", node: "n1", tables: DEFAULT_TABLES, log: () => {} });
    await bus.listRecords(bus.tables.tasks);
    await bus.waitForChanges({ node: "n1", cursor: 0, timeoutSec: 0 });
    assert.equal(seen.length, 2);
    for (const ua of seen) assert.equal(ua, BROWSER_USER_AGENT);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
