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

  // 三步添加 Agent 向导：接收方式预设（通用/WorkBuddy/Muse/Grok Bot/长连接/自建 Webhook）、host/inbox 常驻长连接说明、Webhook Secret 提示
  assert.match(html, /选择接入类型/);
  assert.match(html, /填写名字与角色/);
  assert.match(html, /id="afTemplatePreset"/);
  assert.match(html, /const AGENT_TEMPLATES = /);
  assert.match(html, /通用 · 定时检查（poll，默认）/);
  assert.match(html, /WorkBuddy 云端版（定时任务）/);
  assert.match(html, /Muse（临时云 VM，高保活）/);
  assert.match(html, /Grok Bot（Webhook 门铃）/);
  assert.match(html, /常驻长连接（longpoll，自建进程）/);
  assert.match(html, /Webhook 推送（自建接收端）/);
  assert.match(html, /id="afPollIntervalRow"/);
  assert.match(html, /轮询间隔（分钟）/);
  assert.match(html, /id="afPollInterval"[^>]*type="number"[^>]*min="1"[^>]*max="1440"[^>]*value="5"/);
  assert.match(html, /中台按此间隔 × 1\.5 判定该 Agent 是否在线/);
  assert.match(html, /webhook_url/);
  assert.match(html, /webhook_key/);
  assert.match(html, /Token 只显示这一次/);
  assert.match(html, /派单并接单 \(Leader\)/);
  assert.equal(html.includes("两者都做"), false);
  assert.equal(html.includes("id=\"receiveModal\""), false);
  assert.equal(html.includes("切换接收方式"), false);
  assert.match(html, /节点 → 待接纳/);
  assert.match(html, /ah daemon/);
  assert.match(html, /\/api\/v1\/admin\/tokens/);
  assert.match(html, /\/api\/v1\/admin\/webhooks/);
  assert.match(html, /重新生成/);
  assert.match(html, /吊销/);
  assert.match(html, /接收方式：常驻长连接（ah daemon）/);
  assert.match(html, /Agent 每 30 分钟用检查脚本兜底一次，防止漏推，这不是第二种接收方式/);
  assert.match(html, /请填写对方提供的密钥/);

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
function runInlineConsole(fetchHandler, extra = {}) {
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
      this.disabled = false;
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
      this.children = [];
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
    appendChild(c) {
      this.children.push(c);
      if (this.tagName === "SELECT" && c.tagName === "OPTION") {
        this.options.push(c);
      }
    }
    removeChild(c) { this.children = this.children.filter((x) => x !== c); }
    click() { if (typeof extra.onAnchorClick === "function") extra.onAnchorClick(this); }
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
    afTemplatePreset: "select",
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
    body: new FakeElement("body"),
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
      if (sel === "[data-hub-preview-id]") {
        const contentHtml = getEl("content").innerHTML;
        const found = [];
        const re = /data-hub-preview-id="([^"]+)"/g;
        let m;
        while ((m = re.exec(contentHtml)) !== null) {
          found.push({ dataset: { hubPreviewId: m[1] } });
        }
        return found;
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
  if (extra.token) store.set("a2a_hub_token", extra.token);
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
    Error,
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
    ...(extra.globals || {}),
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
        webhooks: [{
          node: "cloud-bot",
          url: "https://bot.example/hook",
          header: "Authorization",
          secret_mask: "secre…",
          legacy: false,
          last_status: 200,
          last_error: "",
          last_delivered_at: new Date().toISOString(),
          last_attempt_at: new Date().toISOString(),
        }],
      });
    }
    if (url === "/api/v1/admin/webhooks/cloud-bot/test" && method === "POST") {
      return jsonRes(200, { ok: true, status: 204, error: "" });
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
    if (url === "/api/v1/admin/agents" && method === "POST") {
      return jsonRes(200, {
        ok: true, node: body.node, token: "tok_once_123",
        webhook: { url: body.webhook_url, header: "Authorization", secret_mask: "receiv…", legacy: false },
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
  assert.match(nodesHtml, /\+ 添加能力/);
  const nodeCards = nodesHtml.split('class="node-card"').slice(1);
  const macCard = nodeCards.find((html) => html.includes("mac-worker"));
  const cloudCard = nodeCards.find((html) => html.includes("cloud-bot"));
  const pollCard = nodeCards.find((html) => html.includes("poll-bot"));
  assert.ok(macCard && cloudCard && pollCard);
  assert.match(macCard, /工作机节点 · 执行方 \(Worker\)/);
  assert.match(macCard, /接收方式：常驻长连接（ah daemon）/);
  assert.equal(macCard.includes("Webhook 推送"), false);
  assert.equal(macCard.includes("切换接收方式"), false);
  assert.equal(macCard.includes("data-action=\"edit-webhook\""), false);
  assert.match(cloudCard, /云端 HTTP 节点 · Webhook 推送 · 执行方 \(Worker\)/);
  assert.match(cloudCard, /接收方式：Webhook 推送/);
  assert.match(cloudCard, /最近投递成功/);
  assert.match(cloudCard, /data-action="edit-webhook"[^>]*>管理/);
  assert.equal(cloudCard.includes("切换接收方式"), false);
  assert.equal(cloudCard.includes("这不是第二种接收方式"), false);
  assert.equal(cloudCard.includes("https://bot.example/hook"), false);
  assert.equal(cloudCard.includes("data-action=\"delete-webhook\""), false);
  assert.equal(cloudCard.includes("data-action=\"test-webhook\""), false);
  assert.match(pollCard, /云端 HTTP 节点 · 定时检查 · 执行方 \(Worker\)/);
  assert.match(pollCard, /接收方式：定时检查/);
  assert.equal(pollCard.includes("切换接收方式"), false);
  assert.equal(pollCard.includes("data-action=\"edit-webhook\""), false);
  assert.equal(pollCard.includes("data-action=\"test-webhook\""), false);
  assert.equal(pollCard.includes(">管理<"), false);
  assert.equal(pollCard.includes("https://bot.example/hook"), false);

  await vm.runInContext('openWebhookModal("cloud-bot")', sandbox);
  assert.equal(getEl("whUrl").value, "https://bot.example/hook");
  assert.equal(getEl("whHeader").value, "Authorization");
  assert.equal(getEl("whKey").value, "");
  const whStatus = getEl("whStatus").innerHTML;
  assert.match(whStatus, /https:\/\/bot\.example\/hook/);
  assert.match(whStatus, /请求头 Authorization/);
  assert.match(whStatus, /密钥掩码 secre…/);
  assert.match(whStatus, /最近投递成功/);
  assert.match(whStatus, /Agent 每 30 分钟用检查脚本兜底一次，防止漏推，这不是第二种接收方式/);
  assert.equal(getEl("whTestBtn").dataset.node, "cloud-bot");

  await vm.runInContext(`
    state.webhooksByNode.set("cloud-bot", {
      node: "cloud-bot", url: "https://bot.example/hook", header: "X-Api-Key", secret_mask: "secre…",
      legacy: false, last_status: "500", last_error: "HTTP 500", last_delivered_at: "",
      last_attempt_at: new Date(Date.now() + 60000).toISOString()
    });
    render();
  `, sandbox);
  const failedHtml = getEl("content").innerHTML;
  const failedCard = failedHtml.split('class="node-card"').slice(1).find((html) => html.includes("cloud-bot"));
  assert.match(failedCard, /投递失败/);
  assert.match(failedCard, /class="dot warn"/);
  assert.match(failedCard, /在线/);

  await vm.runInContext(`
    state.webhooksByNode.set("cloud-bot", {
      node: "cloud-bot", url: "https://bot.example/hook", legacy: true, secret_mask: "oldsec…",
      last_status: "", last_error: "", last_delivered_at: "", last_attempt_at: ""
    });
    render();
  `, sandbox);
  const legacyCard = getEl("content").innerHTML.split('class="node-card"').slice(1).find((html) => html.includes("cloud-bot"));
  assert.match(legacyCard, /需补填密钥/);
  assert.equal(legacyCard.includes('class="dot warn"'), false);

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

  // 5) 添加 Agent 向导：选择 webhook 并提交，请求体带 URL 与接收端密钥，结果页不展示明文
  await vm.runInContext('openAgentModal(); state.wizardAccess = "http"; state.wizardReceive = "webhook";', sandbox);
  getEl("afNode").value = "wh-bot";
  getEl("afWebhookUrl").value = "https://wh.example/cb";
  await getEl("agentStep2").dispatch("submit");
  assert.equal(requests.some((r) => r.url === "/api/v1/admin/agents" && r.method === "POST"), false);
  getEl("afWebhookKey").value = "receiver-key-ui";
  await getEl("agentStep2").dispatch("submit");
  const agentPost = requests.find((r) => r.url === "/api/v1/admin/agents" && r.method === "POST");
  assert.ok(agentPost);
  assert.equal(agentPost.body.receive, "webhook");
  assert.equal(agentPost.body.webhook_url, "https://wh.example/cb");
  assert.equal(agentPost.body.webhook_key, "receiver-key-ui");
  assert.equal(agentPost.body.poll_interval_min, 5);
  assert.match(getEl("onboardBox").innerHTML, /tok_once_123/);
  assert.equal(getEl("onboardBox").innerHTML.includes("receiver-key-ui"), false);
  assert.equal(renderWebConsoleHtml().includes("receiveModal"), false);

  await vm.runInContext('openAgentModal();', sandbox);
  getEl("afNode").value = "hourly-bot";
  getEl("afPollInterval").value = "60";
  await vm.runInContext('state.wizardAccess = "http"; state.wizardReceive = "webhook"; syncReceiveChoiceCards();', sandbox);
  assert.equal(getEl("afPollInterval").value, "60");
  assert.equal(getEl("afPollIntervalRow").style.display, "flex");
  getEl("afPollInterval").value = "5";
  await vm.runInContext('syncReceiveChoiceCards();', sandbox);
  assert.equal(getEl("afPollInterval").value, "30");
  await vm.runInContext('state.wizardReceive = "longpoll"; syncReceiveChoiceCards();', sandbox);
  assert.equal(getEl("afPollIntervalRow").style.display, "none");
  await vm.runInContext('state.wizardReceive = "poll"; syncReceiveChoiceCards();', sandbox);
  assert.equal(getEl("afPollInterval").value, "5");
  getEl("afPollInterval").value = "60";
  await getEl("agentStep2").dispatch("submit");
  const hourlyPost = requests.filter((r) => r.url === "/api/v1/admin/agents" && r.method === "POST").at(-1);
  assert.equal(hourlyPost.body.node, "hourly-bot");
  assert.equal(hourlyPost.body.receive, "poll");
  assert.equal(hourlyPost.body.poll_interval_min, 60);

  // 6) Step 2 节点模板下拉框：数据驱动渲染、选模板自动带出参数、选「自定义」展开手动接收方式、host 隐藏模板
  await vm.runInContext('openAgentModal(); state.wizardAccess = "http";', sandbox);
  await getEl("agentNextBtn").dispatch("click");
  assert.equal(getEl("afTemplateRow").style.display, "flex");
  assert.equal(getEl("afReceiveGroup").style.display, "none");
  assert.equal(getEl("afTemplatePreset").value, "generic-poll");
  assert.ok(getEl("afTemplatePreset").options.some((o) => o.value === "__custom__"));
  assert.equal(getEl("afPollInterval").value, "5");

  getEl("afTemplatePreset").value = "workbuddy";
  await getEl("afTemplatePreset").dispatch("change");
  assert.equal(getEl("afPollInterval").value, "30");
  assert.equal(getEl("afReceiveGroup").style.display, "none");
  assert.equal(vm.runInContext("state.wizardReceive", sandbox), "poll");

  getEl("afTemplatePreset").value = "grok-bot";
  await getEl("afTemplatePreset").dispatch("change");
  assert.equal(vm.runInContext("state.wizardReceive", sandbox), "webhook");
  assert.equal(vm.runInContext("state.wizardTemplate", sandbox), "grok-bot");
  assert.equal(getEl("afWebhookUrlRow").style.display, "flex");
  assert.equal(getEl("afPollInterval").value, "30");

  getEl("afTemplatePreset").value = "muse";
  await getEl("afTemplatePreset").dispatch("change");
  assert.equal(vm.runInContext("state.wizardReceive", sandbox), "longpoll");
  assert.equal(vm.runInContext("state.wizardTemplate", sandbox), "muse");
  assert.equal(getEl("afWebhookUrlRow").style.display, "none");
  assert.equal(getEl("afPollIntervalRow").style.display, "none");

  getEl("afTemplatePreset").value = "__custom__";
  await getEl("afTemplatePreset").dispatch("change");
  assert.equal(getEl("afReceiveGroup").style.display, "flex");

  await vm.runInContext('openAgentModal(); state.wizardAccess = "host";', sandbox);
  await getEl("agentNextBtn").dispatch("click");
  assert.equal(getEl("afTemplateRow").style.display, "none");
  assert.equal(getEl("afReceiveGroup").style.display, "none");
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

test("控制台附件静态约束：包含上传控件与函数、不把 token 拼进文件 URL、svg 不在内嵌白名单", () => {
  const html = renderWebConsoleHtml();

  // 建单与答复上传控件、图片预览弹窗
  assert.match(html, /id="tfFiles"[^>]*multiple/);
  assert.match(html, /id="tfFileList"/);
  assert.match(html, /id="replyFiles"[^>]*multiple/);
  assert.match(html, /id="replyFileList"/);
  assert.match(html, /id="imagePreviewModal"/);
  assert.match(html, /max-height:\s*160px/);

  // 关键附件辅助函数存在
  for (const fn of [
    "parseHubFileId",
    "isInlineImageMime",
    "renderAttachmentItem",
    "fetchHubImagePreview",
    "downloadHubFile",
    "uploadHubFile",
    "uploadDraftFilesSequentially",
    "revokeAttachmentObjectUrls",
  ]) {
    assert.ok(html.includes(`function ${fn}`), `缺少函数 ${fn}`);
  }

  // svg 绝不能进入内嵌白名单
  const whitelistMatch = html.match(/const INLINE_IMAGE_MIMES = new Set\(\[([^\]]+)\]\)/);
  assert.ok(whitelistMatch, "应定义 INLINE_IMAGE_MIMES 白名单");
  assert.equal(/svg/i.test(whitelistMatch[1]), false, "SVG 不应在内嵌白名单中");
  for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    assert.ok(whitelistMatch[1].includes(mime), `白名单应包含 ${mime}`);
  }

  // 安全：不把 token 拼入文件 URL，也不直接把 /api/v1/files 填进 img src 或 a href
  assert.equal(/\/api\/v1\/files\/[^'"`\n]*[?&]token=/i.test(html), false);
  assert.equal(/<img[^>]*\/api\/v1\/files\//i.test(html), false);
  assert.equal(/<a[^>]*href=[^>]*\/api\/v1\/files\//i.test(html), false);
  assert.match(html, /rel="noopener noreferrer"/);

  // 建单允许只带附件：描述框不再 required，提交时改为「文字或附件至少一个」
  assert.equal(/id="tfText"[^>]*required/.test(html), false);
  assert.ok(html.includes("请填写任务描述，或至少附上一个文件"));
  // 详情接口标了 deleted 的文件直接按 410 展示
  assert.ok(html.includes("file.deleted === true"));
});

test("控制台内嵌脚本：附件展示、Bearer 取图预览、SVG 走下载、410/404 提示、离开详情 revokeObjectURL", async () => {
  const fetchCalls = [];
  const createdUrls = [];
  const revokedUrls = [];
  const clickedAnchors = [];
  let blobSeq = 0;

  const sampleState = {
    hubNode: "mac-hub",
    seq: 1,
    connectedNodes: [],
    agentCards: [],
    tasks: [
      { task_id: "TASK-ATT-1", title: "附件展示测试", target_node: "worker-1", skill_id: "agent", status: "input-required" },
      { task_id: "TASK-ATT-2", title: "另一任务", target_node: "worker-1", skill_id: "agent", status: "completed" },
    ],
    loops: [],
  };

  const detail1 = {
    task: sampleState.tasks[0],
    messages: [
      {
        msg_id: "MSG-1",
        kind: "instruction",
        role: "user",
        from_node: "mac-hub",
        to_node: "worker-1",
        created_at: "2026-11-18 10:00",
        parts: [
          { kind: "text", text: "请看附图" },
          { kind: "file", file_uri: "hub://files/F-img1", file_name: 'pic"><img src=x>.png', mime_type: "image/png" },
          { kind: "file", file_uri: "hub://files/F-svg1", file_name: "vector.svg", mime_type: "image/svg+xml" },
          { kind: "file", file_uri: "hub://files/F-gone", file_name: "expired.png", mime_type: "image/png" },
          { kind: "file", file_uri: "hub://files/F-miss", file_name: "denied.jpg", mime_type: "image/jpeg" },
        ],
      },
    ],
    artifacts: [
      {
        artifact_id: "ART-1",
        name: "交付物",
        description: "含托管与外链",
        files: [
          { file_uri: "hub://files/F-pdf1", file_name: "report.pdf", mime_type: "application/pdf" },
          { file_uri: "https://example.com/spec.txt", file_name: "spec.txt", mime_type: "text/plain" },
          { file_uri: "javascript:alert(1)", file_name: "bad.js", mime_type: "text/javascript" },
        ],
      },
    ],
    runs: [],
  };

  const { sandbox, getEl } = runInlineConsole(
    async (url, opts = {}) => {
      fetchCalls.push({ url, opts });
      const headers = opts.headers || {};
      const jsonRes = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
      if (url === "/api/v1/state") return jsonRes(200, sampleState);
      if (url === "/api/v1/admin/tokens") return jsonRes(404, {});
      if (url === "/api/v1/admin/webhooks") return jsonRes(404, {});
      if (url === "/api/v1/schedules") return jsonRes(404, {});
      if (url === "/api/v1/tasks/TASK-ATT-1") return jsonRes(200, detail1);
      if (url === "/api/v1/tasks/TASK-ATT-2") {
        return jsonRes(200, { task: sampleState.tasks[1], messages: [], artifacts: [], runs: [] });
      }
      if (url === "/api/v1/files/F-img1?inline=1") {
        assert.equal(headers.Authorization, "Bearer tok_secret_ui");
        return { status: 200, ok: true, blob: async () => ({ type: "image/png", size: 128 }) };
      }
      if (url === "/api/v1/files/F-gone?inline=1") {
        return jsonRes(410, { error: "文件已过期清理" });
      }
      if (url === "/api/v1/files/F-miss?inline=1") {
        return jsonRes(404, { error: "Not Found" });
      }
      if (url === "/api/v1/files/F-pdf1") {
        assert.equal(headers.Authorization, "Bearer tok_secret_ui");
        return { status: 200, ok: true, blob: async () => ({ type: "application/pdf", size: 256 }) };
      }
      return jsonRes(404, { error: "Not Found" });
    },
    {
      token: "tok_secret_ui",
      onAnchorClick: (a) => clickedAnchors.push({ href: a.href, download: a.download }),
      globals: {
        URL: {
          createObjectURL: (blob) => {
            const u = `blob:mock/${++blobSeq}`;
            createdUrls.push({ url: u, blob });
            return u;
          },
          revokeObjectURL: (u) => revokedUrls.push(u),
        },
      },
    },
  );

  await vm.runInContext("refreshState()", sandbox);
  await vm.runInContext('jumpToTask("TASK-ATT-1")', sandbox);
  // 等待微任务队列让 fetchHubImagePreview 完成
  await new Promise((r) => setTimeout(r, 20));
  await vm.runInContext("render()", sandbox);

  const taskHtml = getEl("content").innerHTML;
  // XSS 转义：文件名中的 "><img src=x> 必须被 esc() 转义
  assert.equal(taskHtml.includes('"><img src=x>'), false);
  assert.match(taskHtml, /pic&quot;&gt;&lt;img src=x&gt;\.png/);
  // 白名单图片使用 blob objectUrl 渲染缩略图
  assert.match(taskHtml, /<img class="att-thumb" src="blob:mock\/1"/);
  // SVG 不在内嵌白名单中，仅显示下载按钮，不渲染 <img>
  assert.equal(sandbox.isInlineImageMime("image/svg+xml"), false);
  assert.match(taskHtml, /vector\.svg/);
  assert.match(taskHtml, /data-action="download-hub-file" data-file-id="F-svg1"/);
  // 410 / 404 状态文本
  assert.match(taskHtml, /已过期清理/);
  assert.match(taskHtml, /无法访问/);
  // 外链带 rel="noopener noreferrer" 且 target="_blank"；javascript: 链接绝不生成 <a>
  assert.match(taskHtml, /<a[^>]*href="https:\/\/example\.com\/spec\.txt"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.equal(taskHtml.includes('href="javascript:alert(1)"'), false);
  // 所有文件请求 URL 均不含 token
  for (const c of fetchCalls) {
    assert.equal(String(c.url).includes("tok_secret_ui"), false);
  }

  // 非图片下载：fetch + blob + 临时 <a download>
  await vm.runInContext('downloadHubFile("F-pdf1", "report.pdf")', sandbox);
  assert.equal(clickedAnchors.length, 1);
  assert.equal(clickedAnchors[0].download, "report.pdf");
  assert.match(clickedAnchors[0].href, /^blob:mock\//);

  // 离开任务详情（切换视图）应 revokeObjectURL
  await vm.runInContext('state.view = "overview"; render();', sandbox);
  assert.ok(revokedUrls.includes("blob:mock/1"), "离开详情时应释放图片 preview objectUrl");
});

test("控制台内嵌脚本：建单与答复多选文件上传（超 100MB 拦截、进度上传、失败阻断、空文本带附件答复）", async () => {
  const xhrCalls = [];
  const fetchCalls = [];
  let xhrBehavior = "ok";
  let fileSeq = 0;

  class MockXHR {
    constructor() {
      this.headers = {};
      this.upload = {};
      this.status = 0;
      this.responseText = "";
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(k, v) {
      this.headers[k] = v;
    }
    send(body) {
      xhrCalls.push({ method: this.method, url: this.url, headers: { ...this.headers }, body });
      if (typeof this.upload.onprogress === "function") {
        this.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 });
      }
      if (xhrBehavior === "fail-on-second" && xhrCalls.length === 2) {
        this.status = 413;
        this.responseText = JSON.stringify({ error: "超过服务端大小上限" });
        this.onload();
        return;
      }
      if (xhrBehavior === "fail-reply") {
        this.status = 500;
        this.responseText = JSON.stringify({ error: "存储不可用" });
        this.onload();
        return;
      }
      const id = `F-${++fileSeq}`;
      this.status = 201;
      this.responseText = JSON.stringify({
        file_id: id,
        uri: `hub://files/${id}`,
        name: body.name,
        mime: body.type || "application/octet-stream",
        size: body.size,
      });
      this.onload();
    }
  }

  const sampleState = {
    hubNode: "mac-hub",
    seq: 2,
    connectedNodes: [],
    agentCards: [
      {
        cap_id: "CAP-w1", node: "worker-1", worker: "", skill_id: "agent",
        skill_name: "Worker", admission: "admitted", dispatchable: "Yes",
      },
    ],
    tasks: [
      { task_id: "TASK-Q-1", title: "待答复任务", target_node: "worker-1", skill_id: "agent", status: "input-required" },
    ],
    loops: [],
  };

  const { sandbox, getEl } = runInlineConsole(
    async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      const body = opts.body ? JSON.parse(opts.body) : null;
      fetchCalls.push({ url, method, body });
      const jsonRes = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
      if (url === "/api/v1/state") return jsonRes(200, sampleState);
      if (url === "/api/v1/admin/tokens") return jsonRes(404, {});
      if (url === "/api/v1/admin/webhooks") return jsonRes(404, {});
      if (url === "/api/v1/schedules") return jsonRes(404, {});
      if (url === "/api/v1/tasks/TASK-Q-1") {
        return jsonRes(200, { task: sampleState.tasks[0], messages: [], artifacts: [], runs: [] });
      }
      if (url === "/api/v1/tasks" && method === "POST") return jsonRes(201, { task_id: "TASK-NEW-1" });
      if (url === "/api/v1/tasks/TASK-Q-1/reply" && method === "POST") return jsonRes(200, { msg_id: "MSG-2" });
      return jsonRes(404, { error: "Not Found" });
    },
    {
      token: "tok_upload_1",
      globals: { XMLHttpRequest: MockXHR },
    },
  );

  await vm.runInContext("refreshState()", sandbox);

  // 1) 超过 100MB 前端直接拦截
  sandbox.__bigFile = { name: "huge.bin", size: 100 * 1024 * 1024 + 1, type: "application/octet-stream" };
  await vm.runInContext('addDraftFiles("task", [__bigFile])', sandbox);
  assert.equal(vm.runInContext("state.taskDraftFiles.length", sandbox), 0);
  assert.match(getEl("tfFileErr").textContent, /100 MB/);

  // 2) 上传失败阻断派发提交
  sandbox.__f1 = { name: "notes 1.txt", size: 120, type: "text/plain" };
  sandbox.__f2 = { name: "bad.bin", size: 240, type: "application/octet-stream" };
  await vm.runInContext('addDraftFiles("task", [__f1, __f2])', sandbox);
  assert.equal(vm.runInContext("state.taskDraftFiles.length", sandbox), 2);
  getEl("tfTo").value = "worker-1";
  getEl("tfCap").value = "agent";
  getEl("tfText").value = "带附件派单";
  xhrBehavior = "fail-on-second";
  await getEl("taskForm").dispatch("submit");
  assert.equal(fetchCalls.some((c) => c.url === "/api/v1/tasks" && c.method === "POST"), false, "任一上传失败不得提交任务");
  assert.match(getEl("tfFileErr").textContent, /bad\.bin/);

  // 移除失败文件后再重新添加一个合法文件并提交
  const failedId = vm.runInContext("state.taskDraftFiles[1].id", sandbox);
  await vm.runInContext(`removeDraftFile("task", ${JSON.stringify(failedId)})`, sandbox);
  sandbox.__f3 = { name: "图.png", size: 300, type: "image/png" };
  await vm.runInContext('addDraftFiles("task", [__f3])', sandbox);
  xhrBehavior = "ok";
  await getEl("taskForm").dispatch("submit");

  const taskPost = fetchCalls.find((c) => c.url === "/api/v1/tasks" && c.method === "POST");
  assert.ok(taskPost, "全部上传成功后应提交 POST /api/v1/tasks");
  assert.deepEqual(taskPost.body.attachments, [{ file_id: "F-1" }, { file_id: "F-2" }]);
  // 验证 X-File-Name URL 编码、Content-Type 与 Bearer 头
  assert.equal(xhrCalls[0].headers["X-File-Name"], encodeURIComponent("notes 1.txt"));
  assert.equal(xhrCalls[0].headers["Content-Type"], "text/plain");
  assert.equal(xhrCalls[0].headers.Authorization, "Bearer tok_upload_1");
  assert.equal(xhrCalls[2].headers["X-File-Name"], encodeURIComponent("图.png"));

  // 3) 答复表单：上传失败不提交；有附件时允许 text 为空
  await vm.runInContext('jumpToTask("TASK-Q-1")', sandbox);
  await new Promise((r) => setTimeout(r, 10));
  sandbox.__rf = { name: "reply.pdf", size: 512, type: "application/pdf" };
  await vm.runInContext('addDraftFiles("reply", [__rf])', sandbox);
  getEl("replyTextBox").value = "";

  xhrBehavior = "fail-reply";
  await vm.runInContext('replyTask("TASK-Q-1")', sandbox);
  assert.equal(fetchCalls.some((c) => c.url === "/api/v1/tasks/TASK-Q-1/reply"), false);
  assert.match(getEl("replyFileErr").textContent, /存储不可用/);

  xhrBehavior = "ok";
  await vm.runInContext('replyTask("TASK-Q-1")', sandbox);
  const replyPost = fetchCalls.find((c) => c.url === "/api/v1/tasks/TASK-Q-1/reply" && c.method === "POST");
  assert.ok(replyPost, "答复附件上传成功后应允许空文本提交");
  assert.equal(replyPost.body.text, "");
  assert.deepEqual(replyPost.body.attachments, [{ file_id: "F-3" }]);
});
