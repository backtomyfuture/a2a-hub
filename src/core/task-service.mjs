// 唯一权威的任务状态机引擎（A2A 八态模型）。
// 统一处理单/多节点派单、幂等去重、认领租约、上下文历史汇总、Chase 提问回复、
// Ed25519 审批签名放行与 Leader 增量水位消费；全部状态变更都在单事务中完成。

import { actorCanAccessFile } from "../server/auth.mjs";
import { randomId } from "../store/db.mjs";
import { extractHubFileId } from "../store/files.mjs";
import { controlKeysIn, clampTimeoutSec, MAX_RETRIES, STALE_MIN } from "./config.mjs";
import { signDecision } from "./approval-sign.mjs";

export const A2A_STATES = new Set([
  "submitted",
  "working",
  "input-required",
  "auth-required",
  "completed",
  "failed",
  "canceled",
  "rejected",
]);

export const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "rejected"]);
export const FAILED_STATES = new Set(["failed", "rejected"]);
export const RETRYABLE_TERMINAL_STATES = new Set(["failed", "rejected", "canceled"]);

const ALLOWED_TRANSITIONS = {
  submitted: new Set(["working", "auth-required", "canceled", "rejected"]),
  working: new Set(["completed", "failed", "submitted", "input-required", "auth-required", "canceled"]),
  "input-required": new Set(["submitted", "canceled"]),
  "auth-required": new Set(["submitted", "rejected", "canceled"]),
  completed: new Set([]),
  failed: new Set([]),
  canceled: new Set([]),
  rejected: new Set([]),
};

export function canTransition(from, to) {
  return Boolean(ALLOWED_TRANSITIONS[from]?.has(to));
}

function makeError(message, statusCode = 400, code = "bad_request") {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

export class TaskService {
  constructor(store, { approvalPrivateKey = null, defaultLeaseSec = 300 } = {}) {
    this.store = store;
    this.approvalPrivateKey = approvalPrivateKey;
    this.defaultLeaseSec = defaultLeaseSec;
  }

  setApprovalPrivateKey(privateKey) {
    this.approvalPrivateKey = privateKey;
  }

  _resolveAttachments(rawAttachments, { actor = null, fromNode = "owner" } = {}) {
    const items = (Array.isArray(rawAttachments) ? rawAttachments : rawAttachments ? [rawAttachments] : []).filter(Boolean);
    if (!items.length) return { attachments: [], fileIds: [] };

    const effectiveActor =
      actor || (String(fromNode) === "owner" ? { kind: "owner", id: "owner" } : { kind: "agent", id: String(fromNode) });
    const normalized = [];
    const fileIds = new Set();

    for (const item of items) {
      const fileId = extractHubFileId(item);
      if (fileId) {
        const meta = this.store.getFileMeta(fileId);
        if (!meta) {
          throw makeError(`附件不存在或已过期: ${fileId}`, 404, "file_not_found");
        }
        if (!actorCanAccessFile(effectiveActor, meta, this.store)) {
          throw makeError(`无权引用该附件: ${fileId}`, 403, "file_forbidden");
        }
        const customName = typeof item === "object" && item?.name ? String(item.name).trim().slice(0, 200) : "";
        normalized.push({
          id: meta.id,
          uri: `hub://files/${meta.id}`,
          name: customName || meta.name,
          mime: meta.mime,
          size: meta.size,
          sha256: meta.sha256,
          download_path: `/api/v1/files/${meta.id}`,
        });
        fileIds.add(meta.id);
      } else if (typeof item === "string") {
        const uri = item.trim();
        if (!uri) continue;
        normalized.push({
          uri,
          name: uri.split("/").pop()?.slice(0, 200) || "attachment",
        });
      } else if (typeof item === "object") {
        const out = {};
        if (item.uri) out.uri = String(item.uri);
        if (item.url) out.url = String(item.url);
        if (item.name) out.name = String(item.name).slice(0, 200);
        if (item.mime) out.mime = String(item.mime).slice(0, 120);
        if (Number.isFinite(Number(item.size))) out.size = Number(item.size);
        if (Object.keys(out).length > 0) normalized.push(out);
      }
    }

    return { attachments: normalized, fileIds: [...fileIds] };
  }

  // 构建同 Thread（context_id）的跨任务前序摘要，便于新接入的 Worker 或续接任务拿到完整前情。
  buildContextHistory(contextId, excludeTaskId = null, limit = 10) {
    const tasks = this.store.listTasks({ context_id: contextId, order: "asc", limit: 50 });
    const history = [];
    for (const t of tasks) {
      if (excludeTaskId && t.id === excludeTaskId) continue;
      if (!["completed", "failed", "input-required", "auth-required", "working"].includes(t.state)) continue;
      // 已标为「已处理 / 消红」的旧失败不再喂给后续 Agent，避免过期报错污染上下文
      if (FAILED_STATES.has(t.state) && t.resolved_at) continue;
      const summary = t.receipt?.summary || t.receipt?.text || t.error_message || "";
      // 同轮并发扇出下仍在执行且尚无产出的兄弟任务，不注入其他节点的上下文前情，避免浪费 Token 与身份串联
      if (t.state === "working" && !String(summary).trim()) continue;
      history.push({
        task_id: t.id,
        to_agent_id: t.to_agent_id,
        from_node: t.from_node,
        title: t.title,
        input_text: t.input_text,
        state: t.state,
        summary: String(summary).slice(0, 1200),
        created_at: t.created_at,
        completed_at: t.completed_at,
      });
    }
    return history.slice(-limit);
  }

  getTaskDetail(taskId, { includeContextHistory = true } = {}) {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    const messages = this.store.listMessages(taskId);
    const context_history = includeContextHistory ? this.buildContextHistory(task.context_id, task.id) : [];
    return { ...task, messages, context_history };
  }

  // 派单（支持单目标 to: "id" 与多目标扇出 to: ["a", "b"]，共享同一个 context_id）
  dispatchTasks({
    fromNode = "owner",
    to,
    title = "",
    inputText = "",
    params = {},
    attachments = [],
    actor = null,
    model = "",
    priority = 5,
    contextId = "",
    parentTaskId = null,
    source = "direct",
    scheduleId = null,
    touchScheduleRunAt = true,
    idempotencyKey = "",
    timeoutSec,
    maxRetries = MAX_RETRIES,
  } = {}) {
    const targetsRaw = Array.isArray(to) ? to : to ? [to] : [];
    const targets = [...new Set(targetsRaw.map((x) => String(x || "").trim()).filter(Boolean))];
    if (!targets.length) {
      throw makeError("必须至少指定一个目标 Agent (to)", 400, "missing_target");
    }

    const forbidden = controlKeysIn(params);
    if (forbidden.length) {
      throw makeError(`任务参数严禁包含执行控制字段: ${forbidden.join(", ")}`, 400, "exec_control_key_forbidden");
    }

    const scope = `dispatch:${fromNode}`;
    if (idempotencyKey) {
      const cached = this.store.getIdempotency(scope, idempotencyKey);
      if (cached) return { ...cached, idempotent: true };
    }

    const finalContextId = String(contextId || "").trim() || randomId("ctx");
    const safePriority = Math.min(Math.max(Number(priority || 5), 1), 10);
    const safeTimeout = clampTimeoutSec(timeoutSec);
    const safeMaxRetries = Math.min(Math.max(Number(maxRetries ?? MAX_RETRIES), 0), 5);
    const now = Date.now();

    return this.store.transaction(() => {
      const { attachments: normalizedAttachments, fileIds } = this._resolveAttachments(attachments, { actor, fromNode });
      const created = [];
      for (const targetId of targets) {
        const agent = this.store.getAgent(targetId);
        if (!agent) {
          throw makeError(`目标 Agent 不存在: ${targetId}`, 404, "agent_not_found");
        }
        if (!agent.enabled) {
          throw makeError(`目标 Agent 已暂停: ${agent.name || targetId}`, 409, "agent_paused");
        }
        if (agent.device_id) {
          const dev = this.store.getDevice(agent.device_id);
          if (dev && !dev.enabled) {
            throw makeError(`目标设备已暂停: ${dev.name || dev.id}`, 409, "device_paused");
          }
        }

        const taskId = randomId("tsk");
        const requirePreflight = agent.approval_policy === "always" || Boolean(params?.require_approval);
        const initialState = requirePreflight ? "auth-required" : "submitted";
        const seq = this.store.nextSeq();
        const taskTitle = String(title || "").trim() || String(inputText || "").trim().slice(0, 80) || `Task -> ${agent.name}`;
        const chosenModel = String(model || agent.default_model || "").trim();

        this.store.db.prepare(`
          INSERT INTO tasks (
            id, context_id, parent_task_id, from_node, to_agent_id, title, input_text,
            params_json, attachments_json, model, state, priority, source, schedule_id,
            progress_json, receipt_json, error_message, retry_count, max_retries, timeout_sec,
            claimed_by, claimed_at, lease_until, leader_notified,
            created_at, updated_at, completed_at, changed_seq
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', NULL, NULL, 0, ?, ?, NULL, NULL, NULL, 0, ?, ?, NULL, ?)
        `).run(
          taskId,
          finalContextId,
          parentTaskId ? String(parentTaskId) : null,
          String(fromNode),
          agent.id,
          taskTitle,
          String(inputText || ""),
          JSON.stringify(params && typeof params === "object" ? params : {}),
          JSON.stringify(normalizedAttachments),
          chosenModel,
          initialState,
          safePriority,
          String(source || "direct"),
          scheduleId ? String(scheduleId) : null,
          safeMaxRetries,
          safeTimeout,
          now,
          now,
          seq
        );

        const dispatchMsg = this.store.appendMessage({
          task_id: taskId,
          context_id: finalContextId,
          from_node: String(fromNode),
          kind: "dispatch",
          body: String(inputText || taskTitle),
          data: {
            title: taskTitle,
            model: chosenModel,
            params: params && typeof params === "object" ? params : {},
            to_agent_id: agent.id,
          },
          attachments: normalizedAttachments,
          created_at: now,
        });

        for (const fid of fileIds) {
          this.store.linkFileToTask({
            fileId: fid,
            taskId,
            contextId: finalContextId,
            messageId: dispatchMsg.id,
            createdAt: now,
          });
        }

        let authRequestId = null;
        if (requirePreflight) {
          authRequestId = randomId("req");
          this.store.appendMessage({
            task_id: taskId,
            context_id: finalContextId,
            from_node: "hub",
            kind: "auth_request",
            body: `Agent「${agent.name}」配置为执行前需机主签名审批`,
            data: {
              request_id: authRequestId,
              reason: "预检审批策略（approval_policy=always）",
              risk_level: "preflight",
              title: taskTitle,
            },
            created_at: now,
          });
        }

        if (scheduleId) {
          this.store.recordScheduleTaskActivity(agent.id, scheduleId, {
            taskId,
            touchRunAt: Boolean(touchScheduleRunAt),
            clearAlert: true,
            contextId: finalContextId,
            now,
          });
        }

        const task = this.store.getTask(taskId);
        created.push(task);

        this.store.emitChange({
          type: requirePreflight ? "task.auth_required" : "task.created",
          seq,
          taskId,
          contextId: finalContextId,
          fromNode: String(fromNode),
          agentId: agent.id,
          deviceId: agent.device_id,
          state: initialState,
          title: taskTitle,
          reason: requirePreflight ? "执行前需机主签名确认" : undefined,
          messageId: dispatchMsg.id,
        });
      }

      const result = { context_id: finalContextId, tasks: created };
      if (idempotencyKey) {
        this.store.saveIdempotency(scope, idempotencyKey, result);
      }
      return result;
    });
  }

  claimNext({ agentIds, claimant, leaseSec = this.defaultLeaseSec } = {}) {
    const ids = [...new Set((Array.isArray(agentIds) ? agentIds : [agentIds]).map((x) => String(x || "").trim()).filter(Boolean))];
    if (!ids.length) return null;

    const placeholders = ids.map(() => "?").join(",");
    const selectSql = `
      SELECT t.* FROM tasks t
      JOIN agents a ON a.id = t.to_agent_id
      LEFT JOIN devices d ON d.id = a.device_id
      WHERE t.to_agent_id IN (${placeholders})
        AND t.state = 'submitted'
        AND a.enabled = 1
        AND (a.device_id IS NULL OR d.enabled = 1)
      ORDER BY t.priority DESC, t.created_at ASC
      LIMIT 1
    `;
    // 空队列先只读检查，避免每次空认领都开启一次 SQLite BEGIN IMMEDIATE 写事务
    if (!this.store._inTx) {
      const probe = this.store.db.prepare(
        `SELECT t.id FROM tasks t
         JOIN agents a ON a.id = t.to_agent_id
         LEFT JOIN devices d ON d.id = a.device_id
         WHERE t.to_agent_id IN (${placeholders})
           AND t.state = 'submitted'
           AND a.enabled = 1
           AND (a.device_id IS NULL OR d.enabled = 1)
         ORDER BY t.priority DESC, t.created_at ASC
         LIMIT 1`
      ).get(...ids);
      if (!probe) return null;
    }

    return this.store.transaction(() => {
      const candidate = this.store.db.prepare(selectSql).get(...ids);
      if (!candidate) return null;
      return this._claimRow(candidate, { claimant: claimant || candidate.to_agent_id, leaseSec });
    });
  }

  claimTaskById(taskId, { claimant, allowedAgentIds = null, leaseSec = this.defaultLeaseSec } = {}) {
    return this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT * FROM tasks WHERE id = ?").get(String(taskId));
      if (!row) throw makeError("任务不存在", 404, "task_not_found");
      if (Array.isArray(allowedAgentIds) && !allowedAgentIds.includes(row.to_agent_id)) {
        throw makeError("无权认领其他 Agent 的任务", 403, "forbidden");
      }
      const agent = this.store.getAgent(row.to_agent_id);
      if (agent && !agent.enabled) {
        throw makeError(`Agent 已暂停: ${agent.name}`, 409, "agent_paused");
      }
      if (row.state !== "submitted") {
        throw makeError(`任务当前状态为 ${row.state}，不可认领`, 409, "invalid_state");
      }
      return this._claimRow(row, { claimant: claimant || row.to_agent_id, leaseSec });
    });
  }

  _claimRow(row, { claimant, leaseSec }) {
    const now = Date.now();
    const safeLease = Math.min(Math.max(Number(leaseSec || this.defaultLeaseSec), 30), 3600);
    const leaseUntil = now + safeLease * 1000;
    const seq = this.store.nextSeq();

    const upd = this.store.db.prepare(`
      UPDATE tasks
      SET state = 'working', claimed_by = ?, claimed_at = ?, lease_until = ?, updated_at = ?, changed_seq = ?
      WHERE id = ? AND state = 'submitted'
    `).run(String(claimant), now, leaseUntil, now, seq, row.id);
    if (upd.changes === 0) {
      throw makeError("任务已被其他执行者认领", 409, "claim_conflict");
    }

    const ag = this.store.getAgent(row.to_agent_id);
    this.store.db.prepare("UPDATE agents SET active_task_id = ?, last_seen_at = ? WHERE id = ?")
      .run(row.id, now, row.to_agent_id);

    this.store.appendMessage({
      task_id: row.id,
      context_id: row.context_id,
      from_node: String(claimant),
      kind: "status",
      body: "claimed",
      data: { state: "working", lease_until: leaseUntil },
      created_at: now,
    });

    this.store.emitChange({
      type: "task.working",
      seq,
      taskId: row.id,
      contextId: row.context_id,
      fromNode: row.from_node,
      agentId: row.to_agent_id,
      deviceId: ag?.device_id ?? null,
      state: "working",
      title: row.title,
    });

    return this.getTaskDetail(row.id, { includeContextHistory: true });
  }

  heartbeat(taskId, { actorId, progress = {}, leaseSec = this.defaultLeaseSec } = {}) {
    return this.store.transaction(() => {
      const task = this.store.getTask(taskId);
      if (!task) throw makeError("任务不存在", 404, "task_not_found");
      if (task.state !== "working") {
        throw makeError(`任务状态为 ${task.state}，仅 working 支持心跳续约`, 409, "invalid_state");
      }
      const now = Date.now();
      const safeLease = Math.min(Math.max(Number(leaseSec || this.defaultLeaseSec), 30), 3600);
      const leaseUntil = now + safeLease * 1000;
      const mergedProgress = { ...(task.progress || {}), ...(progress && typeof progress === "object" ? progress : {}), updated_at: now };

      this.store.db.prepare(`
        UPDATE tasks SET lease_until = ?, progress_json = ?, updated_at = ? WHERE id = ?
      `).run(leaseUntil, JSON.stringify(mergedProgress), now, task.id);

      this.store.touchAgentSeen(actorId || task.to_agent_id, now);
      return this.store.getTask(task.id);
    });
  }

  ask(taskId, { actorId, prompt, choices = [], data = {} } = {}) {
    if (!String(prompt || "").trim()) {
      throw makeError("追问内容 prompt 不能为空", 400, "missing_prompt");
    }
    return this.store.transaction(() => {
      const task = this.store.getTask(taskId);
      if (!task) throw makeError("任务不存在", 404, "task_not_found");
      if (!canTransition(task.state, "input-required")) {
        throw makeError(`状态 ${task.state} 不允许转为 input-required`, 409, "invalid_state");
      }
      const now = Date.now();
      const seq = this.store.nextSeq();
      this.store.db.prepare(`
        UPDATE tasks SET state = 'input-required', lease_until = NULL, updated_at = ?, changed_seq = ? WHERE id = ?
      `).run(now, seq, task.id);
      this.store.db.prepare("UPDATE agents SET active_task_id = NULL WHERE id = ? AND active_task_id = ?")
        .run(task.to_agent_id, task.id);

      const ag = this.store.getAgent(task.to_agent_id);
      const msg = this.store.appendMessage({
        task_id: task.id,
        context_id: task.context_id,
        from_node: String(actorId || task.to_agent_id),
        kind: "question",
        body: String(prompt),
        data: { choices: Array.isArray(choices) ? choices : [], ...(data && typeof data === "object" ? data : {}) },
        created_at: now,
      });

      this.store.emitChange({
        type: "task.input_required",
        seq,
        taskId: task.id,
        contextId: task.context_id,
        fromNode: task.from_node,
        agentId: task.to_agent_id,
        deviceId: ag?.device_id ?? null,
        state: "input-required",
        title: task.title,
        prompt: String(prompt),
        messageId: msg.id,
      });
      return this.getTaskDetail(task.id, { includeContextHistory: false });
    });
  }

  requestAuth(taskId, { actorId, reason, commandPreview = "", riskLevel = "high", data = {} } = {}) {
    if (!String(reason || "").trim()) {
      throw makeError("审批原因 reason 不能为空", 400, "missing_reason");
    }
    return this.store.transaction(() => {
      const task = this.store.getTask(taskId);
      if (!task) throw makeError("任务不存在", 404, "task_not_found");
      if (!canTransition(task.state, "auth-required")) {
        throw makeError(`状态 ${task.state} 不允许转为 auth-required`, 409, "invalid_state");
      }
      const now = Date.now();
      const seq = this.store.nextSeq();
      const requestId = randomId("req");
      this.store.db.prepare(`
        UPDATE tasks SET state = 'auth-required', lease_until = NULL, updated_at = ?, changed_seq = ? WHERE id = ?
      `).run(now, seq, task.id);
      this.store.db.prepare("UPDATE agents SET active_task_id = NULL WHERE id = ? AND active_task_id = ?")
        .run(task.to_agent_id, task.id);

      const ag = this.store.getAgent(task.to_agent_id);
      const msg = this.store.appendMessage({
        task_id: task.id,
        context_id: task.context_id,
        from_node: String(actorId || task.to_agent_id),
        kind: "auth_request",
        body: String(reason),
        data: {
          request_id: requestId,
          reason: String(reason),
          command_preview: String(commandPreview || ""),
          risk_level: String(riskLevel || "high"),
          ...(data && typeof data === "object" ? data : {}),
        },
        created_at: now,
      });

      this.store.emitChange({
        type: "task.auth_required",
        seq,
        taskId: task.id,
        contextId: task.context_id,
        fromNode: task.from_node,
        agentId: task.to_agent_id,
        deviceId: ag?.device_id ?? null,
        state: "auth-required",
        title: task.title,
        reason: String(reason),
        messageId: msg.id,
      });
      return this.getTaskDetail(task.id, { includeContextHistory: false });
    });
  }

  complete(taskId, { actorId, summary = "", text = "", artifacts = [], data = {}, usage = null, attachments = [], actor = null } = {}) {
    return this.store.transaction(() => {
      const task = this.store.getTask(taskId);
      if (!task) throw makeError("任务不存在", 404, "task_not_found");
      if (!canTransition(task.state, "completed")) {
        throw makeError(`状态 ${task.state} 不允许转为 completed`, 409, "invalid_state");
      }
      const now = Date.now();
      const seq = this.store.nextSeq();
      const { attachments: normalizedAttachments, fileIds } = this._resolveAttachments(attachments, {
        actor,
        fromNode: actorId || task.to_agent_id,
      });
      const receipt = {
        summary: String(summary || text || "").slice(0, 600),
        text: String(text || summary || ""),
        artifacts: Array.isArray(artifacts) ? artifacts : [],
        attachments: normalizedAttachments,
        data: data && typeof data === "object" ? data : {},
        usage: usage || null,
        completed_by: String(actorId || task.to_agent_id),
      };

      this.store.db.prepare(`
        UPDATE tasks
        SET state = 'completed', receipt_json = ?, error_message = NULL, lease_until = NULL,
            completed_at = ?, updated_at = ?, changed_seq = ?
        WHERE id = ?
      `).run(JSON.stringify(receipt), now, now, seq, task.id);

      this.store.db.prepare("UPDATE agents SET active_task_id = NULL WHERE id = ? AND active_task_id = ?")
        .run(task.to_agent_id, task.id);

      // 仅自动消红同线程「更早轮次」（created_at 严格小于当前任务）的未处理失败，
      // 同轮并发扇出（created_at 相同）的兄弟失败绝不误消。
      this.store.db.prepare(`
        UPDATE tasks
        SET resolved_at = ?
        WHERE context_id = ? AND id != ? AND created_at < ?
          AND state IN ('failed', 'rejected') AND resolved_at IS NULL
      `).run(now, task.context_id, task.id, Number(task.created_at || 0));

      if (task.schedule_id) {
        const durationMs = task.created_at ? Math.max(0, now - Number(task.created_at)) : undefined;
        const failedSibling = this.store.hasFailedScheduleSiblingTask(task.schedule_id, task.context_id);
        this.store.recordScheduleTaskActivity(
          task.to_agent_id,
          task.schedule_id,
          failedSibling
            ? { touchRunAt: true, clearAlert: true, contextId: task.context_id, now }
            : {
                taskId: task.id,
                outcome: "completed",
                durationMs,
                touchRunAt: true,
                clearAlert: true,
                contextId: task.context_id,
                now,
              }
        );
      }

      const ag = this.store.getAgent(task.to_agent_id);
      const msg = this.store.appendMessage({
        task_id: task.id,
        context_id: task.context_id,
        from_node: String(actorId || task.to_agent_id),
        kind: "receipt",
        body: receipt.text || receipt.summary,
        data: receipt,
        attachments: normalizedAttachments,
        created_at: now,
      });

      for (const fid of fileIds) {
        this.store.linkFileToTask({
          fileId: fid,
          taskId: task.id,
          contextId: task.context_id,
          messageId: msg.id,
          createdAt: now,
        });
      }

      this.store.emitChange({
        type: "task.completed",
        seq,
        taskId: task.id,
        contextId: task.context_id,
        fromNode: task.from_node,
        agentId: task.to_agent_id,
        deviceId: ag?.device_id ?? null,
        state: "completed",
        title: task.title,
        summary: receipt.summary,
        messageId: msg.id,
      });

      return this.getTaskDetail(task.id, { includeContextHistory: false });
    });
  }

  // 供外部自管定时任务（driver='edge'）在失败、带附件或显式要求归档时单步写入终态记录（见 docs/standard.md §1 例外说明）。
  ingestScheduleTask({
    agentId,
    scheduleId,
    outcome = "completed",
    title = "",
    inputText = "",
    summary = "",
    text = "",
    error = "",
    data = {},
    artifacts = [],
    usage = null,
    attachments = [],
    contextId = "",
    durationMs = null,
    actor = null,
    now = Date.now(),
  } = {}) {
    const forbidden = controlKeysIn(data);
    if (forbidden.length) {
      throw makeError(`回执数据严禁包含执行控制字段: ${forbidden.join(", ")}`, 400, "exec_control_key_forbidden");
    }

    return this.store.transaction(() => {
      const agent = this.store.getAgent(agentId);
      if (!agent) {
        throw makeError(`Agent 不存在: ${agentId}`, 404, "agent_not_found");
      }

      const isFail = outcome === "failed";
      const state = isFail ? "failed" : "completed";
      const taskId = randomId("tsk");
      const finalContextId = String(contextId || "").trim() || randomId("ctx");
      const seq = this.store.nextSeq();
      const safeDuration =
        durationMs !== null && durationMs !== undefined && Number.isFinite(Number(durationMs)) && Number(durationMs) >= 0
          ? Math.trunc(Number(durationMs))
          : null;
      const createdAt = safeDuration !== null ? Math.max(1, now - safeDuration) : now;
      const taskTitle =
        String(title || "").trim() ||
        String(summary || text || error || "").trim().slice(0, 80) ||
        `[定时自报] ${scheduleId}`;

      const { attachments: normalizedAttachments, fileIds } = this._resolveAttachments(attachments, {
        actor,
        fromNode: agent.id,
      });

      const receipt = isFail
        ? null
        : {
            summary: String(summary || text || taskTitle).slice(0, 600),
            text: String(text || summary || taskTitle),
            artifacts: Array.isArray(artifacts) ? artifacts : [],
            attachments: normalizedAttachments,
            data: data && typeof data === "object" ? data : {},
            usage: usage || null,
            completed_by: agent.id,
          };
      const errText = isFail ? String(error || summary || "schedule_execution_failed") : null;

      this.store.db.prepare(`
        INSERT INTO tasks (
          id, context_id, parent_task_id, from_node, to_agent_id, title, input_text,
          params_json, attachments_json, model, state, priority, source, schedule_id,
          progress_json, receipt_json, error_message, retry_count, max_retries, timeout_sec,
          claimed_by, claimed_at, lease_until, leader_notified,
          created_at, updated_at, completed_at, changed_seq
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, '{}', ?, ?, ?, 5, 'edge_cron', ?, '{}', ?, ?, 0, 0, 600, ?, ?, NULL, 0, ?, ?, ?, ?)
      `).run(
        taskId,
        finalContextId,
        agent.id,
        agent.id,
        taskTitle,
        String(inputText || taskTitle),
        JSON.stringify(normalizedAttachments),
        agent.default_model || "",
        state,
        String(scheduleId),
        receipt ? JSON.stringify(receipt) : null,
        errText,
        agent.id,
        createdAt,
        createdAt,
        now,
        now,
        seq
      );

      const msg = this.store.appendMessage({
        task_id: taskId,
        context_id: finalContextId,
        from_node: agent.id,
        kind: isFail ? "error" : "receipt",
        body: isFail ? errText : (receipt.text || receipt.summary),
        data: isFail ? (data && typeof data === "object" ? data : {}) : receipt,
        attachments: normalizedAttachments,
        created_at: now,
      });

      for (const fid of fileIds) {
        this.store.linkFileToTask({
          fileId: fid,
          taskId,
          contextId: finalContextId,
          messageId: msg.id,
          createdAt: now,
        });
      }

      this.store.emitChange({
        type: isFail ? "task.failed" : "task.completed",
        seq,
        taskId,
        contextId: finalContextId,
        fromNode: agent.id,
        agentId: agent.id,
        deviceId: agent.device_id ?? null,
        state,
        title: taskTitle,
        ...(isFail ? { error: errText } : { summary: receipt.summary }),
        messageId: msg.id,
      });

      return this.getTaskDetail(taskId, { includeContextHistory: false });
    });
  }

  fail(taskId, { actorId, error = "execution_failed", retryable = false, data = {} } = {}) {
    return this.store.transaction(() => {
      const task = this.store.getTask(taskId);
      if (!task) throw makeError("任务不存在", 404, "task_not_found");
      if (!canTransition(task.state, "failed")) {
        throw makeError(`状态 ${task.state} 不允许标记失败`, 409, "invalid_state");
      }
      const now = Date.now();
      const seq = this.store.nextSeq();
      const errText = String(error || "execution_failed");
      const canRetry = Boolean(retryable) && Number(task.retry_count) < Number(task.max_retries);
      const ag = this.store.getAgent(task.to_agent_id);

      this.store.db.prepare("UPDATE agents SET active_task_id = NULL WHERE id = ? AND active_task_id = ?")
        .run(task.to_agent_id, task.id);

      if (canRetry) {
        const nextRetry = Number(task.retry_count) + 1;
        this.store.db.prepare(`
          UPDATE tasks
          SET state = 'submitted', retry_count = ?, error_message = ?, claimed_by = NULL,
              claimed_at = NULL, lease_until = NULL, updated_at = ?, changed_seq = ?
          WHERE id = ?
        `).run(nextRetry, errText, now, seq, task.id);

        const msg = this.store.appendMessage({
          task_id: task.id,
          context_id: task.context_id,
          from_node: String(actorId || task.to_agent_id),
          kind: "retry",
          body: errText,
          data: { retry_count: nextRetry, ...(data && typeof data === "object" ? data : {}) },
          created_at: now,
        });

        this.store.emitChange({
          type: "task.requeued",
          seq,
          taskId: task.id,
          contextId: task.context_id,
          fromNode: task.from_node,
          agentId: task.to_agent_id,
          deviceId: ag?.device_id ?? null,
          state: "submitted",
          title: task.title,
          messageId: msg.id,
        });
        return this.getTaskDetail(task.id, { includeContextHistory: false });
      }

      this.store.db.prepare(`
        UPDATE tasks
        SET state = 'failed', error_message = ?, lease_until = NULL, completed_at = ?, updated_at = ?, changed_seq = ?
        WHERE id = ?
      `).run(errText, now, now, seq, task.id);

      if (task.schedule_id) {
        this.store.recordScheduleTaskActivity(task.to_agent_id, task.schedule_id, {
          taskId: task.id,
          outcome: "failed",
          contextId: task.context_id,
          now,
        });
      }

      const msg = this.store.appendMessage({
        task_id: task.id,
        context_id: task.context_id,
        from_node: String(actorId || task.to_agent_id),
        kind: "error",
        body: errText,
        data: data && typeof data === "object" ? data : {},
        created_at: now,
      });

      this.store.emitChange({
        type: "task.failed",
        seq,
        taskId: task.id,
        contextId: task.context_id,
        fromNode: task.from_node,
        agentId: task.to_agent_id,
        deviceId: ag?.device_id ?? null,
        state: "failed",
        title: task.title,
        error: errText,
        messageId: msg.id,
      });
      return this.getTaskDetail(task.id, { includeContextHistory: false });
    });
  }

  reply(taskId, { fromNode = "owner", body = "", data = {}, attachments = [], actor = null } = {}) {
    if (!String(body || "").trim() && !attachments?.length) {
      throw makeError("回复内容不能为空", 400, "missing_body");
    }
    return this.store.transaction(() => {
      const task = this.store.getTask(taskId);
      if (!task) throw makeError("任务不存在", 404, "task_not_found");
      if (task.state !== "input-required") {
        throw makeError(`当前状态 ${task.state} 不可回复（仅 input-required 可补充回复）`, 409, "invalid_state");
      }
      const now = Date.now();
      const seq = this.store.nextSeq();
      const { attachments: normalizedAttachments, fileIds } = this._resolveAttachments(attachments, { actor, fromNode });
      this.store.db.prepare(`
        UPDATE tasks
        SET state = 'submitted', claimed_by = NULL, claimed_at = NULL, lease_until = NULL, updated_at = ?, changed_seq = ?
        WHERE id = ?
      `).run(now, seq, task.id);

      const ag = this.store.getAgent(task.to_agent_id);
      const msg = this.store.appendMessage({
        task_id: task.id,
        context_id: task.context_id,
        from_node: String(fromNode),
        kind: "answer",
        body: String(body || ""),
        data: data && typeof data === "object" ? data : {},
        attachments: normalizedAttachments,
        created_at: now,
      });

      for (const fid of fileIds) {
        this.store.linkFileToTask({
          fileId: fid,
          taskId: task.id,
          contextId: task.context_id,
          messageId: msg.id,
          createdAt: now,
        });
      }

      this.store.emitChange({
        type: "task.resumed",
        seq,
        taskId: task.id,
        contextId: task.context_id,
        fromNode: task.from_node,
        agentId: task.to_agent_id,
        deviceId: ag?.device_id ?? null,
        state: "submitted",
        title: task.title,
        messageId: msg.id,
      });
      return this.getTaskDetail(task.id, { includeContextHistory: false });
    });
  }

  decideApproval(taskId, { fromNode = "owner", decision, note = "", requestId = "", channel = "console", operator = "" } = {}) {
    const raw = String(decision || "").trim().toLowerCase();
    const normalized = ["approve", "approved", "allow", "yes"].includes(raw)
      ? "approved"
      : ["deny", "denied", "reject", "rejected", "no"].includes(raw)
        ? "rejected"
        : "";
    if (!normalized) {
      throw makeError("decision 必须是 approve 或 deny", 400, "invalid_decision");
    }
    if (!this.approvalPrivateKey) {
      throw makeError("Hub 审批签名私钥未就绪", 500, "missing_approval_key");
    }

    return this.store.transaction(() => {
      const task = this.store.getTask(taskId);
      if (!task) throw makeError("任务不存在", 404, "task_not_found");
      if (task.state !== "auth-required") {
        throw makeError(`当前状态 ${task.state} 无需审批`, 409, "invalid_state");
      }

      const msgs = this.store.listMessages(task.id);
      const lastAuthReq = [...msgs].reverse().find((m) => m.kind === "auth_request");
      const latestReqId = String(lastAuthReq?.data?.request_id || "default");
      // 外部渠道（链接、飞书卡片）可能拿着旧请求来点：只认最新一条审批请求，避免签出执行端验不过的决定。
      if (requestId && String(requestId) !== latestReqId) {
        throw makeError("该审批请求已过期，请处理最新的审批", 409, "stale_request");
      }
      const finalReqId = latestReqId;
      const signature = signDecision(this.approvalPrivateKey, {
        taskId: task.id,
        requestId: finalReqId,
        decision: normalized,
      });

      const now = Date.now();
      const seq = this.store.nextSeq();
      const nextState = normalized === "approved" ? "submitted" : "rejected";
      const ag = this.store.getAgent(task.to_agent_id);

      if (normalized === "approved") {
        this.store.db.prepare(`
          UPDATE tasks
          SET state = 'submitted', claimed_by = NULL, claimed_at = NULL, lease_until = NULL, updated_at = ?, changed_seq = ?
          WHERE id = ?
        `).run(now, seq, task.id);
      } else {
        this.store.db.prepare(`
          UPDATE tasks
          SET state = 'rejected', error_message = ?, lease_until = NULL, completed_at = ?, updated_at = ?, changed_seq = ?
          WHERE id = ?
        `).run(String(note || "机主拒绝审批"), now, now, seq, task.id);
        this.store.db.prepare("UPDATE agents SET active_task_id = NULL WHERE id = ? AND active_task_id = ?")
          .run(task.to_agent_id, task.id);
      }

      const msg = this.store.appendMessage({
        task_id: task.id,
        context_id: task.context_id,
        from_node: String(fromNode),
        kind: "auth_decision",
        body: note ? String(note) : normalized,
        data: {
          request_id: finalReqId,
          decision: normalized,
          note: String(note || ""),
          channel: String(channel || "console"),
          ...(operator ? { operator: String(operator) } : {}),
          signature,
        },
        signature,
        created_at: now,
      });

      this.store.emitChange({
        type: normalized === "approved" ? "task.resumed" : "task.rejected",
        seq,
        taskId: task.id,
        contextId: task.context_id,
        fromNode: task.from_node,
        agentId: task.to_agent_id,
        deviceId: ag?.device_id ?? null,
        state: nextState,
        title: task.title,
        messageId: msg.id,
      });

      return this.getTaskDetail(task.id, { includeContextHistory: false });
    });
  }

  cancel(taskId, { fromNode = "owner", reason = "" } = {}) {
    return this.store.transaction(() => {
      const task = this.store.getTask(taskId);
      if (!task) throw makeError("任务不存在", 404, "task_not_found");
      if (TERMINAL_STATES.has(task.state)) {
        throw makeError(`终态任务 (${task.state}) 不可取消`, 409, "terminal_task");
      }
      const now = Date.now();
      const seq = this.store.nextSeq();
      const ag = this.store.getAgent(task.to_agent_id);

      this.store.db.prepare(`
        UPDATE tasks
        SET state = 'canceled', error_message = ?, lease_until = NULL, completed_at = ?, updated_at = ?, changed_seq = ?
        WHERE id = ?
      `).run(String(reason || "canceled"), now, now, seq, task.id);

      this.store.db.prepare("UPDATE agents SET active_task_id = NULL WHERE id = ? AND active_task_id = ?")
        .run(task.to_agent_id, task.id);

      const msg = this.store.appendMessage({
        task_id: task.id,
        context_id: task.context_id,
        from_node: String(fromNode),
        kind: "cancel",
        body: String(reason || "已取消"),
        created_at: now,
      });

      this.store.emitChange({
        type: "task.canceled",
        seq,
        taskId: task.id,
        contextId: task.context_id,
        fromNode: task.from_node,
        agentId: task.to_agent_id,
        deviceId: ag?.device_id ?? null,
        state: "canceled",
        title: task.title,
        messageId: msg.id,
      });
      return this.getTaskDetail(task.id, { includeContextHistory: false });
    });
  }

  // ---- 机主处置闭环：消红（已处理）、一键重试与终态清理（不破坏 A2A 八态协议） ----

  resolveTask(taskId, { now = Date.now() } = {}) {
    return this.store.transaction(() => {
      const task = this.store.getTask(taskId);
      if (!task) throw makeError("任务不存在", 404, "task_not_found");
      if (!FAILED_STATES.has(task.state)) {
        throw makeError(`当前状态 ${task.state} 无需消红（仅失败或已拒绝任务可标为已处理）`, 409, "invalid_state");
      }
      if (task.resolved_at) {
        return { task, already_resolved: true };
      }
      this.store.db.prepare("UPDATE tasks SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL")
        .run(now, task.id);
      if (task.schedule_id) {
        this.store.db.prepare(`
          UPDATE schedules
          SET last_outcome = NULL, updated_at = ?
          WHERE id = ? AND last_task_id = ? AND last_outcome = 'failed'
        `).run(now, task.schedule_id, task.id);
      }
      // 仅通知 Web 控制台刷新，不改任务 changed_seq，不惊动 Agent / Webhook / Leader 水位
      const seq = this.store.nextSeq();
      this.store.emitChange({
        type: "task.resolved",
        seq,
        taskId: task.id,
        contextId: task.context_id,
      });
      return { task: this.store.getTask(task.id), already_resolved: false };
    });
  }

  resolveAllFailed({ contextId = null, sinceMs = null, now = Date.now() } = {}) {
    return this.store.transaction(() => {
      const cid = String(contextId || "").trim();
      const clauses = ["state IN ('failed', 'rejected')", "resolved_at IS NULL"];
      const args = [];
      if (cid) {
        clauses.push("context_id = ?");
        args.push(cid);
      }
      const safeSince =
        sinceMs !== null && sinceMs !== undefined && sinceMs !== "" && Number.isFinite(Number(sinceMs)) && Number(sinceMs) > 0
          ? Math.trunc(Number(sinceMs))
          : null;
      if (safeSince !== null) {
        clauses.push("updated_at >= ?");
        args.push(safeSince);
      }
      const where = clauses.join(" AND ");
      const matchedRows = this.store.db.prepare(`SELECT id FROM tasks WHERE ${where}`).all(...args);
      const matchedIds = matchedRows.map((r) => String(r.id));
      if (!matchedIds.length) {
        return { resolved_count: 0 };
      }

      const placeholders = matchedIds.map(() => "?").join(",");
      const res = this.store.db.prepare(`UPDATE tasks SET resolved_at = ? WHERE id IN (${placeholders})`)
        .run(now, ...matchedIds);
      const resolvedCount = Number(res.changes || 0);
      if (resolvedCount > 0) {
        // 仅清理 last_task_id 落入本次消红集合的定时条目，避免跨线程/跨时间窗误清无关定时状态
        this.store.db.prepare(`
          UPDATE schedules
          SET last_outcome = NULL, updated_at = ?
          WHERE last_outcome = 'failed' AND last_task_id IN (${placeholders})
        `).run(now, ...matchedIds);
        const seq = this.store.nextSeq();
        this.store.emitChange({
          type: "task.resolved",
          seq,
          ...(cid ? { contextId: cid } : {}),
        });
      }
      return { resolved_count: resolvedCount };
    });
  }

  retryTask(taskId, { fromNode = "owner", actor = null, inputText = undefined, to = undefined, model = undefined, now = Date.now() } = {}) {
    return this.store.transaction(() => {
      const task = this.store.getTask(taskId);
      if (!task) throw makeError("任务不存在", 404, "task_not_found");
      if (!RETRYABLE_TERMINAL_STATES.has(task.state)) {
        throw makeError(`当前状态 ${task.state} 不可重试（仅失败、已拒绝或已取消任务可重试）`, 409, "invalid_state");
      }
      // 原任务附带的临时中转文件若已过期则剔除并记录，调用方据此向机主明确提示，不静默丢失
      const validAttachments = [];
      const droppedAttachmentNames = [];
      for (const att of Array.isArray(task.attachments) ? task.attachments : []) {
        const fid = extractHubFileId(att);
        if (!fid) {
          validAttachments.push(att);
          continue;
        }
        if (this.store.getFileMeta(fid, now)) {
          validAttachments.push(att);
        } else {
          const name = typeof att === "object" && att?.name ? String(att.name) : fid;
          droppedAttachmentNames.push(name);
        }
      }

      // 机主手动重试视为机主接管重派（fromNode 默认 owner，不冒充原 Leader 发起）；
      // 若原任务归属定时条目，保留 schedule_id 关联但不修改跑批时钟（touchScheduleRunAt=false）。
      const dispatched = this.dispatchTasks({
        fromNode,
        to: to || task.to_agent_id,
        title: task.title,
        inputText: inputText !== undefined ? String(inputText) : task.input_text,
        params: task.params && typeof task.params === "object" ? task.params : {},
        attachments: validAttachments,
        actor,
        model: model !== undefined ? String(model) : task.model,
        priority: task.priority,
        contextId: task.context_id,
        parentTaskId: task.id,
        source: task.source || "direct",
        scheduleId: task.schedule_id || null,
        touchScheduleRunAt: false,
        timeoutSec: task.timeout_sec,
        maxRetries: task.max_retries,
      });

      if (FAILED_STATES.has(task.state) && !task.resolved_at) {
        this.store.db.prepare("UPDATE tasks SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL")
          .run(now, task.id);
        if (task.schedule_id) {
          this.store.db.prepare(`
            UPDATE schedules
            SET last_outcome = NULL, updated_at = ?
            WHERE id = ? AND last_outcome = 'failed' AND (agent_id = ? OR last_task_id = ?)
          `).run(now, task.schedule_id, task.to_agent_id, task.id);
        }
      }

      return {
        task: dispatched.tasks[0] || null,
        tasks: dispatched.tasks,
        context_id: dispatched.context_id,
        retried_from: task.id,
        dropped_attachments: droppedAttachmentNames.length,
        dropped_attachment_names: droppedAttachmentNames,
      };
    });
  }

  deleteTask(taskId) {
    return this.store.transaction(() => {
      const task = this.store.getTask(taskId);
      if (!task) throw makeError("任务不存在", 404, "task_not_found");
      if (!TERMINAL_STATES.has(task.state)) {
        throw makeError(`进行中或待处理的任务 (${task.state}) 不可删除，请先取消`, 409, "active_task_forbidden");
      }
      const now = Date.now();
      this.store.db.prepare("UPDATE files SET task_id = NULL WHERE task_id = ?").run(task.id);
      this.store.db.prepare(`
        UPDATE schedules
        SET last_task_id = NULL,
            last_outcome = CASE WHEN last_outcome = 'failed' THEN NULL ELSE last_outcome END,
            updated_at = ?
        WHERE last_task_id = ?
      `).run(now, task.id);
      this.store.db.prepare("UPDATE agents SET active_task_id = NULL WHERE active_task_id = ?").run(task.id);
      this.store.db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);

      const seq = this.store.nextSeq();
      this.store.emitChange({
        type: "task.deleted",
        seq,
        taskId: task.id,
        contextId: task.context_id,
      });
      return { deleted: true, task_id: task.id, context_id: task.context_id };
    });
  }

  deleteThread(contextId) {
    const cid = String(contextId || "").trim();
    if (!cid) throw makeError("缺少 context_id", 400, "missing_context_id");
    return this.store.transaction(() => {
      const rows = this.store.db.prepare("SELECT id, state FROM tasks WHERE context_id = ?").all(cid);
      if (!rows.length) throw makeError("Thread 不存在", 404, "thread_not_found");
      const active = rows.find((r) => !TERMINAL_STATES.has(r.state));
      if (active) {
        throw makeError(`该线程仍有未结束的任务 (${active.state})，请先取消后再删除`, 409, "active_thread_forbidden");
      }
      const now = Date.now();
      this.store.db.prepare("UPDATE files SET task_id = NULL WHERE task_id IN (SELECT id FROM tasks WHERE context_id = ?)").run(cid);
      this.store.db.prepare(`
        UPDATE schedules
        SET last_task_id = NULL,
            last_outcome = CASE WHEN last_outcome = 'failed' THEN NULL ELSE last_outcome END,
            updated_at = ?
        WHERE last_task_id IN (SELECT id FROM tasks WHERE context_id = ?)
      `).run(now, cid);
      this.store.db.prepare("UPDATE schedules SET pinned_context_id = NULL, updated_at = ? WHERE pinned_context_id = ?").run(now, cid);
      this.store.db.prepare("UPDATE agents SET active_task_id = NULL WHERE active_task_id IN (SELECT id FROM tasks WHERE context_id = ?)").run(cid);
      this.store.db.prepare("DELETE FROM tasks WHERE context_id = ?").run(cid);

      const seq = this.store.nextSeq();
      this.store.emitChange({
        type: "thread.deleted",
        seq,
        contextId: cid,
      });
      return { deleted: true, context_id: cid, deleted_tasks: rows.length };
    });
  }

  // 有明确租约的任务只看租约：慢速 Agent（如邮件驱动）无法频繁心跳，不能被 updated_at 兜底误回收后重复派发；
  // 仅无租约的 working 任务才用 STALE_MIN 兜底。
  reclaimStale(now = Date.now()) {
    const staleCutoff = now - STALE_MIN * 60_000;
    const staleRows = this.store.db.prepare(`
      SELECT * FROM tasks
      WHERE state = 'working' AND (
        (lease_until IS NOT NULL AND lease_until < ?)
        OR (lease_until IS NULL AND updated_at < ?)
      )
    `).all(now, staleCutoff);

    const reclaimed = [];
    for (const row of staleRows) {
      const canRetry = Number(row.retry_count) < Number(row.max_retries);
      const updated = this.fail(row.id, {
        actorId: "hub-stale-reaper",
        error: "task_lease_expired",
        retryable: canRetry,
      });
      reclaimed.push(updated);
    }
    return reclaimed;
  }

  // 审批挂起超过 timeoutMin 分钟自动拒绝，防止无人处理的任务一直占着线程。timeoutMin<=0 表示关闭。
  expireApprovals(timeoutMin, now = Date.now()) {
    const minutes = Number(timeoutMin);
    if (!Number.isFinite(minutes) || minutes <= 0) return [];
    const cutoff = now - minutes * 60_000;
    const rows = this.store.db.prepare(
      "SELECT id FROM tasks WHERE state = 'auth-required' AND updated_at < ?"
    ).all(cutoff);
    const expired = [];
    for (const row of rows) {
      try {
        expired.push(this.decideApproval(row.id, {
          fromNode: "hub-approval-timeout",
          decision: "deny",
          note: `审批超时（${minutes} 分钟未处理），已自动拒绝`,
          channel: "timeout",
        }));
      } catch {}
    }
    return expired;
  }

  // ---- Leader 增量拉取与 Agent 只读 Check ----

  getLeaderUpdates(actorId, { sinceSeq = null, advance = false } = {}) {
    const storedWatermark = this.store.getWatermark(actorId);
    const effectiveSince = sinceSeq !== null && sinceSeq !== undefined && sinceSeq !== ""
      ? Number(sinceSeq)
      : storedWatermark;

    const rows = this.store.db.prepare(`
      SELECT * FROM tasks
      WHERE from_node = ? AND changed_seq > ?
      ORDER BY changed_seq ASC
      LIMIT 200
    `).all(String(actorId), effectiveSince);

    let maxSeq = effectiveSince;
    const updates = rows.map((r) => {
      const task = this.store.getTask(r.id);
      if (task.changed_seq > maxSeq) maxSeq = task.changed_seq;
      const msgs = this.store.listMessages(task.id);
      const latestMsg = msgs[msgs.length - 1] || null;
      return {
        ...task,
        latest_message: latestMsg,
      };
    });

    if (advance && maxSeq > storedWatermark) {
      this.store.setWatermark(actorId, maxSeq);
    }

    return {
      actor_id: String(actorId),
      since_seq: effectiveSince,
      watermark: advance ? Math.max(storedWatermark, maxSeq) : storedWatermark,
      next_seq: maxSeq,
      updates,
    };
  }

  checkAgentInbox(agentId) {
    const agent = this.store.getAgent(agentId);
    if (!agent) return null;
    const pendingTasks = this.store.listTasks({ to_agent_id: agent.id, state: "submitted", limit: 20 });
    const watermark = this.store.getWatermark(agent.id);
    const leaderUpdatesRow = this.store.db.prepare(
      "SELECT COUNT(*) AS cnt FROM tasks WHERE from_node = ? AND changed_seq > ? AND state != 'submitted'"
    ).get(agent.id, watermark);
    const leaderUpdatesCount = Number(leaderUpdatesRow?.cnt || 0);

    const mutedSchedules = this.store.listMutedScheduleIds(agent.id);

    return {
      ok: true,
      agent_id: agent.id,
      paused: !agent.enabled,
      work: Boolean(agent.enabled && (pendingTasks.length > 0 || leaderUpdatesCount > 0)),
      pending_count: pendingTasks.length,
      leader_updates_count: leaderUpdatesCount,
      watermark,
      muted_schedules: mutedSchedules,
      tasks: agent.enabled
        ? pendingTasks.map((t) => ({
            id: t.id,
            context_id: t.context_id,
            title: t.title,
            from_node: t.from_node,
            priority: t.priority,
            attachments: t.attachments || [],
            attachment_count: (t.attachments || []).length,
            created_at: t.created_at,
          }))
        : [],
    };
  }

  // ---- Thread 视角聚合 ----

  listThreads({ limit = 60, agentId = null, visibleTo = null, includeTasks = true } = {}) {
    const tasks = this.store.listTasks({
      ...(agentId ? { to_agent_id: agentId } : {}),
      ...(visibleTo ? { visible_to: visibleTo } : {}),
      summaryOnly: !includeTasks,
      limit: 500,
    });

    const groups = new Map();
    const visibleTaskIds = new Set();
    const attKeyOf = (att) => {
      if (!att) return "";
      if (typeof att === "string") return att.trim();
      return String(att.id || att.file_id || att.uri || att.url || att.name || "");
    };

    for (const t of tasks) {
      visibleTaskIds.add(t.id);
      let g = groups.get(t.context_id);
      if (!g) {
        g = {
          context_id: t.context_id,
          title: t.title,
          from_node: t.from_node,
          created_at: t.created_at,
          updated_at: t.updated_at,
          agents: [],
          states: {},
          task_count: 0,
          pending_action_count: 0,
          unresolved_failed_count: 0,
          resolved_failed_count: 0,
          attachment_count: 0,
          _attKeys: new Set(),
          _fallbackAttCount: 0,
          ...(includeTasks ? { tasks: [] } : {}),
        };
        groups.set(t.context_id, g);
      }
      g.task_count += 1;
      // 线程标题取最早的任务，与 getThread 详情一致
      if (t.created_at <= g.created_at && t.title) {
        g.title = t.title;
        g.from_node = t.from_node;
      }
      g.created_at = Math.min(g.created_at, t.created_at);
      if (t.updated_at >= g.updated_at) {
        g.updated_at = t.updated_at;
        if (!g.title) g.title = t.title;
      }
      if (!g.agents.includes(t.to_agent_id)) g.agents.push(t.to_agent_id);
      g.states[t.state] = (g.states[t.state] || 0) + 1;
      if (FAILED_STATES.has(t.state)) {
        if (t.resolved_at) g.resolved_failed_count += 1;
        else g.unresolved_failed_count += 1;
      }
      if (t.state === "input-required" || t.state === "auth-required") {
        g.pending_action_count += 1;
      }
      if (Array.isArray(t.attachments) || Array.isArray(t.receipt?.attachments)) {
        for (const att of [...(t.attachments || []), ...(t.receipt?.attachments || [])]) {
          const k = attKeyOf(att);
          if (k) g._attKeys.add(k);
        }
      } else if (Number(t.attachment_count || 0) > 0) {
        g._fallbackAttCount += Number(t.attachment_count || 0);
      }
      if (includeTasks) g.tasks.push(t);
    }

    if (groups.size > 0) {
      if (!includeTasks) {
        const now = Date.now();
        const linkRows = this.store.db.prepare(
          `SELECT fl.task_id, fl.context_id, fl.file_id
           FROM file_links fl
           JOIN files f ON f.id = fl.file_id
           WHERE (f.expires_at IS NULL OR f.expires_at > ?)`
        ).all(now);
        for (const row of linkRows) {
          if (!visibleTaskIds.has(row.task_id)) continue;
          const g = groups.get(row.context_id);
          if (g && row.file_id) g._attKeys.add(String(row.file_id));
        }
      }
      const answerRows = this.store.db.prepare(
        "SELECT task_id, context_id, attachments_json FROM messages WHERE kind = 'answer' AND attachments_json != '[]'"
      ).all();
      for (const row of answerRows) {
        if (!visibleTaskIds.has(row.task_id)) continue;
        const g = groups.get(row.context_id);
        if (!g) continue;
        try {
          const atts = JSON.parse(row.attachments_json || "[]");
          for (const att of Array.isArray(atts) ? atts : []) {
            const k = attKeyOf(att);
            if (k) g._attKeys.add(k);
          }
        } catch {}
      }
    }

    const list = [...groups.values()]
      .map((g) => {
        const attachment_count = g._attKeys.size > 0 ? g._attKeys.size : g._fallbackAttCount;
        delete g._attKeys;
        delete g._fallbackAttCount;
        return { ...g, attachment_count };
      })
      .sort((a, b) => b.updated_at - a.updated_at);
    return list.slice(0, Math.min(Math.max(Number(limit || 60), 1), 300));
  }

  getThread(contextId) {
    const tasks = this.store.listTasks({ context_id: contextId, order: "asc", limit: 200 });
    if (!tasks.length) return null;
    const enriched = tasks.map((t) => ({
      ...t,
      messages: this.store.listMessages(t.id),
    }));
    const agents = [...new Set(enriched.map((t) => t.to_agent_id))];
    const updatedAt = enriched.reduce((m, t) => Math.max(m, t.updated_at), 0);
    return {
      context_id: String(contextId),
      title: enriched[0].title || enriched[0].input_text.slice(0, 80),
      from_node: enriched[0].from_node,
      agents,
      updated_at: updatedAt,
      tasks: enriched,
    };
  }
}
