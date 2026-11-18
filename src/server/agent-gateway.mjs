// 外部 HTTP Agent 轻量接入网关（A2A 协议对齐）。
// 让云端或无常驻守护进程的纯 Agent（如 Muse、Grok Bot）仅凭标准 HTTP 请求（短轮询 / 长轮询），
// 即可完成名片注册、取单认领、心跳续约、提问/动态审批挂起与恢复、结果回执交付，
// 同时支持 Leader Agent 异步派单并拉取全网任务状态更新。

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acceptanceFromParts, parseCriteria } from "../acceptance.mjs";
import { pickSignedDecision, publicKeyOf } from "../approval-sign.mjs";
import { f1 } from "../bus/tables.mjs";
import { capIdOf } from "../config.mjs";
import { agentCanSeeTask, assertAgentRoute } from "../hub/agent-access.mjs";
import { admissionOf, httpError, validateNodeName } from "../hub/admission.mjs";
import { rosterNodeVisible } from "./longpoll-broker.mjs";
import { submitAgentReceipt } from "../inbox.mjs";
import { DAEMON_VERSION } from "../kernel.mjs";

const LEADER_UPDATE_STATUSES = new Set([
  "completed",
  "failed",
  "rejected",
  "canceled",
  "input-required",
  "auth-required",
]);

// 这两态还等着 Leader 处理，不能因为水位已经走过就藏起来。
const LEADER_PENDING_STATUSES = new Set(["input-required", "auth-required"]);

// SqliteBus 用 meta 表持久化水位。没有 getMeta/setMeta 的总线（测试 Mock、旧客户端）退回进程内 Map。
const watermarkFallback = new Map();

function changedSeqOf(task, taskMsgs) {
  let max = Number(task?.seq) || 0;
  if (!Number.isFinite(max) || max < 0) max = 0;
  for (const m of taskMsgs || []) {
    const s = Number(m?.seq) || 0;
    if (s > max) max = s;
  }
  return max;
}

function updatesWatermarkKey(node) {
  return `updates_watermark:${node}`;
}

function busHasMeta(bus) {
  return typeof bus?.getMeta === "function" && typeof bus?.setMeta === "function";
}

async function readUpdatesWatermark(bus, node) {
  if (busHasMeta(bus)) {
    const n = Number(await bus.getMeta(updatesWatermarkKey(node)));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  return watermarkFallback.get(node) ?? 0;
}

async function writeUpdatesWatermark(bus, node, seq) {
  if (busHasMeta(bus)) {
    await bus.setMeta(updatesWatermarkKey(node), String(seq));
    return;
  }
  watermarkFallback.set(node, seq);
}

function selectLeaderUpdates(updates, since) {
  if (since == null) return updates;
  return updates.filter((u) => LEADER_PENDING_STATUSES.has(u.status) || u.changed_seq > since);
}

// 机主用 query role，缺省 worker 与 leader 都算。Agent Token 只用绑定角色，避免用查询参数扩权。
function checkScopeOf(principal, searchParams) {
  if (principal?.kind === "agent") {
    const role = principal.role === "leader" || principal.role === "hybrid" ? principal.role : "worker";
    return {
      role,
      worker: role === "worker" || role === "hybrid",
      leader: role === "leader" || role === "hybrid",
    };
  }
  const raw = String(searchParams?.get("role") ?? "").trim().toLowerCase();
  if (!raw) return { role: "hybrid", worker: true, leader: true };
  if (raw !== "worker" && raw !== "leader" && raw !== "hybrid") {
    throw httpError(400, "role 只能是 worker / leader / hybrid");
  }
  return {
    role: raw,
    worker: raw === "worker" || raw === "hybrid",
    leader: raw === "leader" || raw === "hybrid",
  };
}

// 2×2 四类 Skill 目录：控制端/执行端 × 有 ah CLI / 纯 HTTP，避免向工作机或云端 Agent 下发无关指令
const SKILL_CATALOG = [
  { name: "ah", role: "leader", mode: "cli", audience: "装有 ah CLI 的 Hub / 工作机中控 Agent" },
  { name: "ah-inbox", role: "worker", mode: "cli", audience: "本机独立 Agent（kind=agent + ah inbox）" },
  { name: "a2a-leader", role: "leader", mode: "http", audience: "无 ah CLI 的纯 HTTP 控制端（如云端 Muse Leader）" },
  { name: "a2a-worker", role: "worker", mode: "http", audience: "无 ah CLI 的纯 HTTP 执行端（如云端 Grok Bot）" },
];
const SKILL_BY_NAME = new Map(SKILL_CATALOG.map((item) => [item.name, item]));
const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
// 检查脚本是通用文件，不内嵌 Token。Hub 只按文件名白名单读出原文。
const KIT_DIR = path.join(SKILLS_DIR, "a2a-check");
const KIT_FILES = new Map([
  ["a2a_check.py", "a2a_check.py"],
  ["a2a_check.sh", "a2a_check.sh"],
]);

function nowIso() {
  return new Date().toISOString();
}

function nowMinute() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function parseJson(raw, fallback = null) {
  if (raw && typeof raw === "object") return raw;
  const s = String(raw ?? "").trim();
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

function msgTail(id) {
  const m = String(id ?? "").match(/-(\d+)$/);
  return m ? Number(m[1]) : -1;
}

function nextSuffix(ids, re) {
  let max = 0;
  for (const id of ids) {
    const m = String(id ?? "").match(re);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

function approvalVerifyKey(cfg, approval) {
  const configured = String(cfg?.hubPublicKey ?? "").trim();
  if (configured) return configured;
  if (approval?.signKey) {
    try { return publicKeyOf(approval.signKey); } catch { return ""; }
  }
  return "";
}

function groupByTask(messages, parts, artifacts) {
  const msgByTask = new Map();
  const partsByParent = new Map();
  const artsByTask = new Map();

  for (const m of messages) {
    const tid = f1(m, "Task_ID");
    if (!tid) continue;
    if (!msgByTask.has(tid)) msgByTask.set(tid, []);
    msgByTask.get(tid).push(m);
  }
  for (const list of msgByTask.values()) {
    list.sort((a, b) => msgTail(f1(a, "Msg_ID")) - msgTail(f1(b, "Msg_ID")));
  }

  for (const p of parts) {
    const pid = f1(p, "Parent_ID");
    if (!pid) continue;
    if (!partsByParent.has(pid)) partsByParent.set(pid, []);
    partsByParent.get(pid).push(p);
  }
  for (const list of partsByParent.values()) {
    list.sort((a, b) => (Number(f1(a, "Seq")) || 0) - (Number(f1(b, "Seq")) || 0));
  }

  for (const a of artifacts) {
    const tid = f1(a, "Task_ID");
    if (!tid) continue;
    if (!artsByTask.has(tid)) artsByTask.set(tid, []);
    artsByTask.get(tid).push(a);
  }

  return { msgByTask, partsByParent, artsByTask };
}

function messageTextAndData(msgId, partsByParent) {
  const list = partsByParent.get(msgId) ?? [];
  const texts = [];
  const data = {};
  for (const p of list) {
    const kind = f1(p, "Kind");
    if (kind === "text") {
      const t = String(f1(p, "Text") ?? "");
      if (t) texts.push(t);
    } else if (kind === "data") {
      const parsed = parseJson(f1(p, "Data"), null);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.assign(data, parsed);
      }
    }
  }
  return { text: texts.join("\n"), data };
}

function instructionOfTask(taskMsgs, partsByParent) {
  const instr = taskMsgs.find((m) => f1(m, "Kind") === "instruction");
  if (!instr) return { fromNode: "", text: "", params: {}, criteria: [], msgId: "" };
  const msgId = f1(instr, "Msg_ID");
  const { text, data } = messageTextAndData(msgId, partsByParent);
  const parsed = parseCriteria(data);
  return {
    msgId,
    fromNode: String(f1(instr, "From_Node") ?? "").trim(),
    text,
    params: data,
    criteria: parsed.ok ? parsed.criteria : [],
  };
}

function signedDecisionFor(taskId, taskMsgs, partsByParent, requestId, verifyKey) {
  const candidates = taskMsgs
    .filter((m) =>
      f1(m, "Kind") === "auth_decision"
      && f1(m, "From_Node") === "hub"
      && f1(m, "Role") === "user"
      && f1(m, "In_Reply_To") === requestId)
    .slice()
    .reverse();

  const packed = candidates.map((m) => {
    const { data } = messageTextAndData(f1(m, "Msg_ID"), partsByParent);
    return { decision: String(data.decision ?? ""), sig: data.sig };
  });
  return pickSignedDecision(verifyKey, taskId, requestId, packed);
}

function preflightAuthRequest(taskMsgs, partsByParent) {
  for (const m of taskMsgs) {
    if (f1(m, "Kind") !== "auth_request") continue;
    const { data } = messageTextAndData(f1(m, "Msg_ID"), partsByParent);
    if (data?.scope === "dynamic") continue;
    return m;
  }
  return null;
}

function buildTaskBrief(task, taskMsgs, partsByParent, artsByTask) {
  const taskId = f1(task, "Task_ID");
  const instr = instructionOfTask(taskMsgs, partsByParent);
  const fromNode = instr.fromNode || String(f1(task, "Source") ?? "").trim();

  const latestOf = (kind) => {
    for (let i = taskMsgs.length - 1; i >= 0; i--) {
      if (f1(taskMsgs[i], "Kind") === kind) {
        const mid = f1(taskMsgs[i], "Msg_ID");
        return { msg_id: mid, created_at: f1(taskMsgs[i], "Created_At"), ...messageTextAndData(mid, partsByParent) };
      }
    }
    return null;
  };

  const resultMsg = latestOf("result");
  const questionMsg = latestOf("question");
  const authReqMsg = latestOf("auth_request");
  const noticeMsg = latestOf("notice");
  const metadata = parseJson(f1(task, "Metadata"), {});

  let acceptance = null;
  if (resultMsg) {
    const acc = acceptanceFromParts(partsByParent.get(resultMsg.msg_id) ?? []);
    if (acc) acceptance = acc;
  }
  if (!acceptance && metadata?.acceptance) {
    acceptance = metadata.acceptance;
  }

  const artifacts = (artsByTask.get(taskId) ?? []).map((a) => {
    const artId = f1(a, "Artifact_ID");
    const files = (partsByParent.get(artId) ?? [])
      .filter((p) => f1(p, "Kind") === "file")
      .map((p) => ({
        file_uri: f1(p, "File_URI"),
        file_name: f1(p, "File_Name"),
        mime_type: f1(p, "Mime_Type"),
      }));
    return {
      artifact_id: artId,
      name: f1(a, "Name"),
      description: f1(a, "Description"),
      is_final: f1(a, "Is_Final"),
      files,
    };
  });

  return {
    task_id: taskId,
    title: f1(task, "Title"),
    status: f1(task, "Status"),
    from_node: fromNode,
    source: f1(task, "Source"),
    target_node: f1(task, "Target_Node"),
    worker_hint: f1(task, "Worker_Hint"),
    skill_id: f1(task, "Skill_ID"),
    approval_class: f1(task, "Approval_Class") || "auto",
    claimed_by: f1(task, "Claimed_By"),
    heartbeat_at: f1(task, "Heartbeat_At"),
    context_id: f1(task, "Context_ID"),
    status_msg: f1(task, "Status_Msg"),
    latest_run: f1(task, "Latest_Run"),
    instruction: instr.text,
    params: instr.params,
    criteria: instr.criteria,
    result_text: resultMsg?.text || "",
    question_text: questionMsg?.text || "",
    auth_text: authReqMsg?.text || "",
    notice_text: noticeMsg?.text || "",
    acceptance,
    artifacts,
  };
}

async function ensurePreflightAuth({ bus, task, taskMsgs, partsByParent, verifyKey, onWake }) {
  const taskId = f1(task, "Task_ID");
  const reqMsg = preflightAuthRequest(taskMsgs, partsByParent);
  if (reqMsg) {
    const reqId = f1(reqMsg, "Msg_ID");
    const decision = signedDecisionFor(taskId, taskMsgs, partsByParent, reqId, verifyKey);
    if (decision === "approve") return { ready: true, decision };
    if (decision === "reject" || decision === "deny") return { ready: false, rejected: true, decision };
    if (f1(task, "Status") === "submitted") {
      await bus.updateRecord(bus.tables.tasks, task.record_id, {
        Status: "auth-required",
        Status_Msg: reqId,
      });
      onWake();
    }
    return { ready: false, pending: true, requestId: reqId };
  }

  // 尚未写认领前审批请求：写入 auth_request 并置为 auth-required，让机主在 Web 控制台点批准并签名。
  const nextSeq = nextSuffix(taskMsgs.map((m) => f1(m, "Msg_ID")), /-(\d+)$/);
  const reqId = `MSG-${taskId.replace(/^TASK-/, "")}-${String(nextSeq).padStart(2, "0")}`;
  const instr = instructionOfTask(taskMsgs, partsByParent);
  const cap = f1(task, "Skill_ID") || "agent";
  const body = ["需机主批准后执行", `能力：${cap}`, instr.text || f1(task, "Title") || taskId]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);

  await bus.createRecord(bus.tables.messages, {
    Msg_ID: reqId,
    Task_ID: taskId,
    Context_ID: f1(task, "Context_ID"),
    From_Node: f1(task, "Target_Node"),
    To_Node: "hub",
    Role: "agent",
    Kind: "auth_request",
    Created_At: nowMinute(),
  }, `agent-preflight-auth-${taskId}`);

  await bus.createRecord(bus.tables.parts, {
    Part_ID: `${reqId}-P1`,
    Parent_ID: reqId,
    Parent_Type: "message",
    Seq: 1,
    Kind: "text",
    Text: body,
  }, `agent-preflight-auth-p1-${taskId}`);

  await bus.updateRecord(bus.tables.tasks, task.record_id, {
    Status: "auth-required",
    Status_Msg: reqId,
  });
  onWake();
  return { ready: false, pending: true, requestId: reqId };
}

async function claimTaskForNode({ bus, node, taskId, worker = "", verifyKey, onWake }) {
  const [tasks, messages, parts] = await Promise.all([
    bus.listRecords(bus.tables.tasks),
    bus.listRecords(bus.tables.messages),
    bus.listRecords(bus.tables.parts),
  ]);
  const task = tasks.find((t) => f1(t, "Task_ID") === taskId);
  if (!task) throw httpError(404, `任务不存在：${taskId}`);
  const target = f1(task, "Target_Node");
  if (target !== node) throw httpError(403, `任务目标节点是 ${target}，不是 ${node}`);

  const { msgByTask, partsByParent } = groupByTask(messages, parts, []);
  const taskMsgs = msgByTask.get(taskId) ?? [];
  const st = f1(task, "Status");
  const claimedBy = f1(task, "Claimed_By");

  if (st === "working") {
    if (claimedBy !== node) throw httpError(409, `任务已被 ${claimedBy} 认领`);
    const instr = instructionOfTask(taskMsgs, partsByParent);
    return {
      ok: true,
      already_claimed: true,
      task_id: taskId,
      status: "working",
      run_id: f1(task, "Latest_Run"),
      instruction: instr.text,
      params: instr.params,
      criteria: instr.criteria,
    };
  }

  if (st === "submitted") {
    if (f1(task, "Approval_Class") === "approve") {
      const gate = await ensurePreflightAuth({ bus, task, taskMsgs, partsByParent, verifyKey, onWake });
      if (gate.rejected) throw httpError(403, "审批已拒绝，不能执行该任务");
      if (!gate.ready) throw httpError(409, "任务需机主批准后才能认领（已转为 auth-required）");
    }

    let runId = "";
    if (bus.tables.runs) {
      const runs = await bus.listRecords(bus.tables.runs);
      const mine = runs.filter((r) => f1(r, "Task_Ref") === taskId);
      runId = `${taskId}-R${nextSuffix(mine.map((r) => f1(r, "Run_ID")), /-R(\d+)$/)}`;
      await bus.createRecord(bus.tables.runs, {
        Run_ID: runId,
        Task_Ref: taskId,
        Node: node,
        Worker: worker || f1(task, "Worker_Hint") || "http-agent",
        Started_At: nowIso(),
      });
    }

    const updateFields = {
      Status: "working",
      Claimed_By: node,
      Heartbeat_At: nowIso(),
    };
    if (runId) updateFields.Latest_Run = runId;
    if (!f1(task, "Worker_Hint") && worker) updateFields.Worker_Hint = worker;
    await bus.updateRecord(bus.tables.tasks, task.record_id, updateFields);
    onWake();

    const instr = instructionOfTask(taskMsgs, partsByParent);
    return {
      ok: true,
      action: "execute",
      task_id: taskId,
      status: "working",
      run_id: runId,
      instruction: instr.text,
      params: instr.params,
      criteria: instr.criteria,
    };
  }

  if (st === "input-required") {
    if (claimedBy !== node) throw httpError(403, `任务当前归属 ${claimedBy}，不是 ${node}`);
    const statusMsg = String(f1(task, "Status_Msg") ?? "").trim();
    const answers = taskMsgs
      .filter((m) => f1(m, "Kind") === "answer" && (!statusMsg || f1(m, "In_Reply_To") === statusMsg))
      .map((m) => ({
        msg_id: f1(m, "Msg_ID"),
        from_node: f1(m, "From_Node"),
        created_at: f1(m, "Created_At"),
        ...messageTextAndData(f1(m, "Msg_ID"), partsByParent),
      }));
    if (!answers.length) throw httpError(409, "任务处于 input-required，尚无新答复");

    await bus.updateRecord(bus.tables.tasks, task.record_id, {
      Status: "working",
      Heartbeat_At: nowIso(),
    });
    onWake();
    const instr = instructionOfTask(taskMsgs, partsByParent);
    return {
      ok: true,
      action: "resume",
      resume_reason: "answer",
      task_id: taskId,
      status: "working",
      run_id: f1(task, "Latest_Run"),
      instruction: instr.text,
      params: instr.params,
      criteria: instr.criteria,
      answers,
    };
  }

  if (st === "auth-required") {
    if (claimedBy !== node) throw httpError(409, "任务仍在等待认领前机主审批");
    const statusMsg = String(f1(task, "Status_Msg") ?? "").trim();
    const decision = signedDecisionFor(taskId, taskMsgs, partsByParent, statusMsg, verifyKey);
    if (!decision) throw httpError(409, "任务仍在等待有效的 ed25519 审批决定");

    await bus.updateRecord(bus.tables.tasks, task.record_id, {
      Status: "working",
      Heartbeat_At: nowIso(),
    });
    onWake();
    const instr = instructionOfTask(taskMsgs, partsByParent);
    return {
      ok: true,
      action: "resume",
      resume_reason: "auth_decision",
      decision,
      task_id: taskId,
      status: "working",
      run_id: f1(task, "Latest_Run"),
      instruction: instr.text,
      params: instr.params,
      criteria: instr.criteria,
    };
  }

  throw httpError(409, `任务当前状态为 ${st}，不可认领`);
}

async function collectAgentMailbox({ bus, node, verifyKey, onWake, includeUpdates = true, touchPreflight = false }) {
  const [tasks, messages, parts, artifacts] = await Promise.all([
    bus.listRecords(bus.tables.tasks),
    bus.listRecords(bus.tables.messages),
    bus.listRecords(bus.tables.parts),
    bus.tables.artifacts ? bus.listRecords(bus.tables.artifacts) : Promise.resolve([]),
  ]);
  const { msgByTask, partsByParent, artsByTask } = groupByTask(messages, parts, artifacts);

  const actionable = [];
  const updates = [];
  // poll 的 actionable 不含仍在 working 的租约。检查接口要用同一趟扫描把它叫醒，避免再扫一遍表。
  const working = [];

  for (const task of tasks) {
    const taskId = f1(task, "Task_ID");
    const st = f1(task, "Status");
    const target = f1(task, "Target_Node");
    const claimed = f1(task, "Claimed_By");
    const taskMsgs = msgByTask.get(taskId) ?? [];

    if (target === node) {
      if (st === "submitted") {
        if (f1(task, "Approval_Class") === "approve") {
          const reqMsg = preflightAuthRequest(taskMsgs, partsByParent);
          const reqId = reqMsg ? f1(reqMsg, "Msg_ID") : "";
          const decision = reqId ? signedDecisionFor(taskId, taskMsgs, partsByParent, reqId, verifyKey) : null;
          if (decision === "approve") {
            actionable.push({ action: "execute", ...buildTaskBrief(task, taskMsgs, partsByParent, artsByTask) });
          } else if (touchPreflight && decision !== "reject" && decision !== "deny") {
            await ensurePreflightAuth({ bus, task, taskMsgs, partsByParent, verifyKey, onWake });
          }
        } else {
          actionable.push({ action: "execute", ...buildTaskBrief(task, taskMsgs, partsByParent, artsByTask) });
        }
      } else if (st === "input-required" && claimed === node) {
        const statusMsg = String(f1(task, "Status_Msg") ?? "").trim();
        const answers = taskMsgs
          .filter((m) => f1(m, "Kind") === "answer" && (!statusMsg || f1(m, "In_Reply_To") === statusMsg))
          .map((m) => ({
            msg_id: f1(m, "Msg_ID"),
            from_node: f1(m, "From_Node"),
            created_at: f1(m, "Created_At"),
            ...messageTextAndData(f1(m, "Msg_ID"), partsByParent),
          }));
        if (answers.length) {
          actionable.push({
            action: "resume",
            resume_reason: "answer",
            answers,
            ...buildTaskBrief(task, taskMsgs, partsByParent, artsByTask),
          });
        }
      } else if (st === "auth-required" && claimed === node) {
        const statusMsg = String(f1(task, "Status_Msg") ?? "").trim();
        const decision = statusMsg ? signedDecisionFor(taskId, taskMsgs, partsByParent, statusMsg, verifyKey) : null;
        if (decision) {
          actionable.push({
            action: "resume",
            resume_reason: "auth_decision",
            decision,
            ...buildTaskBrief(task, taskMsgs, partsByParent, artsByTask),
          });
        }
      }
    }

    if (target === node && st === "working" && claimed === node) {
      working.push(taskId);
    }

    if (includeUpdates && LEADER_UPDATE_STATUSES.has(st)) {
      const instr = instructionOfTask(taskMsgs, partsByParent);
      const initiator = instr.fromNode || f1(task, "Source");
      if (initiator === node) {
        updates.push(buildTaskBrief(task, taskMsgs, partsByParent, artsByTask));
      }
    }
  }

  return { actionable, updates, working };
}

// 与 GET updates 同一口径，含仍待处理的 input-required / auth-required。调用方决定要不要写水位。
async function listSelectableLeaderUpdates(bus, node, { wantedStatuses = LEADER_UPDATE_STATUSES, threshold = null } = {}) {
  const [tasks, messages, parts, artifacts] = await Promise.all([
    bus.listRecords(bus.tables.tasks),
    bus.listRecords(bus.tables.messages),
    bus.listRecords(bus.tables.parts),
    bus.tables.artifacts ? bus.listRecords(bus.tables.artifacts) : Promise.resolve([]),
  ]);
  const { msgByTask, partsByParent, artsByTask } = groupByTask(messages, parts, artifacts);
  const out = [];
  for (const task of tasks) {
    const st = f1(task, "Status");
    if (!wantedStatuses.has(st)) continue;
    const taskMsgs = msgByTask.get(f1(task, "Task_ID")) ?? [];
    const instr = instructionOfTask(taskMsgs, partsByParent);
    const initiator = instr.fromNode || f1(task, "Source");
    if (initiator !== node) continue;
    const brief = buildTaskBrief(task, taskMsgs, partsByParent, artsByTask);
    // 只取任务行和它的消息行。Parts 是另一张表，不能把无关写入算进这条任务的变更。
    out.push({ ...brief, changed_seq: changedSeqOf(task, taskMsgs) });
  }
  return selectLeaderUpdates(out.reverse(), threshold);
}

function normalizeChecksInput(raw) {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") {
    return Object.entries(raw).map(([id, v]) => {
      if (typeof v === "string") return { id, verdict: v, evidence: "" };
      return { id, verdict: v?.verdict ?? "", evidence: v?.evidence ?? "" };
    });
  }
  throw httpError(400, "checks 必须是数组或映射对象");
}

function mapInboxError(e) {
  if (e?.status) return e;
  const msg = String(e?.message ?? e);
  if (msg.includes("不存在")) return httpError(404, msg);
  if (msg.includes("认领者") || msg.includes("目标节点")) return httpError(403, msg);
  if (msg.includes("不是 working")) return httpError(409, msg);
  return httpError(400, msg);
}

export async function handleAgentGatewayRequest({
  req,
  res,
  reqUrl,
  pathname,
  method,
  bus,
  broker,
  approval,
  cfg,
  onWake = () => {},
  readJsonBody,
  sendJson,
  discoverOnly = false,
  principal = null,
} = {}) {
  const remoteAddr = req.socket?.remoteAddress || "";
  const verifyKey = approvalVerifyKey(cfg, approval);

  // 0) A2A Hub 元数据发现端点（免鉴权只读，不泄露密钥与任务内容）
  if (method === "GET" && pathname === "/.well-known/agent.json") {
    sendJson(res, 200, {
      name: cfg?.node || "a2a-hub",
      description: cfg?.nodeDesc || "A2A-Hub 独立多 Agent 编排中台",
      version: DAEMON_VERSION,
      protocol: "a2a-hub-http/v1",
      capabilities: {
        longPolling: true,
        shortPolling: true,
        streaming: false,
        approvals: "ed25519",
      },
      authentication: {
        type: cfg?.apiToken ? "bearer" : "none",
      },
      endpoints: {
        register: "/api/v1/agents/register",
        agents: "/api/v1/agents",
        poll: "/api/v1/agents/{node}/poll",
        inbox: "/api/v1/agents/{node}/inbox",
        updates: "/api/v1/agents/{node}/updates",
        tasks: "/api/v1/tasks",
        claim: "/api/v1/tasks/{taskId}/claim",
        heartbeat: "/api/v1/tasks/{taskId}/heartbeat",
        complete: "/api/v1/tasks/{taskId}/complete",
        ask: "/api/v1/tasks/{taskId}/ask",
        fail: "/api/v1/tasks/{taskId}/fail",
        auth: "/api/v1/tasks/{taskId}/auth",
        reply: "/api/v1/tasks/{taskId}/reply",
        cancel: "/api/v1/tasks/{taskId}/cancel",
        check: "/api/v1/agents/{node}/check",
        skills: "/api/v1/skills/{name}",
        checkScript: "/api/v1/kit/a2a_check.py",
        checkScriptShell: "/api/v1/kit/a2a_check.sh",
      },
    });
    return true;
  }
  if (discoverOnly) return false;

  // 路由矩阵与路径/查询/头里的节点身份。body 里的 node/from 由 http-server 读 body 时绑定。
  if (principal?.kind === "agent") {
    assertAgentRoute(principal, {
      method,
      pathname,
      searchParams: reqUrl.searchParams,
      headers: req.headers,
    });
  }

  // 0.5) 只读 Skill 模板分发（白名单校验，便于无 CLI 的云端 HTTP Agent 直接按角色拉取 SKILL.md）
  if (method === "GET" && pathname === "/api/v1/skills") {
    sendJson(res, 200, {
      skills: SKILL_CATALOG.map((item) => ({
        ...item,
        filename: `skills/${item.name}/SKILL.md`,
        url: `/api/v1/skills/${item.name}`,
      })),
    });
    return true;
  }

  const mSkill = pathname.match(/^\/api\/v1\/skills\/([^/]+)$/);
  if (method === "GET" && mSkill) {
    let rawName = "";
    try {
      rawName = decodeURIComponent(mSkill[1]).trim();
    } catch {
      throw httpError(404, "Skill 不存在");
    }
    const meta = SKILL_BY_NAME.get(rawName);
    if (!meta) throw httpError(404, `未知 Skill：${rawName}`);
    const filePath = path.join(SKILLS_DIR, meta.name, "SKILL.md");
    if (!fs.existsSync(filePath)) throw httpError(404, `Skill 文件缺失：${meta.name}`);
    const content = fs.readFileSync(filePath, "utf8");
    sendJson(res, 200, {
      ...meta,
      filename: `skills/${meta.name}/SKILL.md`,
      content,
    });
    return true;
  }

  const mKit = pathname.match(/^\/api\/v1\/kit\/([^/]+)$/);
  if (method === "GET" && mKit) {
    let rawName = "";
    try {
      rawName = decodeURIComponent(mKit[1]).trim();
    } catch {
      throw httpError(404, "脚本不存在");
    }
    const fileName = KIT_FILES.get(rawName);
    if (!fileName) throw httpError(404, "脚本不存在");
    const filePath = path.join(KIT_DIR, fileName);
    if (!fs.existsSync(filePath)) throw httpError(404, `脚本文件缺失：${fileName}`);
    const content = fs.readFileSync(filePath, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(content);
    return true;
  }

  // 1) 注册外部 HTTP Agent 名片与接入状态
  if (method === "POST" && pathname === "/api/v1/agents/register") {
    const body = await readJsonBody(req);
    const node = validateNodeName(body.node);
    const role = String(body.role ?? "worker").trim().toLowerCase() || "worker";
    const kind = String(body.kind ?? "agent").trim() || "agent";
    const zone = String(body.zone ?? "cloud").trim() || "cloud";
    const receiveMode = String(body.receive_mode ?? body.mode ?? "http-poll").trim() || "http-poll";
    const nodeDesc = String(body.node_desc ?? body.desc ?? "").trim();
    const version = String(body.version ?? "http-agent").trim();
    const capPrefix = String(body.cap_prefix ?? node).trim() || node;
    const worker = String(body.worker ?? "").trim();

    let capSpecs = Array.isArray(body.caps) ? body.caps : null;
    if (!capSpecs) {
      capSpecs = role === "leader"
        ? []
        : [{
            skill_id: "agent",
            skill_name: body.skill_name || `${node} Agent`,
            description: nodeDesc || `外部 HTTP Agent (${node})`,
            side_effect: body.side_effect || "write",
            approval_class: body.approval_class || "auto",
          }];
    }

    const existingCards = await bus.listRecords(bus.tables.agentCards);
    const saved = [];
    const admissionMap = {};
    for (const spec of capSpecs) {
      const skillId = String(spec?.skill_id ?? spec?.skill ?? "").trim();
      if (!skillId) throw httpError(400, "caps 每项必须包含 skill_id");
      const specWorker = String(spec?.worker ?? worker ?? "").trim();
      const capKey = specWorker ? `${specWorker}/${skillId}` : skillId;
      const capId = String(spec?.cap_id ?? "").trim()
        || capIdOf(capKey, { ...(specWorker ? { worker: specWorker, skill: skillId } : {}) }, capPrefix);

      // 绝不从 register 写 Admission / Display_Name / Admin_Note，保持机主接纳权与备注不被 Agent 自报覆盖。
      const fields = {
        Cap_ID: capId,
        Node: node,
        Worker: specWorker,
        Skill_ID: skillId,
        Skill_Name: String(spec?.skill_name ?? spec?.name ?? skillId),
        Description: String(spec?.description ?? spec?.desc ?? nodeDesc),
        Side_Effect: String(spec?.side_effect ?? "write"),
        Approval_Class: String(spec?.approval_class ?? "auto"),
        Availability: "online",
        Dispatchable: body.dispatchable === false || spec?.dispatchable === false ? "No" : "Yes",
        Receive_Mode: receiveMode,
        Daemon_Version: version,
        Node_Desc: nodeDesc,
        Zone: zone,
        Updated_At: nowMinute(),
        Metadata: JSON.stringify({ kind, role, mode: receiveMode, worker: specWorker }),
      };

      const match = existingCards.find((r) => f1(r, "Node") === node && f1(r, "Cap_ID") === capId);
      if (match) {
        const resUpd = await bus.updateRecord(bus.tables.agentCards, match.record_id, fields);
        const current = resUpd?.record ?? match;
        admissionMap[capId] = admissionOf(current);
        saved.push({ record_id: match.record_id, ...fields });
      } else {
        const resRec = await bus.createRecord(bus.tables.agentCards, fields);
        const created = resRec?.record;
        admissionMap[capId] = admissionOf(created ?? fields);
        saved.push({ record_id: created?.record_id ?? resRec?.record_id ?? "", ...fields });
      }
    }

    const pending = Object.values(admissionMap).some((v) => v !== "admitted");
    broker?.touchAgent?.(node, { remoteAddr, mode: receiveMode, kind, role });
    onWake();
    sendJson(res, 200, {
      ok: true,
      node,
      hub_node: cfg?.node || "hub",
      role,
      receive_mode: receiveMode,
      cards: saved,
      admission: admissionMap,
      pending,
    });
    return true;
  }

  // 2) 查询全网 Agent 与节点连接状态（合并名片 + LongPollBroker 在线态）
  if (method === "GET" && pathname === "/api/v1/agents") {
    const cards = await bus.listRecords(bus.tables.agentCards);
    const live = new Map((broker?.connectedNodes?.() ?? []).map((n) => [n.node, n]));
    const grouped = new Map();

    for (const [node, conn] of live.entries()) {
      grouped.set(node, {
        node,
        kind: conn.kind || "host",
        mode: conn.mode || "longpoll",
        role: conn.role || "",
        online: conn.online,
        polling: conn.polling,
        remote_addr: conn.remoteAddr,
        last_seen_at: conn.lastSeenAt,
        caps: [],
      });
    }

    for (const c of cards) {
      const node = f1(c, "Node") || "unknown";
      const conn = live.get(node);
      if (!grouped.has(node)) {
        grouped.set(node, {
          node,
          kind: parseJson(f1(c, "Metadata"), {})?.kind || "host",
          mode: f1(c, "Receive_Mode") || "event",
          role: parseJson(f1(c, "Metadata"), {})?.role || "worker",
          online: conn ? conn.online : String(f1(c, "Availability") ?? "").toLowerCase() !== "offline",
          polling: conn?.polling ?? false,
          remote_addr: conn?.remoteAddr || "",
          last_seen_at: conn?.lastSeenAt || null,
          caps: [],
        });
      }
      grouped.get(node).caps.push({
        cap_id: f1(c, "Cap_ID"),
        worker: f1(c, "Worker"),
        skill_id: f1(c, "Skill_ID"),
        skill_name: f1(c, "Skill_Name"),
        description: f1(c, "Description"),
        side_effect: f1(c, "Side_Effect"),
        approval_class: f1(c, "Approval_Class"),
        availability: f1(c, "Availability"),
        dispatchable: f1(c, "Dispatchable"),
        receive_mode: f1(c, "Receive_Mode"),
        zone: f1(c, "Zone"),
        admission: admissionOf(c),
      });
    }

    // 有名片的节点（含离线）保留。只藏无名片且超过 30 分钟没活动的探针记录。
    const agents = Array.from(grouped.values()).filter((agent) =>
      rosterNodeVisible({ lastSeenAt: agent.last_seen_at }, agent.caps.length > 0));
    sendJson(res, 200, { agents });
    return true;
  }

  // 2.5) 轻量检查。只读：不认领、不补预审、不推进 Leader 水位。唯一副作用是刷新在线状态。
  const checkMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/check$/);
  if (method === "GET" && checkMatch) {
    const node = validateNodeName(decodeURIComponent(checkMatch[1]));
    const scope = checkScopeOf(principal, reqUrl.searchParams);
    broker?.touchAgent?.(node, {
      remoteAddr,
      mode: "http-poll",
      kind: "agent",
      role: scope.role,
    });
    const payload = { work: false };
    if (scope.worker) {
      const mailbox = await collectAgentMailbox({
        bus,
        node,
        verifyKey,
        onWake,
        includeUpdates: false,
        touchPreflight: false,
      });
      payload.tasks = mailbox.actionable.map((item) => item.task_id);
      payload.working = mailbox.working;
      if (payload.tasks.length || payload.working.length) payload.work = true;
    }
    if (scope.leader) {
      const watermark = await readUpdatesWatermark(bus, node);
      const updates = await listSelectableLeaderUpdates(bus, node, { threshold: watermark });
      payload.updates = updates.length;
      if (payload.updates > 0) payload.work = true;
    }
    sendJson(res, 200, payload);
    return true;
  }

  // 3) 外部 Agent 短轮询 / 长轮询取单（支持 GET / POST poll 与 GET inbox）
  const pollMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/(poll|inbox)$/);
  if (pollMatch && (method === "GET" || (method === "POST" && pollMatch[2] === "poll"))) {
    const node = validateNodeName(decodeURIComponent(pollMatch[1]));
    const body = method === "POST" ? await readJsonBody(req) : {};
    const qTimeout = reqUrl.searchParams.get("timeout");
    const rawTimeout = body.timeout ?? (qTimeout != null ? Number(qTimeout) : 0);
    const timeoutMs = Number.isFinite(Number(rawTimeout))
      ? Math.max(0, Math.min(60, Number(rawTimeout))) * 1000
      : 0;
    const preCheckSeq = broker?.latestSeq ?? 0;
    const rawCursor = body.cursor ?? reqUrl.searchParams.get("cursor");
    const cursor = rawCursor != null && String(rawCursor).trim() !== "" && Number.isFinite(Number(rawCursor))
      ? Number(rawCursor)
      : preCheckSeq;
    const autoClaim = body.auto_claim === true || reqUrl.searchParams.get("auto_claim") === "true" || reqUrl.searchParams.get("auto_claim") === "1";
    const includeUpdates = body.include_updates !== false
      && reqUrl.searchParams.get("include_updates") !== "false"
      && reqUrl.searchParams.get("include_updates") !== "0";

    const modeHint = timeoutMs > 0 ? "longpoll" : "http-poll";
    broker?.touchAgent?.(node, { remoteAddr, mode: modeHint, kind: "agent" });

    let mailbox = await collectAgentMailbox({
      bus,
      node,
      verifyKey,
      onWake,
      includeUpdates,
      touchPreflight: true,
    });
    let wake = mailbox.actionable.length > 0 || (includeUpdates && mailbox.updates.length > 0);
    let nextCursor = broker?.latestSeq ?? cursor;

    if (!wake && timeoutMs > 0 && broker) {
      const ac = new AbortController();
      const onClose = () => ac.abort();
      req.on("close", onClose);
      try {
        const waitRes = await broker.wait({ node, cursor, timeoutMs, signal: ac.signal, remoteAddr });
        nextCursor = waitRes.cursor ?? nextCursor;
        if (waitRes.wake) {
          mailbox = await collectAgentMailbox({
            bus,
            node,
            verifyKey,
            onWake,
            includeUpdates,
            touchPreflight: true,
          });
          wake = true;
        }
      } finally {
        req.off("close", onClose);
      }
      broker.touchAgent(node, { remoteAddr, mode: modeHint, kind: "agent", cursor: nextCursor });
    }

    let finalTasks = mailbox.actionable;
    if (autoClaim && mailbox.actionable.length) {
      const claimed = [];
      for (const t of mailbox.actionable) {
        try {
          const resClaim = await claimTaskForNode({
            bus,
            node,
            taskId: t.task_id,
            worker: body.worker || "http-agent",
            verifyKey,
            onWake,
          });
          claimed.push({ ...t, ...resClaim, claimed: true });
        } catch {
          // 并发被抢占或仍待审批时跳过即可
        }
      }
      finalTasks = claimed;
    }

    if (!res.writableEnded) {
      sendJson(res, 200, {
        node,
        seq: broker?.latestSeq ?? 0,
        cursor: nextCursor,
        wake,
        count: finalTasks.length,
        tasks: finalTasks,
        ...(includeUpdates ? { updates: mailbox.updates } : {}),
      });
    }
    return true;
  }

  // 4) Leader Agent 关注发起的任务结果更新（completed / failed / input-required / auth-required / canceled）
  const updatesMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/updates$/);
  if (method === "GET" && updatesMatch) {
    const node = validateNodeName(decodeURIComponent(updatesMatch[1]));
    const rawTimeout = Number(reqUrl.searchParams.get("timeout") ?? 0);
    const timeoutMs = Number.isFinite(rawTimeout) ? Math.max(0, Math.min(60, rawTimeout)) * 1000 : 0;
    const preCheckSeq = broker?.latestSeq ?? 0;
    const rawCursor = reqUrl.searchParams.get("cursor");
    const cursor = rawCursor != null && String(rawCursor).trim() !== "" && Number.isFinite(Number(rawCursor))
      ? Number(rawCursor)
      : preCheckSeq;
    const statusParam = String(reqUrl.searchParams.get("status") ?? "").trim();
    const wantedStatuses = statusParam
      ? new Set(statusParam.split(",").map((s) => s.trim()).filter(Boolean))
      : LEADER_UPDATE_STATUSES;
    const sinceParam = reqUrl.searchParams.get("since");
    let since = null;
    if (sinceParam != null && sinceParam.trim() !== "") {
      since = Number(sinceParam);
      if (!Number.isFinite(since)) throw httpError(400, "since 必须是数字序号");
    }
    // new=1 用本节点已持久化的水位；显式 since 优先，避免和水位互相覆盖过滤条件。
    const useNew = reqUrl.searchParams.get("new") === "1";
    const storedWatermark = await readUpdatesWatermark(bus, node);
    const threshold = since != null ? since : (useNew ? storedWatermark : null);

    broker?.touchAgent?.(node, {
      remoteAddr,
      mode: timeoutMs > 0 ? "longpoll" : "http-poll",
      kind: "agent",
      role: "leader",
    });

    const queryUpdates = () => listSelectableLeaderUpdates(bus, node, { wantedStatuses, threshold });

    let list = await queryUpdates();
    let wake = list.length > 0;
    let nextCursor = broker?.latestSeq ?? cursor;
    if (!list.length && timeoutMs > 0 && broker) {
      const ac = new AbortController();
      const onClose = () => ac.abort();
      req.on("close", onClose);
      try {
        const waitRes = await broker.wait({ node, cursor, timeoutMs, signal: ac.signal, remoteAddr });
        nextCursor = waitRes.cursor ?? nextCursor;
        if (waitRes.wake) {
          list = await queryUpdates();
          wake = true;
        }
      } finally {
        req.off("close", onClose);
      }
      broker.touchAgent(node, { remoteAddr, mode: "longpoll", kind: "agent", role: "leader", cursor: nextCursor });
    }

    if (!res.writableEnded) {
      // 水位停在本次实际读到的最大 changed_seq，而不是 broker.latestSeq。
      // 读表之后才落库的写入序号更大，下一轮仍能看见。status 切片不推进，免得把没返回的终态跳过。
      let watermark = storedWatermark;
      if (useNew && !statusParam) {
        let peak = watermark;
        for (const u of list) {
          if (u.changed_seq > peak) peak = u.changed_seq;
        }
        if (peak > watermark) {
          await writeUpdatesWatermark(bus, node, peak);
          watermark = peak;
        }
      }
      sendJson(res, 200, {
        node,
        seq: broker?.latestSeq ?? 0,
        cursor: nextCursor,
        wake,
        count: list.length,
        watermark,
        updates: list,
      });
    }
    return true;
  }

  // 5) 任务列表筛选接口（便于 Agent 查单与对账）
  if (method === "GET" && pathname === "/api/v1/tasks") {
    const to = String(reqUrl.searchParams.get("to") ?? "").trim();
    const from = String(reqUrl.searchParams.get("from") ?? "").trim();
    const status = String(reqUrl.searchParams.get("status") ?? "").trim();
    const contextId = String(reqUrl.searchParams.get("context_id") ?? "").trim();
    const limit = Math.max(1, Math.min(500, Number(reqUrl.searchParams.get("limit") ?? 100) || 100));

    const [tasks, messages, parts, artifacts] = await Promise.all([
      bus.listRecords(bus.tables.tasks),
      bus.listRecords(bus.tables.messages),
      bus.listRecords(bus.tables.parts),
      bus.tables.artifacts ? bus.listRecords(bus.tables.artifacts) : Promise.resolve([]),
    ]);
    const { msgByTask, partsByParent, artsByTask } = groupByTask(messages, parts, artifacts);
    const out = [];
    for (let i = tasks.length - 1; i >= 0; i--) {
      const task = tasks[i];
      if (to && f1(task, "Target_Node") !== to) continue;
      if (status && f1(task, "Status") !== status) continue;
      if (contextId && f1(task, "Context_ID") !== contextId) continue;
      const taskMsgs = msgByTask.get(f1(task, "Task_ID")) ?? [];
      const brief = buildTaskBrief(task, taskMsgs, partsByParent, artsByTask);
      if (from && brief.from_node !== from && brief.source !== from) continue;
      // Agent 身份看不见与自己无关的任务；机主列表保持全量。
      if (!agentCanSeeTask(principal, brief.from_node, brief.source, brief.target_node)) continue;
      out.push(brief);
      if (out.length >= limit) break;
    }
    sendJson(res, 200, { count: out.length, tasks: out });
    return true;
  }

  // 6) 任务生命周期操作：claim / heartbeat / complete / fail / ask / auth
  const actionMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/(claim|heartbeat|complete|fail|ask|auth)$/);
  if (method === "POST" && actionMatch) {
    const taskId = decodeURIComponent(actionMatch[1]);
    const action = actionMatch[2];
    const body = await readJsonBody(req);
    const node = validateNodeName(body.node ?? req.headers["x-a2a-node"]);
    broker?.touchAgent?.(node, { remoteAddr, kind: "agent" });

    if (action === "claim") {
      const result = await claimTaskForNode({
        bus,
        node,
        taskId,
        worker: String(body.worker ?? "").trim(),
        verifyKey,
        onWake,
      });
      sendJson(res, 200, result);
      return true;
    }

    if (action === "heartbeat") {
      const tasks = await bus.listRecords(bus.tables.tasks);
      const task = tasks.find((t) => f1(t, "Task_ID") === taskId);
      if (!task) throw httpError(404, `任务不存在：${taskId}`);
      if (f1(task, "Target_Node") !== node || f1(task, "Claimed_By") !== node) {
        throw httpError(403, `任务当前不属于 ${node}`);
      }
      if (f1(task, "Status") !== "working") {
        throw httpError(409, `任务状态是 ${f1(task, "Status")}，无法续心跳`);
      }
      const hb = nowIso();
      await bus.updateRecord(bus.tables.tasks, task.record_id, { Heartbeat_At: hb });

      const progressText = String(body.text ?? "").trim();
      if (progressText) {
        const msgs = (await bus.listRecords(bus.tables.messages)).filter((m) => f1(m, "Task_ID") === taskId);
        const seq = nextSuffix(msgs.map((m) => f1(m, "Msg_ID")), /-(\d+)$/);
        const msgId = `MSG-${taskId.replace(/^TASK-/, "")}-${String(seq).padStart(2, "0")}`;
        await bus.createRecord(bus.tables.messages, {
          Msg_ID: msgId,
          Task_ID: taskId,
          Context_ID: f1(task, "Context_ID"),
          From_Node: node,
          To_Node: "hub",
          Role: "agent",
          Kind: "progress",
          Created_At: nowMinute(),
        });
        await bus.createRecord(bus.tables.parts, {
          Part_ID: `${msgId}-P1`,
          Parent_ID: msgId,
          Parent_Type: "message",
          Seq: 1,
          Kind: "text",
          Text: progressText.slice(0, 4000),
        });
      }
      onWake();
      sendJson(res, 200, { ok: true, task_id: taskId, heartbeat_at: hb });
      return true;
    }

    const opMap = { complete: "done", fail: "fail", ask: "ask", auth: "auth" };
    const op = opMap[action];
    const text = String(body.text ?? (op === "fail" ? "execution failed" : "")).trim();
    if ((op === "ask" || op === "auth") && !text) {
      throw httpError(400, `${action} 必须提供非空 text`);
    }
    const checks = op === "done" ? normalizeChecksInput(body.checks) : undefined;
    try {
      const receipt = await submitAgentReceipt({
        bus,
        node,
        taskId,
        text,
        artifact: String(body.artifact ?? "").trim(),
        op,
        checks,
      });
      onWake();
      sendJson(res, 200, {
        ok: true,
        task_id: receipt.taskId,
        msg_id: receipt.msgId,
        status: receipt.status,
        run_id: receipt.runId || "",
        ...(receipt.artifactId ? { artifact_id: receipt.artifactId } : {}),
        ...receipt,
      });
    } catch (e) {
      throw mapInboxError(e);
    }
    return true;
  }

  return false;
}
