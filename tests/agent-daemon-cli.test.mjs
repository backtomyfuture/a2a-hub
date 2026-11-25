import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { runDoctor } from "../src/cli/doctor.mjs";
import { probePublicEndpoint } from "../src/cli/expose.mjs";
import { renderWindowsTaskXml, selectAutostartName, systemdUnitName, unitTextTargetsConfig } from "../src/cli/service.mjs";
import { parseJoinHubUrl, resolveSkillsForHost, runDeviceJoin, runHubSetup } from "../src/cli/setup.mjs";
import { AgentDaemon } from "../src/client/agent-daemon.mjs";
import { GatewayClient } from "../src/client/gateway-client.mjs";
import { parseSimpleFlags } from "../src/client/inbox.mjs";
import { loadConfigJson, loadWorkersJson } from "../src/core/config.mjs";
import { startHubRuntime } from "../src/core/hub-runtime.mjs";

test("CLI Wrapper & Flags: bin/ah.mjs --version、ah workers add/remove 与布尔参数不吞位置参数", () => {
  const version = execFileSync(process.execPath, [path.resolve("bin/ah.mjs"), "--version"], { encoding: "utf8" }).trim();
  assert.equal(version, "2.0.0");

  const parsed = parseSimpleFlags(["join", "--service", "http://127.0.0.1:8787"]);
  assert.equal(parsed.service, true);
  assert.deepEqual(parsed._, ["join", "http://127.0.0.1:8787"]);

  const parsedNoDev = parseSimpleFlags(["up", "--no-device", "--skip-skill"]);
  assert.equal(parsedNoDev["no-device"], true);
  assert.equal(parsedNoDev["skip-skill"], true);

  const multiAttach = parseSimpleFlags(["create", "--attach", "a.txt", "--attach", "b.txt"]);
  assert.deepEqual(multiAttach.attach, ["a.txt", "b.txt"]);

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

    const scanOut = execFileSync(process.execPath, [path.resolve("bin/ah.mjs"), "workers", "scan", "--config", dir], {
      encoding: "utf8",
    });
    assert.equal(fs.existsSync(path.join(dir, "workers.json")), true);
    assert.ok(scanOut.includes("探测到") || scanOut.includes("未在本机"));
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

  const xml = renderWindowsTaskXml({
    starter: "C:\\Users\\a\\.a2a-hub\\service\\ah-node.box1.vbs",
    configDir: "C:\\Users\\a\\.a2a-hub",
    role: "node",
    node: "box1",
    userId: "DOMAIN\\user",
    wscript: "C:\\Windows\\System32\\wscript.exe",
  });
  assert.ok(xml.includes("<Interval>PT1M</Interval>"), "Windows Task Scheduler Interval 必须至少为 1 分钟");
  assert.ok(xml.includes("<Count>3</Count>"), "Windows Task Scheduler Count 必须在 unsignedByte 范围内");
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
      command: "mock-run {prompt_file}",
      runner: async (cmd, stdinText, timeoutSec, cwd, extraEnv) => {
        const pText = fs.readFileSync(path.join(extraEnv.AH_RUN_DIR, "prompt.txt"), "utf8");
        const inJson = JSON.parse(fs.readFileSync(path.join(extraEnv.AH_RUN_DIR, "input.json"), "utf8"));
        assert.ok(pText.includes("你的 Agent ID：headless-worker"));
        assert.equal(inJson.downloaded_files.length, 1);
        assert.equal(fs.readFileSync(inJson.downloaded_files[0].local_path, "utf8"), "MANGO-4729");
        assert.ok(pText.includes("hub-probe.txt"));
        return { code: 0, stdout: "agent done", stderr: "" };
      },
      pollTimeoutSec: 1,
    });
    await daemon.registerOnline();

    const up = await owner.uploadFile({
      buffer: Buffer.from("MANGO-4729", "utf8"),
      name: "hub-probe.txt",
      mime: "text/plain",
    });

    const disp = await owner.dispatchTask({
      to: "headless-worker",
      title: "独立执行测试",
      input_text: "hello",
      attachments: [up.file.uri],
    });
    const handled = await daemon.runOnce();
    assert.equal(handled, 1);

    const finalTask = (await owner.getTask(disp.tasks[0].id)).task;
    assert.equal(finalTask.state, "completed");
    assert.equal(finalTask.receipt.text, "agent done");

    // 验证 ah file upload / download CLI 子命令（必须用异步 execFile，避免阻塞同进程 Hub 的事件循环）
    const srcFile = path.join(agDir, "cli-upload.txt");
    const dlOutFile = path.join(agDir, "cli-download.txt");
    fs.writeFileSync(srcFile, "CLI FILE PAYLOAD", "utf8");
    const { stdout: upOut } = await execFileAsync(
      process.execPath,
      [path.resolve("bin/ah.mjs"), "file", "upload", srcFile, "--hub", rt.url, "--token", "ag_owner_tok"],
      { encoding: "utf8" }
    );
    const upJson = JSON.parse(upOut);
    assert.ok(upJson.file.id);
    await execFileAsync(
      process.execPath,
      [path.resolve("bin/ah.mjs"), "file", "download", upJson.file.uri, "--out", dlOutFile, "--hub", rt.url, "--token", "ag_owner_tok"],
      { encoding: "utf8" }
    );
    assert.equal(fs.readFileSync(dlOutFile, "utf8"), "CLI FILE PAYLOAD");
  } finally {
    await rt.stop();
    fs.rmSync(hubDir, { recursive: true, force: true });
    fs.rmSync(agDir, { recursive: true, force: true });
  }
});

test("Muse VM Keepalive & Inbox Flow: ah join --agent --token-file --no-daemon、无 command 保活不抢单与 ah inbox --pop/done", async () => {
  const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-muse-hub-"));
  const museDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-muse-ag-"));
  const rt = await startHubRuntime({
    configDir: hubDir,
    listen: "127.0.0.1:0",
    env: { AH_API_TOKEN: "muse_owner_tok" },
    withDeviceDaemon: false,
  });

  try {
    const owner = new GatewayClient(rt.url, { token: "muse_owner_tok" });
    const created = await owner.post("/api/v1/agents", {
      id: "muse",
      platform: "muse",
      name: "Muse",
      role: "leader",
      transport: "longpoll",
    });

    const tokenFile = path.join(museDir, "agent.token");
    fs.writeFileSync(tokenFile, created.token, { mode: 0o600 });

    await execFileAsync(
      process.execPath,
      [
        path.resolve("bin/ah.mjs"),
        "join",
        rt.url,
        "--agent",
        "--agent-role",
        "leader",
        "--node",
        "muse",
        "--config",
        museDir,
        "--token-file",
        tokenFile,
        "--no-daemon",
        "--skip-skill",
      ],
      { encoding: "utf8" }
    );

    const museCfg = loadConfigJson(museDir);
    assert.equal(museCfg.mode, "agent");
    assert.equal(museCfg.agentId, "muse");
    assert.equal(museCfg.agentRole, "leader");
    assert.equal(museCfg.tokenFile, fs.realpathSync(tokenFile).includes(museDir) ? fs.realpathSync(tokenFile) : path.resolve(tokenFile));
    assert.equal(fs.existsSync(path.join(museDir, "app.env")), false, "使用 --token-file 时不应额外在 app.env 复制明文 Token");

    // 派发任务给 Muse，验证无 command 的保活守护不会把任务误标为 failed
    const disp = await owner.dispatchTask({
      to: "muse",
      title: "Muse 收件箱任务",
      input_text: "请整理方案并回执",
    });
    const taskId = disp.tasks[0].id;

    const keepaliveDaemon = new AgentDaemon({
      configDir: museDir,
      pollTimeoutSec: 1,
      idleWaitMs: 10,
    });
    assert.equal(keepaliveDaemon.token, created.token);
    const handled = await keepaliveDaemon.runOnce();
    assert.equal(handled, 0);

    const stillSubmitted = (await owner.getTask(taskId)).task;
    assert.equal(stillSubmitted.state, "submitted", "无 command 的收件箱保活守护绝不能把待办认领并标失败");

    // 验证 ah inbox --config <dir> --pop --json 认领任务，空队列静默退出，done 回执完结
    const { stdout: popRaw } = await execFileAsync(
      process.execPath,
      [path.resolve("bin/ah.mjs"), "inbox", "--config", museDir, "--pop", "--json"],
      { encoding: "utf8" }
    );
    const popped = JSON.parse(popRaw.trim());
    assert.equal(popped.id, taskId);
    assert.equal(popped.state, "working");

    const { stdout: emptyPopRaw } = await execFileAsync(
      process.execPath,
      [path.resolve("bin/ah.mjs"), "inbox", "--config", museDir, "--pop", "--json"],
      { encoding: "utf8" }
    );
    assert.equal(emptyPopRaw.trim(), "", "空队列时 --pop 应静默退出");

    await execFileAsync(
      process.execPath,
      [path.resolve("bin/ah.mjs"), "inbox", "--config", museDir, "done", taskId, "--text", "已通过 ah inbox 完成"],
      { encoding: "utf8" }
    );
    const doneTask = (await owner.getTask(taskId)).task;
    assert.equal(doneTask.state, "completed");
    assert.equal(doneTask.receipt.text, "已通过 ah inbox 完成");
  } finally {
    await rt.stop();
    fs.rmSync(hubDir, { recursive: true, force: true });
    fs.rmSync(museDir, { recursive: true, force: true });
  }
});
