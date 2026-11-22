import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GatewayClient } from "../src/client/gateway-client.mjs";
import { startHubRuntime } from "../src/core/hub-runtime.mjs";

test("Gateway HTTP: 完整闭环 (Hub 启动 -> 设备同步 -> 独立 Agent 注册 -> 长轮询唤醒 -> 派单回执 -> 文件中转 -> 定时观测)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-gw-"));
  const rt = await startHubRuntime({
    configDir: dir,
    listen: "127.0.0.1:0",
    env: { AH_API_TOKEN: "gw_owner_tok" },
    withDeviceDaemon: false,
  });

  try {
    const owner = new GatewayClient(rt.url, { token: "gw_owner_tok" });
    const h = await owner.health();
    assert.equal(h.ok, true);

    // 1) 创建设备 + 独立 Leader
    const devCreated = await owner.post("/api/v1/devices", { id: "workstation", name: "工作站", max_concurrent: 4 });
    const devClient = new GatewayClient(rt.url, { token: devCreated.token });

    const synced = await devClient.syncDevice("workstation", [
      { key: "claude", name: "Claude CLI", summary: "代码重构", skills: ["coding"] },
    ]);
    assert.equal(synced.agents.length, 1);

    const leaderCreated = await owner.post("/api/v1/agents", {
      id: "muse-cloud",
      platform: "muse",
      name: "Muse",
      role: "leader",
      summary: "云端主调度",
    });
    const leaderClient = new GatewayClient(rt.url, { token: leaderCreated.token });

    // 2) 长轮询挂起期间从 Leader 派单，验证即时唤醒
    const sinceSeq = rt.broker.currentSeq();
    const pollPromise = devClient.pollDevice("workstation", { since: sinceSeq, timeout: 10 });
    await new Promise((r) => setTimeout(r, 60));

    const dispatched = await leaderClient.dispatchTask({
      to: "workstation--claude",
      title: "检查测试覆盖",
      input_text: "run coverage",
    });
    assert.equal(dispatched.tasks.length, 1);

    const pollRes = await pollPromise;
    assert.equal(pollRes.woke, true);
    assert.equal(pollRes.tasks.length, 1);

    // 3) 文件上传与定时自报
    const up = await owner.uploadFile({
      buffer: Buffer.from("log content", "utf8"),
      name: "build.log",
      mime: "text/plain",
      taskId: dispatched.tasks[0].id,
    });
    const dl = await devClient.downloadFile(up.file.id);
    assert.equal(dl.toString("utf8"), "log content");

    const claimed = await devClient.claimTask(dispatched.tasks[0].id);
    assert.equal(claimed.task.state, "working");
    const done = await devClient.complete(dispatched.tasks[0].id, {
      summary: "全部覆盖通过",
      text: "100% pass",
    });
    assert.equal(done.task.state, "completed");

    // 定时自报 missed 检测与丰富执行轨迹聚合
    await leaderClient.put("/api/v1/agents/muse-cloud/schedules/morning", {
      name: "早报巡检",
      cron_expr: "0 9 * * *",
      interval_min: 1,
      last_run_at: Date.now() - 180_000,
    });
    const schRes = await owner.get("/api/v1/schedules");
    assert.equal(schRes.schedules[0].missed, true);
    assert.equal(schRes.schedules[0].health, "missed");

    // 触发运行一条定时任务并验证 recent_runs / success_rate / duration_ms
    const trig = await leaderClient.put("/api/v1/agents/muse-cloud/schedules/check-live", {
      name: "实时巡检",
      cron_expr: "*/15 * * * *",
      interval_min: 15,
      summary: "检查节点状态",
      run: true,
    });
    assert.ok(trig.task.id);
    await leaderClient.claimTask(trig.task.id);
    await leaderClient.complete(trig.task.id, { summary: "全部在线" });

    const schRes2 = await owner.get("/api/v1/schedules");
    const liveSch = schRes2.schedules.find((x) => x.id === "check-live");
    assert.equal(liveSch.health, "healthy");
    assert.equal(liveSch.success_rate, 100);
    assert.equal(liveSch.recent_runs.length, 1);
    assert.equal(liveSch.recent_runs[0].state, "completed");
    assert.ok(liveSch.last_context_id);
    assert.ok(liveSch.last_run.duration_ms >= 0);

    await leaderClient.del("/api/v1/agents/muse-cloud/schedules/check-live");
    const schRes3 = await owner.get("/api/v1/schedules");
    assert.equal(schRes3.schedules.some((x) => x.id === "check-live"), false);

    // 静态目录穿越防护
    const traversal = await fetch(`${rt.url}/../package.json`);
    assert.notEqual(traversal.status, 200);
  } finally {
    await rt.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Device Workers Management: worker-presets、本机 Worker 热增改删落盘与远端生成 CLI 命令", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-workers-"));
  const rt = await startHubRuntime({
    configDir: dir,
    listen: "127.0.0.1:0",
    env: { AH_API_TOKEN: "wk_owner_tok", AH_DEVICE_ID: "" },
    withDeviceDaemon: true,
  });

  try {
    const owner = new GatewayClient(rt.url, { token: "wk_owner_tok" });
    const st0 = await owner.get("/api/v1/state");
    const localDev = st0.devices.find((d) => d.is_local);
    assert.ok(localDev, "本机 Device 应标记 is_local=true");

    const presetsRes = await owner.get("/api/v1/worker-presets");
    assert.ok(Array.isArray(presetsRes.presets) && presetsRes.presets.length >= 26);
    for (const k of ["amp", "droid", "agy", "grok", "cursor", "codebuddy", "copilot", "qwen", "kimi", "kiro", "cline", "kilo"]) {
      assert.ok(presetsRes.presets.some((p) => p.key === k), `presets 应包含 ${k}`);
    }
    const firstUninstalledIdx = presetsRes.presets.findIndex((p) => !p.installed);
    if (firstUninstalledIdx >= 0) {
      assert.equal(
        presetsRes.presets.slice(firstUninstalledIdx).some((p) => p.installed),
        false,
        "已安装的 preset 应排在未安装 preset 之前"
      );
    }

    // 扫描本机与远端设备 Worker
    const scanLocal = await owner.post(`/api/v1/devices/${encodeURIComponent(localDev.id)}/workers/scan`, {});
    assert.equal(scanLocal.ok, true);
    assert.equal(scanLocal.local, true);
    assert.ok(Array.isArray(scanLocal.added));
    assert.ok(Number(scanLocal.total) >= 0);

    // 1) 为本机新增自定义 Worker：立即写入 workers.json 并同步上线
    const addLocal = await owner.post(`/api/v1/devices/${encodeURIComponent(localDev.id)}/workers`, {
      key: "my-script",
      name: "自定义构建脚本",
      command: "echo {prompt}",
      cwd: "/tmp",
      summary: "运行自定义构建",
      skills: "build,test",
    });
    assert.equal(addLocal.local, true);
    const localAgentId = `${localDev.id}--my-script`;
    const workersAfterAdd = JSON.parse(fs.readFileSync(path.join(dir, "workers.json"), "utf8"));
    assert.ok(workersAfterAdd.some((w) => w.key === "my-script" && w.command === "echo {prompt}"));

    // 2) 编辑本机 Worker 应同步回写 workers.json
    await owner.patch(`/api/v1/agents/${encodeURIComponent(localAgentId)}`, {
      summary: "更新后的描述",
      command: "printf %s {prompt}",
      cwd: "/var/tmp",
    });
    const workersAfterPatch = JSON.parse(fs.readFileSync(path.join(dir, "workers.json"), "utf8"));
    const patchedEntry = workersAfterPatch.find((w) => w.key === "my-script");
    assert.equal(patchedEntry.summary, "更新后的描述");
    assert.equal(patchedEntry.command, "printf %s {prompt}");
    assert.equal(patchedEntry.cwd, "/var/tmp");

    // 3) 删除本机 Worker 应从 workers.json 清理
    await owner.del(`/api/v1/agents/${encodeURIComponent(localAgentId)}`);
    const workersAfterDel = JSON.parse(fs.readFileSync(path.join(dir, "workers.json"), "utf8"));
    assert.equal(workersAfterDel.some((w) => w.key === "my-script"), false);

    // 4) 为远端设备添加 Worker：绝不跨网络推命令，而是返回安全的 ah workers add 命令
    await owner.post("/api/v1/devices", { id: "remote-box", name: "Remote Box" });
    const addRemote = await owner.post("/api/v1/devices/remote-box/workers", {
      key: "remote-bash",
      name: "Remote Worker",
      command: "node run.mjs {prompt}",
      cwd: "/opt/work",
    });
    assert.equal(addRemote.local, false);
    assert.ok(addRemote.cli_command.startsWith("ah workers add "));
    assert.ok(addRemote.cli_command.includes("--key 'remote-bash'"));

    const scanRemote = await owner.post("/api/v1/devices/remote-box/workers/scan", {});
    assert.equal(scanRemote.local, false);
    assert.equal(scanRemote.cli_command, "ah workers scan");
  } finally {
    await rt.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
