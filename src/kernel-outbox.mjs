// 命令完成后的 outbox：先落盘，再按缺补齐写表。失败不重跑。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { modelAuditOf } from "./receipt.mjs";
import { acceptanceLine } from "./acceptance.mjs";
import { planArtifactItem, uploadPendingItems } from "./attachments.mjs";
import { f1 } from "./bus/tables.mjs";
import { guessMime } from "./files-client.mjs";
import { parseHubFileUri } from "./hub/files.mjs";
import { TERMINAL_STATUSES, log, nowStr } from "./kernel-util.mjs";

function verifyFailedNoticeText(box) {
  const head = acceptanceLine(box.acceptance) || "验收未通过：verify 执行失败";
  const tail = String(box.verifyEvidence ?? "").trim();
  const tailBlock = tail ? `verify 输出：\n${tail}` : "";
  const rawSummary = String(box.res?.summary ?? "").trim();
  if (!rawSummary) {
    return [head, tailBlock].filter(Boolean).join("\n\n").slice(0, 4000);
  }
  // 保留首行与 verify 输出尾部，避免超长摘要把失败证据挤掉。
  const fixedLen = head.length + (tailBlock ? tailBlock.length + 4 : 0) + 12;
  const summaryBudget = Math.max(0, 4000 - fixedLen);
  const summary = rawSummary.length > summaryBudget ? rawSummary.slice(0, summaryBudget) : rawSummary;
  const summaryBlock = summary ? `执行方摘要：\n${summary}` : "";
  return [head, summaryBlock, tailBlock].filter(Boolean).join("\n\n").slice(0, 4000);
}

// 回执里的交付文件列表：优先 res.artifacts；只有旧的 res.artifact 字符串时等价于一个元素。
function receiptArtifactEntries(res) {
  if (Array.isArray(res?.artifacts) && res.artifacts.length) return res.artifacts;
  const one = String(res?.artifact ?? "").trim();
  return one ? [{ uri: one, ...(res?.artifact_name ? { name: String(res.artifact_name) } : {}) }] : [];
}

function noteSuffix(box) {
  return (box.artifacts ?? []).map((a) => a.note).filter(Boolean).map((n) => `\n（${n}）`).join("");
}

export const outboxMethods = {

  // 执行方写相对路径时，相对它的工作目录（commands.json 的 cwd，缺省配置目录），其次 runs/<Task_ID>。
  artifactBaseDirs(task) {
    const entry = this.commands?.[this.capKeyOf(task)] ?? {};
    const taskId = String(f1(task, "Task_ID") ?? "");
    const dirs = [entry.cwd || this.cfg.configDir];
    if (/^[\w-]+$/.test(taskId)) dirs.push(path.join(this.cfg.configDir, "runs", taskId));
    return dirs;
  },

  // 提交前先把本地存在的交付文件标成待上传（outbox 里记原路径与 upload_pending），不存在的保留原字符串。
  planBoxArtifacts(task, res) {
    const baseDirs = this.artifactBaseDirs(task);
    const items = receiptArtifactEntries(res).map((entry) => planArtifactItem(entry, baseDirs, true));
    for (const item of items) {
      if (!item.local_path && !/^[a-z][a-z0-9+.-]*:\/\//i.test(item.src)) {
        log(`交付文件不存在，保留原字符串：${item.src}`);
      }
    }
    return items;
  },

  // 缺 uri 的先上传，成功一项就把结果写回 outbox 文件；失败抛错，下一轮只补缺的。
  // 413 不重试：保留原字符串，说明追加到结果正文末尾，不能让任务永远卡住。
  async uploadBoxFiles(box) {
    const items = box.artifacts ?? [];
    if (!items.some((item) => item.upload_pending)) return;
    await uploadPendingItems(items, {
      getClient: () => this.getFileClient(),
      save: () => this.saveOutbox(box),
      log,
      tooLarge: "keep",
    });
  },

  artifactMime(item, name) {
    if (item.mime) return item.mime;
    const id = parseHubFileUri(item.uri);
    if (id) {
      try {
        const meta = this._fileClient?.store?.get(id);
        if (meta?.mime) return meta.mime;
      } catch { /* 取不到就按文件名猜 */ }
      return guessMime(name);
    }
    if (/^https?:\/\//i.test(item.uri)) return "application/octet-stream";
    return guessMime(name || item.uri);
  },

  outboxPath(taskId) {
    const id = String(taskId ?? "");
    if (!/^[\w-]+$/.test(id)) throw new Error("非法 Task_ID，拒绝写入 outbox");
    return path.join(this.cfg.configDir, "outbox", `${id}.json`);
  },

  readOutbox(taskId) {
    try {
      return JSON.parse(fs.readFileSync(this.outboxPath(taskId), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  },

  saveOutbox(box) {
    const dir = path.join(this.cfg.configDir, "outbox");
    fs.mkdirSync(dir, { recursive: true });
    const dest = this.outboxPath(box.taskId);
    const tmp = dest + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(box), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, dest);
    fs.chmodSync(dest, 0o600);
  },

  deleteOutbox(taskId) {
    try { fs.unlinkSync(this.outboxPath(taskId)); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  },

  async closeSettledOutbox(task, box, { dropped = false } = {}) {
    await this.noteUsageOnce(task, box);
    if (!dropped) await this.noteAcceptanceOnce(task, box);
    this.dropSession(box.taskId);
    this.deleteOutbox(box.taskId);
    this.clearRetry(box.taskId);
  },

  // 命令已经跑完就先落盘。之后任何写表失败都靠这份文件补齐，不再执行一次。
  beginOutbox(task, info) {
    const box = {
      model: modelAuditOf(f1(task, "Metadata")),
      taskId: f1(task, "Task_ID"),
      outcome: info.outcome,
      res: info.res ?? null,
      raw: info.raw ?? "",
      error: info.error ?? "",
      started: info.started,
      planned: false,
      artId: "",
      artifacts: info.res ? this.planBoxArtifacts(task, info.res) : [],
      runId: info.runId || "",
      msgId: "",
      usage: Object.prototype.hasOwnProperty.call(info, "usage") ? (info.usage ?? null) : (info.res?.usage ?? null),
      usage_noted: false,
      acceptance: info.acceptance ?? null,
      acceptance_noted: false,
      verifyEvidence: info.verifyEvidence ?? "",
      tokens: {
        artifact: randomUUID(),
        artifactPart: randomUUID(),
        message: randomUUID(),
        partText: randomUUID(),
        partData: randomUUID(),
      },
    };
    this.saveOutbox(box);
    return box;
  },

  async findBy(table, field, value) {
    if (!value) return null;
    if (table === this.T.messages || table === this.T.parts) {
      const idx = await this.roundIndex();
      const rows = table === this.T.messages ? idx.messages : idx.parts;
      return rows.find((r) => f1(r, field) === value) ?? null;
    }
    const rows = await this.bus.listRecords(table);
    return rows.find((r) => f1(r, field) === value) ?? null;
  },

  // 升级前落盘的 outbox 只有 res.artifact，补成单元素数组（不探测本地文件，保持旧行为）。
  legacyBoxArtifacts(box) {
    const items = receiptArtifactEntries(box.res).map((entry) => planArtifactItem(entry, [], false));
    if (items[0] && box.artId) {
      items[0].artId = box.artId;
      items[0].tokens = { artifact: box.tokens?.artifact, artifactPart: box.tokens?.artifactPart };
    }
    return items;
  },

  async ensurePlan(task, box) {
    box.tokens ??= {};
    let dirty = false;
    for (const k of ["artifact", "artifactPart", "message", "partText", "partData"]) {
      if (!box.tokens[k]) {
        box.tokens[k] = randomUUID();
        dirty = true;
      }
    }
    if (!Array.isArray(box.artifacts)) {
      box.artifacts = this.legacyBoxArtifacts(box);
      dirty = true;
    }
    if (box.planned && box.runId && box.msgId) {
      if (dirty) this.saveOutbox(box);
      return box;
    }
    const taskId = box.taskId || f1(task, "Task_ID");
    const msgs = await this.listMessages(taskId);
    const arts = (await this.bus.listRecords(this.T.artifacts)).filter((a) => f1(a, "Task_ID") === taskId);
    if (!box.artifacts?.length) box.artId = "";
    else {
      // 每个文件一条 Artifact（<Task_ID>-A<n> 递增）；编号与 token 随 outbox 固化，补齐重试时不重复建。
      let n = this.nextSuffix(arts.map((a) => f1(a, "Artifact_ID")), /-A(\d+)$/);
      box.artifacts.forEach((item, idx) => {
        if (item.artId) return;
        item.artId = idx === 0 && box.artId ? box.artId : `${taskId}-A${n++}`;
        item.tokens = idx === 0
          ? { artifact: box.tokens.artifact, artifactPart: box.tokens.artifactPart }
          : { artifact: randomUUID(), artifactPart: randomUUID() };
      });
      box.artId = box.artifacts[0].artId;
    }
    if (!box.runId) {
      box.runId = this.nextRunId(task, msgs);
    }
    if (!box.msgId) {
      const seq = this.nextMsgSeq(msgs);
      box.msgId = `MSG-${String(taskId).replace("TASK-", "")}-${String(seq).padStart(2, "0")}`;
    }
    box.planned = true;
    this.saveOutbox(box);
    return box;
  },

  async ensureArtifact(task, box) {
    const items = box.artifacts ?? [];
    for (const item of items) {
      if (!item.artId) continue;
      // 单个未上传的产物沿用旧命名（技能名）；上传过的文件或多文件用真实文件名。
      const fallback = items.length === 1 && !item.local_path
        ? (f1(task, "Skill_ID") || "result")
        : path.basename(item.src || item.uri);
      const name = String(item.name || fallback);
      if (!(await this.findBy(this.T.artifacts, "Artifact_ID", item.artId))) {
        await this.bus.createRecord(this.T.artifacts, {
          Artifact_ID: item.artId, Task_ID: box.taskId, Context_ID: f1(task, "Context_ID"),
          Name: name, Description: String(box.res?.summary ?? "").slice(0, 500),
          Is_Final: box.outcome === "succeeded" ? "Yes" : "No", Created_By: this.cfg.node, Created_At: nowStr(),
        }, item.tokens.artifact);
      }
      await this.createPart(item.artId, "artifact", 1, "file", {
        fileUri: String(item.uri ?? ""), fileName: name, mime: this.artifactMime(item, name),
      }, item.tokens.artifactPart);
    }
  },

  async ensureResultMessage(task, box) {
    const failed = box.outcome !== "succeeded";
    const content = box.outcome === "verify_failed"
      ? verifyFailedNoticeText(box)
      : failed
        ? `回执无法解析，任务终止且不重试。原因：${box.error || "未知"}${box.raw ? "\n原始输出：" + box.raw : ""}`.slice(0, 4000)
        : (() => {
          const note = noteSuffix(box);
          return String(box.res?.summary ?? "").slice(0, 4000 - note.length) + note;
        })();
    if (!(await this.findBy(this.T.messages, "Msg_ID", box.msgId))) {
      const fields = {
        Msg_ID: box.msgId, Task_ID: box.taskId, Context_ID: f1(task, "Context_ID"),
        From_Node: this.cfg.node, To_Node: await this.initiatorOf(task), Role: "agent",
        Kind: failed ? "notice" : "result",
        Artifact_Ref: box.artId || "", In_Reply_To: "", Created_At: nowStr(),
      };
      const created = await this.bus.createRecord(this.T.messages, fields, box.tokens.message);
      this._remember(this.T.messages, this._asRow(fields, created));
    }
    if (content) {
      await this.createPart(box.msgId, "message", 1, "text", { text: content }, box.tokens.partText);
    }
    if (box.acceptance || box.model) {
      await this.createPart(box.msgId, "message", 2, "data", {
        data: JSON.stringify({ ...(box.acceptance ? { acceptance: box.acceptance } : {}), ...(box.model ? { model: box.model } : {}) }),
      }, box.tokens.partData);
    }
  },

  // Artifacts → Messages/Parts → Tasks。任一步失败都留着 outbox，下次只补缺的。
  async submitOutbox(task, box) {
    box = await this.ensurePlan(task, box);
    const current = await this.bus.getRecord(this.T.tasks, task.record_id);
    if (!current) throw new Error("任务行不存在 " + box.taskId);
    const st = f1(current, "Status");
    const want = box.outcome === "succeeded" ? "completed" : "failed";
    if (TERMINAL_STATUSES.has(st) && st !== want) {
      log(`outbox drop ${box.taskId}: terminal ${st}`);
      await this.closeSettledOutbox(current, box, { dropped: true });
      return;
    }
    // 终态冲突已处理完才上传，免得替一张已被取消的单白传一遍。
    await this.uploadBoxFiles(box);
    await this.ensureArtifact(current, box);
    await this.ensureResultMessage(current, box);
    if (st === want) {
      await this.closeSettledOutbox(current, box);
      return;
    }
    const fields = box.outcome === "succeeded"
      ? { Status: "completed", Heartbeat_At: "", Status_Msg: "" }
      : { Status: "failed", Heartbeat_At: "" };
    // submitted 时认领可能已被清掉，不能要求 Claimed_By；working 仍由 taskForWrite 核对所有权。
    const ok = await this.updateTaskState(current, fields, ["working", "submitted"], false);
    if (!ok) {
      const again = await this.bus.getRecord(this.T.tasks, task.record_id);
      const st2 = f1(again, "Status");
      if (st2 === want) {
        await this.closeSettledOutbox(again, box);
        return;
      }
      if (TERMINAL_STATUSES.has(st2)) {
        log(`outbox drop ${box.taskId}: terminal ${st2}`);
        await this.closeSettledOutbox(again, box, { dropped: true });
        return;
      }
      throw new Error(`状态未写入（当前 ${st2 || "missing"}），保留 outbox`);
    }
    await this.closeSettledOutbox(current, box);
    log(`${want} ${box.taskId} -> ${box.runId}`);
  },

  async flushOutbox() {
    const dir = path.join(this.cfg.configDir, "outbox");
    let names;
    try { names = fs.readdirSync(dir); }
    catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const taskId = name.slice(0, -".json".length);
      let box;
      try { box = this.readOutbox(taskId); }
      catch (e) {
        log(`outbox 读失败 ${taskId}: ${e.message}`);
        continue;
      }
      if (!box) continue;
      try {
        const tasks = await this.bus.listRecords(this.T.tasks);
        const task = tasks.find((t) => f1(t, "Task_ID") === taskId);
        if (!task) {
          log("outbox 找不到任务，保留文件 " + taskId);
          continue;
        }
        await this.submitOutbox(task, box);
      } catch (e) {
        log(`outbox 补齐失败 ${taskId}: ${e.message}`);
      }
    }
  },

  // 已有 result 但缺正文时不能当成交付关单，也不能因此再执行一遍。
  async repairLooseResult(task) {
    const taskId = f1(task, "Task_ID");
    if (this.readOutbox(taskId)) return false;
    const msgs = await this.listMessages(taskId);
    const result = this.latestMsg(msgs.filter((m) => f1(m, "Kind") === "result"));
    if (!result) return false;
    const parts = await this.listParts(f1(result, "Msg_ID"));
    const hasBody = parts.some((p) => f1(p, "Kind") === "text" && String(f1(p, "Text") ?? "") !== "");
    if (!hasBody) {
      log(`warning: result ${f1(result, "Msg_ID")} 缺 Parts，且无 outbox，不关单也不重跑 ${taskId}`);
      return true;
    }
    if (f1(task, "Status") === "completed") {
      this.clearRetry(taskId);
      return true;
    }
    if (!(await this.updateTaskState(task, { Status: "completed" }, ["submitted", "working"], f1(task, "Status") === "working"))) {
      return true;
    }
    this.clearRetry(taskId);
    log("reconciled completed " + taskId);
    return true;
  },
};
