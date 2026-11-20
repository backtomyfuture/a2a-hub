// busType=agent：分 Agent Token 走官方 Agent Gateway，不碰机主表接口和 /api/v1/poll。

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { AgentDaemon, shouldRefreshInbox } from "../src/agent-daemon.mjs";
import { AgentGatewayClient } from "../src/bus/agent-client.mjs";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { f1, DEFAULT_TABLES } from "../src/bus/tables.mjs";
import { loadConfig } from "../src/config.mjs";
import { ApprovalService } from "../src/hub/approval.mjs";
import { AgentTokenStore } from "../src/hub/agent-tokens.mjs";
import { buildOnboarding } from "../src/hub/admission.mjs";
import { loadOrCreateHubKey } from "../src/approval-sign.mjs";
import { markInboxStatus, readInbox } from "../src/inbox.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { LongPollBroker } from "../src/server/longpoll-broker.mjs";
import { resolveSkillsForHost, runSetup } from "../src/setup.mjs";
import { withTemp } from "./helpers.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "bin", "ah.mjs");

function cliEnv() {
  const env = { ...process.env };
  delete env.AH_HOME;
  env.AH_API_TOKEN = "not-the-agent-token";
  env.HUB_URL = "http://127.0.0.1:9";
  return env;
}

const execFileAsync = promisify(execFile);

// 必须异步拉起 CLI。同步 execFileSync 会卡住本进程事件循环，Hub 的 HTTP 服务无法回包。
async function ah(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [BIN, ...args], {
      encoding: "utf8",
      env: cliEnv(),
      timeout: 20_000,
    });
    return stdout.trim();
  } catch (err) {
    const detail = [err.stdout, err.stderr].filter(Boolean).join("\n");
    if (detail) err.message = `${err.message}\n${detail}`;
    throw err;
  }
}

function writeAgentHome(dir, { node, agentRole, token, hubUrl }) {
  fs.mkdirSync(dir, { recursive: true });
  const tokenPath = path.join(dir, "token");
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(tokenPath, 0o600);
  const nodeJson = {
    node,
    role: "node",
    kind: "agent",
    busType: "agent",
    hubUrl,
    agentRole,
    receiveMode: "http-longpoll",
    tokenFile: tokenPath,
    longPollSec: 25,
  };
  fs.writeFileSync(path.join(dir, "node.json"), `${JSON.stringify(nodeJson, null, 2)}\n`);
  assert.equal(JSON.stringify(nodeJson).includes(token), false);
  return tokenPath;
}

function inboxItem(dir, taskId) {
  return readInbox(dir).find((item) => item.task_id === taskId);
}

test("shouldRefreshInbox：水位没变不盖回 pending，答复或回到 working 才重新入队", () => {
  const base = { status_msg: "MSG-1", latest_msg_id: "MSG-1", answers: [] };
  assert.equal(shouldRefreshInbox(null, { ...base, status: "submitted" }), true);
  assert.equal(shouldRefreshInbox({ status: "acked", ...base }, { ...base, status: "working" }), false);
  assert.equal(shouldRefreshInbox({ status: "pending", ...base }, { ...base, status: "working", status_msg: "MSG-2" }), true);
  assert.equal(shouldRefreshInbox(
    { status: "waiting-answer", status_msg: "MSG-1", latest_msg_id: "MSG-1" },
    { status: "working", status_msg: "MSG-1", answers: [{ msg_id: "MSG-2" }] },
  ), true);
  assert.equal(shouldRefreshInbox({ status: "done", ...base }, { ...base, status: "working" }), false);
});

test("resolveSkillsForHost：显式 agentRole 才覆盖原矩阵", () => {
  assert.deepEqual(resolveSkillsForHost({ role: "node", kind: "host" }), ["ah"]);
  assert.deepEqual(resolveSkillsForHost({ role: "node", kind: "agent" }), ["ah-inbox"]);
  assert.deepEqual(resolveSkillsForHost({ agentRole: "worker" }), ["ah-inbox"]);
  assert.deepEqual(resolveSkillsForHost({ agentRole: "leader" }), ["ah", "ah-inbox"]);
  assert.deepEqual(resolveSkillsForHost({ agentRole: "hybrid" }), ["ah", "ah-inbox"]);
});

test("Muse 模板提示词带临时 VM 自愈，且 Token 仍只出现一次", () => {
  const secret = "aht_prompt_secret_once";
  const muse = buildOnboarding({
    hubUrl: "https://hub.example",
    node: "muse-vm",
    access: "http",
    role: "worker",
    authRequired: true,
    token: secret,
    receive: "longpoll",
    template: "muse",
  });
  assert.match(muse.prompt, /每 5 秒/);
  assert.match(muse.prompt, /ah service --ensure --config/);
  assert.match(muse.prompt, /runtime hook/);
  assert.match(muse.prompt, /\/tmp\/\.a2a-hub-muse-vm\.lock/);
  assert.match(muse.prompt, /~\/\.a2a-hub-muse-vm\/agent\.token/);
  assert.equal(muse.prompt.includes("每 5 分钟"), false);
  assert.equal(muse.prompt.split(secret).length - 1, 1);
  assert.match(muse.steps.join("\n"), /ah service --ensure/);
  // 代理适配由 ah CLI 自重启解决，提示词不再要求对方手设 NODE_USE_ENV_PROXY。
  assert.equal(muse.prompt.includes("NODE_USE_ENV_PROXY"), false);
  // 通用长连接模板不再夹带 VM 自愈段，两套协议不混发。
  const plain = buildOnboarding({
    hubUrl: "https://hub.example",
    node: "vps-1",
    access: "http",
    role: "worker",
    authRequired: true,
    token: secret,
    receive: "longpoll",
  });
  assert.equal(plain.prompt.includes("ah service"), false);
  assert.equal(plain.prompt.includes("ah join"), false);
  assert.match(plain.prompt, /poll\?timeout=25/);
});

test("loadConfig：tokenFile 优先于环境里的 AH_API_TOKEN，且不建 HttpBus", async () => {
  await withTemp(async (dir) => {
    const token = "aht_from_file_not_env";
    writeAgentHome(dir, { node: "cfg-node", agentRole: "leader", token, hubUrl: "http://127.0.0.1:9" });
    const prev = process.env.AH_API_TOKEN;
    process.env.AH_API_TOKEN = "owner-from-env";
    try {
      const cfg = loadConfig(dir);
      assert.equal(cfg.busType, "agent");
      assert.equal(cfg.bus, null);
      assert.equal(cfg.role, "node");
      assert.equal(cfg.kind, "agent");
      assert.equal(cfg.agentRole, "leader");
      assert.equal(cfg.apiToken, token);
      assert.equal(cfg.agentClient.apiToken, token);
      assert.equal(cfg.agentClient.redact(`see ${token}`).includes(token), false);
    } finally {
      if (prev == null) delete process.env.AH_API_TOKEN;
      else process.env.AH_API_TOKEN = prev;
    }
  });
});

test("Agent Gateway 客户端：分 Agent Token 跑通 daemon / inbox / task，表接口仍是 403", async () => {
  await withTemp(async (rootDir) => {
    const hubDir = path.join(rootDir, "hub");
    fs.mkdirSync(hubDir, { recursive: true });
    const ownerToken = "owner-token-agent-gw";
    const key = loadOrCreateHubKey(hubDir);
    const broker = new LongPollBroker({ initialSeq: 0 });
    const bus = new SqliteBus({ dbPath: path.join(hubDir, "hub.db"), tables: DEFAULT_TABLES, broker });
    const approval = new ApprovalService({
      bus,
      ownerId: "",
      allowLocalOwner: true,
      statePath: path.join(hubDir, "approval_state.json"),
      signKey: key.privateKey,
      log: () => {},
    });
    const httpHandle = await startHubHttpServer({
      cfg: {
        node: "mac-mini-hub",
        configDir: hubDir,
        listen: "127.0.0.1:0",
        apiToken: ownerToken,
        hubPublicKey: key.publicKey,
      },
      bus,
      broker,
      approval,
      log: () => {},
      onWake: () => {},
    });
    const baseUrl = httpHandle.localUrl;
    const logs = [];
    try {
      const store = new AgentTokenStore(hubDir);
      const workerToken = store.issue({ node: "gw-worker", role: "worker", scopes: [] }).token;
      const leaderToken = store.issue({ node: "gw-leader", role: "leader", scopes: [] }).token;
      const setupToken = store.issue({ node: "setup-agent", role: "worker", scopes: [] }).token;
      const workerDir = path.join(rootDir, "worker");
      const leaderDir = path.join(rootDir, "leader");
      writeAgentHome(workerDir, { node: "gw-worker", agentRole: "worker", token: workerToken, hubUrl: baseUrl });
      writeAgentHome(leaderDir, { node: "gw-leader", agentRole: "leader", token: leaderToken, hubUrl: baseUrl });

      const workerCfg = loadConfig(workerDir);
      const leaderCfg = loadConfig(leaderDir);
      const workerDaemon = new AgentDaemon(workerCfg, { log: (m) => logs.push(String(m)), heartbeatMs: 0 });
      const leaderDaemon = new AgentDaemon(leaderCfg, { log: (m) => logs.push(String(m)), heartbeatMs: 0 });
      await workerDaemon.run({ once: true });
      await leaderDaemon.run({ once: true });

      const admit = await fetch(`${baseUrl}/api/v1/admin/nodes/gw-worker/admission`, {
        method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ admission: "admitted" }),
      });
      assert.equal(admit.status, 200);

      const note = path.join(rootDir, "note.txt");
      const artifact = path.join(rootDir, "result.txt");
      fs.writeFileSync(note, "hello-attachment");
      fs.writeFileSync(artifact, "result-body");
      const criteria = JSON.stringify([{ id: "c1", text: "结果可读" }]);
      const doneId = await ah([
        "task", "create", "--config", leaderDir, "--to", "gw-worker",
        "--text", "请处理附件", "--criteria", criteria, "--file", note,
      ]);
      assert.match(doneId, /^TASK-/);

      await workerDaemon.run({ once: true });
      const claimed = inboxItem(workerDir, doneId);
      assert.equal(claimed.status, "pending");
      assert.equal(claimed.files.length, 1);
      assert.equal(fs.readFileSync(claimed.files[0].local_path, "utf8"), "hello-attachment");
      const savedMsg = claimed.status_msg;

      markInboxStatus(workerDir, doneId, "acked");
      await workerDaemon.ingestTasks([{
        task_id: doneId,
        status: "working",
        status_msg: savedMsg,
        instruction: claimed.text,
      }]);
      assert.equal(inboxItem(workerDir, doneId).status, "acked");

      const beforeHb = f1(await taskRow(bus, doneId), "Heartbeat_At");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await workerDaemon.sweepHeartbeats();
      const afterHb = f1(await taskRow(bus, doneId), "Heartbeat_At");
      assert.notEqual(afterHb, beforeHb);
      assert.equal(f1(await taskRow(bus, doneId), "Status"), "working");

      const doneOut = await ah([
        "inbox", "done", "--config", workerDir, "--task", doneId,
        "--text", "做好了", "--artifact", artifact, "--check", "c1=pass:读过附件",
      ]);
      assert.match(doneOut, /已完成/);
      const doneRow = await taskRow(bus, doneId);
      assert.equal(f1(doneRow, "Status"), "completed");
      const meta = JSON.parse(f1(doneRow, "Metadata") || "{}");
      assert.equal(meta.acceptance.checks[0].id, "c1");
      assert.equal(meta.acceptance.checks[0].verdict, "pass");
      const arts = (await bus.listRecords(DEFAULT_TABLES.artifacts)).filter((a) => f1(a, "Task_ID") === doneId);
      assert.ok(arts.length >= 1);
      assert.equal(inboxItem(workerDir, doneId).status, "done");

      markInboxStatus(workerDir, doneId, "pending");
      await workerDaemon.sweepHeartbeats();
      assert.equal(inboxItem(workerDir, doneId).status, "done");

      await leaderDaemon.run({ once: true });
      const present = fs.readFileSync(path.join(leaderDir, "present_queue.jsonl"), "utf8");
      assert.match(present, new RegExp(doneId));
      assert.match(present, /completed/);
      assert.equal(present.includes(leaderToken), false);

      const askId = await ah([
        "task", "create", "--config", leaderDir, "--to", "gw-worker", "--text", "需要追问的任务",
      ]);
      await workerDaemon.run({ once: true });
      await ah(["inbox", "ask", "--config", workerDir, "--task", askId, "--text", "缺一份名单"]);
      assert.equal(f1(await taskRow(bus, askId), "Status"), "input-required");
      assert.equal(inboxItem(workerDir, askId).status, "waiting-answer");
      // 答复会把状态拉回 working。updates 只看当前状态，所以要在答复前收下这条 input-required。
      await leaderDaemon.run({ once: true });
      assert.match(fs.readFileSync(path.join(leaderDir, "present_queue.jsonl"), "utf8"), /input-required/);
      const replyOut = await ah(["task", "reply", "--config", leaderDir, "--task", askId, "--text", "名单在附件说明里"]);
      assert.match(replyOut, /已答复/);
      await workerDaemon.run({ once: true });
      assert.equal(inboxItem(workerDir, askId).status, "pending");
      assert.equal(f1(await taskRow(bus, askId), "Status"), "working");

      const failId = await ah([
        "task", "create", "--config", leaderDir, "--to", "gw-worker", "--text", "这单会失败",
      ]);
      await workerDaemon.run({ once: true });
      await ah(["inbox", "fail", "--config", workerDir, "--task", failId, "--text", "依赖缺失"]);
      assert.equal(f1(await taskRow(bus, failId), "Status"), "failed");
      assert.equal(inboxItem(workerDir, failId).status, "failed");

      const authId = await ah([
        "task", "create", "--config", leaderDir, "--to", "gw-worker", "--text", "这单要批准",
      ]);
      await workerDaemon.run({ once: true });
      await ah(["inbox", "auth", "--config", workerDir, "--task", authId, "--text", "要删除远端目录"]);
      assert.equal(f1(await taskRow(bus, authId), "Status"), "auth-required");
      assert.equal(inboxItem(workerDir, authId).status, "waiting-auth");

      await leaderDaemon.run({ once: true });
      const present2 = fs.readFileSync(path.join(leaderDir, "present_queue.jsonl"), "utf8");
      assert.match(present2, /input-required/);
      assert.match(present2, /auth-required/);

      const cancelId = await ah([
        "task", "create", "--config", leaderDir, "--to", "gw-worker", "--text", "这单要撤销",
      ]);
      const cancelOut = await ah(["task", "cancel", "--config", leaderDir, "--task", cancelId, "--text", "不需要了"]);
      assert.match(cancelOut, /已取消/);
      assert.equal(f1(await taskRow(bus, cancelId), "Status"), "canceled");
      const showOut = await ah(["task", "show", "--config", leaderDir, cancelId]);
      assert.match(showOut, /canceled/);

      const denied = await Promise.all([
        fetch(`${baseUrl}/api/v1/tables/tasks/records`, { headers: { authorization: `Bearer ${workerToken}` } }),
        fetch(`${baseUrl}/api/v1/poll?timeout=0`, { headers: { authorization: `Bearer ${workerToken}` } }),
        fetch(`${baseUrl}/api/v1/tables/tasks/records`, { headers: { authorization: `Bearer ${leaderToken}` } }),
        fetch(`${baseUrl}/api/v1/poll?timeout=0`, { headers: { authorization: `Bearer ${leaderToken}` } }),
      ]);
      assert.deepEqual(denied.map((res) => res.status), [403, 403, 403, 403]);

      const blob = [
        logs.join("\n"),
        fs.readFileSync(path.join(workerDir, "node.json"), "utf8"),
        fs.readFileSync(path.join(leaderDir, "node.json"), "utf8"),
        present2,
      ].join("\n");
      assert.equal(blob.includes(workerToken), false);
      assert.equal(blob.includes(leaderToken), false);

      const setupDir = path.join(rootDir, "setup-home");
      const setupTokenPath = path.join(rootDir, "setup.token");
      fs.writeFileSync(setupTokenPath, `${setupToken}\n`, { mode: 0o600 });
      const code = await runSetup(setupDir, [
        "--bus", "agent",
        "--agent-role", "worker",
        "--token-file", setupTokenPath,
        "--hub-url", baseUrl,
        "--node", "setup-agent",
        "--yes",
        "--force",
        "--skip-skill",
      ], ROOT);
      assert.equal(code, 0);
      const saved = JSON.parse(fs.readFileSync(path.join(setupDir, "node.json"), "utf8"));
      assert.equal(saved.busType, "agent");
      assert.equal(saved.role, "node");
      assert.equal(saved.kind, "agent");
      assert.equal(saved.agentRole, "worker");
      assert.equal(saved.tokenFile, setupTokenPath);
      assert.equal(saved.apiToken, undefined);
      assert.equal(fs.existsSync(path.join(setupDir, "app.env")), false);
      assert.equal(fs.existsSync(path.join(setupDir, "commands.json")), false);
      assert.equal(JSON.stringify(saved).includes(setupToken), false);
    } finally {
      await httpHandle.close();
      bus.close();
    }
  });
});

async function taskRow(bus, taskId) {
  const rows = await bus.listRecords(DEFAULT_TABLES.tasks);
  const row = rows.find((t) => f1(t, "Task_ID") === taskId);
  assert.ok(row, `缺少任务 ${taskId}`);
  return row;
}

test("ah service / join --help 暴露 --system 与 --agent", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ah-agent-help-"));
  try {
    const env = { ...process.env, HOME: tmp, AH_HOME: path.join(tmp, "cfg") };
    const serviceHelp = execFileSync(process.execPath, [BIN, "service", "--help"], { env, encoding: "utf8", timeout: 10_000 });
    assert.match(serviceHelp, /--system/);
    assert.match(serviceHelp, /--user/);
    assert.match(serviceHelp, /--name/);
    const joinHelp = execFileSync(process.execPath, [BIN, "join", "--help"], { env, encoding: "utf8", timeout: 10_000 });
    assert.match(joinHelp, /--agent/);
    assert.match(joinHelp, /--token-file/);
    assert.equal(fs.existsSync(path.join(tmp, "cfg")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
