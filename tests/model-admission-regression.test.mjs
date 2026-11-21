import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { doctor } from "../src/doctor.mjs";
import { Kernel } from "../src/kernel.mjs";
import { normalizeCommands, workerModelFields } from "../src/config.mjs";
import { modelAuditOf } from "../src/receipt.mjs";
import { createTask } from "../src/hub/create.mjs";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES, f1 } from "../src/bus/tables.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { LongPollBroker } from "../src/server/longpoll-broker.mjs";
import { withTemp } from "./helpers.mjs";

const opaque = "future/provider:opaque-no-enumeration";
async function withGateway(fn) {
  return withTemp(async (dir) => {
    const broker = new LongPollBroker({ initialSeq: 0 });
    const bus = new SqliteBus({ dbPath: path.join(dir, "hub.db"), tables: DEFAULT_TABLES, broker });
    const server = await startHubHttpServer({ cfg: { node: "hub", configDir: dir, listen: "127.0.0.1:0", apiToken: "regression-fixture" }, bus, broker, log: () => {}, onWake: () => {} });
    const api = async (url, body) => {
      const res = await fetch(server.localUrl + url, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer regression-fixture", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, data: await res.json() };
    };
    const cards = async (node) => (await bus.listRecords(DEFAULT_TABLES.agentCards)).filter((c) => f1(c, "Node") === node);
    const change = async (node, fields) => { for (const c of await cards(node)) await bus.updateRecord(DEFAULT_TABLES.agentCards, c.record_id, fields(c)); };
    const register = async (node, caps, extra = {}) => {
      const res = await api("/api/v1/agents/register", { node, role: "worker", caps, ...extra });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      await change(node, () => ({ Admission: "admitted" }));
      return res;
    };
    const task = async (id) => (await bus.listRecords(DEFAULT_TABLES.tasks)).find((t) => f1(t, "Task_ID") === id);
    try { await fn({ api, bus, cards, change, register, task }); }
    finally { await server.close(); bus.close(); }
  });
}

for (const [label, commands, rejected] of [
  ["removed Herdr context", { workers: { a: { context: "herdr", command: "echo {model_args}", mode: "json", harness: "grok", default_model: "base" } } }, true],
  ["direct default without model slot", { workers: { a: { command: "echo fake", mode: "json", harness: "grok", default_model: "base" } } }, true],
  ["legacy direct default without model slot", { legacy: { command: "echo fake", mode: "json", harness: "grok", default_model: "base" } }, true],
  ["direct resume missing model slot", { workers: { a: { command: "echo {model_args}", resume_command: "echo {sessionId}", mode: "json", harness: "grok", default_model: "base" } } }, true],
  ["extra unknown field remains direct", { workers: { a: { command: "echo {model_args}", mode: "json", harness: "grok", default_model: "base", extra_note: "ok" } } }, false],
  ["null model keeps CLI default", { workers: { a: { command: "echo fake", mode: "json", default_model: null } } }, false],
]) {
  test(`regression doctor: ${label}`, async () => withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ node: "fixture", role: "hub", busType: "sqlite" }));
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify(commands));
    const lines = [], original = console.log;
    let code;
    try { console.log = (...args) => lines.push(args.join(" ")); code = await doctor(dir, path.resolve(".")); }
    finally { console.log = original; }
    assert.equal(code !== 0, rejected, lines.join("\n"));
    if (rejected) assert.match(lines.join("\n"), /default_model.*(?:无法|不支持|不可执行)|model_execution_not_supported|herdr 执行语境已移除/);
  }));
}

test("regression create: override gate uses the chosen admissible Worker", async () => withGateway(async ({ api, register, change, task }) => {
  for (const supported of [false, true]) {
    const node = `binding-${supported}`;
    await register(node, [
      { worker: "blocked", skill_id: "agent", default_model: "BLOCKED", supports_model_override: !supported },
      { worker: "allowed", skill_id: "agent", default_model: "ALLOWED", supports_model_override: supported },
    ]);
    await change(node, (c) => ({ Admission: f1(c, "Worker") === "blocked" ? "rejected" : "admitted", Dispatchable: f1(c, "Worker") === "blocked" ? "No" : "Yes" }));
    const made = await api("/api/v1/tasks", { to: node, text: "select admitted Worker", requested_model: opaque });
    assert.equal(made.status, supported ? 201 : 400, JSON.stringify(made.data));
    if (!supported) continue;
    const wrong = await api(`/api/v1/tasks/${made.data.task_id}/claim`, { node, worker: "blocked" });
    assert.equal(wrong.status, 400);
    assert.equal(modelAuditOf(f1(await task(made.data.task_id), "Metadata")), null);
    const claim = await api(`/api/v1/tasks/${made.data.task_id}/claim`, { node });
    assert.equal(claim.status, 200, JSON.stringify(claim.data));
    assert.equal(claim.data.model.default_model, "ALLOWED");
    assert.equal(claim.data.model.effective_model, opaque);
    assert.equal(f1(await task(made.data.task_id), "Worker_Hint"), "allowed");
  }
}));

for (const stopped of [{ Admission: "rejected" }, { Dispatchable: "No" }]) {
  test(`regression claim rechecks initial gate: ${JSON.stringify(stopped)}`, async () => withGateway(async ({ api, register, change, task, bus }) => {
    await register("stopped", [{ worker: "a", skill_id: "agent", default_model: "base", supports_model_override: true }]);
    const made = await api("/api/v1/tasks", { to: "stopped", text: "queued" });
    assert.equal(made.status, 201);
    await change("stopped", () => stopped);
    const claim = await api(`/api/v1/tasks/${made.data.task_id}/claim`, { node: "stopped" });
    assert.equal(claim.status, 403, JSON.stringify(claim.data));
    const saved = await task(made.data.task_id);
    assert.equal(f1(saved, "Status"), "submitted");
    assert.equal(modelAuditOf(f1(saved, "Metadata")), null);
    assert.equal((await bus.listRecords(DEFAULT_TABLES.runs)).length, 0);
  }));
}

test("regression registration: conflicting Skill model policies reject the whole batch", async () => withGateway(async ({ api, cards }) => {
  const bad = await api("/api/v1/agents/register", { node: "conflict", role: "worker", caps: [
    { worker: "other", skill_id: "agent", default_model: "separate" },
    { worker: "a", skill_id: "agent", default_model: "AGENT", supports_model_override: true },
    { worker: "a", skill_id: "review", default_model: "SKILL", supports_model_override: false },
  ] });
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
  assert.match(bad.data.error, /worker_model_conflict/);
  assert.deepEqual(await cards("conflict"), []);
}));

test("regression registration: partial updates project one Worker policy, preserve aliases and frozen claims", async () => withGateway(async ({ api, register, cards, task }) => {
  await register("aliases", [
    { worker: "a", skill_id: "agent", default_model: "base", supports_model_override: true, skills: [] },
    { worker: "a", skill_id: "review", default_model: "base", supports_model_override: true },
    { worker: "b", skill_id: "agent", default_model: "other", supports_model_override: false },
  ]);
  const made = await api("/api/v1/tasks", { to: "aliases", worker: "a", cap: "review", text: "legacy skill", requested_model: opaque });
  assert.equal(made.status, 201);
  const initial = await api(`/api/v1/tasks/${made.data.task_id}/claim`, { node: "aliases", worker: "a" });
  assert.equal(initial.status, 200);
  await register("aliases", [{ worker: "a", skill_id: "review", default_model: "new-base", supports_model_override: false }]);
  const roster = await cards("aliases");
  for (const c of roster.filter((c) => f1(c, "Worker") === "a")) {
    const spec = JSON.parse(f1(c, "Metadata")).worker_model;
    assert.equal(spec.default_model, "new-base");
    assert.equal(spec.supports_model_override, false);
  }
  assert.equal(JSON.parse(f1(roster.find((c) => f1(c, "Worker") === "b"), "Metadata")).worker_model.default_model, "other");
  const again = await api(`/api/v1/tasks/${made.data.task_id}/claim`, { node: "aliases", worker: "a" });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.deepEqual(again.data.model, initial.data.model);
  const fixed = await api("/api/v1/tasks", { to: "aliases", worker: "a", cap: "review", text: "fixed model cloud Worker" });
  const claim = await api(`/api/v1/tasks/${fixed.data.task_id}/claim`, { node: "aliases", worker: "a" });
  assert.equal(claim.status, 200, JSON.stringify(claim.data));
  assert.equal(claim.data.model.default_model, "new-base");
  assert.equal(f1(await task(fixed.data.task_id), "Skill_ID"), "review");
  const override = await api("/api/v1/tasks", { to: "aliases", worker: "a", cap: "review", text: "unsupported", requested_model: opaque });
  assert.equal(override.status, 400);
}));

test("regression legacy conflicting cards cannot freeze a different agent-card model", async () => withGateway(async ({ api, register, change, task }) => {
  await register("old-conflict", [{ worker: "a", skill_id: "agent", default_model: "base" }, { worker: "a", skill_id: "review", default_model: "base" }]);
  const made = await api("/api/v1/tasks", { to: "old-conflict", worker: "a", cap: "review", text: "queued before drift" });
  await change("old-conflict", (c) => ({ Metadata: JSON.stringify({ kind: "agent", mode: "http-poll", worker_model: { default_model: f1(c, "Skill_ID") === "agent" ? "AGENT" : "SKILL" } }) }));
  const denied = await api("/api/v1/tasks", { to: "old-conflict", worker: "a", cap: "review", text: "must not choose agent" });
  assert.equal(denied.status, 400);
  assert.match(denied.data.error, /worker_model_conflict/);
  const claim = await api(`/api/v1/tasks/${made.data.task_id}/claim`, { node: "old-conflict", worker: "a" });
  assert.equal(claim.status, 400);
  assert.equal(modelAuditOf(f1(await task(made.data.task_id), "Metadata")), null);
}));

for (const [label, kind, mode] of [["local host", "host", "agent"], ["local inbox", "agent", "inbox"], ["unknown backend", "unknown", "http-poll"]]) {
  test(`regression Gateway cannot consume ${label} tasks`, async () => withGateway(async ({ api, bus, task }) => {
    const entry = normalizeCommands({ workers: { h: { context: "direct", command: "echo fake", harness: "grok", default_model: "LOCAL-ONLY" } } })["h/agent"];
    await bus.createRecord(DEFAULT_TABLES.agentCards, { Node: "local", Worker: "h", Skill_ID: "agent", Cap_ID: "CAP-local-h-agent", Admission: "admitted", Dispatchable: "Yes", Receive_Mode: "http-poll", Metadata: JSON.stringify({ kind, mode, worker_model: workerModelFields(entry) }) });
    const made = await api("/api/v1/tasks", { to: "local", worker: "h", text: "local Kernel owns execution" });
    assert.equal(made.status, 201);
    const claim = await api(`/api/v1/tasks/${made.data.task_id}/claim`, { node: "local", worker: "h" });
    assert.equal(claim.status, 400, JSON.stringify(claim.data));
    assert.match(claim.data.error, /execution_backend_not_supported/);
    assert.equal(f1(await task(made.data.task_id), "Status"), "submitted");
    assert.equal(modelAuditOf(f1(await task(made.data.task_id), "Metadata")), null);
    assert.equal((await bus.listRecords(DEFAULT_TABLES.runs)).length, 0);
    const poll = await api("/api/v1/agents/local/poll?timeout=0");
    assert.equal(poll.status, 200);
    assert.deepEqual(poll.data.tasks, []);
  }));
}

test("regression local Kernel honors selected Worker while legacy Skill-only hint stays compatible", async () => withTemp(async (dir) => {
  const commands = { workers: {
    alpha: { command: 'echo \'{"summary":"WRONG"}\'', mode: "json" },
    beta: { command: 'echo \'{"summary":"RIGHT"}\'', mode: "json" },
  }, review: { workers: ["alpha", "beta"] } };
  fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify(commands));
  const broker = new LongPollBroker({ initialSeq: 0 });
  const bus = new SqliteBus({ dbPath: path.join(dir, "local.db"), tables: DEFAULT_TABLES, broker });
  const kernel = new Kernel({ node: "local", role: "node", kind: "host", capPrefix: "local", configDir: dir, bus, events: false });
  try {
    await kernel.sweepOnce();
    for (const c of await bus.listRecords(DEFAULT_TABLES.agentCards)) await bus.updateRecord(DEFAULT_TABLES.agentCards, c.record_id, { Admission: "admitted", Dispatchable: f1(c, "Worker") === "alpha" ? "No" : "Yes" });
    const id = await createTask({ bus, to: "local", cap: "review", text: "selected beta only" });
    let saved = (await bus.listRecords(DEFAULT_TABLES.tasks)).find((t) => f1(t, "Task_ID") === id);
    assert.equal(f1(saved, "Worker_Hint"), "");
    for (let i = 0; i < 160; i++) {
      await kernel.sweepOnce();
      saved = (await bus.listRecords(DEFAULT_TABLES.tasks)).find((t) => f1(t, "Task_ID") === id);
      if (["completed", "failed", "rejected"].includes(f1(saved, "Status"))) break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.equal(f1(saved, "Status"), "completed");
    assert.equal(f1(saved, "Worker_Hint"), "beta");
  } finally { kernel.requestStop(); bus.close(); }
}));

test("regression legacy unbound tasks can still choose an admissible named Worker", async () => withGateway(async ({ api, bus, register, change, task }) => {
  await register("old-task", [
    { worker: "stopped", skill_id: "agent", default_model: "WRONG" },
    { worker: "ready", skill_id: "agent", default_model: "RIGHT" },
  ]);
  await change("old-task", (c) => ({ Dispatchable: f1(c, "Worker") === "stopped" ? "No" : "Yes" }));
  await bus.createRecord(DEFAULT_TABLES.tasks, { Task_ID: "TASK-OLD-UNBOUND", Target_Node: "old-task", Skill_ID: "agent", Status: "submitted", Metadata: "{}" });
  const claim = await api("/api/v1/tasks/TASK-OLD-UNBOUND/claim", { node: "old-task" });
  assert.equal(claim.status, 200, JSON.stringify(claim.data));
  assert.equal(claim.data.model.default_model, "RIGHT");
  assert.equal(f1(await task("TASK-OLD-UNBOUND"), "Worker_Hint"), "ready");
}));

test("regression unknown cardless backend is explicitly refused, not grandfathered by owner credentials", async () => withGateway(async ({ api, bus, task }) => {
  await bus.createRecord(DEFAULT_TABLES.tasks, { Task_ID: "TASK-NO-CARD", Target_Node: "unknown", Skill_ID: "agent", Status: "submitted", Metadata: "{}" });
  const claim = await api("/api/v1/tasks/TASK-NO-CARD/claim", { node: "unknown" });
  assert.equal(claim.status, 400);
  assert.equal(f1(await task("TASK-NO-CARD"), "Status"), "submitted");
  assert.equal(modelAuditOf(f1(await task("TASK-NO-CARD"), "Metadata")), null);
}));

test("regression explicit Node scopes exact Cap_ID resolution", async () => withGateway(async ({ bus, task }) => {
  for (const [node, worker] of [["left", "wrong"], ["right", "chosen"]]) {
    await bus.createRecord(DEFAULT_TABLES.agentCards, { Node: node, Worker: worker, Cap_ID: "CAP-shared", Skill_ID: "agent", Dispatchable: "Yes", Admission: "admitted", Metadata: JSON.stringify({ kind: "agent", mode: "http-poll", worker_model: {} }) });
  }
  const id = await createTask({ bus, to: "right", cap: "CAP-shared", text: "right node only" });
  const saved = await task(id);
  assert.equal(f1(saved, "Target_Node"), "right");
  assert.equal(f1(saved, "Worker_Hint"), "chosen");
}));


test("regression authoritative dispatch binding cannot be smuggled in business params", async () => withGateway(async ({ api, register, bus }) => {
  await register("reserved", [{ worker: "a", skill_id: "agent" }]);
  const made = await api("/api/v1/tasks", { to: "reserved", text: "data only", params: { dispatch_target: { worker: "other" } } });
  assert.equal(made.status, 400);
  assert.equal((await bus.listRecords(DEFAULT_TABLES.tasks)).length, 0);
}));

test("regression HTTP registration cannot relabel a host Worker to bypass execution ownership", async () => withGateway(async ({ api, bus, cards }) => {
  await bus.createRecord(DEFAULT_TABLES.agentCards, { Node: "host-owned", Worker: "h", Skill_ID: "agent", Cap_ID: "CAP-host-owned-h-agent", Admission: "admitted", Dispatchable: "Yes", Receive_Mode: "poll", Metadata: JSON.stringify({ kind: "host", mode: "agent", worker_model: { default_model: "local-only" } }) });
  const before = await cards("host-owned");
  const reg = await api("/api/v1/agents/register", { node: "host-owned", worker: "h", kind: "agent", default_model: "claimed-remote", supports_model_override: true });
  assert.equal(reg.status, 400);
  assert.match(reg.data.error, /execution_backend_conflict/);
  assert.deepEqual(await cards("host-owned"), before);
}));
