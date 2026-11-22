import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadOrCreateHubKey } from "../src/core/approval-sign.mjs";
import { TaskService } from "../src/core/task-service.mjs";
import { HubStore } from "../src/store/db.mjs";

function makeCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-task-"));
  const store = new HubStore(path.join(dir, "hub.db"));
  const { privateKey, publicKey } = loadOrCreateHubKey(dir);
  const taskService = new TaskService(store, { approvalPrivateKey: privateKey });
  return {
    dir,
    store,
    taskService,
    publicKey,
    cleanup() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("TaskService: 扇出派单、幂等去重、控制字段拒收与 Thread 聚合", () => {
  const ctx = makeCtx();
  try {
    ctx.store.createAgent({ id: "leader-1", name: "Muse", role: "leader", summary: "调度" });
    ctx.store.createAgent({ id: "w1", name: "Worker 1", summary: "代码" });
    ctx.store.createAgent({ id: "w2", name: "Worker 2", summary: "搜索" });

    assert.throws(() => {
      ctx.taskService.dispatchTasks({
        fromNode: "leader-1",
        to: "w1",
        inputText: "恶意覆盖命令",
        params: { command: "rm -rf /" },
      });
    }, /执行控制字段/);

    const r1 = ctx.taskService.dispatchTasks({
      fromNode: "leader-1",
      to: ["w1", "w2"],
      title: "并行分析",
      inputText: "分析仓内代码与最新趋势",
      idempotencyKey: "req-abc-1",
    });
    assert.equal(r1.tasks.length, 2);
    assert.equal(r1.tasks[0].context_id, r1.tasks[1].context_id);

    const r2 = ctx.taskService.dispatchTasks({
      fromNode: "leader-1",
      to: ["w1", "w2"],
      title: "并行分析",
      inputText: "分析仓内代码与最新趋势",
      idempotencyKey: "req-abc-1",
    });
    assert.equal(r2.idempotent, true);
    assert.equal(r2.tasks[0].id, r1.tasks[0].id);

    const thread = ctx.taskService.getThread(r1.context_id);
    assert.equal(thread.tasks.length, 2);
    assert.deepEqual(thread.agents.sort(), ["w1", "w2"]);
  } finally {
    ctx.cleanup();
  }
});

test("TaskService: 八态完整流转 (ask -> reply, auth -> sign approve/deny, fail retry, stale reclaim)", () => {
  const ctx = makeCtx();
  try {
    ctx.store.createAgent({ id: "leader", name: "Muse", role: "leader" });
    ctx.store.createAgent({ id: "worker", name: "Claude", role: "worker", approval_policy: "never" });

    const { tasks } = ctx.taskService.dispatchTasks({
      fromNode: "leader",
      to: "worker",
      title: "修改配置",
      inputText: "执行修改并上线",
    });
    const tId = tasks[0].id;

    // claim -> working -> ask -> input-required -> reply -> submitted
    const claimed = ctx.taskService.claimNext({ agentIds: ["worker"], claimant: "worker" });
    assert.equal(claimed.id, tId);
    assert.equal(claimed.state, "working");

    const asked = ctx.taskService.ask(tId, { actorId: "worker", prompt: "目标环境是 prod 吗？" });
    assert.equal(asked.state, "input-required");

    const replied = ctx.taskService.reply(tId, { fromNode: "owner", body: "是的，staging" });
    assert.equal(replied.state, "submitted");

    // 再次认领 -> requestAuth -> auth-required -> decideApproval approve
    ctx.taskService.claimTaskById(tId, { claimant: "worker" });
    const authed = ctx.taskService.requestAuth(tId, { actorId: "worker", reason: "修改线上表结构" });
    assert.equal(authed.state, "auth-required");

    const approved = ctx.taskService.decideApproval(tId, { decision: "approve", note: "确认放行" });
    assert.equal(approved.state, "submitted");
    const decisionMsg = approved.messages.find((m) => m.kind === "auth_decision");
    assert.ok(decisionMsg.signature, "批准消息必须携带 Ed25519 签名");

    // 重试上限验证 + 完成终态不可取消
    ctx.taskService.claimTaskById(tId, { claimant: "worker" });
    const retried = ctx.taskService.fail(tId, { actorId: "worker", error: "瞬时网络抖动", retryable: true });
    assert.equal(retried.state, "submitted");
    assert.equal(retried.retry_count, 1);

    ctx.taskService.claimTaskById(tId, { claimant: "worker" });
    const done = ctx.taskService.complete(tId, { actorId: "worker", summary: "执行成功", text: "OK" });
    assert.equal(done.state, "completed");
    assert.throws(() => ctx.taskService.cancel(tId), /终态任务/);

    // Leader 增量水位验证
    const upd1 = ctx.taskService.getLeaderUpdates("leader", { advance: false });
    assert.equal(upd1.updates.length, 1);
    assert.equal(upd1.watermark, 0);

    const upd2 = ctx.taskService.getLeaderUpdates("leader", { advance: true });
    assert.equal(upd2.updates.length, 1);
    assert.ok(upd2.watermark > 0);

    const upd3 = ctx.taskService.getLeaderUpdates("leader", { advance: true });
    assert.equal(upd3.updates.length, 0);

    // 租约过期回收验证
    const { tasks: staleTasks } = ctx.taskService.dispatchTasks({
      fromNode: "leader",
      to: "worker",
      title: "测试超时",
      inputText: "hang",
      maxRetries: 0,
    });
    const staleId = staleTasks[0].id;
    ctx.taskService.claimTaskById(staleId, { claimant: "worker", leaseSec: 30 });
    const reclaimed = ctx.taskService.reclaimStale(Date.now() + 120_000);
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0].state, "failed");
    assert.equal(reclaimed[0].error_message, "task_lease_expired");
  } finally {
    ctx.cleanup();
  }
});
