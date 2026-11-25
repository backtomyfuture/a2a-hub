import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadOrCreateHubKey } from "../src/core/approval-sign.mjs";
import { LongPollBroker } from "../src/core/broker.mjs";
import { TaskService } from "../src/core/task-service.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { HubStore } from "../src/store/db.mjs";
import { FileStore } from "../src/store/files.mjs";

async function startTestServer(ownerToken = "owner_secret_token") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-auth-"));
  const store = new HubStore(path.join(dir, "hub.db"));
  const fileStore = new FileStore(store, dir);
  const broker = new LongPollBroker(store);
  const { privateKey, publicKey } = loadOrCreateHubKey(dir);
  const taskService = new TaskService(store, { approvalPrivateKey: privateKey });
  store.setChangeHook((ev) => broker.publish(ev));

  const { server } = startHubHttpServer({
    configDir: dir,
    store,
    taskService,
    broker,
    fileStore,
    approvalPublicKey: publicKey,
    approvalPrivateKey: privateKey,
    ownerToken,
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    store,
    taskService,
    async close() {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("Auth: /?token= 兑换 HttpOnly Cookie 并剥离 URL 参数，非授权请求返回 401", async () => {
  const srv = await startTestServer("my_secret_123");
  try {
    const health = await fetch(`${srv.baseUrl}/api/v1/health`);
    assert.equal(health.status, 200);

    const unauth = await fetch(`${srv.baseUrl}/api/v1/state`);
    assert.equal(unauth.status, 401);

    const exchange = await fetch(`${srv.baseUrl}/?token=my_secret_123`, { redirect: "manual" });
    assert.equal(exchange.status, 302);
    assert.equal(exchange.headers.get("location"), "/");
    const cookie = exchange.headers.get("set-cookie");
    assert.ok(cookie.includes("HttpOnly"));
    assert.ok(cookie.includes("SameSite=Lax"));

    const cookiePair = cookie.split(";")[0];
    const authedState = await fetch(`${srv.baseUrl}/api/v1/state`, {
      headers: { Cookie: cookiePair },
    });
    assert.equal(authedState.status, 200);
  } finally {
    await srv.close();
  }
});

test("Auth Matrix: Worker / Leader / Device 权限隔离与防冒充、审批严格归属机主", async () => {
  const srv = await startTestServer("owner_tok");
  try {
    const devA = srv.store.upsertDevice({ id: "dev-a", name: "Dev A", issueToken: true });
    const devB = srv.store.upsertDevice({ id: "dev-b", name: "Dev B", issueToken: true });
    const worker1 = srv.store.createAgent({ id: "worker-1", name: "W1", role: "worker", approval_policy: "always" });
    const worker2 = srv.store.createAgent({ id: "worker-2", name: "W2", role: "worker" });
    const leader1 = srv.store.createAgent({ id: "leader-1", name: "L1", role: "leader" });

    // Worker 不能派单、不能看 Leader updates、不能冒充 register、不能看别的 Worker 邮箱
    const wPostTask = await fetch(`${srv.baseUrl}/api/v1/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${worker1.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: "worker-2", input_text: "hi" }),
    });
    assert.equal(wPostTask.status, 403);

    const wSpoofReg = await fetch(`${srv.baseUrl}/api/v1/agents/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${worker1.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "worker-2" }),
    });
    assert.equal(wSpoofReg.status, 403);

    const wCrossCheck = await fetch(`${srv.baseUrl}/api/v1/agents/worker-2/check`, {
      headers: { Authorization: `Bearer ${worker1.token}` },
    });
    assert.equal(wCrossCheck.status, 403);

    const dCrossSync = await fetch(`${srv.baseUrl}/api/v1/devices/dev-b/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${devA.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ workers: [] }),
    });
    assert.equal(dCrossSync.status, 403);

    // Leader 可以派给 approval_policy=always 的 worker-1，自动进入 auth-required
    const lPost = await fetch(`${srv.baseUrl}/api/v1/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${leader1.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: "worker-1", title: "敏感变更", input_text: "update prod" }),
    });
    assert.equal(lPost.status, 201);
    const created = (await lPost.json()).tasks[0];
    assert.equal(created.state, "auth-required");

    // 即使是 Leader 也绝不能自己批准 auth-required，必须机主 (owner) 批准
    const lApprove = await fetch(`${srv.baseUrl}/api/v1/approvals/${created.id}/decide`, {
      method: "POST",
      headers: { Authorization: "Bearer " + leader1.token, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(lApprove.status, 403);

    const oApprove = await fetch(`${srv.baseUrl}/api/v1/approvals/${created.id}/decide`, {
      method: "POST",
      headers: { Authorization: "Bearer owner_tok", "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(oApprove.status, 200);
    const decided = (await oApprove.json()).task;
    assert.equal(decided.state, "submitted");
  } finally {
    await srv.close();
  }
});

test("File Auth Matrix: 扇出多节点自动授权下载、回执与回复附件互访及越权引用拦截", async () => {
  const srv = await startTestServer("owner_tok");
  try {
    const devA = srv.store.upsertDevice({ id: "dev-a", name: "Dev A", issueToken: true });
    const devB = srv.store.upsertDevice({ id: "dev-b", name: "Dev B", issueToken: true });
    srv.store.syncDeviceWorkers("dev-a", [{ key: "cli", name: "Dev A CLI" }]);
    srv.store.syncDeviceWorkers("dev-b", [{ key: "cli", name: "Dev B CLI" }]);

    const leader = srv.store.createAgent({ id: "muse", name: "Muse", role: "leader" });
    const cloudWorker = srv.store.createAgent({ id: "grok-bot", name: "Grok", role: "worker" });
    const bystander = srv.store.createAgent({ id: "bystander", name: "Other", role: "worker" });
    const badLeader = srv.store.createAgent({ id: "evil-leader", name: "Evil", role: "leader" });

    // 1) Leader 上传文件（task_id=null），随后扇出派给设备节点与云端节点
    const upRes = await fetch(`${srv.baseUrl}/api/v1/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${leader.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "hub-probe.txt", content: "CODE=MANGO-4729", mime: "text/plain" }),
    });
    assert.equal(upRes.status, 201);
    const probeFile = (await upRes.json()).file;
    assert.equal(probeFile.task_id, null);

    // 越权窃取防护：第三方 Leader 不能在派单中引用别人的文件 ID
    const stealResp = await fetch(`${srv.baseUrl}/api/v1/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${badLeader.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        to: ["bystander"],
        title: "越权引用",
        input_text: "read",
        attachments: [{ uri: probeFile.uri }],
      }),
    });
    assert.equal(stealResp.status, 403);

    // 正常扇出派单给 dev-a--cli 与 grok-bot
    const dispResp = await fetch(`${srv.baseUrl}/api/v1/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${leader.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        to: ["dev-a--cli", "grok-bot"],
        title: "扇出读附件",
        input_text: "读取附件并汇报验证码",
        attachments: [{ uri: probeFile.uri }],
      }),
    });
    assert.equal(dispResp.status, 201);
    const dispJson = await dispResp.json();
    assert.equal(dispJson.tasks.length, 2);
    assert.equal(dispJson.tasks[0].attachments[0].size, 15);
    assert.equal(dispJson.tasks[0].attachments[0].download_path, `/api/v1/files/${probeFile.id}`);

    // 2) 设备节点 (dev-a) 与云端节点 (grok-bot) 均可下载原文件及元数据；未参与节点 (dev-b / bystander) 返回 403
    for (const tok of [devA.token, cloudWorker.token, leader.token]) {
      const dl = await fetch(`${srv.baseUrl}/api/v1/files/${probeFile.id}`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      assert.equal(dl.status, 200);
      assert.equal(await dl.text(), "CODE=MANGO-4729");

      const meta = await fetch(`${srv.baseUrl}/api/v1/files/${probeFile.id}/meta`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      assert.equal(meta.status, 200);
    }

    for (const tok of [devB.token, bystander.token, badLeader.token]) {
      const denyDl = await fetch(`${srv.baseUrl}/api/v1/files/${probeFile.id}`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      assert.equal(denyDl.status, 403);

      const denyMeta = await fetch(`${srv.baseUrl}/api/v1/files/${probeFile.id}/meta`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      assert.equal(denyMeta.status, 403);
    }

    // 3) Worker 上传回执文件并在 complete 时附带，Leader 可下载，bystander 仍为 403
    const workerTask = dispJson.tasks.find((t) => t.to_agent_id === "grok-bot");
    await fetch(`${srv.baseUrl}/api/v1/tasks/${workerTask.id}/claim`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cloudWorker.token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    const outUp = await fetch(`${srv.baseUrl}/api/v1/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cloudWorker.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "result.json", content: "{\"code\":\"MANGO-4729\"}", mime: "application/json" }),
    });
    const outFile = (await outUp.json()).file;
    const compResp = await fetch(`${srv.baseUrl}/api/v1/tasks/${workerTask.id}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cloudWorker.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "OK", text: "已读取", attachments: [outFile.uri] }),
    });
    assert.equal(compResp.status, 200);

    const leaderDlOut = await fetch(`${srv.baseUrl}/api/v1/files/${outFile.id}`, {
      headers: { Authorization: `Bearer ${leader.token}` },
    });
    assert.equal(leaderDlOut.status, 200);
    assert.equal(await leaderDlOut.text(), "{\"code\":\"MANGO-4729\"}");

    const bystanderDlOut = await fetch(`${srv.baseUrl}/api/v1/files/${outFile.id}`, {
      headers: { Authorization: `Bearer ${bystander.token}` },
    });
    assert.equal(bystanderDlOut.status, 403);
  } finally {
    await srv.close();
  }
});
