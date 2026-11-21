import assert from "node:assert/strict";
import { getEventListeners, once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HerdrControl, HerdrEvents, discoverSocketPath, normalizeEventName } from "../src/herdr-socket.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const line = (value) => JSON.stringify(value) + "\n";
const backoff = { baseMs: 5, maxMs: 15, jitter: 0 };
async function withServer(handler, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-"));
  let requestSeen;
  const received = new Promise((resolve) => { requestSeen = resolve; });
  const socketPath = path.join(dir, "h.sock"), sockets = new Set(), requests = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "", handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      handled = true;
      const req = JSON.parse(buffer.split("\n")[0]);
      requests.push(req);
      handler(req, socket, requests.length);
      requestSeen(req);
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  try { await fn({ socketPath, requests, sockets, received }); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
}
function eventsAt(socketPath, extra = {}) { return new HerdrEvents({ socketPath, backoff, ackTimeoutMs: 250, connectTimeoutMs: 1000, ...extra }); }

for (const [label, response] of [
  ["missing id", () => ({ result: { type: "ok" } })],
  ["numeric id", () => ({ id: 1, result: { type: "ok" } })],
  ["empty success id", () => ({ id: "", result: { type: "ok" } })],
  ["array result", (r) => ({ id: r.id, result: [] })],
  ["missing result type", (r) => ({ id: r.id, result: {} })],
  ["numeric result type", (r) => ({ id: r.id, result: { type: 42 } })],
  ["result and error", (r) => ({ id: r.id, result: { type: "ok" }, error: { code: "timeout", message: "bad" } })],
  ["malformed error", (r) => ({ id: r.id, error: { message: "missing code" } })],
  ["empty error id except invalid_request", () => ({ id: "", error: { code: "agent_blocked", message: "wrong correlation" } })],
]) {
  test(`2A Control rejects ${label}`, async () => withServer((r, s) => s.end(line(response(r))), async ({ socketPath }) => {
    const c = new HerdrControl({ socketPath });
    try { await assert.rejects(c.call("test"), (e) => e.code === "protocol_error" && e.delivery === "unknown"); assert.equal(c.inflightCount, 0); }
    finally { c.close(); }
  }));
}

for (const terminated of [false, true]) {
  test(`2A byte bound applies ${terminated ? "with LF" : "without LF"}`, async () => withServer((r, s) => s.write(JSON.stringify({ id: r.id, result: { type: "ok", text: "中".repeat(100) } }) + (terminated ? "\n" : "")), async ({ socketPath }) => {
    const c = new HerdrControl({ socketPath, maxFrameBytes: 256, timeoutMs: 80 });
    try { await assert.rejects(c.call("test"), (e) => e.code === "protocol_error"); }
    finally { c.close(); }
  }));
}

test("2A rejects invalid UTF8 instead of accepting replacement characters", async () => withServer((r, s) => {
  s.end(Buffer.concat([Buffer.from(`{"id":"${r.id}","result":{"type":"ok","text":"`), Buffer.from([0xc3, 0x28]), Buffer.from('"}}\n')]));
}, async ({ socketPath }) => {
  const c = new HerdrControl({ socketPath });
  try { await assert.rejects(c.call("test"), (e) => e.code === "protocol_error"); } finally { c.close(); }
}));

test("2A valid CRLF with byte-split Chinese is preserved", async () => withServer((r, s) => {
  const bytes = Buffer.from(JSON.stringify({ id: r.id, result: { type: "ok", text: "中文验收" } }) + "\r\n");
  const cut = bytes.indexOf(Buffer.from("中")) + 1;
  s.write(bytes.subarray(0, cut)); setTimeout(() => s.end(bytes.subarray(cut)), 5);
}, async ({ socketPath }) => {
  const c = new HerdrControl({ socketPath });
  try { assert.equal((await c.call("test")).text, "中文验收"); } finally { c.close(); }
}));

test("2A params are objects, oversized/circular requests fail before connecting", async () => withServer((r, s) => s.end(line({ id: r.id, result: { type: "ok" } })), async ({ socketPath, requests }) => {
  const c = new HerdrControl({ socketPath, maxFrameBytes: 256 });
  try {
    for (const params of [null, [], "text", { text: "x".repeat(300) }]) await assert.rejects(c.call("test", params), (e) => e.local && e.delivery === "not_sent");
    const cyclic = {}; cyclic.self = cyclic;
    await assert.rejects(c.call("test", cyclic), (e) => e.delivery === "not_sent");
    assert.equal(c.inflightCount, 0);
    assert.equal(requests.length, 0);
  } finally { c.close(); }
}));

test("2A bounded inflight rejects excess without sending or leaking abort listeners", async () => withServer(() => {}, async ({ socketPath, requests, received }) => {
  const c = new HerdrControl({ socketPath, maxInflight: 1, timeoutMs: 1000 });
  const ac = new AbortController();
  const first = c.call("hang", {}, { signal: ac.signal });
  const firstError = first.catch((e) => e);
  try {
    await received;
    await assert.rejects(c.call("excess"), (e) => e.code === "client_overloaded" && e.delivery === "not_sent");
    ac.abort();
    const err = await firstError;
    assert.equal(err.delivery, "unknown");
    assert.equal(c.inflightCount, 0);
    assert.equal(getEventListeners(ac.signal, "abort").length, 0);
    assert.equal(requests.length, 1);
  } finally { c.close(); await firstError; }
}));

test("2A delivery unknown on timeout/disconnect never retries side effects", async () => {
  for (const mode of ["timeout", "disconnect", "abort", "close"]) {
    await withServer((_r, s) => { if (mode === "disconnect") s.destroy(); }, async ({ socketPath, requests, received }) => {
      const c = new HerdrControl({ socketPath, timeoutMs: 200 });
      const ac = new AbortController();
      const result = c.call("agent.prompt", { target: "a", text: "pointer" }, { signal: ac.signal }).catch((e) => e);
      if (["abort", "close"].includes(mode)) { await received; if (mode === "abort") ac.abort(); else c.close(); }
      try { const err = await result; assert.equal(err.delivery, "unknown", mode); assert.equal(c.inflightCount, 0); await delay(15); assert.equal(requests.length, 1); }
      finally { c.close(); }
    });
  }
  const c = new HerdrControl({ socketPath: path.join(os.tmpdir(), "missing-herdr-2a.sock") });
  try { await assert.rejects(c.call("ping"), (e) => e.delivery === "not_sent" && e.raw?.code === "ENOENT"); } finally { c.close(); }
});

test("2A Events ACK timeout diagnoses unknown delivery, then reconnects", async () => withServer((r, s, n) => {
  if (n > 1) s.write(line({ id: r.id, result: { type: "subscription_started" } }));
}, async ({ socketPath, requests }) => {
  const e = eventsAt(socketPath); const errors = [];
  e.on("subscribe_error", (err) => errors.push(err));
  try { await e.start(); assert.equal(requests.length, 2); assert.equal(errors[0]?.code, "timeout"); assert.equal(errors[0]?.delivery, "unknown"); }
  finally { e.stop(); }
}));

for (const [label, frame] of [
  ["event before ACK", () => ({ event: "pane.closed", data: { pane_id: "p" } })],
  ["wrong ACK id", () => ({ id: "other", result: { type: "subscription_started" } })],
  ["wrong error id", () => ({ id: "other", error: { code: "invalid_request", message: "not ours" } })],
]) {
  test(`2A Events barrier rejects ${label}`, async () => withServer((r, s) => s.write(line(frame(r))), async ({ socketPath }) => {
    const e = eventsAt(socketPath); const errors = [], seen = [];
    e.on("event", (v) => seen.push(v)); e.on("protocol_error", (err) => { errors.push(err); e.stop(); });
    try { await assert.rejects(e.start()); assert.equal(errors[0]?.code, "protocol_error"); assert.deepEqual(seen, []); }
    finally { e.stop(); }
  }));
}

test("2A ready is connection-local and generations increase after reconnect", async () => withServer((r, s) => s.write(line({ id: r.id, result: { type: "subscription_started" } })), async ({ socketPath, sockets }) => {
  const e = eventsAt(socketPath, { backoff: { baseMs: 40, maxMs: 40, jitter: 0 } });
  try {
    const first = await e.start(); assert.ok(Number.isInteger(first.generation)); assert.equal(e.generation, first.generation);
    const down = once(e, "disconnected"); const again = once(e, "reconnected");
    for (const s of sockets) s.destroy();
    await down; assert.equal(e.ready, false);
    const [next] = await again; assert.ok(next.generation > first.generation); assert.equal(e.ready, true);
  } finally { e.stop(); }
}));

test("2A stop from event listener fences coalesced and late old-socket callbacks", async (t) => {
  const clients = [], original = net.createConnection.bind(net);
  const mock = t.mock.method(net, "createConnection", (...args) => { const s = original(...args); clients.push(s); return s; });
  try { await withServer((r, s) => s.write(line({ id: r.id, result: { type: "subscription_started" } })), async ({ socketPath, sockets }) => {
    const e = eventsAt(socketPath); const seen = [], errors = [];
    e.on("event", (v) => { seen.push(v); e.stop(); }); e.on("protocol_error", (err) => errors.push(err));
    try {
      await e.start(); const oldData = clients[0].listeners("data")[0];
      const data = line({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p", workspace_id: "w" } });
      for (const s of sockets) s.write(data + data);
      await delay(20); oldData(data); assert.equal(seen.length, 1); assert.deepEqual(errors, []);
      await assert.rejects(e.start(), (err) => err.code === "connection_closed");
    } finally { e.stop(); }
  }); } finally { mock.mock.restore(); }
});

test("2A stop before start is terminal, not a hidden reconnect", async () => withServer((r, s) => s.write(line({ id: r.id, result: { type: "subscription_started" } })), async ({ socketPath, requests }) => {
  const e = eventsAt(socketPath); e.stop();
  try { await assert.rejects(e.start(), (err) => err.code === "connection_closed"); assert.equal(requests.length, 0); } finally { e.stop(); }
}));

test("2A refresh invalidates an outstanding asynchronous subscription provider", async () => withServer((r, s) => s.write(line({ id: r.id, result: { type: "subscription_started" } })), async ({ socketPath, requests }) => {
  let release, entered, calls = 0;
  const waiting = new Promise((r) => { entered = r; });
  const pending = new Promise((r) => { release = r; });
  const e = eventsAt(socketPath, { subscriptions: async () => { if (++calls === 1) { entered(); await pending; return [{ type: "pane.closed" }]; } return [{ type: "pane.moved" }]; } });
  try { const started = e.start(); await waiting; e.refresh(); release(); await started; assert.deepEqual(requests[0].params.subscriptions, [{ type: "pane.moved" }]); }
  finally { release(); e.stop(); }
}));

for (const malformed of ["invalid JSON", "oversized", "bad event data", "global type mismatch"]) {
  test(`2A Events ${malformed} invalidates rather than silently skipping`, async () => withServer((r, s) => s.write(line({ id: r.id, result: { type: "subscription_started" } })), async ({ socketPath, sockets }) => {
    const e = eventsAt(socketPath, { maxFrameBytes: 128, subscriptions: [] }); const errors = [], seen = [];
    e.on("event", (v) => seen.push(v)); e.on("protocol_error", (err) => { errors.push(err); e.stop(); });
    try {
      await e.start();
      const bad = malformed === "invalid JSON" ? "broken\n" : malformed === "oversized" ? '"' + "x".repeat(200) + '"\n' : line({ event: "pane_closed", data: malformed === "bad event data" ? [] : { type: "tab_closed" } });
      for (const s of sockets) s.write(bad);
      await delay(20); assert.equal(errors.length, 1); assert.equal(e.ready, false); assert.deepEqual(seen, []);
    } finally { e.stop(); }
  }));
}

test("2A unverified named sessions fail fast but explicit Windows pipes/default Unix remain", () => {
  for (const opts of [{ session: "named", env: {} }, { env: { HERDR_SESSION: "named" } }]) assert.throws(() => discoverSocketPath({ homedir: "/home/u", platform: "linux", ...opts }), (e) => e.code === "socket_path_unverified");
  assert.equal(discoverSocketPath({ homedir: "/home/u", platform: "linux", env: {} }).path, "/home/u/.config/herdr/herdr.sock");
  assert.equal(discoverSocketPath({ platform: "win32", socketPath: "\\\\.\\pipe\\herdr", env: { HERDR_SESSION: "unknown" } }).path, "\\\\.\\pipe\\herdr");
});


test("2A normalization preserves real dot subscription names and is idempotent", () => {
  for (const name of ["pane.output_matched", "pane.agent_status_changed", "pane.scroll_changed"]) assert.equal(normalizeEventName(name), name);
  assert.equal(normalizeEventName("pane_agent_status_changed"), "pane.agent_status_changed");
  assert.equal(normalizeEventName(normalizeEventName("pane_agent_status_changed")), "pane.agent_status_changed");
});

test("2A ACK and CRLF subscription events may coalesce with split UTF8", async () => withServer((r, s) => {
  const bytes = Buffer.from(line({ id: r.id, result: { type: "subscription_started" } }).trimEnd() + "\r\n"
    + JSON.stringify({ event: "pane.agent_status_changed", data: { text: "中文", pane_id: "p" } }) + "\r\n"
    + line({ event: "pane.scroll_changed", data: { pane_id: "p" } }));
  const cut = bytes.indexOf(Buffer.from("中")) + 1;
  s.write(bytes.subarray(0, cut)); setTimeout(() => s.write(bytes.subarray(cut)), 5);
}, async ({ socketPath }) => {
  const e = eventsAt(socketPath), seen = [];
  const received = new Promise((resolve) => e.on("event", (v) => { seen.push(v); if (seen.length === 2) resolve(); }));
  try {
    await e.start(); await received;
    assert.deepEqual(seen.map((v) => v.event), ["pane.agent_status_changed", "pane.scroll_changed"]);
    assert.equal(seen[0].data.text, "中文"); assert.ok(seen.every((v) => v.generation === e.generation));
  } finally { e.stop(); }
}));

test("2A a late old Event socket cannot mutate a refreshed ready generation", async (t) => {
  const clients = [], original = net.createConnection.bind(net);
  const mock = t.mock.method(net, "createConnection", (...args) => { const s = original(...args); clients.push(s); return s; });
  try { await withServer((r, s) => s.write(line({ id: r.id, result: { type: "subscription_started" } })), async ({ socketPath, requests }) => {
    const e = eventsAt(socketPath), seen = [], errors = [];
    e.on("event", (v) => seen.push(v)); e.on("protocol_error", (v) => errors.push(v));
    try {
      await e.start();
      const old = Object.fromEntries(["data", "close", "error"].map((name) => [name, clients[0].listeners(name).at(-1)]));
      const reconnected = once(e, "reconnected"); e.refresh(); const [current] = await reconnected;
      old.data(Buffer.from("malformed old bytes\n")); old.close(); old.error(new Error("stale error"));
      await delay(20);
      assert.equal(e.generation, current.generation); assert.equal(e.ready, true); assert.equal(requests.length, 2);
      assert.deepEqual(errors, []); assert.deepEqual(seen, []);
    } finally { e.stop(); }
  }); } finally { mock.mock.restore(); }
});

test("2A stopping before ACK clears timers/sockets and does not revive", async () => withServer(() => {}, async ({ socketPath, requests, sockets, received }) => {
  const e = eventsAt(socketPath, { ackTimeoutMs: 250 }), errors = [];
  e.on("subscribe_error", (err) => errors.push(err));
  const started = e.start().catch((err) => err);
  try {
    await received; e.stop();
    assert.equal((await started).code, "connection_closed");
    await delay(280); assert.equal(requests.length, 1); assert.equal(sockets.size, 0); assert.deepEqual(errors, []); assert.equal(e.ready, false);
  } finally { e.stop(); }
}));

test("2A correlated remote errors retain raw diagnostics and delivery receipt, without retry", async () => withServer((r, s) => s.end(line({ id: r.id, error: { code: "future_server_code", message: "details", diagnostic: { n: 1 } } })), async ({ socketPath, requests }) => {
  const c = new HerdrControl({ socketPath });
  try {
    await assert.rejects(c.call("test"), (e) => e.code === "future_server_code" && e.category === "other" && !e.local && e.delivery === "response_received" && e.raw.diagnostic.n === 1);
    assert.equal(requests.length, 1); assert.equal(c.inflightCount, 0);
  } finally { c.close(); }
}));

test("2A synchronous connection input errors are normalized as not_sent", async (t) => {
  const failure = Object.assign(new Error("invalid explicit path"), { code: "ERR_INVALID_ARG_VALUE" });
  const mock = t.mock.method(net, "createConnection", () => { throw failure; });
  const c = new HerdrControl({ socketPath: "/unused.sock" });
  try { await assert.rejects(c.call("ping"), (e) => e.local && e.delivery === "not_sent" && e.raw === failure); assert.equal(c.inflightCount, 0); }
  finally { c.close(); mock.mock.restore(); }
});
