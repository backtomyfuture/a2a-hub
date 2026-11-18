// 轻量检查：只读 check、不推进 Leader 水位、脚本下载与 a2a_check 的 IDLE/WORK/ERROR。
// 状态只写临时目录，不连外网，不碰 ~/.a2a-hub。

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES, f1 } from "../src/bus/tables.mjs";
import { BROWSER_USER_AGENT } from "../src/kernel-util.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { LongPollBroker } from "../src/server/longpoll-broker.mjs";
import { withTemp } from "./helpers.mjs";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PY = path.join(REPO_ROOT, "skills", "a2a-check", "a2a_check.py");
const SH = path.join(REPO_ROOT, "skills", "a2a-check", "a2a_check.sh");

function hasBin(bin, args = ["--version"]) {
  const res = spawnSync(bin, args, { encoding: "utf8" });
  return !res.error;
}

const hasPython = hasBin("python3");
const hasCurl = hasBin("curl");

async function apiJson(baseUrl, pathname, { method = "GET", token = "", body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data, text, type: res.headers.get("content-type") || "" };
}

async function withHub(fn) {
  await withTemp(async (rootDir) => {
    const hubDir = path.join(rootDir, "hub");
    fs.mkdirSync(hubDir, { recursive: true });
    const apiToken = "check-owner-token";
    const broker = new LongPollBroker({ initialSeq: 0 });
    const bus = new SqliteBus({
      dbPath: path.join(hubDir, "hub.db"),
      tables: DEFAULT_TABLES,
      broker,
    });
    const httpHandle = await startHubHttpServer({
      cfg: {
        node: "mac-mini-hub",
        configDir: hubDir,
        listen: "127.0.0.1:0",
        apiToken,
      },
      bus,
      broker,
      log: () => {},
      onWake: () => {},
    });
    try {
      await fn({ baseUrl: httpHandle.localUrl, apiToken, bus, broker });
    } finally {
      await httpHandle.close();
      bus.close();
    }
  });
}

async function addAgent(baseUrl, apiToken, node, role) {
  const res = await apiJson(baseUrl, "/api/v1/admin/agents", {
    method: "POST",
    token: apiToken,
    body: { node, access: "http", role },
  });
  assert.equal(res.status, 200, res.text);
  return res.data.token;
}

async function seedInstruction(bus, { taskId, from, to, status, claimedBy = "" }) {
  await bus.createRecord(bus.tables.messages, {
    Msg_ID: `MSG-${taskId}`,
    Task_ID: taskId,
    Context_ID: "CTX-CHECK",
    From_Node: from,
    To_Node: to,
    Role: "user",
    Kind: "instruction",
    Created_At: "2026-11-18T00:00:00.000Z",
  });
  await bus.createRecord(bus.tables.tasks, {
    Task_ID: taskId,
    Title: taskId,
    Source: from,
    Target_Node: to,
    Claimed_By: claimedBy,
    Status: status,
    Context_ID: "CTX-CHECK",
    Skill_ID: "agent",
  });
}

function runScript(bin, file, args, env) {
  // 必须异步拉起。spawnSync 会卡住本进程事件循环，同进程里的 Hub 就无法应答，脚本会一直等到超时。
  const childEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", NO_PROXY: "*", ...env };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    delete childEnv[key];
  }
  return new Promise((resolve) => {
    const child = spawn(bin, [file, ...args], { env: childEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("检查脚本语法，且文件里没有 Token", () => {
  const py = fs.readFileSync(PY, "utf8");
  const sh = fs.readFileSync(SH, "utf8");
  assert.match(py, new RegExp(BROWSER_USER_AGENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(sh, new RegExp(BROWSER_USER_AGENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(py.includes("aht_"), false);
  assert.equal(sh.includes("aht_"), false);

  const shCheck = spawnSync("sh", ["-n", SH], { encoding: "utf8" });
  assert.equal(shCheck.status, 0, shCheck.stderr);

  if (!hasPython) return;
  const compiled = spawnSync("python3", ["-m", "py_compile", PY], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(compiled.status, 0, compiled.stderr);
});

test("GET check 只读：worker 任务、working、leader 计数且不推进水位；跨节点 403；名册在线", async () => {
  await withHub(async ({ baseUrl, apiToken, bus }) => {
    const workerToken = await addAgent(baseUrl, apiToken, "grok-bot", "worker");
    const leaderToken = await addAgent(baseUrl, apiToken, "muse", "leader");

    const idle = await apiJson(baseUrl, "/api/v1/agents/grok-bot/check", { token: workerToken });
    assert.equal(idle.status, 200);
    assert.equal(idle.data.work, false);
    assert.deepEqual(idle.data.tasks, []);
    assert.deepEqual(idle.data.working, []);
    assert.equal(Object.hasOwn(idle.data, "updates"), false);

    await seedInstruction(bus, { taskId: "TASK-NEW", from: "muse", to: "grok-bot", status: "submitted" });
    await seedInstruction(bus, {
      taskId: "TASK-WORK",
      from: "muse",
      to: "grok-bot",
      status: "working",
      claimedBy: "grok-bot",
    });
    await seedInstruction(bus, { taskId: "TASK-DONE", from: "muse", to: "grok-bot", status: "completed" });
    await seedInstruction(bus, { taskId: "TASK-ASK", from: "muse", to: "grok-bot", status: "input-required" });

    const beforeMeta = await bus.getMeta("updates_watermark:muse");
    const beforeTasks = (await bus.listRecords(bus.tables.tasks)).map((row) => ({
      id: f1(row, "Task_ID"),
      status: f1(row, "Status"),
    }));

    const rosterBefore = await apiJson(baseUrl, "/api/v1/agents", { token: apiToken });
    const museBefore = rosterBefore.data.agents.find((agent) => agent.node === "muse");
    assert.ok(museBefore);
    assert.equal(museBefore.online, false);

    const leaderCheck = await apiJson(baseUrl, "/api/v1/agents/muse/check", { token: leaderToken });
    assert.equal(leaderCheck.status, 200);
    assert.equal(leaderCheck.data.work, true);
    assert.equal(leaderCheck.data.updates, 2);
    assert.deepEqual(leaderCheck.data.tasks, []);
    assert.equal(await bus.getMeta("updates_watermark:muse"), beforeMeta);

    const rosterAfter = await apiJson(baseUrl, "/api/v1/agents", { token: apiToken });
    const muse = rosterAfter.data.agents.find((agent) => agent.node === "muse");
    assert.ok(muse);
    assert.equal(muse.online, true);
    assert.equal(muse.role, "leader");

    const updates = await apiJson(baseUrl, "/api/v1/agents/muse/updates?new=1", { token: leaderToken });
    assert.equal(updates.status, 200);
    assert.deepEqual(updates.data.updates.map((item) => item.task_id).sort(), ["TASK-ASK", "TASK-DONE"]);
    assert.equal(await bus.getMeta("updates_watermark:muse"), String(updates.data.watermark));

    const workerCheck = await apiJson(baseUrl, "/api/v1/agents/grok-bot/check", { token: workerToken });
    assert.equal(workerCheck.status, 200);
    assert.equal(workerCheck.data.work, true);
    assert.deepEqual(workerCheck.data.tasks, ["TASK-NEW"]);
    assert.deepEqual(workerCheck.data.working, ["TASK-WORK"]);
    const poll = await apiJson(baseUrl, "/api/v1/agents/grok-bot/poll?timeout=0", { token: workerToken });
    assert.deepEqual(poll.data.tasks.map((item) => item.task_id), ["TASK-NEW"]);
    const rosterKept = await apiJson(baseUrl, "/api/v1/agents", { token: apiToken });
    assert.equal(rosterKept.data.agents.find((agent) => agent.node === "grok-bot").role, "worker");
    assert.equal(rosterKept.data.agents.find((agent) => agent.node === "muse").role, "leader");

    const ownerBoth = await apiJson(baseUrl, "/api/v1/agents/grok-bot/check", { token: apiToken });
    assert.equal(ownerBoth.data.work, true);
    assert.deepEqual(ownerBoth.data.tasks, ["TASK-NEW"]);
    assert.equal(ownerBoth.data.updates, 0);

    const ownerLeaderOnly = await apiJson(baseUrl, "/api/v1/agents/muse/check?role=leader", { token: apiToken });
    assert.equal(ownerLeaderOnly.data.updates >= 1, true);
    assert.deepEqual(ownerLeaderOnly.data.tasks, []);

    const foreign = await apiJson(baseUrl, "/api/v1/agents/muse/check", { token: workerToken });
    assert.equal(foreign.status, 403);
    assert.match(foreign.data.error, /不能以 muse 身份调用/);

    const badRole = await apiJson(baseUrl, "/api/v1/agents/grok-bot/check?role=nope", { token: apiToken });
    assert.equal(badRole.status, 400);

    const afterTasks = (await bus.listRecords(bus.tables.tasks)).map((row) => ({
      id: f1(row, "Task_ID"),
      status: f1(row, "Status"),
    }));
    assert.deepEqual(afterTasks, beforeTasks);

    const disc = await apiJson(baseUrl, "/.well-known/agent.json");
    assert.equal(disc.data.endpoints.check, "/api/v1/agents/{node}/check");
    assert.equal(disc.data.endpoints.checkScript, "/api/v1/kit/a2a_check.py");
  });
});

test("kit 下载需要鉴权，正文是脚本且不含 Token", async () => {
  await withHub(async ({ baseUrl, apiToken }) => {
    const workerToken = await addAgent(baseUrl, apiToken, "grok-bot", "worker");
    const bare = await apiJson(baseUrl, "/api/v1/kit/a2a_check.py");
    assert.equal(bare.status, 401);

    for (const name of ["a2a_check.py", "a2a_check.sh"]) {
      const res = await apiJson(baseUrl, `/api/v1/kit/${name}`, { token: workerToken });
      assert.equal(res.status, 200, name);
      assert.match(res.type, /text\/plain/);
      assert.equal(res.text, fs.readFileSync(path.join(REPO_ROOT, "skills", "a2a-check", name), "utf8"));
      assert.equal(res.text.includes(workerToken), false);
      assert.equal(res.text.includes(apiToken), false);
    }

    const owner = await apiJson(baseUrl, "/api/v1/kit/a2a_check.sh", { token: apiToken });
    assert.equal(owner.status, 200);
    const denied = await apiJson(baseUrl, "/api/v1/kit/other.sh", { token: workerToken });
    assert.equal(denied.status, 403);
  });
});

test("a2a_check.py / sh 对本地 Hub 与桩服务输出 IDLE、WORK、ERROR，并带浏览器 UA", async (t) => {
  if (!hasPython && !hasCurl) {
    t.skip("本机没有 python3 或 curl");
    return;
  }
  await withHub(async ({ baseUrl, apiToken, bus }) => {
    const workerToken = await addAgent(baseUrl, apiToken, "grok-bot", "worker");
    await addAgent(baseUrl, apiToken, "idle-bot", "worker");
    const idleToken = (await apiJson(baseUrl, "/api/v1/admin/tokens", { token: apiToken })).data.tokens
      .find((item) => item.node === "idle-bot");
    assert.ok(idleToken);
    const rotated = await apiJson(baseUrl, "/api/v1/admin/tokens/idle-bot/rotate", {
      method: "POST",
      token: apiToken,
      body: { role: "worker" },
    });
    const idleSecret = rotated.data.token;
    await seedInstruction(bus, { taskId: "TASK-NEW", from: "muse", to: "grok-bot", status: "submitted" });

    const cases = [];
    if (hasPython) cases.push(["python3", PY]);
    if (hasCurl) cases.push(["sh", SH]);
    for (const [bin, file] of cases) {
      const idle = await runScript(bin, file, ["--hub", baseUrl, "--node", "idle-bot", "--token", idleSecret], { A2A_HUB_TOKEN: "" });
      assert.equal(idle.status, 0, idle.stderr || idle.stdout);
      assert.equal(idle.stdout, "IDLE\n");
      assert.equal(idle.stdout.includes(idleSecret), false);

      const quiet = await runScript(bin, file, ["--hub", baseUrl, "--node", "idle-bot", "--token", idleSecret, "--silent-idle"], { A2A_HUB_TOKEN: "" });
      assert.equal(quiet.status, 0, quiet.stderr || quiet.stdout);
      assert.equal(quiet.stdout, "");

      const work = await runScript(bin, file, ["--hub", baseUrl, "--node", "grok-bot"], { A2A_HUB_TOKEN: workerToken });
      assert.equal(work.status, 0, work.stderr || work.stdout);
      const lines = work.stdout.trim().split("\n");
      assert.equal(lines[0], "WORK");
      const payload = JSON.parse(lines[1]);
      assert.equal(payload.work, true);
      assert.deepEqual(payload.tasks, ["TASK-NEW"]);
      assert.equal(work.stdout.includes(workerToken), false);

      const bad = await runScript(bin, file, ["--hub", baseUrl, "--node", "grok-bot", "--token", "aht_wrong"], { A2A_HUB_TOKEN: "" });
      assert.equal(bad.status, 2);
      assert.match(bad.stdout, /^ERROR HTTP 401 /);
      assert.equal(bad.stdout.includes("aht_wrong"), false);
    }
  });

  if (!hasPython && !hasCurl) return;
  const hits = [];
  const stub = http.createServer((req, res) => {
    hits.push({ url: req.url, ua: req.headers["user-agent"] || "", auth: req.headers.authorization || "" });
    if (req.url.endsWith("/deny/check")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no" }));
      return;
    }
    if (req.url.endsWith("/cf/check")) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("error code: 1010");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ work: false }));
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const port = stub.address().port;
  const stubUrl = `http://127.0.0.1:${port}`;
  try {
    const runners = [];
    if (hasPython) runners.push(["python3", PY]);
    if (hasCurl) runners.push(["sh", SH]);
    for (const [bin, file] of runners) {
      hits.length = 0;
      const ok = await runScript(bin, file, ["--hub", stubUrl, "--node", "idle", "--token", "aht_stub"], { A2A_HUB_TOKEN: "" });
      assert.equal(ok.status, 0, ok.stderr || ok.stdout);
      assert.equal(ok.stdout, "IDLE\n");
      assert.equal(hits.at(-1).ua, BROWSER_USER_AGENT);
      assert.equal(hits.at(-1).auth, "Bearer aht_stub");

      const denied = await runScript(bin, file, ["--hub", stubUrl, "--node", "deny", "--token", "aht_stub"], { A2A_HUB_TOKEN: "" });
      assert.equal(denied.status, 2);
      assert.match(denied.stdout, /^ERROR HTTP 401 /);
      assert.equal(denied.stdout.includes("aht_stub"), false);

      const cf = await runScript(bin, file, ["--hub", stubUrl, "--node", "cf", "--token", "aht_stub"], { A2A_HUB_TOKEN: "" });
      assert.equal(cf.status, 2);
      assert.match(cf.stdout, /HTTP 403/);
      assert.match(cf.stdout, /Cloudflare|User-Agent/);
      assert.equal(cf.stdout.includes("aht_stub"), false);
    }
  } finally {
    await new Promise((resolve) => stub.close(resolve));
  }
});
