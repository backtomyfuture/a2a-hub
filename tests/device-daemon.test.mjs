import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeviceDaemon } from "../src/client/device-daemon.mjs";
import { GatewayClient } from "../src/client/gateway-client.mjs";
import { saveWorkersJson } from "../src/core/config.mjs";
import { startHubRuntime } from "../src/core/hub-runtime.mjs";
import { parseCliOutput } from "../src/core/receipt.mjs";

test("Receipt Parser: 解析 Claude JSON、Codex JSONL 与 OpenCode JSON 输出提取 sessionId", () => {
  const claudeOut = JSON.stringify({ result: "修改完成", session_id: "sess_claude_99", usage: { input_tokens: 10 } });
  const c = parseCliOutput(claudeOut);
  assert.equal(c.text, "修改完成");
  assert.equal(c.sessionId, "sess_claude_99");

  const codexJsonl = [
    JSON.stringify({ type: "thread.started", thread_id: "thr_codex_12" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "测试已通过" } }),
  ].join("\n");
  const cx = parseCliOutput(codexJsonl);
  assert.equal(cx.text, "测试已通过");
  assert.equal(cx.sessionId, "thr_codex_12");

  const ocJsonl = [
    JSON.stringify({ type: "step_start", sessionID: "oc_sess_7" }),
    JSON.stringify({ type: "text", sessionID: "oc_sess_7", part: { text: "分析结果如下" } }),
  ].join("\n");
  const oc = parseCliOutput(ocJsonl);
  assert.equal(oc.text, "分析结果如下");
  assert.equal(oc.sessionId, "oc_sess_7");
});

test("DeviceDaemon: 真并发多 Worker 执行、同上下文 Session 续接与 Ed25519 审批验签", async () => {
  const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-dd-hub-"));
  const devDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-dd-dev-"));
  const rt = await startHubRuntime({
    configDir: hubDir,
    listen: "127.0.0.1:0",
    env: { AH_API_TOKEN: "dd_owner_tok" },
    withDeviceDaemon: false,
  });

  try {
    const owner = new GatewayClient(rt.url, { token: "dd_owner_tok" });
    const devReg = await owner.post("/api/v1/devices", { id: "mbp-test", name: "MBP", max_concurrent: 3 });

    saveWorkersJson(devDir, [
      {
        key: "claude",
        name: "Claude",
        summary: "编码",
        command: "mock-claude {prompt}",
        resume_command: "mock-claude --resume {session} {prompt}",
        approval_policy: "never",
      },
      {
        key: "codex",
        name: "Codex",
        summary: "测试",
        command: "mock-codex {prompt}",
        approval_policy: "always",
      },
    ]);

    let activeConcurrent = 0;
    let maxObservedConcurrent = 0;
    const cmdsSeen = [];

    const mockRunner = async (cmd) => {
      cmdsSeen.push(cmd);
      activeConcurrent++;
      maxObservedConcurrent = Math.max(maxObservedConcurrent, activeConcurrent);
      await new Promise((r) => setTimeout(r, 80));
      activeConcurrent--;
      if (cmd.includes("mock-claude")) {
        return { code: 0, stdout: JSON.stringify({ result: "Claude OK", session_id: "cl_sess_1" }), stderr: "" };
      }
      return { code: 0, stdout: "Codex OK", stderr: "" };
    };

    const daemon = new DeviceDaemon({
      configDir: devDir,
      deviceId: "mbp-test",
      hubUrl: rt.url,
      token: devReg.token,
      maxConcurrent: 3,
      hubPublicKey: rt.publicKey,
      runner: mockRunner,
      pollTimeoutSec: 1,
    });
    await daemon.syncNow();

    // 1) 向两个不同线程同时派发给 claude，验证并发执行 (maxObservedConcurrent >= 2)
    const d1 = await owner.dispatchTask({ to: "mbp-test--claude", title: "任务1", input_text: "p1" });
    const d2 = await owner.dispatchTask({ to: "mbp-test--claude", title: "任务2", input_text: "p2" });
    await daemon.runOnce();
    await Promise.all([...daemon._activeTasks.values()]);

    assert.ok(maxObservedConcurrent >= 2, `期望并发度 >= 2，实际 ${maxObservedConcurrent}`);
    const t1Done = (await owner.getTask(d1.tasks[0].id)).task;
    const t2Done = (await owner.getTask(d2.tasks[0].id)).task;
    assert.equal(t1Done.state, "completed");
    assert.equal(t2Done.state, "completed");

    // 2) 同一个 context_id 下再派给 claude，应自动使用 --resume cl_sess_1
    const d3 = await owner.dispatchTask({
      to: "mbp-test--claude",
      title: "续接多轮",
      input_text: "follow up",
      context_id: d1.context_id,
    });
    await daemon.runOnce();
    await Promise.all([...daemon._activeTasks.values()]);
    assert.ok(cmdsSeen.some((c) => c.includes("--resume") && c.includes("cl_sess_1")));
    assert.equal((await owner.getTask(d3.tasks[0].id)).task.state, "completed");

    // 3) approval_policy=always 的 codex 必须先待审批，机主签名后 DeviceDaemon 验签通过才执行
    const dc = await owner.dispatchTask({ to: "mbp-test--codex", title: "签名任务", input_text: "run deploy" });
    assert.equal(dc.tasks[0].state, "auth-required");
    await owner.decideApproval(dc.tasks[0].id, { decision: "approve", note: "go" });

    await daemon.runOnce();
    await Promise.all([...daemon._activeTasks.values()]);
    const codexFinal = (await owner.getTask(dc.tasks[0].id)).task;
    assert.equal(codexFinal.state, "completed");
    assert.equal(codexFinal.receipt.text, "Codex OK");
  } finally {
    await rt.stop();
    fs.rmSync(hubDir, { recursive: true, force: true });
    fs.rmSync(devDir, { recursive: true, force: true });
  }
});
