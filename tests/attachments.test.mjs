// 附件能力阶段 2 测试：写入路径（建单 / 答复 / ask / auth / 交付）与读取路径（内核下载、网关视图）。
// 状态只写系统临时目录；文件存储与客户端用阶段 1 的 FileStore / LocalFileClient。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  appendFileParts,
  attachmentsView,
  normalizeAttachments,
  planArtifactItem,
} from "../src/attachments.mjs";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES, f1 } from "../src/bus/tables.mjs";
import { LocalFileClient } from "../src/files-client.mjs";
import { createTask, parseCreateArgv } from "../src/hub/create.mjs";
import { FileStore, HUB_FILE_URI_PREFIX } from "../src/hub/files.mjs";
import { handleInboxAsk, handleInboxDone, submitAgentReceipt } from "../src/inbox.mjs";
import { Kernel } from "../src/kernel.mjs";
import { parseAgentReceipt, parseJsonReceipt } from "../src/receipt.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { LongPollBroker } from "../src/server/longpoll-broker.mjs";
import { TABLES, withTemp } from "./helpers.mjs";
import { MockBus } from "./mocks/mock-bus.mjs";

const ZERO_ID = `${HUB_FILE_URI_PREFIX}F-${"0".repeat(32)}`;

function writeLocal(dir, name, content = "hello") {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

async function partsOf(bus, parentId) {
  const rows = await bus.listRecords(bus.tables.parts);
  return rows
    .filter((p) => f1(p, "Parent_ID") === parentId)
    .sort((a, b) => Number(f1(a, "Seq")) - Number(f1(b, "Seq")));
}

// ---------- normalizeAttachments ----------

test("normalizeAttachments：file_id 归一、hub:// 存在性、外部 URL、文件名与 MIME 缺省", async () => {
  await withTemp(async (dir) => {
    const store = new FileStore({ configDir: dir });
    try {
      const meta = await store.putFile(writeLocal(dir, "a.txt", "abc"), { name: "报告.txt", mime: "text/plain", uploadedBy: "owner" });

      assert.deepEqual(normalizeAttachments(undefined), []);
      assert.deepEqual(normalizeAttachments(null), []);

      const out = normalizeAttachments([
        { file_id: meta.file_id },
        { uri: meta.uri, name: "../改名\x00.txt", mime: "Text/Markdown; charset=utf-8" },
        { uri: "https://example.com/files/data%20set.csv" },
        { uri: "http://example.com/" },
      ], { fileStore: store });
      assert.deepEqual(out[0], { uri: meta.uri, name: "报告.txt", mime: "text/plain" });
      assert.deepEqual(out[1], { uri: meta.uri, name: "..改名.txt", mime: "text/markdown" });
      assert.deepEqual(out[2], { uri: "https://example.com/files/data%20set.csv", name: "data set.csv", mime: "application/octet-stream" });
      assert.equal(out[3].name, "file");

      // 远端场景拿不到 fileStore：只校验格式，不校验存在性。
      assert.equal(normalizeAttachments([{ uri: ZERO_ID }])[0].uri, ZERO_ID);

      const bad = (input, re, opts) => assert.throws(
        () => normalizeAttachments(input, opts),
        (err) => err.status === 400 && re.test(err.message),
      );
      bad("x", /必须是数组/);
      bad({}, /必须是数组/);
      bad([null], /必须是对象/);
      bad(["hub://files/x"], /必须是对象/);
      bad([{}], /需要 uri 或 file_id/);
      bad([{ file_id: "F-short" }], /file_id 格式/);
      bad([{ uri: ZERO_ID, file_id: meta.file_id }], /不一致/);
      bad([{ uri: "hub://files/../etc/passwd" }], /hub 文件地址/);
      bad([{ uri: ZERO_ID }], /不存在/, { fileStore: store });
      bad([{ uri: "ftp://example.com/a" }], /http/);
      bad([{ uri: "file:///etc/passwd" }], /http/);
      bad([{ uri: "/etc/passwd" }], /URL/);
      bad([{ uri: "https://user:pw@example.com/a" }], /用户名/);
      bad([{ uri: `https://example.com/${"a".repeat(2100)}` }], /2048/);
      bad([{ uri: "https://example.com/a", name: 3 }], /name 必须是字符串/);
      bad(Array.from({ length: 21 }, () => ({ uri: "https://example.com/a" })), /最多 20/);
      assert.equal(normalizeAttachments(Array.from({ length: 20 }, () => ({ uri: "https://example.com/a" }))).length, 20);

      store.markDeleted(meta.file_id, "expired");
      bad([{ uri: meta.uri }], /已过期/, { fileStore: store });
    } finally {
      store.close();
    }
  });
});

test("attachmentsView：hub:// 补 download_url / size / deleted，外部 URL 原样，无 fileStore 时降级", async () => {
  await withTemp(async (dir) => {
    const store = new FileStore({ configDir: dir });
    try {
      const meta = await store.putFile(writeLocal(dir, "v.bin", "12345"), { name: "v.bin", mime: "application/zip" });
      const mock = new MockBus({ tables: TABLES });
      await appendFileParts(mock, "MSG-V-01", 1, [
        { uri: meta.uri, name: "v.bin", mime: "application/zip" },
        { uri: "https://example.com/x.png", name: "x.png", mime: "image/png" },
      ]);
      await mock.createRecord(TABLES.parts, { Part_ID: "MSG-V-01-P9", Parent_ID: "MSG-V-01", Parent_Type: "message", Seq: 9, Kind: "text", Text: "t" });
      const rows = await mock.listRecords(TABLES.parts);

      const view = attachmentsView(rows, "http://hub:8787/", store);
      assert.equal(view.length, 2);
      assert.deepEqual(view[0], {
        file_uri: meta.uri,
        file_name: "v.bin",
        mime_type: "application/zip",
        download_url: `http://hub:8787/api/v1/files/${meta.file_id}`,
        size: 5,
        deleted: false,
      });
      assert.equal(view[1].download_url, "https://example.com/x.png");
      assert.equal(view[1].size, null);
      assert.equal(view[1].deleted, false);

      store.markDeleted(meta.file_id, "expired");
      assert.equal(attachmentsView(rows, "http://hub:8787", store)[0].deleted, true);
      const remote = attachmentsView(rows, "http://hub:8787", null);
      assert.equal(remote[0].size, null);
      assert.equal(remote[0].deleted, false);
    } finally {
      store.close();
    }
  });
});

// ---------- 建单 ----------

test("createTask：文件块排在 text、data 之后，Seq 递增并带 Mime_Type；无文字时从 Seq 1 开始", async () => {
  const mock = new MockBus({ tables: TABLES });
  const taskId = await createTask({
    bus: mock,
    to: "node-a",
    cap: "echo",
    text: "看附件",
    params: { n: 1 },
    validateTarget: false,
    attachments: [
      { uri: ZERO_ID, name: "a.pdf", mime: "application/pdf" },
      { uri: "https://example.com/b.png", name: "b.png" },
    ],
  });
  const msgId = `MSG-${taskId.slice(5)}-01`;
  const parts = await partsOf(mock, msgId);
  assert.deepEqual(parts.map((p) => [Number(f1(p, "Seq")), f1(p, "Kind")]), [[1, "text"], [2, "data"], [3, "file"], [4, "file"]]);
  assert.equal(f1(parts[2], "File_URI"), ZERO_ID);
  assert.equal(f1(parts[2], "Mime_Type"), "application/pdf");
  assert.equal(f1(parts[3], "Mime_Type"), "application/octet-stream");
  assert.equal(f1(parts[3], "File_Name"), "b.png");

  const only = await createTask({
    bus: mock, to: "node-a", cap: "echo", validateTarget: false,
    attachments: [{ uri: "https://example.com/c.txt" }],
  });
  const onlyParts = await partsOf(mock, `MSG-${only.slice(5)}-01`);
  assert.equal(onlyParts.length, 1);
  assert.equal(Number(f1(onlyParts[0], "Seq")), 1);

  // 非法附件在第一笔写之前就拒绝，不留半截消息。
  const before = mock.journal.length;
  await assert.rejects(
    () => createTask({ bus: mock, to: "node-a", cap: "echo", validateTarget: false, text: "x", attachments: [{ uri: "ftp://x/y" }] }),
    (err) => err.status === 400,
  );
  assert.equal(mock.journal.length, before);
});

test("parseCreateArgv：--file 可重复", () => {
  const args = parseCreateArgv(["--to", "node-a", "--file", "/tmp/a", "--file", "/tmp/b", "--text", "hi"]);
  assert.deepEqual(args.files, ["/tmp/a", "/tmp/b"]);
  assert.deepEqual(parseCreateArgv(["--to", "node-a"]).files, []);
});

// ---------- 回执解析 ----------

test("parseAgentReceipt：多行 ARTIFACT、ARTIFACT_NAME 作用于上一条，res.artifact 保留第一个", () => {
  const res = parseAgentReceipt([
    "做完了",
    "ARTIFACT: /tmp/a.md",
    "ARTIFACT_NAME: 报告",
    "ARTIFACT: https://example.com/b.zip",
    "ARTIFACT: /tmp/c.csv",
    "ARTIFACT_NAME: 数据",
  ].join("\n"));
  assert.deepEqual(res.artifacts, [
    { uri: "/tmp/a.md", name: "报告" },
    { uri: "https://example.com/b.zip" },
    { uri: "/tmp/c.csv", name: "数据" },
  ]);
  assert.equal(res.artifact, "/tmp/a.md");
  assert.equal(res.artifact_name, "报告");
  assert.equal(res.summary, "做完了");

  // 旧写法：单个 ARTIFACT，NAME 写在前面也算它的名字。
  const old = parseAgentReceipt("ok\nARTIFACT_NAME: 先写名字\nARTIFACT: /x");
  assert.equal(old.artifact, "/x");
  assert.equal(old.artifact_name, "先写名字");
  assert.deepEqual(old.artifacts, [{ uri: "/x", name: "先写名字" }]);

  const none = parseAgentReceipt("只有正文");
  assert.equal(none.artifact, "");
  assert.deepEqual(none.artifacts, []);
});

test("parseJsonReceipt：artifacts 数组、旧 artifact 字符串兼容、非法元素跳过", () => {
  const logs = [];
  const res = parseJsonReceipt({
    summary: "ok",
    artifacts: [
      "/tmp/a.txt",
      { uri: "hub://files/F-" + "1".repeat(32), name: "n", mime: "text/plain" },
      { nouri: true },
      42,
    ],
  }, (m) => logs.push(m));
  assert.equal(res.artifact, "/tmp/a.txt");
  assert.deepEqual(res.artifacts, [
    { uri: "/tmp/a.txt" },
    { uri: "hub://files/F-" + "1".repeat(32), name: "n", mime: "text/plain" },
  ]);
  assert.equal(logs.filter((m) => /非法元素/.test(m)).length, 2);
  assert.equal(logs.some((m) => /未知顶层键/.test(m)), false);

  const legacy = parseJsonReceipt({ summary: "ok", artifact: "/tmp/z", artifact_name: "Z" });
  assert.equal(legacy.artifact, "/tmp/z");
  assert.equal(legacy.artifact_name, "Z");
  assert.deepEqual(legacy.artifacts, [{ uri: "/tmp/z", name: "Z" }]);

  const both = parseJsonReceipt({ summary: "ok", artifact: "/tmp/z", artifacts: ["/tmp/z", "/tmp/y"] });
  assert.deepEqual(both.artifacts.map((a) => a.uri), ["/tmp/z", "/tmp/y"]);
});

test("planArtifactItem：本地存在的文件记 upload_pending，相对路径按 baseDirs 找，不存在或外部 URL 原样保留", async () => {
  await withTemp(async (dir) => {
    const sub = path.join(dir, "work");
    fs.mkdirSync(sub);
    const abs = writeLocal(sub, "r.txt");
    assert.equal(planArtifactItem(abs, []).upload_pending, true);
    const rel = planArtifactItem("r.txt", [dir, sub]);
    assert.equal(rel.upload_pending, true);
    assert.equal(rel.local_path, abs);
    assert.equal(rel.uri, "");
    assert.equal(rel.src, "r.txt");
    const gone = planArtifactItem("/no/such/file", [dir]);
    assert.equal(gone.upload_pending, undefined);
    assert.equal(gone.uri, "/no/such/file");
    assert.equal(planArtifactItem("https://example.com/a", [dir]).upload_pending, undefined);
    assert.equal(planArtifactItem(abs, [], false).upload_pending, undefined);
    assert.equal(planArtifactItem({ uri: abs, name: "n", mime: "text/x" }, []).name, "n");
  });
});

// ---------- HTTP：建单 / 答复 / ask / auth / 交付 / 视图 ----------

async function startHub(dir) {
  const broker = new LongPollBroker({ initialSeq: 0 });
  const bus = new SqliteBus({ dbPath: path.join(dir, "hub.db"), tables: DEFAULT_TABLES, broker });
  const store = new FileStore({ configDir: dir });
  const handle = await startHubHttpServer({
    cfg: { node: "hub", configDir: dir, listen: "127.0.0.1:0" },
    bus,
    broker,
    fileStore: store,
    log: () => {},
  });
  const api = async (pathname, { method = "GET", body } = {}) => {
    const res = await fetch(`${handle.localUrl}${pathname}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  const upload = async (name, content, mime = "text/plain") => {
    const res = await fetch(`${handle.localUrl}/api/v1/files`, {
      method: "POST",
      headers: { "content-type": mime, "x-file-name": encodeURIComponent(name) },
      body: content,
    });
    assert.equal(res.status, 201);
    return await res.json();
  };
  const close = async () => {
    await handle.close();
    store.close();
    bus.close?.();
  };
  return { bus, store, api, upload, base: handle.localUrl, close };
}

test("HTTP：建单 / 答复 / ask / auth / complete 写出 file Part，网关与详情视图带 download_url、size、deleted", async () => {
  await withTemp(async (dir) => {
    const hub = await startHub(dir);
    try {
      const f1m = await hub.upload("需求.txt", "need", "text/plain");
      const f2m = await hub.upload("答复.png", "png-bytes", "image/png");
      const f3m = await hub.upload("提问图.png", "q", "image/png");
      const f4m = await hub.upload("成果.zip", "zipzip", "application/zip");

      // 建单：text 与 attachments 不能同时为空；非法附件 400
      const empty = await hub.api("/api/v1/tasks", { method: "POST", body: { to: "worker-a", cap: "echo", validateTarget: false } });
      assert.equal(empty.status, 400);
      assert.match(empty.data.error, /不能同时为空/);
      const badAtt = await hub.api("/api/v1/tasks", {
        method: "POST",
        body: { to: "worker-a", cap: "echo", text: "x", validateTarget: false, attachments: [{ file_id: "F-" + "a".repeat(32) }] },
      });
      assert.equal(badAtt.status, 400);
      assert.match(badAtt.data.error, /不存在/);

      // 有附件时 text 可空
      const created = await hub.api("/api/v1/tasks", {
        method: "POST",
        body: {
          to: "worker-a", cap: "echo", validateTarget: false,
          attachments: [{ file_id: f1m.file_id }, { uri: "https://example.com/ref.pdf", name: "ref.pdf", mime: "application/pdf" }],
        },
      });
      assert.equal(created.status, 201);
      const taskId = created.data.task_id;
      const instrId = `MSG-${taskId.slice(5)}-01`;
      const instrParts = await partsOf(hub.bus, instrId);
      assert.deepEqual(instrParts.map((p) => [Number(f1(p, "Seq")), f1(p, "Kind"), f1(p, "Mime_Type")]), [
        [1, "file", "text/plain"],
        [2, "file", "application/pdf"],
      ]);

      // worker 认领：claim 响应直接带 instruction_attachments
      const claim = await hub.api(`/api/v1/tasks/${taskId}/claim`, { method: "POST", body: { node: "worker-a" } });
      assert.equal(claim.status, 200);
      assert.equal(claim.data.instruction_attachments.length, 2);
      assert.equal(claim.data.instruction_attachments[0].download_url, `${hub.base}/api/v1/files/${f1m.file_id}`);

      // ask 带附件
      const ask = await hub.api(`/api/v1/tasks/${taskId}/ask`, {
        method: "POST",
        body: { node: "worker-a", text: "这张图是什么？", attachments: [{ file_id: f3m.file_id }] },
      });
      assert.equal(ask.status, 200);
      const qParts = await partsOf(hub.bus, ask.data.msg_id);
      assert.deepEqual(qParts.map((p) => [Number(f1(p, "Seq")), f1(p, "Kind")]), [[1, "text"], [2, "file"]]);
      assert.equal(f1(qParts[1], "File_URI"), f3m.uri);
      assert.equal(f1(qParts[1], "Mime_Type"), "image/png");

      // ask 带非法附件 400，且不改任务状态
      const taskAfterAsk = (await hub.bus.listRecords(hub.bus.tables.tasks)).find((t) => f1(t, "Task_ID") === taskId);
      assert.equal(f1(taskAfterAsk, "Status"), "input-required");

      // 答复：只有附件，没有 text 块，文件块 Seq 从 1 开始
      const bothEmpty = await hub.api(`/api/v1/tasks/${taskId}/reply`, { method: "POST", body: {} });
      assert.equal(bothEmpty.status, 400);
      const reply = await hub.api(`/api/v1/tasks/${taskId}/reply`, {
        method: "POST",
        body: { attachments: [{ file_id: f2m.file_id }] },
      });
      assert.equal(reply.status, 200);
      const aParts = await partsOf(hub.bus, reply.data.msg_id);
      assert.deepEqual(aParts.map((p) => [Number(f1(p, "Seq")), f1(p, "Kind")]), [[1, "file"]]);
      assert.equal(f1(aParts[0], "Part_ID"), `${reply.data.msg_id}-P1`);

      // 恢复执行：answers[].attachments
      const resume = await hub.api(`/api/v1/tasks/${taskId}/claim`, { method: "POST", body: { node: "worker-a" } });
      assert.equal(resume.status, 200);
      assert.equal(resume.data.answers[0].attachments[0].file_uri, f2m.uri);

      // complete：旧 artifact 字符串 + 新 artifacts 数组，各一条 Artifact + file Part
      const done = await hub.api(`/api/v1/tasks/${taskId}/complete`, {
        method: "POST",
        body: {
          node: "worker-a",
          text: "完成",
          artifact: "legacy-result.txt",
          artifacts: [{ file_id: f4m.file_id, name: "成果.zip" }, { uri: "https://example.com/out.csv", mime: "text/csv" }],
        },
      });
      assert.equal(done.status, 200);
      assert.deepEqual(done.data.artifactIds, [`${taskId}-A1`, `${taskId}-A2`, `${taskId}-A3`]);
      const artifacts = (await hub.bus.listRecords(hub.bus.tables.artifacts)).filter((a) => f1(a, "Task_ID") === taskId);
      assert.equal(artifacts.length, 3);
      const resultMsg = (await hub.bus.listRecords(hub.bus.tables.messages)).find((m) => f1(m, "Msg_ID") === done.data.msg_id);
      assert.equal(f1(resultMsg, "Artifact_Ref"), `${taskId}-A1`);
      const a2 = await partsOf(hub.bus, `${taskId}-A2`);
      assert.equal(a2.length, 1);
      assert.equal(f1(a2[0], "File_URI"), f4m.uri);
      assert.equal(f1(a2[0], "Mime_Type"), "application/zip");
      assert.equal(f1(a2[0], "File_Name"), "成果.zip");
      assert.equal(f1((await partsOf(hub.bus, `${taskId}-A3`))[0], "Mime_Type"), "text/csv");
      assert.equal(f1((await partsOf(hub.bus, `${taskId}-A1`))[0], "File_URI"), "legacy-result.txt");

      // complete 不接收 attachments
      const badDone = await hub.api(`/api/v1/tasks/${taskId}/complete`, { method: "POST", body: { node: "worker-a", attachments: [] } });
      assert.equal(badDone.status, 400);

      // 网关任务视图
      const list = await hub.api("/api/v1/tasks");
      const brief = list.data.tasks.find((t) => t.task_id === taskId);
      assert.deepEqual(brief.instruction_attachments.map((a) => a.file_name), ["需求.txt", "ref.pdf"]);
      assert.equal(brief.question_attachments[0].file_uri, f3m.uri);
      assert.equal(brief.answer_attachments[0].file_uri, f2m.uri);
      assert.equal(brief.answer_attachments[0].size, 9);
      assert.equal(brief.answer_attachments[0].deleted, false);
      const zip = brief.artifacts[1].files[0];
      assert.equal(zip.download_url, `${hub.base}/api/v1/files/${f4m.file_id}`);
      assert.equal(zip.size, 6);
      assert.equal(brief.artifacts[2].files[0].download_url, "https://example.com/out.csv");
      assert.equal(brief.artifacts[2].files[0].size, null);
      // 本地路径遗留项没有可下载地址
      assert.equal(brief.artifacts[0].files[0].download_url, null);

      // GET /api/v1/tasks/:id 详情的文件块补 download_url / size / deleted
      hub.store.markDeleted(f4m.file_id, "expired");
      const detail = await hub.api(`/api/v1/tasks/${taskId}`);
      assert.equal(detail.status, 200);
      const filePart = detail.data.messages.flatMap((m) => m.parts).find((p) => p.file_uri === f1m.uri);
      assert.equal(filePart.download_url, `${hub.base}/api/v1/files/${f1m.file_id}`);
      assert.equal(filePart.size, 4);
      assert.equal(filePart.deleted, false);
      const zipDetail = detail.data.artifacts.flatMap((a) => a.files).find((f) => f.file_uri === f4m.uri);
      assert.equal(zipDetail.deleted, true);
      assert.equal(zipDetail.download_url, `${hub.base}/api/v1/files/${f4m.file_id}`);
    } finally {
      await hub.close();
    }
  });
});

test("HTTP：auth 带附件写进 auth_request（To_Node=hub）；fail 也可带 artifacts", async () => {
  await withTemp(async (dir) => {
    const hub = await startHub(dir);
    try {
      const ev = await hub.upload("evidence.txt", "ev");
      const created = await hub.api("/api/v1/tasks", {
        method: "POST", body: { to: "worker-a", cap: "echo", text: "做事", validateTarget: false },
      });
      const taskId = created.data.task_id;
      await hub.api(`/api/v1/tasks/${taskId}/claim`, { method: "POST", body: { node: "worker-a" } });
      const auth = await hub.api(`/api/v1/tasks/${taskId}/auth`, {
        method: "POST", body: { node: "worker-a", text: "要删库", attachments: [{ file_id: ev.file_id }] },
      });
      assert.equal(auth.status, 200);
      const msg = (await hub.bus.listRecords(hub.bus.tables.messages)).find((m) => f1(m, "Msg_ID") === auth.data.msg_id);
      assert.equal(f1(msg, "Kind"), "auth_request");
      assert.equal(f1(msg, "To_Node"), "hub");
      const parts = await partsOf(hub.bus, auth.data.msg_id);
      assert.deepEqual(parts.map((p) => [Number(f1(p, "Seq")), f1(p, "Kind")]), [[1, "text"], [2, "data"], [3, "file"]]);
      assert.equal(f1(parts[2], "File_URI"), ev.uri);

      // 非法附件 400
      const t2 = (await hub.api("/api/v1/tasks", { method: "POST", body: { to: "worker-a", cap: "echo", text: "x", validateTarget: false } })).data.task_id;
      await hub.api(`/api/v1/tasks/${t2}/claim`, { method: "POST", body: { node: "worker-a" } });
      const badAsk = await hub.api(`/api/v1/tasks/${t2}/ask`, {
        method: "POST", body: { node: "worker-a", text: "q", attachments: [{ uri: "ftp://x/y" }] },
      });
      assert.equal(badAsk.status, 400);
      const fail = await hub.api(`/api/v1/tasks/${t2}/fail`, {
        method: "POST", body: { node: "worker-a", text: "炸了", artifacts: [{ file_id: ev.file_id }] },
      });
      assert.equal(fail.status, 200);
      assert.equal(fail.data.status, "failed");
      assert.equal(fail.data.artifactIds.length, 1);
    } finally {
      await hub.close();
    }
  });
});

// ---------- submitAgentReceipt 直接调用 ----------

test("submitAgentReceipt：artifacts 逐个生成 Artifact + file Part，旧 artifact 字符串等价于一个元素", async () => {
  const mock = new MockBus({ tables: TABLES });
  const taskId = await createTask({ bus: mock, to: "node-a", cap: "echo", text: "x", validateTarget: false });
  const task = (await mock.findRecords(TABLES.tasks, "Task_ID", taskId))[0];
  await mock.updateRecord(TABLES.tasks, task.record_id, { Status: "working", Claimed_By: "node-a" });
  const receipt = await submitAgentReceipt({
    bus: mock, node: "node-a", taskId, text: "done", op: "done",
    artifact: "a.txt",
    artifacts: [{ uri: "https://example.com/b.bin", name: "b.bin", mime: "application/x-b" }],
  });
  assert.deepEqual(receipt.artifactIds, [`${taskId}-A1`, `${taskId}-A2`]);
  assert.equal(receipt.artifactId, `${taskId}-A1`);
  const p1 = (await partsOf(mock, `${taskId}-A1`))[0];
  assert.equal(f1(p1, "File_URI"), "a.txt");
  assert.equal(f1(p1, "Mime_Type"), "text/plain");
  const p2 = (await partsOf(mock, `${taskId}-A2`))[0];
  assert.equal(f1(p2, "Mime_Type"), "application/x-b");
});

// ---------- inbox 本地 outbox：上传失败只补缺，不重复建 ----------

async function seedWorkingTask(mock, { taskId, node = "node-a", status = "working" }) {
  const msgId = `MSG-${taskId.slice(5)}-01`;
  await mock.createRecord(TABLES.messages, {
    Msg_ID: msgId, Task_ID: taskId, Context_ID: `CTX-${taskId}`, From_Node: "hub", To_Node: node,
    Role: "user", Kind: "instruction", Created_At: "2026-01-15T09:00:00+0800",
  });
  await mock.createRecord(TABLES.parts, {
    Part_ID: `${msgId}-P1`, Parent_ID: msgId, Parent_Type: "message", Seq: 1, Kind: "text", Text: "干活",
  });
  const created = await mock.createRecord(TABLES.tasks, {
    Task_ID: taskId, Title: "t", Source: "hub", Target_Node: node, Skill_ID: "agent", Status: status,
    Claimed_By: node, Hop_Count: 0, Retry_Count: 0, Context_ID: `CTX-${taskId}`,
  });
  return created.record;
}

function flakyClient(store, { failTimes = 0, tooLarge = new Set() } = {}) {
  const real = new LocalFileClient(store);
  const state = { uploads: [], failTimes };
  return {
    state,
    store,
    async upload(p, opts) {
      state.uploads.push(p);
      if (tooLarge.has(path.basename(p))) {
        const err = new Error("文件大小超过上限");
        err.status = 413;
        throw err;
      }
      if (state.failTimes > 0) {
        state.failTimes -= 1;
        throw new Error("网络断开");
      }
      return real.upload(p, opts);
    },
    download: (uri, dest) => real.download(uri, dest),
    close() {},
  };
}

test("inbox done：本地产物提交前上传成 hub://，第二个失败后重试只补缺，不重复建 Artifact / Part", async () => {
  await withTemp(async (dir) => {
    const store = new FileStore({ configDir: path.join(dir, "hubdata") });
    try {
      const mock = new MockBus({ tables: TABLES });
      await seedWorkingTask(mock, { taskId: "TASK-INBOX-UP-1" });
      const a = writeLocal(dir, "a.txt", "AAA");
      const b = writeLocal(dir, "b.pdf", "BBBB");
      const client = flakyClient(store);
      // 第一个文件成功，第二个失败
      let n = 0;
      const origUpload = client.upload.bind(client);
      client.upload = async (p, o) => {
        n += 1;
        if (n === 2) throw new Error("网络断开");
        return origUpload(p, o);
      };
      await assert.rejects(
        () => handleInboxDone({
          bus: mock, configDir: dir, node: "node-a", taskId: "TASK-INBOX-UP-1", text: "完成",
          artifacts: [a, b], getFileClient: () => client,
        }),
        /网络断开/,
      );
      // 落盘的计划里第一项已有 uri，第二项仍待上传；表里什么都没写
      const outboxFile = path.join(dir, "inbox-outbox", "TASK-INBOX-UP-1.json");
      const plan = JSON.parse(fs.readFileSync(outboxFile, "utf8"));
      assert.equal(plan.artifacts[0].uri.startsWith(HUB_FILE_URI_PREFIX), true);
      assert.equal(plan.artifacts[0].upload_pending, false);
      assert.equal(plan.artifacts[1].upload_pending, true);
      assert.equal((await mock.listRecords(TABLES.artifacts)).length, 0);

      const res = await handleInboxDone({
        bus: mock, configDir: dir, node: "node-a", taskId: "TASK-INBOX-UP-1", text: "完成",
        artifacts: [a, b], getFileClient: () => client,
      });
      assert.deepEqual(res.artifactIds, ["TASK-INBOX-UP-1-A1", "TASK-INBOX-UP-1-A2"]);
      // 总共只上传了 a 一次、b 两次（一次失败）
      assert.equal(client.state.uploads.filter((p) => p === a).length, 1);
      assert.equal((await mock.listRecords(TABLES.artifacts)).length, 2);
      const fileParts = (await mock.listRecords(TABLES.parts)).filter((p) => f1(p, "Kind") === "file");
      assert.equal(fileParts.length, 2);
      const byUri = new Map(fileParts.map((p) => [f1(p, "File_Name"), p]));
      assert.equal(f1(byUri.get("a.txt"), "Mime_Type"), "text/plain");
      assert.equal(f1(byUri.get("b.pdf"), "Mime_Type"), "application/pdf");
      assert.equal(f1(byUri.get("a.txt"), "File_URI").startsWith(HUB_FILE_URI_PREFIX), true);
      assert.equal(fs.existsSync(outboxFile), false);
    } finally {
      store.close();
    }
  });
});

test("inbox ask --file：附件写在 question 之后，写表中途失败补齐时不重复插入文件块", async () => {
  await withTemp(async (dir) => {
    const store = new FileStore({ configDir: path.join(dir, "hubdata") });
    try {
      const mock = new MockBus({ tables: TABLES });
      await seedWorkingTask(mock, { taskId: "TASK-INBOX-ASK-1" });
      const shot = writeLocal(dir, "shot.png", "PNG");
      const client = flakyClient(store);
      // 文件块写完之后、改任务状态时失败
      mock.failNext((ctx) => ctx.op === "update" && ctx.table === TABLES.tasks);
      await assert.rejects(
        () => handleInboxAsk({
          bus: mock, configDir: dir, node: "node-a", taskId: "TASK-INBOX-ASK-1", text: "看这张图",
          files: [shot], getFileClient: () => client,
        }),
        /1254291/,
      );
      const res = await handleInboxAsk({
        bus: mock, configDir: dir, node: "node-a", taskId: "TASK-INBOX-ASK-1", text: "看这张图",
        files: [shot], getFileClient: () => client,
      });
      assert.equal(client.state.uploads.length, 1);
      const parts = await partsOf(mock, res.msgId);
      assert.deepEqual(parts.map((p) => [Number(f1(p, "Seq")), f1(p, "Kind")]), [[1, "text"], [2, "file"]]);
      assert.equal(f1(parts[1], "Mime_Type"), "image/png");
      assert.equal(f1(parts[1], "File_Name"), "shot.png");
      assert.equal(f1((await mock.findRecords(TABLES.tasks, "Task_ID", "TASK-INBOX-ASK-1"))[0], "Status"), "input-required");

      // 显式 --file 不存在：直接报错，不写表
      await seedWorkingTask(mock, { taskId: "TASK-INBOX-ASK-2" });
      await assert.rejects(
        () => handleInboxAsk({
          bus: mock, configDir: dir, node: "node-a", taskId: "TASK-INBOX-ASK-2", text: "q",
          files: [path.join(dir, "不存在.png")], getFileClient: () => client,
        }),
        /文件不存在/,
      );
    } finally {
      store.close();
    }
  });
});

// ---------- 内核：outbox 上传 / 413 / 读取下载 ----------

function makeKernel(dir, extra = {}) {
  fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({ echo: { command: "true", mode: "json" } }), { mode: 0o600 });
  const mock = new MockBus({ tables: TABLES });
  const kernel = new Kernel({
    node: "node-a", role: "node", kind: "host", zone: "test", capPrefix: "test", events: false,
    configDir: dir, bus: mock, ...extra,
  });
  return { mock, kernel };
}

async function seedKernelTask(mock, taskId, { extraMessages = [] } = {}) {
  const task = await seedWorkingTask(mock, { taskId });
  await mock.updateRecord(TABLES.tasks, task.record_id, { Skill_ID: "echo", Heartbeat_At: "2026-01-15T09:00:00+0800" });
  for (const m of extraMessages) await m(mock);
  return (await mock.findRecords(TABLES.tasks, "Task_ID", taskId))[0];
}

test("内核 outbox：本地文件先记 upload_pending，上传失败保留 outbox、重试只补缺；多文件 A1/A2，Mime 填写，Artifact_Ref 指向第一条", async () => {
  await withTemp(async (dir) => {
    const store = new FileStore({ configDir: path.join(dir, "hubdata") });
    try {
      const workDir = path.join(dir, "work");
      fs.mkdirSync(workDir);
      writeLocal(workDir, "r1.md", "# one");
      const abs2 = writeLocal(dir, "r2.csv", "a,b");
      const client = flakyClient(store);
      let calls = 0;
      const realUpload = client.upload.bind(client);
      client.upload = async (p, o) => {
        calls += 1;
        if (calls === 2) throw new Error("网络断开");
        return realUpload(p, o);
      };
      const { mock, kernel } = makeKernel(dir, { fileClient: client });
      kernel.commands.echo.cwd = workDir;
      const task = await seedKernelTask(mock, "TASK-K-UP-1");
      const res = {
        summary: "交付完毕",
        artifacts: [
          { uri: "r1.md" },                                  // 相对 cwd
          { uri: abs2, name: "数据" },                       // 绝对路径 + 名字
          { uri: "/no/such/file.bin" },                       // 不存在：保留原字符串
          { uri: "https://example.com/doc.pdf", mime: "application/pdf" },
        ],
      };
      res.artifact = res.artifacts[0].uri;
      const box = kernel.beginOutbox(task, { outcome: "succeeded", res, started: "2026-01-15T09:00:00+0800", runId: "" });
      assert.deepEqual(box.artifacts.map((a) => !!a.upload_pending), [true, true, false, false]);

      await assert.rejects(() => kernel.submitOutbox(task, box), /网络断开/);
      // outbox 保留，r1 已回写 uri，r2 仍待上传，表里还没有 Artifact
      const saved = kernel.readOutbox("TASK-K-UP-1");
      assert.equal(saved.artifacts[0].uri.startsWith(HUB_FILE_URI_PREFIX), true);
      assert.equal(saved.artifacts[1].upload_pending, true);
      assert.equal((await mock.listRecords(TABLES.artifacts)).length, 0);

      await kernel.flushOutbox();
      assert.equal(kernel.readOutbox("TASK-K-UP-1"), null);
      assert.equal(calls, 3, "r1 只传一次，r2 失败后补传一次");
      const arts = (await mock.listRecords(TABLES.artifacts)).sort((a, b) => f1(a, "Artifact_ID").localeCompare(f1(b, "Artifact_ID")));
      assert.deepEqual(arts.map((a) => f1(a, "Artifact_ID")), ["TASK-K-UP-1-A1", "TASK-K-UP-1-A2", "TASK-K-UP-1-A3", "TASK-K-UP-1-A4"]);
      assert.deepEqual(arts.map((a) => f1(a, "Name")), ["r1.md", "数据", "file.bin", "doc.pdf"]);
      const fileOf = async (id) => (await partsOf(mock, id))[0];
      assert.equal(f1(await fileOf("TASK-K-UP-1-A1"), "File_URI").startsWith(HUB_FILE_URI_PREFIX), true);
      assert.equal(f1(await fileOf("TASK-K-UP-1-A1"), "Mime_Type"), "text/markdown");
      assert.equal(f1(await fileOf("TASK-K-UP-1-A2"), "Mime_Type"), "text/csv");
      assert.equal(f1(await fileOf("TASK-K-UP-1-A3"), "File_URI"), "/no/such/file.bin");
      assert.equal(f1(await fileOf("TASK-K-UP-1-A4"), "Mime_Type"), "application/pdf");
      const allFileParts = (await mock.listRecords(TABLES.parts)).filter((p) => f1(p, "Parent_Type") === "artifact");
      assert.equal(allFileParts.length, 4, "没有重复的 file Part");
      const result = (await mock.listRecords(TABLES.messages)).find((m) => f1(m, "Kind") === "result");
      assert.equal(f1(result, "Artifact_Ref"), "TASK-K-UP-1-A1");
      assert.equal(f1((await mock.findRecords(TABLES.tasks, "Task_ID", "TASK-K-UP-1"))[0], "Status"), "completed");
    } finally {
      store.close();
    }
  });
});

test("内核 outbox：单个旧式 artifact 字符串保持旧行为（名字取技能名、路径原样）", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = makeKernel(dir);
    const task = await seedKernelTask(mock, "TASK-K-OLD-1");
    const box = kernel.beginOutbox(task, {
      outcome: "succeeded", res: { summary: "ok", artifact: "/no/such/legacy.txt" }, started: "2026-01-15T09:00:00+0800", runId: "",
    });
    await kernel.submitOutbox(task, box);
    const art = (await mock.listRecords(TABLES.artifacts))[0];
    assert.equal(f1(art, "Artifact_ID"), "TASK-K-OLD-1-A1");
    assert.equal(f1(art, "Name"), "echo");
    assert.equal(f1((await partsOf(mock, "TASK-K-OLD-1-A1"))[0], "File_URI"), "/no/such/legacy.txt");

    // 升级前落盘的旧 outbox（没有 artifacts 数组）读回来仍按单产物补齐。
    await seedKernelTask(mock, "TASK-K-OLD-2");
    const task2 = (await mock.findRecords(TABLES.tasks, "Task_ID", "TASK-K-OLD-2"))[0];
    const legacyBox = kernel.beginOutbox(task2, {
      outcome: "succeeded", res: { summary: "ok", artifact: "/legacy/path.txt", artifact_name: "旧名" }, started: "2026-01-15T09:00:00+0800", runId: "",
    });
    delete legacyBox.artifacts;
    legacyBox.artId = "TASK-K-OLD-2-A1";
    kernel.saveOutbox(legacyBox);
    await kernel.submitOutbox(task2, kernel.readOutbox("TASK-K-OLD-2"));
    const art2 = (await mock.findRecords(TABLES.artifacts, "Artifact_ID", "TASK-K-OLD-2-A1"))[0];
    assert.equal(f1(art2, "Name"), "旧名");
  });
});

test("内核 outbox：上传 413 不重试，保留原字符串并在结果正文末尾追加说明，任务正常完成", async () => {
  await withTemp(async (dir) => {
    const store = new FileStore({ configDir: path.join(dir, "hubdata") });
    try {
      const big = writeLocal(dir, "huge.bin", "x");
      const small = writeLocal(dir, "small.txt", "y");
      const client = flakyClient(store, { tooLarge: new Set(["huge.bin"]) });
      const { mock, kernel } = makeKernel(dir, { fileClient: client });
      const task = await seedKernelTask(mock, "TASK-K-413-1");
      const box = kernel.beginOutbox(task, {
        outcome: "succeeded",
        res: { summary: "已生成", artifact: big, artifacts: [{ uri: big }, { uri: small }] },
        started: "2026-01-15T09:00:00+0800", runId: "",
      });
      await kernel.submitOutbox(task, box);
      assert.equal(kernel.readOutbox("TASK-K-413-1"), null);
      assert.equal(client.state.uploads.filter((p) => p === big).length, 1, "413 不重试");
      assert.equal(f1((await partsOf(mock, "TASK-K-413-1-A1"))[0], "File_URI"), big);
      assert.equal(f1((await partsOf(mock, "TASK-K-413-1-A2"))[0], "File_URI").startsWith(HUB_FILE_URI_PREFIX), true);
      const result = (await mock.listRecords(TABLES.messages)).find((m) => f1(m, "Kind") === "result");
      const text = f1((await partsOf(mock, f1(result, "Msg_ID"))).find((p) => f1(p, "Kind") === "text"), "Text");
      assert.match(text, /^已生成/);
      assert.match(text, /（产物 huge\.bin 超过大小上限，未上传，仍保留原路径 .*huge\.bin）$/);
      assert.equal(f1((await mock.findRecords(TABLES.tasks, "Task_ID", "TASK-K-413-1"))[0], "Status"), "completed");
    } finally {
      store.close();
    }
  });
});

test("内核读取：collectDialogue 纳入 question 文件，hub:// 下载到 runs/<Task_ID>/files，input.json 记 local_path / error", async () => {
  await withTemp(async (dir) => {
    const store = new FileStore({ configDir: path.join(dir, "hubdata") });
    try {
      const mk = async (name, content, mime) => store.putFile(writeLocal(dir, name, content), { name, mime });
      const instrFile = await mk("需求.txt", "need", "text/plain");
      const qFile = await mk("../q.png", "qq", "image/png");
      const ansFile = await mk("ans.pdf", "ansans", "application/pdf");
      const goneFile = await mk("gone.txt", "g", "text/plain");
      store.markDeleted(goneFile.file_id, "expired");

      const client = flakyClient(store);
      let netDown = false;
      const origDownload = client.download;
      client.download = async (uri, dest) => {
        client.state.downloads = (client.state.downloads ?? 0) + 1;
        if (netDown) throw new Error("ECONNRESET");
        return origDownload(uri, dest);
      };
      const { mock, kernel } = makeKernel(dir, { fileClient: client });
      const task = await seedKernelTask(mock, "TASK-K-DL-1");
      const taskId = "TASK-K-DL-1";
      const instrId = "MSG-K-DL-1-01";
      const addMsg = async (msgId, kind, parts) => {
        await mock.createRecord(TABLES.messages, {
          Msg_ID: msgId, Task_ID: taskId, Context_ID: "CTX-TASK-K-DL-1", From_Node: "hub", To_Node: "node-a",
          Role: "user", Kind: kind, Created_At: "2026-01-15T09:00:00+0800",
        });
        await appendFileParts(mock, msgId, 1, parts);
      };
      await appendFileParts(mock, instrId, 2, [
        { uri: instrFile.uri, name: "需求.txt", mime: "text/plain" },
        { uri: ZERO_ID, name: "missing.bin", mime: "application/octet-stream" },
        { uri: "https://example.com/ext.png", name: "ext.png", mime: "image/png" },
        { uri: goneFile.uri, name: "gone.txt", mime: "text/plain" },
      ]);
      await addMsg("MSG-K-DL-1-02", "question", [{ uri: qFile.uri, name: "../q.png", mime: "image/png" }]);
      await addMsg("MSG-K-DL-1-03", "answer", [{ uri: ansFile.uri, name: "ans.pdf", mime: "application/pdf" }]);
      kernel._round = null;

      const inputPath = await kernel.writeAgentInput(task, {}, undefined);
      const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
      assert.deepEqual(input.files.map((f) => f.from_kind), ["instruction", "instruction", "instruction", "instruction", "question", "answer"]);
      const filesDir = path.join(dir, "runs", taskId, "files");
      assert.equal(input.files[0].local_path, path.join(filesDir, "01-需求.txt"));
      assert.equal(fs.readFileSync(input.files[0].local_path, "utf8"), "need");
      assert.equal(fs.statSync(input.files[0].local_path).mode & 0o777, 0o600);
      assert.equal(input.files[1].error, "not_found");
      assert.equal(input.files[1].local_path, undefined);
      assert.equal(input.files[2].local_path, undefined);
      assert.equal(input.files[2].error, undefined);
      assert.equal(input.files[3].error, "expired");
      assert.equal(input.files[4].local_path, path.join(filesDir, "05-..q.png"));
      assert.equal(input.files[5].local_path, path.join(filesDir, "06-ans.pdf"));
      assert.equal(fs.readFileSync(input.files[5].local_path, "utf8"), "ansans");

      // 已下载且大小一致的不重下；失败的（not_found / expired）每次仍会尝试
      const before = client.state.downloads;
      netDown = true;
      const again = await kernel.collectDialogue(task);
      assert.equal(again.files[0].local_path, input.files[0].local_path);
      assert.equal(again.files[5].error, undefined);
      assert.equal(client.state.downloads - before, 2, "只重试 not_found 与 expired 两项");
      assert.equal(again.files[1].error, "download_failed", "网络错误记 download_failed，不抛出");

      // 网络错误：全新目录下载失败也只记 error
      fs.rmSync(filesDir, { recursive: true, force: true });
      const failed = await kernel.collectDialogue(task);
      assert.equal(failed.files[0].error, "download_failed");
      assert.equal(failed.files[2].error, undefined);
    } finally {
      store.close();
    }
  });
});

test("内核端到端：JSON 回执 artifacts 里的本地文件在 run 内自动上传成 hub://，命令只跑一次", async () => {
  await withTemp(async (dir) => {
    const store = new FileStore({ configDir: path.join(dir, "hubdata") });
    try {
      const report = writeLocal(dir, "report.txt", "REPORT");
      const counter = path.join(dir, "runs-count");
      const script = `
        const fs = require("node:fs");
        fs.appendFileSync(${JSON.stringify(counter)}, "x");
        console.log(JSON.stringify({ summary: "跑完了", artifacts: [${JSON.stringify(report)}, "https://example.com/more.zip"] }));
      `;
      // 多行脚本经 JSON.stringify 塞进 -e 会变成字面 \n，落成文件再执行。
      const scriptPath = path.join(dir, "emit.cjs");
      fs.writeFileSync(scriptPath, script);
      fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
        echo: { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`, mode: "json", context: "direct", timeout_sec: 30 },
      }), { mode: 0o600 });
      const mock = new MockBus({ tables: TABLES });
      const client = flakyClient(store, { failTimes: 1 });
      const kernel = new Kernel({
        node: "node-a", role: "node", kind: "host", zone: "test", capPrefix: "test", events: false,
        configDir: dir, bus: mock, fileClient: client,
      });
      const msgId = "MSG-E2E-01-01";
      await mock.createRecord(TABLES.messages, {
        Msg_ID: msgId, Task_ID: "TASK-E2E-01", Context_ID: "CTX-E2E-01", From_Node: "hub", To_Node: "node-a",
        Role: "user", Kind: "instruction", Created_At: "2026-01-15T09:00:00+0800",
      });
      await mock.createRecord(TABLES.parts, { Part_ID: `${msgId}-P1`, Parent_ID: msgId, Parent_Type: "message", Seq: 1, Kind: "text", Text: "跑" });
      await mock.createRecord(TABLES.tasks, {
        Task_ID: "TASK-E2E-01", Title: "跑", Source: "hub", Target_Node: "node-a", Skill_ID: "echo", Status: "submitted",
        Hop_Count: 0, Retry_Count: 0, Idempotency_Key: "k-e2e", Context_ID: "CTX-E2E-01",
      });

      await kernel.run({ once: true });
      // 第一次上传失败：outbox 保留，任务还没完成，命令跑过一次
      assert.equal(fs.readFileSync(counter, "utf8"), "x");
      assert.notEqual(kernel.readOutbox("TASK-E2E-01"), null);
      await kernel.flushOutbox();
      assert.equal(kernel.readOutbox("TASK-E2E-01"), null);
      assert.equal(fs.readFileSync(counter, "utf8"), "x", "补齐阶段不重跑命令");
      assert.equal(f1((await mock.findRecords(TABLES.tasks, "Task_ID", "TASK-E2E-01"))[0], "Status"), "completed");
      const p1 = (await partsOf(mock, "TASK-E2E-01-A1"))[0];
      assert.equal(f1(p1, "File_URI").startsWith(HUB_FILE_URI_PREFIX), true);
      assert.equal(f1(p1, "File_Name"), "report.txt");
      assert.equal(f1(p1, "Mime_Type"), "text/plain");
      assert.equal(f1((await partsOf(mock, "TASK-E2E-01-A2"))[0], "File_URI"), "https://example.com/more.zip");
      assert.equal((await mock.listRecords(TABLES.artifacts)).length, 2);
    } finally {
      store.close();
    }
  });
});
