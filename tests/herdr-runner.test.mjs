// herdr 多 Agent 编排引擎单元测试：并发槽位、热驻留占槽、原地热续接、冷启动兜底与 setup/doctor 集成。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { signDecision, loadOrCreateHubKey } from "../src/approval-sign.mjs";
import { f1 } from "../src/bus/tables.mjs";
import { controlKeysIn, inferHerdrKind, loadConfig, normalizeCommands } from "../src/config.mjs";
import { doctor } from "../src/doctor.mjs";
import { hasPastedPlaceholder, herdrAgentName, isTerminalChromeOnly, readHerdrLedger } from "../src/herdr-runner.mjs";
import { Kernel } from "../src/kernel.mjs";
import { discoverLocalAgents, runSetup } from "../src/setup.mjs";
import { TABLES, withTemp } from "./helpers.mjs";
import { MockBus } from "./mocks/mock-bus.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 内存态 Herdr CLI 模拟器：按命令行参数驱动 workspace / tab / agent 生命周期，并记录完整调用轨迹。
function createMockHerdr() {
  let wsSeq = 0;
  let tabSeq = 0;
  let paneSeq = 0;
  const workspaces = [];
  const tabs = new Map();
  const agents = new Map();
  const calls = [];

  const exec = async (rawArgs) => {
    calls.push([...rawArgs]);
    const args = [...rawArgs];
    let session = "";
    if (args[0] === "--session") {
      args.shift();
      session = args.shift() || "";
    }
    const [group, cmd, ...rest] = args;

    if (group === "workspace" && cmd === "list") {
      return { stdout: JSON.stringify({ result: { workspaces } }), stderr: "" };
    }
    if (group === "workspace" && cmd === "create") {
      const idx = rest.indexOf("--label");
      const label = idx >= 0 ? rest[idx + 1] : "default";
      const wsId = `ws-${++wsSeq}`;
      const ws = { workspace_id: wsId, label, session };
      workspaces.push(ws);
      return { stdout: JSON.stringify({ result: { workspace: ws } }), stderr: "" };
    }

    if (group === "tab" && cmd === "create") {
      const env = {};
      let workspaceId = "";
      let cwd = "";
      let label = "";
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--workspace") workspaceId = rest[++i];
        else if (rest[i] === "--cwd") cwd = rest[++i];
        else if (rest[i] === "--label") label = rest[++i];
        else if (rest[i] === "--env") {
          const kv = rest[++i] || "";
          const eq = kv.indexOf("=");
          if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
      }
      const tabId = `tab-${++tabSeq}`;
      const paneId = `pane-${++paneSeq}`;
      tabs.set(tabId, { tabId, paneId, workspaceId, cwd, label, env, closed: false });
      return {
        stdout: JSON.stringify({
          result: {
            tab: { tab_id: tabId },
            root_pane: { pane_id: paneId },
          },
        }),
        stderr: "",
      };
    }
    if (group === "tab" && cmd === "close") {
      const tabId = rest[0];
      const tab = tabs.get(tabId);
      if (tab) tab.closed = true;
      for (const [name, ag] of agents.entries()) {
        if (ag.tabId === tabId) agents.delete(name);
      }
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    }
    if (group === "pane" && cmd === "close") {
      const paneId = rest[0];
      for (const [name, ag] of agents.entries()) {
        if (ag.paneId === paneId) agents.delete(name);
      }
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    }

    if (group === "agent" && cmd === "start") {
      const name = rest[0];
      let kind = "";
      let paneId = "";
      let extraArgs = [];
      for (let i = 1; i < rest.length; i++) {
        if (rest[i] === "--kind") kind = rest[++i];
        else if (rest[i] === "--pane") paneId = rest[++i];
        else if (rest[i] === "--") {
          extraArgs = rest.slice(i + 1);
          break;
        }
      }
      let tabId = "";
      for (const t of tabs.values()) {
        if (t.paneId === paneId) { tabId = t.tabId; break; }
      }
      agents.set(name, {
        name,
        kind,
        paneId,
        tabId,
        extraArgs,
        status: "idle",
        prompts: [],
        keys: [],
        output: "",
      });
      return { stdout: JSON.stringify({ result: { agent: { name, agent_status: "idle" } } }), stderr: "" };
    }

    if (group === "agent" && cmd === "prompt") {
      const name = rest[0];
      const promptText = rest[1] ?? "";
      const ag = agents.get(name);
      if (!ag) throw new Error(`agent not found: ${name}`);
      if (ag.status === "blocked") throw new Error("agent_blocked");
      ag.prompts.push(promptText);
      ag.status = "working";
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    }

    if (group === "agent" && cmd === "send-keys") {
      const name = rest[0];
      const ag = agents.get(name);
      if (!ag) throw new Error(`agent not found: ${name}`);
      ag.keys.push(...rest.slice(1));
      if (ag.status === "blocked") ag.status = "idle";
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    }

    if (group === "agent" && cmd === "get") {
      const name = rest[0];
      const ag = agents.get(name);
      if (!ag) throw new Error(`agent not found: ${name}`);
      return {
        stdout: JSON.stringify({
          result: { agent: { name: ag.name, agent_status: ag.status, pane_id: ag.paneId, tab_id: ag.tabId } },
        }),
        stderr: "",
      };
    }

    if (group === "agent" && cmd === "read") {
      const name = rest[0];
      const ag = agents.get(name);
      if (!ag) throw new Error(`agent not found: ${name}`);
      return { stdout: ag.output || "", stderr: "" };
    }

    if (group === "agent" && cmd === "wait") {
      // 测试里同步扫表推进，立刻返回即可（kernel 会因 <20ms 不自激）。
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    }

    throw new Error(`unexpected herdr args: ${rawArgs.join(" ")}`);
  };

  return { exec, workspaces, tabs, agents, calls };
}

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

function makeKernel(dir, mock, herdrExec, extraCfg = {}) {
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
    herdrExec,
    ...extraCfg,
  });
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

test("1. 同节点多任务并发认领与执行（maxConcurrent=2，3任务排队与补位）", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
      workers: {
        claude: {
          context: "herdr",
          herdr_kind: "claude",
          herdr_args: ["--dangerously-skip-permissions"],
          herdr_env: { CUSTOM_FLAG: "yes" },
          timeout_sec: 120,
        },
      },
    }), { mode: 0o600 });

    const mock = new MockBus({ tables: TABLES });
    const herdr = createMockHerdr();
    const kernel = makeKernel(dir, mock, herdr.exec, { herdrSession: "prod" });

    await seedTask(mock, { Task_ID: "TASK-H-1" });
    await seedTask(mock, { Task_ID: "TASK-H-2" });
    await seedTask(mock, { Task_ID: "TASK-H-3" });

    await kernel.sweepOnce();

    assert.equal(f1(await taskOf(mock, "TASK-H-1"), "Status"), "working");
    assert.equal(f1(await taskOf(mock, "TASK-H-2"), "Status"), "working");
    assert.equal(f1(await taskOf(mock, "TASK-H-3"), "Status"), "submitted");
    assert.equal(kernel.activeHerdrCount(), 2);

    // 验证 --session 前置参数、AH_* 环境变量与 herdr_env / herdr_args 注入
    const tabList = [...herdr.tabs.values()];
    assert.equal(tabList.length, 2);
    for (const tid of ["TASK-H-1", "TASK-H-2"]) {
      const tab = tabList.find((t) => t.label === tid);
      assert.ok(tab);
      assert.equal(tab.env.AH_TASK_ID, tid);
      assert.equal(tab.env.AH_NODE, "node-a");
      assert.equal(tab.env.AH_WORKER, "claude");
      assert.equal(tab.env.AH_RUN_DIR, path.join(dir, "runs", tid));
      assert.equal(tab.env.AH_INPUT_PATH, path.join(dir, "runs", tid, "input.json"));
      assert.equal(tab.env.AH_RECEIPT_PATH, path.join(dir, "runs", tid, "receipt.txt"));
      assert.equal(tab.env.CUSTOM_FLAG, "yes");

      const ledger = readHerdrLedger(dir, tid);
      assert.equal(ledger.state, "working");
      assert.equal(ledger.agent_name, herdrAgentName(tid));
      assert.equal(fs.statSync(path.join(dir, "runs", tid, "herdr.json")).mode & 0o777, 0o600);
      assert.deepEqual(herdr.agents.get(ledger.agent_name).extraArgs, ["--dangerously-skip-permissions"]);
    }
    assert.equal(herdr.calls.every((c) => c[0] === "--session" && c[1] === "prod"), true);

    // 完成任务 1（通过 receipt.txt 双通道回执），应关闭其 Tab 并立即补位认领 TASK-H-3
    const ag1 = herdr.agents.get(herdrAgentName("TASK-H-1"));
    ag1.status = "idle";
    fs.writeFileSync(path.join(dir, "runs", "TASK-H-1", "receipt.txt"), "任务1已完成。\n", { mode: 0o600 });

    await kernel.sweepOnce();

    assert.equal(f1(await taskOf(mock, "TASK-H-1"), "Status"), "completed");
    assert.equal(readHerdrLedger(dir, "TASK-H-1"), null);
    assert.equal(tabList.find((t) => t.label === "TASK-H-1").closed, true);
    assert.equal(f1(await taskOf(mock, "TASK-H-2"), "Status"), "working");
    assert.equal(f1(await taskOf(mock, "TASK-H-3"), "Status"), "working");
    assert.equal(kernel.activeHerdrCount(), 2);

    // 任务 2、3 通过终端 agent read 回退通道完成
    const ag2 = herdr.agents.get(herdrAgentName("TASK-H-2"));
    ag2.status = "done";
    ag2.output = "任务2通过终端读取完成。";
    const ag3 = herdr.agents.get(herdrAgentName("TASK-H-3"));
    ag3.status = "idle";
    ag3.output = "任务3通过终端读取完成。";

    await kernel.sweepOnce();
    assert.equal(f1(await taskOf(mock, "TASK-H-2"), "Status"), "completed");
    assert.equal(f1(await taskOf(mock, "TASK-H-3"), "Status"), "completed");
    assert.equal(kernel.activeHerdrCount(), 0);
    assert.equal([...herdr.tabs.values()].every((t) => t.closed), true);
  });
});

test("2. input-required 与 auth-required 驻留占槽与原地热续接（不被槽满挡住）", async () => {
  await withTemp(async (dir) => {
    const hubKey = loadOrCreateHubKey(dir);
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
      workers: {
        claude: { context: "herdr", herdr_kind: "claude", timeout_sec: 120 },
      },
    }), { mode: 0o600 });

    const mock = new MockBus({ tables: TABLES });
    const herdr = createMockHerdr();
    const kernel = makeKernel(dir, mock, herdr.exec, { hubPublicKey: hubKey.publicKey });

    await seedTask(mock, { Task_ID: "TASK-A", Context_ID: "CTX-A" });
    await seedTask(mock, { Task_ID: "TASK-B", Context_ID: "CTX-B" });
    await seedTask(mock, { Task_ID: "TASK-C", Context_ID: "CTX-C" });

    // 第一轮：A 与 B 启动进入 working，C 停在 submitted
    await kernel.sweepOnce();
    assert.equal(f1(await taskOf(mock, "TASK-A"), "Status"), "working");
    assert.equal(f1(await taskOf(mock, "TASK-B"), "Status"), "working");
    assert.equal(f1(await taskOf(mock, "TASK-C"), "Status"), "submitted");

    // 任务 A 提出 agent-ask 进入 input-required：Pane 不关、herdr.json 变为 parked、依然占槽
    const agentAName = herdrAgentName("TASK-A");
    const agA = herdr.agents.get(agentAName);
    agA.status = "idle";
    fs.writeFileSync(
      path.join(dir, "runs", "TASK-A", "receipt.txt"),
      "```agent-ask\n请确认目标分支名称？\n```\n",
    );

    await kernel.sweepOnce();
    const taskA1 = await taskOf(mock, "TASK-A");
    assert.equal(f1(taskA1, "Status"), "input-required");
    assert.equal(f1(await taskOf(mock, "TASK-C"), "Status"), "submitted", "驻留任务 A 仍占槽，C 不得抢占");
    assert.equal(kernel.activeHerdrCount(), 2);
    const tabA = [...herdr.tabs.values()].find((t) => t.label === "TASK-A");
    assert.equal(tabA.closed, false);
    assert.equal(readHerdrLedger(dir, "TASK-A").state, "parked");
    assert.equal(fs.existsSync(path.join(dir, "runs", "TASK-A", "receipt.txt")), false);

    // 发起方回复 answer：槽满(2/2)下任务 A 直接原地热续接，不重开 Tab
    const tabCountBefore = herdr.tabs.size;
    await mock.createRecord(TABLES.messages, {
      Msg_ID: "MSG-A-03",
      Task_ID: "TASK-A",
      Context_ID: "CTX-A",
      From_Node: "hub",
      To_Node: "node-a",
      Role: "user",
      Kind: "answer",
      In_Reply_To: f1(taskA1, "Status_Msg"),
      Created_At: "2026-01-15T09:05:00+0800",
    });
    await mock.createRecord(TABLES.parts, {
      Part_ID: "MSG-A-03-P1",
      Parent_ID: "MSG-A-03",
      Parent_Type: "message",
      Seq: 1,
      Kind: "text",
      Text: "main",
    });

    await kernel.sweepOnce();
    assert.equal(f1(await taskOf(mock, "TASK-A"), "Status"), "working");
    assert.equal(herdr.tabs.size, tabCountBefore, "热续接不应创建新 Tab");
    assert.equal(agA.prompts.length, 2, "应在原 agent_name 上直接发第 2 次 prompt");
    assert.equal(readHerdrLedger(dir, "TASK-A").turn_count, 2);
    const inputA = JSON.parse(fs.readFileSync(path.join(dir, "runs", "TASK-A", "input.json"), "utf8"));
    assert.equal(inputA.turns[0].answer, "main");

    // 任务 A 接着在执行中申请动态审批 agent-auth -> auth-required 驻留占槽 -> 签名批准后原地热续接
    agA.status = "idle";
    agA.output = "```agent-auth\n推送代码到 origin/main\n```";
    await kernel.sweepOnce();

    const taskA2 = await taskOf(mock, "TASK-A");
    assert.equal(f1(taskA2, "Status"), "auth-required");
    assert.equal(tabA.closed, false);
    assert.equal(readHerdrLedger(dir, "TASK-A").state, "parked");
    assert.equal(kernel.activeHerdrCount(), 2);

    const authReqId = f1(taskA2, "Status_Msg");
    const sig = signDecision(hubKey.privateKey, { taskId: "TASK-A", requestId: authReqId, decision: "approve" });
    await mock.createRecord(TABLES.messages, {
      Msg_ID: "MSG-A-05",
      Task_ID: "TASK-A",
      Context_ID: "CTX-A",
      From_Node: "hub",
      To_Node: "node-a",
      Role: "user",
      Kind: "auth_decision",
      In_Reply_To: authReqId,
      Created_At: "2026-01-15T09:06:00+0800",
    });
    await mock.createRecord(TABLES.parts, {
      Part_ID: "MSG-A-05-P1",
      Parent_ID: "MSG-A-05",
      Parent_Type: "message",
      Seq: 1,
      Kind: "data",
      Data: JSON.stringify({ decision: "approve", sig }),
    });

    await kernel.sweepOnce();
    assert.equal(f1(await taskOf(mock, "TASK-A"), "Status"), "working");
    assert.equal(herdr.tabs.size, tabCountBefore, "auth-required 热续接不应新建 Tab");
    assert.equal(agA.prompts.length, 3);
    assert.equal(readHerdrLedger(dir, "TASK-A").turn_count, 3);
    const inputA2 = JSON.parse(fs.readFileSync(path.join(dir, "runs", "TASK-A", "input.json"), "utf8"));
    assert.equal(inputA2.approvals.length, 1);
    assert.equal(inputA2.approvals[0].decision, "approve");

    // 最终 A 完成并关 Tab，C 自动补位！
    agA.status = "idle";
    fs.writeFileSync(path.join(dir, "runs", "TASK-A", "receipt.txt"), "已推送到 main。\n");
    await kernel.sweepOnce();
    assert.equal(f1(await taskOf(mock, "TASK-A"), "Status"), "completed");
    assert.equal(tabA.closed, true);
    assert.equal(readHerdrLedger(dir, "TASK-A"), null);
    assert.equal(f1(await taskOf(mock, "TASK-C"), "Status"), "working");
  });
});

test("3. 热续接失败（Pane 意外丢失）时自动冷启动重建兜底", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
      workers: {
        claude: { context: "herdr", herdr_kind: "claude", timeout_sec: 120 },
      },
    }), { mode: 0o600 });

    const mock = new MockBus({ tables: TABLES });
    const herdr = createMockHerdr();
    const kernel = makeKernel(dir, mock, herdr.exec);

    await seedTask(mock, { Task_ID: "TASK-FALLBACK", Context_ID: "CTX-FB" });
    await kernel.sweepOnce();

    const agentName = herdrAgentName("TASK-FALLBACK");
    const ag1 = herdr.agents.get(agentName);
    ag1.status = "idle";
    ag1.output = "```agent-ask\n继续吗？\n```";
    await kernel.sweepOnce();

    const paused = await taskOf(mock, "TASK-FALLBACK");
    assert.equal(f1(paused, "Status"), "input-required");
    assert.equal(herdr.tabs.size, 1);

    // 模拟原 Pane / Agent 意外丢失
    herdr.agents.delete(agentName);

    await mock.createRecord(TABLES.messages, {
      Msg_ID: "MSG-FALLBACK-03",
      Task_ID: "TASK-FALLBACK",
      Context_ID: "CTX-FB",
      From_Node: "hub",
      To_Node: "node-a",
      Role: "user",
      Kind: "answer",
      In_Reply_To: f1(paused, "Status_Msg"),
      Created_At: "2026-01-15T09:10:00+0800",
    });
    await mock.createRecord(TABLES.parts, {
      Part_ID: "MSG-FALLBACK-03-P1",
      Parent_ID: "MSG-FALLBACK-03",
      Parent_Type: "message",
      Seq: 1,
      Kind: "text",
      Text: "继续",
    });

    await kernel.sweepOnce();
    assert.equal(f1(await taskOf(mock, "TASK-FALLBACK"), "Status"), "working");
    assert.equal(herdr.tabs.size, 2, "原 Pane 丢失后应冷重开新 Tab");
    const ag2 = herdr.agents.get(agentName);
    assert.ok(ag2);
    assert.equal(ag2.prompts.length, 1);

    ag2.status = "idle";
    fs.writeFileSync(path.join(dir, "runs", "TASK-FALLBACK", "receipt.txt"), "冷重建后顺利完成。\n");
    await kernel.sweepOnce();
    assert.equal(f1(await taskOf(mock, "TASK-FALLBACK"), "Status"), "completed");
    assert.equal(readHerdrLedger(dir, "TASK-FALLBACK"), null);
  });
});

test("3b. TUI blocked 态挂起占槽、回复后 send-keys 解阻并热续接，以及重启后从磁盘账本接管", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
      workers: {
        claude: { context: "herdr", herdr_kind: "claude", timeout_sec: 120 },
      },
    }), { mode: 0o600 });

    const mock = new MockBus({ tables: TABLES });
    const herdr = createMockHerdr();
    const kernel1 = makeKernel(dir, mock, herdr.exec);

    await seedTask(mock, { Task_ID: "TASK-BLK", Context_ID: "CTX-BLK" });
    await kernel1.sweepOnce();

    const agentName = herdrAgentName("TASK-BLK");
    const ag = herdr.agents.get(agentName);
    ag.status = "blocked";
    ag.output = "Allow bash command rm -rf build/? [y/N]";
    await kernel1.sweepOnce();

    const paused = await taskOf(mock, "TASK-BLK");
    assert.equal(f1(paused, "Status"), "input-required");
    assert.equal(readHerdrLedger(dir, "TASK-BLK").state, "parked");
    assert.equal(readHerdrLedger(dir, "TASK-BLK").blocked, true);

    // 模拟守护进程重启：新 Kernel 实例从磁盘 herdr.json 接管 parked 占槽并完成热续接
    kernel1.stopHerdrTimers();
    const kernel2 = makeKernel(dir, mock, herdr.exec);
    await kernel2.sweepOnce();
    assert.equal(kernel2.activeHerdrCount(), 1);
    assert.equal(kernel2._herdrFlights.get("TASK-BLK")?.state, "parked");

    await mock.createRecord(TABLES.messages, {
      Msg_ID: "MSG-BLK-03",
      Task_ID: "TASK-BLK",
      Context_ID: "CTX-BLK",
      From_Node: "hub",
      To_Node: "node-a",
      Role: "user",
      Kind: "answer",
      In_Reply_To: f1(paused, "Status_Msg"),
      Created_At: "2026-01-15T09:12:00+0800",
    });
    await mock.createRecord(TABLES.parts, {
      Part_ID: "MSG-BLK-03-P1",
      Parent_ID: "MSG-BLK-03",
      Parent_Type: "message",
      Seq: 1,
      Kind: "text",
      Text: "允许清理 build 目录",
    });

    await kernel2.sweepOnce();
    assert.equal(f1(await taskOf(mock, "TASK-BLK"), "Status"), "working");
    assert.deepEqual(ag.keys, ["esc"]);
    assert.equal(ag.prompts.length, 2);
    assert.equal(herdr.tabs.size, 1);

    ag.status = "idle";
    fs.writeFileSync(path.join(dir, "runs", "TASK-BLK", "receipt.txt"), "已清理并构建通过。\n");
    await kernel2.sweepOnce();
    assert.equal(f1(await taskOf(mock, "TASK-BLK"), "Status"), "completed");
    assert.equal(kernel2.activeHerdrCount(), 0);
  });
});

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

test("纯 TUI 横幅和粘贴占位符不是有效回执", () => {
  const banner = "Claude Code v2.1.329\nHaiku\n";
  assert.equal(isTerminalChromeOnly(banner), true);
  assert.equal(isTerminalChromeOnly("[Pasted text #1 +10 lines]"), true);
  assert.equal(hasPastedPlaceholder("[Pasted text #1 +10 lines]"), true);
  assert.equal(isTerminalChromeOnly("已完成任务，结果是 42"), false);
});

test("herdr 只有启动横幅时不得标记 completed", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
      workers: {
        claude: { context: "herdr", herdr_kind: "claude", timeout_sec: 120 },
      },
    }), { mode: 0o600 });
    const mock = new MockBus({ tables: TABLES });
    const herdr = createMockHerdr();
    const kernel = makeKernel(dir, mock, herdr.exec);
    await seedTask(mock, { Task_ID: "TASK-BANNER", Context_ID: "CTX-BANNER" });
    await kernel.sweepOnce();
    assert.equal(f1(await taskOf(mock, "TASK-BANNER"), "Status"), "working");
    await kernel.sweepOnce();
    assert.equal(f1(await taskOf(mock, "TASK-BANNER"), "Status"), "working");
    const ag = herdr.agents.get(herdrAgentName("TASK-BANNER"));
    ag.status = "idle";
    ag.output = "Claude Code v2.1.329\nHaiku\n";
    await kernel.sweepOnce();
    assert.equal(f1(await taskOf(mock, "TASK-BANNER"), "Status"), "working");
    await kernel.sweepOnce();
    const done = await taskOf(mock, "TASK-BANNER");
    assert.equal(f1(done, "Status"), "failed");
    assert.notEqual(f1(done, "Status"), "completed");
  });
});
