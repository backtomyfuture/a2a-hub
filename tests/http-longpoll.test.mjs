// Hub HTTP Server + HttpBus + LongPollWaker 端到端集成测试。
// 验证：
// 1. 远程节点通过 HTTP 长轮询连接独立 Hub，节点本地无需监听任何端口；
// 2. Bearer API Token 鉴权（/api/v1/health 免鉴权，其余 /api/* 未带正确 token 返回 401）；
// 3. 建单后长轮询毫秒级唤醒远程节点执行，并在 Web 状态面板呈现拓扑；
// 4. auth-required -> Web UI 审批 (POST /api/v1/approvals/:taskId/decide) 生成 hub ed25519 签名决策
//    -> 远程节点按 hubPublicKey 验签通过后放行执行；
// 5. input-required -> Web UI 答复 (POST /api/v1/tasks/:taskId/reply) -> 远程节点续跑并完成。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadOrCreateHubKey } from "../src/approval-sign.mjs";
import { f1 } from "../src/bus/tables.mjs";
import { HttpBus } from "../src/bus/http-bus.mjs";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES } from "../src/bus/tables.mjs";
import { loadConfig, readEnvFile } from "../src/config.mjs";
import { ApprovalService } from "../src/hub/approval.mjs";
import { Kernel } from "../src/kernel.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { LongPollBroker } from "../src/server/longpoll-broker.mjs";
import { runSetup } from "../src/setup.mjs";
import { createLongPollWaker } from "../src/transport/longpoll.mjs";
import { withTemp } from "./helpers.mjs";

async function waitFor(fn, { timeoutMs = 10000, stepMs = 30 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const val = await fn();
    if (val) return val;
    if (Date.now() >= deadline) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

test("端到端：HttpBus + 长轮询毫秒级唤醒 + Web ed25519 审批 + 问答续跑完成", async () => {
  await withTemp(async (rootDir) => {
    const hubDir = path.join(rootDir, "hub");
    const nodeDir = path.join(rootDir, "worker");
    fs.mkdirSync(hubDir, { recursive: true });
    fs.mkdirSync(nodeDir, { recursive: true });

    const apiToken = "test-secret-token";
    const key = loadOrCreateHubKey(hubDir);
    const broker = new LongPollBroker({ initialSeq: 0 });
    const sqliteBus = new SqliteBus({
      dbPath: path.join(hubDir, "hub.db"),
      tables: DEFAULT_TABLES,
      broker,
    });
    const approval = new ApprovalService({
      bus: sqliteBus,
      ownerId: "",
      allowLocalOwner: true,
      statePath: path.join(hubDir, "approval_state.json"),
      signKey: key.privateKey,
      log: () => {},
    });

    const httpHandle = await startHubHttpServer({
      cfg: {
        node: "mac-mini-hub",
        configDir: hubDir,
        listen: "127.0.0.1:0",
        apiToken,
        hubPublicKey: key.publicKey,
      },
      bus: sqliteBus,
      broker,
      approval,
      log: () => {},
      onWake: () => {},
    });

    const workerScriptPath = path.join(nodeDir, "worker.mjs");
    fs.writeFileSync(workerScriptPath, [
      'import fs from "node:fs";',
      'const prompt = process.argv.slice(2).join(" ");',
      'const m = prompt.match(/(\\/[^\\s"\']+input\\.json)/);',
      'const data = m ? JSON.parse(fs.readFileSync(m[1], "utf8")) : {};',
      'const ans = (Array.isArray(data.qa) ? data.qa : []).filter((x) => x.kind === "answer");',
      'if (ans.length > 0) {',
      '  console.log("已收到答复：" + ans[ans.length - 1].text);',
      '} else {',
      '  console.log("请确认\\n```agent-ask\\n请确认发布分支\\n```");',
      '}',
    ].join("\n"));
    fs.writeFileSync(path.join(nodeDir, "commands.json"), JSON.stringify({
      "ask-and-run": {
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(workerScriptPath)} {prompt}`,
        mode: "agent",
        side_effect: "write",
        approval_class: "auto",
        timeout_sec: 15,
      },
    }), { mode: 0o600 });

    const remoteBus = new HttpBus({
      hubUrl: httpHandle.localUrl,
      apiToken,
      node: "worker-1",
      tables: DEFAULT_TABLES,
      delaysMs: [0, 50],
    });

    const remoteKernel = new Kernel({
      node: "worker-1",
      role: "node",
      kind: "host",
      zone: "home",
      capPrefix: "w1",
      events: true,
      longPollSec: 3,
      hubPublicKey: key.publicKey,
      configDir: nodeDir,
      bus: remoteBus,
      log: () => {},
    });

    let wakeCount = 0;
    const waker = createLongPollWaker({
      node: "worker-1",
      role: "node",
      bus: remoteBus,
      longPollSec: 3,
      sweepSec: 60,
      pollSec: 45,
      events: true,
    }, {
      onWake: () => { wakeCount += 1; },
      log: () => {},
    });

    try {
      // 1) /api/v1/health 免鉴权，/api/v1/state 未带 token 返回 401
      const healthResp = await fetch(`${httpHandle.localUrl}/api/v1/health`);
      assert.strictEqual(healthResp.status, 200);
      const unauthResp = await fetch(`${httpHandle.localUrl}/api/v1/state`);
      assert.strictEqual(unauthResp.status, 401);

      // 2) 远程节点启动长轮询 + 注册 AgentCards，并由管理员在管理端接纳
      await remoteKernel.reconcileCards();
      const admitResp = await fetch(`${httpHandle.localUrl}/api/v1/admin/nodes/worker-1/admission`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ admission: "admitted" }),
      });
      assert.strictEqual(admitResp.status, 200);
      waker.start();
      await waitFor(() => broker.connectedNodes().some((n) => n.node === "worker-1" && n.activeWaiters > 0));

      // 3) 通过 Web API 创建一个要求人工审批 (approval="approve") 的任务
      const baseWake = wakeCount;
      const createRes = await fetch(`${httpHandle.localUrl}/api/v1/tasks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: "worker-1",
          cap: "CAP-w1-ask-and-run",
          text: "发布最新版本",
          approval: "approve",
        }),
      });
      assert.strictEqual(createRes.status, 201);
      const { task_id: taskId } = await createRes.json();

      // 长轮询应立刻收到唤醒
      await waitFor(() => wakeCount > baseWake);

      // 4) 远程节点扫表 -> 静态门拦截并置为 auth-required
      await remoteKernel.sweepOnce();
      let tasks = await sqliteBus.listRecords(DEFAULT_TABLES.tasks);
      let task = tasks.find((t) => f1(t, "Task_ID") === taskId);
      assert.strictEqual(f1(task, "Status"), "auth-required");

      // Hub ApprovalService 扫描生成卡片并在本地模式记录状态
      await approval.scan();
      assert.ok(sqliteBus.listCards().length >= 1);

      // 5) 在 Web 控制台执行 ed25519 签名批准
      const decideRes = await fetch(`${httpHandle.localUrl}/api/v1/approvals/${encodeURIComponent(taskId)}/decide`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ decision: "approve" }),
      });
      assert.strictEqual(decideRes.status, 200);

      tasks = await sqliteBus.listRecords(DEFAULT_TABLES.tasks);
      task = tasks.find((t) => f1(t, "Task_ID") === taskId);
      assert.strictEqual(f1(task, "Status"), "submitted");

      // 验证 auth_decision 带有 ed25519 signature，且远程节点验签放行执行（direct 需轮询收口）-> 进入 input-required
      await waitFor(async () => {
        await remoteKernel.sweepOnce();
        const cur = (await sqliteBus.listRecords(DEFAULT_TABLES.tasks)).find((t) => f1(t, "Task_ID") === taskId);
        return f1(cur, "Status") === "input-required";
      });

      // 6) Web 控制台回复 input-required，并触发长轮询唤醒与续跑完成
      const replyWake = wakeCount;
      const replyRes = await fetch(`${httpHandle.localUrl}/api/v1/tasks/${encodeURIComponent(taskId)}/reply`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "main" }),
      });
      assert.strictEqual(replyRes.status, 200);
      await waitFor(() => wakeCount > replyWake);

      await waitFor(async () => {
        await remoteKernel.sweepOnce();
        const cur = (await sqliteBus.listRecords(DEFAULT_TABLES.tasks)).find((t) => f1(t, "Task_ID") === taskId);
        return f1(cur, "Status") === "completed";
      });

      // 7) 验证 Web 总览与单任务详情 API
      const detailResp = await fetch(`${httpHandle.localUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      assert.strictEqual(detailResp.status, 200);
      const detail = await detailResp.json();
      assert.strictEqual(detail.task.status, "completed");
      assert.ok(detail.messages.some((m) => m.kind === "auth_decision"));
      assert.ok(detail.messages.some((m) => m.kind === "answer"));
      assert.ok(detail.messages.some((m) => m.kind === "result"));
      assert.ok(detail.messages.find((m) => m.kind === "result").parts.some((p) => String(p.text).includes("main")));
    } finally {
      await waker.stop();
      broker.close();
      await httpHandle.close();
      sqliteBus.close();
    }
  });
});

test("一键部署：--hub 自动生成 Token、/api/v1/health 暴露公钥、--join 自动抽离凭据并同步 hubPublicKey", async () => {
  await withTemp(async (rootDir) => {
    const appDir = path.resolve(import.meta.dirname, "..");
    const hubDir = path.join(rootDir, "hub");
    const nodeDir = path.join(rootDir, "edge-node");
    const prevExitCode = process.exitCode;
    process.exitCode = 0;

    let sqliteBus;
    let broker;
    let httpHandle;
    try {
      await runSetup(
        hubDir,
        ["--hub", "--listen", "127.0.0.1:18799", "--node", "test-hub", "--yes", "--skip-skill"],
        appDir,
      );
      assert.strictEqual(process.exitCode || 0, 0);

      const hubNodeJson = JSON.parse(fs.readFileSync(path.join(hubDir, "node.json"), "utf8"));
      assert.strictEqual(hubNodeJson.busType, "sqlite");
      assert.strictEqual(hubNodeJson.listen, "127.0.0.1:18799");
      assert.strictEqual(hubNodeJson.role, "hub");

      const keyPath = path.join(hubDir, "approval_key.pem");
      assert.ok(fs.existsSync(keyPath));
      assert.strictEqual(fs.statSync(keyPath).mode & 0o777, 0o600);

      const hubEnvPath = path.join(hubDir, "app.env");
      assert.ok(fs.existsSync(hubEnvPath));
      assert.strictEqual(fs.statSync(hubEnvPath).mode & 0o777, 0o600);
      const hubEnv = readEnvFile(hubEnvPath);
      const apiToken = hubEnv.AH_API_TOKEN || hubEnv.AH_API_TOKEN || "";
      assert.ok(apiToken.length >= 16, "auto-generated apiToken should be non-empty");
      assert.strictEqual(hubEnv.AH_API_TOKEN, apiToken);
      assert.strictEqual(hubEnv.AH_API_TOKEN, apiToken);

      const key = loadOrCreateHubKey(hubDir);
      broker = new LongPollBroker({ initialSeq: 0 });
      sqliteBus = new SqliteBus({
        dbPath: path.join(hubDir, "hub.db"),
        tables: DEFAULT_TABLES,
        broker,
      });
      const approval = new ApprovalService({
        bus: sqliteBus,
        ownerId: "",
        allowLocalOwner: true,
        statePath: path.join(hubDir, "approval_state.json"),
        signKey: key.privateKey,
        log: () => {},
      });

      httpHandle = await startHubHttpServer({
        cfg: {
          node: "test-hub",
          configDir: hubDir,
          listen: "127.0.0.1:0",
          apiToken,
          hubPublicKey: key.publicKey,
        },
        bus: sqliteBus,
        broker,
        approval,
        log: () => {},
        onWake: () => {},
      });

      const healthResp = await fetch(`${httpHandle.localUrl}/api/v1/health`);
      assert.strictEqual(healthResp.status, 200);
      const health = await healthResp.json();
      assert.strictEqual(health.ok, true);
      assert.strictEqual(health.hubPublicKey, key.publicKey);

      const port = new URL(httpHandle.localUrl).port;
      const joinUrl = `http://${encodeURIComponent(apiToken)}@127.0.0.1:${port}`;
      process.exitCode = 0;
      await runSetup(
        nodeDir,
        ["--join", joinUrl, "--node", "edge-auto", "--yes", "--skip-skill"],
        appDir,
      );
      assert.strictEqual(process.exitCode || 0, 0);

      const edgeNodeJson = JSON.parse(fs.readFileSync(path.join(nodeDir, "node.json"), "utf8"));
      assert.strictEqual(edgeNodeJson.busType, "http");
      assert.strictEqual(edgeNodeJson.hubUrl, httpHandle.localUrl);
      assert.ok(!String(edgeNodeJson.hubUrl).includes(apiToken), "node.json must not leak apiToken");
      assert.strictEqual(edgeNodeJson.hubPublicKey, key.publicKey);

      const edgeEnvPath = path.join(nodeDir, "app.env");
      assert.ok(fs.existsSync(edgeEnvPath));
      assert.strictEqual(fs.statSync(edgeEnvPath).mode & 0o777, 0o600);
      const edgeEnv = readEnvFile(edgeEnvPath);
      assert.strictEqual(edgeEnv.AH_API_TOKEN, apiToken);
      assert.strictEqual(edgeEnv.AH_API_TOKEN, apiToken);

      const loadedCfg = loadConfig(nodeDir);
      assert.strictEqual(loadedCfg.apiToken, apiToken);
      assert.strictEqual(loadedCfg.hubPublicKey, key.publicKey);
      assert.strictEqual(loadedCfg.hubUrl, httpHandle.localUrl);
    } finally {
      process.exitCode = prevExitCode;
      if (broker) broker.close();
      if (httpHandle) await httpHandle.close();
      if (sqliteBus) sqliteBus.close();
    }
  });
});
