import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startHubRuntime } from "../src/core/hub-runtime.mjs";
import { DEFAULT_AGENT_TEMPLATES, loadAgentTemplates } from "../src/core/templates.mjs";
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
  for (const id of ["openclaw", "hermes", "manus", "kimi-agent", "coze", "dify", "n8n", "feishu-bot"]) {
    assert.ok(DEFAULT_AGENT_TEMPLATES.some((t) => t.id === id), `DEFAULT_AGENT_TEMPLATES 缺少 ${id}`);
  }

  // 验证已有旧版 agent_templates.json 时会无损增量追加新增内置模板
  const tplDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-tpl-"));
  try {
    fs.writeFileSync(
      path.join(tplDir, "agent_templates.json"),
      JSON.stringify([{ id: "custom-org", name: "Custom Org", role: "worker", transport: "poll", poll_interval_min: 5 }])
    );
    const mergedTpls = loadAgentTemplates(tplDir);
    assert.equal(mergedTpls[0].id, "custom-org");
    assert.ok(mergedTpls.some((t) => t.id === "openclaw"));
    assert.ok(mergedTpls.some((t) => t.id === "dify"));
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
});
