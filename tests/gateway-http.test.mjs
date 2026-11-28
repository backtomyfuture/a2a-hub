import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import zlib from "node:zlib";

const execFileAsync = promisify(execFile);
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

    // 3) 文件上传、元数据查询、?inline=1 安全预览白名单与中文文件名 RFC5987 头
    const up = await owner.uploadFile({
      buffer: Buffer.from("log content", "utf8"),
      name: "构建日志 build.log",
      mime: "text/plain",
      taskId: dispatched.tasks[0].id,
    });
    assert.ok(up.file.download_path.endsWith(up.file.id));
    assert.ok(up.file.download_url.includes(up.file.id));

    const metaRes = await devClient.get(`/api/v1/files/${up.file.id}/meta`);
    assert.equal(metaRes.file.name, "构建日志 build.log");

    const dl = await devClient.downloadFile(up.file.id);
    assert.equal(dl.toString("utf8"), "log content");

    const inlineTxt = await fetch(`${rt.url}/api/v1/files/${up.file.id}?inline=1`, {
      headers: { Authorization: `Bearer ${devCreated.token}` },
    });
    assert.equal(inlineTxt.status, 200);
    assert.ok(inlineTxt.headers.get("content-disposition").startsWith("inline;"));
    assert.ok(inlineTxt.headers.get("content-disposition").includes("filename*=UTF-8''"));
    assert.equal(inlineTxt.headers.get("content-security-policy"), "default-src 'none'; sandbox");

    // 危险 MIME（HTML / SVG）即使带 ?inline=1 也必须强制 attachment 下载，禁止浏览器内联脚本执行
    const htmlUp = await owner.uploadFile({
      buffer: Buffer.from("<script>alert(1)</script>", "utf8"),
      name: "evil.html",
      mime: "text/html",
      taskId: dispatched.tasks[0].id,
    });
    const inlineHtml = await fetch(`${rt.url}/api/v1/files/${htmlUp.file.id}?inline=1`, {
      headers: { Authorization: `Bearer ${devCreated.token}` },
    });
    assert.equal(inlineHtml.status, 200);
    assert.ok(inlineHtml.headers.get("content-disposition").startsWith("attachment;"));

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

    // 外部旧版 PUT run:true 兼容为一次无副作用成功打卡（不往自身收件箱派发待办任务）
    const trig = await leaderClient.put("/api/v1/agents/muse-cloud/schedules/check-live", {
      name: "实时巡检",
      cron_expr: "*/15 * * * *",
      interval_min: 15,
      summary: "检查节点状态",
      run: true,
    });
    assert.equal(trig.task, null);

    const schRes2 = await owner.get("/api/v1/schedules");
    const liveSch = schRes2.schedules.find((x) => x.id === "check-live");
    assert.equal(liveSch.health, "healthy");
    assert.equal(liveSch.success_rate, 100);
    assert.equal(liveSch.recent_runs.length, 1);
    assert.equal(liveSch.recent_runs[0].state, "completed");
    assert.ok(liveSch.last_context_id);

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

test("HTTP Optimization: /api/v1/state 裁剪大字段、gzip 压缩、AH_NO_DEVICE 禁用空设备与断连轮询跳过查询", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-opt-"));
  // 先模拟旧版云端容器遗留的零 Worker 空壳本机设备配置
  const { HubStore } = await import("../src/store/db.mjs");
  const { runHubSetup } = await import("../src/cli/setup.mjs");
  const silentIo = { log() {}, error() {} };
  await runHubSetup({ configDir: dir, deviceId: "legacy-box", noDevice: true, skipSkill: true, io: silentIo });
  assert.equal(fs.existsSync(path.join(dir, "workers.json")), false, "noDevice 模式不应生成空 workers.json");

  const seedStore = new HubStore(path.join(dir, "hub.db"));
  seedStore.upsertDevice({ id: "legacy-box", name: "legacy-box", summary: "Hub 本机运行设备", issueToken: false });
  seedStore.close();

  const rt = await startHubRuntime({
    configDir: dir,
    listen: "127.0.0.1:0",
    env: { AH_API_TOKEN: "opt_owner_tok", AH_NO_DEVICE: "1" },
  });

  try {
    assert.equal(rt.deviceDaemon, null, "AH_NO_DEVICE=1 应禁用本机 DeviceDaemon");

    const owner = new GatewayClient(rt.url, { token: "opt_owner_tok" });
    const ag = await owner.post("/api/v1/agents", { id: "worker-x", name: "Worker X", summary: "测试" });
    const workerClient = new GatewayClient(rt.url, { token: ag.token });

    const bigPrompt = "P".repeat(2500);
    const bigResult = "R".repeat(3000);
    const disp = await owner.dispatchTask({
      to: "worker-x",
      title: "大回执测试",
      input_text: bigPrompt,
    });
    const tid = disp.tasks[0].id;
    await workerClient.claimTask(tid);
    await workerClient.complete(tid, { summary: "简短摘要", text: bigResult });

    // 1) /api/v1/state 已清理遗留空壳设备，且裁剪 input_text / receipt.text / threads[*].tasks
    const state = await owner.get("/api/v1/state");
    assert.equal(state.devices.some((d) => d.id === "legacy-box"), false, "应自动清理零 Worker 的旧版空壳设备");
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].receipt?.summary, "简短摘要");
    assert.equal("input_text" in state.tasks[0], false, "/api/v1/state 不应返回冗余 input_text");
    assert.equal("text" in (state.tasks[0].receipt || {}), false, "/api/v1/state 不应返回冗余 receipt.text");
    assert.equal("tasks" in state.threads[0], false, "/api/v1/state threads 不应重复嵌套 tasks");

    // 2) 请求带 Accept-Encoding: gzip 且响应 >= 1KB 时返回 gzip 压缩体
    const gzResult = await new Promise((resolve, reject) => {
      const u = new URL(`${rt.url}/api/v1/state`);
      const req = http.get(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          headers: { Authorization: "Bearer opt_owner_tok", "Accept-Encoding": "gzip" },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ headers: res.headers, buf: Buffer.concat(chunks) }));
        }
      );
      req.on("error", reject);
    });
    assert.equal(gzResult.headers["content-encoding"], "gzip");
    const gunzipped = JSON.parse(zlib.gunzipSync(gzResult.buf).toString("utf8"));
    assert.equal(gunzipped.ok, true);
    assert.equal(gunzipped.tasks[0].id, tid);

    // 3) /api/v1/tasks?summary=1 返回摘要，默认 /api/v1/tasks 保持完整兼容性
    const fullTasks = await owner.get("/api/v1/tasks");
    assert.equal(fullTasks.tasks[0].input_text, bigPrompt);
    assert.equal(fullTasks.tasks[0].receipt.text, bigResult);
    const sumTasks = await owner.get("/api/v1/tasks?summary=1");
    assert.equal("input_text" in sumTasks.tasks[0], false);
    assert.equal(sumTasks.tasks[0].receipt.summary, "简短摘要");

    // 4) 客户端主动断开长轮询后，服务端不应继续执行后续 touchAgentSeen / DB 更新
    await workerClient.registerAgent({ id: "worker-x", summary: "测试" });
    const seenBefore = rt.store.getAgent("worker-x").last_seen_at;
    const ac = new AbortController();
    const abortedPoll = fetch(`${rt.url}/api/v1/agents/worker-x/poll?since=${rt.broker.currentSeq()}&timeout=10`, {
      headers: { Authorization: `Bearer ${ag.token}` },
      signal: ac.signal,
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 40));
    // 把 last_seen_at 改回 20s 前，若断连分支仍跑 touchAgentSeen 就会被覆盖刷新
    rt.store.db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(seenBefore - 30_000, "worker-x");
    ac.abort();
    await abortedPoll;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(rt.store.getAgent("worker-x").last_seen_at, seenBefore - 30_000, "断连后不得再执行后续 DB 写入");
  } finally {
    await rt.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Task Exit & Schedule Ack HTTP: 仅机主可消红/重试/删除/定时忽略异常，权限隔离且联动生效", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-exit-"));
  const rt = await startHubRuntime({
    configDir: dir,
    listen: "127.0.0.1:0",
    env: { AH_API_TOKEN: "exit_owner_tok" },
    withDeviceDaemon: false,
  });

  try {
    const owner = new GatewayClient(rt.url, { token: "exit_owner_tok" });
    const ag = await owner.post("/api/v1/agents", { id: "bot-a", name: "Bot A", role: "worker", summary: "执行" });
    const botClient = new GatewayClient(rt.url, { token: ag.token });

    // 1) 创建并失败两条任务
    const d1 = await owner.dispatchTask({ to: "bot-a", title: "测试失败 1", input_text: "run 1", max_retries: 0 });
    const t1 = d1.tasks[0].id;
    await botClient.claimTask(t1);
    await botClient.fail(t1, { error: "bad_key", retryable: false });

    const d2 = await owner.dispatchTask({ to: "bot-a", title: "测试失败 2", input_text: "run 2", max_retries: 0 });
    const t2 = d2.tasks[0].id;
    await botClient.claimTask(t2);
    await botClient.fail(t2, { error: "bad_net", retryable: false });

    // 权限隔离：普通 Agent 不可调用 resolve / resolve-all / retry / delete / schedule ack
    await assert.rejects(() => botClient.resolveTask(t1), /仅机主/);
    await assert.rejects(() => botClient.resolveAllFailed(), /仅机主/);
    await assert.rejects(() => botClient.retryTask(t1), /仅机主/);
    await assert.rejects(() => botClient.deleteTask(t1), /仅机主/);
    await assert.rejects(() => botClient.deleteThread(d1.context_id), /仅机主/);

    // 2) 机主重试 t1：同线程生成新任务且旧 t1 自动消红
    const retried = await owner.retryTask(t1);
    assert.equal(retried.ok, true);
    assert.equal(retried.context_id, d1.context_id);
    assert.equal(retried.task.state, "submitted");
    const t1After = await owner.get(`/api/v1/tasks/${t1}`);
    assert.ok(t1After.task.resolved_at);

    // 含活跃任务的线程不可删除，取消后即可删除整条线程
    await assert.rejects(() => owner.deleteThread(d1.context_id), /未结束/);
    await owner.cancelTask(retried.task.id, "取消");
    const delThreadRes = await owner.deleteThread(d1.context_id);
    assert.equal(delThreadRes.deleted, true);
    assert.equal(delThreadRes.deleted_tasks, 2);

    // 3) 一键清空剩余未处理失败 t2
    const resolveAllRes = await owner.resolveAllFailed();
    assert.equal(resolveAllRes.resolved_count, 1);
    const st = await owner.get("/api/v1/state");
    const t2InState = st.tasks.find((x) => x.id === t2);
    assert.ok(t2InState.resolved_at);

    // 删除单条终态任务
    const delOne = await owner.deleteTask(t2);
    assert.equal(delOne.deleted, true);

    // 4) 定时任务 failing 与 missed 均可通过 /ack 消红
    await botClient.post("/api/v1/schedules/daily-job/runs", {
      name: "每日汇总",
      every: "1d",
      error: "api_500",
    });
    let schList = (await owner.get("/api/v1/schedules")).schedules;
    assert.equal(schList.find((x) => x.id === "daily-job").health, "failing");
    await assert.rejects(() => botClient.ackSchedule("bot-a", "daily-job"), /仅机主/);
    await owner.ackSchedule("bot-a", "daily-job");
    schList = (await owner.get("/api/v1/schedules")).schedules;
    assert.equal(schList.find((x) => x.id === "daily-job").health, "healthy");

    // 超时未报 (missed) 也可通过 /ack 顺延到下一个周期并消红
    await botClient.put("/api/v1/agents/bot-a/schedules/missed-job", {
      name: "超时巡检",
      interval_min: 1,
      last_run_at: Date.now() - 180_000,
    });
    schList = (await owner.get("/api/v1/schedules")).schedules;
    assert.equal(schList.find((x) => x.id === "missed-job").health, "missed");
    await owner.ackSchedule("bot-a", "missed-job");
    schList = (await owner.get("/api/v1/schedules")).schedules;
    const ackedMissed = schList.find((x) => x.id === "missed-job");
    assert.equal(ackedMissed.missed, false);
    assert.equal(ackedMissed.health, "healthy");

    // 5) 中台定时任务处于 failing 且已到期（next_run_at <= now）时，ack 只消红、绝不跳过本轮排期；
    //    且重试该定时任务不篡改 last_run_at / last_tick_at 跑批时钟。
    await owner.put("/api/v1/agents/bot-a/schedules/hub-due", {
      name: "中台到期待跑",
      driver: "hub",
      cron_expr: "0 * * * *",
      summary: "每小时检查",
      task_template: { to: ["bot-a"], title: "每小时检查", input_text: "check" },
    });
    const trigHub = await owner.post("/api/v1/agents/bot-a/schedules/hub-due/trigger", {});
    const hubTaskId = trigHub.task.id;
    await botClient.claimTask(hubTaskId);
    await botClient.fail(hubTaskId, { error: "temp_err", retryable: false });

    const dueAt = Date.now() - 5_000;
    const oldRunAt = Date.now() - 3600_000;
    rt.store.db.prepare(
      "UPDATE schedules SET next_run_at = ?, last_run_at = ?, last_tick_at = ? WHERE agent_id = ? AND id = ?"
    ).run(dueAt, oldRunAt, oldRunAt, "bot-a", "hub-due");

    const ackHubRes = await owner.ackSchedule("bot-a", "hub-due");
    assert.equal(ackHubRes.skipped_window, false, "failing 但未超宽限期的中台定时 ack 不得跳过本轮");
    assert.equal(ackHubRes.schedule.next_run_at, dueAt, "failing 消红不得推进已到期的 next_run_at");

    // 两次 per_run 失败（T1 较旧、T2 较新）：
    // 重试较旧的 T1 并完成它，不得涂绿较新的 T2，也不得改动 last_run_at / last_tick_at / next_run_at；
    // 重试最新的 T2 并完成它，健康状态恢复 completed 但跑批时钟仍保持原排期不变。
    const trigT1 = await owner.post("/api/v1/agents/bot-a/schedules/hub-due/trigger", {});
    const t1Id = trigT1.task.id;
    await botClient.claimTask(t1Id);
    await botClient.fail(t1Id, { error: "t1_err", retryable: false });

    const trigT2 = await owner.post("/api/v1/agents/bot-a/schedules/hub-due/trigger", {});
    const t2Id = trigT2.task.id;
    await botClient.claimTask(t2Id);
    await botClient.fail(t2Id, { error: "t2_err", retryable: false });

    const beforeRetrySch = rt.store.getSchedule("bot-a", "hub-due");
    assert.equal(beforeRetrySch.last_task_id, t2Id);
    assert.equal(beforeRetrySch.last_outcome, "failed");

    await new Promise((r) => setTimeout(r, 15));
    const retryT1 = await owner.retryTask(t1Id);
    await botClient.claimTask(retryT1.task.id);
    await botClient.complete(retryT1.task.id, { summary: "t1 ok", text: "t1 ok" });

    assert.equal(rt.store.getTask(t2Id).resolved_at, null, "重试较旧 T1 并完成后，较新失败 T2 仍须未处理");
    const afterT1RetrySch = rt.store.getSchedule("bot-a", "hub-due");
    assert.equal(afterT1RetrySch.last_task_id, t2Id, "重试较旧 T1 不得覆盖 last_task_id");
    assert.equal(afterT1RetrySch.last_outcome, "failed", "重试较旧 T1 完成不得涂绿更新的失败");
    assert.equal(afterT1RetrySch.last_run_at, beforeRetrySch.last_run_at, "重试较旧 T1 完成不得改动 last_run_at");
    assert.equal(afterT1RetrySch.last_tick_at, beforeRetrySch.last_tick_at, "重试较旧 T1 完成不得改动 last_tick_at");
    assert.equal(afterT1RetrySch.next_run_at, beforeRetrySch.next_run_at, "重试较旧 T1 完成不得改动 next_run_at");
    const schViewAfterT1 = (await owner.get("/api/v1/schedules")).schedules.find((x) => x.id === "hub-due");
    assert.equal(schViewAfterT1.health, "failing");

    // 重试当前头部 T2 并完成：状态恢复健康，但跑批时钟仍保持不变
    await new Promise((r) => setTimeout(r, 15));
    const retryT2 = await owner.retryTask(t2Id);
    await botClient.claimTask(retryT2.task.id);
    await botClient.complete(retryT2.task.id, { summary: "t2 ok", text: "t2 ok" });

    const afterT2RetrySch = rt.store.getSchedule("bot-a", "hub-due");
    assert.equal(afterT2RetrySch.last_task_id, retryT2.task.id);
    assert.equal(afterT2RetrySch.last_outcome, "completed");
    assert.equal(afterT2RetrySch.last_run_at, beforeRetrySch.last_run_at, "重试当前头部 T2 完成也不得改动 last_run_at");
    assert.equal(afterT2RetrySch.last_tick_at, beforeRetrySch.last_tick_at, "重试当前头部 T2 完成也不得改动 last_tick_at");
    assert.equal(afterT2RetrySch.next_run_at, beforeRetrySch.next_run_at, "重试当前头部 T2 完成也不得改动 next_run_at");

    // 6) CLI `ah task retry` 对携带过期附件的失败任务必须显式输出过期附件名称
    const expUp = await owner.uploadFile({
      buffer: Buffer.from("stale data", "utf8"),
      name: "stale-report.txt",
      mime: "text/plain",
    });
    const dCli = await owner.dispatchTask({
      to: "bot-a",
      title: "CLI 重试过期附件提示",
      input_text: "check",
      attachments: [expUp.file.uri],
      max_retries: 0,
    });
    const cliTaskId = dCli.tasks[0].id;
    await botClient.claimTask(cliTaskId);
    await botClient.fail(cliTaskId, { error: "cli_fail", retryable: false });
    rt.store.db.prepare("UPDATE files SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, expUp.file.id);

    const { stdout: cliOut } = await execFileAsync(
      process.execPath,
      [path.resolve("bin", "ah.mjs"), "task", "retry", cliTaskId, "--hub", rt.url, "--token", "exit_owner_tok"],
      { encoding: "utf8" }
    );
    assert.ok(cliOut.includes("已重试任务"), `CLI 应输出重试成功提示: ${cliOut}`);
    assert.ok(cliOut.includes("stale-report.txt") && cliOut.includes("已过期"), `CLI 应明确提示被剔除的过期附件: ${cliOut}`);

    // 7) 中台派发失败（仅写 recent_ticks 无 task 行）也能通过 /ack 完整消红
    rt.store.upsertSchedule({
      id: "hub-tick-fail",
      agent_id: "bot-a",
      name: "派发失败测试",
      driver: "hub",
      cron_expr: "0 * * * *",
      last_tick_at: Date.now() - 1000,
      last_outcome: "failed",
      next_run_at: Date.now() + 3600_000,
      recent_ticks: [{ at: Date.now() - 1000, outcome: "failed", summary: "dispatch_boom" }],
    });
    schList = (await owner.get("/api/v1/schedules")).schedules;
    assert.equal(schList.find((x) => x.id === "hub-tick-fail").health, "failing");
    await owner.ackSchedule("bot-a", "hub-tick-fail");
    schList = (await owner.get("/api/v1/schedules")).schedules;
    assert.equal(schList.find((x) => x.id === "hub-tick-fail").health, "healthy");
  } finally {
    await rt.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
