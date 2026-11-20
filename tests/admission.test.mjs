// 名片接纳（Admission）功能测试：纯函数、派单门禁、管理 API、onboarding、gateway 不越权及 inventory 输出。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES, f1 } from "../src/bus/tables.mjs";
import { capIdOf } from "../src/config.mjs";
import {
  ADMISSION_VALUES,
  admissionOf,
  buildOnboarding,
  ensureLeaderIdentityCards,
  formatAgentCard,
  isAdmitted,
  parseCardMetadata,
  presetHttpCardFields,
  receiveForTemplate,
  validatePollIntervalMin,
} from "../src/hub/admission.mjs";
import { AgentTokenStore } from "../src/hub/agent-tokens.mjs";
import { createTask } from "../src/hub/create.mjs";
import { createLoop } from "../src/hub/loop.mjs";
import { inventory } from "../src/inventory.mjs";
import { BROWSER_USER_AGENT } from "../src/kernel-util.mjs";
import { LocalScheduleService } from "../src/local-schedule.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { LongPollBroker } from "../src/server/longpoll-broker.mjs";
import { TABLES, withTemp } from "./helpers.mjs";
import { MockBus } from "./mocks/mock-bus.mjs";

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

async function withHubServer(fn, cfgExtra = {}) {
  await withTemp(async (rootDir) => {
    const hubDir = path.join(rootDir, "hub");
    fs.mkdirSync(hubDir, { recursive: true });
    const apiToken = "super-secret-hub-token-12345";
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
        ...cfgExtra,
      },
      bus,
      broker,
      log: () => {},
      onWake: () => {},
    });
    try {
      await fn({ baseUrl: httpHandle.localUrl, apiToken, bus, broker, hubDir });
    } finally {
      await httpHandle.close();
      bus.close();
    }
  });
}

test("纯函数：ADMISSION_VALUES、admissionOf、isAdmitted 规范化口径", () => {
  assert.deepEqual(ADMISSION_VALUES, ["admitted", "pending", "rejected"]);
  assert.equal(admissionOf(null), "pending");
  assert.equal(admissionOf({}), "pending");
  assert.equal(admissionOf({ fields: {} }), "pending");
  assert.equal(admissionOf({ fields: { Admission: "" } }), "pending");
  assert.equal(admissionOf({ fields: { Admission: "unknown" } }), "pending");
  assert.equal(admissionOf({ fields: { Admission: ["admitted"] } }), "admitted");
  assert.equal(admissionOf({ fields: { Admission: "rejected" } }), "rejected");
  assert.equal(isAdmitted({ fields: { Admission: "admitted" } }), true);
  assert.equal(isAdmitted({ fields: { Admission: "pending" } }), false);
  assert.equal(isAdmitted({ fields: { Admission: "rejected" } }), false);
});

test("纯函数：buildOnboarding 协议 Skill 映射、真实 join 参数与 Token 脱敏", () => {
  const realToken = "real-secret-never-appear";
  const cases = [
    { access: "http", role: "worker", expectedSkills: ["a2a-worker"] },
    { access: "http", role: "leader", expectedSkills: ["a2a-worker", "a2a-leader"] },
    { access: "http", role: "hybrid", expectedSkills: ["a2a-worker", "a2a-leader"] },
    { access: "inbox", role: "worker", expectedSkills: ["ah-inbox"] },
    { access: "host", role: "worker", expectedSkills: [] },
  ];
  for (const c of cases) {
    const ob = buildOnboarding({
      hubUrl: "http://hub.local:8787/",
      node: "agent-1",
      access: c.access,
      role: c.role,
      authRequired: true,
    });
    assert.equal(ob.access, c.access);
    assert.equal(ob.role, c.role);
    assert.deepEqual(
      ob.skills,
      c.expectedSkills.map((name) => ({ name, url: `http://hub.local:8787/api/v1/skills/${name}` })),
    );
    assert.ok(ob.steps.length >= 2);
    assert.match(ob.prompt, /http:\/\/hub\.local:8787/);
    assert.match(ob.prompt, /agent-1/);
    assert.match(ob.prompt, /<AH_API_TOKEN>/);
    assert.equal(JSON.stringify(ob).includes(realToken), false);
    if (c.access === "host") {
      assert.ok(ob.steps.some((s) => s.includes("ah join http://hub.local:8787 --node agent-1 --api-token <AH_API_TOKEN>")));
    }
    if (c.access === "inbox") {
      assert.ok(ob.steps.some((s) => s.includes("--kind agent")));
    }
  }

  const noAuth = buildOnboarding({
    hubUrl: "http://127.0.0.1:8787",
    node: "open-node",
    access: "host",
    role: "worker",
    authRequired: false,
  });
  assert.match(noAuth.prompt, /无需 Token/);
  assert.equal(noAuth.prompt.includes("<AH_API_TOKEN>"), false);

  // 云端 HTTP Agent 的提示词自包含：不要求下载脚本，也不要求伪装浏览器 UA（1010 由边缘放行解决）。
  for (const role of ["worker", "leader", "hybrid"]) {
    for (const authRequired of [true, false]) {
      const ob = buildOnboarding({ hubUrl: "https://hub.example", node: "n1", access: "http", role, authRequired });
      assert.equal(ob.prompt.includes(BROWSER_USER_AGENT), false);
      assert.equal(ob.prompt.includes("a2a_check.py"), false);
      assert.match(ob.prompt, /\/api\/v1\/agents\/n1\/check/);
      assert.match(ob.prompt, /每 5 分钟/);
      assert.equal(ob.template, "generic");
    }
  }
});

test("http 通用模板提示词自包含，host/inbox 仍是原来的句子", () => {
  const secret = "aht_plain_once";
  const httpWorker = buildOnboarding({
    hubUrl: "https://hub.example",
    node: "grok-bot",
    access: "http",
    role: "worker",
    authRequired: true,
    token: secret,
  });
  assert.match(httpWorker.prompt, /\/api\/v1\/agents\/grok-bot\/check/);
  assert.match(httpWorker.prompt, /poll\?timeout=0/);
  assert.match(httpWorker.prompt, /每 5 分钟/);
  assert.match(httpWorker.prompt, /专用令牌/);
  assert.match(httpWorker.prompt, /"receive_mode":"http-poll"/);
  assert.match(httpWorker.prompt, /不需要下载或运行任何脚本/);
  assert.equal(httpWorker.prompt.includes("a2a_check.py"), false);
  assert.equal(httpWorker.prompt.includes(BROWSER_USER_AGENT), false);
  // 明文 Token 只在请求头说明里出现一次。
  assert.equal(httpWorker.prompt.split(secret).length - 1, 1);
  assert.match(httpWorker.steps.join("\n"), /每 5 分钟/);

  const leader = buildOnboarding({
    hubUrl: "https://hub.example",
    node: "muse",
    access: "http",
    role: "leader",
    authRequired: true,
    token: secret,
  });
  assert.match(leader.prompt, /每 5 分钟/);
  assert.match(leader.prompt, /poll\?timeout=0/);
  assert.match(leader.prompt, /updates\?new=1/);
  assert.match(leader.prompt, /idempotencyKey/);
  assert.match(leader.prompt, /绝不以任何方式代批/);
  assert.match(leader.prompt, /from 必须是 "muse"/);
  assert.equal(leader.prompt.includes("hybrid"), false);
  assert.equal(leader.prompt.split(secret).length - 1, 1);

  const hybrid = buildOnboarding({
    hubUrl: "https://hub.example",
    node: "both",
    access: "http",
    role: "hybrid",
    authRequired: true,
  });
  assert.match(hybrid.prompt, /每 5 分钟/);
  assert.match(hybrid.prompt, /<AH_API_TOKEN>/);
  assert.match(hybrid.prompt, /【每次运行】/);
  assert.match(hybrid.prompt, /【跟单与派单】/);
  assert.match(hybrid.prompt, /"role":"leader"/);
  assert.equal(hybrid.prompt.includes("hybrid"), false);

  const host = buildOnboarding({
    hubUrl: "http://hub.local:8787",
    node: "agent-1",
    access: "host",
    role: "worker",
    authRequired: true,
  });
  assert.equal(host.prompt.includes("a2a_check.py"), false);
  assert.equal(host.prompt.includes("A2A_HUB_TOKEN"), false);
  assert.match(host.prompt, /<AH_API_TOKEN>/);
  assert.ok(host.steps.some((s) => s.includes("ah join http://hub.local:8787 --node agent-1 --api-token <AH_API_TOKEN>")));

  const inbox = buildOnboarding({
    hubUrl: "http://hub.local:8787",
    node: "agent-1",
    access: "inbox",
    role: "worker",
    authRequired: true,
  });
  assert.equal(inbox.prompt.includes("a2a_check.py"), false);
  assert.equal(inbox.prompt.includes("A2A_HUB_TOKEN"), false);
  assert.match(inbox.prompt, /ah-inbox/);
  assert.ok(inbox.steps.some((s) => s.includes("--kind agent")));
});

test("接入提示词按接收方式区分，host/inbox 说明常驻长连接和在哪里接纳", () => {
  const secret = "aht_plain_once";
  const webhookSecret = "whsec_once_only";
  const poll = buildOnboarding({
    hubUrl: "https://hub.example",
    node: "grok-bot",
    access: "http",
    role: "worker",
    authRequired: true,
    token: secret,
    receive: "poll",
  });
  assert.match(poll.prompt, /"receive_mode":"http-poll"/);
  assert.match(poll.prompt, /每 5 分钟/);
  assert.equal(poll.prompt.includes("http-longpoll"), false);
  assert.equal(poll.prompt.includes("A2A_HUB_WEBHOOK_SECRET"), false);
  assert.equal(poll.steps.join("\n").includes("名片墙"), false);

  const longpoll = buildOnboarding({
    hubUrl: "https://hub.example",
    node: "grok-bot",
    access: "http",
    role: "worker",
    authRequired: true,
    token: secret,
    receive: "longpoll",
  });
  assert.match(longpoll.prompt, /"receive_mode":"http-longpoll"/);
  assert.match(longpoll.prompt, /poll\?timeout=25/);
  assert.match(longpoll.prompt, /1 秒、3 秒、8 秒、30 秒/);
  assert.match(longpoll.prompt, /不需要下载或运行任何脚本/);
  assert.match(longpoll.prompt, /heartbeat/);
  assert.equal(longpoll.prompt.includes("每 5 分钟"), false);
  assert.equal(longpoll.prompt.includes('"receive_mode":"http-poll"'), false);
  assert.equal(longpoll.prompt.split(secret).length - 1, 1);

  const leaderLoop = buildOnboarding({
    hubUrl: "https://hub.example",
    node: "muse",
    access: "http",
    role: "leader",
    authRequired: true,
    receive: "longpoll",
  });
  assert.match(leaderLoop.prompt, /updates\?new=1/);
  assert.match(leaderLoop.prompt, /poll\?timeout=25/);
  assert.equal(leaderLoop.prompt.includes("不要调用 poll 或 claim"), false);
  assert.match(leaderLoop.prompt, /1 秒、3 秒、8 秒、30 秒/);
  assert.equal(leaderLoop.prompt.includes("a2a_check.py --hub"), false);

  const hybridLoop = buildOnboarding({
    hubUrl: "https://hub.example",
    node: "both",
    access: "http",
    role: "hybrid",
    receive: "longpoll",
  });
  assert.match(hybridLoop.prompt, /poll\?timeout=25/);
  assert.match(hybridLoop.prompt, /updates\?new=1/);

  const webhook = buildOnboarding({
    hubUrl: "https://hub.example",
    node: "grok-bot",
    access: "http",
    role: "hybrid",
    authRequired: true,
    token: secret,
    receive: "webhook",
    webhookSecret,
  });
  assert.match(webhook.prompt, /"receive_mode":"webhook"/);
  assert.match(webhook.prompt, /HMAC-SHA256/);
  assert.match(webhook.prompt, /300 秒/);
  assert.match(webhook.prompt, /Webhook 密钥只配在接收端/);
  assert.match(webhook.prompt, /timestamp/);
  assert.match(webhook.prompt, /raw body/);
  assert.match(webhook.prompt, /poll\?timeout=0/);
  assert.match(webhook.prompt, /updates\?new=1/);
  assert.match(webhook.prompt, /不含指令正文/);
  assert.match(webhook.prompt, /每 30 分钟/);
  assert.equal(webhook.prompt.includes("a2a_check"), false);
  assert.equal(webhook.prompt.includes(webhookSecret), false);
  assert.equal(webhook.prompt.split(secret).length - 1, 1);
  assert.equal(webhook.steps.join("\n").includes(webhookSecret), false);

  const webhookNoSecret = buildOnboarding({
    hubUrl: "https://hub.example",
    node: "grok-bot",
    access: "http",
    role: "worker",
    receive: "webhook",
  });
  assert.match(webhookNoSecret.prompt, /Webhook 密钥只配在接收端/);
  assert.equal(webhookNoSecret.prompt.includes("向机主索取"), false);
  assert.equal(webhookNoSecret.prompt.includes("这一次的明文 Webhook 密钥"), false);
  assert.match(webhookNoSecret.prompt, /忽略 event=task\.updated/);

  const host = buildOnboarding({
    hubUrl: "http://hub.local:8787",
    node: "box",
    access: "host",
    role: "worker",
    authRequired: true,
    receive: "webhook",
    webhookSecret,
  });
  assert.match(host.prompt, /常驻长连接/);
  assert.match(host.prompt, /ah daemon/);
  assert.match(host.prompt, /出站长轮询/);
  assert.match(host.prompt, /节点 → 待接纳/);
  assert.equal(host.prompt.includes("名片墙"), false);
  assert.equal(host.prompt.includes(webhookSecret), false);
  assert.equal(host.steps.join("\n").includes("名片墙"), false);
  assert.ok(host.steps.some((s) => s.includes("节点 → 待接纳")));

  const inbox = buildOnboarding({
    hubUrl: "http://hub.local:8787",
    node: "box",
    access: "inbox",
    role: "worker",
    authRequired: true,
  });
  assert.match(inbox.prompt, /常驻长连接/);
  assert.match(inbox.prompt, /ah daemon/);
  assert.match(inbox.prompt, /出站长轮询/);
  assert.match(inbox.prompt, /节点 → 待接纳/);
  assert.match(inbox.prompt, /ah inbox/);
  assert.equal(inbox.prompt.includes("名片墙"), false);
});

test("模板：muse 与 grok-bot 各自约束接收方式，提示词精简且自包含", () => {
  const secret = "aht_tpl_once";
  const muse = buildOnboarding({
    hubUrl: "https://hub.example",
    node: "muse-1",
    access: "http",
    role: "leader",
    authRequired: true,
    token: secret,
    receive: "poll",
    template: "muse",
  });
  assert.equal(muse.template, "muse");
  assert.match(muse.prompt, /ah join https:\/\/hub\.example --agent --agent-role leader --node muse-1/);
  assert.match(muse.prompt, /--token-file ~\/\.a2a-hub-muse-1\/agent\.token/);
  assert.match(muse.prompt, /ah service --ensure --config/);
  assert.match(muse.prompt, /runtime hook/);
  assert.match(muse.prompt, /ah inbox --config ~\/\.a2a-hub-muse-1 --pop --json/);
  assert.match(muse.prompt, /ah present --config/);
  assert.match(muse.prompt, /install\.sh/);
  // 接收方式被模板约束为长轮询（daemon 常驻），Token 只在 0600 写入行出现一次。
  assert.equal(muse.prompt.includes("http-poll"), false);
  assert.equal(muse.prompt.split(secret).length - 1, 1);
  assert.equal(muse.prompt.includes(BROWSER_USER_AGENT), false);

  const grok = buildOnboarding({
    hubUrl: "https://hub.example",
    node: "grok-1",
    access: "http",
    role: "worker",
    authRequired: true,
    token: secret,
    receive: "poll",
    template: "grok-bot",
  });
  assert.equal(grok.template, "grok-bot");
  assert.match(grok.prompt, /"receive_mode":"webhook"/);
  assert.match(grok.prompt, /POST to 和 key/);
  assert.match(grok.prompt, /A2A_HUB_TOKEN/);
  assert.match(grok.prompt, /event 为 ping 或 task_id 为空就结束/);
  assert.match(grok.prompt, /poll\?timeout=0/);
  assert.match(grok.prompt, /每 30 分钟/);
  // Grok Bot 看不到原始请求体与签名头：不含验签、不含脚本下载。
  assert.equal(grok.prompt.includes("HMAC"), false);
  assert.equal(grok.prompt.includes("a2a_check"), false);
  assert.equal(grok.prompt.split(secret).length - 1, 1);

  assert.throws(
    () => buildOnboarding({ hubUrl: "https://hub.example", node: "n1", access: "http", role: "worker", template: "nope" }),
    /template 只能是 generic \/ muse \/ grok-bot/,
  );
});

test("模板：presetHttpCardFields 把模板写进 Metadata，parseCardMetadata 读回，rotate 可按名片推导", () => {
  const fields = presetHttpCardFields({ node: "muse-1", role: "leader", receiveMode: "http-longpoll", template: "muse" });
  const meta = parseCardMetadata(fields);
  assert.equal(meta.template, "muse");
  assert.equal(meta.role, "leader");
  // generic 是默认值，不落盘，保持历史名片形状不变。
  const plain = presetHttpCardFields({ node: "n1", role: "worker", receiveMode: "http-poll" });
  assert.equal(parseCardMetadata(plain).template, "");
  assert.equal(JSON.parse(plain.Metadata).template, undefined);
  assert.equal(receiveForTemplate("muse", "poll"), "longpoll");
  assert.equal(receiveForTemplate("grok-bot", "poll"), "webhook");
  assert.equal(receiveForTemplate("generic", "webhook"), "webhook");
});

test("派单门：未接纳（pending/缺省）与 rejected 拒单且不写表，接纳后可派", async () => {
  const tables = { ...TABLES, loops: "tbl_loops" };
  const mock = new MockBus({ tables });
  const rec = await mock.createRecord(tables.agentCards, {
    Cap_ID: "CAP-node-a-echo",
    Node: "node-a",
    Skill_ID: "echo",
    Dispatchable: "Yes",
    Availability: "online",
  });
  mock.journal.length = 0;

  // 1. 缺省（pending）拒单（含 createTask 与 createLoop）
  await assert.rejects(
    () => createTask({ bus: mock, to: "node-a", cap: "echo", text: "hi" }),
    /未接纳（Admission=pending），请在 Web 控制台「节点 → 待接纳」中接纳/,
  );
  await assert.rejects(
    () => createTask({ bus: mock, cap: "CAP-node-a-echo", text: "hi" }),
    /未接纳（Admission=pending）/,
  );
  await assert.rejects(
    () => createTask({ bus: mock, to: "node-a", text: "hi" }),
    /未接纳（Admission=pending）/,
  );
  const loopStages = [{ id: "step", name: "测试", to: "node-a", cap: "echo", prompt: "{{goal}}" }];
  await assert.rejects(
    () => createLoop({ bus: mock, title: "t", goal: "g", stages: loopStages }),
    /未接纳（Admission=pending）/,
  );
  assert.equal(mock.journal.filter((j) => j.op === "create").length, 0);

  // 2. rejected 拒单
  await mock.updateRecord(tables.agentCards, rec.record.record_id, { Admission: "rejected" });
  mock.journal.length = 0;
  await assert.rejects(
    () => createTask({ bus: mock, to: "node-a", cap: "echo", text: "hi" }),
    /未接纳（Admission=rejected）/,
  );
  assert.equal(mock.journal.filter((j) => j.op === "create").length, 0);

  // 3. 接纳后可派（含 createTask 与 createLoop）
  await mock.updateRecord(tables.agentCards, rec.record.record_id, { Admission: "admitted" });
  const taskId = await createTask({ bus: mock, to: "node-a", cap: "echo", text: "hi" });
  assert.ok(taskId.startsWith("TASK-"));
  const loopRes = await createLoop({
    bus: mock,
    title: "测试",
    goal: "测试闭环",
    stages: loopStages,
  });
  assert.ok(loopRes.loopId.startsWith("LOOP-"));
});

test("派单门：指定 --worker 时未接纳同样拒单，且 local-schedule 受门禁约束", async () => {
  await withTemp(async (dir) => {
    const mock = new MockBus({ tables: TABLES });
    const rec = await mock.createRecord(TABLES.agentCards, {
      Cap_ID: "CAP-a-beta-agent",
      Node: "node-a",
      Worker: "beta",
      Skill_ID: "agent",
      Dispatchable: "Yes",
      Availability: "online",
    });
    await assert.rejects(
      () => createTask({ bus: mock, to: "node-a", worker: "beta", text: "x" }),
      /未接纳（Admission=pending）/,
    );
    await mock.updateRecord(TABLES.agentCards, rec.record.record_id, { Admission: "admitted" });
    const okId = await createTask({ bus: mock, to: "node-a", worker: "beta", text: "x" });
    assert.ok(okId);

    // local-schedule 路径同样走 createTask 门禁
    const schedCard = await mock.createRecord(TABLES.agentCards, {
      Cap_ID: "CAP-sched",
      Node: "node-a",
      Skill_ID: "sched",
      Dispatchable: "Yes",
      Availability: "online",
    });
    fs.writeFileSync(path.join(dir, "schedules.json"), JSON.stringify({
      schedules: [{ id: "S1", enabled: true, cron: "0 9 * * *", cap: "CAP-sched", text: "定时" }],
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "schedule_local_state.json"), JSON.stringify({
      schedules: { S1: { cron: "0 9 * * *", last_fired: "2026-01-15T09:00:00+0800" } },
    }), { mode: 0o600 });
    const logs = [];
    const svc = new LocalScheduleService({
      bus: mock,
      node: "node-a",
      tz: "Asia/Shanghai",
      schedulesPath: path.join(dir, "schedules.json"),
      statePath: path.join(dir, "schedule_local_state.json"),
      now: () => Date.parse("2026-01-16T01:30:00.000Z"),
      log: (line) => logs.push(String(line)),
      createTask,
      commandsOf: () => new Set(["CAP-sched"]),
      notify: () => {},
    });
    await svc.tick();
    assert.equal(logs.some((l) => l.includes("未接纳（Admission=pending）")), true);

    await mock.updateRecord(TABLES.agentCards, schedCard.record.record_id, { Admission: "admitted" });
    await svc.tick();
    const tasks = await mock.listRecords(TABLES.tasks);
    assert.equal(tasks.some((t) => f1(t, "Skill_ID") === "sched"), true);
  });
});

test("HTTP 管理端点：register 不覆盖 Admission、预建槽位命中同一 Cap_ID、409、onboarding 脱敏与 400/404", async () => {
  await withHubServer(async ({ baseUrl, apiToken, bus }) => {
    // 未鉴权访问管理端点返回 401
    const unauth = await apiJson(baseUrl, "/api/v1/admin/onboarding?node=n1&access=http&role=worker");
    assert.equal(unauth.status, 401);

    // 1. 外部 Agent register 夹带 Admission/Display_Name/Admin_Note，新卡仍为 pending
    const regBad = await apiJson(baseUrl, "/api/v1/agents/register", {
      method: "POST",
      token: apiToken,
      body: {
        node: "rogue-bot",
        role: "worker",
        Admission: "admitted",
        Display_Name: "篡改名称",
        Admin_Note: "篡改备注",
        caps: [{
          skill_id: "echo",
          Admission: "admitted",
          Display_Name: "篡改技能名",
        }],
      },
    });
    assert.equal(regBad.status, 200);
    assert.equal(regBad.data.pending, true);
    assert.deepEqual(regBad.data.admission, { "CAP-rogue-bot-echo": "pending" });

    // 未接纳拒绝通过 POST /api/v1/tasks 派单
    const blockedCreate = await apiJson(baseUrl, "/api/v1/tasks", {
      method: "POST",
      token: apiToken,
      body: { to: "rogue-bot", cap: "echo", text: "hello" },
    });
    assert.equal(blockedCreate.status, 400);
    assert.match(blockedCreate.data.error, /未接纳（Admission=pending）/);

    // 检查 /api/v1/state 与 /api/v1/agents 字段
    const st1 = await apiJson(baseUrl, "/api/v1/state", { token: apiToken });
    assert.equal(st1.status, 200);
    const rogueStateCard = st1.data.agentCards.find((c) => c.cap_id === "CAP-rogue-bot-echo");
    assert.equal(rogueStateCard.admission, "pending");
    assert.equal(rogueStateCard.display_name, "");
    assert.equal(rogueStateCard.admin_note, "");
    assert.equal(rogueStateCard.kind, "agent");
    assert.equal(rogueStateCard.role, "worker");

    const agents1 = await apiJson(baseUrl, "/api/v1/agents", { token: apiToken });
    const rogueAgent = agents1.data.agents.find((a) => a.node === "rogue-bot");
    assert.equal(rogueAgent.caps[0].admission, "pending");

    // 2. PATCH profile + POST cards/:capId/admission 接纳 -> 再 register 不覆盖三字段
    const profRes = await apiJson(baseUrl, "/api/v1/admin/cards/CAP-rogue-bot-echo/profile", {
      method: "PATCH",
      token: apiToken,
      body: { display_name: "  小罗宾  ", admin_note: "  测试备注  " },
    });
    assert.equal(profRes.status, 200);
    assert.equal(profRes.data.card.display_name, "小罗宾");
    assert.equal(profRes.data.card.admin_note, "测试备注");

    // 只改传入的键（只传 admin_note 时保留 display_name）
    const profPartial = await apiJson(baseUrl, "/api/v1/admin/cards/CAP-rogue-bot-echo/profile", {
      method: "PATCH",
      token: apiToken,
      body: { admin_note: "更新备注" },
    });
    assert.equal(profPartial.status, 200);
    assert.equal(profPartial.data.card.display_name, "小罗宾");
    assert.equal(profPartial.data.card.admin_note, "更新备注");

    const admitRes = await apiJson(baseUrl, "/api/v1/admin/cards/CAP-rogue-bot-echo/admission", {
      method: "POST",
      token: apiToken,
      body: { admission: "admitted" },
    });
    assert.equal(admitRes.status, 200);
    assert.equal(admitRes.data.card.admission, "admitted");

    // 再次 register：不得覆盖 Admission / Display_Name / Admin_Note
    const regAgain = await apiJson(baseUrl, "/api/v1/agents/register", {
      method: "POST",
      token: apiToken,
      body: {
        node: "rogue-bot",
        role: "worker",
        Admission: "rejected",
        Display_Name: "覆盖失败",
        caps: [{ skill_id: "echo" }],
      },
    });
    assert.equal(regAgain.status, 200);
    assert.equal(regAgain.data.pending, false);
    assert.deepEqual(regAgain.data.admission, { "CAP-rogue-bot-echo": "admitted" });

    const st2 = await apiJson(baseUrl, "/api/v1/state", { token: apiToken });
    const afterCard = st2.data.agentCards.find((c) => c.cap_id === "CAP-rogue-bot-echo");
    assert.equal(afterCard.admission, "admitted");
    assert.equal(afterCard.display_name, "小罗宾");
    assert.equal(afterCard.admin_note, "更新备注");

    // 接纳后可派单
    const okCreate = await apiJson(baseUrl, "/api/v1/tasks", {
      method: "POST",
      token: apiToken,
      body: { to: "rogue-bot", cap: "echo", text: "ok now" },
    });
    assert.equal(okCreate.status, 201);

    // 3. 预建槽位（POST /api/v1/admin/agents）与之后 register 命中同一 Cap_ID + 409 重复
    const addHttp = await apiJson(baseUrl, "/api/v1/admin/agents", {
      method: "POST",
      token: apiToken,
      body: {
        node: "muse-worker",
        access: "http",
        role: "hybrid",
        display_name: "云端缪斯",
        admin_note: "预建槽位",
        description: "负责协同和执行",
      },
    });
    assert.equal(addHttp.status, 200);
    assert.equal(addHttp.data.node, "muse-worker");
    assert.equal(addHttp.data.card.cap_id, capIdOf("agent", {}, "muse-worker"));
    assert.equal(addHttp.data.card.admission, "admitted");
    assert.equal(addHttp.data.card.availability, "offline");
    assert.equal(addHttp.data.card.display_name, "云端缪斯");
    assert.equal(addHttp.data.card.admin_note, "预建槽位");
    assert.equal(addHttp.data.card.role, "leader");
    assert.equal(addHttp.data.card.dispatchable, "Yes");
    assert.deepEqual(addHttp.data.onboarding.skills.map((s) => s.name), ["a2a-worker", "a2a-leader"]);
    // onboarding 绝不含真实 token，且 host 来自请求 Host 头
    assert.equal(JSON.stringify(addHttp.data.onboarding).includes(apiToken), false);
    const expectedHost = new URL(baseUrl).host;
    assert.ok(addHttp.data.onboarding.skills[0].url.startsWith(`http://${expectedHost}/api/v1/skills/`));

    // 同 Cap_ID 重复预建返回 409
    const dupHttp = await apiJson(baseUrl, "/api/v1/admin/agents", {
      method: "POST",
      token: apiToken,
      body: { node: "muse-worker", access: "http", role: "worker" },
    });
    assert.equal(dupHttp.status, 409);

    // 之后该 HTTP Agent 调用 /agents/register（不传 caps）命中同一行、保留 Admission=admitted
    const regPreset = await apiJson(baseUrl, "/api/v1/agents/register", {
      method: "POST",
      token: apiToken,
      body: { node: "muse-worker", role: "hybrid" },
    });
    assert.equal(regPreset.status, 200);
    assert.equal(regPreset.data.pending, false);
    assert.deepEqual(regPreset.data.admission, { [capIdOf("agent", {}, "muse-worker")]: "admitted" });
    assert.equal(regPreset.data.cards[0].record_id, addHttp.data.card.record_id);

    const allCards = await bus.listRecords(DEFAULT_TABLES.agentCards);
    assert.equal(allCards.filter((c) => f1(c, "Node") === "muse-worker").length, 1);
    assert.equal(f1(allCards.find((c) => f1(c, "Node") === "muse-worker"), "Availability"), "online");

    const lead = await apiJson(baseUrl, "/api/v1/admin/agents", {
      method: "POST",
      token: apiToken,
      body: { node: "lead-1", access: "http", role: "leader" },
    });
    assert.equal(lead.status, 200);
    assert.equal(lead.data.card.cap_id, capIdOf("agent", {}, "lead-1"));
    assert.equal(lead.data.card.skill_id, "agent");
    assert.equal(lead.data.card.dispatchable, "Yes");
    assert.equal(lead.data.card.admission, "admitted");
    assert.equal(lead.data.card.role, "leader");
    assert.equal(lead.data.onboarding.prompt.includes("hybrid"), false);

    for (const combo of [
      { node: "host-1", access: "host", role: "worker" },
      { node: "inbox-1", access: "inbox", role: "worker" },
    ]) {
      const r = await apiJson(baseUrl, "/api/v1/admin/agents", {
        method: "POST",
        token: apiToken,
        body: combo,
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.card, null);
      assert.equal(JSON.stringify(r.data.onboarding).includes(apiToken), false);
    }

    // 4. GET /api/v1/admin/onboarding 只读不写表
    const beforeCount = (await bus.listRecords(DEFAULT_TABLES.agentCards)).length;
    const obGet = await apiJson(
      baseUrl,
      "/api/v1/admin/onboarding?node=fresh-node&access=host&role=worker",
      { token: apiToken },
    );
    assert.equal(obGet.status, 200);
    assert.deepEqual(obGet.data.onboarding.skills, []);
    assert.equal(JSON.stringify(obGet.data.onboarding).includes(apiToken), false);
    assert.equal((await bus.listRecords(DEFAULT_TABLES.agentCards)).length, beforeCount);

    // 5. capId 需要 decodeURIComponent + Metadata 坏 JSON 容错
    await bus.createRecord(DEFAULT_TABLES.agentCards, {
      Cap_ID: "CAP/special:1",
      Node: "special-node",
      Skill_ID: "echo",
      Dispatchable: "Yes",
      Metadata: "{bad-json",
    });
    const stBadMeta = await apiJson(baseUrl, "/api/v1/state", { token: apiToken });
    const badMetaCard = stBadMeta.data.agentCards.find((c) => c.cap_id === "CAP/special:1");
    assert.equal(badMetaCard.kind, "");
    assert.equal(badMetaCard.role, "");
    assert.equal(badMetaCard.admission, "pending");

    const encAdmit = await apiJson(baseUrl, `/api/v1/admin/cards/${encodeURIComponent("CAP/special:1")}/admission`, {
      method: "POST",
      token: apiToken,
      body: { admission: "admitted" },
    });
    assert.equal(encAdmit.status, 200);
    assert.equal(encAdmit.data.card.cap_id, "CAP/special:1");
    assert.equal(encAdmit.data.card.admission, "admitted");

    // 6. 各管理端点 400 / 404 检查
    assert.equal((await apiJson(baseUrl, "/api/v1/admin/cards/CAP-missing/admission", {
      method: "POST", token: apiToken, body: { admission: "admitted" },
    })).status, 404);
    assert.equal((await apiJson(baseUrl, "/api/v1/admin/cards/CAP-rogue-bot-echo/admission", {
      method: "POST", token: apiToken, body: { admission: "invalid" },
    })).status, 400);

    assert.equal((await apiJson(baseUrl, "/api/v1/admin/nodes/no-such-node/admission", {
      method: "POST", token: apiToken, body: { admission: "admitted" },
    })).status, 404);
    assert.equal((await apiJson(baseUrl, "/api/v1/admin/nodes/rogue-bot/admission", {
      method: "POST", token: apiToken, body: { admission: "bad" },
    })).status, 400);

    assert.equal((await apiJson(baseUrl, "/api/v1/admin/cards/CAP-missing/profile", {
      method: "PATCH", token: apiToken, body: { display_name: "x" },
    })).status, 404);
    assert.equal((await apiJson(baseUrl, "/api/v1/admin/cards/CAP-rogue-bot-echo/profile", {
      method: "PATCH", token: apiToken, body: { display_name: "a".repeat(65) },
    })).status, 400);
    assert.equal((await apiJson(baseUrl, "/api/v1/admin/cards/CAP-rogue-bot-echo/profile", {
      method: "PATCH", token: apiToken, body: { admin_note: "b".repeat(501) },
    })).status, 400);

    assert.equal((await apiJson(baseUrl, "/api/v1/admin/agents", {
      method: "POST", token: apiToken, body: { node: "*", access: "http", role: "worker" },
    })).status, 400);
    assert.equal((await apiJson(baseUrl, "/api/v1/admin/agents", {
      method: "POST", token: apiToken, body: { node: "ok-node", access: "ssh", role: "worker" },
    })).status, 400);
    assert.equal((await apiJson(baseUrl, "/api/v1/admin/agents", {
      method: "POST", token: apiToken, body: { node: "ok-node", access: "http", role: "boss" },
    })).status, 400);

    assert.equal((await apiJson(baseUrl, "/api/v1/admin/onboarding?node=&access=http&role=worker", {
      token: apiToken,
    })).status, 400);
    assert.equal((await apiJson(baseUrl, "/api/v1/admin/onboarding?node=ok&access=bad&role=worker", {
      token: apiToken,
    })).status, 400);
    assert.equal((await apiJson(baseUrl, "/api/v1/admin/onboarding?node=ok&access=http&role=bad", {
      token: apiToken,
    })).status, 400);
  });
});

test("onboarding：配置了 publicUrl 时提示词用对外地址而不是请求 Host", async () => {
  await withHubServer(async ({ baseUrl, apiToken }) => {
    const res = await apiJson(baseUrl, "/api/v1/admin/onboarding?node=n1&access=http&role=worker", { token: apiToken });
    assert.equal(res.status, 200);
    assert.equal(res.data.onboarding.skills[0].url, "https://hub.example.com/api/v1/skills/a2a-worker");
    assert.equal(res.data.onboarding.prompt.includes("127.0.0.1"), false);
  }, { publicUrl: "https://hub.example.com/" });
});

test("inventory 输出每张名片包含 Admission=<值>", async () => {
  await withTemp(async (dir) => {
    const dbPath = path.join(dir, "hub.db");
    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({
      node: "inv-node",
      role: "node",
      busType: "sqlite",
      dbPath,
      tables: DEFAULT_TABLES,
    }), { mode: 0o600 });
    const bus = new SqliteBus({ dbPath, tables: DEFAULT_TABLES });
    await bus.createRecord(DEFAULT_TABLES.agentCards, {
      Cap_ID: "CAP-inv-1",
      Node: "inv-node",
      Skill_ID: "echo",
      Receive_Mode: "event",
      Availability: "online",
      Dispatchable: "Yes",
    });
    await bus.createRecord(DEFAULT_TABLES.agentCards, {
      Cap_ID: "CAP-inv-2",
      Node: "inv-node",
      Skill_ID: "agent",
      Receive_Mode: "event",
      Availability: "online",
      Dispatchable: "Yes",
      Admission: "admitted",
    });
    bus.close();

    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      await inventory(dir);
    } finally {
      console.log = origLog;
    }
    const output = lines.join("\n");
    assert.match(output, /CAP-inv-1.*Admission=pending/);
    assert.match(output, /CAP-inv-2.*Admission=admitted/);
  });
});

test("启动迁移给没有名片的 leader/hybrid 补可派单身份名片，不覆盖已有 Admission", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "agent_tokens.json"), `${JSON.stringify({
      version: 1,
      tokens: [
        { node: "old-hybrid", role: "hybrid", scopes: [], hash: "h1", prefix: "aht_hybrid", created_at: "2026-01-01T00:00:00.000Z", last_used_at: null },
        { node: "kept", role: "leader", scopes: [], hash: "h2", prefix: "aht_kept01", created_at: "2026-01-01T00:00:00.000Z", last_used_at: null },
        { node: "plain", role: "worker", scopes: [], hash: "h3", prefix: "aht_worker", created_at: "2026-01-01T00:00:00.000Z", last_used_at: null },
      ],
    }, null, 2)}\n`, { mode: 0o600 });
    const broker = new LongPollBroker();
    const bus = new SqliteBus({ dbPath: path.join(dir, "hub.db"), tables: DEFAULT_TABLES, broker });
    await bus.createRecord(DEFAULT_TABLES.agentCards, {
      Cap_ID: capIdOf("agent", {}, "kept"),
      Node: "kept",
      Skill_ID: "agent",
      Dispatchable: "No",
      Admission: "rejected",
      Receive_Mode: "http-poll",
      Metadata: JSON.stringify({ kind: "agent", role: "leader" }),
    });
    const httpHandle = await startHubHttpServer({
      cfg: { node: "hub", configDir: dir, listen: "127.0.0.1:0", apiToken: "owner-token" },
      bus,
      broker,
      log: () => {},
    });
    try {
      const cards = await bus.listRecords(DEFAULT_TABLES.agentCards);
      const hybrid = cards.filter((card) => f1(card, "Node") === "old-hybrid");
      assert.equal(hybrid.length, 1);
      assert.equal(f1(hybrid[0], "Cap_ID"), capIdOf("agent", {}, "old-hybrid"));
      assert.equal(f1(hybrid[0], "Skill_ID"), "agent");
      assert.equal(f1(hybrid[0], "Dispatchable"), "Yes");
      assert.equal(f1(hybrid[0], "Admission"), "admitted");
      assert.equal(JSON.parse(f1(hybrid[0], "Metadata")).role, "leader");
      const kept = cards.find((card) => f1(card, "Node") === "kept");
      assert.equal(f1(kept, "Admission"), "rejected");
      assert.equal(f1(kept, "Dispatchable"), "No");
      assert.equal(cards.some((card) => f1(card, "Node") === "plain"), false);
      const again = await ensureLeaderIdentityCards({ bus, tokenStore: new AgentTokenStore(dir) });
      assert.equal(again, 0);
      assert.equal((await bus.listRecords(DEFAULT_TABLES.agentCards)).filter((card) => f1(card, "Node") === "old-hybrid").length, 1);
    } finally {
      await httpHandle.close();
      bus.close();
    }
  });
});

test("formatAgentCard 透出 manual / preset，供控制台判断能否删除", () => {
  const manual = formatAgentCard({ record_id: "r1", fields: { Cap_ID: "CAP-a-x", Node: "a", Metadata: JSON.stringify({ kind: "agent", manual: true }) } });
  assert.equal(manual.manual, true);
  assert.equal(manual.preset, false);
  assert.equal(manual.poll_interval_min, null);
  const plain = formatAgentCard({ record_id: "r2", fields: { Cap_ID: "CAP-b-x", Node: "b", Metadata: "not-json" } });
  assert.equal(plain.manual, false);
  assert.equal(plain.preset, false);
  assert.equal(plain.poll_interval_min, null);
  const paced = formatAgentCard({ record_id: "r3", fields: { Cap_ID: "CAP-c-x", Node: "c", Metadata: JSON.stringify({ poll_interval_min: 60 }) } });
  assert.equal(paced.poll_interval_min, 60);
  assert.equal(parseCardMetadata(paced).poll_interval_min, null);
  assert.equal(parseCardMetadata({ Metadata: { poll_interval_min: 15 } }).poll_interval_min, 15);
});

test("poll_interval_min 默认值、校验，以及接入提示词按分钟改写", () => {
  assert.equal(validatePollIntervalMin(undefined, "poll"), 5);
  assert.equal(validatePollIntervalMin(null, "webhook"), 30);
  assert.equal(validatePollIntervalMin("", "longpoll"), null);
  assert.equal(validatePollIntervalMin("60", "poll"), 60);
  assert.throws(() => validatePollIntervalMin(0, "poll"), /poll_interval_min 必须是 1 到 1440 之间的整数/);
  assert.throws(() => validatePollIntervalMin(1441, "webhook"), /1 到 1440/);
  assert.throws(() => validatePollIntervalMin(1.5, "poll"), /1 到 1440/);

  const pollCard = presetHttpCardFields({ node: "n", role: "worker", receiveMode: "http-poll" });
  assert.equal(JSON.parse(pollCard.Metadata).poll_interval_min, 5);
  const customCard = presetHttpCardFields({ node: "n", role: "worker", receiveMode: "http-poll", pollIntervalMin: 60 });
  assert.equal(JSON.parse(customCard.Metadata).poll_interval_min, 60);
  const hookCard = presetHttpCardFields({ node: "n", role: "worker", receiveMode: "webhook" });
  assert.equal(JSON.parse(hookCard.Metadata).poll_interval_min, 30);
  const loopCard = presetHttpCardFields({ node: "n", role: "leader", receiveMode: "http-longpoll" });
  assert.equal(JSON.parse(loopCard.Metadata).poll_interval_min, undefined);

  const slow = buildOnboarding({
    hubUrl: "https://hub.example",
    node: "grok-bot",
    access: "http",
    role: "worker",
    receive: "poll",
    pollIntervalMin: 60,
  });
  assert.match(slow.prompt, /每 60 分钟/);
  assert.equal(slow.prompt.includes("每 5 分钟"), false);
  assert.match(slow.steps.join("\n"), /每 60 分钟/);
  assert.match(slow.prompt, /POST https:\/\/hub\.example\/api\/v1\/tasks\/<task_id>\/claim/);
  assert.match(slow.prompt, /不要提前批量认领/);

  const hook = buildOnboarding({
    hubUrl: "https://hub.example",
    node: "grok-bot",
    access: "http",
    role: "worker",
    receive: "webhook",
    pollIntervalMin: 15,
  });
  assert.match(hook.prompt, /每 15 分钟/);
  assert.equal(hook.prompt.includes("每 30 分钟"), false);
  assert.match(hook.steps.join("\n"), /每 15 分钟/);
  assert.match(hook.prompt, /不要提前批量认领/);

  const loop = buildOnboarding({
    hubUrl: "https://hub.example",
    node: "grok-bot",
    access: "http",
    role: "worker",
    receive: "longpoll",
    pollIntervalMin: 60,
  });
  assert.match(loop.prompt, /不要提前批量认领/);
  assert.equal(loop.prompt.includes("每 60 分钟"), false);
});
