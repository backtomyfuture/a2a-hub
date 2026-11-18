// 附件能力阶段 1 测试：FileStore、HTTP 上传下载、可见性隔离、410/413、Retention 清理、Local/HttpFileClient、agent-access 放行。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES } from "../src/bus/tables.mjs";
import {
  createFileClient,
  guessMime,
  HttpFileClient,
  LocalFileClient,
} from "../src/files-client.mjs";
import { assertAgentRoute } from "../src/hub/agent-access.mjs";
import { AgentTokenStore } from "../src/hub/agent-tokens.mjs";
import {
  FileRetentionService,
  FileStore,
  findFileRefs,
  HUB_FILE_URI_PREFIX,
  parseHubFileUri,
  sanitizeFileName,
} from "../src/hub/files.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { LongPollBroker } from "../src/server/longpoll-broker.mjs";
import { withTemp } from "./helpers.mjs";

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function seedTaskWithMessageFile(bus, {
  taskId,
  fromNode,
  targetNode,
  source = "",
  status = "submitted",
  fileUri,
  fileName = "doc.txt",
  mimeType = "text/plain",
}) {
  const msgId = `MSG-${taskId}-01`;
  await bus.createRecord(bus.tables.messages, {
    Msg_ID: msgId,
    Task_ID: taskId,
    Context_ID: `CTX-${taskId}`,
    From_Node: fromNode,
    To_Node: targetNode,
    Role: "user",
    Kind: "instruction",
  });
  await bus.createRecord(bus.tables.parts, {
    Part_ID: `${msgId}-P1`,
    Parent_ID: msgId,
    Parent_Type: "message",
    Seq: 1,
    Kind: "file",
    File_URI: fileUri,
    File_Name: fileName,
    Mime_Type: mimeType,
  });
  await bus.createRecord(bus.tables.tasks, {
    Task_ID: taskId,
    Title: `Task ${taskId}`,
    Status: status,
    Target_Node: targetNode,
    Source: source || fromNode,
    Context_ID: `CTX-${taskId}`,
  });
}

async function seedArtifactFile(bus, {
  taskId,
  artId,
  fileUri,
  fileName = "out.bin",
  mimeType = "application/octet-stream",
}) {
  await bus.createRecord(bus.tables.artifacts, {
    Artifact_ID: artId,
    Task_ID: taskId,
    Context_ID: `CTX-${taskId}`,
    Name: fileName,
    Is_Final: "Yes",
    Created_By: "worker-a",
  });
  await bus.createRecord(bus.tables.parts, {
    Part_ID: `${artId}-P1`,
    Parent_ID: artId,
    Parent_Type: "artifact",
    Seq: 1,
    Kind: "file",
    File_URI: fileUri,
    File_Name: fileName,
    Mime_Type: mimeType,
  });
}

test("FileStore：流式写入、sha256、0700/0600 权限、文件名清洗与 URI 解析", async () => {
  await withTemp(async (rootDir) => {
    const fixedNow = new Date("2026-11-01T10:00:00.000Z");
    const store = new FileStore({
      configDir: rootDir,
      maxBytes: 1024,
      now: () => fixedNow,
    });
    try {
      const payload = Buffer.from("hello attachment bytes \u4e2d\u6587");
      const meta = await store.putStream(Readable.from([payload.subarray(0, 6), payload.subarray(6)]), {
        name: "../../dir/a\x00b/测试文档.txt",
        mime: "Text/Plain; charset=utf-8",
        uploadedBy: "worker-1",
      });

      assert.match(meta.file_id, /^F-[0-9a-f]{32}$/);
      assert.equal(meta.uri, `${HUB_FILE_URI_PREFIX}${meta.file_id}`);
      assert.equal(parseHubFileUri(meta.uri), meta.file_id);
      assert.equal(parseHubFileUri("http://example.com/a"), null);
      assert.equal(parseHubFileUri("hub://files/../etc/passwd"), null);
      assert.equal(meta.name, "....dirab测试文档.txt");
      assert.equal(meta.mime, "text/plain");
      assert.equal(meta.size, payload.length);
      assert.equal(meta.sha256, sha256Hex(payload));
      assert.equal(meta.uploaded_by, "worker-1");
      assert.equal(meta.created_at, fixedNow.toISOString());
      assert.equal(meta.deleted_at, null);

      const blobPath = store.blobPath(meta.file_id);
      assert.ok(fs.existsSync(blobPath));
      assert.equal(fs.statSync(store.filesDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.dirname(blobPath)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(blobPath).mode & 0o777, 0o600);

      // 读回校验
      const chunks = [];
      for await (const c of store.openReadStream(meta.file_id)) chunks.push(c);
      assert.deepEqual(Buffer.concat(chunks), payload);

      // 文件名 255 字节截断不拆 UTF-8 多字节字符
      const longName = "中".repeat(120) + ".txt";
      const sanitized = sanitizeFileName(longName);
      assert.ok(Buffer.byteLength(sanitized, "utf8") <= 255);
      assert.equal(Buffer.from(sanitized, "utf8").toString("utf8"), sanitized);
    } finally {
      store.close();
    }
  });
});

test("FileStore 与 HTTP POST /api/v1/files：超限返回 413 且无残留临时文件", async () => {
  await withTemp(async (rootDir) => {
    const store = new FileStore({ configDir: rootDir, maxBytes: 512 });
    const broker = new LongPollBroker({ initialSeq: 0 });
    const bus = new SqliteBus({
      dbPath: path.join(rootDir, "hub.db"),
      tables: DEFAULT_TABLES,
      broker,
    });
    const httpHandle = await startHubHttpServer({
      cfg: { node: "hub", configDir: rootDir, listen: "127.0.0.1:0" },
      bus,
      broker,
      fileStore: store,
      log: () => {},
    });

    try {
      // 1) FileStore.putStream 超限
      await assert.rejects(
        () => store.putStream(Readable.from([Buffer.alloc(300), Buffer.alloc(300)]), { name: "big.bin" }),
        (err) => err.status === 413,
      );
      assert.deepEqual(fs.readdirSync(store.tmpDir), []);

      // 2) HTTP 带 Content-Length 预检超限 413
      const overBuf = Buffer.alloc(600, 0x41);
      const resCl = await fetch(`${httpHandle.localUrl}/api/v1/files`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-File-Name": encodeURIComponent("too-big.bin"),
        },
        body: overBuf,
      });
      assert.equal(resCl.status, 413);
      assert.deepEqual(fs.readdirSync(store.tmpDir), []);

      // 3) HTTP 无 Content-Length（chunked 流式）超限 413
      const chunkedStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(300));
          controller.enqueue(new Uint8Array(300));
          controller.close();
        },
      });
      const resStream = await fetch(`${httpHandle.localUrl}/api/v1/files`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: chunkedStream,
        duplex: "half",
      });
      assert.equal(resStream.status, 413);
      assert.deepEqual(fs.readdirSync(store.tmpDir), []);
    } finally {
      await httpHandle.close();
      store.close();
      bus.close();
    }
  });
});

test("HTTP 上传下载：Content-Disposition 与 inline 白名单（svg 禁止 inline）、响应头与 410", async () => {
  await withTemp(async (rootDir) => {
    const store = new FileStore({ configDir: rootDir, maxBytes: 4096 });
    const broker = new LongPollBroker({ initialSeq: 0 });
    const bus = new SqliteBus({
      dbPath: path.join(rootDir, "hub.db"),
      tables: DEFAULT_TABLES,
      broker,
    });
    const httpHandle = await startHubHttpServer({
      cfg: { node: "hub", configDir: rootDir, listen: "127.0.0.1:0" },
      bus,
      broker,
      fileStore: store,
      log: () => {},
    });

    try {
      // 上传 PNG
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const upPng = await fetch(`${httpHandle.localUrl}/api/v1/files`, {
        method: "POST",
        headers: {
          "Content-Type": "image/png",
          "X-File-Name": encodeURIComponent("截图 1.png"),
        },
        body: pngBytes,
      });
      assert.equal(upPng.status, 201);
      const pngMeta = await upPng.json();
      assert.equal(pngMeta.sha256, sha256Hex(pngBytes));
      assert.equal(store.get(pngMeta.file_id)?.uploaded_by, "open");

      // 默认 attachment
      const dlAttach = await fetch(`${httpHandle.localUrl}/api/v1/files/${pngMeta.file_id}`);
      assert.equal(dlAttach.status, 200);
      assert.equal(dlAttach.headers.get("x-content-type-options"), "nosniff");
      assert.equal(dlAttach.headers.get("cache-control"), "private, max-age=0");
      assert.equal(
        dlAttach.headers.get("content-disposition"),
        `attachment; filename*=UTF-8''${encodeURIComponent("截图 1.png")}`,
      );
      assert.deepEqual(Buffer.from(await dlAttach.arrayBuffer()), pngBytes);

      // ?inline=1 对 PNG/JPEG/GIF/WEBP 允许 inline，非白名单（SVG/TXT）忽略 inline
      const dlInline = await fetch(`${httpHandle.localUrl}/api/v1/files/${pngMeta.file_id}?inline=1`);
      assert.equal(dlInline.status, 200);
      assert.match(dlInline.headers.get("content-disposition"), /^inline; filename\*=UTF-8''/);

      for (const mime of ["image/jpeg", "image/gif", "image/webp"]) {
        const upImg = await fetch(`${httpHandle.localUrl}/api/v1/files`, {
          method: "POST",
          headers: { "Content-Type": mime, "X-File-Name": "pic.bin" },
          body: Buffer.from("img"),
        });
        assert.equal(upImg.status, 201);
        const im = await upImg.json();
        const dlImg = await fetch(`${httpHandle.localUrl}/api/v1/files/${im.file_id}?inline=1`);
        assert.match(dlImg.headers.get("content-disposition"), /^inline; filename\*=UTF-8''/);
      }

      // 上传 SVG，?inline=1 必须忽略，仍返回 attachment
      const svgBytes = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
      const upSvg = await fetch(`${httpHandle.localUrl}/api/v1/files`, {
        method: "POST",
        headers: {
          "Content-Type": "image/svg+xml",
          "X-File-Name": encodeURIComponent("icon.svg"),
        },
        body: svgBytes,
      });
      assert.equal(upSvg.status, 201);
      const svgMeta = await upSvg.json();
      const dlSvgInline = await fetch(`${httpHandle.localUrl}/api/v1/files/${svgMeta.file_id}?inline=1`);
      assert.equal(dlSvgInline.status, 200);
      assert.match(dlSvgInline.headers.get("content-disposition"), /^attachment; filename\*=UTF-8''/);

      // 410 已清理（下载与 /meta 均返回 410）
      store.markDeleted(pngMeta.file_id, "unreferenced");
      const dlGone = await fetch(`${httpHandle.localUrl}/api/v1/files/${pngMeta.file_id}`);
      assert.equal(dlGone.status, 410);
      const goneBody = await dlGone.json();
      assert.equal(goneBody.error, "文件已过期清理");
      assert.equal(goneBody.reason, "unreferenced");
      assert.ok(goneBody.deleted_at);

      const metaGone = await fetch(`${httpHandle.localUrl}/api/v1/files/${pngMeta.file_id}/meta`);
      assert.equal(metaGone.status, 410);
      const metaGoneBody = await metaGone.json();
      assert.equal(metaGoneBody.reason, "unreferenced");
    } finally {
      await httpHandle.close();
      store.close();
      bus.close();
    }
  });
});

test("可见性与权限：owner 全可见、上传者可见、引用任务相关方可见、无关 agent 404", async () => {
  await withTemp(async (rootDir) => {
    const store = new FileStore({ configDir: rootDir, maxBytes: 4096 });
    const broker = new LongPollBroker({ initialSeq: 0 });
    const bus = new SqliteBus({
      dbPath: path.join(rootDir, "hub.db"),
      tables: DEFAULT_TABLES,
      broker,
    });

    const ownerToken = "owner-secret-token";
    const tokenStore = new AgentTokenStore(rootDir);
    const tokUploader = tokenStore.issue({ node: "leader-a", role: "leader" }).token;
    const tokTarget = tokenStore.issue({ node: "worker-b", role: "worker" }).token;
    const tokStranger = tokenStore.issue({ node: "worker-c", role: "worker" }).token;

    const httpHandle = await startHubHttpServer({
      cfg: { node: "hub", configDir: rootDir, listen: "127.0.0.1:0", apiToken: ownerToken },
      bus,
      broker,
      fileStore: store,
      log: () => {},
    });

    try {
      // 未携带 Token 拒绝
      const unauth = await fetch(`${httpHandle.localUrl}/api/v1/files`, { method: "POST", body: "hi" });
      assert.equal(unauth.status, 401);

      // leader-a 上传文件
      const content = Buffer.from("secret task payload");
      const up = await fetch(`${httpHandle.localUrl}/api/v1/files`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokUploader}`,
          "Content-Type": "text/plain",
          "X-File-Name": "secret.txt",
        },
        body: content,
      });
      assert.equal(up.status, 201);
      const uploaded = await up.json();
      assert.equal(store.get(uploaded.file_id)?.uploaded_by, "leader-a");

      // 在关联任务前：上传者与 owner 可见；worker-b、worker-c 均为 404
      assert.equal(
        (await fetch(`${httpHandle.localUrl}/api/v1/files/${uploaded.file_id}`, {
          headers: { Authorization: `Bearer ${tokUploader}` },
        })).status,
        200,
      );
      assert.equal(
        (await fetch(`${httpHandle.localUrl}/api/v1/files/${uploaded.file_id}`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        })).status,
        200,
      );
      assert.equal(
        (await fetch(`${httpHandle.localUrl}/api/v1/files/${uploaded.file_id}`, {
          headers: { Authorization: `Bearer ${tokTarget}` },
        })).status,
        404,
      );
      assert.equal(
        (await fetch(`${httpHandle.localUrl}/api/v1/files/${uploaded.file_id}/meta`, {
          headers: { Authorization: `Bearer ${tokTarget}` },
        })).status,
        404,
      );

      // 把文件挂到 leader-a -> worker-b 的任务上（再测一次 artifact 引用）
      await seedTaskWithMessageFile(bus, {
        taskId: "TASK-VIS-1",
        fromNode: "leader-a",
        targetNode: "worker-b",
        status: "working",
        fileUri: uploaded.uri,
      });

      // worker-b 现在可见（下载 + meta）
      const dlTarget = await fetch(`${httpHandle.localUrl}/api/v1/files/${uploaded.file_id}`, {
        headers: { Authorization: `Bearer ${tokTarget}` },
      });
      assert.equal(dlTarget.status, 200);
      assert.deepEqual(Buffer.from(await dlTarget.arrayBuffer()), content);

      const metaTarget = await fetch(`${httpHandle.localUrl}/api/v1/files/${uploaded.file_id}/meta`, {
        headers: { Authorization: `Bearer ${tokTarget}` },
      });
      assert.equal(metaTarget.status, 200);
      const metaJson = await metaTarget.json();
      assert.equal(metaJson.meta.file_id, uploaded.file_id);
      assert.deepEqual(metaJson.refs, ["TASK-VIS-1"]);

      // 无关的 worker-c 仍返回 404（即便已清理也不能泄露 410）
      assert.equal(
        (await fetch(`${httpHandle.localUrl}/api/v1/files/${uploaded.file_id}`, {
          headers: { Authorization: `Bearer ${tokStranger}` },
        })).status,
        404,
      );
      store.markDeleted(uploaded.file_id, "expired");
      assert.equal(
        (await fetch(`${httpHandle.localUrl}/api/v1/files/${uploaded.file_id}`, {
          headers: { Authorization: `Bearer ${tokStranger}` },
        })).status,
        404,
      );
      assert.equal(
        (await fetch(`${httpHandle.localUrl}/api/v1/files/${uploaded.file_id}`, {
          headers: { Authorization: `Bearer ${tokTarget}` },
        })).status,
        410,
      );

      // artifact 引用同样赋予任务相关方可见性
      const upArt = await fetch(`${httpHandle.localUrl}/api/v1/files`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/octet-stream",
          "X-File-Name": "artifact.bin",
        },
        body: Buffer.from("artifact-bytes"),
      });
      const artMeta = await upArt.json();
      assert.equal(
        (await fetch(`${httpHandle.localUrl}/api/v1/files/${artMeta.file_id}`, {
          headers: { Authorization: `Bearer ${tokTarget}` },
        })).status,
        404,
      );
      await seedArtifactFile(bus, {
        taskId: "TASK-VIS-1",
        artId: "TASK-VIS-1-A1",
        fileUri: artMeta.uri,
      });
      assert.equal(
        (await fetch(`${httpHandle.localUrl}/api/v1/files/${artMeta.file_id}`, {
          headers: { Authorization: `Bearer ${tokTarget}` },
        })).status,
        200,
      );
      assert.equal(
        (await fetch(`${httpHandle.localUrl}/api/v1/files/${artMeta.file_id}`, {
          headers: { Authorization: `Bearer ${tokStranger}` },
        })).status,
        404,
      );
    } finally {
      await httpHandle.close();
      store.close();
      bus.close();
    }
  });
});

test("FileRetentionService 与 findFileRefs：24h 未引用删、30 天且引用任务终态删、非终态跳过", async () => {
  await withTemp(async (rootDir) => {
    const t0 = Date.parse("2026-10-01T00:00:00.000Z");
    let currentNow = t0;
    const store = new FileStore({ configDir: rootDir, maxBytes: 4096, now: () => currentNow });
    const bus = new SqliteBus({
      dbPath: path.join(rootDir, "hub.db"),
      tables: DEFAULT_TABLES,
    });

    try {
      const fUnrefOld = await store.putStream(Readable.from([Buffer.from("unref-old")]), { name: "a.txt" });
      const fTerm = await store.putStream(Readable.from([Buffer.from("term-ref")]), { name: "b.txt" });
      const fActive = await store.putStream(Readable.from([Buffer.from("active-ref")]), { name: "c.txt" });

      // 23 小时后上传另一个未引用文件
      currentNow = t0 + 23 * 3600_000;
      const fUnrefFresh = await store.putStream(Readable.from([Buffer.from("unref-fresh")]), { name: "d.txt" });

      await seedTaskWithMessageFile(bus, {
        taskId: "TASK-TERM",
        fromNode: "leader",
        targetNode: "worker",
        status: "completed",
        fileUri: fTerm.uri,
      });
      await seedArtifactFile(bus, {
        taskId: "TASK-TERM",
        artId: "TASK-TERM-A1",
        fileUri: fTerm.uri,
      });
      await seedTaskWithMessageFile(bus, {
        taskId: "TASK-ACTIVE",
        fromNode: "leader",
        targetNode: "worker",
        status: "working",
        fileUri: fActive.uri,
      });

      const refs = await findFileRefs(bus, fTerm.file_id);
      assert.equal(refs.length, 2);
      assert.deepEqual(
        refs.map((r) => `${r.parent_type}:${r.task_id}`).sort(),
        ["artifact:TASK-TERM", "message:TASK-TERM"],
      );

      const logs = [];
      const retention = new FileRetentionService({
        fileStore: store,
        bus,
        now: () => currentNow,
        log: (m) => logs.push(m),
      });

      // t0 + 25h：fUnrefOld (>24h 无引用) 被删，fUnrefFresh (2h) 保留，引用文件保留
      currentNow = t0 + 25 * 3600_000;
      const r1 = await retention.scan();
      assert.equal(r1.unreferenced, 1);
      assert.equal(r1.expired, 0);
      assert.ok(store.get(fUnrefOld.file_id).deleted_at);
      assert.equal(store.getReason(fUnrefOld.file_id), "unreferenced");
      assert.equal(fs.existsSync(store.blobPath(fUnrefOld.file_id)), false);
      assert.equal(store.get(fUnrefFresh.file_id).deleted_at, null);

      // t0 + 31d：fTerm (31d 且唯一引用任务 completed) 被删且 Parts 不动；fActive (working) 不删
      currentNow = t0 + 31 * 24 * 3600_000;
      const partsBefore = (await bus.listRecords(bus.tables.parts)).length;
      const r2 = await retention.scan();
      assert.equal(r2.expired, 1);
      assert.equal(r2.unreferenced, 1); // fUnrefFresh 也超过 24h 了
      assert.ok(store.get(fTerm.file_id).deleted_at);
      assert.equal(store.getReason(fTerm.file_id), "expired");
      assert.equal(fs.existsSync(store.blobPath(fTerm.file_id)), false);
      assert.equal(store.get(fActive.file_id).deleted_at, null);
      assert.ok(fs.existsSync(store.blobPath(fActive.file_id)));
      assert.equal((await bus.listRecords(bus.tables.parts)).length, partsBefore);

      // 定时器单轮出错只记日志不抛异常，且 stop 可清掉定时器
      const badRetention = new FileRetentionService({
        fileStore: store,
        bus: {
          tables: DEFAULT_TABLES,
          async listRecords() {
            throw new Error("boom");
          },
        },
        log: (m) => logs.push(m),
      });
      badRetention.start({ initialDelayMs: 10, intervalMs: 1000 });
      await new Promise((r) => setTimeout(r, 40));
      badRetention.stop();
      assert.ok(logs.some((l) => l.includes("文件清理失败") && l.includes("boom")));
    } finally {
      store.close();
      bus.close();
    }
  });
});

test("LocalFileClient、HttpFileClient、createFileClient 与 guessMime", async () => {
  assert.equal(guessMime("/tmp/photo.PNG"), "image/png");
  assert.equal(guessMime("/tmp/doc.md"), "text/markdown");
  assert.equal(guessMime("/tmp/unknown.xyz"), "application/octet-stream");

  await withTemp(async (rootDir) => {
    const srcFile = path.join(rootDir, "report.json");
    const content = Buffer.from(JSON.stringify({ ok: true, msg: "附件往返" }));
    fs.writeFileSync(srcFile, content);

    const store = new FileStore({ configDir: rootDir, maxBytes: 4096 });
    const broker = new LongPollBroker({ initialSeq: 0 });
    const bus = new SqliteBus({
      dbPath: path.join(rootDir, "hub.db"),
      tables: DEFAULT_TABLES,
      broker,
    });
    const apiToken = "client-test-token";
    const httpHandle = await startHubHttpServer({
      cfg: { node: "hub", configDir: rootDir, listen: "127.0.0.1:0", apiToken },
      bus,
      broker,
      fileStore: store,
      log: () => {},
    });

    try {
      // 1) LocalFileClient via createFileClient
      const localClient = createFileClient({ busType: "sqlite", fileStore: store });
      assert.ok(localClient instanceof LocalFileClient);
      const m1 = await localClient.upload(srcFile);
      assert.equal(m1.mime, "application/json");
      assert.equal(m1.sha256, sha256Hex(content));

      const localDest = path.join(rootDir, "out", "local.json");
      const d1 = await localClient.download(m1.uri, localDest);
      assert.equal(d1.size, content.length);
      assert.equal(d1.mime, "application/json");
      assert.deepEqual(fs.readFileSync(localDest), content);
      assert.equal(fs.statSync(localDest).mode & 0o777, 0o600);

      await assert.rejects(
        () => localClient.download("hub://files/F-" + "0".repeat(32), localDest),
        (err) => err.code === "NOT_FOUND",
      );

      // 2) HttpFileClient via createFileClient
      const httpClient = createFileClient({
        busType: "http",
        hubUrl: httpHandle.localUrl,
        apiToken,
        delaysMs: [0, 10],
      });
      assert.ok(httpClient instanceof HttpFileClient);
      const m2 = await httpClient.upload(srcFile);
      assert.equal(m2.mime, "application/json");
      assert.equal(m2.sha256, sha256Hex(content));

      const httpDest = path.join(rootDir, "out", "http.json");
      const d2 = await httpClient.download(m2.uri, httpDest);
      assert.equal(d2.size, content.length);
      assert.equal(d2.mime, "application/json");
      assert.deepEqual(fs.readFileSync(httpDest), content);

      await assert.rejects(
        () => httpClient.download("hub://files/F-" + "1".repeat(32), httpDest),
        (err) => err.code === "NOT_FOUND",
      );

      store.markDeleted(m2.file_id, "expired");
      await assert.rejects(
        () => httpClient.download(m2.uri, httpDest),
        (err) => err.code === "EXPIRED" && err.status === 410,
      );
      await assert.rejects(
        () => localClient.download(m2.uri, localDest),
        (err) => err.code === "EXPIRED" && err.status === 410,
      );

      // 3) HttpFileClient 上传超过 maxBytes 直接 413 不重试
      const tooBigFile = path.join(rootDir, "too-big.bin");
      fs.writeFileSync(tooBigFile, Buffer.alloc(5000, 0x78));
      await assert.rejects(
        () => httpClient.upload(tooBigFile),
        (err) => err.status === 413,
      );
    } finally {
      await httpHandle.close();
      store.close();
      bus.close();
    }

    // 4) startHubHttpServer 不传 fileStore 时按 cfg.configDir 自动创建并随 close 关闭
    const autoDir = path.join(rootDir, "auto-hub");
    fs.mkdirSync(autoDir, { recursive: true });
    const autoBroker = new LongPollBroker({ initialSeq: 0 });
    const autoBus = new SqliteBus({
      dbPath: path.join(autoDir, "hub.db"),
      tables: DEFAULT_TABLES,
      broker: autoBroker,
    });
    const autoHandle = await startHubHttpServer({
      cfg: { node: "hub", configDir: autoDir, listen: "127.0.0.1:0" },
      bus: autoBus,
      broker: autoBroker,
      log: () => {},
    });
    try {
      assert.ok(autoHandle.fileStore instanceof FileStore);
      const up = await fetch(`${autoHandle.localUrl}/api/v1/files`, {
        method: "POST",
        body: Buffer.from("auto-store"),
      });
      assert.equal(up.status, 201);
    } finally {
      await autoHandle.close();
      autoBus.close();
    }
  });
});

test("HttpFileClient 退避策略：4xx（除 429）不重试，503/429 自动重试成功", async () => {
  await withTemp(async (rootDir) => {
    const srcFile = path.join(rootDir, "a.txt");
    fs.writeFileSync(srcFile, "retry-body");

    let uploadCalls = 0;
    let downloadCalls = 0;
    let mode = "503-then-ok";

    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/v1/files") {
        uploadCalls += 1;
        req.resume();
        req.on("end", () => {
          if (mode === "400") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "bad request" }));
            return;
          }
          if (uploadCalls === 1) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "busy" }));
            return;
          }
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ file_id: "F-" + "a".repeat(32), uri: "hub://files/F-" + "a".repeat(32) }));
        });
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/api/v1/files/")) {
        downloadCalls += 1;
        if (downloadCalls === 1) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "rate limited" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok-data");
      }
    });

    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const client = new HttpFileClient({
      hubUrl: `http://127.0.0.1:${port}`,
      apiToken: "tok",
      delaysMs: [0, 5, 5],
      log: () => {},
    });

    try {
      const up = await client.upload(srcFile);
      assert.equal(uploadCalls, 2);
      assert.equal(up.file_id, "F-" + "a".repeat(32));

      const dest = path.join(rootDir, "dl.txt");
      const dl = await client.download(up.uri, dest);
      assert.equal(downloadCalls, 2);
      assert.equal(fs.readFileSync(dest, "utf8"), "ok-data");
      assert.equal(dl.size, 7);

      mode = "400";
      uploadCalls = 0;
      await assert.rejects(() => client.upload(srcFile), (err) => err.status === 400);
      assert.equal(uploadCalls, 1);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test("agent-access：所有 agent 角色均放行三条文件路由，并阻断 X-A2A-Node 冒充", () => {
  for (const role of ["worker", "leader", "hybrid"]) {
    const principal = { kind: "agent", node: `n-${role}`, role, scopes: [] };
    assert.doesNotThrow(() =>
      assertAgentRoute(principal, { method: "POST", pathname: "/api/v1/files", headers: {} }),
    );
    assert.doesNotThrow(() =>
      assertAgentRoute(principal, {
        method: "GET",
        pathname: `/api/v1/files/F-${"a".repeat(32)}`,
        headers: {},
      }),
    );
    assert.doesNotThrow(() =>
      assertAgentRoute(principal, {
        method: "GET",
        pathname: `/api/v1/files/F-${"a".repeat(32)}/meta`,
        headers: {},
      }),
    );
    assert.throws(
      () => assertAgentRoute(principal, {
        method: "POST",
        pathname: "/api/v1/files",
        headers: { "x-a2a-node": "other-node" },
      }),
      (err) => err.status === 403,
    );
  }
});
