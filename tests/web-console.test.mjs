import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startHubRuntime } from "../src/core/hub-runtime.mjs";
import { DEFAULT_AGENT_TEMPLATES } from "../src/core/templates.mjs";
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
});
