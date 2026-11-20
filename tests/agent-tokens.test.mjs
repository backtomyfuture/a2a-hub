// 分 Agent Token：签发/轮换/吊销、机主权限不变、路由隔离、跨节点冒充、onboarding 内嵌与占位。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES } from "../src/bus/tables.mjs";
import { buildOnboarding } from "../src/hub/admission.mjs";
import { AgentTokenStore } from "../src/hub/agent-tokens.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { LongPollBroker } from "../src/server/longpoll-broker.mjs";
import { withTemp } from "./helpers.mjs";

async function apiJson(baseUrl, pathname, { method = "GET", token = "", body, headers = {} } = {}) {
  const reqHeaders = { ...headers };
  if (token) reqHeaders.authorization = `Bearer ${token}`;
  if (body !== undefined) reqHeaders["content-type"] = "application/json";
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: reqHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function withHub(fn, { apiToken = "owner-token-0123456789abcdef" } = {}) {
  await withTemp(async (rootDir) => {
    const hubDir = path.join(rootDir, "hub");
    fs.mkdirSync(hubDir, { recursive: true });
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
      await fn({ baseUrl: httpHandle.localUrl, apiToken, bus, hubDir });
    } finally {
      await httpHandle.close();
      bus.close();
    }
  });
}

function hashOf(token) {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

test("存储：签发只落哈希、同节点拒绝、轮换废旧、吊销、每分钟最多写一次 last_used", async () => {
  await withTemp(async (dir) => {
    let now = new Date("2026-04-01T00:00:10.000Z");
    const store = new AgentTokenStore(dir, { now: () => now });
    const issued = store.issue({ node: "grok-bot", role: "worker", scopes: ["admin"] });
    assert.match(issued.token, /^aht_[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.prefix, issued.token.slice(0, 10));
    assert.equal(issued.last_used_at, null);

    const file = path.join(dir, "agent_tokens.json");
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
    const raw = fs.readFileSync(file, "utf8");
    assert.equal(raw.includes(issued.token), false);
    const saved = JSON.parse(raw);
    assert.equal(saved.version, 1);
    assert.equal(saved.tokens[0].hash, hashOf(issued.token));
    assert.equal(saved.tokens[0].prefix, issued.prefix);
    assert.deepEqual(saved.tokens[0].scopes, ["admin"]);
    assert.equal(Object.hasOwn(saved.tokens[0], "token"), false);

    assert.throws(
      () => store.issue({ node: "grok-bot", role: "worker" }),
      /轮换/,
    );

    assert.equal(store.authenticate("aht_not-the-real-token"), null);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).tokens[0].last_used_at, null);

    const ident = store.authenticate(issued.token);
    assert.deepEqual(ident, { node: "grok-bot", role: "worker", scopes: ["admin"] });
    const afterFirst = fs.readFileSync(file, "utf8");
    assert.match(afterFirst, /2026-04-01T00:00:10/);
    now = new Date("2026-04-01T00:00:50.000Z");
    store.authenticate(issued.token);
    assert.equal(fs.readFileSync(file, "utf8"), afterFirst);
    now = new Date("2026-04-01T00:01:05.000Z");
    store.authenticate(issued.token);
    assert.notEqual(fs.readFileSync(file, "utf8"), afterFirst);
    assert.match(fs.readFileSync(file, "utf8"), /2026-04-01T00:01:05/);

    const rotated = store.rotate({ node: "grok-bot" });
    assert.notEqual(rotated.token, issued.token);
    assert.equal(rotated.role, "worker");
    assert.deepEqual(rotated.scopes, ["admin"]);
    assert.equal(store.authenticate(issued.token), null);
    assert.equal(store.authenticate(rotated.token)?.node, "grok-bot");
    assert.equal(raw.includes(rotated.token), false);
    assert.equal(fs.readFileSync(file, "utf8").includes(rotated.token), false);

    const created = store.rotate({ node: "muse", role: "leader", scopes: [] });
    assert.equal(created.role, "leader");
    assert.equal(store.listPublic().some((t) => t.hash), false);
    assert.equal(store.listPublic().map((t) => t.node).sort().join(), "grok-bot,muse");

    assert.equal(store.revoke("muse"), true);
    assert.equal(store.revoke("muse"), false);
    assert.equal(store.authenticate(created.token), null);
    assert.equal(store.get("muse"), null);
  });
});

test("onboarding：有 token 时内嵌明文，没有时用占位符；host/inbox 命令行仍是占位符", () => {
  const token = "aht_exampletokenvalue";
  const embedded = buildOnboarding({
    hubUrl: "https://hub.example.com/",
    node: "grok-bot",
    access: "http",
    role: "worker",
    authRequired: true,
    token,
  });
  assert.equal(embedded.prompt.includes(token), true);
  assert.equal(embedded.prompt.includes("<AH_API_TOKEN>"), false);
  assert.match(embedded.prompt, /poll\?timeout=0/);
  assert.match(embedded.prompt, /\/heartbeat/);
  // 提示词自包含，不再要求对方拉取协议 Skill；链接只在 onboarding.skills 里给机主参考。
  // 不再提及 /.well-known/agent.json 或 /api/v1/health 鉴权例外，避免诱导定时任务每轮多打无信息量健康检查。
  assert.deepEqual(embedded.skills, [{ name: "a2a-worker", url: "https://hub.example.com/api/v1/skills/a2a-worker" }]);
  assert.equal(embedded.prompt.includes("/.well-known/agent.json"), false);
  assert.match(embedded.prompt, /无需请求 \/health/);
  assert.equal(embedded.prompt.includes("127.0.0.1"), false);

  const leader = buildOnboarding({
    hubUrl: "https://hub.example.com",
    node: "muse",
    access: "http",
    role: "leader",
    token,
  });
  assert.match(leader.prompt, /updates\?new=1/);
  assert.match(leader.prompt, /idempotencyKey/);
  assert.match(leader.prompt, /绝不以任何方式代批/);
  assert.match(leader.prompt, /from 必须是 "muse"/);
  assert.equal(leader.prompt.includes("<AH_API_TOKEN>"), false);

  const hybrid = buildOnboarding({
    hubUrl: "https://hub.example.com",
    node: "both",
    access: "http",
    role: "hybrid",
    token,
  });
  assert.match(hybrid.prompt, /poll\?timeout=0/);
  assert.match(hybrid.prompt, /updates\?new=1/);

  const placeholder = buildOnboarding({
    hubUrl: "https://hub.example.com",
    node: "grok-bot",
    access: "http",
    role: "worker",
    authRequired: true,
  });
  assert.match(placeholder.prompt, /<AH_API_TOKEN>/);
  assert.equal(placeholder.prompt.includes(token), false);

  const host = buildOnboarding({
    hubUrl: "http://hub.local:8787",
    node: "box",
    access: "host",
    role: "worker",
    authRequired: true,
    token,
  });
  assert.ok(host.steps.some((s) => s.includes("ah join http://hub.local:8787 --node box --api-token <AH_API_TOKEN>")));
  assert.equal(host.steps.join("\n").includes(token), false);
});

test("HTTP：机主不受影响，Agent 按角色隔离，冒充与撤单受绑定节点约束", async () => {
  await withHub(async ({ baseUrl, apiToken, hubDir }) => {
    const state = await apiJson(baseUrl, "/api/v1/state", { token: apiToken });
    assert.equal(state.status, 200);
    const skills = await apiJson(baseUrl, "/api/v1/skills", { token: apiToken });
    assert.equal(skills.status, 200);

    const workerAdd = await apiJson(baseUrl, "/api/v1/admin/agents", {
      method: "POST",
      token: apiToken,
      body: { node: "grok-bot", access: "http", role: "worker", display_name: "Grok" },
    });
    assert.equal(workerAdd.status, 200);
    const workerToken = workerAdd.data.token;
    assert.match(workerToken, /^aht_/);
    assert.equal(workerAdd.data.onboarding.prompt.includes(workerToken), true);
    assert.equal(workerAdd.data.onboarding.prompt.includes("<AH_API_TOKEN>"), false);
    assert.equal(workerAdd.data.onboarding.prompt.includes(apiToken), false);
    const disk = fs.readFileSync(path.join(hubDir, "agent_tokens.json"), "utf8");
    assert.equal(disk.includes(workerToken), false);
    assert.equal(disk.includes(apiToken), false);

    const dup = await apiJson(baseUrl, "/api/v1/admin/agents", {
      method: "POST",
      token: apiToken,
      body: { node: "grok-bot", access: "http", role: "worker" },
    });
    assert.equal(dup.status, 409);
    assert.match(dup.data.error, /轮换/);

    const leaderAdd = await apiJson(baseUrl, "/api/v1/admin/agents", {
      method: "POST",
      token: apiToken,
      body: { node: "muse", access: "http", role: "leader" },
    });
    assert.equal(leaderAdd.status, 200);
    assert.equal(leaderAdd.data.card.cap_id, "CAP-muse-agent");
    assert.equal(leaderAdd.data.card.dispatchable, "Yes");
    assert.equal(leaderAdd.data.card.role, "leader");
    const leaderToken = leaderAdd.data.token;
    assert.equal(leaderAdd.data.onboarding.prompt.includes(leaderToken), true);

    const hostAdd = await apiJson(baseUrl, "/api/v1/admin/agents", {
      method: "POST",
      token: apiToken,
      body: { node: "mac-host", access: "host", role: "worker" },
    });
    assert.equal(hostAdd.status, 200);
    assert.equal(hostAdd.data.token, undefined);
    assert.match(hostAdd.data.onboarding.prompt, /<AH_API_TOKEN>/);
    assert.equal(hostAdd.data.onboarding.prompt.includes(apiToken), false);

    const listed = await apiJson(baseUrl, "/api/v1/admin/tokens", { token: apiToken });
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.data.tokens.map((t) => t.node).sort(),
      ["grok-bot", "muse"],
    );
    assert.equal(JSON.stringify(listed.data).includes(workerToken), false);
    assert.equal(JSON.stringify(listed.data).includes("sha256:"), false);

    assert.equal((await apiJson(baseUrl, "/api/v1/state")).status, 401);
    assert.equal((await apiJson(baseUrl, "/api/v1/state", { token: "aht_nope" })).status, 401);
    assert.equal((await apiJson(baseUrl, "/api/v1/state", { token: apiToken })).status, 200);
    assert.equal((await apiJson(baseUrl, "/api/v1/health")).status, 200);

    const workerState = await apiJson(baseUrl, "/api/v1/state", { token: workerToken });
    assert.equal(workerState.status, 403);
    assert.match(workerState.data.error, /\/api\/v1\/state/);
    for (const [pathname, method] of [
      ["/api/v1/approvals/TASK-1/decide", "POST"],
      ["/api/v1/admin/agents", "POST"],
      ["/api/v1/admin/tokens", "GET"],
      ["/api/v1/admin/tokens/grok-bot/rotate", "POST"],
      ["/api/v1/tables/tasks/records", "GET"],
      ["/api/v1/poll?timeout=0", "GET"],
      ["/api/v1/tasks", "POST"],
      ["/api/v1/agents/muse/updates?timeout=0", "GET"],
    ]) {
      const res = await apiJson(baseUrl, pathname, {
        method,
        token: workerToken,
        body: method === "GET" ? undefined : {},
      });
      assert.equal(res.status, 403, `${method} ${pathname} -> ${res.status} ${res.data.error}`);
    }

    assert.equal((await apiJson(baseUrl, "/api/v1/skills/a2a-worker", { token: workerToken })).status, 200);
    const reg = await apiJson(baseUrl, "/api/v1/agents/register", {
      method: "POST",
      token: workerToken,
      body: { role: "worker" },
    });
    assert.equal(reg.status, 200);
    assert.equal(reg.data.node, "grok-bot");
    const impersonate = await apiJson(baseUrl, "/api/v1/agents/register", {
      method: "POST",
      token: workerToken,
      body: { node: "muse", role: "worker" },
    });
    assert.equal(impersonate.status, 403);
    assert.equal(impersonate.data.error, "Token 绑定节点 grok-bot，不能以 muse 身份调用");
    const headerLie = await apiJson(baseUrl, "/api/v1/skills", {
      token: workerToken,
      headers: { "x-a2a-node": "muse" },
    });
    assert.equal(headerLie.status, 403);
    assert.match(headerLie.data.error, /不能以 muse 身份调用/);

    const pollSelf = await apiJson(baseUrl, "/api/v1/agents/grok-bot/poll?timeout=0", { token: workerToken });
    assert.equal(pollSelf.status, 200);
    const pollOther = await apiJson(baseUrl, "/api/v1/agents/muse/poll?timeout=0", { token: workerToken });
    assert.equal(pollOther.status, 403);
    assert.equal(pollOther.data.error, "Token 绑定节点 grok-bot，不能以 muse 身份调用");

    const hubTask = await apiJson(baseUrl, "/api/v1/tasks", {
      method: "POST",
      token: apiToken,
      body: { to: "grok-bot", cap: "agent", text: "机主的单" },
    });
    assert.equal(hubTask.status, 201);
    const leaderTask = await apiJson(baseUrl, "/api/v1/tasks", {
      method: "POST",
      token: leaderToken,
      body: { to: "grok-bot", cap: "agent", text: "缪斯的单", idempotencyKey: "matter-muse-1" },
    });
    assert.equal(leaderTask.status, 201);
    const forgedFrom = await apiJson(baseUrl, "/api/v1/tasks", {
      method: "POST",
      token: leaderToken,
      body: { from: "mac-mini-hub", to: "grok-bot", cap: "agent", text: "冒充" },
    });
    assert.equal(forgedFrom.status, 403);
    assert.match(forgedFrom.data.error, /不能以 mac-mini-hub 身份调用/);

    const leaderList = await apiJson(baseUrl, "/api/v1/tasks", { token: leaderToken });
    assert.equal(leaderList.status, 200);
    assert.equal(leaderList.data.tasks.some((t) => t.task_id === leaderTask.data.task_id), true);
    assert.equal(leaderList.data.tasks.some((t) => t.task_id === hubTask.data.task_id), false);
    const ownerList = await apiJson(baseUrl, "/api/v1/tasks", { token: apiToken });
    assert.equal(ownerList.data.tasks.some((t) => t.task_id === hubTask.data.task_id), true);

    const seeOwn = await apiJson(baseUrl, `/api/v1/tasks/${leaderTask.data.task_id}`, { token: leaderToken });
    assert.equal(seeOwn.status, 200);
    const seeHub = await apiJson(baseUrl, `/api/v1/tasks/${hubTask.data.task_id}`, { token: leaderToken });
    assert.equal(seeHub.status, 403);
    const workerSee = await apiJson(baseUrl, `/api/v1/tasks/${hubTask.data.task_id}`, { token: workerToken });
    assert.equal(workerSee.status, 403);

    const claimLie = await apiJson(baseUrl, `/api/v1/tasks/${hubTask.data.task_id}/claim`, {
      method: "POST",
      token: workerToken,
      body: { node: "muse" },
    });
    assert.equal(claimLie.status, 403);
    assert.match(claimLie.data.error, /不能以 muse 身份调用/);
    const claim = await apiJson(baseUrl, `/api/v1/tasks/${hubTask.data.task_id}/claim`, {
      method: "POST",
      token: workerToken,
      body: {},
    });
    assert.equal(claim.status, 200);
    assert.equal(claim.data.task_id, hubTask.data.task_id);

    const cancelHub = await apiJson(baseUrl, `/api/v1/tasks/${hubTask.data.task_id}/cancel`, {
      method: "POST",
      token: leaderToken,
      body: {},
    });
    assert.equal(cancelHub.status, 403);
    assert.match(cancelHub.data.error, /只能撤销本节点发起的任务/);
    const cancelOwn = await apiJson(baseUrl, `/api/v1/tasks/${leaderTask.data.task_id}/cancel`, {
      method: "POST",
      token: leaderToken,
      body: { text: "不需要了" },
    });
    assert.equal(cancelOwn.status, 200);

    const noAdmin = await apiJson(baseUrl, "/api/v1/admin/cards/CAP-grok-bot-agent/admission", {
      method: "POST",
      token: leaderToken,
      body: { admission: "rejected" },
    });
    assert.equal(noAdmin.status, 403);
    const workerAdmin = await apiJson(baseUrl, "/api/v1/admin/tokens/grok-bot/rotate", {
      method: "POST",
      token: apiToken,
      body: { scopes: ["admin"] },
    });
    assert.equal(workerAdmin.status, 200);
    assert.equal((await apiJson(baseUrl, "/api/v1/skills", { token: workerToken })).status, 401);
    const workerStill = await apiJson(baseUrl, "/api/v1/admin/cards/CAP-grok-bot-agent/admission", {
      method: "POST",
      token: workerAdmin.data.token,
      body: { admission: "rejected" },
    });
    assert.equal(workerStill.status, 403);

    const leaderAdmin = await apiJson(baseUrl, "/api/v1/admin/tokens/muse/rotate", {
      method: "POST",
      token: apiToken,
      body: { scopes: ["admin"] },
    });
    assert.equal(leaderAdmin.status, 200);
    assert.equal(leaderAdmin.data.onboarding.prompt.includes(leaderAdmin.data.token), true);
    assert.equal((await apiJson(baseUrl, "/api/v1/agents/muse/updates?timeout=0", { token: leaderToken })).status, 401);
    const admit = await apiJson(baseUrl, "/api/v1/admin/cards/CAP-grok-bot-agent/admission", {
      method: "POST",
      token: leaderAdmin.data.token,
      body: { admission: "admitted" },
    });
    assert.equal(admit.status, 200);
    assert.equal(admit.data.card.admission, "admitted");
    const profile = await apiJson(baseUrl, "/api/v1/admin/cards/CAP-grok-bot-agent/profile", {
      method: "POST",
      token: leaderAdmin.data.token,
      body: { display_name: "改名" },
    });
    assert.equal(profile.status, 200);
    assert.equal(profile.data.card.display_name, "改名");
    const ob = await apiJson(
      baseUrl,
      "/api/v1/admin/onboarding?access=http&role=leader",
      { token: leaderAdmin.data.token },
    );
    assert.equal(ob.status, 200);
    assert.match(ob.data.onboarding.prompt, /<AH_API_TOKEN>/);
    assert.equal(ob.data.onboarding.prompt.includes(leaderAdmin.data.token), false);
    const obOther = await apiJson(
      baseUrl,
      "/api/v1/admin/onboarding?node=grok-bot&access=http&role=worker",
      { token: leaderAdmin.data.token },
    );
    assert.equal(obOther.status, 200);
    assert.match(obOther.data.onboarding.prompt, /grok-bot/);
    assert.equal((await apiJson(baseUrl, "/api/v1/admin/tokens", { token: leaderAdmin.data.token })).status, 403);
    assert.equal((await apiJson(baseUrl, "/api/v1/state", { token: leaderAdmin.data.token })).status, 403);

    const ownerProfile = await apiJson(baseUrl, "/api/v1/admin/cards/CAP-grok-bot-agent/profile", {
      method: "PATCH",
      token: apiToken,
      body: { display_name: "机主改回" },
    });
    assert.equal(ownerProfile.status, 200);

    const removed = await apiJson(baseUrl, "/api/v1/admin/tokens/muse", {
      method: "DELETE",
      token: apiToken,
    });
    assert.deepEqual(removed.data, { ok: true });
    assert.equal((await apiJson(baseUrl, "/api/v1/skills", { token: leaderAdmin.data.token })).status, 401);
    assert.equal((await apiJson(baseUrl, "/api/v1/admin/tokens/muse", { method: "DELETE", token: apiToken })).status, 404);

    const fresh = await apiJson(baseUrl, "/api/v1/admin/tokens/new-leader/rotate", {
      method: "POST",
      token: apiToken,
      body: { role: "leader" },
    });
    assert.equal(fresh.status, 200);
    assert.match(fresh.data.token, /^aht_/);
    assert.equal((await apiJson(baseUrl, "/api/v1/agents/new-leader/updates?timeout=0", { token: fresh.data.token })).status, 200);

    const used = (await apiJson(baseUrl, "/api/v1/admin/tokens", { token: apiToken }))
      .data.tokens.find((t) => t.node === "new-leader");
    assert.equal(typeof used.last_used_at, "string");

    // 吊销已有 leader 节点的 Token 后再调用 /rotate 且不传 role：应从已有名片推导 leader 并保留 longpoll 接入提示。
    const addedLp = await apiJson(baseUrl, "/api/v1/admin/agents", {
      method: "POST",
      token: apiToken,
      body: { node: "muse-lp", access: "http", role: "leader", receive: "longpoll" },
    });
    assert.equal(addedLp.status, 200);
    assert.equal((await apiJson(baseUrl, "/api/v1/admin/tokens/muse-lp", { method: "DELETE", token: apiToken })).status, 200);
    const reissued = await apiJson(baseUrl, "/api/v1/admin/tokens/muse-lp/rotate", {
      method: "POST",
      token: apiToken,
      body: {},
    });
    assert.equal(reissued.status, 200);
    assert.match(reissued.data.token, /^aht_/);
    assert.match(reissued.data.onboarding.prompt, /poll\?timeout=25/);
    assert.match(reissued.data.onboarding.prompt, /"receive_mode":"http-longpoll"/);
    assert.equal((await apiJson(baseUrl, "/api/v1/agents/muse-lp/updates?timeout=0", { token: reissued.data.token })).status, 200);
  });
});

test("未配置机主 Token 时拒绝签发 Agent Token，避免机主被挡在管理接口之外", async () => {
  await withHub(async ({ baseUrl }) => {
    assert.equal((await apiJson(baseUrl, "/api/v1/state")).status, 200);
    const added = await apiJson(baseUrl, "/api/v1/admin/agents", {
      method: "POST",
      body: { node: "solo", access: "http", role: "worker" },
    });
    assert.equal(added.status, 400);
    assert.match(added.data.error, /apiToken/);
    const rotated = await apiJson(baseUrl, "/api/v1/admin/tokens/solo/rotate", { method: "POST", body: {} });
    assert.equal(rotated.status, 400);
    assert.equal((await apiJson(baseUrl, "/api/v1/state")).status, 200);
  }, { apiToken: "" });
});
