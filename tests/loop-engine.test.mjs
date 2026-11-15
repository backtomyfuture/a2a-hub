// LoopForge SOP 多阶段闭环编排引擎单元测试。
// 覆盖：
// 1. plan-code-verify 模板按阶段顺序派单并共享同一 Context_ID 与 Ref_Task_IDs；
// 2. verify 阶段验收未通过（acceptance.overall === "fail"）时，触发 goto:implement 注入 {{failure_feedback}} 打回重做；
// 3. 修复后 verify 验收通过，闭环自动进入 completed；
// 4. Max_Iterations 熔断与 cancelLoop。

import assert from "node:assert/strict";
import test from "node:test";
import { f1 } from "../src/bus/feishu.mjs";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES } from "../src/bus/tables.mjs";
import { LoopService, cancelLoop, createLoop } from "../src/hub/loop.mjs";

async function completeTask(bus, taskId, text, extraMeta = null) {
  const tasks = await bus.listRecords(bus.tables.tasks);
  const task = tasks.find((t) => f1(t, "Task_ID") === taskId);
  const msgId = `MSG-${taskId.replace("TASK-", "")}-99`;
  await bus.createRecord(bus.tables.parts, {
    Part_ID: `${msgId}-P1`,
    Parent_ID: msgId,
    Parent_Type: "message",
    Seq: 1,
    Kind: "text",
    Text: text,
  });
  if (extraMeta) {
    await bus.createRecord(bus.tables.parts, {
      Part_ID: `${msgId}-P2`,
      Parent_ID: msgId,
      Parent_Type: "message",
      Seq: 2,
      Kind: "data",
      Data: JSON.stringify(extraMeta),
    });
  }
  await bus.createRecord(bus.tables.messages, {
    Msg_ID: msgId,
    Task_ID: taskId,
    Context_ID: f1(task, "Context_ID"),
    From_Node: f1(task, "Target_Node") || "node-a",
    To_Node: "hub",
    Role: "agent",
    Kind: "result",
    Created_At: "2026-11-15 12:00",
  });
  const patch = { Status: "completed", Status_Msg: msgId };
  if (extraMeta) patch.Metadata = JSON.stringify(extraMeta);
  await bus.updateRecord(bus.tables.tasks, task.record_id, patch);
}

async function failTask(bus, taskId, reason) {
  const tasks = await bus.listRecords(bus.tables.tasks);
  const task = tasks.find((t) => f1(t, "Task_ID") === taskId);
  const msgId = `MSG-${taskId.replace("TASK-", "")}-98`;
  await bus.createRecord(bus.tables.parts, {
    Part_ID: `${msgId}-P1`,
    Parent_ID: msgId,
    Parent_Type: "message",
    Seq: 1,
    Kind: "text",
    Text: reason,
  });
  await bus.createRecord(bus.tables.messages, {
    Msg_ID: msgId,
    Task_ID: taskId,
    Context_ID: f1(task, "Context_ID"),
    From_Node: f1(task, "Target_Node") || "node-a",
    To_Node: "hub",
    Role: "agent",
    Kind: "notice",
    Created_At: "2026-11-15 12:00",
  });
  await bus.updateRecord(bus.tables.tasks, task.record_id, { Status: "failed", Status_Msg: msgId });
}

test("LoopService：plan -> implement -> verify 验收失败自动 goto:implement 注入反馈，修复后再 verify 通过完成", async () => {
  const bus = new SqliteBus({ dbPath: ":memory:", tables: DEFAULT_TABLES });
  const loopSvc = new LoopService({ bus, log: () => {} });

  try {
    const created = await createLoop({
      bus,
      title: "实现并验收新特性",
      goal: "实现用户导出 CSV 功能",
      template: "plan-code-verify",
      to: "node-a",
      cap: "CAP-a-agent",
      validateTarget: false,
      maxIterations: 6,
    });
    assert.ok(created.loopId.startsWith("LOOP-"));

    const loopRow = () => bus.listRecords(bus.tables.loops).then((rs) => rs.find((r) => f1(r, "Loop_ID") === created.loopId));

    // 阶段 1 (plan) 完成 -> 推进到阶段 2 (implement)
    await completeTask(bus, created.firstTaskId, "方案：新增 exportCsv() 函数");
    assert.strictEqual(await loopSvc.scan(), 1);
    let lp = await loopRow();
    assert.strictEqual(Number(f1(lp, "Stage_Index")), 1);
    assert.strictEqual(Number(f1(lp, "Iteration")), 2);
    const implTaskId1 = f1(lp, "Active_Task_ID");

    // 阶段 2 (implement) 完成 -> 推进到阶段 3 (verify)
    await completeTask(bus, implTaskId1, "已编写 exportCsv.mjs");
    assert.strictEqual(await loopSvc.scan(), 1);
    lp = await loopRow();
    assert.strictEqual(Number(f1(lp, "Stage_Index")), 2);
    assert.strictEqual(Number(f1(lp, "Iteration")), 3);
    const verifyTaskId1 = f1(lp, "Active_Task_ID");

    // 阶段 3 (verify) 完成但验收门禁判定 overall = "fail" -> 触发 goto:implement 打回第 2 阶段
    await completeTask(bus, verifyTaskId1, "单测有一个用例未过", {
      acceptance: {
        overall: "fail",
        checks: [{ id: "tests_pass", verdict: "fail", evidence: "CSV 转义双引号失败" }],
      },
    });
    assert.strictEqual(await loopSvc.scan(), 1);
    lp = await loopRow();
    assert.strictEqual(f1(lp, "Status"), "running");
    assert.strictEqual(Number(f1(lp, "Stage_Index")), 1); // 回到 implement
    assert.strictEqual(Number(f1(lp, "Iteration")), 4);
    const implTaskId2 = f1(lp, "Active_Task_ID");

    // 验证回跳任务与 Loop 共享同一 Context_ID，且 prompt 注入了失败原因
    const tasks = await bus.listRecords(bus.tables.tasks);
    const implTask2 = tasks.find((t) => f1(t, "Task_ID") === implTaskId2);
    assert.strictEqual(f1(implTask2, "Context_ID"), created.contextId);
    const msgs = await bus.listRecords(bus.tables.messages);
    const parts = await bus.listRecords(bus.tables.parts);
    const instrMsg = msgs.find((m) => f1(m, "Task_ID") === implTaskId2 && f1(m, "Kind") === "instruction");
    assert.strictEqual(f1(instrMsg, "Ref_Task_IDs"), verifyTaskId1);
    const instrText = parts.find((p) => f1(p, "Parent_ID") === f1(instrMsg, "Msg_ID") && f1(p, "Kind") === "text")?.fields?.Text;
    assert.match(String(instrText), /CSV 转义双引号失败/);

    // 阶段 2 修复完成 -> 推进到阶段 3 -> 阶段 3 验收通过 -> Loop 完成
    await completeTask(bus, implTaskId2, "已修复双引号转义问题");
    await loopSvc.scan();
    lp = await loopRow();
    const verifyTaskId2 = f1(lp, "Active_Task_ID");

    await completeTask(bus, verifyTaskId2, "所有单测全部通过", {
      acceptance: {
        overall: "pass",
        checks: [
          { id: "tests_pass", verdict: "pass", evidence: "10/10 passed" },
          { id: "goal_met", verdict: "pass", evidence: "CSV 导出完善" },
        ],
      },
    });
    await loopSvc.scan();
    lp = await loopRow();
    assert.strictEqual(f1(lp, "Status"), "completed");
    assert.strictEqual(Number(f1(lp, "Iteration")), 5);
  } finally {
    bus.close();
  }
});

test("LoopService：Max_Iterations 熔断与 cancelLoop", async () => {
  const bus = new SqliteBus({ dbPath: ":memory:", tables: DEFAULT_TABLES });
  const loopSvc = new LoopService({ bus, log: () => {} });

  try {
    const loopA = await createLoop({
      bus,
      goal: "测试迭代上限熔断",
      stages: [{ id: "step", name: "单步", to: "node-a", cap: "CAP-a", on_fail: "retry", prompt: "{{goal}}" }],
      maxIterations: 2,
      validateTarget: false,
    });
    const getRow = async (id) => (await bus.listRecords(bus.tables.loops)).find((r) => f1(r, "Loop_ID") === id);

    // Iter 1 失败 -> 生成 Iter 2
    await failTask(bus, loopA.firstTaskId, "第一次报错");
    await loopSvc.scan();
    let rowA = await getRow(loopA.loopId);
    assert.strictEqual(f1(rowA, "Status"), "running");
    assert.strictEqual(Number(f1(rowA, "Iteration")), 2);

    // Iter 2 再次失败 -> 达到 maxIterations=2 熔断为 failed
    await failTask(bus, f1(rowA, "Active_Task_ID"), "第二次报错");
    await loopSvc.scan();
    rowA = await getRow(loopA.loopId);
    assert.strictEqual(f1(rowA, "Status"), "failed");
    assert.match(String(f1(rowA, "Error")), /最大闭环迭代上限/);

    // cancelLoop 同时取消 Loop 与当前运行任务
    const loopB = await createLoop({
      bus,
      goal: "测试手动取消",
      stages: [{ id: "step", name: "单步", to: "node-a", cap: "CAP-a", prompt: "{{goal}}" }],
      validateTarget: false,
    });
    await cancelLoop({ bus, loopId: loopB.loopId, reason: "测试停止" });
    const rowB = await getRow(loopB.loopId);
    assert.strictEqual(f1(rowB, "Status"), "canceled");
    const taskB = (await bus.listRecords(bus.tables.tasks)).find((t) => f1(t, "Task_ID") === loopB.firstTaskId);
    assert.strictEqual(f1(taskB, "Status"), "canceled");
  } finally {
    bus.close();
  }
});
