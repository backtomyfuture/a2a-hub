// LoopForge 风格 SOP 闭环编排引擎（基于 A2A Context_ID + Ref_Task_IDs + Acceptance Gate）。
// 按多阶段阶段定义（如 Plan -> Implement -> Verify -> Review）在同会话下自动派生后续任务；
// 当阶段失败或验收未通过（acceptance.overall === "fail"）时，自动注入失败反馈并回跳重试，
// 受 Max_Iterations 与 A2A HOP_LIMIT (8) 双重熔断约束。

import { randomBytes } from "node:crypto";
import { f1 } from "../bus/feishu.mjs";
import { acceptanceForTask, parseCriteria } from "../acceptance.mjs";
import { createTask, formatCreatedAt } from "./create.mjs";
import { messageText } from "./cards.mjs";
import { cancelTask } from "./cancel.mjs";

const HOP_LIMIT = 8;
const DEFAULT_MAX_ITERATIONS = 5;

export const BUILTIN_LOOP_TEMPLATES = Object.freeze({
  "plan-code-verify": {
    id: "plan-code-verify",
    name: "Plan → Code → Verify (研发闭环)",
    description: "先规划方案、再编码实现、最后验收门禁；验收不通过自动带报错打回编码阶段修复。",
    max_iterations: 6,
    stages: [
      {
        id: "plan",
        name: "方案规划",
        cap: "agent",
        approval: "auto",
        on_fail: "retry",
        prompt: "【阶段 1/3：方案规划】\n目标：{{goal}}\n请输出清晰的实现方案、改动文件清单与风险点。\n{{failure_feedback_block}}",
      },
      {
        id: "implement",
        name: "编码实现",
        cap: "agent",
        approval: "auto",
        on_fail: "retry",
        prompt: "【阶段 2/3：编码实现】\n总体目标：{{goal}}\n上一阶段方案/输入：\n{{prev_result}}\n{{failure_feedback_block}}\n请完成实现并给出改动摘要。",
      },
      {
        id: "verify",
        name: "验收门禁",
        cap: "agent",
        approval: "auto",
        on_fail: "goto:implement",
        prompt: "【阶段 3/3：验收检查】\n总体目标：{{goal}}\n实现成果：\n{{prev_result}}\n请运行测试并逐条核对验收标准。",
        criteria: [
          { id: "tests_pass", text: "相关单元测试与集成检查全部通过", evidence_required: true },
          { id: "goal_met", text: "核心需求完整落地且无回归问题", evidence_required: false },
        ],
      },
    ],
  },
  "write-review-refine": {
    id: "write-review-refine",
    name: "Write → Review → Refine (内容打磨闭环)",
    description: "起草内容并由审校节点按清单评审，未达标时自动附评审意见退回重写。",
    max_iterations: 5,
    stages: [
      {
        id: "draft",
        name: "初稿撰写",
        cap: "agent",
        approval: "auto",
        on_fail: "retry",
        prompt: "【阶段 1/2：初稿撰写】\n创作目标：{{goal}}\n{{failure_feedback_block}}\n请完成完整稿件输出。",
      },
      {
        id: "review",
        name: "质量评审",
        cap: "agent",
        approval: "auto",
        on_fail: "goto:draft",
        prompt: "【阶段 2/2：质量评审】\n目标：{{goal}}\n待评审稿件：\n{{prev_result}}\n请严格核查准确性、结构清晰度与可执行性，不达标请标记 FAIL 并给出具体修改建议。",
        criteria: [
          { id: "accuracy", text: "事实、技术细节与结论准确无误", evidence_required: false },
          { id: "clarity", text: "结构清晰、可直接交付使用", evidence_required: false },
        ],
      },
    ],
  },
  "audit-fix-verify": {
    id: "audit-fix-verify",
    name: "Audit → Fix → Verify (巡检修复闭环)",
    description: "先巡检定位问题，再自动派发修复，最后复验确认清零。",
    max_iterations: 6,
    stages: [
      {
        id: "audit",
        name: "问题巡检",
        cap: "agent",
        approval: "auto",
        on_fail: "retry",
        prompt: "【阶段 1/3：巡检定位】\n巡检范围与目标：{{goal}}\n请列出发现的问题清单与复现依据。",
      },
      {
        id: "fix",
        name: "问题修复",
        cap: "agent",
        approval: "auto",
        on_fail: "retry",
        prompt: "【阶段 2/3：修复执行】\n目标：{{goal}}\n巡检结论：\n{{prev_result}}\n{{failure_feedback_block}}\n请修复上述问题并说明改动。",
      },
      {
        id: "reverify",
        name: "复验确认",
        cap: "agent",
        approval: "auto",
        on_fail: "goto:fix",
        prompt: "【阶段 3/3：复验确认】\n目标：{{goal}}\n修复说明：\n{{prev_result}}\n请复验确认所有问题已解决且无新增故障。",
        criteria: [
          { id: "resolved", text: "巡检发现问题已全部关闭", evidence_required: true },
        ],
      },
    ],
  },
});

function parseJsonSafe(raw, fallback) {
  if (raw && typeof raw === "object") return raw;
  const s = String(raw ?? "").trim();
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function freshLoopId(existingIds, now) {
  const p = (n) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  for (let i = 0; i < 8; i++) {
    const id = `LOOP-${day}-${randomBytes(3).toString("hex")}`;
    if (!existingIds.has(id)) return id;
  }
  throw new Error("无法生成不重复的 Loop_ID");
}

export function normalizeLoopStages(rawStages, defaults = {}) {
  if (!Array.isArray(rawStages) || !rawStages.length) {
    throw new Error("Loop 至少需要 1 个 stage");
  }
  const seenIds = new Set();
  const out = [];
  for (let i = 0; i < rawStages.length; i++) {
    const st = rawStages[i];
    if (!st || typeof st !== "object" || Array.isArray(st)) {
      throw new Error(`stage[${i}] 必须是对象`);
    }
    const id = String(st.id ?? `stage-${i + 1}`).trim();
    if (!id) throw new Error(`stage[${i}] 缺少 id`);
    if (seenIds.has(id)) throw new Error(`stage id 重复：${id}`);
    seenIds.add(id);

    const bind = defaults.stageBindings?.[id] ?? {};
    const to = String(bind.to ?? st.to ?? defaults.to ?? "").trim();
    const worker = String(bind.worker ?? st.worker ?? defaults.worker ?? "").trim();
    const cap = String(bind.cap ?? st.cap ?? defaults.cap ?? (worker ? "agent" : "")).trim();
    if (!to && !cap) {
      throw new Error(`stage "${id}" 必须指定目标节点 to 或能力 cap`);
    }

    const approval = String(bind.approval ?? st.approval ?? defaults.approval ?? "auto").trim() || "auto";
    if (!["auto", "notify", "approve"].includes(approval)) {
      throw new Error(`stage "${id}" 的 approval 非法：${approval}`);
    }

    const onFail = String(st.on_fail ?? "retry").trim() || "retry";
    if (onFail !== "retry" && onFail !== "abort" && !onFail.startsWith("goto:")) {
      throw new Error(`stage "${id}" 的 on_fail 非法：${onFail}（仅支持 retry / abort / goto:<id>）`);
    }

    let criteria = undefined;
    if (Array.isArray(st.criteria) && st.criteria.length) {
      const checked = parseCriteria({ acceptance: { criteria: st.criteria } });
      if (!checked.ok) throw new Error(`stage "${id}" 的 criteria 非法：${checked.error}`);
      criteria = checked.criteria;
    }

    out.push({
      id,
      name: String(st.name ?? id).trim() || id,
      to,
      worker,
      cap,
      approval,
      prompt: String(st.prompt ?? "请执行阶段 {{stage_name}}：{{goal}}\n{{prev_result}}\n{{failure_feedback_block}}"),
      criteria,
      on_fail: onFail,
      strict_acceptance: Boolean(st.strict_acceptance),
    });
  }
  // 验证 goto:<id> 指向的 stage 存在。
  for (const st of out) {
    if (st.on_fail.startsWith("goto:")) {
      const target = st.on_fail.slice("goto:".length).trim();
      if (!seenIds.has(target)) {
        throw new Error(`stage "${st.id}" 的 on_fail 指向不存在的阶段 "${target}"`);
      }
    }
  }
  return out;
}

export function renderStagePrompt(template, vars) {
  const feedback = String(vars.failure_feedback ?? "").trim();
  const prev = String(vars.prev_result ?? "").trim();
  const feedbackBlock = feedback
    ? `【上轮失败/未过反馈，请务必针对性修复】\n${feedback}`
    : "";
  const map = {
    goal: String(vars.goal ?? ""),
    prev_result: prev || "(无上阶段输出)",
    failure_feedback: feedback || "(无)",
    failure_feedback_block: feedbackBlock,
    iteration: String(vars.iteration ?? 1),
    stage_id: String(vars.stage_id ?? ""),
    stage_name: String(vars.stage_name ?? ""),
  };
  return String(template ?? "").replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, k) => (
    Object.hasOwn(map, k) ? map[k] : ""
  )).replace(/\n{3,}/g, "\n\n").trim();
}

export async function createLoop({
  bus,
  title = "",
  goal,
  template = "",
  stages = null,
  to = "",
  worker = "",
  cap = "",
  approval = "",
  stageBindings = null,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  context = "",
  from = "hub",
  validateTarget = true,
  now = new Date(),
} = {}) {
  if (!bus?.tables?.loops) throw new Error("当前总线未配置 loops 表");
  const goalText = String(goal ?? "").trim();
  if (!goalText) throw new Error("创建 Loop 需要提供目标 goal");

  let rawStages = stages;
  let tplMeta = null;
  const tplKey = String(template ?? "").trim();
  if (!rawStages) {
    if (!tplKey) throw new Error("请提供 template 或自定义 stages");
    tplMeta = BUILTIN_LOOP_TEMPLATES[tplKey];
    if (!tplMeta) {
      throw new Error(`未知 Loop 模板：${tplKey}（可选：${Object.keys(BUILTIN_LOOP_TEMPLATES).join(", ")}）`);
    }
    rawStages = tplMeta.stages;
  }

  const normalizedStages = normalizeLoopStages(rawStages, {
    to,
    worker,
    cap,
    approval,
    stageBindings,
  });

  const maxIterRaw = Number(maxIterations ?? tplMeta?.max_iterations ?? DEFAULT_MAX_ITERATIONS);
  const maxIter = Math.max(1, Math.min(HOP_LIMIT, Number.isFinite(maxIterRaw) ? Math.floor(maxIterRaw) : DEFAULT_MAX_ITERATIONS));

  const existing = await bus.listRecords(bus.tables.loops);
  const ids = new Set(existing.map((r) => String(f1(r, "Loop_ID") ?? "").trim()).filter(Boolean));
  const loopId = freshLoopId(ids, now instanceof Date ? now : new Date(now));
  const contextId = String(context ?? "").trim() || `ctx-${loopId.toLowerCase()}`;
  const loopTitle = String(title ?? "").trim() || goalText.split("\n")[0].slice(0, 80);

  const first = normalizedStages[0];
  const prompt = renderStagePrompt(first.prompt, {
    goal: goalText,
    prev_result: "",
    failure_feedback: "",
    iteration: 1,
    stage_id: first.id,
    stage_name: first.name,
  });

  const firstTaskId = await createTask({
    bus,
    from: from || "hub",
    source: "loop",
    to: first.to,
    worker: first.worker,
    cap: first.cap,
    text: prompt,
    criteria: first.criteria,
    context: contextId,
    approval: first.approval,
    idempotencyKey: `loop:${loopId}:iter:1`,
    validateTarget,
    now,
  });

  const ts = formatCreatedAt(now);
  const history = [{
    iteration: 1,
    stage_id: first.id,
    stage_name: first.name,
    task_id: firstTaskId,
    status: "submitted",
    at: ts,
  }];

  await bus.createRecord(bus.tables.loops, {
    Loop_ID: loopId,
    Title: loopTitle,
    Goal: goalText,
    Context_ID: contextId,
    Status: "running",
    Template: tplKey || "custom",
    Stages: JSON.stringify(normalizedStages),
    Stage_Index: 0,
    Iteration: 1,
    Max_Iterations: maxIter,
    Active_Task_ID: firstTaskId,
    Last_Result: "",
    Last_Error: "",
    History: JSON.stringify(history),
    Error: "",
    Created_By: from || "hub",
    Created_At: ts,
    Updated_At: ts,
  });

  return {
    loopId,
    contextId,
    firstTaskId,
    stages: normalizedStages,
  };
}

export async function cancelLoop({ bus, loopId, reason = "操作者取消了 SOP 闭环" } = {}) {
  if (!bus?.tables?.loops) throw new Error("当前总线未配置 loops 表");
  const rows = await bus.listRecords(bus.tables.loops);
  const row = rows.find((r) => f1(r, "Loop_ID") === loopId);
  if (!row) throw new Error(`Loop 不存在：${loopId}`);
  const st = f1(row, "Status");
  if (st !== "running") throw new Error(`Loop ${loopId} 当前状态为 ${st}，不可取消`);

  const activeTaskId = String(f1(row, "Active_Task_ID") ?? "").trim();
  if (activeTaskId) {
    try {
      await cancelTask({ bus, taskId: activeTaskId, role: "hub", text: reason });
    } catch {
      // 任务可能已终态，忽略
    }
  }
  const now = formatCreatedAt(new Date());
  await bus.updateRecord(bus.tables.loops, row.record_id, {
    Status: "canceled",
    Error: reason,
    Updated_At: now,
  });
  return { loopId, canceledTaskId: activeTaskId };
}

export class LoopService {
  constructor({ bus, log, now = () => new Date(), role = "hub" } = {}) {
    this.bus = bus;
    this.log = log ?? (() => {});
    this.now = now;
    this.role = role === "node" ? "node" : "hub";
  }

  async scan() {
    if (this.role === "node") return 0;
    const loopsTable = this.bus?.tables?.loops;
    const tasksTable = this.bus?.tables?.tasks;
    if (!loopsTable || !tasksTable) return 0;

    const loops = await this.bus.listRecords(loopsTable);
    const running = loops.filter((l) => f1(l, "Status") === "running");
    if (!running.length) return 0;

    const tasks = await this.bus.listRecords(tasksTable);
    const tasksById = new Map(tasks.map((t) => [String(f1(t, "Task_ID") ?? ""), t]));

    let messagesCache = null;
    let partsCache = null;
    let runsCache = null;
    const loadDetail = async () => {
      if (!messagesCache) messagesCache = await this.bus.listRecords(this.bus.tables.messages);
      if (!partsCache) partsCache = await this.bus.listRecords(this.bus.tables.parts);
      if (!runsCache && this.bus.tables.runs) runsCache = await this.bus.listRecords(this.bus.tables.runs);
    };

    let advanced = 0;
    for (const loopRow of running) {
      const loopId = String(f1(loopRow, "Loop_ID") ?? "");
      const activeTaskId = String(f1(loopRow, "Active_Task_ID") ?? "").trim();
      if (!activeTaskId) continue;
      const task = tasksById.get(activeTaskId);
      if (!task) continue;

      const taskStatus = String(f1(task, "Status") ?? "");
      if (!["completed", "failed", "rejected", "canceled"].includes(taskStatus)) {
        continue;
      }

      const nowDate = this.now() instanceof Date ? this.now() : new Date(this.now());
      const nowStr = formatCreatedAt(nowDate);
      const stages = parseJsonSafe(f1(loopRow, "Stages"), []);
      const stageIndex = Number(f1(loopRow, "Stage_Index")) || 0;
      const iteration = Number(f1(loopRow, "Iteration")) || 1;
      const maxIterations = Math.min(HOP_LIMIT, Number(f1(loopRow, "Max_Iterations")) || DEFAULT_MAX_ITERATIONS);
      const stage = stages[stageIndex];
      if (!stage) {
        await this.bus.updateRecord(loopsTable, loopRow.record_id, {
          Status: "failed",
          Error: `阶段索引越界：${stageIndex}`,
          Updated_At: nowStr,
        });
        continue;
      }

      if (taskStatus === "canceled") {
        await this.bus.updateRecord(loopsTable, loopRow.record_id, {
          Status: "canceled",
          Error: `阶段任务 ${activeTaskId} 已取消`,
          Updated_At: nowStr,
        });
        advanced += 1;
        continue;
      }

      await loadDetail();
      const taskMsgs = messagesCache.filter((m) => f1(m, "Task_ID") === activeTaskId);
      const { acceptance: acc } = acceptanceForTask(taskMsgs, partsCache, activeTaskId, f1(task, "Metadata"));
      const accOverall = String(acc?.overall ?? "");

      const failedByStatus = taskStatus === "failed" || taskStatus === "rejected";
      const failedByAcc = accOverall === "fail" || (stage.strict_acceptance && accOverall === "uncertain");
      const stageFailed = failedByStatus || failedByAcc;

      const history = parseJsonSafe(f1(loopRow, "History"), []);
      const histIdx = history.findIndex((h) => h.task_id === activeTaskId);

      if (!stageFailed) {
        const resultMsg = [...taskMsgs].reverse().find((m) => f1(m, "Kind") === "result");
        const resultText = resultMsg ? messageText(partsCache, f1(resultMsg, "Msg_ID")) : "";
        if (histIdx >= 0) {
          history[histIdx] = {
            ...history[histIdx],
            status: taskStatus,
            outcome: "passed",
            summary: resultText.slice(0, 600),
            finished_at: nowStr,
          };
        }

        if (stageIndex + 1 >= stages.length) {
          await this.bus.updateRecord(loopsTable, loopRow.record_id, {
            Status: "completed",
            Last_Result: resultText.slice(0, 4000),
            History: JSON.stringify(history),
            Updated_At: nowStr,
          });
          this.log(`loop completed ${loopId} (iterations=${iteration})`);
          advanced += 1;
          continue;
        }

        const nextStageIdx = stageIndex + 1;
        const nextStage = stages[nextStageIdx];
        const nextIter = iteration + 1;
        const hop = Number(f1(task, "Hop_Count")) || 0;
        if (nextIter > maxIterations || hop + 1 > HOP_LIMIT) {
          await this.bus.updateRecord(loopsTable, loopRow.record_id, {
            Status: "failed",
            Last_Result: resultText.slice(0, 4000),
            Error: `已达最大迭代上限（iteration=${iteration}/${maxIterations}, hop=${hop}）`,
            History: JSON.stringify(history),
            Updated_At: nowStr,
          });
          this.log(`loop aborted ${loopId}: max iterations/hop reached`);
          advanced += 1;
          continue;
        }

        const nextPrompt = renderStagePrompt(nextStage.prompt, {
          goal: f1(loopRow, "Goal"),
          prev_result: resultText,
          failure_feedback: "",
          iteration: nextIter,
          stage_id: nextStage.id,
          stage_name: nextStage.name,
        });

        try {
          const nextTaskId = await createTask({
            bus: this.bus,
            from: String(f1(loopRow, "Created_By") ?? "hub") || "hub",
            source: "loop",
            to: nextStage.to,
            worker: nextStage.worker,
            cap: nextStage.cap,
            text: nextPrompt,
            criteria: nextStage.criteria,
            context: f1(loopRow, "Context_ID"),
            ref: activeTaskId,
            approval: nextStage.approval,
            idempotencyKey: `loop:${loopId}:iter:${nextIter}`,
            validateTarget: false,
            now: nowDate,
          });
          history.push({
            iteration: nextIter,
            stage_id: nextStage.id,
            stage_name: nextStage.name,
            task_id: nextTaskId,
            status: "submitted",
            at: nowStr,
          });
          await this.bus.updateRecord(loopsTable, loopRow.record_id, {
            Stage_Index: nextStageIdx,
            Iteration: nextIter,
            Active_Task_ID: nextTaskId,
            Last_Result: resultText.slice(0, 4000),
            Last_Error: "",
            History: JSON.stringify(history),
            Updated_At: nowStr,
          });
          this.log(`loop ${loopId} advanced ${stage.id} -> ${nextStage.id} (${nextTaskId})`);
          advanced += 1;
        } catch (e) {
          await this.bus.updateRecord(loopsTable, loopRow.record_id, {
            Status: "failed",
            Error: `派生阶段 ${nextStage.id} 失败：${e?.message ?? e}`,
            History: JSON.stringify(history),
            Updated_At: nowStr,
          });
          advanced += 1;
        }
        continue;
      }

      // 当前阶段失败或验收不通过：提取失败反馈并根据 on_fail 决定重试/回跳/中止。
      const noticeMsg = [...taskMsgs].reverse().find((m) => f1(m, "Kind") === "notice");
      const noticeText = noticeMsg ? messageText(partsCache, f1(noticeMsg, "Msg_ID")) : "";
      const resultMsg = [...taskMsgs].reverse().find((m) => f1(m, "Kind") === "result");
      const resultText = resultMsg ? messageText(partsCache, f1(resultMsg, "Msg_ID")) : "";
      const latestRun = (runsCache ?? []).filter((r) => f1(r, "Task_Ref") === activeTaskId).pop();
      const errLog = latestRun ? String(f1(latestRun, "Error_Log") ?? "").trim() : "";

      const feedbackParts = [];
      if (noticeText) feedbackParts.push(noticeText);
      if (failedByAcc) {
        const failedChecks = (acc?.checks ?? [])
          .filter((c) => (c.verdict ?? c.status) !== "pass")
          .map((c) => {
            const v = c.verdict ?? c.status ?? "fail";
            const ev = c.evidence ?? c.note ?? "";
            return `- [${v}] ${c.id}${ev ? ": " + ev : ""}`;
          })
          .join("\n");
        feedbackParts.push(`验收门禁判定 overall=${accOverall}` + (failedChecks ? `\n${failedChecks}` : ""));
      }
      if (errLog) feedbackParts.push(`执行日志：${errLog}`);
      if (resultText && !noticeText) feedbackParts.push(`阶段输出摘要：\n${resultText.slice(0, 800)}`);
      const feedback = feedbackParts.filter(Boolean).join("\n").slice(0, 2500) || `任务 ${activeTaskId} 状态为 ${taskStatus}`;

      if (histIdx >= 0) {
        history[histIdx] = {
          ...history[histIdx],
          status: taskStatus,
          outcome: "failed",
          error: feedback.slice(0, 600),
          finished_at: nowStr,
        };
      }

      const onFail = String(stage.on_fail ?? "retry");
      const hop = Number(f1(task, "Hop_Count")) || 0;
      const nextIter = iteration + 1;

      if (onFail === "abort" || nextIter > maxIterations || hop + 1 > HOP_LIMIT) {
        const why = onFail === "abort"
          ? `阶段 ${stage.id} 失败且策略为 abort`
          : `已达最大闭环迭代上限（${iteration}/${maxIterations}，hop=${hop}）`;
        await this.bus.updateRecord(loopsTable, loopRow.record_id, {
          Status: "failed",
          Last_Error: feedback,
          Error: `${why}：${feedback.slice(0, 300)}`,
          History: JSON.stringify(history),
          Updated_At: nowStr,
        });
        this.log(`loop failed ${loopId}: ${why}`);
        advanced += 1;
        continue;
      }

      let targetIdx = stageIndex;
      if (onFail.startsWith("goto:")) {
        const targetId = onFail.slice("goto:".length).trim();
        const found = stages.findIndex((s) => s.id === targetId);
        if (found >= 0) targetIdx = found;
      }
      const targetStage = stages[targetIdx];
      const nextPrompt = renderStagePrompt(targetStage.prompt, {
        goal: f1(loopRow, "Goal"),
        prev_result: resultText || String(f1(loopRow, "Last_Result") ?? ""),
        failure_feedback: feedback,
        iteration: nextIter,
        stage_id: targetStage.id,
        stage_name: targetStage.name,
      });

      try {
        const nextTaskId = await createTask({
          bus: this.bus,
          from: String(f1(loopRow, "Created_By") ?? "hub") || "hub",
          source: "loop",
          to: targetStage.to,
          worker: targetStage.worker,
          cap: targetStage.cap,
          text: nextPrompt,
          criteria: targetStage.criteria,
          context: f1(loopRow, "Context_ID"),
          ref: activeTaskId,
          approval: targetStage.approval,
          idempotencyKey: `loop:${loopId}:iter:${nextIter}`,
          validateTarget: false,
          now: nowDate,
        });
        history.push({
          iteration: nextIter,
          stage_id: targetStage.id,
          stage_name: targetStage.name,
          task_id: nextTaskId,
          status: "submitted",
          retry_from: stage.id,
          at: nowStr,
        });
        await this.bus.updateRecord(loopsTable, loopRow.record_id, {
          Stage_Index: targetIdx,
          Iteration: nextIter,
          Active_Task_ID: nextTaskId,
          Last_Error: feedback,
          History: JSON.stringify(history),
          Updated_At: nowStr,
        });
        this.log(`loop ${loopId} feedback loop ${stage.id} -> ${targetStage.id} (${nextTaskId}, iter=${nextIter})`);
        advanced += 1;
      } catch (e) {
        await this.bus.updateRecord(loopsTable, loopRow.record_id, {
          Status: "failed",
          Last_Error: feedback,
          Error: `打回阶段 ${targetStage.id} 建单失败：${e?.message ?? e}`,
          History: JSON.stringify(history),
          Updated_At: nowStr,
        });
        advanced += 1;
      }
    }
    return advanced;
  }
}
