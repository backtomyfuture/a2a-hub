// 双模式定时任务与看门狗服务（ScheduleService）。
// 遵循第一性原理「简单、零介入、少概念」：
// 1. driver = 'hub'（仅机主管理）：由中台按排期主动派发任务，默认防重入（skip）+ 休眠合并补跑一次（fire_once）；
// 2. driver = 'edge'（外部自管）：Bot 或脚本按自身定时器运行，跑完报一次状态（成功/空转仅记打卡账本不刷屏线程，失败或带附件才归档任务并告警）。

import { randomId } from "../store/db.mjs";
import { controlKeysIn } from "./config.mjs";
import {
  DEFAULT_TIMEZONE,
  defaultHubTimezone,
  estimateCronIntervalMin,
  formatScheduleWindowKey,
  nextCronRunMs,
  normalizeTimezone,
  parseCronExpr,
  parseEveryToMinutes,
} from "./cron.mjs";
import { sanitizeAlertDetail } from "./notifier.mjs";

const TERMINAL_OK_STATES = new Set(["completed"]);
const TERMINAL_FAIL_STATES = new Set(["failed", "rejected", "canceled"]);
const TERMINAL_ALL_STATES = new Set(["completed", "failed", "rejected", "canceled"]);
const ACTIVE_STATES = new Set(["submitted", "working", "input-required", "auth-required"]);

function makeScheduleError(message, statusCode = 400, code = "bad_request") {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

// 未显式指定 grace_sec 时，按预期周期的 50% 动态计算宽限期（下限 30 秒，上限 2 小时 = 7200 秒），
// 配合 last_duration_ms 补偿后既兼容重型长耗时任务，又保证日更任务当天漏跑能及时告警。
export function defaultGraceSecForInterval(intervalMin) {
  const sec = Math.max(Number(intervalMin || 60), 1) * 60;
  return Math.min(Math.max(Math.round(sec * 0.5), 30), 7200);
}

// 确定性三规则判定：
// 1) 有非空 error（或显式 outcome='failed'）即失败；
// 2) 显式 noop:true（或 outcome='noop'）即静默空转；
// 3) 其余一律计成功（completed）。
export function normalizeOutcome(body = {}) {
  const raw = String(body.outcome || "").trim().toLowerCase();
  if (raw && !["completed", "failed", "noop"].includes(raw)) {
    throw makeScheduleError(`无效的 outcome "${body.outcome}"（仅支持 completed、failed、noop）`, 400, "invalid_outcome");
  }
  if (raw === "failed" || Boolean(String(body.error || "").trim())) return "failed";
  if (raw === "noop" || body.noop === true) return "noop";
  return "completed";
}

function computeNextRunTimestamp({ cronExpr, intervalMin, timezone, afterMs, preferInterval = false }) {
  const anchor = Number(afterMs);
  const intervalStepMs = Math.max(Number(intervalMin || 60), 1) * 60_000;
  if (cronExpr && !preferInterval) {
    return nextCronRunMs(cronExpr, anchor, timezone);
  }
  return anchor + intervalStepMs;
}

export class ScheduleService {
  constructor(store, taskService, { envResolver = null, logger = console } = {}) {
    this.store = store;
    this.taskService = taskService;
    this.envResolver = envResolver;
    this.logger = logger;
  }

  defaultTimezone() {
    return this._defaultTimezone();
  }

  _defaultTimezone() {
    const env = typeof this.envResolver === "function" ? this.envResolver() : process.env;
    return defaultHubTimezone(env);
  }

  _effectiveGraceSec(sch) {
    if (sch.grace_sec !== null && sch.grace_sec !== undefined && Number(sch.grace_sec) >= 0) {
      return Math.trunc(Number(sch.grace_sec));
    }
    return defaultGraceSecForInterval(sch.interval_min);
  }

  // 外部任务预期完成时刻 = 下次排期起点 + 上次实测耗时（last_duration_ms），
  // 防止 08:00 开跑、耗时 20 分钟的重任务在次日 08:15 运行途中被误报「超时未报」。
  _resolveExpectedNextAt(sch) {
    let baseAt = null;
    if (sch.next_run_at) {
      baseAt = Number(sch.next_run_at);
    } else {
      const lastAnchor = sch.last_tick_at || sch.last_run_at || null;
      if (lastAnchor) {
        const intervalMs = Math.max(Number(sch.interval_min || 60), 1) * 60_000;
        baseAt = Number(lastAnchor) + intervalMs;
      }
    }
    if (baseAt === null) return null;
    if (sch.driver === "edge") {
      return baseAt + Math.max(0, Number(sch.last_duration_ms || 0));
    }
    return baseAt;
  }

  listWithStatus(agentId = null, now = Date.now()) {
    const schedules = this.store.listSchedules(agentId);
    if (!schedules.length) return [];
    const devices = new Map(this.store.listDevices().map((d) => [d.id, d]));
    const agents = new Map(this.store.listAgents().map((a) => [a.id, a]));
    const rows = this.store.listRecentScheduleTasks(agentId, 15);

    const runsByKey = new Map();
    const taskById = new Map();
    for (const t of rows) {
      const endAt = t.completed_at || (t.state === "working" ? now : null);
      const durationMs = endAt && t.created_at ? Math.max(0, Number(endAt) - Number(t.created_at)) : null;
      const item = {
        id: t.id,
        context_id: t.context_id,
        state: t.state,
        source: t.source || "",
        title: t.title || "",
        summary: String(t.receipt_summary || t.receipt_text_head || "").slice(0, 300),
        error_message: t.error_message || "",
        created_at: Number(t.created_at),
        completed_at: t.completed_at ?? null,
        resolved_at: t.resolved_at ?? null,
        duration_ms: durationMs,
      };
      taskById.set(t.id, item);

      const key = `${t.to_agent_id}::${t.schedule_id}`;
      let arr = runsByKey.get(key);
      if (!arr) {
        arr = [];
        runsByKey.set(key, arr);
      }
      if (arr.length < 15) {
        arr.push(item);
      }
    }

    return schedules.map((sch) => {
      const ag = agents.get(sch.agent_id);
      const dev = ag?.device_id ? devices.get(ag.device_id) : null;
      const key = `${sch.agent_id}::${sch.id}`;
      const taskRunsNewestFirst = [...(runsByKey.get(key) || [])];

      if (sch.last_task_id && !taskRunsNewestFirst.some((r) => r.id === sch.last_task_id)) {
        const cached = taskById.get(sch.last_task_id);
        if (cached) {
          taskRunsNewestFirst.unshift(cached);
        } else {
          const explicitTask = this.store.getTask(sch.last_task_id);
          if (explicitTask) {
            const endAt = explicitTask.completed_at || null;
            taskRunsNewestFirst.unshift({
              id: explicitTask.id,
              context_id: explicitTask.context_id,
              state: explicitTask.state,
              source: explicitTask.source || "",
              title: explicitTask.title,
              summary: String(explicitTask.receipt?.summary || explicitTask.receipt?.text || "").slice(0, 300),
              error_message: explicitTask.error_message || "",
              created_at: Number(explicitTask.created_at),
              completed_at: explicitTask.completed_at,
              resolved_at: explicitTask.resolved_at ?? null,
              duration_ms: endAt ? Math.max(0, Number(endAt) - Number(explicitTask.created_at)) : null,
            });
          }
        }
      }

      const tickEntries = (Array.isArray(sch.recent_ticks) ? sch.recent_ticks : []).map((tk) => {
        const st = tk.outcome || "noop";
        const noteText = String(tk.summary ?? tk.note ?? "").slice(0, 300);
        const isFailTick = st === "failed";
        return {
          id: null,
          context_id: null,
          state: st,
          source: sch.driver === "hub" ? "hub_cron" : "edge_cron",
          title:
            st === "skipped_overlap"
              ? "上轮未结束，跳过重入"
              : st === "skipped_paused"
                ? "目标已暂停，跳过本轮"
                : isFailTick
                  ? "定时派发失败"
                  : st === "completed"
                    ? sch.name
                    : "静默打卡（无新动作）",
          summary: isFailTick ? "" : noteText,
          error_message: isFailTick ? noteText : "",
          created_at: Number(tk.at || 0),
          completed_at: Number(tk.at || 0),
          resolved_at: tk.resolved_at ?? null,
          duration_ms: tk.duration_ms ?? null,
        };
      });

      const mergedChronological = [...taskRunsNewestFirst, ...tickEntries]
        .filter((x) => x.created_at > 0)
        .sort((a, b) => (a.completed_at || a.created_at) - (b.completed_at || b.created_at) || a.created_at - b.created_at);

      const mergedTimeline = mergedChronological.slice(-10);
      const substantiveNewestFirst = [...mergedChronological]
        .reverse()
        .filter((x) => x.state !== "noop" && x.state !== "skipped_overlap" && x.state !== "skipped_paused");

      const lastRun = substantiveNewestFirst[0] || null;
      const latestTaskRun = taskRunsNewestFirst[0] || null;
      const lastRunAt = sch.last_run_at || lastRun?.created_at || null;
      const lastTickAt = Math.max(Number(sch.last_tick_at || 0), Number(lastRunAt || 0)) || null;
      const effectiveGraceSec = this._effectiveGraceSec(sch);
      const graceMs = effectiveGraceSec * 1000;
      const nextExpectedAt = sch.enabled ? this._resolveExpectedNextAt(sch) : null;

      const activeTaskState = latestTaskRun && ACTIVE_STATES.has(latestTaskRun.state) ? latestTaskRun.state : null;
      const isCurrentlyActive = Boolean(activeTaskState);

      const hubFailedCurrentTick = Boolean(
        sch.driver === "hub" &&
        sch.last_outcome === "failed" &&
        sch.next_run_at &&
        Number(sch.last_tick_at || 0) >= Number(sch.next_run_at)
      );
      const canCheckMissed = Boolean(
        sch.enabled &&
        nextExpectedAt &&
        !isCurrentlyActive &&
        !hubFailedCurrentTick &&
        (lastTickAt || sch.driver === "hub" || now > Number(nextExpectedAt) + graceMs)
      );
      const missed = Boolean(canCheckMissed && now > Number(nextExpectedAt) + graceMs);
      const overdueMs = missed && nextExpectedAt ? Math.max(0, now - Number(nextExpectedAt)) : 0;

      const terminalRuns = substantiveNewestFirst.filter((r) => TERMINAL_ALL_STATES.has(r.state)).slice(0, 10);
      const okRuns = terminalRuns.filter((r) => TERMINAL_OK_STATES.has(r.state));
      const successRate = terminalRuns.length > 0 ? Math.round((okRuns.length / terminalRuns.length) * 100) : null;

      const lastState = activeTaskState || lastRun?.state || sch.last_outcome || null;
      const lastFailResolved = Boolean(
        lastRun &&
        TERMINAL_FAIL_STATES.has(lastRun.state) &&
        lastRun.resolved_at &&
        (!sch.last_task_id || sch.last_task_id === lastRun.id)
      );
      let health = "idle";
      if (!sch.enabled) health = "paused";
      else if (activeTaskState === "working" || activeTaskState === "submitted") health = "running";
      else if (activeTaskState === "input-required" || activeTaskState === "auth-required") health = "attention";
      else if (missed) health = "missed";
      else if (
        (sch.last_outcome === "failed" && !lastFailResolved) ||
        (!sch.last_outcome && lastRun && TERMINAL_FAIL_STATES.has(lastRun.state) && !lastRun.resolved_at)
      ) {
        health = "failing";
      } else if (lastTickAt || lastRunAt) {
        health = "healthy";
      }

      const { recent_ticks: _omitTicks, ...restSch } = sch;
      return {
        ...restSch,
        effective_grace_sec: effectiveGraceSec,
        agent_name: ag?.name || sch.agent_id,
        agent_kind: ag?.kind || "",
        agent_device_id: ag?.device_id || null,
        agent_device_name: dev?.name || "",
        agent_platform: ag?.platform || "",
        agent_enabled: ag ? Boolean(ag.enabled) : true,
        last_tick_at: lastTickAt,
        last_run_at: lastRunAt,
        last_run: lastRun,
        last_task_state: lastState,
        last_task_title: lastRun?.title || "",
        last_context_id: latestTaskRun?.context_id || sch.pinned_context_id || null,
        recent_runs: mergedTimeline,
        next_expected_at: nextExpectedAt,
        overdue_ms: overdueMs,
        success_rate: successRate,
        missed,
        health,
      };
    });
  }

  _validateScheduleSecurity(body, existing, actor) {
    const isOwner = !actor || actor.kind === "owner";

    // 安全红线：无论是新建还是修改/暂停已有的 driver='hub' 条目，一律仅允许机主操作，
    // 防止被提示注入的 Worker 把自身 Hub 定时改为每分钟触发来耗尽机主 Token。
    if (!isOwner && (existing?.driver === "hub" || body.driver === "hub")) {
      throw makeScheduleError("仅机主可创建或修改中台派发 (driver=hub) 的定时任务", 403, "owner_required");
    }

    if (body.task_template && typeof body.task_template === "object") {
      const forbidden = controlKeysIn(body.task_template.params || {});
      if (forbidden.length) {
        throw makeScheduleError(`定时任务参数严禁包含执行控制字段: ${forbidden.join(", ")}`, 400, "exec_control_key_forbidden");
      }
      const forbiddenTop = controlKeysIn(body.task_template);
      if (forbiddenTop.length) {
        throw makeScheduleError(`定时任务模板严禁包含执行控制字段: ${forbiddenTop.join(", ")}`, 400, "exec_control_key_forbidden");
      }
    }
  }

  upsertForAgent(agentId, scheduleId, body = {}, { actor = null, now = Date.now() } = {}) {
    const agent = this.store.getAgent(agentId);
    if (!agent) {
      throw makeScheduleError(`Agent 不存在: ${agentId}`, 404, "not_found");
    }
    const existing = this.store.getSchedule(agentId, scheduleId);
    this._validateScheduleSecurity(body, existing, actor);

    const driver = (body.driver !== undefined ? body.driver : existing?.driver) === "hub" ? "hub" : "edge";
    const cronRaw = body.cron_expr !== undefined
      ? String(body.cron_expr || "").trim()
      : (existing?.cron_expr || "");
    const parsedCron = cronRaw ? parseCronExpr(cronRaw) : null;

    const defaultTz = this._defaultTimezone();
    const timezone = normalizeTimezone(
      body.timezone !== undefined ? body.timezone : (existing?.timezone || defaultTz),
      defaultTz
    );

    const everyMin = body.every !== undefined ? parseEveryToMinutes(body.every) : null;
    const explicitIntervalProvided =
      everyMin !== null || (body.interval_min !== undefined && body.interval_min !== null && body.interval_min !== "");
    let intervalMin;
    if (everyMin !== null) {
      intervalMin = everyMin;
    } else if (explicitIntervalProvided) {
      intervalMin = Math.max(1, Math.trunc(Number(body.interval_min) || 60));
    } else if (parsedCron) {
      intervalMin = estimateCronIntervalMin(parsedCron, now, timezone);
    } else {
      intervalMin = existing?.interval_min || 60;
    }

    if (driver === "hub" && !parsedCron && !explicitIntervalProvided && !existing) {
      throw makeScheduleError("中台定时任务请填写有效的 5 段 Cron 表达式或周期（every / interval_min）", 400, "missing_schedule_time");
    }

    const effectiveTemplate = body.task_template !== undefined ? body.task_template : existing?.task_template;
    if (driver === "hub" && effectiveTemplate && typeof effectiveTemplate === "object" && effectiveTemplate.to !== undefined) {
      const toList = [...new Set(
        (Array.isArray(effectiveTemplate.to) ? effectiveTemplate.to : [effectiveTemplate.to])
          .map((x) => String(x || "").trim())
          .filter(Boolean)
      )];
      const missing = toList.filter((id) => !this.store.getAgent(id));
      if (missing.length) {
        throw makeScheduleError(`目标 Agent 不存在: ${missing.join(", ")}`, 400, "invalid_target");
      }
    }

    const enabled = body.enabled !== undefined ? Boolean(body.enabled) : (existing ? existing.enabled : true);
    const recordRun = Boolean(body.run);

    const explicitLastRun = body.last_run_at !== undefined && body.last_run_at !== null
      ? Number(body.last_run_at)
      : undefined;
    const anchorMs = explicitLastRun ?? existing?.last_tick_at ?? existing?.last_run_at ?? now;

    // 兼容显式传入短于 Cron 周期的 interval_min 探针场景
    const cronApproxMin = parsedCron ? estimateCronIntervalMin(parsedCron, anchorMs, timezone) : null;
    const preferInterval = Boolean(
      driver === "edge" &&
      explicitIntervalProvided &&
      cronApproxMin !== null &&
      intervalMin < cronApproxMin
    );

    let nextRunAt = existing?.next_run_at ?? null;
    const resumedFromPaused = Boolean(existing && !existing.enabled && enabled);
    const timingChanged =
      !existing ||
      existing.driver !== driver ||
      (body.cron_expr !== undefined && cronRaw !== (existing.cron_expr || "")) ||
      (body.timezone !== undefined && timezone !== (existing.timezone || defaultTz)) ||
      (explicitIntervalProvided && intervalMin !== Number(existing.interval_min || 60)) ||
      explicitLastRun !== undefined;

    if (enabled) {
      if (driver === "hub") {
        if (!existing || resumedFromPaused || !existing.next_run_at || timingChanged) {
          nextRunAt = computeNextRunTimestamp({
            cronExpr: parsedCron,
            intervalMin,
            timezone,
            afterMs: now,
            preferInterval: false,
          });
        }
      } else if (!existing || resumedFromPaused || !existing.next_run_at || timingChanged) {
        // 从静默恢复监控时以当前时刻起算，避免刚点恢复就立刻误报超时
        const effectiveAnchor = resumedFromPaused && explicitLastRun === undefined ? now : anchorMs;
        nextRunAt = computeNextRunTimestamp({
          cronExpr: parsedCron,
          intervalMin,
          timezone,
          afterMs: effectiveAnchor,
          preferInterval,
        });
        // 缩短或修改已有外部自管条目周期时若按旧锚点已过期，改按当前时刻推算，防止保存瞬间误炸超时告警
        if (existing && timingChanged && explicitLastRun === undefined && !resumedFromPaused && nextRunAt <= now) {
          nextRunAt = computeNextRunTimestamp({
            cronExpr: parsedCron,
            intervalMin,
            timezone,
            afterMs: now,
            preferInterval,
          });
        }
      }
    } else {
      nextRunAt = null;
    }

    const graceSec = body.grace_sec !== undefined
      ? (body.grace_sec === null || body.grace_sec === "" ? null : Math.max(0, Math.trunc(Number(body.grace_sec))))
      : existing?.grace_sec;

    const rawContextMode = body.context_mode !== undefined
      ? body.context_mode
      : (existing?.context_mode || (driver === "edge" ? "rolling" : "per_run"));
    const contextMode = rawContextMode === "rolling" ? "rolling" : "per_run";
    const pinnedContextId = contextMode === "rolling"
      ? (body.pinned_context_id || existing?.pinned_context_id || randomId("ctx"))
      : null;

    const triggerable = body.triggerable !== undefined
      ? Boolean(body.triggerable)
      : existing
        ? existing.triggerable
        : driver === "hub";

    const sch = this.store.upsertSchedule({
      id: scheduleId,
      agent_id: agentId,
      name: body.name !== undefined ? body.name : (existing?.name || scheduleId),
      driver,
      cron_expr: cronRaw,
      interval_min: intervalMin,
      timezone,
      grace_sec: graceSec,
      summary: body.summary !== undefined ? body.summary : existing?.summary,
      task_template: body.task_template !== undefined ? body.task_template : existing?.task_template,
      context_mode: contextMode,
      pinned_context_id: pinnedContextId,
      overlap_policy: body.overlap_policy !== undefined ? body.overlap_policy : existing?.overlap_policy,
      misfire_policy: body.misfire_policy !== undefined ? body.misfire_policy : existing?.misfire_policy,
      triggerable,
      next_run_at: nextRunAt,
      last_tick_at: explicitLastRun !== undefined ? explicitLastRun : undefined,
      last_run_at: explicitLastRun,
      last_task_id: body.last_task_id,
      alerted_missed_at: !enabled || resumedFromPaused || explicitLastRun !== undefined || (existing && timingChanged) ? null : undefined,
      enabled,
      now,
    });

    if (recordRun) {
      if (driver === "hub") {
        const triggered = this.triggerNow(agentId, sch.id, {
          fromNode: actor?.kind === "agent" ? actor.id : "owner",
          title: body.task_title || "",
          inputText: body.input_text || "",
          contextId: body.context_id || "",
          actor,
          now,
        });
        const tasks = triggered.tasks || [];
        return {
          schedule: this.store.getSchedule(agentId, scheduleId),
          task: tasks[0] || null,
          ...(tasks.length > 1 ? { tasks } : {}),
        };
      }
      // 兼容按旧提示词发送 PUT .../schedules/<id> {"run":true} 的外部 Bot：
      // 统一按一次成功打卡入账，不再向其收件箱反向塞入待办任务消耗额外 Token。
      const edgeRes = this.recordEdgeRun(
        agentId,
        sch.id,
        { outcome: "completed", summary: body.summary || body.input_text || "" },
        { actor, now }
      );
      return { schedule: edgeRes.schedule, task: null };
    }

    return { schedule: this.store.getSchedule(agentId, scheduleId), task: null };
  }

  // 立即派发一次定时任务（供 Web 控制台「立即运行」或 Hub Cron 到期共用）。
  triggerNow(agentId, scheduleId, {
    fromNode = "owner",
    source = "cron",
    title = "",
    inputText = "",
    contextId = "",
    idempotencyKey = "",
    targetsOverride = null,
    actor = null,
    advanceNextRunAt = null,
    now = Date.now(),
  } = {}) {
    return this.store.transaction(() => {
      const sch = this.store.getSchedule(agentId, scheduleId);
      if (!sch) throw makeScheduleError(`定时条目不存在: ${scheduleId}`, 404, "not_found");
      if (sch.driver === "edge" && !sch.triggerable) {
        throw makeScheduleError(`外部自管定时任务「${sch.name}」未开启反向触发能力`, 409, "not_triggerable");
      }

      const tpl = sch.task_template && typeof sch.task_template === "object" ? sch.task_template : {};
      const overrideList = Array.isArray(targetsOverride)
        ? targetsOverride.map((x) => String(x || "").trim()).filter(Boolean)
        : [];
      const rawTargets = overrideList.length
        ? overrideList
        : (sch.driver === "hub" && tpl.to ? tpl.to : [agentId]);
      const targets = (Array.isArray(rawTargets) ? rawTargets : [rawTargets]).map((x) => String(x || "").trim()).filter(Boolean);

      const finalContextId =
        String(contextId || "").trim() ||
        (sch.context_mode === "rolling" ? (sch.pinned_context_id || randomId("ctx")) : randomId("ctx"));

      const taskTitle =
        String(title || tpl.title || "").trim() ||
        `${sch.driver === "hub" ? "[定时调度]" : "[定时触发]"} ${sch.name}`;
      const promptText =
        String(inputText || tpl.input_text || sch.summary || "").trim() ||
        `定时任务「${sch.name}」开始执行`;

      const res = this.taskService.dispatchTasks({
        fromNode,
        to: targets,
        title: taskTitle,
        inputText: promptText,
        params: tpl.params && typeof tpl.params === "object" ? tpl.params : {},
        model: tpl.model || "",
        priority: tpl.priority ?? 5,
        timeoutSec: tpl.timeout_sec,
        contextId: finalContextId,
        source,
        scheduleId: sch.id,
        idempotencyKey,
        actor,
      });

      const primaryTask = res.tasks[0] || null;
      const nextRunPatch = advanceNextRunAt !== null
        ? advanceNextRunAt
        : sch.enabled && sch.cron_expr
          ? nextCronRunMs(sch.cron_expr, now, sch.timezone || DEFAULT_TIMEZONE)
          : sch.enabled
            ? now + Math.max(sch.interval_min, 1) * 60_000
            : null;

      const updatedSchedule = this.store.upsertSchedule(
        {
          id: sch.id,
          agent_id: sch.agent_id,
          pinned_context_id: sch.context_mode === "rolling" ? finalContextId : null,
          last_tick_at: now,
          last_run_at: now,
          last_outcome: null,
          last_task_id: primaryTask?.id ?? sch.last_task_id,
          next_run_at: nextRunPatch,
          alerted_missed_at: null,
          now,
        },
        { eventType: null }
      );

      return { schedule: updatedSchedule, context_id: res.context_id, tasks: res.tasks, task: primaryTask };
    });
  }

  // 外部自管定时任务跑完单步报备入口：
  // 平时成功或 noop 仅记录打卡轨迹（零任务噪音、零线程刷屏）；仅当失败、带附件或显式要求 record_task:true 时落地终态任务。
  recordEdgeRun(agentId, scheduleId, body = {}, { actor = null, idempotencyKey = "", now = Date.now() } = {}) {
    const idemKey = String(
      idempotencyKey || body.window_key || body.idempotency_key || body.client_token || ""
    ).trim();
    const idemScope = `schedule_run:${agentId}:${scheduleId}`;

    return this.store.transaction(() => {
      const agent = this.store.getAgent(agentId);
      if (!agent) throw makeScheduleError(`Agent 不存在: ${agentId}`, 404, "not_found");
      this.store.touchAgentSeen(agentId, now);

      let sch = this.store.getSchedule(agentId, scheduleId);
      if (sch && sch.driver === "hub") {
        throw makeScheduleError("该定时条目由中台统一派发 (driver=hub)，不可作为外部自管条目上报", 409, "hub_schedule_managed_by_hub");
      }

      if (idemKey) {
        const cached = this.store.getIdempotency(idemScope, idemKey);
        if (cached) {
          return {
            ...cached,
            idempotent: true,
            muted: sch ? !sch.enabled : false,
            muted_schedules: this.store.listMutedScheduleIds(agentId),
          };
        }
      }

      const nameArg = typeof body.name === "string" ? body.name.trim() : "";
      const cronArg = typeof body.cron_expr === "string" ? body.cron_expr.trim() : "";
      const tzArg = typeof body.timezone === "string" ? body.timezone.trim() : "";
      const hasEvery = body.every !== undefined && body.every !== null && String(body.every).trim() !== "";
      const hasInterval = body.interval_min !== undefined && body.interval_min !== null && body.interval_min !== "";

      if (!sch) {
        // 首次上报自动建档（默认 triggerable=false 纯观测不介入，context_mode='rolling' 避免碎片线程）
        sch = this.upsertForAgent(
          agentId,
          scheduleId,
          {
            name: nameArg || scheduleId,
            driver: "edge",
            ...(cronArg ? { cron_expr: cronArg } : {}),
            ...(hasEvery ? { every: body.every } : {}),
            ...(hasInterval ? { interval_min: body.interval_min } : {}),
            ...(tzArg ? { timezone: tzArg } : {}),
            ...(body.grace_sec !== undefined ? { grace_sec: body.grace_sec } : {}),
            context_mode: body.context_mode === "per_run" ? "per_run" : "rolling",
            triggerable: Boolean(body.triggerable),
          },
          { actor, now }
        ).schedule;
      } else if (nameArg || cronArg || tzArg || hasEvery || hasInterval || body.grace_sec !== undefined) {
        // 仅当显式传入非空的排期字段时才更新，防止普通 ok/fail 上报空串清空既有 cron 或重置时区
        sch = this.upsertForAgent(
          agentId,
          scheduleId,
          {
            ...(nameArg ? { name: nameArg } : {}),
            ...(cronArg ? { cron_expr: cronArg } : {}),
            ...(hasEvery ? { every: body.every } : {}),
            ...(hasInterval ? { interval_min: body.interval_min } : {}),
            ...(tzArg ? { timezone: tzArg } : {}),
            ...(body.grace_sec !== undefined ? { grace_sec: body.grace_sec } : {}),
          },
          { actor, now }
        ).schedule;
      }

      const outcome = normalizeOutcome(body);
      const durationMs =
        body.duration_ms !== undefined && body.duration_ms !== null && Number.isFinite(Number(body.duration_ms))
          ? Math.max(0, Math.trunc(Number(body.duration_ms)))
          : null;

      const parsedCron = sch.cron_expr ? parseCronExpr(sch.cron_expr) : null;
      let nextRunAt = null;
      if (sch.enabled) {
        if (parsedCron) {
          nextRunAt = nextCronRunMs(parsedCron, now, sch.timezone || this._defaultTimezone());
        } else {
          // 按「本次开工时刻 (now - durationMs) + 周期」推算下次排期起点，消除因执行耗时波动导致的预期时间持续后漂
          const stepMs = Math.max(Number(sch.interval_min || 60), 1) * 60_000;
          const startedAt = durationMs !== null ? Math.max(0, now - durationMs) : now;
          nextRunAt = startedAt + stepMs > now ? startedAt + stepMs : now + stepMs;
        }
      }

      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      const shouldArchiveTask =
        outcome === "failed" || attachments.length > 0 || body.record_task === true;

      let task = null;
      if (!shouldArchiveTask) {
        const nextTicks = [
          ...(Array.isArray(sch.recent_ticks) ? sch.recent_ticks : []),
          {
            at: now,
            outcome,
            duration_ms: durationMs,
            summary: String(body.summary || body.text || "").slice(0, 300),
          },
        ].slice(-20);

        sch = this.store.upsertSchedule(
          {
            id: sch.id,
            agent_id: agentId,
            last_tick_at: now,
            ...(outcome === "completed" ? { last_run_at: now } : {}),
            ...(durationMs !== null ? { last_duration_ms: durationMs } : {}),
            last_outcome: outcome,
            next_run_at: nextRunAt,
            alerted_missed_at: null,
            recent_ticks: nextTicks,
            now,
          },
          { eventType: "schedule.ticked", includeActorScope: false }
        );
      } else {
        const finalContextId =
          String(body.context_id || "").trim() ||
          (sch.context_mode === "rolling" ? (sch.pinned_context_id || randomId("ctx")) : randomId("ctx"));

        task = this.taskService.ingestScheduleTask({
          agentId,
          scheduleId: sch.id,
          outcome,
          title: body.title || `[定时自报] ${sch.name}`,
          inputText: body.input_text || sch.summary || sch.name,
          summary: body.summary || "",
          text: body.text || "",
          error: body.error || "",
          data: body.data || {},
          artifacts: body.artifacts || [],
          usage: body.usage || null,
          attachments,
          contextId: finalContextId,
          durationMs,
          actor,
          now,
        });

        sch = this.store.upsertSchedule(
          {
            id: sch.id,
            agent_id: agentId,
            pinned_context_id: sch.context_mode === "rolling" ? finalContextId : null,
            last_tick_at: now,
            last_run_at: now,
            ...(durationMs !== null ? { last_duration_ms: durationMs } : {}),
            last_outcome: outcome,
            last_task_id: task.id,
            next_run_at: nextRunAt,
            alerted_missed_at: null,
            now,
          },
          { eventType: null }
        );
      }

      const { recent_ticks: _omitTicks, ...cleanSchedule } = sch || {};
      const resultPayload = {
        schedule: cleanSchedule,
        outcome,
        task,
        muted: !sch.enabled,
        muted_schedules: this.store.listMutedScheduleIds(agentId),
      };
      if (idemKey) {
        this.store.saveIdempotency(idemScope, idemKey, resultPayload);
      }
      return resultPayload;
    });
  }

  _recordHubDispatchFailure(sch, agents, { dueAt, nextFutureAt = null, graceMs = 60_000, err, now = Date.now(), failedOut = null } = {}) {
    const reason = sanitizeAlertDetail(err?.message || String(err || "定时派发异常"), 160);
    const prevTicks = Array.isArray(sch.recent_ticks) ? [...sch.recent_ticks] : [];
    const lastTk = prevTicks.length ? prevTicks[prevTicks.length - 1] : null;
    const sameDue = Boolean(lastTk && lastTk.outcome === "failed" && Number(lastTk.due_at || 0) === Number(dueAt || 0));

    if (sameDue && now - Number(lastTk.at || 0) < 60_000) {
      return;
    }

    const attempts = sameDue ? Number(lastTk.attempts || 1) + 1 : 1;
    const exhausted = Boolean(
      attempts >= 3 ||
      (nextFutureAt !== null && nextFutureAt !== undefined && now >= nextFutureAt) ||
      (dueAt && (now - dueAt) > Math.max(graceMs, 300_000))
    );

    const summary = exhausted
      ? `派发失败(已重试${attempts}次，跳过本轮): ${reason}`
      : `派发失败(第${attempts}次，待重试): ${reason}`;
    const tickEntry = {
      at: now,
      outcome: "failed",
      due_at: dueAt || now,
      attempts,
      duration_ms: 0,
      summary,
    };
    const nextTicks = sameDue
      ? [...prevTicks.slice(0, -1), tickEntry].slice(-20)
      : [...prevTicks, tickEntry].slice(-20);

    const nextRunPatch = exhausted && nextFutureAt !== null && nextFutureAt !== undefined
      ? nextFutureAt
      : (sch.next_run_at ?? (dueAt || null));

    const ag = agents.get(sch.agent_id);
    this.logger?.error?.(
      `[a2a-hub] schedule dispatch failed (${sch.agent_id}/${sch.id}, attempt=${attempts}${exhausted ? ", exhausted" : ""}): ${reason}`
    );

    try {
      this.store.upsertSchedule(
        {
          id: sch.id,
          agent_id: sch.agent_id,
          last_tick_at: now,
          last_outcome: "failed",
          next_run_at: nextRunPatch,
          recent_ticks: nextTicks,
          now,
        },
        {
          eventType: attempts === 1 ? "schedule.failed" : "schedule.ticked",
          includeActorScope: false,
          ...(attempts === 1
            ? {
                eventExtra: {
                  agentId: sch.agent_id,
                  agentName: ag?.name || sch.agent_id,
                  scheduleName: sch.name,
                  reason,
                  attempts,
                },
              }
            : {}),
        }
      );
    } catch (persistErr) {
      this.logger?.error?.(
        `[a2a-hub] persist schedule failure state error (${sch.agent_id}/${sch.id}): ${persistErr?.message || persistErr}`
      );
    }

    if (Array.isArray(failedOut)) {
      failedOut.push({
        agent_id: sch.agent_id,
        id: sch.id,
        error: reason,
        attempts,
        exhausted,
      });
    }
  }

  // 中台周期心跳入口：
  // 1) 扫描到期的 driver='hub' 任务自动派单（默认 misfire_policy='fire_once' 合并补跑一次，overlap_policy='skip' 防重入）；
  // 2) 扫描超过 next_expected_at + grace_sec 仍未报备的外部条目推送单次 schedule.missed 告警。
  tick(now = Date.now()) {
    const dispatched = [];
    const skipped = [];
    const failed = [];
    const missedAlerts = [];

    const allSchedules = this.store.listSchedules();
    if (!allSchedules.length) {
      return { dispatched, skipped, failed, missed_alerts: missedAlerts };
    }

    const agents = new Map(this.store.listAgents().map((a) => [a.id, a]));
    const devices = new Map(this.store.listDevices().map((d) => [d.id, d]));

    for (const sch of allSchedules) {
      if (!sch.enabled) continue;

      try {
        if (sch.driver === "hub") {
          const parsedCron = sch.cron_expr ? parseCronExpr(sch.cron_expr) : null;
          if (!sch.next_run_at) {
            const initNext = computeNextRunTimestamp({
              cronExpr: parsedCron,
              intervalMin: sch.interval_min,
              timezone: sch.timezone || this._defaultTimezone(),
              afterMs: now,
            });
            this.store.upsertSchedule(
              { id: sch.id, agent_id: sch.agent_id, next_run_at: initNext, now },
              { eventType: null }
            );
            continue;
          }

          if (now < Number(sch.next_run_at)) continue;

          const dueAt = Number(sch.next_run_at);
          const nextFutureAt = computeNextRunTimestamp({
            cronExpr: parsedCron,
            intervalMin: sch.interval_min,
            timezone: sch.timezone || this._defaultTimezone(),
            afterMs: now,
          });
          const graceMs = this._effectiveGraceSec(sch) * 1000;

          if (sch.misfire_policy === "skip" && now - dueAt > Math.max(graceMs, 60_000)) {
            this.store.upsertSchedule(
              { id: sch.id, agent_id: sch.agent_id, next_run_at: nextFutureAt, now },
              { eventType: "schedule.ticked", includeActorScope: false }
            );
            skipped.push({ agent_id: sch.agent_id, id: sch.id, reason: "misfire_skipped" });
            continue;
          }

          // 同一到期窗口失败重试冷却期（60s）内不重复拉起派发
          const recentTicks = Array.isArray(sch.recent_ticks) ? sch.recent_ticks : [];
          const lastTk = recentTicks.length ? recentTicks[recentTicks.length - 1] : null;
          if (
            lastTk &&
            lastTk.outcome === "failed" &&
            Number(lastTk.due_at || 0) === dueAt &&
            now - Number(lastTk.at || 0) < 60_000
          ) {
            skipped.push({ agent_id: sch.agent_id, id: sch.id, reason: "failure_cooldown" });
            continue;
          }

          if (sch.overlap_policy !== "allow" && sch.last_task_id) {
            const prevTask = this.store.getTask(sch.last_task_id);
            let activeTask = prevTask && ACTIVE_STATES.has(prevTask.state) ? prevTask : null;
            if (!activeTask && prevTask) {
              activeTask = this.store.hasActiveScheduleSiblingTask(sch.id, prevTask.context_id);
            }
            if (activeTask) {
              const nextTicks = [
                ...recentTicks,
                { at: now, outcome: "skipped_overlap", duration_ms: 0, summary: `上轮任务 ${activeTask.id} 仍在 ${activeTask.state}` },
              ].slice(-20);
              this.store.upsertSchedule(
                {
                  id: sch.id,
                  agent_id: sch.agent_id,
                  next_run_at: nextFutureAt,
                  recent_ticks: nextTicks,
                  now,
                },
                { eventType: "schedule.ticked", includeActorScope: false }
              );
              skipped.push({ agent_id: sch.agent_id, id: sch.id, reason: "overlap_skipped" });
              continue;
            }
          }

          const tpl = sch.task_template && typeof sch.task_template === "object" ? sch.task_template : {};
          const rawTargets = tpl.to ? (Array.isArray(tpl.to) ? tpl.to : [tpl.to]) : [sch.agent_id];
          const validTargets = rawTargets
            .map((id) => String(id || "").trim())
            .filter((id) => {
              const a = agents.get(id);
              if (!a || !a.enabled) return false;
              if (a.device_id) {
                const d = devices.get(a.device_id);
                if (d && !d.enabled) return false;
              }
              return true;
            });

          if (!validTargets.length) {
            const nextTicks = [
              ...recentTicks,
              { at: now, outcome: "skipped_paused", duration_ms: 0, summary: "目标 Agent 或设备已暂停，本轮跳过" },
            ].slice(-20);
            this.store.upsertSchedule(
              { id: sch.id, agent_id: sch.agent_id, next_run_at: nextFutureAt, recent_ticks: nextTicks, now },
              { eventType: "schedule.ticked", includeActorScope: false }
            );
            skipped.push({ agent_id: sch.agent_id, id: sch.id, reason: "target_paused" });
            continue;
          }

          const winKey = `hub_cron:${sch.agent_id}:${sch.id}:${formatScheduleWindowKey(dueAt, sch.timezone || this._defaultTimezone())}`;
          try {
            const runRes = this.triggerNow(sch.agent_id, sch.id, {
              fromNode: "hub:cron",
              source: "hub_cron",
              idempotencyKey: winKey,
              targetsOverride: validTargets,
              advanceNextRunAt: nextFutureAt,
              now,
            });
            dispatched.push({
              agent_id: sch.agent_id,
              id: sch.id,
              context_id: runRes.context_id,
              task_ids: (runRes.tasks || []).map((t) => t.id),
            });
          } catch (err) {
            this._recordHubDispatchFailure(sch, agents, {
              dueAt,
              nextFutureAt,
              graceMs,
              err,
              now,
              failedOut: failed,
            });
          }
          continue;
        }

        // Edge 任务超时未报检测（expectedAt 已包含 last_duration_ms 耗时补偿）
        const expectedAt = this._resolveExpectedNextAt(sch);
        if (!expectedAt) continue;
        const graceMs = this._effectiveGraceSec(sch) * 1000;
        if (now <= expectedAt + graceMs) continue;
        if (sch.alerted_missed_at) continue;

        if (sch.last_task_id) {
          const lastTask = this.store.getTask(sch.last_task_id);
          if (lastTask && ACTIVE_STATES.has(lastTask.state)) continue;
        }

        const ag = agents.get(sch.agent_id);
        const overdueMin = Math.max(1, Math.round((now - expectedAt) / 60_000));
        const reason = `已超过预期完成窗口 ${overdueMin} 分钟未收到状态上报（排期: ${sch.cron_expr || `每 ${sch.interval_min} 分钟`}）`;
        this.store.upsertSchedule(
          {
            id: sch.id,
            agent_id: sch.agent_id,
            alerted_missed_at: now,
            now,
          },
          {
            eventType: "schedule.missed",
            includeActorScope: false,
            eventExtra: {
              agentId: sch.agent_id,
              agentName: ag?.name || sch.agent_id,
              scheduleName: sch.name,
              overdueMs: now - expectedAt,
              reason,
            },
          }
        );
        missedAlerts.push({ agent_id: sch.agent_id, id: sch.id, overdue_min: overdueMin });
      } catch (err) {
        this._recordHubDispatchFailure(sch, agents, {
          dueAt: Number(sch.next_run_at || now),
          nextFutureAt: null,
          graceMs: this._effectiveGraceSec(sch) * 1000,
          err,
          now,
          failedOut: failed,
        });
      }
    }

    return { dispatched, skipped, failed, missed_alerts: missedAlerts };
  }

  // 机主确认并消除定时任务的「上次失败 / 超时未报」告警：
  // - failing：只消红旧失败（任务与派发失败 tick），不修改 next_run_at，绝不跳过即将到期的本轮；
  // - missed（超时未报）：清除超时告警并顺延 next_run_at 至下一个周期窗口。
  acknowledge(agentId, scheduleId, { now = Date.now() } = {}) {
    return this.store.transaction(() => {
      const sch = this.store.getSchedule(agentId, scheduleId);
      if (!sch) throw makeScheduleError(`定时条目不存在: ${scheduleId}`, 404, "not_found");

      const lastTask = sch.last_task_id ? this.store.getTask(sch.last_task_id) : null;
      const isCurrentlyActive = Boolean(
        (lastTask && ACTIVE_STATES.has(lastTask.state)) ||
        (lastTask && this.store.hasActiveScheduleSiblingTask(sch.id, lastTask.context_id))
      );

      if (lastTask?.context_id) {
        this.store.db.prepare(`
          UPDATE tasks
          SET resolved_at = ?
          WHERE schedule_id = ? AND state IN ('failed', 'rejected') AND resolved_at IS NULL
            AND (to_agent_id = ? OR context_id = ?)
        `).run(now, String(scheduleId), String(agentId), String(lastTask.context_id));
      } else {
        this.store.db.prepare(`
          UPDATE tasks
          SET resolved_at = ?
          WHERE to_agent_id = ? AND schedule_id = ? AND state IN ('failed', 'rejected') AND resolved_at IS NULL
        `).run(now, String(agentId), String(scheduleId));
      }

      // 兼容中台派发异常（仅记录在 recent_ticks、未落地 tasks 表的 failed tick）
      const rawTicks = Array.isArray(sch.recent_ticks) ? sch.recent_ticks : [];
      let ticksChanged = false;
      const nextTicks = rawTicks.map((tk) => {
        if (tk && tk.outcome === "failed" && !tk.resolved_at) {
          ticksChanged = true;
          return { ...tk, resolved_at: now };
        }
        return tk;
      });

      const parsedCron = sch.cron_expr ? parseCronExpr(sch.cron_expr) : null;
      const expectedAt = this._resolveExpectedNextAt(sch);
      const graceMs = this._effectiveGraceSec(sch) * 1000;
      const hubFailedCurrentTick = Boolean(
        sch.driver === "hub" &&
        sch.last_outcome === "failed" &&
        sch.next_run_at &&
        Number(sch.last_tick_at || 0) >= Number(sch.next_run_at)
      );
      const canCheckMissed = Boolean(
        sch.enabled &&
        expectedAt &&
        !isCurrentlyActive &&
        !hubFailedCurrentTick &&
        (sch.last_tick_at || sch.last_run_at || sch.driver === "hub" || now > Number(expectedAt) + graceMs)
      );
      const isMissed = Boolean(canCheckMissed && now > Number(expectedAt) + graceMs);

      let nextRunAt = sch.next_run_at;
      if (isMissed) {
        nextRunAt = computeNextRunTimestamp({
          cronExpr: parsedCron,
          intervalMin: sch.interval_min,
          timezone: sch.timezone || this._defaultTimezone(),
          afterMs: now,
        });
      }

      const updated = this.store.upsertSchedule(
        {
          id: sch.id,
          agent_id: sch.agent_id,
          last_outcome: sch.last_outcome === "failed" ? null : sch.last_outcome,
          next_run_at: nextRunAt,
          alerted_missed_at: null,
          ...(ticksChanged ? { recent_ticks: nextTicks } : {}),
          now,
        },
        { eventType: "schedule.acknowledged", includeActorScope: false }
      );
      return { schedule: updated, skipped_window: isMissed };
    });
  }

  deleteForAgent(agentId, scheduleId, { actor = null } = {}) {
    const existing = this.store.getSchedule(agentId, scheduleId);
    if (existing?.driver === "hub" && actor && actor.kind !== "owner") {
      throw makeScheduleError("仅机主可删除中台派发 (driver=hub) 的定时任务", 403, "owner_required");
    }
    return this.store.deleteSchedule(agentId, scheduleId);
  }
}
