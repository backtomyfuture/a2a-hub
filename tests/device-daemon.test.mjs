import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeviceDaemon } from "../src/client/device-daemon.mjs";
import { GatewayClient } from "../src/client/gateway-client.mjs";
import {
  KNOWN_CLIS,
  discoverLocalWorkers,
  mergeDiscoveredWorkers,
  resolveSpecBinary,
  saveWorkersJson,
  whichBinary,
} from "../src/core/config.mjs";
import { startHubRuntime } from "../src/core/hub-runtime.mjs";
import { formatCliFailure, parseCliOutput, renderWorkerCommand } from "../src/core/receipt.mjs";

test("Receipt Parser: 解析单对象 JSON、Amp/Claude stream-json、Cline 与 Pi 输出并提取 sessionId", () => {
  const claudeOut = JSON.stringify({ result: "修改完成", session_id: "sess_claude_99", usage: { input_tokens: 10 } });
  const c = parseCliOutput(claudeOut);
  assert.equal(c.text, "修改完成");
  assert.equal(c.sessionId, "sess_claude_99");

  const agyOut = JSON.stringify({ response: "调研结论如下", conversation_id: "conv_agy_42" });
  const agy = parseCliOutput(agyOut);
  assert.equal(agy.text, "调研结论如下");
  assert.equal(agy.sessionId, "conv_agy_42");

  const cursorOut = JSON.stringify({ output: "补丁已应用", chat_id: "chat_cursor_7" });
  const cur = parseCliOutput(cursorOut);
  assert.equal(cur.text, "补丁已应用");
  assert.equal(cur.sessionId, "chat_cursor_7");

  const ampStream = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "T-amp-123" }),
    JSON.stringify({
      type: "assistant",
      session_id: "T-amp-123",
      message: { role: "assistant", content: [{ type: "text", text: "过程分片不应重复出现" }] },
    }),
    JSON.stringify({ type: "result", subtype: "success", session_id: "T-amp-123", result: "最终唯一结论" }),
  ].join("\n");
  const amp = parseCliOutput(ampStream);
  assert.equal(amp.text, "最终唯一结论");
  assert.equal(amp.sessionId, "T-amp-123");

  const clineOut = [
    JSON.stringify({ type: "agent_event", session_id: "cline_sess_5", text: "step 1" }),
    JSON.stringify({ type: "run_result", session_id: "cline_sess_5", text: "Cline 终态结果" }),
  ].join("\n");
  const cl = parseCliOutput(clineOut);
  assert.equal(cl.text, "Cline 终态结果");
  assert.equal(cl.sessionId, "cline_sess_5");

  const piOut = [
    JSON.stringify({ type: "session", id: "pi_sess_88" }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Pi 分析完成" }] } }),
  ].join("\n");
  const pi = parseCliOutput(piOut);
  assert.equal(pi.text, "Pi 分析完成");
  assert.equal(pi.sessionId, "pi_sess_88");

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

  // Droid 实测失败：stderr 为 Ignored hook 警告，stdout JSON 包含真正的 402 错误
  const droidErrOut = JSON.stringify({
    type: "result",
    subtype: "failure",
    is_error: true,
    result: "402 You've reached your weekly Droid Core usage limit",
    session_id: "ba361f7c",
  });
  const droidStderr = "Ignored hook settings entry: /Users/jarod/.factory/settings.json: hooks.PermissionRequest";
  const dr = parseCliOutput(droidErrOut, droidStderr);
  assert.equal(dr.isError, true);
  assert.equal(dr.sessionId, "ba361f7c");
  const droidFailure = formatCliFailure(dr, droidStderr, 1);
  assert.ok(droidFailure.includes("402"), "错误摘要应保留 stdout 中的 402 原因");
  assert.equal(droidFailure.includes("Ignored hook"), false, "不得让无关 stderr 警告掩盖结构化错误");

  // Amp 实测欠费：退出码 0，result 事件无 result 字段，原因在 error 字段
  const ampErrStream = [
    JSON.stringify({ type: "system", subtype: "init", cwd: "/tmp", session_id: "T-amp-err", tools: ["shell_command"] }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "只回复 OK" }] }, session_id: "T-amp-err" }),
    JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 0,
      error: "Out of Credits You must have at least $1 in available credits to start this request.",
      session_id: "T-amp-err",
    }),
  ].join("\n");
  const ampWarn = "Warning: Permission rules (amp.permissions) are deprecated";
  const ampErr = parseCliOutput(ampErrStream, ampWarn);
  assert.equal(ampErr.isError, true);
  const ampFailure = formatCliFailure(ampErr, ampWarn, 0);
  assert.ok(ampFailure.startsWith("Out of Credits"), `应提取 Amp 的 error 字段，实际: ${ampFailure.slice(0, 80)}`);
  assert.equal(ampFailure.includes("\"type\":\"system\""), false, "不得把原始 JSONL 当作错误摘要");

  // CodeBuddy 实测顶层 JSON 数组：忽略 user <system-reminder>，取最终 result 与 session_id
  const cbArray = JSON.stringify([
    {
      type: "message",
      role: "user",
      sessionId: "cb_sess_1",
      content: [{ type: "input_text", text: "<system-reminder>internal prompt</system-reminder>" }],
    },
    {
      type: "message",
      role: "assistant",
      sessionId: "cb_sess_1",
      content: [{ type: "output_text", text: "OK" }],
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "OK",
      session_id: "cb_sess_1",
    },
  ]);
  const cb = parseCliOutput(cbArray);
  assert.equal(cb.text, "OK");
  assert.equal(cb.sessionId, "cb_sess_1");
  assert.equal(cb.isError, false);
  assert.equal(cb.text.includes("<system-reminder>"), false);
});

test("CLI Auto-Discovery: >=26 种 CLI 唯一性、坏软链跳过、多别名探测与无损增量合并", () => {
  assert.ok(KNOWN_CLIS.length >= 26, `预期 KNOWN_CLIS >= 26，实际 ${KNOWN_CLIS.length}`);
  const keys = KNOWN_CLIS.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, "KNOWN_CLIS 中不得存在重复 key");
  for (const required of ["claude", "codex", "opencode", "amp", "droid", "agy", "grok", "cursor", "codebuddy", "kimi", "qwen", "copilot", "cline", "kilo"]) {
    assert.ok(keys.includes(required), `KNOWN_CLIS 缺少 ${required}`);
  }
  const kimiSpec = KNOWN_CLIS.find((s) => s.key === "kimi");
  assert.equal(kimiSpec.command.includes("--yolo"), false, "Kimi -p 模式不得拼接冲突的 --yolo 参数");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-which-"));
  const binDir = path.join(tmpDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  try {
    const mockExe = path.join(binDir, "cbc");
    fs.writeFileSync(mockExe, "#!/bin/sh\necho ok\n", { mode: 0o755 });
    const danglingLink = path.join(binDir, "dangling-cli-tool");
    fs.symlinkSync(path.join(tmpDir, "nonexistent-target"), danglingLink);

    assert.equal(whichBinary("cbc", { env: { PATH: binDir }, homeDir: tmpDir }), mockExe);
    assert.equal(whichBinary("dangling-cli-tool", { env: { PATH: binDir }, homeDir: tmpDir }), null, "悬空坏软链不得判定为已安装");

    const codebuddySpec = KNOWN_CLIS.find((s) => s.key === "codebuddy");
    assert.equal(
      resolveSpecBinary(codebuddySpec, (name) => whichBinary(name, { env: { PATH: binDir }, homeDir: tmpDir })),
      mockExe,
      "应能通过别名 cbc 发现 codebuddy"
    );

    const discovered = discoverLocalWorkers({
      whichFn: (bin) =>
        bin === "amp" || bin === "kimi" || bin === "agy" || bin === "devin" ? `/mock/${bin}` : null,
      homeDir: tmpDir,
      defaultCwd: "/work",
    });
    assert.deepEqual(discovered.map((w) => w.key), ["amp", "agy", "kimi", "devin"]);
    const ampWorker = discovered.find((w) => w.key === "amp");
    const agyWorker = discovered.find((w) => w.key === "agy");
    const kimiWorker = discovered.find((w) => w.key === "kimi");
    const devinWorker = discovered.find((w) => w.key === "devin");

    const ampCmd = renderWorkerCommand({ worker: ampWorker, prompt: "fix tests" });
    assert.ok(ampCmd.includes("--dangerously-allow-all") && ampCmd.includes("--stream-json"));
    const kimiCmd = renderWorkerCommand({ worker: kimiWorker, prompt: "review" });
    assert.equal(kimiCmd.includes("--yolo"), false);

    // agy / devin 的 -p 须紧邻 prompt 且置于 --output-format / --permission-mode 等选项之后
    const agyCmd = renderWorkerCommand({ worker: agyWorker, prompt: "hello" });
    assert.ok(agyCmd.includes("--output-format json"));
    assert.ok(agyCmd.endsWith("-p 'hello'"), `agy 命令应以 -p 'hello' 结尾，实际: ${agyCmd}`);
    assert.ok(agyCmd.indexOf("--output-format json") < agyCmd.indexOf("-p 'hello'"));

    const agyResumeCmd = renderWorkerCommand({ worker: agyWorker, prompt: "hello", sessionId: "conv_1" });
    assert.ok(agyResumeCmd.includes("--conversation 'conv_1'"));
    assert.ok(agyResumeCmd.endsWith("-p 'hello'"), `agy 续接命令应以 -p 'hello' 结尾，实际: ${agyResumeCmd}`);

    const devinCmd = renderWorkerCommand({ worker: devinWorker, prompt: "hello" });
    assert.ok(devinCmd.includes("--permission-mode dangerous"));
    assert.ok(devinCmd.endsWith("-p 'hello'"), `devin 命令应以 -p 'hello' 结尾，实际: ${devinCmd}`);

    // 增量合并默认保留用户既有配置与自定义 key，仅追加新发现项
    const existing = [
      { key: "amp", name: "My Custom Amp", command: "amp -x {prompt}", cwd: "/custom" },
      { key: "my-script", name: "Script", command: "echo {prompt}", cwd: "/scripts" },
    ];
    const m1 = mergeDiscoveredWorkers(existing, discovered, { force: false });
    assert.deepEqual(m1.added.map((w) => w.key), ["agy", "kimi", "devin"]);
    assert.equal(m1.updated.length, 0);
    assert.equal(m1.workers.find((w) => w.key === "amp").cwd, "/custom");
    assert.ok(m1.workers.some((w) => w.key === "my-script"));

    // force: true 覆盖同名内置 CLI 但依然保留用户自定义 key
    const m2 = mergeDiscoveredWorkers(existing, discovered, { force: true });
    assert.deepEqual(m2.updated.map((w) => w.key), ["amp"]);
    assert.deepEqual(m2.added.map((w) => w.key), ["agy", "kimi", "devin"]);
    assert.equal(m2.workers.find((w) => w.key === "amp").cwd, "/work");
    assert.ok(m2.workers.some((w) => w.key === "my-script"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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
      {
        key: "droid",
        name: "Droid",
        summary: "故障透传测试",
        command: "mock-droid {prompt}",
        approval_policy: "never",
      },
    ]);

    let activeConcurrent = 0;
    let maxObservedConcurrent = 0;
    const cmdsSeen = [];
    const stdinSeen = [];

    const mockRunner = async (cmd, stdinText) => {
      cmdsSeen.push(cmd);
      stdinSeen.push(stdinText);
      activeConcurrent++;
      maxObservedConcurrent = Math.max(maxObservedConcurrent, activeConcurrent);
      await new Promise((r) => setTimeout(r, 80));
      activeConcurrent--;
      if (cmd.includes("mock-claude")) {
        return { code: 0, stdout: JSON.stringify({ result: "Claude OK", session_id: "cl_sess_1" }), stderr: "" };
      }
      if (cmd.includes("mock-droid")) {
        return {
          code: 1,
          stdout: JSON.stringify({
            type: "result",
            subtype: "failure",
            is_error: true,
            result: "402 usage limit reached",
            session_id: "dr_1",
          }),
          stderr: "Ignored hook settings entry: hooks.PermissionRequest",
        };
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
    assert.ok(stdinSeen.every((s) => s === null), "命令已含 {prompt} 占位符时不应重复写入 stdin");

    // 4) 失败结构化 JSON + 无害 stderr 警告时，任务错误摘要保留真实 JSON 报错而非被 stderr 覆盖
    const df = await owner.dispatchTask({ to: "mbp-test--droid", title: "额度测试", input_text: "hello" });
    await daemon.runOnce();
    await Promise.all([...daemon._activeTasks.values()]);
    const droidFinal = (await owner.getTask(df.tasks[0].id)).task;
    assert.equal(droidFinal.state, "failed");
    assert.ok(droidFinal.error_message.includes("402 usage limit reached"));
    assert.equal(droidFinal.error_message.includes("Ignored hook"), false);
  } finally {
    await rt.stop();
    fs.rmSync(hubDir, { recursive: true, force: true });
    fs.rmSync(devDir, { recursive: true, force: true });
  }
});

test("DeviceDaemon: 空轮询与短队列不发起多余 POST /api/v1/tasks/claim", async () => {
  const devDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-dd-empty-"));
  try {
    saveWorkersJson(devDir, [
      { key: "claude", name: "Claude", command: "mock-claude {prompt}" },
    ]);

    let claimNextCalls = 0;
    let claimTaskCalls = 0;
    let nextTasks = [];
    const mockClient = {
      async syncDevice() {
        return { ok: true };
      },
      async pollDevice() {
        return { ok: true, seq: 10, woke: nextTasks.length > 0, tasks: nextTasks };
      },
      async claimTask(id) {
        claimTaskCalls += 1;
        return { task: { id, to_agent_id: "box--claude", context_id: "c1", title: "t", input_text: "p" } };
      },
      async claimNext() {
        claimNextCalls += 1;
        return { task: null };
      },
      async complete() {
        return { ok: true };
      },
      async fail() {
        return { ok: true };
      },
    };

    const daemon = new DeviceDaemon({
      configDir: devDir,
      deviceId: "box",
      hubUrl: "http://127.0.0.1:8787",
      token: "tok",
      client: mockClient,
      maxConcurrent: 4,
      runner: async () => ({ code: 0, stdout: "ok", stderr: "" }),
      pollTimeoutSec: 1,
    });

    // 1) 首次同步后空轮询：不得调用 claimTask 或 claimNext
    nextTasks = [];
    const startedEmpty = await daemon.runOnce();
    assert.equal(startedEmpty, 0);
    assert.equal(claimTaskCalls, 0);
    assert.equal(claimNextCalls, 0);

    // 2) 返回 1 条候选任务时，仅精确认领这 1 条，不得在末尾再发多余 claimNext
    nextTasks = [{ id: "tsk_one" }];
    const startedOne = await daemon.runOnce();
    await Promise.all([...daemon._activeTasks.values()]);
    assert.equal(startedOne, 1);
    assert.equal(claimTaskCalls, 1);
    assert.equal(claimNextCalls, 0);

    // 3) 无已启用 Worker 时即使传入候选也不认领
    daemon.workers = [];
    assert.equal(await daemon.drainPendingTasks([{ id: "tsk_ignored" }]), 0);
    assert.equal(claimTaskCalls, 1);
    assert.equal(claimNextCalls, 0);
  } finally {
    fs.rmSync(devDir, { recursive: true, force: true });
  }
});

test("DeviceDaemon: 扇出附件下载与 Prompt 显式注入、下载失败报错记录及节点身份防串名", async () => {
  const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-dd-att-hub-"));
  const devDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-dd-att-dev-"));
  const rt = await startHubRuntime({
    configDir: hubDir,
    listen: "127.0.0.1:0",
    env: { AH_API_TOKEN: "dd_att_owner" },
    withDeviceDaemon: false,
  });

  try {
    const owner = new GatewayClient(rt.url, { token: "dd_att_owner" });
    const leader = await owner.post("/api/v1/agents", {
      id: "muse",
      platform: "muse",
      name: "Muse",
      role: "leader",
    });
    const leaderClient = new GatewayClient(rt.url, { token: leader.token });
    const devReg = await owner.post("/api/v1/devices", { id: "mac-mini", name: "Mac mini", max_concurrent: 4 });

    saveWorkersJson(devDir, [
      { key: "droid", name: "Droid", command: "mock-droid {prompt_file}" },
      { key: "agy", name: "Agy", command: "mock-agy {prompt_file}" },
    ]);

    const seenRuns = new Map();
    const daemon = new DeviceDaemon({
      configDir: devDir,
      deviceId: "mac-mini",
      hubUrl: rt.url,
      token: devReg.token,
      maxConcurrent: 4,
      hubPublicKey: rt.publicKey,
      pollTimeoutSec: 1,
      runner: async (cmd, stdinText, timeoutSec, cwd, extraEnv) => {
        const taskId = extraEnv.AH_TASK_ID;
        const promptFile = path.join(extraEnv.AH_RUN_DIR, "prompt.txt");
        const inputFile = path.join(extraEnv.AH_RUN_DIR, "input.json");
        seenRuns.set(taskId, {
          cmd,
          extraEnv,
          promptText: fs.readFileSync(promptFile, "utf8"),
          inputJson: JSON.parse(fs.readFileSync(inputFile, "utf8")),
        });
        return { code: 0, stdout: JSON.stringify({ result: `done:${extraEnv.AH_AGENT_ID}` }), stderr: "" };
      },
    });
    await daemon.syncNow();

    // 1) Leader 以无 task_id 上传文件，然后扇出派给同一个设备上的 droid 与 agy
    const probeContent = "MANGO-4729 verification payload for fan-out probe";
    const up = await leaderClient.uploadFile({
      buffer: Buffer.from(probeContent, "utf8"),
      name: "hub-probe-20261125.txt",
      mime: "text/plain",
      taskId: null,
    });

    const fanout = await leaderClient.dispatchTask({
      to: ["mac-mini--droid", "mac-mini--agy"],
      title: "可用性与附件检查",
      input_text: "请读取附件验证码并自报节点名",
      attachments: [up.file.uri],
    });
    assert.equal(fanout.tasks.length, 2);

    await daemon.runOnce();
    await Promise.all([...daemon._activeTasks.values()]);

    for (const t of fanout.tasks) {
      const done = (await owner.getTask(t.id)).task;
      assert.equal(done.state, "completed");
      const runInfo = seenRuns.get(t.id);
      assert.ok(runInfo, `应执行任务 ${t.id}`);
      assert.equal(runInfo.extraEnv.AH_AGENT_ID, t.to_agent_id);
      assert.equal(runInfo.extraEnv.AH_DEVICE_ID, "mac-mini");

      // 身份显式注入，且不包含仍在 working 的兄弟空壳任务
      assert.ok(runInfo.promptText.includes(`你的 Agent ID：${t.to_agent_id}`));
      const otherAgent = t.to_agent_id === "mac-mini--droid" ? "mac-mini--agy" : "mac-mini--droid";
      assert.equal(runInfo.promptText.includes(otherAgent), false, "同轮空壳兄弟任务不得写入另一节点的 prompt.txt");

      // 附件已落盘并显式写入 prompt.txt 与 input.json
      assert.equal(runInfo.inputJson.downloaded_files.length, 1);
      assert.equal(runInfo.inputJson.failed_downloads.length, 0);
      const localPath = runInfo.inputJson.downloaded_files[0].local_path;
      assert.equal(fs.readFileSync(localPath, "utf8"), probeContent);
      assert.ok(runInfo.promptText.includes("### 任务附件"));
      assert.ok(runInfo.promptText.includes("hub-probe-20261125.txt"));
      assert.ok(runInfo.promptText.includes(localPath));
    }

    // 2) 当下载失败时，不得静默吞异常：必须在 input.json.failed_downloads 与 prompt.txt 中显式记录
    const origDownload = daemon.client.downloadFile.bind(daemon.client);
    daemon.client.downloadFile = async () => {
      throw new Error("HTTP 403 forbidden");
    };
    const failCase = await leaderClient.dispatchTask({
      to: ["mac-mini--droid"],
      title: "模拟下载失败",
      input_text: "检查下载异常提示",
      attachments: [up.file.uri],
    });
    await daemon.runOnce();
    await Promise.all([...daemon._activeTasks.values()]);
    daemon.client.downloadFile = origDownload;

    const failRun = seenRuns.get(failCase.tasks[0].id);
    assert.equal(failRun.inputJson.downloaded_files.length, 0);
    assert.equal(failRun.inputJson.failed_downloads.length, 1);
    assert.ok(failRun.inputJson.failed_downloads[0].error.includes("403"));
    assert.ok(failRun.promptText.includes("[下载失败]"));
    assert.ok(failRun.promptText.includes("403"));
  } finally {
    await rt.stop();
    fs.rmSync(hubDir, { recursive: true, force: true });
    fs.rmSync(devDir, { recursive: true, force: true });
  }
});

test("DeviceDaemon: stop() 立即中止挂起长轮询与在途长任务宽限兜底，不卡死系统关机", async () => {
  const devDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-dev-stop-"));
  try {
    let pollAborted = false;
    const mockClient = {
      async syncDevice() {
        return { ok: true };
      },
      async pollDevice(_devId, { signal } = {}) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              pollAborted = true;
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            },
            { once: true }
          );
        });
      },
    };

    const daemon = new DeviceDaemon({
      configDir: devDir,
      deviceId: "win-stop-test",
      hubUrl: "http://127.0.0.1:8787",
      client: mockClient,
      pollTimeoutSec: 35,
      logger: { log() {}, warn() {}, error() {} },
    });

    const loopPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 40));

    const t0 = Date.now();
    await daemon.stop({ graceMs: 300 });
    await loopPromise;
    const elapsed = Date.now() - t0;

    assert.equal(pollAborted, true, "stop() 必须通过 AbortSignal 立即中止 35s 长轮询");
    assert.ok(elapsed < 1000, `stop() 应在 1s 内收口，实测 ${elapsed}ms`);
  } finally {
    fs.rmSync(devDir, { recursive: true, force: true });
  }
});
