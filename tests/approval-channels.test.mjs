import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentDaemon } from "../src/client/agent-daemon.mjs";
import { GatewayClient } from "../src/client/gateway-client.mjs";
import { ApprovalLinkService, resolveApprovalSettings } from "../src/core/approval-links.mjs";
import { loadOrCreateHubKey, verifyDecision, verifyTaskApproval } from "../src/core/approval-sign.mjs";
import { FeishuApprovalChannel, resolveFeishuAppConfig } from "../src/core/feishu-approval.mjs";
import { decodeFrame, encodeFrame } from "../src/core/feishu-ws.mjs";
import { startHubRuntime } from "../src/core/hub-runtime.mjs";
import { ExternalNotifier } from "../src/core/notifier.mjs";
import { TaskService } from "../src/core/task-service.mjs";
import { HubStore } from "../src/store/db.mjs";

function makeCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-approval-"));
  const store = new HubStore(path.join(dir, "hub.db"));
  const { privateKey, publicKey } = loadOrCreateHubKey(dir);
  const taskService = new TaskService(store, { approvalPrivateKey: privateKey });
  return {
    dir,
    store,
    taskService,
    privateKey,
    publicKey,
    cleanup() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function lastAuthRequestId(store, taskId) {
  return [...store.listMessages(taskId)].reverse().find((m) => m.kind === "auth_request").data.request_id;
}

test("TaskService: 只认最新审批请求，超时自动拒绝并记录渠道", () => {
  const ctx = makeCtx();
  try {
    ctx.store.createAgent({ id: "guarded", name: "Guarded", approval_policy: "always" });
    const t1 = ctx.taskService.dispatchTasks({ to: "guarded", title: "部署", inputText: "deploy" }).tasks[0];
    assert.equal(t1.state, "auth-required");

    assert.throws(
      () => ctx.taskService.decideApproval(t1.id, { decision: "approve", requestId: "req_old" }),
      (err) => err.code === "stale_request" && err.statusCode === 409
    );

    const reqId = lastAuthRequestId(ctx.store, t1.id);
    const approved = ctx.taskService.decideApproval(t1.id, { decision: "approve", requestId: reqId, channel: "cli" });
    assert.equal(approved.state, "submitted");
    const dec = approved.messages.find((m) => m.kind === "auth_decision");
    assert.equal(dec.data.channel, "cli");
    assert.equal(verifyTaskApproval(approved, ctx.publicKey).ok, true);

    const t2 = ctx.taskService.dispatchTasks({ to: "guarded", title: "迁移", inputText: "migrate" }).tasks[0];
    // 未到期不处理；0 表示关闭
    assert.equal(ctx.taskService.expireApprovals(60, Date.now()).length, 0);
    assert.equal(ctx.taskService.expireApprovals(0, Date.now() + 10 * 3600_000).length, 0);
    const expired = ctx.taskService.expireApprovals(60, Date.now() + 61 * 60_000);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].id, t2.id);
    assert.equal(expired[0].state, "rejected");
    const timeoutMsg = expired[0].messages.find((m) => m.kind === "auth_decision");
    assert.equal(timeoutMsg.from_node, "hub-approval-timeout");
    assert.equal(timeoutMsg.data.channel, "timeout");
    assert.equal(verifyTaskApproval(expired[0], ctx.publicKey).ok, false);
  } finally {
    ctx.cleanup();
  }
});

test("ApprovalLinkService: 篡改、过期、一次性占用", () => {
  const ctx = makeCtx();
  try {
    const links = new ApprovalLinkService({
      store: ctx.store,
      privateKey: ctx.privateKey,
      hubUrlResolver: () => "https://hub.example.com/",
      envResolver: () => ({ AH_APPROVAL_LINKS: "1", AH_APPROVAL_LINK_TTL_MIN: "5" }),
    });
    assert.equal(links.isEnabled(), true);
    const now = Date.now();
    const link = links.issue({ taskId: "tsk_a", requestId: "req_a", now });
    assert.ok(link.url.startsWith("https://hub.example.com/approve/"));
    assert.equal(link.expiresAt, now + 5 * 60_000);

    const ok = links.verify(link.token, now + 1000);
    assert.equal(ok.ok, true);
    assert.equal(ok.taskId, "tsk_a");
    assert.equal(ok.requestId, "req_a");

    const [p, s] = link.token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ t: "tsk_other", r: "req_a", e: now + 60_000, n: "x" })).toString("base64url");
    assert.equal(links.verify(`${forgedPayload}.${s}`, now).code, "invalid_link");
    assert.equal(links.verify(`${p}.${s.slice(0, -2)}xx`, now).code, "invalid_link");
    assert.equal(links.verify(link.token, now + 6 * 60_000).code, "link_expired");

    assert.equal(links.consume(ok.nonce), true);
    assert.equal(links.consume(ok.nonce), false);
    assert.equal(links.verify(link.token, now).code, "link_used");

    // 另一把 Hub 私钥签出的链接不被接受
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-approval-k2-"));
    try {
      const other = new ApprovalLinkService({ store: ctx.store, privateKey: loadOrCreateHubKey(otherDir).privateKey, envResolver: () => ({}) });
      assert.equal(links.verify(other.issue({ taskId: "tsk_a", requestId: "req_a" }).token).code, "invalid_link");
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }

    assert.deepEqual(resolveApprovalSettings({}), { linksEnabled: false, linkTtlMin: 30, timeoutMin: 1440 });
    assert.equal(resolveApprovalSettings({ AH_APPROVAL_LINK_TTL_MIN: "99999" }).linkTtlMin, 1440);
    assert.equal(resolveApprovalSettings({ AH_APPROVAL_TIMEOUT_MIN: "0" }).timeoutMin, 0);
  } finally {
    ctx.cleanup();
  }
});

test("ExternalNotifier: 审批事件附带一次性链接，Bark 点击直达确认页", async () => {
  const sent = [];
  const notifier = new ExternalNotifier(
    { AH_BARK_URL: "https://api.day.app/k", AH_TELEGRAM_BOT_TOKEN: "t", AH_TELEGRAM_CHAT_ID: "c" },
    {
      fetchFn: async (url, opts) => {
        sent.push({ url, body: JSON.parse(opts.body) });
        return { ok: true, status: 200 };
      },
      hubUrlResolver: () => "https://hub.example.com",
      approvalLinkResolver: (ev) => `https://hub.example.com/approve/tok_${ev.taskId}.sig`,
    }
  );
  notifier.handleEvent({ type: "task.auth_required", seq: 3, taskId: "tsk_x", contextId: "ctx_x", title: "高危" });
  notifier.handleEvent({ type: "task.input_required", seq: 4, taskId: "tsk_y", contextId: "ctx_y", title: "追问" });
  await new Promise((r) => setTimeout(r, 20));
  const bark = sent.filter((s) => s.url.startsWith("https://api.day.app"));
  assert.equal(bark[0].body.url, "https://hub.example.com/approve/tok_tsk_x.sig");
  assert.ok(bark[0].body.body.includes("一键审批"));
  // 追问不是审批，不附带链接
  assert.ok(bark[1].body.url.includes("task=tsk_y"));
  const tg = sent.find((s) => s.url.includes("api.telegram.org"));
  assert.equal(tg.body.parse_mode, undefined);
  assert.ok(tg.body.text.includes("tok_tsk_x.sig"));
});

test("Gateway HTTP: 一次性审批链接 GET 只展示、POST 才签名，用过即失效", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-approve-http-"));
  const rt = await startHubRuntime({
    configDir: dir,
    listen: "127.0.0.1:0",
    env: { AH_API_TOKEN: "link_owner_tok" },
    withDeviceDaemon: false,
  });
  try {
    const owner = new GatewayClient(rt.url, { token: "link_owner_tok" });
    rt.store.createAgent({ id: "ops", name: "Ops", approval_policy: "always" });
    const task = rt.taskService.dispatchTasks({ to: "ops", title: "<b>删库</b>", inputText: "drop" }).tasks[0];

    const link = rt.approvalLinks.issueForTask(task.id);
    const pagePath = `/approve/${link.token}`;

    // 未开启时链接不可用
    let r = await fetch(rt.url + pagePath);
    assert.equal(r.status, 404);

    await owner.post("/api/v1/admin/settings", { approval_links: true, approval_timeout_min: "120" });
    const settings = await owner.get("/api/v1/admin/settings");
    assert.equal(settings.approval.links_enabled, true);
    assert.equal(settings.approval.timeout_min, 120);
    assert.equal(settings.feishu_app.status.configured, false);

    r = await fetch(rt.url + pagePath);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.match(r.headers.get("content-security-policy"), /form-action 'self'/);
    const html = await r.text();
    assert.ok(html.includes("签名并放行"));
    assert.ok(html.includes("&lt;b&gt;删库&lt;/b&gt;"));
    assert.equal(rt.store.getTask(task.id).state, "auth-required");

    const post = (body, p = pagePath) =>
      fetch(rt.url + p, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });

    r = await post("decision=maybe");
    assert.equal(r.status, 400);
    assert.equal(rt.store.getTask(task.id).state, "auth-required");

    r = await post("decision=approve", `/approve/${link.token.slice(0, -3)}abc`);
    assert.equal(r.status, 400);

    r = await post("decision=approve&note=%E5%A5%BD");
    assert.equal(r.status, 200);
    assert.ok((await r.text()).includes("已签名放行"));
    const detail = rt.taskService.getTaskDetail(task.id);
    assert.equal(detail.state, "submitted");
    const dec = detail.messages.find((m) => m.kind === "auth_decision");
    assert.equal(dec.data.channel, "link");
    assert.equal(dec.data.note, "好");
    assert.equal(
      verifyDecision(rt.publicKey, { taskId: task.id, requestId: dec.data.request_id, decision: "approved" }, dec.signature),
      true
    );

    r = await post("decision=deny");
    assert.equal(r.status, 410);
    assert.equal(rt.store.getTask(task.id).state, "submitted");

    // 已有更新的审批请求时，旧链接失效
    const t2 = rt.taskService.dispatchTasks({ to: "ops", title: "二次", inputText: "x" }).tasks[0];
    const oldLink = rt.approvalLinks.issueForTask(t2.id);
    rt.taskService.decideApproval(t2.id, { decision: "approve" });
    rt.taskService.claimTaskById(t2.id, { claimant: "ops" });
    rt.taskService.requestAuth(t2.id, { actorId: "ops", reason: "再次确认" });
    r = await fetch(`${rt.url}/approve/${oldLink.token}`);
    assert.equal(r.status, 410);
  } finally {
    await rt.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("AgentDaemon: 进入过审批的任务必须带 Hub 签名的批准才执行", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-agent-verify-"));
  const rt = await startHubRuntime({
    configDir: dir,
    listen: "127.0.0.1:0",
    env: { AH_API_TOKEN: "agent_owner_tok" },
    withDeviceDaemon: false,
  });
  try {
    const owner = new GatewayClient(rt.url, { token: "agent_owner_tok" });
    const created = await owner.post("/api/v1/agents", { id: "cloud-worker", name: "Cloud Worker", approval_policy: "always" });
    const runs = [];
    const daemon = new AgentDaemon({
      configDir: path.join(dir, "agent-home"),
      agentId: "cloud-worker",
      hubUrl: rt.url,
      token: created.token,
      command: "echo {prompt}",
      runner: async () => {
        runs.push(1);
        return { code: 0, stdout: "执行完成", stderr: "" };
      },
      pollTimeoutSec: 1,
      idleWaitMs: 0,
      logger: { warn() {}, error() {}, log() {} },
    });
    const reg = await daemon.registerOnline();
    assert.equal(reg.approval_public_key, rt.publicKey);
    assert.equal(daemon.hubPublicKey, rt.publicKey);

    // 合法路径：机主签名批准后执行
    const ok = rt.taskService.dispatchTasks({ to: "cloud-worker", title: "合法", inputText: "a" }).tasks[0];
    rt.taskService.decideApproval(ok.id, { decision: "approve" });
    await daemon.runOnce();
    assert.equal(rt.store.getTask(ok.id).state, "completed");
    assert.equal(runs.length, 1);

    // 绕过签名直接改库放回队列：执行端必须拒绝
    const forged = rt.taskService.dispatchTasks({ to: "cloud-worker", title: "伪造", inputText: "b" }).tasks[0];
    rt.store.db.prepare("UPDATE tasks SET state = 'submitted' WHERE id = ?").run(forged.id);
    await daemon.runOnce();
    const forgedRow = rt.store.getTask(forged.id);
    assert.equal(forgedRow.state, "failed");
    assert.match(forgedRow.error_message, /审批签名无效/);
    assert.equal(runs.length, 1);
  } finally {
    await rt.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Feishu WS: pbbp2 帧编解码保留 uint64 精度", () => {
  const big = 18446744073709551615n;
  const frame = {
    SeqID: big,
    LogID: 9007199254740993n,
    service: 12345,
    method: 1,
    headers: [{ key: "type", value: "event" }, { key: "message_id", value: "中文-id" }],
    payload: new TextEncoder().encode('{"a":1}'),
    LogIDNew: "log-new",
  };
  const decoded = decodeFrame(encodeFrame(frame));
  assert.equal(decoded.SeqID, big);
  assert.equal(decoded.LogID, 9007199254740993n);
  assert.equal(decoded.service, 12345);
  assert.equal(decoded.method, 1);
  assert.deepEqual(decoded.headers, frame.headers);
  assert.equal(new TextDecoder().decode(decoded.payload), '{"a":1}');
  assert.equal(decoded.LogIDNew, "log-new");
});

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = {};
    FakeWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.emit("open", {});
    }, 0);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  emit(type, ev) {
    for (const fn of this.listeners[type] || []) fn(ev);
  }
  send(bytes) {
    this.sent.push(decodeFrame(bytes));
  }
  close() {
    this.readyState = 3;
    this.emit("close", { code: 1000 });
  }
}

function jsonRes(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

async function waitFor(fn, ms = 1000) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("Feishu 应用审批：邮箱解析成本应用 open_id、跨应用 open_id 报错可见", async () => {
  const ctx = makeCtx();
  const sent = [];
  const fetchFn = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (url.endsWith("/callback/ws/endpoint")) return jsonRes({ code: 0, data: { URL: "wss://x.feishu.cn/ws/v2?service_id=1&ticket=t", ClientConfig: {} } });
    if (url.endsWith("/tenant_access_token/internal")) return jsonRes({ code: 0, tenant_access_token: "t", expire: 7200 });
    if (url.includes("/contact/v3/users/batch_get_id")) {
      assert.deepEqual(body.emails, ["boss@corp.com"]);
      assert.deepEqual(body.mobiles, ["18102019896"]);
      return jsonRes({ code: 0, data: { user_list: [{ email: "boss@corp.com", user_id: "ou_mine" }, { mobile: "18102019896", user_id: "ou_phone" }] } });
    }
    if (url.includes("/im/v1/messages?receive_id_type=")) {
      sent.push(body.receive_id);
      if (body.receive_id === "ou_foreign") return jsonRes({ code: 99992361, msg: "open_id cross app" });
      return jsonRes({ code: 0, data: { message_id: `om_${body.receive_id}` } });
    }
    return jsonRes({ code: 99, msg: "unexpected" });
  };
  const channel = new FeishuApprovalChannel({
    store: ctx.store,
    taskService: ctx.taskService,
    envResolver: () => ({ AH_FEISHU_APP_ID: "cli_x", AH_FEISHU_APP_SECRET: "s", AH_FEISHU_APPROVERS: "boss@corp.com, +86-18102019896, ou_foreign" }),
    fetchFn,
    WebSocketImpl: FakeWebSocket,
    logger: { warn() {}, error() {}, log() {} },
  });
  ctx.store.setChangeHook((ev) => channel.handleEvent(ev));
  try {
    channel.start();
    ctx.store.createAgent({ id: "prod", name: "Prod", approval_policy: "always" });
    ctx.taskService.dispatchTasks({ to: "prod", title: "上线", inputText: "ship" });
    const st = await waitFor(() => channel.status().last_send && channel.status());
    assert.deepEqual(sent.sort(), ["ou_foreign", "ou_mine", "ou_phone"]);
    assert.equal(st.last_send.ok, 2);
    assert.equal(st.last_send.failed, 1);
    assert.ok(st.last_send.error.includes("邮箱或手机号"));
    assert.equal(channel._isApprover({ open_id: "ou_mine" }), true);
    assert.equal(channel._isApprover({ open_id: "ou_phone" }), true);
    assert.equal(channel._isApprover({ open_id: "ou_other" }), false);
  } finally {
    await channel.stop();
    ctx.cleanup();
  }
});

test("Feishu 应用审批：长连接卡片回调签名放行、白名单拦截、结束后刷新卡片", async () => {
  const ctx = makeCtx();
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method: opts.method, body, headers: opts.headers });
    if (url.endsWith("/callback/ws/endpoint")) {
      assert.deepEqual(body, { AppID: "cli_a1b2c3d4e5f60718", AppSecret: "sec" });
      return jsonRes({ code: 0, data: { URL: "wss://msg-frontier.feishu.cn/ws/v2?device_id=d1&service_id=777&ticket=t", ClientConfig: { PingInterval: 90 } } });
    }
    if (url.endsWith("/tenant_access_token/internal")) return jsonRes({ code: 0, tenant_access_token: "t-abc", expire: 7200 });
    if (url.includes("/im/v1/messages?receive_id_type=")) return jsonRes({ code: 0, data: { message_id: `om_${body.receive_id}` } });
    if (opts.method === "PATCH") return jsonRes({ code: 0 });
    return jsonRes({ code: 99, msg: "unexpected" });
  };
  const env = {
    AH_FEISHU_APP_ID: "cli_a1b2c3d4e5f60718",
    AH_FEISHU_APP_SECRET: "sec",
    AH_FEISHU_APPROVERS: "ou_boss, ou_cto",
    AH_FEISHU_CHAT_ID: "oc_team",
  };
  assert.equal(resolveFeishuAppConfig({ ...env, AH_FEISHU_APPROVERS: "" }).configured, false);
  const channel = new FeishuApprovalChannel({
    store: ctx.store,
    taskService: ctx.taskService,
    envResolver: () => env,
    hubUrlResolver: () => "https://hub.example.com",
    fetchFn,
    WebSocketImpl: FakeWebSocket,
    logger: { warn() {}, error() {}, log() {} },
  });
  ctx.store.setChangeHook((ev) => channel.handleEvent(ev));
  try {
    channel.start();
    const ws = await waitFor(() => FakeWebSocket.instances.at(-1)?.readyState === 1 && FakeWebSocket.instances.at(-1));
    assert.equal(channel.status().state, "connected");
    // 连上即发 ping 控制帧
    const ping = await waitFor(() => ws.sent.find((f) => f.method === 0));
    assert.equal(ping.service, 777);

    ctx.store.createAgent({ id: "prod", name: "Prod", approval_policy: "always" });
    const task = ctx.taskService.dispatchTasks({ to: "prod", title: "上线 <at id=all></at>", inputText: "ship" }).tasks[0];

    const sends = await waitFor(() => {
      const s = calls.filter((c) => c.url.includes("/im/v1/messages?receive_id_type="));
      return s.length === 3 && s;
    });
    assert.deepEqual(sends.map((s) => s.url.split("receive_id_type=")[1]).sort(), ["chat_id", "open_id", "open_id"]);
    assert.equal(sends[0].headers.Authorization, "Bearer t-abc");
    const card = JSON.parse(sends[0].body.content);
    assert.equal(card.schema, "2.0");
    const flat = JSON.stringify(card);
    assert.ok(!flat.includes('"tag":"markdown","content":"**任务'), "任务内容不能走 markdown");
    assert.ok(flat.includes("上线 <at id=all></at>"));
    const reqId = lastAuthRequestId(ctx.store, task.id);
    assert.ok(flat.includes(reqId));

    let logId = 100n;
    const pushCallback = async (operator, decision) => {
      const event = {
        schema: "2.0",
        header: { event_type: "card.action.trigger", app_id: "cli_a1b2c3d4e5f60718" },
        event: { operator, action: { tag: "button", value: { ah: "approval", task_id: task.id, request_id: reqId, decision } } },
      };
      logId += 1n;
      const before = ws.sent.length;
      ws.emit("message", {
        data: encodeFrame({
          SeqID: 0n,
          LogID: logId,
          service: 777,
          method: 1,
          headers: [{ key: "type", value: "event" }, { key: "message_id", value: `m${logId}` }, { key: "sum", value: "1" }, { key: "seq", value: "0" }],
          payload: new TextEncoder().encode(JSON.stringify(event)),
        }).buffer,
      });
      const resp = await waitFor(() => ws.sent.slice(before).find((f) => f.method === 1 && f.LogID === logId));
      assert.ok(resp.headers.some((h) => h.key === "biz_rt"));
      const outer = JSON.parse(new TextDecoder().decode(resp.payload));
      assert.equal(outer.code, 200);
      return JSON.parse(Buffer.from(outer.data, "base64").toString("utf8"));
    };

    const denied = await pushCallback({ open_id: "ou_intruder" }, "approve");
    assert.equal(denied.toast.type, "error");
    assert.equal(ctx.store.getTask(task.id).state, "auth-required");

    const approved = await pushCallback({ open_id: "ou_cto", user_id: "u1" }, "approve");
    assert.equal(approved.toast.type, "success");
    assert.equal(approved.card.type, "raw");
    assert.equal(approved.card.data.header.template, "green");
    const detail = ctx.taskService.getTaskDetail(task.id);
    assert.equal(detail.state, "submitted");
    const dec = detail.messages.find((m) => m.kind === "auth_decision");
    assert.equal(dec.data.channel, "feishu");
    assert.equal(dec.data.operator, "ou_cto");
    assert.equal(verifyTaskApproval(detail, ctx.publicKey).ok, true);

    // 其他审批人手里的卡片被刷新为最终状态
    const patches = await waitFor(() => {
      const p = calls.filter((c) => c.method === "PATCH");
      return p.length === 3 && p;
    });
    assert.equal(JSON.parse(patches[0].body.content).header.template, "green");

    // 重复点击：任务已不在审批态，返回提示且不改变状态
    const again = await pushCallback({ open_id: "ou_boss" }, "deny");
    assert.equal(again.toast.type, "warning");
    assert.equal(ctx.store.getTask(task.id).state, "submitted");
  } finally {
    await channel.stop();
    ctx.cleanup();
  }
});
