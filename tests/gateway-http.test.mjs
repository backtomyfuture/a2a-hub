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

    // 定时自报 missed 检测
    await leaderClient.put("/api/v1/agents/muse-cloud/schedules/morning", {
      name: "早报巡检",
      interval_min: 1,
      last_run_at: Date.now() - 180_000,
    });
    const schRes = await owner.get("/api/v1/schedules");
    assert.equal(schRes.schedules[0].missed, true);

    // 静态目录穿越防护
    const traversal = await fetch(`${rt.url}/../package.json`);
    assert.notEqual(traversal.status, 200);
  } finally {
    await rt.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
