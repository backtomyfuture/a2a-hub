// 定时自报任务观测服务（聚合挂载 Worker、最近 10 次执行轨迹、成功率、超时未报与一键触发）。
// 中台不替代本地 cron 触发器，只汇总各 Agent 报上来的定时任务并检测超时未报（> interval_min * 1.5）。

const TERMINAL_OK_STATES = new Set(["completed"]);
const TERMINAL_FAIL_STATES = new Set(["failed", "rejected", "canceled"]);
const TERMINAL_ALL_STATES = new Set(["completed", "failed", "rejected", "canceled"]);

export class ScheduleService {
  constructor(store, taskService) {
    this.store = store;
    this.taskService = taskService;
  }

  listWithStatus(agentId = null, now = Date.now()) {
    const schedules = this.store.listSchedules(agentId);
    if (!schedules.length) return [];
    const devices = new Map(this.store.listDevices().map((d) => [d.id, d]));
    const agents = new Map(this.store.listAgents().map((a) => [a.id, a]));

    // 单次批量查出最近带 schedule_id 的定时执行记录（仅投影轻量字段，避免读取超长正文）。
    const taskCols = `id, context_id, to_agent_id, schedule_id, state, title,
      CASE WHEN receipt_json IS NOT NULL AND json_valid(receipt_json) THEN json_extract(receipt_json, '$.summary') ELSE NULL END AS receipt_summary,
      CASE WHEN receipt_json IS NOT NULL AND json_valid(receipt_json) THEN substr(json_extract(receipt_json, '$.text'), 1, 300) ELSE NULL END AS receipt_text_head,
      error_message, created_at, completed_at`;
    const rows = agentId
      ? this.store.db.prepare(`
          SELECT ${taskCols} FROM tasks
          WHERE schedule_id IS NOT NULL AND to_agent_id = ?
          ORDER BY created_at DESC
          LIMIT 500
        `).all(String(agentId))
      : this.store.db.prepare(`
          SELECT ${taskCols} FROM tasks
          WHERE schedule_id IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 500
        `).all();
    const runsByKey = new Map();
    for (const t of rows) {
      const key = `${t.to_agent_id}::${t.schedule_id}`;
      let arr = runsByKey.get(key);
      if (!arr) {
        arr = [];
        runsByKey.set(key, arr);
      }
      if (arr.length < 10) {
        const endAt = t.completed_at || (t.state === "working" ? now : null);
        const durationMs = endAt && t.created_at ? Math.max(0, Number(endAt) - Number(t.created_at)) : null;
        arr.push({
          id: t.id,
          context_id: t.context_id,
          state: t.state,
          title: t.title || "",
          summary: String(t.receipt_summary || t.receipt_text_head || "").slice(0, 300),
          error_message: t.error_message || "",
          created_at: t.created_at,
          completed_at: t.completed_at ?? null,
          duration_ms: durationMs,
        });
      }
    }

    return schedules.map((sch) => {
      const ag = agents.get(sch.agent_id);
      const dev = ag?.device_id ? devices.get(ag.device_id) : null;
      const key = `${sch.agent_id}::${sch.id}`;
      const runsNewestFirst = runsByKey.get(key) || [];
      const recentRuns = [...runsNewestFirst].reverse(); // 旧 → 新顺序，适合 sparkline 从左向右展示

      let lastRun = runsNewestFirst[0] || null;
      if (!lastRun && sch.last_task_id) {
        const explicitTask = this.store.getTask(sch.last_task_id);
        if (explicitTask) {
          const endAt = explicitTask.completed_at || null;
          lastRun = {
            id: explicitTask.id,
            context_id: explicitTask.context_id,
            state: explicitTask.state,
            title: explicitTask.title,
            summary: String(explicitTask.receipt?.summary || explicitTask.receipt?.text || "").slice(0, 300),
            error_message: explicitTask.error_message || "",
            created_at: explicitTask.created_at,
            completed_at: explicitTask.completed_at,
            duration_ms: endAt ? Math.max(0, Number(endAt) - Number(explicitTask.created_at)) : null,
          };
          recentRuns.push(lastRun);
        }
      }

      const lastRunAt = sch.last_run_at || lastRun?.created_at || null;
      const intervalMs = Math.max(Number(sch.interval_min || 60), 1) * 60_000;
      const missed = Boolean(sch.enabled && lastRunAt && now - Number(lastRunAt) > intervalMs * 1.5);
      const nextExpectedAt = sch.enabled && lastRunAt ? Number(lastRunAt) + intervalMs : null;
      const overdueMs = missed && lastRunAt ? Math.max(0, now - (Number(lastRunAt) + intervalMs)) : 0;

      const terminalRuns = recentRuns.filter((r) => TERMINAL_ALL_STATES.has(r.state));
      const okRuns = terminalRuns.filter((r) => TERMINAL_OK_STATES.has(r.state));
      const successRate = terminalRuns.length > 0 ? Math.round((okRuns.length / terminalRuns.length) * 100) : null;

      const lastState = lastRun?.state || null;
      let health = "idle";
      if (!sch.enabled) health = "paused";
      else if (lastState === "working" || lastState === "submitted") health = "running";
      else if (lastState === "input-required" || lastState === "auth-required") health = "attention";
      else if (missed) health = "missed";
      else if (TERMINAL_FAIL_STATES.has(lastState)) health = "failing";
      else if (lastRunAt) health = "healthy";

      return {
        ...sch,
        agent_name: ag?.name || sch.agent_id,
        agent_kind: ag?.kind || "",
        agent_device_id: ag?.device_id || null,
        agent_device_name: dev?.name || "",
        agent_platform: ag?.platform || "",
        agent_enabled: ag ? Boolean(ag.enabled) : true,
        last_run_at: lastRunAt,
        last_run: lastRun,
        last_task_state: lastState,
        last_task_title: lastRun?.title || "",
        last_context_id: lastRun?.context_id || null,
        recent_runs: recentRuns,
        next_expected_at: nextExpectedAt,
        overdue_ms: overdueMs,
        success_rate: successRate,
        missed,
        health,
      };
    });
  }

  upsertForAgent(agentId, scheduleId, body = {}) {
    const agent = this.store.getAgent(agentId);
    if (!agent) {
      const err = new Error(`Agent 不存在: ${agentId}`);
      err.statusCode = 404;
      throw err;
    }
    const now = Date.now();
    const recordRun = Boolean(body.run);
    const sch = this.store.upsertSchedule({
      id: scheduleId,
      agent_id: agentId,
      name: body.name || scheduleId,
      cron_expr: body.cron_expr || body.cron || "",
      interval_min: Number(body.interval_min || 60) || 60,
      summary: body.summary || "",
      enabled: body.enabled !== undefined ? Boolean(body.enabled) : true,
      last_run_at: recordRun ? now : body.last_run_at ?? null,
      last_task_id: body.last_task_id ?? null,
    });

    let task = null;
    if (recordRun) {
      const res = this.taskService.dispatchTasks({
        fromNode: agentId,
        to: agentId,
        title: body.task_title || `[定时自报] ${sch.name}`,
        inputText: body.input_text || sch.summary || `定时任务 ${sch.name} 开始执行`,
        source: "cron",
        scheduleId: sch.id,
        contextId: body.context_id || undefined,
      });
      task = res.tasks[0] || null;
    }
    return { schedule: this.store.getSchedule(agentId, scheduleId), task };
  }

  deleteForAgent(agentId, scheduleId) {
    return this.store.deleteSchedule(agentId, scheduleId);
  }
}
