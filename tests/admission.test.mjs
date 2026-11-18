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
  isAdmitted,
} from "../src/hub/admission.mjs";
import { createTask } from "../src/hub/create.mjs";
import { createLoop } from "../src/hub/loop.mjs";
import { inventory } from "../src/inventory.mjs";
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
    { access: "http", role: "leader", expectedSkills: ["a2a-leader"] },
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
    /未接纳（Admission=pending），请在 Web 控制台「Agent 名片墙 → 待接纳」中接纳/,
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
    assert.equal(addHttp.data.card.role, "hybrid");
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

    // 其他组合不建卡（http+leader / host / inbox）
    for (const combo of [
      { node: "lead-1", access: "http", role: "leader" },
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
