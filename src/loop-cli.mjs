// ah loop CLI 实现：创建、查看、取消多阶段 SOP 闭环与列出内置模板。

import fs from "node:fs";
import { f1 } from "./bus/tables.mjs";
import { loadConfig } from "./config.mjs";
import { BUILTIN_LOOP_TEMPLATES, cancelLoop, createLoop } from "./hub/loop.mjs";

function parseJsonArg(raw, label) {
  let text = String(raw ?? "");
  if (text.startsWith("@")) {
    const file = text.slice(1);
    if (!file) throw new Error(`${label} @文件 缺少路径`);
    text = fs.readFileSync(file, "utf8");
  }
  return JSON.parse(text);
}

export async function runLoopCli(argv, defaultConfigDir) {
  const sub = argv[0];
  const rest = argv.slice(1);
  let configDir = defaultConfigDir;

  const take = (i, flag) => {
    const val = rest[i + 1];
    if (val == null || val.startsWith("--")) throw new Error(`${flag} 需要参数`);
    return val;
  };

  if (sub === "templates") {
    const list = Object.values(BUILTIN_LOOP_TEMPLATES).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      max_iterations: t.max_iterations,
      stages: t.stages.map((s) => ({ id: s.id, name: s.name, on_fail: s.on_fail })),
    }));
    console.log(JSON.stringify(list, null, 2));
    return 0;
  }

  if (sub === "create") {
    let title = "";
    let goal = "";
    let template = "plan-code-verify";
    let stagesRaw = "";
    let bindingsRaw = "";
    let to = "";
    let worker = "";
    let cap = "";
    let approval = "";
    let maxIterations;
    let context = "";
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (flag === "--config") configDir = take(i, flag);
      else if (flag === "--title") title = take(i, flag);
      else if (flag === "--goal") goal = take(i, flag);
      else if (flag === "--template") template = take(i, flag);
      else if (flag === "--stages") stagesRaw = take(i, flag);
      else if (flag === "--bindings") bindingsRaw = take(i, flag);
      else if (flag === "--to") to = take(i, flag);
      else if (flag === "--worker") worker = take(i, flag);
      else if (flag === "--cap" || flag === "--skill") cap = take(i, flag);
      else if (flag === "--approval") approval = take(i, flag);
      else if (flag === "--max-iterations") maxIterations = Number(take(i, flag));
      else if (flag === "--context") context = take(i, flag);
      else throw new Error(`无法识别的参数：${flag}`);
      if (flag.startsWith("--")) i++;
    }
    const cfg = loadConfig(configDir, { forCli: true });
    const stages = stagesRaw ? parseJsonArg(stagesRaw, "--stages") : null;
    const stageBindings = bindingsRaw ? parseJsonArg(bindingsRaw, "--bindings") : null;
    const res = await createLoop({
      bus: cfg.bus,
      title,
      goal,
      template: stages ? "" : template,
      stages,
      stageBindings,
      to,
      worker,
      cap,
      approval,
      maxIterations,
      context,
      from: cfg.node,
      validateTarget: true,
    });
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }

  if (sub === "ls") {
    let json = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--config") { configDir = take(i, "--config"); i++; }
      else if (rest[i] === "--json") json = true;
    }
    const cfg = loadConfig(configDir, { forCli: true });
    const rows = await cfg.bus.listRecords(cfg.bus.tables.loops);
    const items = rows.map((r) => ({
      loop_id: f1(r, "Loop_ID"),
      title: f1(r, "Title"),
      status: f1(r, "Status"),
      template: f1(r, "Template"),
      stage_index: f1(r, "Stage_Index"),
      iteration: `${f1(r, "Iteration")}/${f1(r, "Max_Iterations")}`,
      active_task_id: f1(r, "Active_Task_ID"),
      updated_at: f1(r, "Updated_At"),
    }));
    if (json || !items.length) {
      console.log(JSON.stringify(items, null, 2));
      return 0;
    }
    for (const item of items) {
      console.log(`${item.loop_id}  [${item.status}]  iter=${item.iteration}  task=${item.active_task_id}  ${item.title}`);
    }
    return 0;
  }

  if (sub === "show") {
    let loopId = "";
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--config") { configDir = take(i, "--config"); i++; }
      else if (rest[i] === "--loop") { loopId = take(i, "--loop"); i++; }
      else if (!rest[i].startsWith("--") && !loopId) loopId = rest[i];
    }
    if (!loopId) throw new Error("用法：ah loop show <Loop_ID>");
    const cfg = loadConfig(configDir, { forCli: true });
    const rows = await cfg.bus.listRecords(cfg.bus.tables.loops);
    const row = rows.find((r) => f1(r, "Loop_ID") === loopId);
    if (!row) throw new Error(`Loop 不存在：${loopId}`);
    console.log(JSON.stringify({
      loop_id: f1(row, "Loop_ID"),
      title: f1(row, "Title"),
      goal: f1(row, "Goal"),
      status: f1(row, "Status"),
      template: f1(row, "Template"),
      context_id: f1(row, "Context_ID"),
      stage_index: f1(row, "Stage_Index"),
      iteration: f1(row, "Iteration"),
      max_iterations: f1(row, "Max_Iterations"),
      active_task_id: f1(row, "Active_Task_ID"),
      stages: JSON.parse(f1(row, "Stages") || "[]"),
      history: JSON.parse(f1(row, "History") || "[]"),
      last_result: f1(row, "Last_Result"),
      last_error: f1(row, "Last_Error"),
      error: f1(row, "Error"),
    }, null, 2));
    return 0;
  }

  if (sub === "cancel") {
    let loopId = "";
    let text = "";
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--config") { configDir = take(i, "--config"); i++; }
      else if (rest[i] === "--loop") { loopId = take(i, "--loop"); i++; }
      else if (rest[i] === "--text") { text = take(i, "--text"); i++; }
      else if (!rest[i].startsWith("--") && !loopId) loopId = rest[i];
    }
    if (!loopId) throw new Error("用法：ah loop cancel <Loop_ID> [--text <说明>]");
    const cfg = loadConfig(configDir, { forCli: true });
    const res = await cancelLoop({ bus: cfg.bus, loopId, reason: text || "操作者取消了 SOP 闭环" });
    console.log(`已取消 Loop ${res.loopId}` + (res.canceledTaskId ? `（并取消在途任务 ${res.canceledTaskId}）` : ""));
    return 0;
  }

  throw new Error("用法：ah loop <create|ls|show|cancel|templates>");
}
