import assert from "node:assert/strict";
import { exec, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { canExecuteModel, controlKeysIn, loadConfig, normalizeCommands, resolveCapKey, workerModelFields } from "../src/config.mjs";
import { agentTaskCreate } from "../src/agent-cli.mjs";
import { doctor } from "../src/doctor.mjs";
import { Kernel, resolveModelDecision, taskModelDecision } from "../src/kernel.mjs";
import { modelAuditOf, modelArgs } from "../src/receipt.mjs";
import { assertModelOverride, formatAgentCard, presetHttpCardFields } from "../src/hub/admission.mjs";
import { createTask, parseCreateArgv } from "../src/hub/create.mjs";
import { loadAgentTemplates, seedAgentTemplates } from "../src/hub/agent-templates.mjs";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES, f1 } from "../src/bus/tables.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { LongPollBroker } from "../src/server/longpoll-broker.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockBus } from "./mocks/mock-bus.mjs";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const future = "future/provider:model-2030@preview";
const audit = (requested_model, default_model, effective_model, model_source) =>
  ({ requested_model, default_model, effective_model, model_source });

for (const [requested, worker, expected] of [
  [future, { default_model: "base" }, audit(future, "base", future, "override")],
  [null, { default_model: "base" }, audit(null, "base", "base", "worker_default")],
  [undefined, {}, audit(null, null, null, "cli_default")],
  [null, { default_model: null }, audit(null, null, null, "cli_default")],
]) {
  test(`Kernel 模型唯一解析：${expected.model_source}/${String(requested)}`, () => {
    const result = resolveModelDecision(requested, worker);
    assert.deepEqual(result, expected);
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(worker, worker.default_model === undefined ? {} : { default_model: worker.default_model });
  });
}

test("模型只做结构校验；未知字符串透传，执行控制不能藏进业务参数", () => {
  assert.deepEqual(modelArgs("grok", future), ["--model", future]);
  assert.throws(() => modelArgs("constructor", future), /not_supported/);
  for (const invalid of ["", "\n", 42, {}, "a\0b"]) assert.throws(() => resolveModelDecision(invalid));
  assert.throws(() => assertModelOverride(42, { supports_model_override: true }), (e) => e.statusCode === 400 || e.status === 400);
  assert.deepEqual(controlKeysIn({ requested_model: future, effective_model: "fake", x: 1 }), ["requested_model", "effective_model"]);
});

test("Worker 拥有模型及可选 skills，旧 Skill/Cap 寻址与 json/shell 命令保留", () => {
  const config = { workers: { a: { command: "fake {model_args}", harness: "grok", mode: "json", default_model: "base", skills: [] } },
    review: { workers: ["a"], default_model: "injected", skills: ["blocking"] },
    shell: { command: "printf old", mode: "shell" } };
  const flat = normalizeCommands(config);
  assert.equal(flat["a/agent"].default_model, "base");
  assert.deepEqual(flat["a/review"].skills, []);
  assert.equal(flat["a/review"].default_model, "base");
  assert.equal(flat.shell.command, "printf old");
  assert.equal(resolveCapKey(flat, "", "a"), "a/agent");
  assert.equal(resolveCapKey(flat, "review", "a"), "a/review");
  assert.deepEqual(workerModelFields({}).skills, []);
  assert.deepEqual(normalizeCommands({ echo: { command: "echo old" } }), { echo: { command: "echo old" } });
});

test("发现如实声明支持能力；非 direct/未知 harness/静态冲突参数不能假报 override", () => {
  const base = { harness: "grok", command: "fake {model_args}", mode: "json" };
  assert.equal(workerModelFields(base).supports_model_override, true);
  assert.equal(workerModelFields({ ...base, supports_model_override: false }).supports_model_override, false);
  assert.equal(canExecuteModel({ ...base, supports_model_override: false }), true);
  for (const extra of [{ context: "custom" }, { mode: "inbox" }, { harness: "constructor" }, { command: "fake --model static {model_args}" }, { command: "fake '--model' static {model_args}" }, { command: "fake --model=static {model_args}" }, { command: "fake {model_args} {model_args}" }, { command: 'fake "{model_args}"' }, { command: "fake prefix{model_args}" }, { resume_command: "fake resume" }]) {
    assert.equal(workerModelFields({ ...base, ...extra, supports_model_override: true }).supports_model_override, false);
  }
  const model = workerModelFields({ ...base, default_model: "base" });
  const card = formatAgentCard({ fields: presetHttpCardFields({ node: "n", role: "worker", receiveMode: "http-poll", model }) });
  assert.equal(card.harness, "grok");
  assert.equal(card.default_model, "base");
  assert.equal(card.active_model, null);
  assert.equal(card.supports_model_override, true);
  assert.deepEqual(card.skills, []);
});

test("--model 在建单前校验能力；空 skills 可派，不支持覆盖时零写入", async () => {
  const bus = new MockBus({ tables: TABLES });
  await bus.createRecord(TABLES.agentCards, { ...presetHttpCardFields({ node: "n", role: "worker", receiveMode: "http-poll", model: { harness: "remote", default_model: "base", supports_model_override: true, skills: [] } }), Admission: "admitted", Worker: "a" });
  const argv = parseCreateArgv(["--to", "n", "--worker", "a", "--model", future]);
  const id = await createTask({ bus, to: argv.to, worker: argv.worker, requested_model: argv.requested_model, text: "go" });
  const task = (await bus.listRecords(TABLES.tasks)).find((t) => f1(t, "Task_ID") === id);
  assert.equal(f1(task, "Skill_ID"), "agent");
  assert.equal(JSON.parse(f1(task, "Metadata")).requested_model, future);
  assert.equal(modelAuditOf(f1(task, "Metadata")), null);
  const card = (await bus.listRecords(TABLES.agentCards))[0];
  await bus.updateRecord(TABLES.agentCards, card.record_id, { Metadata: JSON.stringify({ worker_model: { supports_model_override: false } }) });
  const before = (await Promise.all([TABLES.tasks, TABLES.messages, TABLES.parts].map((t) => bus.listRecords(t)))).map((x) => x.length);
  await assert.rejects(createTask({ bus, to: "n", worker: "a", requested_model: future, text: "must reject" }), /model_override_not_supported/);
  assert.deepEqual((await Promise.all([TABLES.tasks, TABLES.messages, TABLES.parts].map((t) => bus.listRecords(t)))).map((x) => x.length), before);
});

test("不可变审计快照胜过后续 Worker 默认与 Agent 自报", () => {
  const model = resolveModelDecision(future, { default_model: "old" });
  const task = { fields: { Metadata: JSON.stringify({ requested_model: "changed", model }) } };
  assert.deepEqual(taskModelDecision(task, { default_model: "new" }), model);
  assert.equal(modelAuditOf(JSON.stringify({ model: { effective_model: "forged" } })), null);
  assert.throws(() => taskModelDecision({ fields: { Metadata: "broken-json" } }), /model_metadata_invalid/);
  assert.throws(() => taskModelDecision({ fields: { Metadata: JSON.stringify({ model: { ...model, model_source: "cli_default" } }) } }), /model_audit_invalid/);
  assert.throws(() => taskModelDecision({ fields: { Metadata: JSON.stringify({ model: {} }) } }), /model_audit_invalid/);
  assert.equal(Object.isFrozen(taskModelDecision(task)), true);
});

test("假 CLI 实测原生参数与引号安全，覆盖不污染下一单默认，null 回退无粘滞", async () => withTemp(async (dir) => {
  const fake = path.join(dir, "fake-cli.mjs");
  fs.writeFileSync(fake, `let text='';for await (const c of process.stdin)text+=c;console.log(JSON.stringify({summary:JSON.stringify({argv:process.argv.slice(2),input:JSON.parse(text)})}));`);
  const entry = { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} {model_args}`, mode: "json", context: "direct", harness: "grok", default_model: "base", skills: [], approval_class: "auto" };
  fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({ workers: { a: entry } }));
  const bus = new MockBus({ tables: TABLES });
  const kernel = new Kernel({ node: "n", role: "node", kind: "host", capPrefix: "n", configDir: dir, bus, events: false });
  await kernel.sweepOnce();
  for (const c of await bus.listRecords(TABLES.agentCards)) await bus.updateRecord(TABLES.agentCards, c.record_id, { Admission: "admitted" });
  const dangerous = `unknown'; touch ${path.join(dir, "injected")}; '$(echo not-shell)`;
  for (const [requested, defaultModel, expected] of [[dangerous, "base", dangerous], [null, "base", "base"], [null, null, null]]) {
    entry.default_model = defaultModel;
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({ workers: { a: entry } }));
    await kernel.sweepOnce();
    const id = await createTask({ bus, from: "hub", to: "n", worker: "a", requested_model: requested, text: "fake only" });
    let task;
    for (let i = 0; i < 180; i++) {
      await kernel.sweepOnce();
      task = (await bus.listRecords(TABLES.tasks)).find((t) => f1(t, "Task_ID") === id);
      if (["completed", "failed", "rejected"].includes(f1(task, "Status"))) break;
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(f1(task, "Status"), "completed");
    const decision = resolveModelDecision(requested, entry);
    assert.deepEqual(modelAuditOf(f1(task, "Metadata")), decision);
    const result = (await bus.listRecords(TABLES.messages)).find((m) => f1(m, "Task_ID") === id && f1(m, "Kind") === "result");
    const parts = (await bus.listRecords(TABLES.parts)).filter((p) => f1(p, "Parent_ID") === f1(result, "Msg_ID"));
    const actual = JSON.parse(f1(parts.find((p) => f1(p, "Kind") === "text"), "Text"));
    assert.deepEqual(actual.argv, expected === null ? [] : ["--model", expected]);
    assert.deepEqual(actual.input._hub.model, decision);
    assert.deepEqual(JSON.parse(f1(parts.find((p) => f1(p, "Kind") === "data"), "Data")).model, decision);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "commands.json"))).workers.a.default_model, defaultModel);
  }
  assert.equal(fs.existsSync(path.join(dir, "injected")), false);
  kernel.abandonLocalFlight();
}));

test("只禁止单次覆盖的 Worker 仍执行自己的默认模型；不支持的模型不得静默忽略", async () => withTemp(async (dir) => {
  const bus = new MockBus({ tables: TABLES });
  const kernel = new Kernel({ node: "n", role: "node", kind: "host", capPrefix: "n", configDir: dir, bus, events: false });
  const entry = { command: "echo {model_args}", mode: "json", harness: "grok", default_model: "base", supports_model_override: false };
  kernel.commands = { "a/agent": entry };
  const task = { fields: { Task_ID: "TASK-NATIVE", Metadata: "{}" } };
  const prepared = await kernel.prepareCommand("a/agent", task, {}, null);
  const result = await execAsync(prepared.command);
  assert.equal(result.stdout.trim(), "--model base");
  kernel.commands["a/agent"] = { ...entry, mode: "agent" };
  task.fields.Worker_Hint = "a";
  task.fields.Skill_ID = "agent";
  const agentPrepared = await kernel.prepareCommand("a/agent", task, {}, null);
  assert.equal((await execAsync(agentPrepared.command)).stdout.trim(), "--model base");
  assert.match(agentPrepared.stdinText, /TASK-NATIVE/);
  kernel.commands["a/agent"] = { ...entry, context: "custom" };
  await assert.rejects(kernel.prepareCommand("a/agent", task, {}, null), /model_execution_not_supported/);
}));

test("模板不持久化 active_model", async () => withTemp(async (dir) => {
  fs.writeFileSync(path.join(dir, "agent_templates.json"), JSON.stringify(seedAgentTemplates()));
  assert.deepEqual(loadAgentTemplates(dir).errors, []);
  const templates = JSON.parse(fs.readFileSync(path.join(dir, "agent_templates.json")));
  assert.equal(templates.every((t) => t.default_model === null && Array.isArray(t.skills) && !Object.hasOwn(t, "active_model")), true);
}));

async function api(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer test-model-token", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

test("HTTP/Gateway：注册发现→派单→claim/重认领快照→完成回执，云端复用 Kernel 解析", async () => withTemp(async (dir) => {
  const templates = seedAgentTemplates();
  templates[0] = { ...templates[0], default_model: "template/base", supports_model_override: true, harness: "external" };
  fs.writeFileSync(path.join(dir, "agent_templates.json"), JSON.stringify(templates));
  const broker = new LongPollBroker({ initialSeq: 0 });
  const bus = new SqliteBus({ dbPath: path.join(dir, "hub.db"), tables: DEFAULT_TABLES, broker });
  const server = await startHubHttpServer({ cfg: { node: "hub", configDir: dir, listen: "127.0.0.1:0", apiToken: "test-model-token" }, bus, broker, log: () => {}, onWake: () => {} });
  const base = server.localUrl;
  try {
    assert.equal((await api(base, "/api/v1/agents/register", { node: "named", role: "worker", worker: "a", default_model: "named/base", supports_model_override: true })).status, 200);
    assert.equal((await api(base, "/api/v1/admin/nodes/named/admission", { admission: "admitted" })).status, 200);
    const namedTask = await api(base, "/api/v1/tasks", { from: "hub", to: "named", text: "default worker" });
    assert.equal(namedTask.status, 201);
    const unknownWorker = await api(base, `/api/v1/tasks/${namedTask.data.task_id}/claim`, { node: "named", worker: "missing" });
    assert.equal(unknownWorker.status, 400);
    const namedClaim = await api(base, `/api/v1/tasks/${namedTask.data.task_id}/claim`, { node: "named" });
    assert.deepEqual(namedClaim.data.model, resolveModelDecision(null, { default_model: "named/base" }));
    const namedSaved = (await bus.listRecords(DEFAULT_TABLES.tasks)).find((t) => f1(t, "Task_ID") === namedTask.data.task_id);
    assert.equal(f1(namedSaved, "Worker_Hint"), "a");
    const ownerCreated = await api(base, "/api/v1/admin/agents", { node: "from-template", access: "http", role: "worker", template_id: "generic-poll" });
    assert.equal(ownerCreated.status, 200, JSON.stringify(ownerCreated.data));
    const templateCard = (await bus.listRecords(DEFAULT_TABLES.agentCards)).find((c) => f1(c, "Node") === "from-template");
    assert.equal(formatAgentCard(templateCard).default_model, "template/base");
    assert.equal(formatAgentCard(templateCard).supports_model_override, true);
    let reg = await api(base, "/api/v1/agents/register", { node: "cloud", role: "worker", harness: "external", default_model: "base", supports_model_override: true, skills: [] });
    assert.equal(reg.status, 200);
    assert.equal((await api(base, "/api/v1/admin/nodes/cloud/admission", { admission: "admitted" })).status, 200);
    const nodes = await api(base, "/api/v1/agents");
    const card = nodes.data.agents.find((a) => a.node === "cloud").caps[0];
    assert.equal(card.default_model, "base");
    assert.equal(card.supports_model_override, true);
    assert.equal(card.active_model, null);
    assert.deepEqual(card.skills, []);
    const made = await api(base, "/api/v1/tasks", { from: "hub", to: "cloud", requested_model: future, text: "model contract" });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const id = made.data.task_id;
    const claimed = await api(base, `/api/v1/tasks/${id}/claim`, { node: "cloud", worker: "legacy-runtime-label", lease_id: "one" });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.data));
    const decision = resolveModelDecision(future, { default_model: "base" });
    assert.deepEqual(claimed.data.model, decision);
    await api(base, "/api/v1/agents/register", { node: "cloud", role: "worker", default_model: "new-default" });
    const again = await api(base, `/api/v1/tasks/${id}/claim`, { node: "cloud", lease_id: "one" });
    assert.equal(again.data.already_claimed, true);
    assert.deepEqual(again.data.model, decision);
    assert.equal((await api(base, `/api/v1/tasks/${id}/ask`, { node: "cloud", text: "question" })).status, 200);
    assert.equal((await api(base, `/api/v1/tasks/${id}/reply`, { from: "hub", text: "answer" })).status, 200);
    const resumed = await api(base, `/api/v1/tasks/${id}/claim`, { node: "cloud", lease_id: "one" });
    assert.equal(resumed.data.action, "resume");
    assert.deepEqual(resumed.data.model, decision);
    const completed = await api(base, `/api/v1/tasks/${id}/complete`, { node: "cloud", summary: "done", model: { effective_model: "spoofed" } });
    assert.equal(completed.status, 200, JSON.stringify(completed.data));
    assert.deepEqual(completed.data.model, decision);
    const saved = (await bus.listRecords(DEFAULT_TABLES.tasks)).find((t) => f1(t, "Task_ID") === id);
    assert.deepEqual(modelAuditOf(f1(saved, "Metadata")), decision);
    const next = await api(base, "/api/v1/tasks", { from: "hub", to: "cloud", text: "default" });
    const nextClaim = await api(base, `/api/v1/tasks/${next.data.task_id}/claim`, { node: "cloud" });
    assert.deepEqual(nextClaim.data.model, resolveModelDecision(null, { default_model: "new-default" }));
    for (const busType of ["http", "agent"]) {
      const cliDir = path.join(dir, `cli-${busType}`);
      fs.mkdirSync(cliDir);
      fs.writeFileSync(path.join(cliDir, "node.json"), JSON.stringify({ node: "hub", role: "node", busType, hubUrl: base, apiToken: "test-model-token" }));
      const { stdout } = await execFileAsync(process.execPath, [path.resolve("bin/ah.mjs"), "task", "create", "--config", cliDir, "--to", "cloud", "--model", future, "--text", "CLI projection"]);
      const cliId = stdout.match(/TASK-[A-Za-z0-9-]+/)?.[0];
      assert.ok(cliId, stdout);
      const cliTask = (await bus.listRecords(DEFAULT_TABLES.tasks)).find((t) => f1(t, "Task_ID") === cliId);
      assert.equal(JSON.parse(f1(cliTask, "Metadata")).requested_model, future);
    }
    await api(base, "/api/v1/agents/register", { node: "cloud", role: "worker", supports_model_override: false });
    const denied = await api(base, "/api/v1/tasks", { from: "hub", to: "cloud", requested_model: future, text: "reject" });
    assert.equal(denied.status, 400);
    assert.match(denied.data.error, /model_override_not_supported/);
    await api(base, "/api/v1/agents/register", { node: "cloud", role: "worker", default_model: null });
    const legacy = await api(base, "/api/v1/tasks", { from: "hub", to: "cloud", text: "cli default" });
    const legacyClaim = await api(base, `/api/v1/tasks/${legacy.data.task_id}/claim`, { node: "cloud" });
    assert.deepEqual(legacyClaim.data.model, resolveModelDecision(null, {}));
  } finally {
    await server.close();
    bus.close();
  }
}));

test("Agent CLI 网关建单明确透传 requested_model，而非业务参数", async () => {
  let captured;
  const id = await agentTaskCreate({ node: "leader", busType: "agent", hubUrl: "http://127.0.0.1:1", agentClient: { createTask: async (payload) => { captured = payload; return { task_id: "TASK-CAPTURE" }; } } },
    { to: "cloud", requested_model: future, files: [], text: "go" }, { params: { topic: "safe" } });
  assert.equal(id, "TASK-CAPTURE");
  assert.equal(captured.requested_model, future);
  assert.deepEqual(captured.params, { topic: "safe" });
});

test("doctor 缺 default_model 仅警告，不阻断旧 Worker", async () => withTemp(async (dir) => {
  fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ node: "test-hub", role: "hub", busType: "sqlite", listen: "127.0.0.1:0" }));
  fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({ workers: { a: { command: "echo fake", mode: "json" } } }));
  const lines = [];
  const original = console.log;
  let code;
  console.log = (...args) => lines.push(args.join(" "));
  try { code = await doctor(dir, path.resolve(".")); }
  finally { console.log = original; }
  assert.equal(code, 0, lines.join("\n"));
  assert.match(lines.join("\n"), /Warning: Worker a 未配置 default_model/);
}));
