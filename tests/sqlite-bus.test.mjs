// SqliteBus 与 LongPollBroker 单元测试。
// 覆盖 WAL 持久化、client_token 幂等建行、Cards 写入/更新、parts 写时按 json_extract 唤醒目标节点，
// 以及 LongPollBroker 游标发布、超时、断开、环形缓冲淘汰 resync 与在线拓扑追踪。

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { f1 } from "../src/bus/feishu.mjs";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES } from "../src/bus/tables.mjs";
import { LongPollBroker } from "../src/server/longpoll-broker.mjs";
import { withTemp } from "./helpers.mjs";

test("SqliteBus：CRUD、client_token 幂等建行、卡片持久化和跨重启持久性", async () => {
  await withTemp(async (dir) => {
    const dbPath = path.join(dir, "hub.db");
    const bus = new SqliteBus({ dbPath, tables: DEFAULT_TABLES });

    const r1 = await bus.createRecord(bus.tables.tasks, {
      Task_ID: "TASK-1",
      Title: "测试任务",
      Status: "submitted",
      Target_Node: "node-a",
    }, "tok-1");
    assert.ok(r1.record.record_id.startsWith("rec_"));

    // 相同 client_token 命中幂等，不生成重复记录
    const r1Dup = await bus.createRecord(bus.tables.tasks, {
      Task_ID: "TASK-1",
      Title: "不应重复",
      Status: "submitted",
    }, "tok-1");
    assert.strictEqual(r1Dup.record.record_id, r1.record.record_id);
    assert.strictEqual((await bus.listRecords(bus.tables.tasks)).length, 1);

    // updateRecord 增量合并字段
    const u1 = await bus.updateRecord(bus.tables.tasks, r1.record.record_id, {
      Status: "working",
      Claimed_By: "node-a",
    });
    assert.strictEqual(f1(u1.record, "Title"), "测试任务");
    assert.strictEqual(f1(u1.record, "Status"), "working");
    assert.strictEqual(await bus.getRecord(bus.tables.tasks, "missing_id"), null);

    // sendCard & patchInteractiveCard
    const cardRes = await bus.sendCard("owner-1", { header: { title: { content: "审批" } }, tag: "pending" });
    assert.ok(cardRes.message_id.startsWith("om_"));
    await bus.patchInteractiveCard(cardRes.message_id, { header: { title: { content: "已批准" } }, tag: "approved" });
    const cardRow = bus.getCard(cardRes.message_id);
    assert.strictEqual(cardRow.card.tag, "approved");

    bus.close();

    // 重新打开数据库文件，验证所有数据与 seq 游标持久化
    const bus2 = new SqliteBus({ dbPath, tables: DEFAULT_TABLES });
    const tasks = await bus2.listRecords(bus2.tables.tasks);
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(f1(tasks[0], "Claimed_By"), "node-a");
    assert.strictEqual(bus2.listCards().length, 1);
    assert.ok(bus2.currentSeq() >= 4);
    bus2.close();
  });
});

test("SqliteBus + LongPollBroker：instruction 静默落库，Tasks 与非 instruction Parts 定向秒级唤醒", async () => {
  await withTemp(async (dir) => {
    const broker = new LongPollBroker({ initialSeq: 0, maxHistory: 3 });
    const bus = new SqliteBus({
      dbPath: path.join(dir, "hub.db"),
      tables: DEFAULT_TABLES,
      broker,
    });

    try {
      const workerWaiter = broker.wait({ node: "node-worker", cursor: 0, timeoutMs: 3000 });
      const otherWaiter = broker.wait({ node: "node-other", cursor: 0, timeoutMs: 120 });

      // instruction 消息在 Tasks 之前写入，不提前唤醒 node-worker
      await bus.createRecord(bus.tables.messages, {
        Msg_ID: "MSG-1-01",
        Task_ID: "TASK-1",
        Context_ID: "CTX-1",
        From_Node: "hub",
        To_Node: "node-worker",
        Role: "user",
        Kind: "instruction",
      });
      await bus.createRecord(bus.tables.parts, {
        Part_ID: "MSG-1-01-P1",
        Parent_ID: "MSG-1-01",
        Parent_Type: "message",
        Seq: 1,
        Kind: "text",
        Text: "hello",
      });

      // 写入指向 node-worker 的 Tasks 行 -> 立刻唤醒 workerWaiter，而 node-other 不唤醒（超时返回）
      await bus.createRecord(bus.tables.tasks, {
        Task_ID: "TASK-1",
        Status: "submitted",
        Target_Node: "node-worker",
      });

      const workerWake = await workerWakeOrThrow(workerWaiter);
      assert.strictEqual(workerWake.wake, true);
      assert.strictEqual(workerWake.events[0].table, bus.tables.tasks);

      const otherRes = await otherWaiter;
      assert.strictEqual(otherRes.wake, false);

      // 非 instruction（例如 answer）的 Part 写入时，通过 json_extract 找到父消息 To_Node=node-worker 并推送唤醒
      const workerAnswerWaiter = broker.wait({ node: "node-worker", cursor: workerWake.cursor, timeoutMs: 3000 });
      await bus.createRecord(bus.tables.parts, {
        Part_ID: "MSG-1-02-P1",
        Parent_ID: "MSG-1-02",
        Parent_Type: "message",
        Seq: 1,
        Kind: "text",
        Text: "答复内容",
      });
      await bus.createRecord(bus.tables.messages, {
        Msg_ID: "MSG-1-02",
        Task_ID: "TASK-1",
        Context_ID: "CTX-1",
        From_Node: "hub",
        To_Node: "node-worker",
        Role: "user",
        Kind: "answer",
      });
      const ansWake = await workerAnswerWaiter;
      assert.strictEqual(ansWake.wake, true);

      // 若 answer 先写 Messages 再写 Parts，Part 写时同样能查父消息并唤醒
      const partWaiter = broker.wait({ node: "node-worker", cursor: ansWake.cursor, timeoutMs: 3000 });
      await bus.createRecord(bus.tables.parts, {
        Part_ID: "MSG-1-02-P2",
        Parent_ID: "MSG-1-02",
        Parent_Type: "message",
        Seq: 2,
        Kind: "text",
        Text: "补充 part",
      });
      const partWake = await partWaiter;
      assert.strictEqual(partWake.wake, true);
      assert.strictEqual(partWake.events[0].table, bus.tables.parts);

      // 游标过旧（已被 maxHistory=3 淘汰）时返回 resync 唤醒
      const staleRes = await broker.wait({ node: "node-worker", cursor: 0, timeoutMs: 100 });
      assert.strictEqual(staleRes.wake, true);
      assert.strictEqual(staleRes.events[0].op, "resync");

      // connectedNodes 追踪在线长轮询节点
      const nodes = broker.connectedNodes();
      assert.ok(nodes.some((n) => n.node === "node-worker" && n.online === true));
    } finally {
      broker.close();
      bus.close();
    }
  });
});

async function workerWakeOrThrow(promise) {
  const res = await promise;
  if (!res?.wake) throw new Error("expected worker waiter to be woken immediately");
  return res;
}
