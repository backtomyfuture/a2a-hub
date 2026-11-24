import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HubStore } from "../src/store/db.mjs";
import { FileStore, parseHubFileUri } from "../src/store/files.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-store-"));
}

test("HubStore: SQLite WAL 持久化、事务回滚不触发事件与 0600 权限", () => {
  const dir = makeTempDir();
  try {
    const dbPath = path.join(dir, "hub.db");
    const events = [];
    const store = new HubStore(dbPath, { changeHook: (ev) => events.push(ev) });

    if (process.platform !== "win32") {
      const mode = fs.statSync(dbPath).mode & 0o777;
      assert.equal(mode, 0o600);
    }

    assert.throws(() => {
      store.transaction(() => {
        store.upsertDevice({ id: "dev-rollback", name: "Rollback" });
        throw new Error("boom");
      });
    }, /boom/);

    assert.equal(store.getDevice("dev-rollback"), null);
    assert.equal(events.length, 0, "回滚事务不得对外发送变更事件");

    const { device, token } = store.upsertDevice({
      id: "mac-mini",
      name: "Mac mini",
      max_concurrent: 4,
      issueToken: true,
    });
    assert.equal(device.id, "mac-mini");
    assert.ok(token.startsWith("ah_dev_"));
    assert.equal(events.length, 1);

    const auth = store.authenticateToken(token);
    assert.equal(auth.actorType, "device");
    assert.equal(auth.device.id, "mac-mini");

    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HubStore: syncDeviceWorkers 保留机主备注与暂停状态并清理已删除 Worker", () => {
  const dir = makeTempDir();
  try {
    const store = new HubStore(path.join(dir, "hub.db"));
    store.upsertDevice({ id: "mbp", name: "MacBook Pro" });

    store.syncDeviceWorkers("mbp", [
      { key: "claude", name: "Claude Code", summary: "代码专家", skills: ["coding"] },
      { key: "codex", name: "Codex", summary: "测试专家", skills: ["test"] },
    ]);

    const c = store.getAgent("mbp--claude");
    assert.equal(c.kind, "device-worker");
    assert.equal(c.enabled, true);

    store.updateAgent("mbp--claude", { note: "机主自定义备注", enabled: false });

    // 重新同步时仅传 claude：应保留 note 与 enabled=false，并删除移除的 codex
    store.syncDeviceWorkers("mbp", [
      { key: "claude", name: "Claude Code Pro", summary: "升级描述", skills: ["coding", "git"] },
    ]);

    const after = store.getAgent("mbp--claude");
    assert.equal(after.name, "Claude Code Pro");
    assert.equal(after.summary, "升级描述");
    assert.equal(after.note, "机主自定义备注");
    assert.equal(after.enabled, false);
    assert.equal(store.getAgent("mbp--codex"), null);

    // 再次用完全相同配置同步（设备仍在在线窗口内）：不应自增 seq 或广播 device.synced
    const events = [];
    store.setChangeHook((ev) => events.push(ev));
    const seqBefore = store.currentSeq();
    store.syncDeviceWorkers("mbp", [
      { key: "claude", name: "Claude Code Pro", summary: "升级描述", skills: ["coding", "git"] },
    ]);
    assert.equal(store.currentSeq(), seqBefore, "幂等同步设备不应自增 seq");
    assert.equal(events.length, 0, "幂等同步设备不应触发 device.synced 事件");

    // updateAgent 传入未变化的字段时也不应自增 seq
    store.updateAgent("mbp--claude", { summary: "升级描述", skills: ["coding", "git"] });
    assert.equal(store.currentSeq(), seqBefore, "无字段变更的 updateAgent 不应自增 seq");
    assert.equal(events.length, 0);

    // 幂等键清理与 WAL checkpoint
    store.saveIdempotency("dispatch:owner", "old-k", { ok: true });
    store.db.prepare("UPDATE idempotency SET created_at = ? WHERE token_key = ?").run(Date.now() - 10 * 86400_000, "old-k");
    store.saveIdempotency("dispatch:owner", "fresh-k", { ok: true });
    const pruned = store.pruneIdempotency(7 * 86400_000);
    assert.equal(pruned, 1);
    assert.equal(store.getIdempotency("dispatch:owner", "old-k"), null);
    assert.deepEqual(store.getIdempotency("dispatch:owner", "fresh-k"), { ok: true });
    store.checkpointWal("TRUNCATE");

    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("FileStore: 文件上传、SHA256 校验与过期自动清理", () => {
  const dir = makeTempDir();
  try {
    const store = new HubStore(path.join(dir, "hub.db"));
    const files = new FileStore(store, dir, { defaultTtlMs: 60_000 });

    const put = files.put({
      buffer: Buffer.from("hello a2a-hub v2", "utf8"),
      name: "report.txt",
      mime: "text/plain",
      ownerNode: "owner",
    });
    assert.equal(parseHubFileUri(put.uri), put.id);

    const read = files.readBuffer(put.id);
    assert.equal(read.buffer.toString("utf8"), "hello a2a-hub v2");
    assert.equal(read.meta.name, "report.txt");

    const expired = files.put({
      buffer: Buffer.from("old", "utf8"),
      name: "old.txt",
      ttlMs: 1,
    });
    const removed = files.sweepExpired(Date.now() + 5000);
    assert.equal(removed, 1);
    assert.equal(files.getMeta(expired.id), null);
    assert.ok(files.getMeta(put.id));

    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
