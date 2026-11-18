// Web 控制台输出与内嵌脚本语法、安全转义及结构完整性测试。

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES } from "../src/bus/tables.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { LongPollBroker } from "../src/server/longpoll-broker.mjs";
import { renderWebConsoleHtml } from "../src/server/web-ui.mjs";
import { withTemp } from "./helpers.mjs";

test("renderWebConsoleHtml 输出完整单页、零外链且内嵌 JS 语法无误", () => {
  const html = renderWebConsoleHtml();
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<\/html>\s*$/);
  // 零外网 CDN / 字体 / 脚本依赖
  assert.equal(/https?:\/\/(cdn|unpkg|jsdelivr|fonts\.googleapis)/i.test(html), false);

  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "页面应包含内嵌 <script> 标签");
  // 使用 vm.Script 编译校验内嵌 JS 语法，防止模板字符串转义失误导致浏览器报 SyntaxError
  assert.doesNotThrow(() => new vm.Script(scriptMatch[1], { filename: "web-ui-inline.js" }));
});

test("控制台包含新术语结构、接收方式、添加能力、闭环分派与定时任务页，且无命令行参数残留", () => {
  const html = renderWebConsoleHtml();

  // 首页「待我处理」与「一切正常」及状态中文映射 + 术语统一
  assert.match(html, /待我处理/);
  assert.match(html, /一切正常/);
  assert.match(html, /节点在线状态概览/);
  assert.match(html, /等待审批/);
  assert.match(html, /等待答复/);
  assert.match(html, /执行中/);
  assert.match(html, /待认领/);
  assert.equal(/Agent 名片墙/.test(html), false);

  // 派单表单只露 3 项，高级选项收起，验收清单改为行编辑器且去掉命令行参数名
  assert.match(html, /交给谁/);
  assert.match(html, /要做什么/);
  assert.match(html, /执行前需要我批准/);
  assert.match(html, /高级选项/);
  assert.match(html, /添加一条要求/);
  assert.match(html, /需要证据/);
  const withoutStyleAndVars = html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/var\(--[a-z0-9-]+\)/g, "");
  assert.equal(/--to\b|--cap\b|--text\b|--criteria\b/.test(withoutStyleAndVars), false);

  // 节点页：分层结构（节点 -> Agent -> 能力 + 节点直属能力）、添加能力与删除
  assert.match(html, /data-view="agents"[^>]*>[\s\S]*?节点/);
  assert.match(html, /节点直属能力/);
  assert.match(html, /\+ 添加能力/);
  assert.match(html, /\/api\/v1\/admin\/cards/);
  assert.match(html, /\/api\/v1\/admin\/commands-snippet/);
  assert.match(html, /去该节点改 commands\.json，守护进程自动热重载/);
  assert.match(html, /名词一分钟看懂/);
  assert.match(html, /技术详情/);
  assert.match(html, /展开能力/);

  // 三步添加 Agent 向导：接收方式三选一、host/inbox 常驻长连接说明、Webhook Secret 提示
  assert.match(html, /选择接入类型/);
  assert.match(html, /填写名字与角色/);
  assert.match(html, /定时检查（poll，默认）/);
  assert.match(html, /常驻长连接（longpoll）/);
  assert.match(html, /Webhook 推送（webhook）/);
  assert.match(html, /webhook_url/);
  assert.match(html, /Token 只显示这一次/);
  assert.match(html, /Webhook Secret 只显示这一次/);
  assert.match(html, /节点 → 待接纳/);
  assert.match(html, /ah daemon/);
  assert.match(html, /\/api\/v1\/admin\/tokens/);
  assert.match(html, /\/api\/v1\/admin\/webhooks/);
  assert.match(html, /重新生成/);
  assert.match(html, /吊销/);
  assert.match(html, /id="receiveModal"/);
  assert.match(html, /切换接收方式/);
  assert.match(html, /接收方式：常驻长连接（ah daemon）/);
  assert.match(html, /Agent 每 30 分钟用检查脚本兜底一次，防止漏推，这不是第二种接收方式/);
  assert.match(html, /把这段提示词发给对方 Agent，让它改用新方式/);
  assert.match(html, /\/api\/v1\/admin\/nodes\//);

  // 新建闭环：顶部说明、全部阶段用同一个、stageBindings 提交
  assert.match(html, /什么是闭环/);
  assert.match(html, /与单次任务的区别/);
  assert.match(html, /与能力（Skill）的区别/);
  assert.match(html, /全部阶段用同一个/);
  assert.match(html, /stageBindings/);

  // 定时任务只读页
  assert.match(html, /data-view="schedules"[^>]*>[\s\S]*?定时任务/);
  assert.match(html, /\/api\/v1\/schedules/);
  assert.match(html, /计划在各节点本地管理，用 ah schedule 修改/);

  // 深浅色与窄屏导航适配
  assert.match(html, /prefers-color-scheme:\s*light/);
  assert.match(html, /mobile-nav/);
});

// 构造轻量模拟 DOM/fetch 沙箱运行内嵌脚本，直接验证表单提交 payload、节点分层渲染与定时任务页逻辑。
function runInlineConsole(fetchHandler) {
  const html = renderWebConsoleHtml();
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch);

  class FakeElement {
    constructor(tag = "div", id = "") {
      this.tagName = tag.toUpperCase();
      this.id = id;
      this.value = "";
      this.checked = false;
      this.open = false;
      this.style = {};
      this.dataset = {};
      this._innerHTML = "";
      this.textContent = "";
      this.children = [];
      this.options = [];
      this._listeners = new Map();
      this.className = "";
      this.classList = {
        _set: new Set(),
        add: (...cls) => cls.forEach((c) => this.classList._set.add(c)),
        remove: (...cls) => cls.forEach((c) => this.classList._set.delete(c)),
        toggle: (c, force) => {
          if (force === undefined) {
            if (this.classList._set.has(c)) this.classList._set.delete(c);
            else this.classList._set.add(c);
          } else if (force) this.classList._set.add(c);
          else this.classList._set.delete(c);
        },
        contains: (c) => this.classList._set.has(c),
      };
    }
    set innerHTML(v) {
      this._innerHTML = String(v ?? "");
      if (this.tagName === "SELECT") {
        const opts = [];
        const re = /<option[^>]*value="([^"]*)"[^>]*>/g;
        let m;
        while ((m = re.exec(this._innerHTML)) !== null) opts.push({ value: m[1] });
        this.options = opts;
        if (opts.length && !opts.some((o) => o.value === this.value)) {
          const selMatch = /<option[^>]*value="([^"]*)"[^>]*selected/.exec(this._innerHTML);
          this.value = selMatch ? selMatch[1] : opts[0].value;
        }
      }
    }
    get innerHTML() { return this._innerHTML; }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    async dispatch(type, ev = {}) {
      const fns = this._listeners.get(type) || [];
      const event = Object.assign({ target: this, preventDefault: () => {} }, ev);
      for (const fn of fns) await fn(event);
    }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    closest() { return null; }
    appendChild(c) { this.children.push(c); }
    reset() { this.value = ""; }
  }

  const elements = new Map();
  const idTags = {
    lfTemplate: "select",
    lfBulkNode: "select",
    lfBulkCap: "select",
    tfTargetSelect: "select",
    acSideEffect: "select",
    acApproval: "select",
    acMode: "select",
    afRole: "select",
  };
  function getEl(id) {
    if (!elements.has(id)) {
      const el = new FakeElement(idTags[id] || "div", id);
      if (id === "lfMaxIter") el.value = "5";
      if (id === "lfCap") el.value = "agent";
      if (id === "afRole") el.value = "worker";
      if (id === "acSideEffect") el.value = "write";
      if (id === "acApproval") el.value = "auto";
      if (id === "acMode") el.value = "agent";
      elements.set(id, el);
    }
    return elements.get(id);
  }
  const docListeners = new Map();
  const fakeDoc = {
    documentElement: new FakeElement("html"),
    getElementById: (id) => getEl(id),
    querySelectorAll: (sel) => {
      if (sel === "#lfStageBindings .stage-bind-row") {
        const htmlStr = getEl("lfStageBindings").innerHTML;
        const rows = [];
        const re = /class="stage-bind-row" data-stage-id="([^"]+)"[^>]*>[\s\S]*?<select class="input stage-node-sel"[^>]*>([\s\S]*?)<\/select><select class="input stage-cap-sel"[^>]*>([\s\S]*?)<\/select>/g;
        let m;
        while ((m = re.exec(htmlStr)) !== null) {
          const nodeSel = new FakeElement("select");
          nodeSel.innerHTML = m[2];
          const capSel = new FakeElement("select");
          capSel.innerHTML = m[3];
          rows.push({
            dataset: { stageId: m[1] },
            querySelector: (q) => (q === ".stage-node-sel" ? nodeSel : q === ".stage-cap-sel" ? capSel : null),
          });
        }
        return rows;
      }
      return [];
    },
    createElement: (tag) => new FakeElement(tag),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
  };
  const store = new Map();
  const sandbox = {
    console,
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    JSON,
    Promise,
    URLSearchParams,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout: () => 1,
    clearTimeout: () => {},
    location: { search: "", pathname: "/", hash: "" },
    history: { replaceState: () => {} },
    localStorage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
    },
    window: {},
    document: fakeDoc,
    fetch: async (url, opts) => {
      if (String(url).startsWith("/api/v1/poll")) {
        return new Promise(() => {});
      }
      return fetchHandler(url, opts);
    },
  };
  // 屏蔽脚本尾部自动 startLongPoll 的死循环挂起，改为暴露内部方法供测试直接调用
  const patchedScript = scriptMatch[1].replace("startLongPoll();", "");
  vm.runInNewContext(patchedScript, sandbox, { filename: "web-ui-sim.js" });
  return { sandbox, getEl };
}

test("控制台内嵌脚本：节点分层渲染、stageBindings 闭环提交、添加能力、Webhook 与定时任务页交互", async () => {
  const requests = [];
  const sampleState = {
    hubNode: "mac-hub",
    seq: 12,
    connectedNodes: [
      { node: "mac-worker", kind: "host", role: "worker", mode: "longpoll", online: true, lastSeenAt: new Date().toISOString() },
      { node: "cloud-bot", kind: "agent", role: "worker", mode: "webhook", online: true, lastSeenAt: new Date().toISOString() },
    ],
    agentCards: [
      {
        cap_id: "CAP-mac-claude-agent", node: "mac-worker", worker: "claude", skill_id: "agent",
        skill_name: "Claude Code", display_name: "Claude", side_effect: "write", approval_class: "auto",
        availability: "online", dispatchable: "Yes", receive_mode: "longpoll", admission: "admitted", kind: "host",
      },
      {
        cap_id: "CAP-mac-claude-review", node: "mac-worker", worker: "claude", skill_id: "review",
        skill_name: "Code Review", display_name: "", side_effect: "read", approval_class: "auto",
        availability: "online", dispatchable: "Yes", receive_mode: "longpoll", admission: "admitted", kind: "host",
      },
      {
        cap_id: "CAP-mac-echo", node: "mac-worker", worker: "", skill_id: "echo",
        skill_name: "Echo", display_name: "", side_effect: "read", approval_class: "auto",
        availability: "online", dispatchable: "Yes", receive_mode: "longpoll", admission: "admitted", kind: "host",
      },
      {
        cap_id: "CAP-cloud-agent", node: "cloud-bot", worker: "", skill_id: "agent",
        skill_name: "Cloud Bot", display_name: "云端助手", side_effect: "write", approval_class: "auto",
        availability: "online", dispatchable: "Yes", receive_mode: "webhook", daemon_version: "http-agent",
        admission: "admitted", kind: "agent", role: "worker",
      },
      {
        cap_id: "CAP-poll-agent", node: "poll-bot", worker: "", skill_id: "agent",
        skill_name: "Poll Bot", display_name: "定时助手", side_effect: "write", approval_class: "auto",
        availability: "online", dispatchable: "Yes", receive_mode: "http-poll", daemon_version: "http-agent",
        admission: "admitted", kind: "agent", role: "worker",
      },
    ],
    tasks: [],
    loops: [
      {
        loop_id: "LOOP-1", title: "测试闭环", goal: "完成改造", status: "running", iteration: 1, max_iterations: 5, stage_index: 0,
        stages: [
          { id: "plan", name: "规划", to: "cloud-bot", worker: "", cap: "agent" },
          { id: "implement", name: "实现", to: "mac-worker", worker: "claude", cap: "agent" },
        ],
      },
    ],
  };

  const { sandbox, getEl } = runInlineConsole(async (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    requests.push({ url, method, body });

    const jsonRes = (status, data) => ({
      status,
      ok: status >= 200 && status < 300,
      json: async () => data,
    });
    if (url === "/api/v1/state") return jsonRes(200, sampleState);
    if (url === "/api/v1/admin/tokens") return jsonRes(200, { tokens: [{ node: "cloud-bot", prefix: "a2a_xx", last_used_at: null }] });
    if (url === "/api/v1/admin/webhooks") {
      return jsonRes(200, {
        webhooks: [{ node: "cloud-bot", url: "https://bot.example/hook", last_status: 200, last_error: "", last_delivered_at: new Date().toISOString() }],
      });
    }
    if (url === "/api/v1/schedules") {
      return jsonRes(200, {
        schedules: [
          {
            rule_id: "mac-worker:daily", node: "mac-worker", schedule_id: "daily", cron: "0 9 * * *",
            tz: "Asia/Shanghai", cap: "echo", text: "每日巡检", enabled: true,
            next_fire_at: new Date(Date.now() + 3600_000).toISOString(), source: "node",
            last_task: { task_id: "TASK-100", status: "completed", updated_at: new Date().toISOString() },
            anomaly: "",
          },
          {
            rule_id: "cloud-bot:hourly", node: "cloud-bot", schedule_id: "hourly", cron: "0 * * * *",
            tz: "", cap: "agent", text: "每小时拉取", enabled: true,
            next_fire_at: "", source: "http-agent", last_task: null, anomaly: "missed",
          },
        ],
      });
    }
    if (url === "/api/v1/loop-templates") {
      return jsonRes(200, {
        templates: [{
          id: "plan-code-verify", name: "Plan -> Code -> Verify", description: "三阶段闭环",
          stages: [
            { id: "plan", name: "方案规划", cap: "agent", on_fail: "retry" },
            { id: "implement", name: "编码实现", cap: "agent", on_fail: "retry" },
            { id: "verify", name: "验收门禁", cap: "agent", on_fail: "goto:implement" },
          ],
        }],
      });
    }
    if (url === "/api/v1/loops" && method === "POST") return jsonRes(201, { loop_id: "LOOP-2" });
    if (url === "/api/v1/admin/cards" && method === "POST") return jsonRes(200, { ok: true, card: { cap_id: "CAP-new" } });
    if (url === "/api/v1/admin/commands-snippet" && method === "POST") {
      return jsonRes(200, { snippet: { lint: { command: "npm run lint", mode: "json" } }, text: '{"lint":{"command":"npm run lint"}}', hint: "去该节点改 commands.json，守护进程自动热重载" });
    }
    if (method === "POST" && /^\/api\/v1\/admin\/nodes\/[^/]+\/receive$/.test(url)) {
      return jsonRes(200, {
        ok: true,
        node: "poll-bot",
        receive: body.receive,
        receive_mode: body.receive === "webhook" ? "webhook" : "http-longpoll",
        cards_updated: 1,
        webhook: body.receive === "webhook" ? { url: body.webhook_url, secret: "whsec_switch_once" } : undefined,
        onboarding: { prompt: "改用 " + body.receive },
      });
    }
    if (url === "/api/v1/admin/agents" && method === "POST") {
      return jsonRes(200, {
        ok: true, node: body.node, token: "tok_once_123",
        webhook: { url: body.webhook_url, secret: "whsec_once_456" },
        card: { cap_id: "CAP-x" },
        onboarding: { access: "http", role: "worker", prompt: "test prompt", steps: [], skills: [] },
      });
    }
    return jsonRes(404, { error: "Not Found" });
  });

  await vm.runInContext("refreshState()", sandbox);

  // 1) 节点页：展开 mac-worker，验证 Agent 归组、旗下能力与「节点直属能力」，以及云端节点 Webhook 展示
  await vm.runInContext('state.view = "agents"; state.expandedNodes.add("mac-worker"); render();', sandbox);
  const nodesHtml = getEl("content").innerHTML;
  assert.match(nodesHtml, /Claude/);
  assert.match(nodesHtml, /Code Review/);
  assert.match(nodesHtml, /节点直属能力/);
  assert.match(nodesHtml, /Echo/);
  assert.match(nodesHtml, /https:\/\/bot\.example\/hook/);
  assert.match(nodesHtml, /最近投递 HTTP 200/);
  assert.match(nodesHtml, /\+ 添加能力/);
  const nodeCards = nodesHtml.split('class="node-card"').slice(1);
  const macCard = nodeCards.find((html) => html.includes("mac-worker"));
  const cloudCard = nodeCards.find((html) => html.includes("cloud-bot"));
  const pollCard = nodeCards.find((html) => html.includes("poll-bot"));
  assert.ok(macCard && cloudCard && pollCard);
  assert.match(macCard, /接收方式：常驻长连接（ah daemon）/);
  assert.equal(macCard.includes("切换接收方式"), false);
  assert.equal(macCard.includes("data-action=\"edit-webhook\""), false);
  assert.match(cloudCard, /接收方式：Webhook 推送/);
  assert.match(cloudCard, /切换接收方式/);
  assert.match(cloudCard, /这不是第二种接收方式/);
  assert.equal(cloudCard.includes("data-action=\"delete-webhook\""), false);
  assert.match(pollCard, /接收方式：定时检查/);
  assert.match(pollCard, /切换接收方式/);
  assert.equal(pollCard.includes("data-action=\"edit-webhook\""), false);
  assert.equal(pollCard.includes("data-action=\"test-webhook\""), false);
  assert.equal(pollCard.includes("https://bot.example/hook"), false);

  // 2) 闭环页卡片每个阶段显示派给了谁；新建闭环弹窗提交 stageBindings
  await vm.runInContext('state.view = "loops"; render();', sandbox);
  const loopsHtml = getEl("content").innerHTML;
  assert.match(loopsHtml, /云端助手 \(cloud-bot\) · agent/);
  assert.match(loopsHtml, /Claude \(mac-worker\) · claude/);

  await vm.runInContext("openLoopModal()", sandbox);
  const stageHtml = getEl("lfStageBindings").innerHTML;
  assert.match(stageHtml, /data-stage-id="plan"/);
  assert.match(stageHtml, /data-stage-id="implement"/);
  assert.match(stageHtml, /data-stage-id="verify"/);
  getEl("lfGoal").value = "验证多阶段绑定";
  await getEl("loopForm").dispatch("submit");
  const loopPost = requests.find((r) => r.url === "/api/v1/loops" && r.method === "POST");
  assert.ok(loopPost, "应提交 POST /api/v1/loops");
  assert.ok(loopPost.body.stageBindings && loopPost.body.stageBindings.plan && loopPost.body.stageBindings.verify);
  assert.ok(loopPost.body.stageBindings.plan.to);

  // 3) 定时任务页（只读）：按节点分组、cron、上次任务、异常标记
  await vm.runInContext('state.view = "schedules"; render();', sandbox);
  const schedHtml = getEl("content").innerHTML;
  assert.match(schedHtml, /计划在各节点本地管理，用 ah schedule 修改/);
  assert.match(schedHtml, /0 9 \* \* \*/);
  assert.match(schedHtml, /TASK-100/);
  assert.match(schedHtml, /漏触发 \(missed\)/);

  // 4) 添加能力：HTTP 节点调 /api/v1/admin/cards，Host 节点调 /api/v1/admin/commands-snippet
  await vm.runInContext('openAddCapModal("cloud-bot")', sandbox);
  getEl("acSkillId").value = "translate";
  getEl("acSkillName").value = "翻译";
  await getEl("addCapForm").dispatch("submit");
  const cardPost = requests.find((r) => r.url === "/api/v1/admin/cards" && r.method === "POST");
  assert.ok(cardPost);
  assert.equal(cardPost.body.node, "cloud-bot");
  assert.equal(cardPost.body.skill_id, "translate");

  await vm.runInContext('openAddCapModal("mac-worker")', sandbox);
  getEl("acSkillId").value = "lint";
  getEl("acCommand").value = "npm run lint";
  await getEl("addCapForm").dispatch("submit");
  const snipPost = requests.find((r) => r.url === "/api/v1/admin/commands-snippet" && r.method === "POST");
  assert.ok(snipPost);
  assert.equal(snipPost.body.skill_id, "lint");
  assert.match(getEl("acSnippetText").value, /npm run lint/);

  // 5) 添加 Agent 向导：选择 webhook 并提交，验证请求体带 receive/webhook_url 且结果页展示 Secret
  await vm.runInContext('openAgentModal(); state.wizardAccess = "http"; state.wizardReceive = "webhook";', sandbox);
  getEl("afNode").value = "wh-bot";
  getEl("afWebhookUrl").value = "https://wh.example/cb";
  await getEl("agentStep2").dispatch("submit");
  const agentPost = requests.find((r) => r.url === "/api/v1/admin/agents" && r.method === "POST");
  assert.ok(agentPost);
  assert.equal(agentPost.body.receive, "webhook");
  assert.equal(agentPost.body.webhook_url, "https://wh.example/cb");
  assert.match(getEl("onboardBox").innerHTML, /tok_once_123/);
  assert.match(getEl("onboardBox").innerHTML, /whsec_once_456/);

  // 6) 切换接收方式弹窗存在，提交走新接口，结果页带一次性 secret 与提示词
  assert.ok(getEl("receiveModal"));
  await vm.runInContext('openSwitchReceive("poll-bot"); state.switchReceive = "webhook";', sandbox);
  getEl("rxUrl").value = "https://wh.example/switch";
  await getEl("receiveForm").dispatch("submit");
  const receivePost = requests.find((r) => r.method === "POST" && r.url === "/api/v1/admin/nodes/poll-bot/receive");
  assert.ok(receivePost);
  assert.equal(receivePost.body.receive, "webhook");
  assert.equal(receivePost.body.webhook_url, "https://wh.example/switch");
  assert.match(getEl("rxResult").innerHTML, /whsec_switch_once/);
  assert.match(getEl("rxResult").innerHTML, /把这段提示词发给对方 Agent，让它改用新方式/);
  assert.match(getEl("rxResult").innerHTML, /改用 webhook/);
});

test("控制台对尚未合入的后端接口（404）给出友好降级提示而非报错白屏", async () => {
  const { sandbox, getEl } = runInlineConsole(async (url) => {
    if (url === "/api/v1/state") {
      return {
        status: 200,
        ok: true,
        json: async () => ({ hubNode: "hub", seq: 1, connectedNodes: [], agentCards: [], tasks: [], loops: [] }),
      };
    }
    return { status: 404, ok: false, json: async () => ({ error: "Not Found" }) };
  });

  await vm.runInContext("refreshState()", sandbox);
  await vm.runInContext('state.view = "schedules"; render();', sandbox);
  const schedHtml = getEl("content").innerHTML;
  assert.match(schedHtml, /计划在各节点本地管理，用 ah schedule 修改/);
  assert.match(schedHtml, /后端暂未启用定时任务查询接口/);
});

test("startHubHttpServer GET / 返回可用控制台 HTML", async () => {
  await withTemp(async (dir) => {
    const broker = new LongPollBroker({ initialSeq: 0 });
    const bus = new SqliteBus({ dbPath: path.join(dir, "hub.db"), tables: DEFAULT_TABLES, broker });
    const handle = await startHubHttpServer({
      cfg: { node: "test-hub", configDir: dir, listen: "127.0.0.1:0", apiToken: "" },
      bus,
      broker,
      log: () => {},
      onWake: () => {},
    });
    try {
      const res = await fetch(handle.localUrl + "/");
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") || "", /text\/html/);
      const body = await res.text();
      assert.match(body, /A2A-Hub/);
      assert.match(body, /待我处理/);
    } finally {
      await handle.close();
      bus.close();
    }
  });
});
