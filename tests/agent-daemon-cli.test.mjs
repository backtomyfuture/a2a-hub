import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDoctor } from "../src/cli/doctor.mjs";
import { probePublicEndpoint } from "../src/cli/expose.mjs";
import { selectAutostartName, systemdUnitName, unitTextTargetsConfig } from "../src/cli/service.mjs";
import { parseJoinHubUrl, resolveSkillsForHost, runDeviceJoin, runHubSetup } from "../src/cli/setup.mjs";
import { AgentDaemon } from "../src/client/agent-daemon.mjs";
import { GatewayClient } from "../src/client/gateway-client.mjs";
import { parseSimpleFlags } from "../src/client/inbox.mjs";
import { loadWorkersJson } from "../src/core/config.mjs";
import { startHubRuntime } from "../src/core/hub-runtime.mjs";

test("CLI Wrapper & Flags: bin/ah.mjs --version、ah workers add/remove 与布尔参数不吞位置参数", () => {
  const version = execFileSync(process.execPath, [path.resolve("bin/ah.mjs"), "--version"], { encoding: "utf8" }).trim();
  assert.equal(version, "2.0.0");

  const parsed = parseSimpleFlags(["join", "--service", "http://127.0.0.1:8787"]);
  assert.equal(parsed.service, true);
  assert.deepEqual(parsed._, ["join", "http://127.0.0.1:8787"]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-workers-cli-"));
  try {
    execFileSync(
      process.execPath,
      [
        path.resolve("bin/ah.mjs"),
        "workers",
        "add",
        "--config",
        dir,
        "--key",
        "custom-cli",
        "--name",
        "Custom CLI",
        "--command",
        "echo {prompt}",
        "--summary",
        "执行自定义命令",
      ],
      { encoding: "utf8" }
    );
    let workers = loadWorkersJson(dir);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].key, "custom-cli");

    execFileSync(process.execPath, [path.resolve("bin/ah.mjs"), "workers", "remove", "custom-cli", "--config", dir], {
      encoding: "utf8",
    });
    workers = loadWorkersJson(dir);
    assert.equal(workers.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI Setup & Doctor: ah up / ah join 配置生成与只读健康巡检", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-setup-"));
  try {
    const parsed = parseJoinHubUrl("http://tok%2F123@192.168.1.50:8787/");
    assert.equal(parsed.token, "tok/123");
    assert.equal(parsed.baseUrl, "http://192.168.1.50:8787");

    assert.deepEqual(resolveSkillsForHost({ mode: "hub" }), ["ah"]);
    assert.deepEqual(resolveSkillsForHost({ mode: "agent", agentRole: "worker" }), ["ah-inbox"]);
    assert.deepEqual(resolveSkillsForHost({ mode: "agent", agentRole: "leader" }), ["ah-inbox", "ah"]);

    const silentIo = { log() {}, error() {} };
    const hubRes = await runHubSetup({ configDir: dir, skipSkill: true, io: silentIo });
    assert.equal(hubRes.config.mode, "hub");
    assert.ok(hubRes.token.startsWith("ah_owner_"));

    const docCode = await runDoctor({ configDir: dir, io: silentIo });
    assert.equal(docCode, 0);

    const joinDir = path.join(dir, "remote-dev");
    const devRes = await runDeviceJoin({
      configDir: joinDir,
      joinUrl: "http://dev_tok@127.0.0.1:8787",
      deviceId: "edge-1",
      skipSkill: true,
      io: silentIo,
    });
    assert.equal(devRes.config.mode, "device");
    assert.equal(devRes.config.deviceId, "edge-1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Expose & Service Helpers: Cloudflare Bot 拦截探测与跨平台自启命名", async () => {
  const blocked = await probePublicEndpoint("https://hub.example.com", {
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      headers: new Map([["server", "cloudflare"], ["content-type", "text/html"]]),
      text: async () => "<html>Just a moment...</html>",
    }),
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.cfBlocked, true);

  const ok = await probePublicEndpoint("https://hub.example.com", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify({ ok: true, auth_required: true }),
    }),
  });
  assert.equal(ok.ok, true);

  assert.equal(systemdUnitName("hub", "macmini"), "ah-hub-macmini.service");
  assert.equal(selectAutostartName({ role: "node", node: "box1", kind: "systemd" }), "ah-box1.service");
  assert.equal(unitTextTargetsConfig("--config /Users/a/.a2a-hub --role hub", "/Users/a/.a2a-hub"), true);
  assert.equal(unitTextTargetsConfig("--config /Users/a/.a2a-hub-2", "/Users/a/.a2a-hub"), false);
});

test("AgentDaemon: 独立长连接 Agent 认领并执行完成闭环", async () => {
  const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-ag-hub-"));
  const agDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-ag-run-"));
  const rt = await startHubRuntime({
    configDir: hubDir,
    listen: "127.0.0.1:0",
    env: { AH_API_TOKEN: "ag_owner_tok" },
    withDeviceDaemon: false,
  });

  try {
    const owner = new GatewayClient(rt.url, { token: "ag_owner_tok" });
    const created = await owner.post("/api/v1/agents", {
      id: "headless-worker",
      name: "Headless Worker",
      summary: "容器常驻执行器",
    });

    const daemon = new AgentDaemon({
      configDir: agDir,
      agentId: "headless-worker",
      hubUrl: rt.url,
      token: created.token,
      command: "mock-run {prompt}",
      runner: async () => ({ code: 0, stdout: "agent done", stderr: "" }),
      pollTimeoutSec: 1,
    });
    await daemon.registerOnline();

    const disp = await owner.dispatchTask({
      to: "headless-worker",
      title: "独立执行测试",
      input_text: "hello",
    });
    const handled = await daemon.runOnce();
    assert.equal(handled, 1);

    const finalTask = (await owner.getTask(disp.tasks[0].id)).task;
    assert.equal(finalTask.state, "completed");
    assert.equal(finalTask.receipt.text, "agent done");
  } finally {
    await rt.stop();
    fs.rmSync(hubDir, { recursive: true, force: true });
    fs.rmSync(agDir, { recursive: true, force: true });
  }
});
