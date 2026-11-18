#!/usr/bin/env node
// 写出 SQLite 逻辑表契约：schema/base-schema.json 与 docs/base-schema.md。
// 行数据存在 records.fields_json，不按列建物理表。本脚本不访问网络。
//
//   node schema/generate_schema.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATUS = ["submitted", "working", "input-required", "auth-required", "completed", "failed", "canceled", "rejected"];
const YES_NO = ["Yes", "No"];

function field(name, type, extra = {}) {
  const entry = { name, type, primary: Boolean(extra.primary) };
  if (extra.options) entry.options = extra.options;
  if (extra.note) entry.note = extra.note;
  return entry;
}

const TABLES = [
  {
    name: "tasks",
    role: "Task：一件工作的信封与状态机，一行一任务",
    fields: [
      field("Title", "text", { primary: true, note: "主字段" }),
      field("Task_ID", "text", { note: "业务编号，唯一、人可读，发起方生成后不变" }),
      field("Source", "text", { note: "任务来源：hub / cron / manual / agent-derived 等" }),
      field("Target_Node", "text", { note: "目标节点名，与 agentCards.Node 对应" }),
      field("Worker_Hint", "text", { note: "指定目标节点上的 Worker；写了是硬约束，留空由节点取默认并在认领时回填" }),
      field("Skill_ID", "text", { note: "要调用的技能 id，与 agentCards.Skill_ID 对应" }),
      field("Status", "select", { options: STATUS, note: "A2A 八态状态机；终态不可变" }),
      field("Approval_Class", "select", { options: ["auto", "notify", "approve"], note: "approve 类须走审批流" }),
      field("Hop_Count", "number", { note: "派生层数，>8 熔断" }),
      field("Idempotency_Key", "text", { note: "建单幂等键：来源+业务键" }),
      field("Latest_Run", "text", { note: "最新一条 Run 的 Run_ID" }),
      field("Presented", "select", { options: YES_NO, note: "结果是否已呈递给操作者" }),
      field("Claimed_By", "text", { note: "认领租约：当前持有节点" }),
      field("Heartbeat_At", "text", { note: "认领心跳；20 分钟无心跳视为放弃、可回收" }),
      field("Retry_Count", "number", { note: "失败重试计数，上限 2" }),
      field("Context_ID", "text", { note: "会话键（A2A contextId）：同一件事的全部任务共享" }),
      field("Status_Msg", "text", { note: "指向当前提问/待批消息的 Msg_ID" }),
      field("Metadata", "text", { note: "A2A 原生自由字段（JSON）；非核心本地信息放这里，不新增列" }),
    ],
  },
  {
    name: "messages",
    role: "Message：任务内全部对话轮次，只追加，一行一消息（正文在 parts）",
    fields: [
      field("Msg_ID", "text", { primary: true, note: "主键，同时是幂等键（重复投递靠它去重）" }),
      field("Task_ID", "text"),
      field("Context_ID", "text"),
      field("From_Node", "text"),
      field("To_Node", "text"),
      field("Role", "select", { options: ["user", "agent"], note: "user（发起方→执行方）/ agent（执行方→发起方）" }),
      field("Kind", "select", {
        options: ["instruction", "question", "answer", "auth_request", "auth_decision", "progress", "result", "notice"],
        note: "消息种类",
      }),
      field("Artifact_Ref", "text", { note: "关联的 Artifact_ID（result 消息用）" }),
      field("In_Reply_To", "text", { note: "所回复消息的 Msg_ID，构成对话链" }),
      field("Created_At", "text"),
      field("Ref_Task_IDs", "text", { note: "A2A referenceTaskIds：本消息关联/派生的前任任务" }),
    ],
  },
  {
    name: "parts",
    role: "Part：消息与产物的内容块，一行一块，text/file/data 三型",
    fields: [
      field("Part_ID", "text", { primary: true, note: "主字段" }),
      field("Parent_ID", "text", { note: "所属消息 Msg_ID 或产物 Artifact_ID" }),
      field("Parent_Type", "select", { options: ["message", "artifact"], note: "message / artifact" }),
      field("Seq", "number"),
      field("Kind", "select", { options: ["text", "file", "data"], note: "text / file / data（A2A TextPart / FilePart / DataPart）" }),
      field("Text", "text", { note: "text 块正文；长内容只放指针，本体放产物或外部存储" }),
      field("File_URI", "text"),
      field("File_Name", "text"),
      field("Mime_Type", "text"),
      field("Data", "text", { note: "data 块的 JSON：任务参数、审批决定等走这里" }),
    ],
  },
  {
    name: "runs",
    role: "每次执行的起止、结果与报错",
    fields: [
      field("Run_ID", "text", { primary: true, note: "形如 <Task_ID>-R<序号>" }),
      field("Task_Ref", "text"),
      field("Node", "text"),
      field("Worker", "text", { note: "本次执行实际使用的 Worker；节点本尊直接执行记 daemon" }),
      field("Error_Log", "text", { note: "失败信息；沟通内容不写这里，去 messages" }),
      field("Started_At", "text"),
      field("Finished_At", "text"),
      field("Outcome", "select", { options: ["succeeded", "failed", "paused"], note: "paused＝等补信息暂停，不计失败" }),
    ],
  },
  {
    name: "artifacts",
    role: "Artifact：交付物登记，内容为其 FilePart，修订＝同名新 ID",
    fields: [
      field("Artifact_ID", "text", { primary: true, note: "建议 <Task_ID>-A<序号>" }),
      field("Task_ID", "text"),
      field("Context_ID", "text"),
      field("Name", "text", { note: "产物名；同名再交付即新版本（修订＝同名新 ID）" }),
      field("Is_Final", "select", { options: YES_NO, note: "是否终稿" }),
      field("Created_By", "text"),
      field("Created_At", "text"),
      field("Description", "text"),
      field("Metadata", "text"),
    ],
  },
  {
    name: "agentCards",
    role: "AgentCard 规范化展开：一行一项能力",
    fields: [
      field("Cap_ID", "text", { primary: true, note: "行主键：CAP-<节点前缀>-<技能>；Worker 的能力为 CAP-<节点前缀>-<Worker>-<技能>" }),
      field("Node", "text", { note: "节点名（AgentCard name 的节点部分）" }),
      field("Zone", "text"),
      field("Description", "text", { note: "技能说明（skill.description）" }),
      field("Skill_ID", "text", { note: "技能 id（skill.id）" }),
      field("Side_Effect", "select", { options: ["read", "write", "external"], note: "决定默认审批等级" }),
      field("Availability", "text", { note: "online / work-hours / offline 等在册状态" }),
      field("Dispatchable", "select", { options: YES_NO, note: "Yes 才可派发" }),
      field("Daemon_Version", "text"),
      field("Node_Desc", "text"),
      field("Receive_Mode", "select", { options: ["longpoll", "poll"], note: "唤醒方式" }),
      field("Skill_Name", "text"),
      field("Input_Modes", "text"),
      field("Output_Modes", "text"),
      field("Metadata", "text", { note: "A2A 原生自由字段（JSON）；内核登记写入 {kind, mode}，可为空" }),
      field("Worker", "text", { note: "该能力由哪个 Worker 执行，留空＝节点本尊" }),
      field("Admission", "select", { options: ["admitted", "pending", "rejected"], note: "机主接纳状态；缺省、空或其他值按 pending。只由 Hub 管理 API 写" }),
      field("Display_Name", "text", { note: "机主显示名，可空，不超过 64 字符。只由 Hub 管理 API 写" }),
      field("Admin_Note", "text", { note: "机主备注，可空，不超过 500 字符。只由 Hub 管理 API 写" }),
    ],
  },
  {
    name: "rules",
    role: "路由、审批策略与定时观察镜像",
    fields: [
      field("Rule_ID", "text", { primary: true, note: "主字段" }),
      field("Match_Type", "text", { note: "按 Skill_ID 或标签匹配" }),
      field("Target_Node", "text"),
      field("Worker_Hint", "text"),
      field("Skill_ID", "text"),
      field("Approval_Class", "select", { options: ["auto", "notify", "approve"] }),
      field("Priority", "number", { note: "多规则命中时按优先级取一" }),
      field("Enabled", "select", { options: YES_NO, note: "是否生效" }),
      field("Note", "text"),
      field("Schedule", "text"),
      field("Text", "text"),
      field("Last_Fired", "text"),
    ],
  },
  {
    name: "loops",
    role: "LoopForge 多阶段闭环：同一 Context_ID 下的阶段任务",
    fields: [
      field("Loop_ID", "text", { primary: true, note: "主字段" }),
      field("Title", "text"),
      field("Goal", "text"),
      field("Context_ID", "text"),
      field("Status", "text", { note: "running 等闭环状态" }),
      field("Template", "text", { note: "内置模板 id，或 custom" }),
      field("Stages", "text", { note: "阶段定义 JSON" }),
      field("Stage_Index", "number"),
      field("Iteration", "number"),
      field("Max_Iterations", "number", { note: "与 HOP_LIMIT=8 一起限制回跳" }),
      field("Active_Task_ID", "text"),
      field("Last_Result", "text"),
      field("Last_Error", "text"),
      field("History", "text", { note: "阶段历史 JSON" }),
      field("Error", "text"),
      field("Created_By", "text"),
      field("Created_At", "text"),
      field("Updated_At", "text"),
    ],
  },
];

export function buildSchema() {
  return {
    name: "a2a-hub SQLite 逻辑表",
    generated_by: "schema/generate_schema.mjs",
    note: "SQLite 将每行 fields 存为 JSON。本文件描述逻辑字段，不对应物理列。语义见 docs/base-schema.md 与 docs/standard.md。",
    tables: TABLES.map((table) => ({
      name: table.name,
      role: table.role,
      fields: table.fields.map((item) => {
        const out = { name: item.name, type: item.type, primary: item.primary };
        if (item.options) out.options = item.options;
        return out;
      }),
    })),
  };
}

export function renderMarkdown(schema) {
  const notes = new Map();
  for (const table of TABLES) {
    notes.set(table.name, new Map(table.fields.filter((item) => item.note).map((item) => [item.name, item.note])));
  }
  const lines = [
    "# 逻辑表结构",
    "",
    "本文件由 `schema/generate_schema.mjs` 从仓库内的 SQLite 逻辑表定义生成。",
    "独立中台把这些字段放进 `records.fields_json`，不按列建物理表。完整规范见",
    "[中台标准](standard.md)。",
    "",
  ];
  for (const table of schema.tables) {
    lines.push(`## ${table.name}`);
    lines.push("");
    lines.push(table.role);
    lines.push("");
    lines.push("| 字段 | 类型 | 说明 |");
    lines.push("|---|---|---|");
    const tableNotes = notes.get(table.name) ?? new Map();
    for (const item of table.fields) {
      let desc = tableNotes.get(item.name) ?? "";
      if (item.options) {
        const opt = "选项：" + item.options.join(" / ");
        desc = desc ? `${desc}（${opt}）` : opt;
      }
      if (item.primary) desc = desc ? `主字段。${desc}` : "主字段";
      lines.push(`| ${item.name} | ${item.type} | ${desc} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.dirname(here);
  const schema = buildSchema();
  fs.writeFileSync(path.join(here, "base-schema.json"), JSON.stringify(schema, null, 1) + "\n");
  fs.writeFileSync(path.join(root, "docs", "base-schema.md"), renderMarkdown(schema));
  console.log("tables:", schema.tables.map((table) => [table.name, table.fields.length]));
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(entry) === fs.realpathSync(self);
  } catch {
    return path.resolve(entry) === path.resolve(self);
  }
}

if (invokedDirectly()) {
  try {
    main();
  } catch (e) {
    console.error(e?.message ?? e);
    process.exit(1);
  }
}
