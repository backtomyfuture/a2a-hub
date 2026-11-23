import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startHubRuntime } from "../src/core/hub-runtime.mjs";
import { DEFAULT_AGENT_TEMPLATES, buildAgentOnboardingPrompt, loadAgentTemplates } from "../src/core/templates.mjs";
import { renderAgentCard } from "../src/web/components/agent-card.js";
import { escapeHtml } from "../src/web/utils.js";

test("Web Console: 静态资源托管完整性、登录鉴权与 /api/v1/state 聚合视图", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-web-"));
  const rt = await startHubRuntime({
    configDir: dir,
    listen: "127.0.0.1:0",
    env: { AH_API_TOKEN: "web_owner_tok" },
    withDeviceDaemon: false,
  });

  try {
    for (const asset of [
      "/",
      "/styles.css",
      "/app.js",
      "/api.js",
      "/state.js",
      "/utils.js",
      "/components/agent-card.js",
      "/components/agent-drawer.js",
      "/components/add-modal.js",
      "/components/add-worker-modal.js",
      "/components/dispatch-modal.js",
      "/components/settings-drawer.js",
      "/views/home.js",
      "/views/agents.js",
      "/views/threads.js",
      "/views/schedules.js",
    ]) {
      const resp = await fetch(`${rt.url}${asset}`);
      assert.equal(resp.status, 200, `${asset} 应返回 200`);
    }

    // 表单登录获取 HttpOnly Cookie
    const loginResp = await fetch(`${rt.url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "web_owner_tok" }),
    });
    assert.equal(loginResp.status, 200);
    const cookie = loginResp.headers.get("set-cookie").split(";")[0];

    // 创建 Agent 与 Device，验证返回 onboarding_prompt 与 join_command
    const agResp = await fetch(`${rt.url}/api/v1/agents`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "muse",
        name: "Muse云端",
        summary: "我的云端主调度 Agent",
      }),
    });
    const agJson = await agResp.json();
    assert.equal(agJson.ok, true);
    assert.ok(agJson.onboarding_prompt.includes(agJson.token));
    assert.equal(agJson.agent.enabled, true);

    const devResp = await fetch(`${rt.url}/api/v1/devices`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "office-mac", name: "Office Mac" }),
    });
    const devJson = await devResp.json();
    assert.equal(devJson.ok, true);
    assert.ok(devJson.join_command.includes("install.sh") && devJson.join_command.includes("--join") && devJson.join_command.includes("--device office-mac"));
    assert.ok(devJson.join_commands?.unix.includes("install.sh"));
    assert.ok(devJson.join_commands?.windows.includes("install.ps1") && devJson.join_commands?.windows.includes("AH_JOIN"));
    assert.ok(devJson.join_commands?.cli.startsWith("ah join "));

    const stateResp = await fetch(`${rt.url}/api/v1/state`, { headers: { Cookie: cookie } });
    const state = await stateResp.json();
    assert.equal(state.ok, true);
    assert.equal(state.agents.length, 1);
    assert.equal(state.agents[0].summary, "我的云端主调度 Agent");
  } finally {
    await rt.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Agent Card: 正面显著展示能力定位 Summary（不被机主备注掩盖）且防御 XSS", () => {
  assert.equal(escapeHtml(`<img src=x onerror="alert(1)">`), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");

  const html = renderAgentCard({
    id: "claude-mac",
    name: "Claude <script>",
    role: "worker",
    kind: "device-worker",
    device_name: "Mac mini",
    summary: "擅长 TypeScript 重构与疑难单测修复",
    note: "这条备注绝对不能覆盖能力定位",
    skills: ["coding", "git"],
    tools: ["bash"],
    default_model: "claude-sonnet-4-5",
    enabled: true,
    online: true,
  });

  assert.ok(html.includes("擅长 TypeScript 重构与疑难单测修复"));
  assert.ok(!html.includes("这条备注绝对不能覆盖能力定位"));
  assert.ok(!html.includes("<script>"), "必须转义名称中的 HTML 标签");

  const compactHtml = renderAgentCard(
    {
      id: "mac-mini--claude",
      worker_key: "claude",
      name: "Claude Code",
      role: "worker",
      kind: "device-worker",
      device_name: "Mac mini",
      summary: "终端编程",
      skills: ["coding"],
      tools: ["bash"],
      default_model: "claude-sonnet-4-5",
      approval_policy: "risk",
      enabled: true,
      online: true,
    },
    [],
    { compactInDevice: true }
  );
  assert.ok(compactHtml.includes("is-in-device"));
  assert.ok(compactHtml.includes(">claude<"), "设备内紧凑卡片副标题应展示短 worker_key");
  assert.ok(!compactHtml.includes("Mac mini · 本机 CLI"), "设备分组内卡片不应重复显示设备名");
  assert.ok(compactHtml.includes("需审批"));
});

test("Web Console DOM Safety: 非 document 对象禁止调用 getElementById", () => {
  const webDir = path.resolve("src", "web");
  const walk = (dir) => {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...walk(full));
      else if (entry.name.endsWith(".js")) files.push(full);
    }
    return files;
  };
  for (const f of walk(webDir)) {
    const src = fs.readFileSync(f, "utf8");
    const bad = [...src.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\.getElementById\(/g)]
      .filter((m) => m[1] !== "document");
    assert.equal(bad.length, 0, `${f} 不得在 ${bad.map((m) => m[1]).join(",")} 上调用 getElementById`);
  }
});

test("Web Console UI & Templates: 主题变量切换规则、控件可读文字色与精简平台模板", () => {
  const css = fs.readFileSync(path.resolve("src", "web", "styles.css"), "utf8");
  assert.ok(css.includes(':root[data-theme="dark"]'));
  assert.ok(css.includes(':root[data-theme="light"]'));
  assert.ok(css.includes("color-scheme: dark;"));
  assert.ok(css.includes("button, input, select, textarea"));

  const html = fs.readFileSync(path.resolve("src", "web", "index.html"), "utf8");
  assert.ok(html.includes('id="btn-theme-toggle"'));
  assert.ok(html.includes('id="btn-open-settings"'));
  assert.ok(html.includes('data-tab="schedules"'));
  assert.ok(html.includes('localStorage.getItem("ah_theme")'));

  assert.equal(DEFAULT_AGENT_TEMPLATES[0].id, "generic");
  assert.equal(
    DEFAULT_AGENT_TEMPLATES.some((t) => t.id.startsWith("generic-")),
    false,
    "不应再把 poll/longpoll/webhook 拆成冗余通用模板"
  );
  assert.ok(DEFAULT_AGENT_TEMPLATES.some((t) => t.id === "muse" && t.role === "leader"));
  assert.ok(DEFAULT_AGENT_TEMPLATES.some((t) => t.id === "grok-bot" && t.transport === "webhook"));
  for (const id of ["openclaw", "hermes", "manus", "kimi-agent", "lingguang", "gemini", "claude-client", "cursor-agent", "lobechat"]) {
    assert.ok(DEFAULT_AGENT_TEMPLATES.some((t) => t.id === id), `DEFAULT_AGENT_TEMPLATES 缺少 ${id}`);
  }
  for (const removedId of ["coze", "dify", "n8n", "feishu-bot"]) {
    assert.equal(DEFAULT_AGENT_TEMPLATES.some((t) => t.id === removedId), false, `DEFAULT_AGENT_TEMPLATES 不应包含已移除的 ${removedId}`);
  }

  // 验证已有旧版 agent_templates.json 时会无损增量追加新增内置模板并过滤已移除模板
  const tplDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-tpl-"));
  try {
    fs.writeFileSync(
      path.join(tplDir, "agent_templates.json"),
      JSON.stringify([
        { id: "custom-org", name: "Custom Org", role: "worker", transport: "poll", poll_interval_min: 5 },
        { id: "coze", name: "Coze", role: "worker", transport: "webhook", poll_interval_min: 30 },
      ])
    );
    const mergedTpls = loadAgentTemplates(tplDir);
    assert.equal(mergedTpls[0].id, "custom-org");
    assert.ok(mergedTpls.some((t) => t.id === "openclaw"));
    assert.ok(mergedTpls.some((t) => t.id === "gemini"));
    assert.equal(mergedTpls.some((t) => t.id === "coze"), false);
  } finally {
    fs.rmSync(tplDir, { recursive: true, force: true });
  }

  const homeSrc = fs.readFileSync(path.resolve("src", "web", "views", "home.js"), "utf8");
  assert.equal(homeSrc.includes("home-add-btn"), false, "概览页不得再包含重复的接入按钮");
  assert.equal(homeSrc.includes("home-dispatch-btn"), false, "概览页不得再包含重复的派发按钮");
  assert.equal(homeSrc.includes("可用 Agent 能力总览"), false, "概览页不得再重复平铺 Agent 能力卡片");
  assert.equal(homeSrc.includes("all-clear-bar"), false, "零待办时不得渲染占位大绿条打断左右栏顶对齐");
  assert.ok(homeSrc.includes("节点负载") && homeSrc.includes("定时巡检") && homeSrc.includes("任务动态"));
  assert.ok(
    homeSrc.includes("kpi-strip") &&
      homeSrc.includes("seg-control") &&
      homeSrc.includes("task-excerpt") &&
      homeSrc.includes("mini-meter")
  );

  const agentsSrc = fs.readFileSync(path.resolve("src", "web", "views", "agents.js"), "utf8");
  assert.equal(agentsSrc.includes("agents-add-btn"), false, "Agent 与设备页顶部工具栏不得重复顶部栏接入按钮");
  assert.ok(
    agentsSrc.includes("device-node-card") &&
      agentsSrc.includes("data-toggle-device-collapse") &&
      agentsSrc.includes("#agent-search-input")
  );

  const dispatchSrc = fs.readFileSync(path.resolve("src", "web", "components", "dispatch-modal.js"), "utf8");
  assert.ok(dispatchSrc.includes("dispatch-group") && dispatchSrc.includes("#dispatch-agent-search"));

  const addModalSrc = fs.readFileSync(path.resolve("src", "web", "components", "add-modal.js"), "utf8");
  assert.ok(addModalSrc.includes("data-join-plat") && addModalSrc.includes("Windows PowerShell"));

  // 验证 workbuddy 与 qwen 使用精简免误报自动执行提示词，其他模板保留原有通用提示词
  for (const pid of ["workbuddy", "qwen"]) {
    const prompt = buildAgentOnboardingPrompt({
      hubUrl: "https://example.test",
      agent: { id: pid, name: pid, role: "worker", platform: pid, transport: "poll", poll_interval_min: 10 },
      token: "ah_ag_test_tok",
    });
    assert.ok(prompt.includes("免确认自动执行范围"), `${pid} 应包含免确认白名单`);
    assert.ok(prompt.includes("无待办静默结束"), `${pid} 应包含无待办静默约定`);
    assert.ok(prompt.includes("/fail"), `${pid} 应包含 fail 兜底`);
    assert.ok(!prompt.includes("/auth"), `${pid} 不应包含 /auth 高危授权`);
    assert.ok(!prompt.includes("记忆中"), `${pid} 不应要求写入对话记忆`);
    assert.ok(!prompt.includes("当前在线"), `${pid} 不应包含固定暗号回执`);
  }
  const doubaoPrompt = buildAgentOnboardingPrompt({
    hubUrl: "https://example.test",
    agent: { id: "doubao", name: "豆包", role: "worker", platform: "doubao", transport: "poll", poll_interval_min: 5 },
    token: "ah_ag_test_tok",
  });
  assert.ok(doubaoPrompt.includes("# 接入 a2a-hub 编排中台（豆包）"));
});

test("Web Console: 浮层防误触关闭 (bindBackdropClose) 与 Drawer 稳定渲染机制", async () => {
  const { bindBackdropClose } = await import("../src/web/utils.js");

  // 1. 模拟 DOM 元素验证 bindBackdropClose 行为
  const makeElement = (name) => {
    const handlers = {};
    return {
      name,
      addEventListener(type, fn) {
        handlers[type] = handlers[type] || [];
        handlers[type].push(fn);
      },
      dispatch(type, target) {
        for (const fn of handlers[type] || []) {
          fn({ target });
        }
      },
    };
  };

  const backdrop = makeElement("backdrop");
  const card = makeElement("card");
  let closeCallCount = 0;
  bindBackdropClose(backdrop, () => {
    closeCallCount++;
  });

  // 模拟正常点击空白处：mousedown 和 click 都在 backdrop
  backdrop.dispatch("mousedown", backdrop);
  backdrop.dispatch("mouseup", backdrop);
  backdrop.dispatch("click", backdrop);
  assert.equal(closeCallCount, 1, "正常点击遮罩空白处应触发关闭");

  // 模拟文本拖选滑出边界：在内部 card 上 mousedown，抬起时落在 backdrop
  backdrop.dispatch("mousedown", card);
  backdrop.dispatch("mouseup", backdrop);
  backdrop.dispatch("click", backdrop);
  assert.equal(closeCallCount, 1, "内部拖选文本越界到遮罩抬起时，绝对不得触发关闭");

  // 模拟在遮罩按下但拖拽到 card 内部释放
  // 浏览器此时 click 的 target 会冒泡为共同祖先（遮罩），所以这里按真实行为派发 backdrop
  backdrop.dispatch("mousedown", backdrop);
  backdrop.dispatch("mouseup", card);
  backdrop.dispatch("click", backdrop);
  assert.equal(closeCallCount, 1, "从外部拖入内部松开不应触发关闭");

  // 2. 静态断言：所有 5 个组件均使用 bindBackdropClose 防御误关闭
  for (const comp of [
    "src/web/components/add-modal.js",
    "src/web/components/add-worker-modal.js",
    "src/web/components/dispatch-modal.js",
    "src/web/components/agent-drawer.js",
    "src/web/components/settings-drawer.js",
  ]) {
    const src = fs.readFileSync(path.resolve(comp), "utf8");
    assert.ok(src.includes("bindBackdropClose("), `${comp} 应使用 bindBackdropClose`);
    assert.ok(
      !src.includes(".hasAttribute(\"data-modal-backdrop\")") &&
        !src.includes(".hasAttribute(\"data-worker-modal-backdrop\")") &&
        !src.includes(".hasAttribute(\"data-dispatch-backdrop\")") &&
        !src.includes(".hasAttribute(\"data-drawer-backdrop\")") &&
        !src.includes(".hasAttribute(\"data-settings-backdrop\")"),
      `${comp} 不应再保留粗糙的 hasAttribute 遮罩点击判定`
    );
  }

  // 3. 抽屉状态区就地刷新：不重建 DOM，仅更新文字
  const { refreshAgentDrawerStatus } = await import("../src/web/components/agent-drawer.js");
  const { store, setState } = await import("../src/web/state.js");
  setState({
    selectedAgentId: "a1",
    state: { agents: [{ id: "a1", name: "A", enabled: false, online: true, last_seen_at: null }] },
  });
  const nodes = {
    title: { textContent: "" },
    meta: { textContent: "" },
    btn: { textContent: "", className: "" },
  };
  const box = {
    querySelector(sel) {
      if (sel === "div > div:first-child") return nodes.title;
      if (sel === "div > div:nth-child(2)") return nodes.meta;
      if (sel === "#drawer-toggle-enabled") return nodes.btn;
      return null;
    },
  };
  refreshAgentDrawerStatus({ querySelector: (s) => (s === "[data-drawer-status]" ? box : null) });
  assert.equal(nodes.title.textContent, "当前已暂停接单");
  assert.equal(nodes.btn.textContent, "恢复启用");
  assert.ok(store.selectedAgentId === "a1");
});
