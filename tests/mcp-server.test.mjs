import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { GatewayClient } from "../src/client/gateway-client.mjs";
import { startHubRuntime } from "../src/core/hub-runtime.mjs";
import { runMcpStdioCommand } from "../src/core/mcp-server.mjs";
import { DEFAULT_AGENT_TEMPLATES, buildAgentMcpOnboarding, buildAgentMcpPrompt } from "../src/core/templates.mjs";

test("MCP Server (Streamable HTTP & Token Identity Binding): 按 Token 角色动态裁剪工具、零参数防冒充与完整派单接单闭环", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-mcp-"));
  const rt = await startHubRuntime({
    configDir: dir,
    listen: "127.0.0.1:0",
    env: { AH_API_TOKEN: "mcp_owner_tok" },
    withDeviceDaemon: false,
  });

  try {
    const owner = new GatewayClient(rt.url, { token: "mcp_owner_tok" });

    // 1) 创建 Leader (Muse) 与 Worker (Gemini)
    const leaderCreated = await owner.post("/api/v1/agents", {
      id: "muse",
      platform: "muse",
      name: "Muse",
      role: "leader",
      summary: "主控调度 Agent",
    });
    const workerCreated = await owner.post("/api/v1/agents", {
      id: "gemini",
      platform: "gemini",
      name: "Gemini",
      role: "worker",
      summary: "Google Gemini 终端",
    });

    // 验证新增 Agent 接口返回脱敏的 mcp_onboarding（mcp_prompt 不含 Token 明文与 curl）
    assert.ok(workerCreated.mcp_onboarding, "应返回 mcp_onboarding");
    assert.equal(workerCreated.mcp_onboarding.preferred_connect, "mcp");
    assert.ok(
      !workerCreated.mcp_onboarding.mcp_prompt.includes(workerCreated.token),
      "MCP 激活提示词严禁暴露 Token 明文"
    );
    assert.ok(
      !workerCreated.mcp_onboarding.mcp_prompt.includes("curl "),
      "MCP 激活提示词严禁包含 curl 命令"
    );
    assert.ok(
      workerCreated.mcp_onboarding.http_json.includes(workerCreated.token),
      "MCP HTTP JSON 配置文件应在传输层携带 Token"
    );
    assert.ok(
      workerCreated.mcp_onboarding.http_json.includes("serverUrl"),
      "Gemini 模板的 Streamable HTTP 配置应使用 serverUrl 字段"
    );
    assert.ok(
      workerCreated.mcp_onboarding.cli_commands.gemini.includes("gemini mcp add --transport http a2a-hub"),
      "应生成 Gemini CLI HTTP 一行挂载命令"
    );

    // 验证支持 URL ?token= 鉴权（适配不支持自定义 headers 的 Streamable HTTP 客户端）
    const qAuthResp = await fetch(`${rt.url}/api/v1/mcp?token=${encodeURIComponent(workerCreated.token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "initialize" }),
    });
    assert.equal(qAuthResp.status, 200);
    const qAuthJson = await qAuthResp.json();
    assert.equal(qAuthJson.result.serverInfo.name, "a2a-hub");
    assert.ok(qAuthJson.result.instructions.includes("gemini"));

    const badQAuthResp = await fetch(`${rt.url}/api/v1/mcp?token=invalid_tok`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "initialize" }),
    });
    assert.equal(badQAuthResp.status, 401);

    const leaderMcp = new GatewayClient(rt.url, { token: leaderCreated.token });
    const workerMcp = new GatewayClient(rt.url, { token: workerCreated.token });

    // 2) initialize 与 notifications/initialized (202 Accepted)
    const initRes = await workerMcp.post("/api/v1/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", clientInfo: { name: "gemini-cli", version: "1.0.0" } },
    });
    assert.equal(initRes.jsonrpc, "2.0");
    assert.equal(initRes.id, 1);
    assert.equal(initRes.result.serverInfo.name, "a2a-hub");
    assert.ok(initRes.result.instructions.includes("gemini"));

    const notifResp = await fetch(`${rt.url}/api/v1/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${workerCreated.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(notifResp.status, 202);

    // 3) 验证基于 Token 角色动态裁剪 tools/list
    const workerToolsRes = await workerMcp.post("/api/v1/mcp", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const workerToolNames = workerToolsRes.result.tools.map((t) => t.name);
    assert.deepEqual(workerToolNames, [
      "a2a_register",
      "a2a_poll_inbox",
      "a2a_claim_task",
      "a2a_submit_receipt",
    ]);

    const leaderToolsRes = await leaderMcp.post("/api/v1/mcp", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    });
    const leaderToolNames = leaderToolsRes.result.tools.map((t) => t.name);
    assert.deepEqual(leaderToolNames, [
      "a2a_register",
      "a2a_list_agents",
      "a2a_dispatch_task",
      "a2a_check_updates",
      "a2a_reply_task",
    ]);

    // 4) 零参数签到与防冒充校验
    const regWorker = await workerMcp.post("/api/v1/mcp", {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "a2a_register",
        arguments: {
          summary: "已通过 MCP 签到的 Gemini 节点",
          skills: ["mcp", "multimodal"],
        },
      },
    });
    assert.equal(regWorker.result.isError, false);
    assert.equal(regWorker.result.structuredContent.agent_id, "gemini");
    assert.equal(regWorker.result.structuredContent.online, true);

    const spoofAttempt = await workerMcp.post("/api/v1/mcp", {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "a2a_register",
        arguments: { id: "muse", summary: "尝试冒充 Muse" },
      },
    });
    assert.equal(spoofAttempt.result.isError, true);
    assert.equal(spoofAttempt.result.structuredContent.error, "impersonation_forbidden");

    // 5) Worker 启动长轮询接单 (wait_sec=5, auto_claim=true)，同时 Leader 派单触发实时唤醒
    const pollPromise = workerMcp.post("/api/v1/mcp", {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "a2a_poll_inbox",
        arguments: { wait_sec: 5, auto_claim: true },
      },
    });
    await new Promise((r) => setTimeout(r, 60));

    const dispatchRes = await leaderMcp.post("/api/v1/mcp", {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "a2a_dispatch_task",
        arguments: {
          to: ["gemini"],
          title: "审查 MCP 协议安全性",
          input_text: "请输出包含 Markdown 代码块与引号的报告",
        },
      },
    });
    assert.equal(dispatchRes.result.isError, false);
    const taskId = dispatchRes.result.structuredContent.tasks[0].id;

    const pollWokeRes = await pollPromise;
    assert.equal(pollWokeRes.result.isError, false);
    const claimedTask = pollWokeRes.result.structuredContent.claimed_task;
    assert.ok(claimedTask, "auto_claim=true 应自动认领新派入的待办任务");
    assert.equal(claimedTask.id, taskId);
    assert.equal(claimedTask.state, "working");

    // 6) Worker 发起 input-required 追问 -> Leader 拉取 updates 并回答 -> Worker 完成交付复杂特殊字符文本
    const askRes = await workerMcp.post("/api/v1/mcp", {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "a2a_submit_receipt",
        arguments: {
          task_id: taskId,
          status: "input-required",
          prompt: "是否需要包含 Stdio 模式评估？",
        },
      },
    });
    assert.equal(askRes.result.structuredContent.task.state, "input-required");

    const upd1 = await leaderMcp.post("/api/v1/mcp", {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "a2a_check_updates",
        arguments: { advance: true },
      },
    });
    assert.equal(upd1.result.structuredContent.updates.length, 1);
    assert.equal(upd1.result.structuredContent.updates[0].state, "input-required");

    const replyRes = await leaderMcp.post("/api/v1/mcp", {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "a2a_reply_task",
        arguments: {
          task_id: taskId,
          action: "reply",
          body: "需要，请一并覆盖 Stdio 与 Streamable HTTP。",
        },
      },
    });
    assert.equal(replyRes.result.structuredContent.task.state, "submitted");

    // Worker 重新认领并提交含复杂引号、换行、代码块的回执（验证零转义损伤）
    const claimAgain = await workerMcp.post("/api/v1/mcp", {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "a2a_claim_task",
        arguments: {},
      },
    });
    assert.equal(claimAgain.result.structuredContent.task.id, taskId);

    const complexReport = "评估结论：'单引号' 与 \"双引号\" 以及 `$SHELL` 均安全。\n```json\n{\"ok\": true}\n```";
    const doneRes = await workerMcp.post("/api/v1/mcp", {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "a2a_submit_receipt",
        arguments: {
          task_id: taskId,
          status: "completed",
          summary: "MCP 安全性验证通过",
          text: complexReport,
        },
      },
    });
    assert.equal(doneRes.result.isError, false);
    assert.equal(doneRes.result.structuredContent.task.state, "completed");

    const upd2 = await leaderMcp.post("/api/v1/mcp", {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "a2a_check_updates",
        arguments: { advance: true },
      },
    });
    assert.equal(upd2.result.structuredContent.updates.length, 1);
    assert.equal(upd2.result.structuredContent.updates[0].receipt.text, complexReport);
  } finally {
    await rt.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP Stdio (`ah mcp`): 通过 stdin/stdout 行级 JSON-RPC 2.0 桥接转发", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-mcp-stdio-"));
  const rt = await startHubRuntime({
    configDir: dir,
    listen: "127.0.0.1:0",
    env: { AH_API_TOKEN: "stdio_owner_tok" },
    withDeviceDaemon: false,
  });

  try {
    const owner = new GatewayClient(rt.url, { token: "stdio_owner_tok" });
    const ag = await owner.post("/api/v1/agents", {
      id: "stdio-worker",
      platform: "generic",
      name: "Stdio Worker",
      role: "worker",
    });

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const outLines = [];
    stdout.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) outLines.push(JSON.parse(line));
      }
    });

    const stdioPromise = runMcpStdioCommand(
      ["--hub", rt.url, "--token", ag.token],
      { configDir: dir, stdin, stdout }
    );

    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 101, method: "initialize" }) + "\n");
    stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 102, method: "tools/list" }) + "\n");
    stdin.end();

    await stdioPromise;

    assert.equal(outLines.length, 2, "通知帧不应输出响应，应恰好收到 2 条响应");
    assert.equal(outLines[0].id, 101);
    assert.equal(outLines[0].result.serverInfo.name, "a2a-hub");
    assert.equal(outLines[1].id, 102);
    assert.ok(outLines[1].result.tools.some((t) => t.name === "a2a_poll_inbox"));
  } finally {
    await rt.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Templates Preferred Connect: 仅 Gemini 桌面端默认推荐 MCP，通用、AutoClaw 与云端模板默认优先 HTTP", () => {
  for (const mcpId of ["gemini"]) {
    const tpl = DEFAULT_AGENT_TEMPLATES.find((t) => t.id === mcpId);
    assert.ok(tpl, `模板应包含 ${mcpId}`);
    assert.equal(tpl.preferred_connect, "mcp", `${mcpId} 应默认推荐 mcp`);
    assert.ok(tpl.name.includes("桌面端"), `${mcpId} 应标注为桌面端`);
  }
  for (const httpId of [
    "generic",
    "muse",
    "autoclaw",
    "workbuddy",
    "grok-bot",
    "doubao",
    "lingguang",
    "qwen",
  ]) {
    const tpl = DEFAULT_AGENT_TEMPLATES.find((t) => t.id === httpId);
    assert.ok(tpl, `模板应包含 ${httpId}`);
    assert.equal(tpl.preferred_connect, "http", `${httpId} 应默认推荐 http`);
  }
  for (const removedId of [
    "coze",
    "dify",
    "n8n",
    "feishu-bot",
    "claude-client",
    "cursor-agent",
    "lobechat",
    "openclaw",
    "hermes",
    "kimi-agent",
    "manus",
  ]) {
    assert.equal(DEFAULT_AGENT_TEMPLATES.some((t) => t.id === removedId), false, `不应包含已下线模板 ${removedId}`);
  }

  const bundle = buildAgentMcpOnboarding({
    hubUrl: "http://127.0.0.1:8787",
    agent: { id: "gemini", name: "Gemini", role: "worker", platform: "gemini" },
    token: "ag_secret_123456",
  });
  assert.equal(bundle.preferred_connect, "mcp");
  assert.ok(!bundle.mcp_prompt.includes("ag_secret_123456"));
  assert.ok(!bundle.mcp_prompt.includes("curl "));
  assert.ok(bundle.mcp_prompt.includes("必须建立轮询 / 待命机制"));
  assert.ok(bundle.mcp_prompt.includes("5 分钟"));
  assert.ok(bundle.mcp_prompt.includes("静默结束"));
  assert.ok(bundle.stdio_json.includes("ag_secret_123456"));
  assert.ok(bundle.stdio_json.includes("/opt/homebrew/bin"));
  assert.ok(bundle.npx_json.includes("github:backtomyfuture/a2a-hub"));
  assert.ok(bundle.http_json.includes("serverUrl"));
  assert.ok(bundle.http_json.includes("?token=ag_secret_123456"));

  const autoClawBundle = buildAgentMcpOnboarding({
    hubUrl: "http://127.0.0.1:8787",
    agent: { id: "autoclaw", name: "AutoClaw", role: "leader", platform: "autoclaw" },
    token: "ag_secret_654321",
  });
  assert.equal(autoClawBundle.preferred_connect, "http");
  assert.ok(autoClawBundle.http_json.includes("Bearer ag_secret_654321"));
  assert.ok(autoClawBundle.http_json.includes("?token=ag_secret_654321"));

  // 未知/自定义模板与 webhook 模式均默认回落到 http，且 Leader MCP 提示词包含轮询兜底与脱敏约束
  const customBundle = buildAgentMcpOnboarding({
    hubUrl: "http://127.0.0.1:8787",
    agent: { id: "custom-cloud", name: "Custom Cloud", role: "worker", platform: "unknown-cloud" },
    token: "ag_secret_custom",
  });
  assert.equal(customBundle.preferred_connect, "http");

  const webhookOverride = buildAgentMcpOnboarding({
    hubUrl: "http://127.0.0.1:8787",
    agent: { id: "gemini-wh", name: "Gemini WH", role: "worker", platform: "gemini", transport: "webhook" },
    token: "ag_secret_wh",
  });
  assert.equal(webhookOverride.preferred_connect, "http");

  const leaderMcpPrompt = buildAgentMcpPrompt({
    agent: { id: "muse", name: "Muse", role: "leader", transport: "longpoll", poll_interval_min: 2 },
    template: DEFAULT_AGENT_TEMPLATES.find((t) => t.id === "muse"),
  });
  assert.ok(!leaderMcpPrompt.includes("curl "));
  assert.ok(leaderMcpPrompt.includes("必须建立轮询 / 待命机制"));
  assert.ok(leaderMcpPrompt.includes("a2a_check_updates"));
  assert.ok(leaderMcpPrompt.includes("每 2 分钟"));
  assert.ok(leaderMcpPrompt.includes("静默结束"));
});
