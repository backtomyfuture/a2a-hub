// herdr 多 Agent 编排引擎单元测试：并发槽位、热驻留占槽、原地热续接、冷启动兜底与 setup/doctor 集成。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { signDecision, loadOrCreateHubKey } from "../src/approval-sign.mjs";
import { f1 } from "../src/bus/tables.mjs";
import { controlKeysIn, inferHerdrKind, loadConfig, normalizeCommands } from "../src/config.mjs";
import { doctor } from "../src/doctor.mjs";
import {
  HERDR_PROTOCOL_MIN,
  HerdrControl,
  HerdrError,
  HerdrEvents,
  LIFECYCLE_SUBSCRIPTIONS,
  assertProtocol,
  backoffDelay,
  classifyErrorCode,
  createHerdrSocket,
  discoverSocketPath,
  normalizeEventName,
  paneStatusSubscription,
} from "../src/herdr-socket.mjs";
import {
  MAX_POINTER_PROMPT_BYTES,
  PointerPromptError,
  assertPointerPrompt,
  atomicWriteFile,
  buildLaunchEnv,
  buildPointerPrompt,
  checkResultGate,
  createHerdrRuntime,
  herdrAgentName,
  herdrAttemptPaths,
  newAttemptId,
  readHerdrLedger,
  writeAttemptEnvelope,
} from "../src/herdr-runner.mjs";
import { Kernel } from "../src/kernel.mjs";
import { readHerdrBinding, readSessionId, writeHerdrBinding, writeSessionId } from "../src/session-store.mjs";
import { discoverLocalAgents, runSetup } from "../src/setup.mjs";
import { TABLES, withTemp } from "./helpers.mjs";
import { MockBus } from "./mocks/mock-bus.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function seedTask(mock, fields, { text = "执行任务", params = { n: 1 }, from = "hub" } = {}) {
  const taskId = fields.Task_ID;
  const msgId = `MSG-${taskId.replace("TASK-", "")}-01`;
  await mock.createRecord(TABLES.messages, {
    Msg_ID: msgId,
    Task_ID: taskId,
    Context_ID: fields.Context_ID || `CTX-${taskId}`,
    From_Node: from,
    To_Node: "node-a",
    Role: "user",
    Kind: "instruction",
    Created_At: fields.Created_At || "2026-01-15T09:00:00+0800",
  });
  if (text) {
    await mock.createRecord(TABLES.parts, {
      Part_ID: `${msgId}-P1`,
      Parent_ID: msgId,
      Parent_Type: "message",
      Seq: 1,
      Kind: "text",
      Text: text,
    });
  }
  if (params) {
    await mock.createRecord(TABLES.parts, {
      Part_ID: `${msgId}-P2`,
      Parent_ID: msgId,
      Parent_Type: "message",
      Seq: 2,
      Kind: "data",
      Data: JSON.stringify(params),
    });
  }
  const created = await mock.createRecord(TABLES.tasks, {
    Title: text || taskId,
    Source: from,
    Target_Node: "node-a",
    Skill_ID: "agent",
    Worker_Hint: "claude",
    Status: "submitted",
    Hop_Count: 0,
    Retry_Count: 0,
    Idempotency_Key: `key-${taskId}`,
    ...fields,
  });
  return created.record;
}

function taskOf(mock, taskId) {
  return mock.findRecords(TABLES.tasks, "Task_ID", taskId).then((rows) => rows[0]);
}

function makeKernel(dir, mock, extraCfg = {}) {
  return new Kernel({
    node: "node-a",
    role: "node",
    kind: "host",
    zone: "test",
    capPrefix: "test",
    events: false,
    maxConcurrent: 2,
    herdrWorkspace: "a2a-hub",
    configDir: dir,
    bus: mock,
    ...extraCfg,
  });
}

function writeHerdrWorker(dir, extra = {}) {
  fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
    workers: {
      claude: {
        context: "herdr",
        herdr_kind: "claude",
        timeout_sec: 120,
        ...extra,
      },
    },
  }), { mode: 0o600 });
}

// 默认 prompt 会在十几毫秒后自动 idle，扫表会把还没写 result.json 的回合当成交卷失败。
// 测试自己决定何时 setStatus("idle")。
function armHerdrWorld(world) {
  world.hooks.prompt = (agent) => {
    world.setStatus(agent, "working");
    return { type: "ok" };
  };
  world.hooks.keys = (agent) => { world.setStatus(agent, "idle"); };
}

function passGate(world, dir, taskId, receipt) {
  const ledger = readHerdrLedger(dir, taskId);
  writeGateResult(ledger.result_path, ledger.attempt_id, receipt);
  const agent = world.agents.get(ledger.agent_name);
  if (agent) world.setStatus(agent, "idle");
  return ledger;
}

test("config：EXEC_CONTROL_KEYS、LAUNCH_KEYS、inferHerdrKind 与 normalizeCommands 兼容", () => {
  assert.deepEqual(
    controlKeysIn({
      herdr_kind: "codex",
      herdr_args: ["--fast"],
      herdr_env: { A: "1" },
      herdr_session: "s1",
      herdr_workspace: "w1",
      timeout_sec: 120,
    }).sort(),
    ["herdr_args", "herdr_env", "herdr_kind", "herdr_session", "herdr_workspace"],
  );

  assert.equal(inferHerdrKind({ worker: "cursor-agent", command: "cursor-agent -p {prompt}" }), "cursor");
  assert.equal(inferHerdrKind({ worker: "custom", command: "/opt/bin/cursor-agent -p {prompt}" }), "cursor");
  assert.equal(inferHerdrKind({ worker: "claude", context: "herdr" }), "claude");

  const problems = [];
  const flat = normalizeCommands({
    workers: {
      claude: {
        context: "herdr",
        herdr_kind: "claude",
        herdr_args: ["--model", "sonnet"],
        herdr_env: { FOO: "bar" },
      },
    },
    code: {
      workers: ["claude"],
      herdr_kind: "codex",
      herdr_env: { FOO: "evil" },
    },
  }, (m) => problems.push(m));
  assert.equal(problems.length, 0);
  assert.equal(flat["claude/agent"].command, "claude {prompt}");
  assert.equal(flat["claude/code"].command, "claude {prompt}");
  assert.equal(flat["claude/code"].herdr_kind, "claude");
  assert.deepEqual(flat["claude/code"].herdr_env, { FOO: "bar" });
  assert.deepEqual(flat["claude/code"].herdr_args, ["--model", "sonnet"]);
});

test("loadConfig 读取 maxConcurrent、herdrSession 与 herdrWorkspace", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({
      node: "edge-1",
      role: "node",
      busType: "http",
      hubUrl: "http://127.0.0.1:8787",
      maxConcurrent: 6,
      herdrSession: "work",
      herdrWorkspace: "my-hub",
    }));
    const cfg = loadConfig(dir);
    assert.equal(cfg.maxConcurrent, 6);
    assert.equal(cfg.herdrSession, "work");
    assert.equal(cfg.herdrWorkspace, "my-hub");

    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({
      node: "edge-1",
      role: "node",
      busType: "http",
      hubUrl: "http://127.0.0.1:8787",
      maxConcurrent: 0,
    }));
    const fallback = loadConfig(dir);
    assert.equal(fallback.maxConcurrent, 4);
    assert.equal(fallback.herdrSession, "");
    assert.equal(fallback.herdrWorkspace, "a2a-hub");
  });
});

test("1. 同节点多任务并发认领与执行（maxConcurrent=2，3任务排队与补位）", () => withFake(async (fake) => {
  const world = new FakeHerdrWorld(fake);
  armHerdrWorld(world);
  await withTemp(async (dir) => {
    writeHerdrWorker(dir, {
      herdr_args: ["--dangerously-skip-permissions"],
      herdr_env: { CUSTOM_FLAG: "yes" },
    });
    const mock = new MockBus({ tables: TABLES });
    const kernel = makeKernel(dir, mock, { herdrSocketPath: fake.socketPath });
    try {
      await seedTask(mock, { Task_ID: "TASK-H-1" });
      await seedTask(mock, { Task_ID: "TASK-H-2" });
      await seedTask(mock, { Task_ID: "TASK-H-3" });
      await kernel.sweepOnce();

      assert.equal(f1(await taskOf(mock, "TASK-H-1"), "Status"), "working");
      assert.equal(f1(await taskOf(mock, "TASK-H-2"), "Status"), "working");
      assert.equal(f1(await taskOf(mock, "TASK-H-3"), "Status"), "submitted");
      assert.equal(kernel.activeHerdrCount(), 2);

      for (const tid of ["TASK-H-1", "TASK-H-2"]) {
        const tab = world.tabCreates.find((t) => t.label === tid);
        assert.ok(tab, tid);
        assert.equal(tab.env.AH_TASK_ID, tid);
        assert.equal(tab.env.AH_NODE, "node-a");
        assert.equal(tab.env.AH_WORKER, "claude");
        assert.equal(tab.env.AH_RUN_DIR, path.join(dir, "runs", tid));
        assert.equal(tab.env.AH_INPUT_PATH, path.join(dir, "runs", tid, "input.json"));
        assert.equal(tab.env.AH_RECEIPT_PATH, path.join(dir, "runs", tid, "receipt.txt"));
        assert.equal(tab.env.CUSTOM_FLAG, "yes");
        assert.equal(tab.env.A2A_TASK_ID, tid);
        const ledger = readHerdrLedger(dir, tid);
        assert.equal(ledger.state, "working");
        assert.equal(ledger.agent_name, herdrAgentName(tid));
        assert.equal(fs.statSync(path.join(dir, "runs", tid, "herdr.json")).mode & 0o777, 0o600);
        const started = world.req("agent.start").find((s) => s.name === ledger.agent_name);
        assert.deepEqual(started.args, ["--dangerously-skip-permissions"]);
        const prompt = world.prompts.find((item) => item.target === ledger.agent_name);
        assert.match(prompt.text, /^A2A task: /);
        assert.ok(Buffer.byteLength(prompt.text) <= MAX_POINTER_PROMPT_BYTES);
        assert.doesNotMatch(prompt.text, /你是中台节点/);
      }

      passGate(world, dir, "TASK-H-1", "任务1已完成。\n");
      await kernel.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-H-1"), "Status"), "completed");
      assert.equal(readHerdrLedger(dir, "TASK-H-1"), null);
      assert.equal([...world.tabs.values()].some((t) => t.label === "TASK-H-1"), false);
      assert.equal(f1(await taskOf(mock, "TASK-H-2"), "Status"), "working");
      assert.equal(f1(await taskOf(mock, "TASK-H-3"), "Status"), "working");
      assert.equal(kernel.activeHerdrCount(), 2);

      passGate(world, dir, "TASK-H-2", "任务2已完成。\n");
      passGate(world, dir, "TASK-H-3", "任务3已完成。\n");
      await kernel.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-H-2"), "Status"), "completed");
      assert.equal(f1(await taskOf(mock, "TASK-H-3"), "Status"), "completed");
      assert.equal(kernel.activeHerdrCount(), 0);
      assert.equal(world.tabs.size, 0);
    } finally {
      kernel.stopHerdrTimers();
    }
  });
}));

test("2. input-required 与 auth-required 驻留占槽与原地热续接（不被槽满挡住）", () => withFake(async (fake) => {
  const world = new FakeHerdrWorld(fake);
  armHerdrWorld(world);
  await withTemp(async (dir) => {
    const hubKey = loadOrCreateHubKey(dir);
    writeHerdrWorker(dir);
    const mock = new MockBus({ tables: TABLES });
    const kernel = makeKernel(dir, mock, { herdrSocketPath: fake.socketPath, hubPublicKey: hubKey.publicKey });
    try {
      await seedTask(mock, { Task_ID: "TASK-A", Context_ID: "CTX-A" });
      await seedTask(mock, { Task_ID: "TASK-B", Context_ID: "CTX-B" });
      await seedTask(mock, { Task_ID: "TASK-C", Context_ID: "CTX-C" });
      await kernel.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-A"), "Status"), "working");
      assert.equal(f1(await taskOf(mock, "TASK-B"), "Status"), "working");
      assert.equal(f1(await taskOf(mock, "TASK-C"), "Status"), "submitted");

      passGate(world, dir, "TASK-A", "```agent-ask\n请确认目标分支名称？\n```\n");
      await kernel.sweepOnce();
      const taskA1 = await taskOf(mock, "TASK-A");
      assert.equal(f1(taskA1, "Status"), "input-required");
      assert.equal(f1(await taskOf(mock, "TASK-C"), "Status"), "submitted", "驻留任务 A 仍占槽，C 不得抢占");
      assert.equal(kernel.activeHerdrCount(), 2);
      assert.equal([...world.tabs.values()].some((t) => t.label === "TASK-A"), true);
      assert.equal(readHerdrLedger(dir, "TASK-A").state, "parked");
      const tabsBefore = world.tabCreates.length;

      await mock.createRecord(TABLES.messages, {
        Msg_ID: "MSG-A-03", Task_ID: "TASK-A", Context_ID: "CTX-A",
        From_Node: "hub", To_Node: "node-a", Role: "user", Kind: "answer",
        In_Reply_To: f1(taskA1, "Status_Msg"), Created_At: "2026-01-15T09:05:00+0800",
      });
      await mock.createRecord(TABLES.parts, {
        Part_ID: "MSG-A-03-P1", Parent_ID: "MSG-A-03", Parent_Type: "message",
        Seq: 1, Kind: "text", Text: "main",
      });
      await kernel.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-A"), "Status"), "working");
      assert.equal(world.tabCreates.length, tabsBefore, "热续接不应创建新 Tab");
      assert.equal(world.prompts.filter((item) => item.target === herdrAgentName("TASK-A")).length, 2);
      assert.equal(readHerdrLedger(dir, "TASK-A").turn_count, 2);
      const inputA = JSON.parse(fs.readFileSync(path.join(dir, "runs", "TASK-A", "input.json"), "utf8"));
      assert.equal(inputA.turns[0].answer, "main");

      passGate(world, dir, "TASK-A", "```agent-auth\n推送代码到 origin/main\n```\n");
      await kernel.sweepOnce();
      const taskA2 = await taskOf(mock, "TASK-A");
      assert.equal(f1(taskA2, "Status"), "auth-required");
      assert.equal([...world.tabs.values()].some((t) => t.label === "TASK-A"), true);
      assert.equal(readHerdrLedger(dir, "TASK-A").state, "parked");
      assert.equal(kernel.activeHerdrCount(), 2);

      const authReqId = f1(taskA2, "Status_Msg");
      const sig = signDecision(hubKey.privateKey, { taskId: "TASK-A", requestId: authReqId, decision: "approve" });
      await mock.createRecord(TABLES.messages, {
        Msg_ID: "MSG-A-05", Task_ID: "TASK-A", Context_ID: "CTX-A",
        From_Node: "hub", To_Node: "node-a", Role: "user", Kind: "auth_decision",
        In_Reply_To: authReqId, Created_At: "2026-01-15T09:06:00+0800",
      });
      await mock.createRecord(TABLES.parts, {
        Part_ID: "MSG-A-05-P1", Parent_ID: "MSG-A-05", Parent_Type: "message",
        Seq: 1, Kind: "data", Data: JSON.stringify({ decision: "approve", sig }),
      });
      await kernel.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-A"), "Status"), "working");
      assert.equal(world.tabCreates.length, tabsBefore, "auth-required 热续接不应新建 Tab");
      assert.equal(world.prompts.filter((item) => item.target === herdrAgentName("TASK-A")).length, 3);
      assert.equal(readHerdrLedger(dir, "TASK-A").turn_count, 3);
      const inputA2 = JSON.parse(fs.readFileSync(path.join(dir, "runs", "TASK-A", "input.json"), "utf8"));
      assert.equal(inputA2.approvals.length, 1);
      assert.equal(inputA2.approvals[0].decision, "approve");

      passGate(world, dir, "TASK-A", "已推送到 main。\n");
      await kernel.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-A"), "Status"), "completed");
      assert.equal([...world.tabs.values()].some((t) => t.label === "TASK-A"), false);
      assert.equal(readHerdrLedger(dir, "TASK-A"), null);
      assert.equal(f1(await taskOf(mock, "TASK-C"), "Status"), "working");
    } finally {
      kernel.stopHerdrTimers();
    }
  });
}));

test("3. 热续接失败（Pane 意外丢失）时自动冷启动重建兜底", () => withFake(async (fake) => {
  const world = new FakeHerdrWorld(fake);
  armHerdrWorld(world);
  await withTemp(async (dir) => {
    writeHerdrWorker(dir);
    const mock = new MockBus({ tables: TABLES });
    const kernel = makeKernel(dir, mock, { herdrSocketPath: fake.socketPath });
    try {
      await seedTask(mock, { Task_ID: "TASK-FALLBACK", Context_ID: "CTX-FB" });
      await kernel.sweepOnce();
      const agentName = herdrAgentName("TASK-FALLBACK");
      passGate(world, dir, "TASK-FALLBACK", "```agent-ask\n继续吗？\n```\n");
      await kernel.sweepOnce();
      const paused = await taskOf(mock, "TASK-FALLBACK");
      assert.equal(f1(paused, "Status"), "input-required");
      assert.equal(world.tabCreates.length, 1);

      world.agents.delete(agentName);
      await mock.createRecord(TABLES.messages, {
        Msg_ID: "MSG-FALLBACK-03", Task_ID: "TASK-FALLBACK", Context_ID: "CTX-FB",
        From_Node: "hub", To_Node: "node-a", Role: "user", Kind: "answer",
        In_Reply_To: f1(paused, "Status_Msg"), Created_At: "2026-01-15T09:10:00+0800",
      });
      await mock.createRecord(TABLES.parts, {
        Part_ID: "MSG-FALLBACK-03-P1", Parent_ID: "MSG-FALLBACK-03", Parent_Type: "message",
        Seq: 1, Kind: "text", Text: "继续",
      });
      await kernel.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-FALLBACK"), "Status"), "working");
      assert.equal(world.tabCreates.length, 2, "原 Pane 丢失后应冷重开新 Tab");
      assert.ok(world.agents.get(agentName));
      assert.equal(world.prompts.filter((item) => item.target === agentName).length, 2);

      passGate(world, dir, "TASK-FALLBACK", "冷重建后顺利完成。\n");
      await kernel.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-FALLBACK"), "Status"), "completed");
      assert.equal(readHerdrLedger(dir, "TASK-FALLBACK"), null);
    } finally {
      kernel.stopHerdrTimers();
    }
  });
}));

test("3b. TUI blocked 态挂起占槽、回复后 send-keys 解阻并热续接，以及重启后从磁盘账本接管", () => withFake(async (fake) => {
  const world = new FakeHerdrWorld(fake);
  armHerdrWorld(world);
  await withTemp(async (dir) => {
    writeHerdrWorker(dir);
    const mock = new MockBus({ tables: TABLES });
    let kernel1 = null;
    let kernel2 = null;
    try {
      kernel1 = makeKernel(dir, mock, { herdrSocketPath: fake.socketPath });
      await seedTask(mock, { Task_ID: "TASK-BLK", Context_ID: "CTX-BLK" });
      await kernel1.sweepOnce();
      const agentName = herdrAgentName("TASK-BLK");
      const ag = world.agents.get(agentName);
      ag.screen = "Allow bash command rm -rf build/? [y/N]";
      world.setStatus(ag, "blocked");
      await kernel1.sweepOnce();
      const paused = await taskOf(mock, "TASK-BLK");
      assert.equal(f1(paused, "Status"), "input-required");
      assert.equal(readHerdrLedger(dir, "TASK-BLK").state, "parked");
      assert.equal(readHerdrLedger(dir, "TASK-BLK").blocked, true);

      kernel1.stopHerdrTimers();
      kernel1 = null;
      kernel2 = makeKernel(dir, mock, { herdrSocketPath: fake.socketPath });
      await kernel2.sweepOnce();
      assert.equal(kernel2.activeHerdrCount(), 1);
      assert.equal(kernel2._herdrFlights.get("TASK-BLK")?.state, "parked");

      await mock.createRecord(TABLES.messages, {
        Msg_ID: "MSG-BLK-03", Task_ID: "TASK-BLK", Context_ID: "CTX-BLK",
        From_Node: "hub", To_Node: "node-a", Role: "user", Kind: "answer",
        In_Reply_To: f1(paused, "Status_Msg"), Created_At: "2026-01-15T09:12:00+0800",
      });
      await mock.createRecord(TABLES.parts, {
        Part_ID: "MSG-BLK-03-P1", Parent_ID: "MSG-BLK-03", Parent_Type: "message",
        Seq: 1, Kind: "text", Text: "允许清理 build 目录",
      });
      await kernel2.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-BLK"), "Status"), "working");
      assert.equal(world.keys.length, 1);
      assert.deepEqual(world.keys[0].keys, ["esc"]);
      assert.equal(world.prompts.filter((item) => item.target === agentName).length, 2);
      assert.equal(world.tabCreates.length, 1);

      passGate(world, dir, "TASK-BLK", "已清理并构建通过。\n");
      await kernel2.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-BLK"), "Status"), "completed");
      assert.equal(kernel2.activeHerdrCount(), 0);
    } finally {
      kernel1?.stopHerdrTimers();
      kernel2?.stopHerdrTimers();
    }
  });
}));

test("4. setup 检测 herdr 自动配置 context/herdr_kind/maxConcurrent，doctor 校验通过", async () => {
  await withTemp(async (dir) => {
    const withHerdr = discoverLocalAgents({ useHerdr: true });
    const withoutHerdr = discoverLocalAgents({ useHerdr: false });
    for (const a of withHerdr) {
      if (a.herdrKind) {
        assert.equal(a.entry.context, "herdr");
        assert.equal(a.entry.herdr_kind, a.herdrKind);
        assert.ok(a.entry.command);
      }
    }
    for (const a of withoutHerdr) {
      assert.equal(a.entry.context, undefined);
      assert.equal(a.entry.herdr_kind, undefined);
    }

    // runSetup 在存在 herdr 的宿主机上自动配置 maxConcurrent 与 context=herdr
    const code = await runSetup(dir, [
      "--hub",
      "--node", "herdr-hub",
      "--listen", "127.0.0.1:18899",
      "--yes",
      "--skip-skill",
    ], ROOT);
    assert.equal(code, 0);

    const nodeJson = JSON.parse(fs.readFileSync(path.join(dir, "node.json"), "utf8"));
    const cmdsJson = JSON.parse(fs.readFileSync(path.join(dir, "commands.json"), "utf8"));
    if (withHerdr.some((a) => a.herdrKind)) {
      assert.equal(nodeJson.maxConcurrent, 4);
      const herdrWorker = Object.values(cmdsJson.workers || {}).find((w) => w.context === "herdr");
      assert.ok(herdrWorker, "setup 应写入至少一个 context=herdr 的 Worker");
      assert.ok(herdrWorker.herdr_kind);
    }

    // doctor 对纯 herdr_kind（无手写 command）配置也校验通过
    const docDir = path.join(dir, "doc-only");
    fs.mkdirSync(docDir, { recursive: true });
    fs.writeFileSync(path.join(docDir, "node.json"), JSON.stringify({
      node: "edge-herdr",
      role: "node",
      busType: "http",
      hubUrl: "http://127.0.0.1:8787",
      maxConcurrent: 4,
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(docDir, "commands.json"), JSON.stringify({
      workers: {
        claude: { context: "herdr", herdr_kind: "claude", name: "Claude" },
      },
    }), { mode: 0o600 });

    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      const rc = await doctor(docDir, ROOT);
      // 仅检查 commands.json 校验段落通过（远程 Hub 未启动不计入 commands 校验）
      const out = lines.join("\n");
      assert.match(out, /✓ commands\.json 字段校验通过/);
      assert.doesNotMatch(out, /context="herdr" 非法/);
      void rc;
    } finally {
      console.log = origLog;
    }
  });
});

// ======================================================================
// Herdr Socket 层（src/herdr-socket.mjs）与 Fake Socket Server 夹具
// ======================================================================
//
// 夹具照搬 0.9.5 真实服务端的实测行为，测试才有意义：
//   - 控制请求：只处理连接上的第一行，应答后立刻关连接；
//   - events.subscribe：确认后连接只读，客户端再写任何一行都会被断开；
//   - 订阅里只要有一个 pane 不存在，整条请求被拒绝并断连。
class FakeHerdrServer {
  constructor() {
    this.handlers = new Map();
    this.requests = [];
    this.rawLines = [];
    this.subscribers = new Set();
    this.subscribeRequests = [];
    this.connectionCount = 0;
    this.subscribeError = null;
    this.server = null;
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-"));
    this.socketPath = path.join(this.dir, "h.sock");
    this._conns = new Set();
  }

  async start() {
    this.server = net.createServer((conn) => this._onConnection(conn));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
    return this;
  }

  // 模拟服务端消失：关监听并掐断所有连接。
  async stop() {
    const server = this.server;
    this.server = null;
    for (const c of this._conns) c.destroy();
    this.subscribers.clear();
    if (server) await new Promise((resolve) => server.close(resolve));
  }

  async restart() {
    try { fs.unlinkSync(this.socketPath); } catch { /* 已清理 */ }
    await this.start();
  }

  async dispose() {
    await this.stop();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  // handler(params, request) 返回 result 对象；抛 {code,message} 即错误应答。
  // 特殊返回值：{__hang:true} 不应答；{__hangup:true} 直接断开；{__badId:true} 回错误的 id；
  // {__emptyIdError:{code,message}} 回空 id 的错误；{__chunks:[Buffer|string], gapMs} 分块写出整行应答。
  on(method, handler) {
    this.handlers.set(method, handler);
    return this;
  }

  push(event, data) {
    // protocol22 全局事件带 EventData.type；pane 专属点号事件没有这个字段。
    this.pushRaw(JSON.stringify({ event, data: event.includes(".") ? data : { type: event, ...data } }) + "\n");
  }

  pushRaw(chunk) {
    for (const c of this.subscribers) c.write(chunk);
  }

  // 订阅连接上推送错误帧后断开（events_lost 的真实形态）。
  pushErrorAndClose(code, message = code) {
    const subs = [...this.subscribers];
    this.subscribers.clear();
    for (const c of subs) c.end(JSON.stringify({ id: c._subId, error: { code, message } }) + "\n");
  }

  dropSubscribers() {
    const subs = [...this.subscribers];
    this.subscribers.clear();
    for (const c of subs) c.destroy();
  }

  _onConnection(conn) {
    this.connectionCount += 1;
    this._conns.add(conn);
    conn.setEncoding("utf8");
    conn.on("close", () => { this._conns.delete(conn); this.subscribers.delete(conn); });
    conn.on("error", () => {});
    let buf = "";
    let handled = false;
    conn.on("data", (chunk) => {
      if (conn._isSub) { conn.destroy(); return; }
      if (handled) return;
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      handled = true;
      void this._handle(conn, buf.slice(0, nl));
    });
  }

  async _handle(conn, line) {
    this.rawLines.push(line);
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      conn.end(JSON.stringify({ id: "", error: { code: "invalid_request", message: "invalid json" } }) + "\n");
      return;
    }
    this.requests.push(req);
    const reply = (obj) => conn.end(JSON.stringify(obj) + "\n");
    if (req.method === "events.subscribe") {
      this.subscribeRequests.push(req.params);
      const err = this.subscribeError?.(req.params);
      if (err) { reply({ id: req.id, error: err }); return; }
      conn._isSub = true;
      conn._subId = req.id;
      this.subscribers.add(conn);
      conn.write(JSON.stringify({ id: req.id, result: { type: "subscription_started" } }) + "\n");
      return;
    }
    const handler = this.handlers.get(req.method);
    if (!handler) {
      reply({ id: req.id, error: { code: "invalid_request", message: `unknown variant \`${req.method}\`` } });
      return;
    }
    try {
      const out = await handler(req.params, req);
      if (out?.__hang) return;
      if (out?.__hangup) { conn.destroy(); return; }
      if (out?.__badId) { reply({ id: "someone-else", result: { type: "ok" } }); return; }
      if (out?.__emptyIdError) { reply({ id: "", error: out.__emptyIdError }); return; }
      if (out?.__chunks) {
        for (const part of out.__chunks) {
          conn.write(part);
          await new Promise((r) => setTimeout(r, out.gapMs ?? 10));
        }
        conn.end();
        return;
      }
      reply({ id: req.id, result: out });
    } catch (e) {
      reply({ id: req.id, error: { code: e.code ?? "internal", message: e.message ?? String(e) } });
    }
  }
}

async function withFake(fn) {
  const fake = await new FakeHerdrServer().start();
  try {
    return await fn(fake);
  } finally {
    await fake.dispose();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 断言失败会跳过用例末尾的 stop()，重连循环就会一直占着事件循环，让整个测试进程挂住。
// 所有用例创建的 HerdrEvents 都登记在这里，afterEach 统一停掉。
const liveEvents = [];
class TrackedEvents extends HerdrEvents {
  constructor(opts) {
    super(opts);
    liveEvents.push(this);
  }
}
afterEach(() => {
  for (const ev of liveEvents.splice(0)) ev.stop();
});

const FAST_BACKOFF = { baseMs: 5, maxMs: 20, jitter: 0 };

test("socket 路径发现：显式路径优先，未核验 named-session/Windows 默认布局拒绝猜测", () => {
  const base = { homedir: "/home/u", platform: "linux" };
  assert.deepEqual(
    discoverSocketPath({ ...base, socketPath: "/x/a.sock", env: { HERDR_SOCKET_PATH: "/e.sock", HERDR_SESSION: "s" }, session: "t" }),
    { path: "/x/a.sock", source: "config" },
  );
  assert.deepEqual(
    discoverSocketPath({ ...base, env: { HERDR_SOCKET_PATH: "/e.sock", HERDR_SESSION: "s" }, session: "t" }),
    { path: "/e.sock", source: "env:HERDR_SOCKET_PATH" },
  );
  // M0 未证实 named-session 布局；不能用猜测路径维持虚假的兼容性。
  assert.throws(() => discoverSocketPath({ ...base, env: { HERDR_SESSION: "envs" }, session: "cfgs" }), (e) => e.code === "socket_path_unverified");
  assert.throws(() => discoverSocketPath({ ...base, env: { HERDR_SESSION: "envs" } }), (e) => e.code === "socket_path_unverified");
  // 空串视为未设置，不能把空 HERDR_SOCKET_PATH 当成有效路径。
  assert.deepEqual(
    discoverSocketPath({ ...base, env: { HERDR_SOCKET_PATH: "  ", HERDR_SESSION: "" } }),
    { path: "/home/u/.config/herdr/herdr.sock", source: "default" },
  );
  assert.throws(() => discoverSocketPath({ ...base, session: "../evil", env: {} }), (e) => e.code === "invalid_request");
  // Windows：显式路径（命名管道）原样放行，缺省时报错而不是猜一个 Unix 路径。
  assert.equal(discoverSocketPath({ platform: "win32", env: { HERDR_SOCKET_PATH: "\\\\.\\pipe\\herdr" } }).path, "\\\\.\\pipe\\herdr");
  assert.throws(() => discoverSocketPath({ platform: "win32", env: {} }), (e) => e.code === "server_unavailable");
});

test("错误归一：已知码归类，*_not_found 同类，未知码原样保留", () => {
  assert.equal(classifyErrorCode("agent_blocked"), "blocked");
  assert.equal(classifyErrorCode("agent_prompt_stalled"), "prompt_stalled");
  assert.equal(classifyErrorCode("agent_not_running"), "not_running");
  assert.equal(classifyErrorCode("agent_not_ready"), "not_ready");
  assert.equal(classifyErrorCode("agent_pane_busy"), "shell_not_ready");
  assert.equal(classifyErrorCode("agent_pane_unavailable"), "shell_not_ready");
  for (const c of ["not_found", "pane_not_found", "agent_not_found", "tab_not_found", "workspace_not_found"]) {
    assert.equal(classifyErrorCode(c), "not_found", c);
  }
  assert.equal(classifyErrorCode("events_lost"), "events_lost");
  assert.equal(classifyErrorCode("some_future_code"), "other");
  const err = new HerdrError("some_future_code", "x");
  assert.equal(err.code, "some_future_code");
  assert.equal(err.category, "other");
});

test("backoffDelay：指数增长、封顶、抖动只往下缩", () => {
  const opts = { baseMs: 250, maxMs: 8000, factor: 2, jitter: 0.5 };
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffDelay(n, opts, () => 0)), [250, 500, 1000, 2000, 4000, 8000, 8000, 8000, 8000]);
  assert.equal(backoffDelay(3, opts, () => 1), 1000, "random=1 时抖动取最大，延迟减半");
  assert.equal(backoffDelay(3, opts, () => 0.5), 1500);
});

test("事件名归一：下划线推送名 → 点号订阅名", () => {
  assert.equal(normalizeEventName("pane_agent_status_changed"), "pane.agent_status_changed");
  assert.equal(normalizeEventName("pane_moved"), "pane.moved");
  assert.equal(normalizeEventName("layout_updated"), "layout.updated");
  assert.deepEqual(paneStatusSubscription("w1:p2"), { type: "pane.agent_status_changed", pane_id: "w1:p2" });
});

test("Control：无参请求显式带 params:{}，且每次调用独立短连接（服务端应答后即关）", () => withFake(async (fake) => {
  fake.on("ping", () => ({ type: "pong", version: "x", protocol: 22 }));
  const control = new HerdrControl({ socketPath: fake.socketPath });
  const r1 = await control.call("ping");
  const r2 = await control.call("ping");
  assert.equal(r1.type, "pong");
  assert.equal(r2.type, "pong");
  assert.equal(fake.connectionCount, 2, "第二次调用不能依赖第一次的连接");
  for (const line of fake.rawLines) {
    const req = JSON.parse(line);
    assert.deepEqual(req.params, {}, "无参请求必须带 params:{}");
    assert.match(req.id, /^ah-\d+$/);
  }
  assert.notEqual(JSON.parse(fake.rawLines[0]).id, JSON.parse(fake.rawLines[1]).id);
}));

test("Control：并发调用按 id 各取各的结果，慢请求不堵快请求", () => withFake(async (fake) => {
  const order = [];
  fake.on("slow", async () => { await sleep(80); return { type: "slow" }; });
  fake.on("fast", async () => ({ type: "fast" }));
  const control = new HerdrControl({ socketPath: fake.socketPath });
  const slow = control.call("slow").then((r) => { order.push("slow"); return r; });
  const fast = control.call("fast").then((r) => { order.push("fast"); return r; });
  const [s, f] = await Promise.all([slow, fast]);
  assert.equal(s.type, "slow");
  assert.equal(f.type, "fast");
  assert.deepEqual(order, ["fast", "slow"]);
  assert.equal(control.inflightCount, 0);
}));

test("Control：服务端错误码归一并带上 method，未知码不被吞", () => withFake(async (fake) => {
  const control = new HerdrControl({ socketPath: fake.socketPath });
  for (const [code, category] of [
    ["pane_not_found", "not_found"],
    ["agent_blocked", "blocked"],
    ["agent_prompt_stalled", "prompt_stalled"],
    ["agent_not_running", "not_running"],
    ["brand_new_code", "other"],
  ]) {
    fake.on("agent.prompt", () => { throw Object.assign(new Error(`msg ${code}`), { code }); });
    await assert.rejects(control.call("agent.prompt", { target: "a", text: "t" }), (e) => {
      assert.ok(e instanceof HerdrError);
      assert.equal(e.code, code);
      assert.equal(e.category, category);
      assert.equal(e.method, "agent.prompt");
      assert.equal(e.local, false);
      assert.equal(e.message, `msg ${code}`);
      return true;
    });
  }
  // 服务端对无法解码的请求会回空 id，仍是对这条请求的应答。
  fake.on("bad", () => ({ __emptyIdError: { code: "invalid_request", message: "bad" } }));
  await assert.rejects(control.call("bad"), (e) => e.code === "invalid_request" && e.local === false);
}));

test("Control：客户端超时与 AbortSignal 分别报 timeout / aborted，且不泄漏 inflight", () => withFake(async (fake) => {
  fake.on("hang", () => ({ __hang: true }));
  const control = new HerdrControl({ socketPath: fake.socketPath });
  await assert.rejects(control.call("hang", {}, { timeoutMs: 40 }), (e) => e.code === "timeout" && e.local === true && e.category === "timeout");
  assert.equal(control.inflightCount, 0);

  const pre = new AbortController();
  pre.abort();
  const before = fake.connectionCount;
  await assert.rejects(control.call("hang", {}, { signal: pre.signal }), (e) => e.code === "aborted");
  assert.equal(fake.connectionCount, before, "已取消的信号不能再建连");

  const mid = new AbortController();
  const p = control.call("hang", {}, { signal: mid.signal, timeoutMs: 5000 });
  await sleep(30);
  assert.equal(control.inflightCount, 1);
  mid.abort();
  await assert.rejects(p, (e) => e.code === "aborted" && e.local === true);
  assert.equal(control.inflightCount, 0);
}));

test("Control：断连、服务不可用、id 不匹配、应答分块（含多字节字符被切开）", () => withFake(async (fake) => {
  const control = new HerdrControl({ socketPath: fake.socketPath });
  fake.on("hangup", () => ({ __hangup: true }));
  await assert.rejects(control.call("hangup"), (e) => e.code === "connection_closed");

  fake.on("badid", () => ({ __badId: true }));
  await assert.rejects(control.call("badid"), (e) => e.code === "protocol_error");

  // “验收”各 3 字节，在第 2 个字节处切开，客户端必须拼回完整文本。
  fake.on("chunky", (_p, req) => {
    const bytes = Buffer.from(JSON.stringify({ id: req.id, result: { type: "pane_read", text: "验收通过\n第二行" } }) + "\n");
    const cut = bytes.indexOf(Buffer.from("验")) + 1;
    return { __chunks: [bytes.subarray(0, cut), bytes.subarray(cut, cut + 7), bytes.subarray(cut + 7)], gapMs: 15 };
  });
  const out = await control.call("chunky");
  assert.equal(out.text, "验收通过\n第二行");

  await fake.stop();
  await assert.rejects(control.call("ping"), (e) => e.code === "server_unavailable" && e.category === "unavailable");
}));

test("Control：close() 立刻拒绝在途调用，之后的调用直接失败", () => withFake(async (fake) => {
  fake.on("hang", () => ({ __hang: true }));
  const control = new HerdrControl({ socketPath: fake.socketPath });
  const p = control.call("hang", {}, { timeoutMs: 5000 });
  await sleep(20);
  control.close();
  await assert.rejects(p, (e) => e.code === "connection_closed");
  await assert.rejects(control.call("ping"), (e) => e.code === "connection_closed");
}));

test("ping：协议版本低于下限报 protocol_unsupported，达标则透传 pong", () => withFake(async (fake) => {
  const h = createHerdrSocket({ socketPath: fake.socketPath });
  fake.on("ping", () => ({ type: "pong", version: "0.9.5", protocol: HERDR_PROTOCOL_MIN }));
  assert.equal((await h.ping()).protocol, HERDR_PROTOCOL_MIN);
  fake.on("ping", () => ({ type: "pong", version: "0.1.0", protocol: HERDR_PROTOCOL_MIN - 1 }));
  await assert.rejects(h.ping(), (e) => e.code === "protocol_unsupported" && /0\.1\.0/.test(e.message));
  assert.throws(() => assertProtocol({ version: "?" }), (e) => e.code === "protocol_unsupported");
  h.close();
}));

test("Events：订阅确认后收到事件，粘包与半包都能拆对，事件名归一为点号", () => withFake(async (fake) => {
  const events = new TrackedEvents({ socketPath: fake.socketPath, subscriptions: [{ type: "pane.moved" }], backoff: FAST_BACKOFF });
  const seen = [];
  events.on("event", (e) => seen.push(e));
  await events.start();
  assert.deepEqual(fake.subscribeRequests, [{ subscriptions: [{ type: "pane.moved" }] }]);

  fake.pushRaw(
    JSON.stringify({ event: "pane_moved", data: { type: "pane_moved", n: 1 } }) + "\n" + JSON.stringify({ event: "pane_agent_status_changed", data: { type: "pane_agent_status_changed", n: 2 } }) + "\n",
  );
  const third = Buffer.from(JSON.stringify({ event: "tab_created", data: { type: "tab_created", label: "任务甲" } }) + "\n");
  const cut = third.indexOf(Buffer.from("务")) + 1;
  fake.pushRaw(third.subarray(0, cut));
  await sleep(20);
  fake.pushRaw(third.subarray(cut));
  await sleep(30);

  assert.deepEqual(seen.map((e) => e.event), ["pane.moved", "pane.agent_status_changed", "tab.created"]);
  assert.deepEqual(seen.map((e) => e.raw), ["pane_moved", "pane_agent_status_changed", "tab_created"]);
  assert.equal(seen[2].data.label, "任务甲");
  events.stop();
}));

test("Events：断线后带退避自动重连并发射 reconnected，重连时重新取订阅集合", () => withFake(async (fake) => {
  let calls = 0;
  const events = new TrackedEvents({
    socketPath: fake.socketPath,
    subscriptions: () => { calls += 1; return calls === 1 ? [{ type: "pane.moved" }] : [{ type: "pane.moved" }, { type: "pane.closed" }]; },
    backoff: FAST_BACKOFF,
    random: () => 0,
  });
  const log = [];
  const seen = [];
  events.on("ready", () => log.push("ready"));
  events.on("disconnected", () => log.push("disconnected"));
  events.on("reconnected", () => log.push("reconnected"));
  events.on("event", (e) => seen.push(e.event));
  await events.start();

  fake.dropSubscribers();
  await once(events, "reconnected");
  assert.deepEqual(log, ["ready", "disconnected", "reconnected"]);
  assert.equal(fake.subscribeRequests.length, 2);
  assert.deepEqual(fake.subscribeRequests[1].subscriptions, [{ type: "pane.moved" }, { type: "pane.closed" }], "重连必须按最新 provider 重订");

  // 重连后事件照常到达；断线期间的事件不补发（事件只是失效信号，由调用方 snapshot 对账）。
  fake.push("pane_closed", { pane_id: "w1:p1" });
  await sleep(20);
  assert.deepEqual(seen, ["pane.closed"]);

  // 连续两次断线：每次都恢复，且 reconnected 只在确认之后发射。
  fake.dropSubscribers();
  await once(events, "reconnected");
  assert.equal(fake.subscribeRequests.length, 3);
  events.stop();
}));

test("Events：服务端起晚了也能连上；start() 在确认前不 resolve", () => withFake(async (fake) => {
  await fake.stop();
  const events = new TrackedEvents({ socketPath: fake.socketPath, backoff: FAST_BACKOFF, random: () => 0 });
  let disconnects = 0;
  events.on("disconnected", () => { disconnects += 1; });
  let ready = false;
  const started = events.start().then(() => { ready = true; });
  await sleep(60);
  assert.equal(ready, false);
  assert.ok(disconnects >= 2, `应该已经退避重试多次，实际 ${disconnects}`);
  await fake.restart();
  await started;
  assert.equal(ready, true);
  assert.equal(events.ready, true);
  events.stop();
}));

test("Events：events_lost 先发 lost，再自动重订并发 reconnected", () => withFake(async (fake) => {
  const events = new TrackedEvents({ socketPath: fake.socketPath, backoff: FAST_BACKOFF, random: () => 0 });
  const log = [];
  events.on("lost", (e) => log.push(`lost:${e.code}`));
  events.on("reconnected", () => log.push("reconnected"));
  await events.start();
  fake.pushErrorAndClose("events_lost", "subscriber fell behind");
  await once(events, "reconnected");
  assert.deepEqual(log, ["lost:events_lost", "reconnected"]);
  events.stop();
}));

test("Events：订阅被拒（pane_not_found）时发 subscribe_error，剪掉失效 pane 后重订成功", () => withFake(async (fake) => {
  fake.subscribeError = (params) => (params.subscriptions.some((s) => s.pane_id === "w9:p9")
    ? { code: "pane_not_found", message: "pane w9:p9 not found" }
    : null);
  const panes = new Set(["w1:p1", "w9:p9"]);
  const events = new TrackedEvents({
    socketPath: fake.socketPath,
    subscriptions: () => [...panes].map((id) => paneStatusSubscription(id)),
    backoff: FAST_BACKOFF,
    random: () => 0,
  });
  const errors = [];
  events.on("subscribe_error", (e) => { errors.push(e.code); panes.delete("w9:p9"); });
  await events.start();
  assert.deepEqual(errors, ["pane_not_found"]);
  assert.deepEqual(fake.subscribeRequests.at(-1).subscriptions, [paneStatusSubscription("w1:p1")]);
  events.stop();
}));

test("Events：订阅请求本身非法（invalid_request）是致命错误，start() reject 且不再重试", () => withFake(async (fake) => {
  fake.subscribeError = () => ({ code: "invalid_request", message: "unknown variant" });
  const events = new TrackedEvents({ socketPath: fake.socketPath, backoff: FAST_BACKOFF });
  let fatal = null;
  events.on("fatal", (e) => { fatal = e; });
  await assert.rejects(events.start(), (e) => e.code === "invalid_request");
  const attempts = fake.subscribeRequests.length;
  await sleep(60);
  assert.equal(fatal?.code, "invalid_request");
  assert.equal(fake.subscribeRequests.length, attempts, "致命错误之后不能继续重连");
}));

test("Events：refresh() 立即按新订阅集合重订，不走故障退避", () => withFake(async (fake) => {
  let subs = [paneStatusSubscription("w1:p1")];
  // 退避设成 5s：如果 refresh 误走退避，下面 1s 的等待必然超时。
  const events = new TrackedEvents({ socketPath: fake.socketPath, subscriptions: () => subs, backoff: { baseMs: 5000, maxMs: 5000, jitter: 0 } });
  await events.start();
  subs = [paneStatusSubscription("w1:p1"), paneStatusSubscription("w1:p2")];
  const reconnected = once(events, "reconnected", { signal: AbortSignal.timeout(1000) });
  events.refresh();
  await reconnected;
  assert.deepEqual(fake.subscribeRequests.at(-1).subscriptions.map((s) => s.pane_id), ["w1:p1", "w1:p2"]);
  events.stop();
}));

test("Events：stop() 之后不再重连，确认前 stop 会让 start() reject", () => withFake(async (fake) => {
  const events = new TrackedEvents({ socketPath: fake.socketPath, backoff: FAST_BACKOFF, random: () => 0 });
  await events.start();
  events.stop();
  fake.dropSubscribers();
  const n = fake.connectionCount;
  await sleep(60);
  assert.equal(fake.connectionCount, n, "stop 之后不能再建连");

  await fake.stop();
  const early = new TrackedEvents({ socketPath: fake.socketPath, backoff: FAST_BACKOFF, random: () => 0 });
  const p = early.start();
  await sleep(30);
  early.stop();
  await assert.rejects(p, (e) => e.code === "connection_closed");
}));

test("契约：固定 Herdr 0.9.5/protocol22 Schema，无真实二进制调用", () => {
  const raw = fs.readFileSync(path.join(ROOT, "tests/fixtures/herdr-protocol22.schema.json"));
  const provenance = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/herdr-protocol22.provenance.json"), "utf8"));
  assert.equal(createHash("sha256").update(raw).digest("hex"), provenance.raw_stdout_sha256);
  assert.equal(provenance.herdr_version, "0.9.5");
  const doc = JSON.parse(raw);
  assert.equal(doc.protocol, HERDR_PROTOCOL_MIN);
  assert.equal(doc.schema_version, 1);
  const subTypes = new Set(
    (doc.schemas.request.$defs.Subscription.oneOf ?? []).map((v) => v.properties?.type?.const).filter(Boolean),
  );
  for (const sub of LIFECYCLE_SUBSCRIPTIONS) assert.ok(subTypes.has(sub.type), `schema 里没有订阅类型 ${sub.type}`);
  assert.ok(subTypes.has(paneStatusSubscription("w1:p1").type));
  const readSources = doc.schemas.request.$defs.ReadSource.enum;
  assert.ok(readSources.includes("recent_unwrapped"), "Socket 的读屏源应为 recent_unwrapped（下划线）");
  assert.ok(!readSources.includes("recent-unwrapped"));
});

// =====================================================================
// Phase 2：HerdrRuntime（L2）。全部跑在 Fake Socket Server 上，不需要真实 Herdr 进程。
// =====================================================================

function herr(code, message = code) {
  return Object.assign(new Error(message), { code });
}

// 一个够用的 Herdr 世界模型：workspace / tab / pane / agent 与全部本层用到的方法。
// 行为钩子（hooks）让各用例按需制造 blocked、stalled、not_running 等异常。
class FakeHerdrWorld {
  constructor(fake) {
    this.fake = fake;
    this.workspaces = new Map();
    this.tabs = new Map();
    this.panes = new Map();
    this.agents = new Map();
    this.turnMs = 15;
    this.prompts = [];
    this.keys = [];
    this.explains = 0;
    this.waitCalls = 0;
    this.processes = new Map();
    this.hooks = {};
    this.inflight = 0;
    this.maxInflight = 0;
    this.removeWorktreeError = null;
    this.tabCreates = [];
    this.n = 40;
    this.install();
  }

  id(prefix) { this.n += 1; return `${prefix}${this.n}`; }

  addWorkspace(label = "ws") {
    const ws = { workspace_id: this.id("w"), label };
    this.workspaces.set(ws.workspace_id, ws);
    return ws;
  }

  addTab(workspaceId, label = "") {
    const tab = { tab_id: this.id("t"), workspace_id: workspaceId, label };
    this.tabs.set(tab.tab_id, tab);
    const pane = { pane_id: `${workspaceId}:${this.id("p")}`, workspace_id: workspaceId, tab_id: tab.tab_id };
    this.panes.set(pane.pane_id, pane);
    return { tab, pane };
  }

  addAgent(name, paneId, status = "idle") {
    const pane = this.panes.get(paneId);
    const a = {
      name, pane_id: paneId, workspace_id: pane.workspace_id, tab_id: pane.tab_id,
      agent_status: status, state_change_seq: 1, interactive_ready: true, launch_pending: false,
      screen: "", agent: "claude",
    };
    this.agents.set(name, a);
    return a;
  }

  // 直接造一个已经在跑的 Agent，返回其 pane。
  seedAgent(name, status = "idle") {
    const ws = this.workspaces.size ? [...this.workspaces.values()][0] : this.addWorkspace("a2a-hub");
    const { pane } = this.addTab(ws.workspace_id, name);
    return this.addAgent(name, pane.pane_id, status);
  }

  setStatus(a, status) {
    a.agent_status = status;
    a.state_change_seq += 1;
  }

  async runTurn(a, endStatus = "idle") {
    this.setStatus(a, "working");
    this.inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    await sleep(this.turnMs);
    this.inflight -= 1;
    this.setStatus(a, endStatus);
  }

  agentOf(target) {
    const hit = this.agents.get(target) ?? [...this.agents.values()].find((a) => a.pane_id === target);
    if (!hit) throw herr("agent_not_found", `agent ${target} not found`);
    return hit;
  }

  view(a) {
    const { screen: _screen, ...info } = a;
    return info;
  }

  snapshot() {
    return {
      protocol: 22, version: "fake",
      workspaces: [...this.workspaces.values()],
      tabs: [...this.tabs.values()],
      panes: [...this.panes.values()],
      agents: [...this.agents.values()].map((a) => this.view(a)),
      layouts: [],
    };
  }

  removeTab(tabId) {
    this.tabs.delete(tabId);
    for (const pane of [...this.panes.values()]) {
      if (pane.tab_id !== tabId) continue;
      this.panes.delete(pane.pane_id);
      for (const a of [...this.agents.values()]) if (a.pane_id === pane.pane_id) this.agents.delete(a.name);
    }
  }

  // 模拟用户把 pane 拖到另一个 workspace：pane_id 变了，agent 名字跟着走，并推送 pane_moved。
  movePane(a, { push = true } = {}) {
    const ws = this.addWorkspace("moved");
    const { tab, pane } = this.addTab(ws.workspace_id, "moved");
    const prev = a.pane_id;
    this.panes.delete(prev);
    a.pane_id = pane.pane_id;
    a.workspace_id = ws.workspace_id;
    a.tab_id = tab.tab_id;
    if (push) {
      this.fake.push("pane_moved", {
        type: "pane_moved", pane, previous_pane_id: prev, previous_tab_id: "x", previous_workspace_id: "x",
        closed_tab_id: null, closed_workspace_id: null,
      });
    }
    return { prev, pane };
  }

  install() {
    const { fake } = this;
    fake.on("session.snapshot", () => ({ type: "session_snapshot", snapshot: this.snapshot() }));
    fake.on("workspace.list", () => ({ type: "workspace_list", workspaces: [...this.workspaces.values()] }));
    fake.on("workspace.create", (p) => ({ type: "workspace_created", workspace: this.addWorkspace(p.label) }));
    fake.on("tab.create", (p) => {
      this.tabCreates.push(p);
      if (!this.workspaces.has(p.workspace_id)) throw herr("workspace_not_found");
      const { tab, pane } = this.addTab(p.workspace_id, p.label);
      this.lastTab = { tab, pane };
      return { type: "tab_created", tab, root_pane: pane };
    });
    fake.on("tab.close", (p) => {
      if (!this.tabs.has(p.tab_id)) throw herr("tab_not_found");
      this.removeTab(p.tab_id);
      return { type: "ok" };
    });
    fake.on("pane.close", (p) => {
      if (!this.panes.has(p.pane_id)) throw herr("pane_not_found");
      this.panes.delete(p.pane_id);
      return { type: "ok" };
    });
    fake.on("pane.get", (p) => {
      const pane = this.panes.get(p.pane_id);
      if (!pane) throw herr("pane_not_found", `pane ${p.pane_id} not found`);
      return { type: "pane_info", pane };
    });
    fake.on("pane.process_info", (p) => {
      if (!this.panes.has(p.pane_id)) throw herr("pane_not_found");
      return {
        type: "pane_process_info",
        process_info: {
          pane_id: p.pane_id, shell_pid: 100, tty: "ttys9", foreground_process_group_id: 100,
          foreground_processes: this.processes.get(p.pane_id) ?? [{ pid: 100, name: "zsh" }],
        },
      };
    });
    fake.on("worktree.create", (p) => {
      const ws = this.addWorkspace(p.label ?? "wt");
      const { tab, pane } = this.addTab(ws.workspace_id, "default");
      this.lastWorktree = { ws, tab, pane };
      return {
        type: "worktree_created", workspace: ws, tab, root_pane: pane,
        worktree: { path: `/tmp/fake-wt/${p.branch}`, branch: p.branch },
      };
    });
    fake.on("worktree.remove", (p) => {
      if (this.removeWorktreeError) throw herr(this.removeWorktreeError);
      if (!this.workspaces.has(p.workspace_id)) throw herr("workspace_not_found");
      this.workspaces.delete(p.workspace_id);
      return { type: "worktree_removed", workspace_id: p.workspace_id, path: "x", forced: false };
    });
    fake.on("agent.start", (p) => {
      if (typeof this.hooks.start === "function") this.hooks.start(p);
      if (!this.panes.has(p.pane_id)) throw herr("pane_not_found");
      const a = this.addAgent(p.name, p.pane_id);
      return { type: "agent_started", agent: this.view(a) };
    });
    fake.on("agent.get", (p) => ({ type: "agent_info", agent: this.view(this.agentOf(p.target)) }));
    fake.on("agent.explain", async (p) => {
      this.explains += 1;
      await this.hooks.explain?.(p);
      return { type: "agent_explain", text: "fake explain" };
    });
    fake.on("agent.read", (p) => ({
      type: "pane_read",
      read: { text: this.agentOf(p.target).screen, source: p.source, pane_id: "x", tab_id: "x", workspace_id: "x", revision: 1, truncated: false, format: "text" },
    }));
    fake.on("agent.send_keys", async (p) => {
      const a = this.agentOf(p.target);
      this.keys.push({ target: a.name, keys: p.keys });
      await this.hooks.keys?.(a, p);
      return { type: "ok" };
    });
    fake.on("agent.prompt", async (p) => {
      const a = this.agentOf(p.target);
      this.prompts.push({ target: a.name, text: p.text, wait: p.wait, statusAtSend: a.agent_status });
      const custom = await this.hooks.prompt?.(a, p);
      if (custom !== undefined) return custom;
      if (a.agent_status === "blocked") throw herr("agent_blocked");
      await this.runTurn(a);
      return { type: "wait_matched", event: { event: "pane_agent_status_changed", data: { agent_status: a.agent_status } } };
    });
    fake.on("agent.wait", async (p) => {
      this.waitCalls += 1;
      const first = this.agentOf(p.target);
      const custom = await this.hooks.wait?.(first, p);
      if (custom !== undefined) return custom;
      const deadline = Date.now() + (p.timeout_ms ?? 60_000);
      for (;;) {
        if (!this.fake.server) throw herr("connection_closed");
        const cur = this.agentOf(p.target);
        if (p.until.includes(cur.agent_status)) {
          return { type: "wait_matched", event: { event: "pane_agent_status_changed", data: { agent_status: cur.agent_status } } };
        }
        if (Date.now() >= deadline) throw herr("timeout");
        await sleep(5);
      }
    });
  }

  req(method) { return this.fake.requests.filter((r) => r.method === method).map((r) => r.params); }
}

const liveRuntimes = [];
afterEach(() => {
  for (const rt of liveRuntimes.splice(0)) rt.stop();
});

async function waitFor(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(5);
  }
  assert.fail("waitFor 超时");
}

async function withWorld(fn, runtimeOpts = {}, { start = true } = {}) {
  return withFake(async (fake) => {
    const world = new FakeHerdrWorld(fake);
    const rt = createHerdrRuntime(
      { herdrSocketPath: fake.socketPath },
      {
        socketOptions: { backoff: FAST_BACKOFF, random: () => 0 },
        waitSliceMs: 400,
        guardWaitMs: 300,
        leaveBlockedMs: 200,
        stallBackoff: { baseMs: 2, maxMs: 5, jitter: 0 },
        invalidateDebounceMs: 2,
        subscriptionRefreshDebounceMs: 5,
        ...runtimeOpts,
      },
    );
    liveRuntimes.push(rt);
    if (start) await rt.start();
    try {
      return await fn({ fake, world, rt });
    } finally {
      rt.stop();
    }
  });
}

const POINTER = "A2A task: read /tmp/e.json and follow it. attempt_id=att_1_aa.";

test("Runtime.start：严格先 events.subscribe 再 session.snapshot", () => withWorld(async ({ fake, rt }) => {
  const order = fake.requests.map((r) => r.method).filter((m) => m === "events.subscribe" || m === "session.snapshot");
  assert.deepEqual(order, ["events.subscribe", "session.snapshot"]);
  assert.equal(rt.stale, false);
}));

test("Runtime 缓存：状态事件只触发定向 pane.get/agent.get，不重放事件、不整张快照", () => withWorld(async ({ fake, world, rt }) => {
  const a = world.seedAgent("ah-a");
  await rt.refreshSnapshot();
  const snaps = world.req("session.snapshot").length;
  const before = fake.requests.length;
  // 事件里故意带一个与真实状态不同的 hint：缓存必须以定向读取的结果为准。
  world.setStatus(a, "working");
  const hints = [];
  rt.on("agent_status", (e) => hints.push(e));
  fake.push("pane_agent_status_changed", { type: "pane_agent_status_changed", pane_id: a.pane_id, workspace_id: a.workspace_id, agent_status: "idle", agent: "claude" });
  await waitFor(() => rt.topology().agents.find((x) => x.pane_id === a.pane_id)?.agent_status === "working");
  const added = fake.requests.slice(before).map((r) => r.method);
  assert.deepEqual([...new Set(added)].sort(), ["agent.get", "pane.get"]);
  assert.equal(world.req("session.snapshot").length, snaps, "pane 级事件不得触发整张快照");
  assert.equal(hints[0].hint, "idle", "事件只作唤醒提示，hint 原样透出但不进入缓存");
}));

test("Runtime 缓存：事件风暴期间读取中途再到的失效不会被漏掉", () => withWorld(async ({ fake, world, rt }) => {
  const a = world.seedAgent("ah-a");
  await rt.refreshSnapshot();
  world.hooks.explain = null;
  let first = true;
  // 第一次 pane.get 返回时，真实状态已经又变了一次：必须再刷新一轮。
  fake.on("pane.get", async (p) => {
    const pane = world.panes.get(p.pane_id);
    if (first) { first = false; world.setStatus(a, "blocked"); fake.push("pane_updated", { type: "pane_updated", pane }); }
    return { type: "pane_info", pane };
  });
  fake.push("pane_updated", { type: "pane_updated", pane: world.panes.get(a.pane_id) });
  await waitFor(() => rt.topology().agents.find((x) => x.pane_id === a.pane_id)?.agent_status === "blocked");
}));

test("Runtime 重连自愈：Event 断线后自动重订 → 快照 → 对账，且跨区移动的 pane_id 被修正", () => withWorld(async ({ fake, world, rt }) => {
  const a = world.seedAgent("ah-a");
  await rt.refreshSnapshot();
  const binding = rt.track({ taskId: "t1", agentName: "ah-a", paneId: a.pane_id, workspaceId: a.workspace_id, tabId: a.tab_id });
  const changed = [];
  rt.on("binding_changed", (b, info) => changed.push({ b, info }));
  const resynced = once(rt, "resynced", { signal: AbortSignal.timeout(2000) });
  const snaps = world.req("session.snapshot").length;
  // 断线期间 pane 被挪走且事件丢失（push 关闭）：只有重连后的对账能发现。
  const { pane } = world.movePane(a, { push: false });
  fake.dropSubscribers();
  const [info] = await resynced;
  assert.equal(info.reason, "reconnected");
  assert.ok(world.req("session.snapshot").length > snaps, "重连后必须重做 session.snapshot");
  assert.equal(binding.paneId, pane.pane_id);
  assert.equal(changed[0].info.reason, "reconcile");
  assert.equal(rt.stale, false);
  // 重订的订阅里应只含真实存在的 pane（旧 pane 已不存在，带上它会让整条订阅被拒）。
  await waitFor(() => fake.subscribeRequests.at(-1).subscriptions.some((s) => s.pane_id === pane.pane_id));
  assert.ok(!fake.subscribeRequests.at(-1).subscriptions.some((s) => s.pane_id === a.pane_id && a.pane_id !== pane.pane_id));
}));

test("Runtime：订阅集合只含缓存里真实存在的 pane，避免一个失效 pane 拖垮整条订阅", () => withWorld(async ({ world, rt }) => {
  const a = world.seedAgent("ah-a");
  await rt.refreshSnapshot();
  rt.track({ agentName: "ah-a", paneId: a.pane_id });
  rt.track({ agentName: "ghost", paneId: "w9:p99" });
  const paneSubs = rt.subscriptions().filter((s) => s.type === "pane.agent_status_changed").map((s) => s.pane_id);
  assert.deepEqual(paneSubs, [a.pane_id]);
}));

test("Runtime pane.moved：原地刷新绑定的 pane_id，随后按名字派发仍然成功", () => withWorld(async ({ world, rt }) => {
  const a = world.seedAgent("ah-a");
  await rt.refreshSnapshot();
  const binding = rt.track({ taskId: "t1", agentName: "ah-a", paneId: a.pane_id, workspaceId: a.workspace_id, tabId: a.tab_id });
  const changed = once(rt, "binding_changed", { signal: AbortSignal.timeout(1500) });
  const { prev, pane } = world.movePane(a);
  const [b, info] = await changed;
  assert.equal(b, binding, "绑定对象原地修改，持有它的调用方无需重新查找");
  assert.equal(binding.paneId, pane.pane_id);
  assert.equal(info.previousPaneId, prev);
  await waitFor(() => rt.topology().panes.some((p) => p.pane_id === pane.pane_id) && !rt.topology().panes.some((p) => p.pane_id === prev));
  const out = await rt.dispatchPrompt("ah-a", POINTER, { timeoutMs: 2000 });
  assert.equal(out.status, "settled");
}));

test("Runtime.reconcile：alive / moved / agent_gone / lost 四种结论", () => withWorld(async ({ world, rt }) => {
  const alive = world.seedAgent("ah-alive");
  const moved = world.seedAgent("ah-moved");
  const gone = world.seedAgent("ah-gone");
  const goneAgentPane = gone.pane_id;
  world.agents.delete("ah-gone"); // pane 还在，Agent 没了
  const stalePane = moved.pane_id;
  world.movePane(moved, { push: false });
  const res = await rt.reconcile([
    { taskId: "1", agentName: "ah-alive", paneId: alive.pane_id },
    { taskId: "2", agentName: "ah-moved", paneId: stalePane },
    { taskId: "3", agentName: "ah-gone", paneId: goneAgentPane },
    { taskId: "4", agentName: "ah-lost", paneId: "w9:p99" },
  ]);
  assert.deepEqual(res.map((r) => [r.agentName, r.state]), [
    ["ah-alive", "alive"], ["ah-moved", "moved"], ["ah-gone", "agent_gone"], ["ah-lost", "lost"],
  ]);
  assert.equal(res[1].binding.paneId, moved.pane_id);
  assert.ok(rt.binding("ah-alive") && rt.binding("ah-moved"));
  assert.ok(!rt.binding("ah-lost"), "lost 的绑定不再被订阅或追踪");
}));

test("Runtime.launchAgent（worktree）：pane_id 来自返回值、env 经 tab.create 注入且不覆盖 HERDR_*、默认 Tab 被收掉", () => withWorld(async ({ world, rt }) => withTemp(async (dir) => {
  const b = await rt.launchAgent({
    configDir: dir, taskId: "task-abc", runId: "run-1", attemptId: "att_1_aa", node: "n1", worker: "w",
    kind: "claude", args: ["--model", "x"], cwd: "/repo", envelopePath: "/e.json",
    env: { FOO: "1", HERDR_PANE_ID: "evil", A2A_TASK_ID: "evil", AH_NODE: "evil" },
    worktree: { branch: "a2a/task-abc" },
  });
  const wt = world.req("worktree.create")[0];
  assert.deepEqual([wt.cwd, wt.branch, wt.focus], ["/repo", "a2a/task-abc", false]);
  assert.ok(!("env" in wt), "worktree.create 不收 env，不得传");
  const tab = world.req("tab.create")[0];
  assert.equal(tab.workspace_id, world.lastWorktree.ws.workspace_id);
  assert.equal(tab.cwd, "/tmp/fake-wt/a2a/task-abc");
  assert.equal(tab.env.FOO, "1");
  assert.equal(tab.env.A2A_TASK_ID, "task-abc");
  assert.equal(tab.env.A2A_ATTEMPT_ID, "att_1_aa");
  assert.equal(tab.env.A2A_ENVELOPE_PATH, "/e.json");
  assert.equal(tab.env.AH_NODE, "n1");
  assert.ok(!("HERDR_PANE_ID" in tab.env), "不得覆盖或伪造 HERDR_*");
  const start = world.req("agent.start")[0];
  assert.equal(start.pane_id, world.lastTab.pane.pane_id, "pane_id 必须取自 tab.create 的返回值");
  assert.ok(!("env" in start));
  assert.deepEqual(start.args, ["--model", "x"]);
  assert.equal(b.paneId, start.pane_id);
  assert.equal(b.worktreePath, "/tmp/fake-wt/a2a/task-abc");
  assert.equal(world.req("tab.close")[0].tab_id, world.lastWorktree.tab.tab_id, "worktree 自带的默认 Tab 要收掉");
  assert.equal(rt.binding(b.agentName), b);
})));

test("Runtime.launchAgent：新窗格还不是可用 shell 时等待后再启动", () => withWorld(async ({ world, rt }) => withTemp(async (dir) => {
  let n = 0;
  world.hooks.start = (p) => {
    n += 1;
    if (n < 3) throw herr("agent_pane_busy", `agent target pane ${p.pane_id} is not an available shell`);
  };
  const b = await rt.launchAgent({ configDir: dir, taskId: "task-shell", kind: "agy", cwd: "/x" });
  assert.equal(n, 3);
  assert.equal(world.req("agent.start").length, 3);
  assert.equal(b.paneId, world.req("agent.start")[0].pane_id);
  assert.equal(b.agentName, "ah-shell");
})));

test("Runtime.launchAgent：shell 一直不可用时在时限内放弃并关掉空壳 Tab", () => withWorld(async ({ world, rt }) => withTemp(async (dir) => {
  world.hooks.start = (p) => { throw herr("agent_pane_busy", `agent target pane ${p.pane_id} is not an available shell`); };
  const tabsBefore = world.tabs.size;
  await assert.rejects(
    rt.launchAgent({ configDir: dir, taskId: "task-busy", kind: "agy" }),
    (e) => e.code === "agent_pane_busy",
  );
  assert.ok(world.req("agent.start").length >= 2);
  assert.equal(world.tabs.size, tabsBefore);
  assert.equal(rt.binding("ah-busy"), null);
}), { startTimeoutMs: 3600 }));

test("Runtime.launchAgent（非 worktree）：复用/创建同名 workspace，起不来时清掉空壳 Tab", () => withWorld(async ({ world, rt }) => withTemp(async (dir) => {
  const b1 = await rt.launchAgent({ configDir: dir, taskId: "task-1", kind: "claude", cwd: "/x" });
  const b2 = await rt.launchAgent({ configDir: dir, taskId: "task-2", kind: "claude", cwd: "/x" });
  assert.equal(world.req("workspace.create").length, 1, "同名 workspace 只创建一次");
  assert.equal(b1.workspaceId, b2.workspaceId);
  world.fake.on("agent.start", () => { throw herr("invalid_agent_name"); });
  const tabsBefore = world.tabs.size;
  await assert.rejects(rt.launchAgent({ configDir: dir, taskId: "task-3", kind: "claude" }), (e) => e.code === "invalid_agent_name");
  assert.equal(world.tabs.size, tabsBefore, "agent.start 失败后必须关掉刚开的 Tab");
  assert.equal(rt.binding("ah-3"), null);
})));

test("Runtime.closeAgent：Worktree 里有未提交改动时保留检出只关 Tab，干净时连 Worktree 一起清", () => withWorld(async ({ world, rt }) => withTemp(async (dir) => {
  const b = await rt.launchAgent({ configDir: dir, taskId: "task-d", kind: "claude", cwd: "/repo", worktree: { branch: "a2a/d" } });
  world.removeWorktreeError = "worktree_dirty";
  const kept = await rt.closeAgent(b);
  assert.equal(kept.worktreeKept, true);
  assert.equal(kept.worktreeRemoved, false);
  assert.equal(kept.closed, true);
  assert.equal(world.req("worktree.remove")[0].force, false, "绝不 force 删除，避免丢产出");
  assert.ok(world.req("tab.close").some((r) => r.tab_id === b.tabId));

  world.removeWorktreeError = null;
  const b2 = await rt.launchAgent({ configDir: dir, taskId: "task-e", kind: "claude", cwd: "/repo", worktree: { branch: "a2a/e" } });
  const clean = await rt.closeAgent(b2);
  assert.equal(clean.worktreeRemoved, true);
  assert.equal(rt.binding(b2.agentName), null);
})));

test("Runtime.dispatchPrompt：正常交卷，prompt 是 <=300 字节单行指针", () => withWorld(async ({ world, rt }) => {
  world.seedAgent("ah-a");
  const out = await rt.dispatchPrompt("ah-a", POINTER, { timeoutMs: 2000 });
  assert.equal(out.status, "settled");
  assert.equal(world.prompts.length, 1);
  assert.ok(Buffer.byteLength(world.prompts[0].text) <= MAX_POINTER_PROMPT_BYTES);
  assert.deepEqual(world.prompts[0].wait.until, ["idle", "done", "blocked"]);
}));

test("Runtime.dispatchPrompt：超长或多行文本在发送前就被拒，一个字节都不会进终端", () => withWorld(async ({ world, rt }) => {
  world.seedAgent("ah-a");
  await assert.rejects(rt.dispatchPrompt("ah-a", "x".repeat(MAX_POINTER_PROMPT_BYTES + 1)), PointerPromptError);
  await assert.rejects(rt.dispatchPrompt("ah-a", "line1\nline2"), PointerPromptError);
  assert.equal(world.prompts.length, 0);
}));

test("Runtime 状态前置守卫：对 working 的 Agent 先等旧 turn 结束，再发 prompt", () => withWorld(async ({ world, rt }) => {
  const a = world.seedAgent("ah-a", "working");
  setTimeout(() => world.setStatus(a, "idle"), 60);
  const out = await rt.dispatchPrompt("ah-a", POINTER, { timeoutMs: 3000 });
  assert.equal(out.status, "settled");
  assert.equal(world.prompts[0].statusAtSend, "idle", "prompt 只能在 idle/done 时发出，否则旧 turn 结束会误满足等待");
}));

test("Runtime 状态前置守卫：旧 turn 迟迟不结束时返回 busy 且不发送", () => withWorld(async ({ world, rt }) => {
  world.seedAgent("ah-a", "working");
  const out = await rt.dispatchPrompt("ah-a", POINTER, { timeoutMs: 3000 });
  assert.equal(out.status, "busy");
  assert.equal(world.prompts.length, 0);
}, { guardWaitMs: 80, waitSliceMs: 30 }));

test("Runtime 并发排队：同一 Agent 的派发串行，不同 Agent 并行", () => withWorld(async ({ world, rt }) => {
  world.seedAgent("ah-a");
  world.seedAgent("ah-b");
  world.turnMs = 60;
  const [r1, r2] = await Promise.all([
    rt.dispatchPrompt("ah-a", `${POINTER} one`, { timeoutMs: 3000 }),
    rt.dispatchPrompt("ah-a", `${POINTER} two`, { timeoutMs: 3000 }),
  ]);
  assert.deepEqual([r1.status, r2.status], ["settled", "settled"]);
  assert.equal(world.maxInflight, 1, "同一 Agent 同一时刻只能有一个 turn");
  assert.deepEqual(world.prompts.map((p) => p.text.slice(-3)), ["one", "two"], "按到达顺序排队");
  assert.ok(world.prompts.every((p) => p.statusAtSend === "idle"));

  world.maxInflight = 0;
  await Promise.all([
    rt.dispatchPrompt("ah-a", POINTER, { timeoutMs: 3000 }),
    rt.dispatchPrompt("ah-b", POINTER, { timeoutMs: 3000 }),
  ]);
  assert.equal(world.maxInflight, 2, "不同 Agent 互不阻塞");
  assert.equal(rt.pendingDispatches("ah-a"), 0);
}));

test("Runtime agent_prompt_stalled：agent.get+explain 复核后退避重投，成功则交卷", () => withWorld(async ({ world, rt }) => {
  world.seedAgent("ah-a");
  let n = 0;
  world.hooks.prompt = () => { if (n++ === 0) throw herr("agent_prompt_stalled"); return undefined; };
  const out = await rt.dispatchPrompt("ah-a", POINTER, { timeoutMs: 3000 });
  assert.equal(out.status, "settled");
  assert.equal(out.stalls, 1);
  assert.equal(world.prompts.length, 2);
  assert.equal(world.explains, 1);
}));

test("Runtime agent_prompt_stalled：重投达上限后报 stalled，绝不误判完成", () => withWorld(async ({ world, rt }) => {
  world.seedAgent("ah-a");
  world.hooks.prompt = () => { throw herr("agent_prompt_stalled"); };
  const out = await rt.dispatchPrompt("ah-a", POINTER, { timeoutMs: 3000 });
  assert.equal(out.status, "stalled");
  assert.equal(world.prompts.length, 3, "首次 + 2 次重投");
  assert.equal(out.stalls, 2);
  assert.ok(out.explain, "附带 agent.explain 诊断");
}));

test("Runtime agent_prompt_stalled：复核时发现已有活动（上一次其实投递了）就只等待、不重投", () => withWorld(async ({ world, rt }) => {
  const a = world.seedAgent("ah-a");
  world.hooks.prompt = () => {
    world.setStatus(a, "working");
    setTimeout(() => world.setStatus(a, "idle"), 40);
    throw herr("agent_prompt_stalled");
  };
  const out = await rt.dispatchPrompt("ah-a", POINTER, { timeoutMs: 3000 });
  assert.equal(out.status, "settled");
  assert.equal(world.prompts.length, 1, "有活动迹象时重投会让任务执行两遍");
}));

test("Runtime：wait 被提交前的旧状态满足（state_change_seq 没动）不算交卷", () => withWorld(async ({ world, rt }) => {
  world.seedAgent("ah-a");
  // 服务端立即回 wait_matched，但 Agent 实际没有任何状态变化。
  world.hooks.prompt = () => ({ type: "wait_matched", event: { event: "pane_agent_status_changed", data: { agent_status: "idle" } } });
  const out = await rt.dispatchPrompt("ah-a", POINTER, { timeoutMs: 3000 });
  assert.equal(out.status, "stalled");
  assert.equal(world.prompts.length, 3);
}));

test("Runtime agent_blocked（发送前已卡住）：用 recent_unwrapped 抓弹窗送审，不发 prompt", () => withWorld(async ({ fake, world, rt }) => {
  const a = world.seedAgent("ah-a", "blocked");
  a.screen = "Allow Bash(rm -rf build)?\n❯ 1. Yes\n  2. No";
  const out = await rt.dispatchPrompt("ah-a", POINTER, { timeoutMs: 2000 });
  assert.equal(out.status, "blocked");
  assert.match(out.popup, /Allow Bash\(rm -rf build\)/);
  assert.equal(world.prompts.length, 0, "已 blocked 的 Agent 不得再被塞 prompt");
  const read = fake.requests.find((r) => r.method === "agent.read").params;
  assert.equal(read.source, "recent_unwrapped");
  assert.equal(read.strip_ansi, true);
}));

test("Runtime agent_blocked（投递后才卡住）：等待返回 blocked 并带弹窗，不重复 prompt", () => withWorld(async ({ world, rt }) => {
  const a = world.seedAgent("ah-a");
  a.screen = "Allow edit?";
  world.hooks.prompt = async (agent) => { await world.runTurn(agent, "blocked"); return { type: "wait_matched" }; };
  const out = await rt.dispatchPrompt("ah-a", POINTER, { timeoutMs: 2000 });
  assert.equal(out.status, "blocked");
  assert.equal(out.popup, "Allow edit?");
  assert.equal(world.prompts.length, 1);
}));

test("Runtime 审批续接：注入精确按键后先等离开 blocked 再等交卷，全程不重复 prompt", () => withWorld(async ({ world, rt }) => {
  const a = world.seedAgent("ah-a", "blocked");
  a.screen = "Allow?";
  // 按键注入后 40ms 才开始 working、再 40ms 收尾：如果实现直接等 blocked/idle，会被旧的 blocked 立刻满足。
  world.hooks.keys = (agent) => {
    setTimeout(() => world.setStatus(agent, "working"), 40);
    setTimeout(() => world.setStatus(agent, "idle"), 80);
  };
  const out = await rt.resumeAfterApproval("ah-a", ["enter"], { timeoutMs: 3000, prevPopup: "Allow?" });
  assert.equal(out.status, "settled");
  assert.deepEqual(world.keys, [{ target: "ah-a", keys: ["enter"] }]);
  assert.equal(world.prompts.length, 0, "审批只发按键，不能重发 prompt");
}));

test("Runtime 审批续接：按键没生效（弹窗没变）返回 blocked+stuck，不假装通过", () => withWorld(async ({ world, rt }) => {
  const a = world.seedAgent("ah-a", "blocked");
  a.screen = "Allow?";
  const out = await rt.resumeAfterApproval("ah-a", ["enter"], { timeoutMs: 3000, prevPopup: "Allow?" });
  assert.equal(out.status, "blocked");
  assert.equal(out.stuck, true);
}));

test("Runtime 审批续接：用户已在终端里自己点掉弹窗时不再注入按键", () => withWorld(async ({ world, rt }) => {
  world.seedAgent("ah-a", "idle");
  const out = await rt.resumeAfterApproval("ah-a", ["enter"], { timeoutMs: 1000 });
  assert.equal(out.status, "settled");
  assert.equal(out.notBlocked, true);
  assert.equal(world.keys.length, 0);
}));

test("Runtime 审批续接：非法按键参数直接拒绝", () => withWorld(async ({ world, rt }) => {
  world.seedAgent("ah-a", "blocked");
  await assert.rejects(rt.resumeAfterApproval("ah-a", [], {}), TypeError);
  await assert.rejects(rt.resumeAfterApproval("ah-a", [""], {}), TypeError);
  assert.equal(world.keys.length, 0);
}));

test("Runtime agent_not_running：先按名字 agent.get 排除跨区移动，找到就刷新 pane_id 继续等", () => withWorld(async ({ world, rt }) => {
  const a = world.seedAgent("ah-a", "working");
  const binding = rt.track({ agentName: "ah-a", paneId: a.pane_id, workspaceId: a.workspace_id, tabId: a.tab_id });
  let first = true;
  world.hooks.wait = (agent) => {
    if (!first) return undefined;
    first = false;
    world.movePane(agent, { push: false }); // 挪走但没推事件
    setTimeout(() => world.setStatus(agent, "idle"), 30);
    throw herr("agent_not_running");
  };
  const out = await rt.dispatchPrompt("ah-a", POINTER, { timeoutMs: 3000 });
  assert.equal(out.status, "settled");
  assert.equal(binding.paneId, a.pane_id, "agent_not_running 恢复路径要把绑定刷到新 pane");
}));

test("Runtime agent_not_running：按名字也找不到才判退出", () => withWorld(async ({ world, rt }) => {
  world.seedAgent("ah-a", "working");
  world.hooks.wait = (agent) => { world.agents.delete(agent.name); throw herr("agent_not_running"); };
  const out = await rt.dispatchPrompt("ah-a", POINTER, { timeoutMs: 3000 });
  assert.equal(out.status, "dead");
}));

test("Runtime timeout：agent.wait 切片超时但 Agent 仍在 working 时不误杀，到期才报 deadline(alive)", () => withWorld(async ({ world, rt }) => {
  world.seedAgent("ah-a", "working");
  const out = await rt.dispatchPrompt("ah-a", POINTER, { timeoutMs: 250 });
  // 守卫期内旧 turn 没结束 → busy；这里要看长任务在等待阶段的行为，所以改走已投递后的路径。
  assert.equal(out.status, "busy");
}, { guardWaitMs: 60, waitSliceMs: 30 }));

test("Runtime timeout：投递后长任务跨越多个等待切片仍被判存活，到期返回 deadline 且 alive=true", () => withWorld(async ({ world, rt }) => {
  const a = world.seedAgent("ah-a");
  world.hooks.prompt = () => { world.setStatus(a, "working"); throw herr("timeout"); }; // 已开跑，但本片没等到收尾
  const out = await rt.dispatchPrompt("ah-a", POINTER, { timeoutMs: 260 });
  assert.equal(out.status, "deadline");
  assert.equal(out.alive, true);
  assert.ok(world.waitCalls >= 3, `应跨多个切片继续等待，实际 agent.wait 调用 ${world.waitCalls} 次`);
  assert.equal(world.prompts.length, 1, "timeout 不代表没投递，不能重投");
}, { waitSliceMs: 40 }));

test("Runtime timeout：状态 unknown 时看 pane.process_info，前台有非 shell 进程算存活，只有 shell 判 inactive", () => withWorld(async ({ world, rt }) => {
  const a = world.seedAgent("ah-a");
  world.hooks.prompt = () => { world.setStatus(a, "unknown"); throw herr("timeout"); };
  world.processes.set(a.pane_id, [{ pid: 4321, name: "claude" }]);
  const alive = await rt.dispatchPrompt("ah-a", POINTER, { timeoutMs: 200 });
  assert.equal(alive.status, "deadline");
  assert.equal(alive.alive, true);

  world.processes.set(a.pane_id, [{ pid: 100, name: "zsh" }]);
  world.setStatus(a, "idle");
  world.hooks.prompt = () => { world.setStatus(a, "unknown"); throw herr("timeout"); };
  const inactive = await rt.dispatchPrompt("ah-a", POINTER, { timeoutMs: 2000 });
  assert.equal(inactive.status, "inactive");
}, { waitSliceMs: 30 }));

test("Runtime：Agent 在派发前就不存在时返回 dead", () => withWorld(async ({ world, rt }) => {
  const out = await rt.dispatchPrompt("ah-ghost", POINTER, { timeoutMs: 500 });
  assert.equal(out.status, "dead");
  assert.equal(world.prompts.length, 0);
}));

test("Runtime：AbortSignal 能打断等待", () => withWorld(async ({ world, rt }) => {
  const a = world.seedAgent("ah-a");
  world.hooks.prompt = () => { world.setStatus(a, "working"); throw herr("timeout"); };
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 40);
  await assert.rejects(rt.dispatchPrompt("ah-a", POINTER, { timeoutMs: 5000, signal: ac.signal }), (e) => e.code === "aborted");
}, { waitSliceMs: 2000 }));

// ---------- 文件信封与门禁 ----------

function goodResult(attemptId, extra = {}) {
  return { schema: "a2a-hub/herdr-result@1", attempt_id: attemptId, receipt_text: "STATUS: done", ...extra };
}

test("信封：原子落盘（无 .tmp 残留），携带 attempt_id/result_path，权限 0600", () => withTemp(async (dir) => {
  const attemptId = newAttemptId(1);
  assert.match(attemptId, /^att_1_[0-9a-f]{8}$/);
  assert.notEqual(newAttemptId(1), newAttemptId(1));
  const p = writeAttemptEnvelope({ configDir: dir, taskId: "task-1", runId: "run-1", attemptNo: 1, attemptId, envelope: { input_path: "/in.json", goal: "g" } });
  assert.equal(p.envelope, herdrAttemptPaths(dir, "task-1", 1).envelope);
  const env = JSON.parse(fs.readFileSync(p.envelope, "utf8"));
  assert.deepEqual([env.attempt_id, env.run_id, env.task_id, env.result_path], [attemptId, "run-1", "task-1", p.result]);
  assert.equal(env.goal, "g");
  assert.equal(fs.existsSync(`${p.envelope}.tmp`), false);
  assert.equal(fs.statSync(p.envelope).mode & 0o777, 0o600);
  // 调用方想塞同名字段也不能覆盖标识。
  const p2 = writeAttemptEnvelope({ configDir: dir, taskId: "task-1", runId: "run-1", attemptNo: 2, attemptId: "att_2_x", envelope: { attempt_id: "evil", task_id: "evil" } });
  const env2 = JSON.parse(fs.readFileSync(p2.envelope, "utf8"));
  assert.deepEqual([env2.attempt_id, env2.task_id], ["att_2_x", "task-1"]);
  assert.throws(() => herdrAttemptPaths(dir, "task-1", 0));
  assert.throws(() => herdrAttemptPaths(dir, "../x", 1));
}));

test("指针 prompt：单行、<=300 字节；超限报错而不是截断", () => withTemp(async (dir) => {
  const { envelope } = herdrAttemptPaths(dir, "task-1", 1);
  const text = buildPointerPrompt({ envelopePath: envelope, attemptId: "att_1_deadbeef" });
  assert.ok(Buffer.byteLength(text) <= MAX_POINTER_PROMPT_BYTES);
  assert.ok(text.includes(envelope) && text.includes("att_1_deadbeef"));
  assert.match(buildPointerPrompt({ envelopePath: envelope, attemptId: "a", repair: true }), /repair/);
  assert.throws(() => buildPointerPrompt({ envelopePath: `/${"d".repeat(300)}/envelope.json`, attemptId: "a" }), PointerPromptError);
  assert.equal(assertPointerPrompt("x".repeat(MAX_POINTER_PROMPT_BYTES)), MAX_POINTER_PROMPT_BYTES);
  // 多字节字符按字节算：100 个汉字 = 300 字节，再多一个就超限。
  assert.equal(assertPointerPrompt("字".repeat(100)), 300);
  assert.throws(() => assertPointerPrompt("字".repeat(101)), PointerPromptError);
}));

test("门禁：合法 result 通过；缺失 / .tmp 残留 / 非 JSON / schema 错 / 空回执 / attempt_id 串包逐一拦截", () => withTemp(async (dir) => {
  const attemptId = "att_2_cafe0001";
  const { result } = herdrAttemptPaths(dir, "task-1", 2);
  const codes = () => checkResultGate({ resultPath: result, attemptId, runId: "run-1", taskId: "task-1" }).violations.map((v) => v.code);

  assert.deepEqual(codes(), ["missing"]);

  atomicWriteFile(result, JSON.stringify(goodResult(attemptId, { run_id: "run-1", task_id: "task-1" })));
  const ok = checkResultGate({ resultPath: result, attemptId, runId: "run-1", taskId: "task-1" });
  assert.equal(ok.ok, true);
  assert.equal(ok.result.receipt_text, "STATUS: done");

  fs.writeFileSync(`${result}.tmp`, "{");
  assert.deepEqual(codes(), ["tmp_residue"], "未 rename 收尾的写入不算完成");
  fs.unlinkSync(`${result}.tmp`);

  fs.writeFileSync(result, "{not json");
  assert.deepEqual(codes(), ["not_json"]);

  fs.writeFileSync(result, JSON.stringify([1]));
  assert.deepEqual(codes(), ["bad_schema"]);

  fs.writeFileSync(result, JSON.stringify({ ...goodResult(attemptId), schema: "other" }));
  assert.deepEqual(codes(), ["bad_schema"]);

  fs.writeFileSync(result, JSON.stringify({ ...goodResult(attemptId), receipt_text: "  " }));
  assert.deepEqual(codes(), ["empty_receipt"]);

  // 串包：Agent 把上一轮 attempt 的结果原样拷了过来。
  fs.writeFileSync(result, JSON.stringify(goodResult("att_1_oldoldol")));
  const stale = checkResultGate({ resultPath: result, attemptId });
  assert.deepEqual(stale.violations.map((v) => v.code), ["attempt_mismatch"]);
  assert.equal(stale.result, null, "未通过门禁时不暴露 result 内容");
  assert.match(stale.violations[0].message, /att_2_cafe0001/);

  fs.writeFileSync(result, JSON.stringify({ ...goodResult(attemptId), attempt_id: undefined }));
  assert.deepEqual(codes(), ["attempt_mismatch"], "缺 attempt_id 同样拦截");

  fs.writeFileSync(result, JSON.stringify(goodResult(attemptId, { run_id: "run-OTHER" })));
  assert.deepEqual(codes(), ["run_mismatch"]);
}));

test("会话文件同时保住 Claude session 与 Herdr 双键绑定", () => withTemp((dir) => {
  writeSessionId(dir, "TASK-BIND", "sess-1");
  writeHerdrBinding(dir, "TASK-BIND", {
    agent_name: "ah-bind", workspace_id: "w1", pane_id: "w1:p1", worktree_path: "/tmp/wt",
  });
  assert.equal(readSessionId(dir, "TASK-BIND"), "sess-1");
  assert.deepEqual(readHerdrBinding(dir, "TASK-BIND"), {
    agent_name: "ah-bind", workspace_id: "w1", pane_id: "w1:p1", worktree_path: "/tmp/wt",
  });
  writeHerdrBinding(dir, "TASK-BIND", {
    agent_name: "ah-bind", workspace_id: "w2", pane_id: "w2:p9", worktree_path: "",
  });
  assert.equal(readSessionId(dir, "TASK-BIND"), "sess-1", "刷新物理位置不能冲掉 session id");
  assert.equal(readHerdrBinding(dir, "TASK-BIND").pane_id, "w2:p9");
  writeSessionId(dir, "TASK-BIND", "sess-2");
  assert.equal(readHerdrBinding(dir, "TASK-BIND").agent_name, "ah-bind");
}));

function writeGateResult(file, attemptId, receipt) {
  const body = {
    schema: "a2a-hub/herdr-result@1",
    attempt_id: attemptId,
    receipt_text: receipt,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

test("内核 Socket 派发：指针不带正文，门禁失败原址修复，blocked 用按键续接", () => withFake(async (fake) => {
  const world = new FakeHerdrWorld(fake);
  world.hooks.prompt = (agent) => {
    world.setStatus(agent, "working");
    return { type: "ok" };
  };
  world.hooks.keys = (agent) => { world.setStatus(agent, "idle"); };
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
      workers: {
        claude: {
          context: "herdr",
          herdr_kind: "claude",
          herdr_args: ["--dangerously-skip-permissions"],
          herdr_env: { CUSTOM_FLAG: "yes", HERDR_EVIL: "no" },
          timeout_sec: 120,
        },
      },
    }), { mode: 0o600 });
    const mock = new MockBus({ tables: TABLES });
    const kernel = makeKernel(dir, mock, { herdrSocketPath: fake.socketPath });
    try {
      await seedTask(mock, { Task_ID: "TASK-SOCK", Context_ID: "CTX-SOCK" });
      await kernel.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-SOCK"), "Status"), "working");
      const ledger = readHerdrLedger(dir, "TASK-SOCK");
      assert.equal(ledger.agent_name, herdrAgentName("TASK-SOCK"));
      assert.equal(ledger.attempt_no, 1);
      assert.ok(ledger.pane_id && ledger.pane_id !== "w1:p1");
      assert.equal(world.prompts.length, 1);
      assert.ok(Buffer.byteLength(world.prompts[0].text) <= MAX_POINTER_PROMPT_BYTES);
      assert.match(world.prompts[0].text, /^A2A task: /);
      assert.doesNotMatch(world.prompts[0].text, /你是中台节点/);
      const envelope = JSON.parse(fs.readFileSync(ledger.envelope_path, "utf8"));
      assert.match(envelope.instructions, /你是中台节点/);
      assert.equal(envelope.attempt_id, ledger.attempt_id);
      const env = world.tabCreates[0].env;
      assert.equal(env.AH_TASK_ID, "TASK-SOCK");
      assert.equal(env.A2A_ATTEMPT_ID, ledger.attempt_id);
      assert.equal(env.CUSTOM_FLAG, "yes");
      assert.equal(env.HERDR_EVIL, undefined);
      const binding = readHerdrBinding(dir, "TASK-SOCK");
      assert.equal(binding.agent_name, ledger.agent_name);
      assert.equal(binding.pane_id, ledger.pane_id);
      const started = world.req("agent.start")[0];
      assert.deepEqual(started.args, ["--dangerously-skip-permissions"]);

      writeGateResult(ledger.result_path, "att_wrong", "这不是这次的结果。\n");
      world.setStatus(world.agents.get(ledger.agent_name), "idle");
      await kernel.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-SOCK"), "Status"), "working", "attempt_id 串包不能算通过");
      assert.equal(world.prompts.length, 2);
      assert.match(world.prompts[1].text, /^A2A repair: /);
      const repaired = readHerdrLedger(dir, "TASK-SOCK");
      assert.equal(repaired.attempt_no, 2);
      assert.notEqual(repaired.attempt_id, ledger.attempt_id);
      assert.equal(repaired.repairs, 1);

      writeGateResult(repaired.result_path, repaired.attempt_id, "```agent-ask\n可以发布吗？\n```\n");
      world.setStatus(world.agents.get(ledger.agent_name), "idle");
      await kernel.sweepOnce();
      const asked = await taskOf(mock, "TASK-SOCK");
      assert.equal(f1(asked, "Status"), "input-required");
      assert.equal(readHerdrLedger(dir, "TASK-SOCK").state, "parked");
      assert.equal([...world.tabs.values()].some((tab) => tab.tab_id === ledger.tab_id), true);

      world.agents.get(ledger.agent_name).agent_status = "blocked";
      world.agents.get(ledger.agent_name).screen = "Allow publish? [y/N]";
      await mock.createRecord(TABLES.messages, {
        Msg_ID: "MSG-SOCK-03",
        Task_ID: "TASK-SOCK",
        Context_ID: "CTX-SOCK",
        From_Node: "hub",
        To_Node: "node-a",
        Role: "user",
        Kind: "answer",
        In_Reply_To: f1(asked, "Status_Msg"),
        Created_At: "2026-01-15T09:20:00+0800",
      });
      await mock.createRecord(TABLES.parts, {
        Part_ID: "MSG-SOCK-03-P1",
        Parent_ID: "MSG-SOCK-03",
        Parent_Type: "message",
        Seq: 1,
        Kind: "text",
        Text: "可以",
      });
      await kernel.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-SOCK"), "Status"), "working");
      assert.equal(world.keys.length, 1);
      assert.deepEqual(world.keys[0].keys, ["esc"]);
      assert.equal(world.prompts.length, 3);
      assert.match(world.prompts[2].text, /^A2A task: /);
      assert.equal(world.tabCreates.length, 1, "续接留在原 Pane");

      const doneLedger = readHerdrLedger(dir, "TASK-SOCK");
      writeGateResult(doneLedger.result_path, doneLedger.attempt_id, "已发布。\n");
      world.setStatus(world.agents.get(ledger.agent_name), "idle");
      await kernel.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-SOCK"), "Status"), "completed");
      assert.equal(readHerdrLedger(dir, "TASK-SOCK"), null);
    } finally {
      kernel.stopHerdrTimers();
    }
  });
}));

test("内核 Socket：发 prompt 后仍停在原 idle 时不消耗修复次数", () => withFake(async (fake) => {
  const world = new FakeHerdrWorld(fake);
  world.hooks.prompt = (agent) => {
    // 真实 Herdr 收下 prompt 就会把 state_change_seq 加一，状态仍可能停在原来的 idle。
    agent.state_change_seq += 1;
    return { type: "ok" };
  };
  await withTemp(async (dir) => {
    writeHerdrWorker(dir);
    const mock = new MockBus({ tables: TABLES });
    const kernel = makeKernel(dir, mock, { herdrSocketPath: fake.socketPath, herdrStartupGraceMs: 60_000 });
    try {
      await seedTask(mock, { Task_ID: "TASK-IDLE", Context_ID: "CTX-IDLE" });
      await kernel.sweepOnce();
      await kernel.sweepOnce();
      const ledger = readHerdrLedger(dir, "TASK-IDLE");
      assert.equal(f1(await taskOf(mock, "TASK-IDLE"), "Status"), "working");
      assert.equal(ledger.attempt_no, 1);
      assert.equal(Number(ledger.repairs) || 0, 0);
      assert.equal(world.prompts.length, 1);
      assert.match(world.prompts[0].text, /^A2A task: /);
    } finally {
      kernel.stopHerdrTimers();
    }
  });
}));

test("doctor：Herdr socket ping、协议与孤立 Agent", () => withFake(async (fake) => {
  fake.on("ping", () => ({ type: "pong", version: "fake", protocol: HERDR_PROTOCOL_MIN }));
  const world = new FakeHerdrWorld(fake);
  world.seedAgent("ah-orphan");
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({
      node: "edge-herdr",
      role: "node",
      busType: "http",
      hubUrl: "http://127.0.0.1:1",
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
      workers: { claude: { context: "herdr", herdr_kind: "claude", name: "Claude" } },
    }), { mode: 0o600 });
    const lines = [];
    const orig = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      await doctor(dir, dir, { herdrSocketPath: fake.socketPath });
    } finally {
      console.log = orig;
    }
    const out = lines.join("\n");
    assert.match(out, new RegExp(`Herdr socket 可达（config，protocol ${HERDR_PROTOCOL_MIN}`));
    assert.match(out, /孤立 Agent ah-orphan/);
  });
}));

test("buildLaunchEnv：A2A_*/AH_* 由系统决定，用户 env 只能加不能改", () => {
  const env = buildLaunchEnv({
    taskId: "task-1", runId: "r", attemptId: "a", node: "n", worker: "w", runDir: "/run", inputPath: "/i",
    receiptPath: "/r", envelopePath: "/e", extra: { A2A_NODE: "x", AH_RUN_DIR: "x", HERDR_ENV: "1", OK_KEY: 7, "bad key": "1", NIL: null },
  });
  assert.equal(env.A2A_NODE, "n");
  assert.equal(env.AH_RUN_DIR, "/run");
  assert.equal(env.OK_KEY, "7");
  assert.ok(!("HERDR_ENV" in env) && !("bad key" in env) && !("NIL" in env));
  assert.deepEqual(
    Object.keys(env).filter((k) => k.startsWith("A2A_")).sort(),
    ["A2A_ATTEMPT_ID", "A2A_ENVELOPE_PATH", "A2A_NODE", "A2A_RUN_ID", "A2A_TASK_ID"],
  );
});
