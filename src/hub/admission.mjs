// 名片接纳与新 Agent 接入引导纯函数：归一化 Admission、校验管理请求参数、构造 onboarding 指引。

import { f1 } from "../bus/tables.mjs";

export const ADMISSION_VALUES = Object.freeze(["admitted", "pending", "rejected"]);
export const ACCESS_VALUES = Object.freeze(["http", "host", "inbox"]);
export const ROLE_VALUES = Object.freeze(["worker", "leader", "hybrid"]);

const ADMISSION_SET = new Set(ADMISSION_VALUES);
const ACCESS_SET = new Set(ACCESS_VALUES);
const ROLE_SET = new Set(ROLE_VALUES);

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// 兼容完整记录（{ fields: { Admission } }）与扁平字段对象，缺省/非法一律按 pending 处理，
// 让历史名片无需建表迁移即可自动归入待接纳池。
export function admissionOf(card) {
  const raw = card?.fields !== undefined
    ? f1(card, "Admission")
    : (Array.isArray(card?.Admission) ? card.Admission[0] : card?.Admission);
  const val = String(raw ?? "").trim().toLowerCase();
  return ADMISSION_SET.has(val) ? val : "pending";
}

export function isAdmitted(card) {
  return admissionOf(card) === "admitted";
}

export function validateNodeName(raw) {
  const node = String(raw ?? "").trim();
  if (!node || node === "*" || node.length > 64 || !/^[A-Za-z0-9._-]+$/.test(node)) {
    throw httpError(400, "node 名称不合法（只允许字母、数字、._-，且不能为空）");
  }
  return node;
}

export function validateAdmission(raw) {
  const val = String(raw ?? "").trim();
  if (!ADMISSION_SET.has(val)) {
    throw httpError(400, `admission 只能是 ${ADMISSION_VALUES.join(" / ")}`);
  }
  return val;
}

export function validateAccess(raw) {
  const val = String(raw ?? "").trim().toLowerCase();
  if (!ACCESS_SET.has(val)) {
    throw httpError(400, `access 只能是 ${ACCESS_VALUES.join(" / ")}`);
  }
  return val;
}

export function validateRole(raw) {
  const val = String(raw ?? "").trim().toLowerCase();
  if (!ROLE_SET.has(val)) {
    throw httpError(400, `role 只能是 ${ROLE_VALUES.join(" / ")}`);
  }
  return val;
}

export function validateProfileFields(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "请求体必须是 JSON 对象");
  }
  const patch = {};
  if (Object.hasOwn(body, "display_name") && body.display_name !== undefined) {
    if (body.display_name !== null && typeof body.display_name !== "string") {
      throw httpError(400, "display_name 必须是字符串");
    }
    const val = body.display_name == null ? "" : body.display_name.trim();
    if (val.length > 64) {
      throw httpError(400, "display_name 不能超过 64 个字符");
    }
    patch.Display_Name = val;
  }
  if (Object.hasOwn(body, "admin_note") && body.admin_note !== undefined) {
    if (body.admin_note !== null && typeof body.admin_note !== "string") {
      throw httpError(400, "admin_note 必须是字符串");
    }
    const val = body.admin_note == null ? "" : body.admin_note.trim();
    if (val.length > 500) {
      throw httpError(400, "admin_note 不能超过 500 个字符");
    }
    patch.Admin_Note = val;
  }
  return patch;
}

export function parseCardMetadata(card) {
  const rawMeta = card?.fields !== undefined ? f1(card, "Metadata") : card?.Metadata;
  if (!rawMeta) return { kind: "", role: "" };
  try {
    const meta = typeof rawMeta === "object" ? rawMeta : JSON.parse(String(rawMeta));
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return { kind: "", role: "" };
    return {
      kind: meta.kind == null ? "" : String(meta.kind),
      role: meta.role == null ? "" : String(meta.role),
    };
  } catch {
    return { kind: "", role: "" };
  }
}

export function formatAgentCard(c) {
  const { kind, role } = parseCardMetadata(c);
  return {
    record_id: c.record_id,
    cap_id: f1(c, "Cap_ID"),
    node: f1(c, "Node"),
    worker: f1(c, "Worker"),
    skill_id: f1(c, "Skill_ID"),
    skill_name: f1(c, "Skill_Name"),
    description: f1(c, "Description"),
    side_effect: f1(c, "Side_Effect"),
    availability: f1(c, "Availability"),
    dispatchable: f1(c, "Dispatchable"),
    receive_mode: f1(c, "Receive_Mode"),
    daemon_version: f1(c, "Daemon_Version"),
    node_desc: f1(c, "Node_Desc"),
    zone: f1(c, "Zone"),
    admission: admissionOf(c),
    display_name: String(f1(c, "Display_Name") ?? ""),
    admin_note: String(f1(c, "Admin_Note") ?? ""),
    kind,
    role,
  };
}

function skillNamesFor(access, role) {
  if (access === "host") return [];
  if (access === "inbox") return ["ah-inbox"];
  if (role === "leader") return ["a2a-leader"];
  if (role === "hybrid") return ["a2a-worker", "a2a-leader"];
  return ["a2a-worker"];
}

function roleSummary(role) {
  if (role === "leader") return "作为调度控制端（leader），负责向其他节点派发任务并跟踪结果更新。";
  if (role === "hybrid") return "作为混合角色（hybrid），既可认领分配给本节点的任务并回执结果，也可向其他节点派发协同任务。";
  return "作为执行端（worker），负责轮询认领分配给本节点的任务、按要求回执进度与结果。";
}

// 绝不在引导里拼接任何真实 Token，只使用占位符或明确说明无需 Token，避免控制台输出泄露凭据。
export function buildOnboarding({ hubUrl, node, access, role, authRequired = false }) {
  const base = String(hubUrl ?? "").trim().replace(/\/+$/, "") || "http://127.0.0.1:8787";
  const skills = skillNamesFor(access, role).map((name) => ({
    name,
    url: `${base}/api/v1/skills/${name}`,
  }));
  const authNote = authRequired
    ? "携带请求头 Authorization: Bearer <AH_API_TOKEN>（请向机主获取真实 Token 替换占位符）"
    : "当前 Hub 未开启鉴权，无需提供 Token";
  const tokenFlag = authRequired ? " --api-token <AH_API_TOKEN>" : "";

  let steps;
  if (access === "host") {
    steps = [
      `若目标宿主机尚未安装 a2a-hub CLI，运行一行安装并接入：curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh -s -- --join ${base} --node ${node}${tokenFlag}`,
      `若目标宿主机已安装 ah CLI，直接执行：ah join ${base} --node ${node}${tokenFlag} --service`,
      "宿主机守护进程上线并登记能力名片后会进入「待接纳」池，请到 Web 控制台「Agent 名片墙 → 待接纳」点击接纳后再派单。",
    ];
  } else if (access === "inbox") {
    steps = [
      `若目标机器尚未安装 a2a-hub CLI，运行一行安装并接入（独立 Agent 模式）：curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh -s -- --join ${base} --node ${node} --kind agent${tokenFlag}`,
      `若已安装 ah CLI，执行（将自动安装 ah-inbox 协议 Skill）：ah join ${base} --node ${node} --kind agent${tokenFlag} --service`,
      "名片上线后会进入「待接纳」池，请在 Web 控制台「Agent 名片墙 → 待接纳」中接纳该节点；随后 Agent 通过 ah inbox 接单并回执。",
    ];
  } else if (role === "leader") {
    steps = [
      `先拉取协议 Skill（${authNote}）：${skills.map((s) => `GET ${s.url}`).join("、")}`,
      `可选上报在线态：POST ${base}/api/v1/agents/register，body 为 {"node":"${node}","role":"leader","kind":"agent","receive_mode":"http-poll"}（Leader 无能力名片，无需等待接纳）`,
      `通过 POST ${base}/api/v1/tasks 派单，并用 GET ${base}/api/v1/agents/${node}/updates?timeout=25 轮询任务进展与结果。`,
    ];
  } else {
    steps = [
      `先拉取协议 Skill（${authNote}）：${skills.map((s) => `GET ${s.url}`).join("、")}`,
      `调用 POST ${base}/api/v1/agents/register（body: {"node":"${node}","role":"${role}","kind":"agent","receive_mode":"http-poll"}）上线；默认 agent 名片已在添加时预建并接纳（若注册自定义 caps，需在「待接纳」中接纳后才可派单）。`,
      `长轮询取单：GET ${base}/api/v1/agents/${node}/poll?timeout=25，取单后按 /claim、/complete、/fail、/ask、/auth 回执${role === "hybrid" ? `；派单与拉取结果使用 POST ${base}/api/v1/tasks 与 GET ${base}/api/v1/agents/${node}/updates` : ""}。`,
    ];
  }

  const skillPromptLine = skills.length
    ? `接入后请先拉取并阅读协议 Skill：${skills.map((s) => s.url).join(" ，")}`
    : "本宿主机接入方式无需额外拉取协议 Skill，任务回执规范已内置于调度指令中。";

  const prompt = [
    `请接入 a2a-hub 多 Agent 编排中台：`,
    `- Hub 地址：${base}`,
    `- 你的节点名：${node}`,
    `- 接入方式：${access}，角色：${role}`,
    `- 鉴权要求：${authRequired ? "Bearer Token，占位符为 <AH_API_TOKEN>（请向机主索取真实 Token 后再请求）" : "无需 Token（免鉴权）"}`,
    `- ${skillPromptLine}`,
    `- 职责说明：${roleSummary(role)}`,
  ].join("\n");

  return {
    access,
    role,
    skills,
    steps,
    prompt,
  };
}
