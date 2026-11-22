// 定时自报任务观测服务（只读聚合 +missed 检测 + 可选登记即触发记录）。
// 中台不替代本地 cron 触发器，只汇总各 Agent 报上来的定时任务并检测超时未报（> interval_min * 1.5）。

export class ScheduleService {
  constructor(store, taskService) {
    this.store = store;
    this.taskService = taskService;
  }

  listWithStatus(agentId = null, now = Date.now()) {
    const schedules = this.store.listSchedules(agentId);
    const agents = new Map(this.store.listAgents().map((a) => [a.id, a]));
    return schedules.map((sch) => {
      const ag = agents.get(sch.agent_id);
      const lastTask = sch.last_task_id ? this.store.getTask(sch.last_task_id) : null;
      const lastRunAt = sch.last_run_at || lastTask?.created_at || null;
      const intervalMs = Math.max(Number(sch.interval_min || 60), 1) * 60_000;
      const missed = Boolean(sch.enabled && lastRunAt && now - Number(lastRunAt) > intervalMs * 1.5);
      return {
        ...sch,
        agent_name: ag?.name || sch.agent_id,
        agent_platform: ag?.platform || "",
        last_run_at: lastRunAt,
        last_task_state: lastTask?.state || null,
        last_task_title: lastTask?.title || "",
        missed,
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
