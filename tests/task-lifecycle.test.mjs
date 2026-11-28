import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadOrCreateHubKey } from "../src/core/approval-sign.mjs";
import { TaskService } from "../src/core/task-service.mjs";
import { HubStore } from "../src/store/db.mjs";
import { FileStore } from "../src/store/files.mjs";

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

    const threadSummaries = ctx.taskService.listThreads({ includeTasks: false });
    assert.equal(threadSummaries.length, 1);
    assert.equal(threadSummaries[0].task_count, 2);
    assert.equal("tasks" in threadSummaries[0], false, "includeTasks=false 不应内嵌冗余完整任务数组");

    // 空队列调用 claimNext 不应开启写事务或自增 seq
    const seqBeforeClaim = ctx.store.currentSeq();
    let txCalls = 0;
    const origTx = ctx.store.transaction.bind(ctx.store);
    ctx.store.transaction = (fn) => {
      txCalls += 1;
      return origTx(fn);
    };
    assert.equal(ctx.taskService.claimNext({ agentIds: ["leader-1"] }), null);
    assert.equal(txCalls, 0, "空队列 claimNext 不应进入 BEGIN IMMEDIATE 写事务");
    assert.equal(ctx.store.currentSeq(), seqBeforeClaim);

    // 并发扇出同在 working 状态但尚无产出时，buildContextHistory 不得注入空壳兄弟任务
    ctx.taskService.claimTaskById(r1.tasks[0].id, { claimant: "w1" });
    ctx.taskService.claimTaskById(r1.tasks[1].id, { claimant: "w2" });
    assert.deepEqual(ctx.taskService.buildContextHistory(r1.context_id, r1.tasks[0].id), []);
    assert.deepEqual(ctx.taskService.buildContextHistory(r1.context_id, r1.tasks[1].id), []);

    // 若其中一方已完成并有回执，才会进入续接上下文
    ctx.taskService.complete(r1.tasks[0].id, { actorId: "w1", summary: "w1 完成", text: "w1 result" });
    const histForW2 = ctx.taskService.buildContextHistory(r1.context_id, r1.tasks[1].id);
    assert.equal(histForW2.length, 1);
    assert.equal(histForW2[0].to_agent_id, "w1");
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

    // 长租约任务：即使超过 STALE_MIN(20 分钟) 未更新，只要租约未到期就不应被回收（租约上限 1 小时，这里取 50 分钟）
    const { tasks: longTasks } = ctx.taskService.dispatchTasks({
      fromNode: "leader",
      to: "worker",
      title: "长租约",
      inputText: "slow",
      maxRetries: 0,
    });
    ctx.taskService.claimTaskById(longTasks[0].id, { claimant: "worker", leaseSec: 50 * 60 });
    const keep = ctx.taskService.reclaimStale(Date.now() + 40 * 60_000);
    assert.equal(keep.length, 0);
    const expired = ctx.taskService.reclaimStale(Date.now() + 2 * 3600_000);
    assert.equal(expired.length, 1);
  } finally {
    ctx.cleanup();
  }
});

test("TaskService: 失败退出闭环（消红、一键清空、重试、自动消红、上下文隔离与终态删除保护）", () => {
  const ctx = makeCtx();
  try {
    ctx.store.createAgent({ id: "leader", name: "Muse", role: "leader" });
    ctx.store.createAgent({ id: "worker", name: "Claude", role: "worker", approval_policy: "never" });

    // 1) 失败任务单条消红：不扰动 Leader 水位、从上下文隔离、线程 unresolved_failed_count 归零
    const d1 = ctx.taskService.dispatchTasks({
      fromNode: "leader",
      to: "worker",
      title: "首次配置测试",
      inputText: "跑一下测试",
      maxRetries: 0,
    });
    const t1 = d1.tasks[0].id;
    ctx.taskService.claimTaskById(t1, { claimant: "worker" });
    ctx.taskService.fail(t1, { actorId: "worker", error: "token_missing", retryable: false });

    // 先消费掉 Leader 水位，验证后续 resolveTask 不会产生重复 Leader 更新
    const beforeUpd = ctx.taskService.getLeaderUpdates("leader", { advance: true });
    assert.equal(beforeUpd.updates.length, 1);

    const thBefore = ctx.taskService.listThreads({ includeTasks: false }).find((x) => x.context_id === d1.context_id);
    assert.equal(thBefore.unresolved_failed_count, 1);
    assert.equal(ctx.taskService.buildContextHistory(d1.context_id).length, 1);

    const res1 = ctx.taskService.resolveTask(t1);
    assert.equal(res1.already_resolved, false);
    assert.ok(res1.task.resolved_at);
    // 幂等再调一次
    const res1Again = ctx.taskService.resolveTask(t1);
    assert.equal(res1Again.already_resolved, true);

    assert.equal(ctx.taskService.getLeaderUpdates("leader", { advance: false }).updates.length, 0, "消红不得污染 Leader 消费水位");
    assert.equal(ctx.taskService.buildContextHistory(d1.context_id).length, 0, "已消红的旧失败不得注入后续上下文");
    const thAfter = ctx.taskService.listThreads({ includeTasks: false }).find((x) => x.context_id === d1.context_id);
    assert.equal(thAfter.unresolved_failed_count, 0);
    assert.equal(thAfter.resolved_failed_count, 1);

    // 2) 重试任务：同线程生成新任务，自动消红旧失败，并保留 parent_task_id
    const d2 = ctx.taskService.dispatchTasks({
      fromNode: "owner",
      to: "worker",
      title: "构建发布",
      inputText: "npm run build",
      maxRetries: 0,
    });
    const t2 = d2.tasks[0].id;
    ctx.taskService.claimTaskById(t2, { claimant: "worker" });
    ctx.taskService.fail(t2, { actorId: "worker", error: "network_timeout", retryable: false });

    const retried = ctx.taskService.retryTask(t2, { fromNode: "owner" });
    assert.equal(retried.context_id, d2.context_id);
    assert.equal(retried.retried_from, t2);
    assert.equal(retried.task.parent_task_id, t2);
    assert.equal(retried.task.state, "submitted");
    assert.ok(ctx.store.getTask(t2).resolved_at, "重试成功后旧失败应自动消红");
    assert.throws(() => ctx.taskService.retryTask(retried.task.id), /不可重试/);

    // 3) 同线程后续任务成功完成时自动消红旧失败
    const d3 = ctx.taskService.dispatchTasks({
      fromNode: "owner",
      to: "worker",
      title: "第一次尝试",
      inputText: "try 1",
      maxRetries: 0,
    });
    const t3Fail = d3.tasks[0].id;
    ctx.taskService.claimTaskById(t3Fail, { claimant: "worker" });
    ctx.taskService.fail(t3Fail, { actorId: "worker", error: "bad_env", retryable: false });
    // 确保上一轮失败任务的 created_at 严格早于后续续聊轮次，避免同毫秒时钟抖动
    ctx.store.db.prepare("UPDATE tasks SET created_at = created_at - 1000 WHERE id = ?").run(t3Fail);
    assert.equal(ctx.store.getTask(t3Fail).resolved_at, null);

    const d3Follow = ctx.taskService.dispatchTasks({
      fromNode: "owner",
      to: "worker",
      title: "修好后再来",
      inputText: "try 2",
      contextId: d3.context_id,
    });
    const t3Ok = d3Follow.tasks[0].id;
    ctx.taskService.claimTaskById(t3Ok, { claimant: "worker" });
    ctx.taskService.complete(t3Ok, { actorId: "worker", summary: "ok", text: "done" });
    assert.ok(ctx.store.getTask(t3Fail).resolved_at, "同线程后续成功后应自动消红此前未处理失败");
    assert.throws(() => ctx.taskService.resolveTask(t3Ok), /无需消红/);

    // 4) 一键全部消红 resolveAllFailed
    const d4 = ctx.taskService.dispatchTasks({
      fromNode: "owner",
      to: "worker",
      title: "批量失败验证",
      inputText: "fail me",
      maxRetries: 0,
    });
    ctx.taskService.claimTaskById(d4.tasks[0].id, { claimant: "worker" });
    ctx.taskService.fail(d4.tasks[0].id, { actorId: "worker", error: "err", retryable: false });
    const bulk = ctx.taskService.resolveAllFailed();
    assert.equal(bulk.resolved_count, 1);
    assert.equal(ctx.taskService.resolveAllFailed().resolved_count, 0);

    // 5) 删除保护：活跃任务与含活跃任务的线程禁止删除；终态任务与终态线程可级联删除
    assert.throws(() => ctx.taskService.deleteTask(retried.task.id), /不可删除/);
    assert.throws(() => ctx.taskService.deleteThread(d2.context_id), /仍有未结束的任务/);

    ctx.taskService.cancel(retried.task.id, { fromNode: "owner", reason: "取消测试" });
    const delOne = ctx.taskService.deleteTask(t2);
    assert.equal(delOne.deleted, true);
    assert.equal(ctx.store.getTask(t2), null);
    assert.equal(ctx.store.listMessages(t2).length, 0);

    const delThread = ctx.taskService.deleteThread(d3.context_id);
    assert.equal(delThread.deleted, true);
    assert.equal(delThread.deleted_tasks, 2);
    assert.equal(ctx.taskService.getThread(d3.context_id), null);

    // 6) 同轮并发扇出：A、B 同轮创建（created_at 相同），B 失败后 A 成功绝不得误消 B
    ctx.store.createAgent({ id: "worker-b", name: "Codex", role: "worker", approval_policy: "never" });
    const fanout = ctx.taskService.dispatchTasks({
      fromNode: "owner",
      to: ["worker", "worker-b"],
      title: "同轮并发扇出",
      inputText: "fanout",
      maxRetries: 0,
    });
    const [fa, fb] = fanout.tasks;
    assert.equal(fa.created_at, fb.created_at);
    ctx.taskService.claimTaskById(fb.id, { claimant: "worker-b" });
    ctx.taskService.fail(fb.id, { actorId: "worker-b", error: "worker_b_failed", retryable: false });
    ctx.taskService.claimTaskById(fa.id, { claimant: "worker" });
    ctx.taskService.complete(fa.id, { actorId: "worker", summary: "a ok", text: "a ok" });
    assert.equal(ctx.store.getTask(fb.id).resolved_at, null, "同轮扇出兄弟成功绝不得误消另一兄弟的失败");

    // 7) 重试边界：目标 Agent 暂停时报错且原失败不被误消；过期附件被剔除并返回 dropped_attachments
    const fileStore = new FileStore(ctx.store, ctx.dir);
    const savedFile = fileStore.put({
      buffer: Buffer.from("temp log", "utf8"),
      name: "expired.log",
      mime: "text/plain",
      ownerNode: "owner",
    });
    const dAtt = ctx.taskService.dispatchTasks({
      fromNode: "owner",
      to: "worker-b",
      title: "带附件任务",
      inputText: "check log",
      attachments: [savedFile.uri],
      maxRetries: 0,
    });
    const tAtt = dAtt.tasks[0].id;
    ctx.taskService.claimTaskById(tAtt, { claimant: "worker-b" });
    ctx.taskService.fail(tAtt, { actorId: "worker-b", error: "oops", retryable: false });

    // 暂停目标 Agent 时重试应失败并回滚，不误消旧失败
    ctx.store.updateAgent("worker-b", { enabled: false });
    assert.throws(() => ctx.taskService.retryTask(tAtt, { fromNode: "owner" }), /已暂停/);
    assert.equal(ctx.store.getTask(tAtt).resolved_at, null, "重试失败回滚时原失败不得被误消红");

    // 恢复 Agent 但把附件标记为过期，重试应成功并显式上报被剔除的过期附件
    ctx.store.updateAgent("worker-b", { enabled: true });
    ctx.store.db.prepare("UPDATE files SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, savedFile.id);
    const retryAtt = ctx.taskService.retryTask(tAtt, { fromNode: "owner" });
    assert.equal(retryAtt.dropped_attachments, 1);
    assert.deepEqual(retryAtt.dropped_attachment_names, ["expired.log"]);
    assert.deepEqual(retryAtt.task.attachments, []);
    assert.ok(ctx.store.getTask(tAtt).resolved_at);

    // 8) resolveAllFailed 的 sinceMs 与 contextId 作用域隔离（不误清无关定时条目）
    const now = Date.now();
    const oldTs = now - 48 * 3600 * 1000;
    const recentTs = now - 60_000;
    const dOld = ctx.taskService.dispatchTasks({ fromNode: "owner", to: "worker", title: "旧失败", inputText: "old", maxRetries: 0 });
    ctx.taskService.claimTaskById(dOld.tasks[0].id, { claimant: "worker" });
    ctx.taskService.fail(dOld.tasks[0].id, { actorId: "worker", error: "old_err", retryable: false });
    ctx.store.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(oldTs, dOld.tasks[0].id);

    ctx.store.upsertSchedule({
      id: "sch-keep",
      agent_id: "worker",
      name: "不应被误清",
      driver: "edge",
      last_task_id: dOld.tasks[0].id,
      last_outcome: "failed",
    });

    const dRec = ctx.taskService.dispatchTasks({ fromNode: "owner", to: "worker", title: "近失败", inputText: "rec", maxRetries: 0 });
    ctx.taskService.claimTaskById(dRec.tasks[0].id, { claimant: "worker" });
    ctx.taskService.fail(dRec.tasks[0].id, { actorId: "worker", error: "rec_err", retryable: false });
    ctx.store.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(recentTs, dRec.tasks[0].id);

    // 仅清近 24h 范围：不应动 48h 前的旧失败及关联定时条目
    const scopedSince = ctx.taskService.resolveAllFailed({ sinceMs: now - 24 * 3600 * 1000 });
    assert.ok(scopedSince.resolved_count >= 1);
    assert.ok(ctx.store.getTask(dRec.tasks[0].id).resolved_at);
    assert.equal(ctx.store.getTask(dOld.tasks[0].id).resolved_at, null, "sinceMs 之外的旧失败不得被消红");
    assert.equal(ctx.store.getSchedule("worker", "sch-keep").last_outcome, "failed", "无关定时条目的 last_outcome 不得被误清");
  } finally {
    ctx.cleanup();
  }
});

test("HubStore migration: 老库升级新增 resolved_at 列并自动回填 24 小时前存量失败", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-mig-resolved-"));
  const dbPath = path.join(dir, "hub.db");
  try {
    const rawDb = new DatabaseSync(dbPath);
    const now = Date.now();
    const oldTs = now - 48 * 3600 * 1000;
    const freshTs = now - 10 * 60 * 1000;
    rawDb.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        parent_task_id TEXT,
        from_node TEXT NOT NULL,
        to_agent_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        input_text TEXT NOT NULL DEFAULT '',
        params_json TEXT NOT NULL DEFAULT '{}',
        attachments_json TEXT NOT NULL DEFAULT '[]',
        model TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 5,
        source TEXT NOT NULL DEFAULT 'direct',
        schedule_id TEXT,
        progress_json TEXT NOT NULL DEFAULT '{}',
        receipt_json TEXT,
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 2,
        timeout_sec INTEGER NOT NULL DEFAULT 600,
        claimed_by TEXT,
        claimed_at INTEGER,
        lease_until INTEGER,
        leader_notified INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        changed_seq INTEGER NOT NULL DEFAULT 0
      );
    `);
    const ins = rawDb.prepare(`
      INSERT INTO tasks (id, context_id, from_node, to_agent_id, title, state, created_at, updated_at, completed_at)
      VALUES (?, ?, 'owner', 'w1', ?, ?, ?, ?, ?)
    `);
    ins.run("tsk_old_fail", "ctx_1", "老失败", "failed", oldTs, oldTs, oldTs);
    ins.run("tsk_fresh_fail", "ctx_2", "新失败", "failed", freshTs, freshTs, freshTs);
    ins.run("tsk_old_ok", "ctx_3", "老成功", "completed", oldTs, oldTs, oldTs);
    rawDb.close();

    const store = new HubStore(dbPath);
    try {
      assert.ok(store.getTask("tsk_old_fail").resolved_at, "24 小时以前的存量失败迁移时应回填 resolved_at");
      assert.equal(store.getTask("tsk_fresh_fail").resolved_at, null, "近 24 小时内的存量失败应保留待机主处置");
      assert.equal(store.getTask("tsk_old_ok").resolved_at, null, "已完成任务不应写入 resolved_at");
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
