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

// token 有值时内嵌这一次明文；没有则只用占位符。host/inbox 的 join 用的是机主 Token，命令行仍写占位符，不把 Agent Token 写进去。
function credentialOf(token, authRequired) {
  const secret = String(token ?? "").trim();
  if (secret) {
    return {
      mode: "token",
      header: `Authorization: Bearer ${secret}`,
      promptLine: `Bearer Token：${secret}（每次请求都带请求头 Authorization: Bearer ${secret}）`,
    };
  }
  if (authRequired) {
    return {
      mode: "placeholder",
      header: "Authorization: Bearer <AH_API_TOKEN>",
      promptLine: "Bearer Token，占位符为 <AH_API_TOKEN>（请向机主索取真实 Token 后再请求）",
    };
  }
  return {
    mode: "none",
    header: "",
    promptLine: "无需 Token（免鉴权）",
  };
}

function authBullet(cred) {
  if (cred.mode === "none") return "当前 Hub 未开启鉴权，请求不带 Authorization 头。";
  return `除 GET /.well-known/agent.json 与 GET /api/v1/health 外，所有 /api/*（含 /api/v1/skills/*）都要带请求头 ${cred.header}。不要把 Skill 地址当成免鉴权。`;
}

function workerSchedule(base, node, cred, role = "worker") {
  const head = cred.mode === "none" ? "（当前免鉴权，不要加 Authorization）" : `请求头：${cred.header}`;
  return [
    `【定时指令】（每 10 分钟运行一次；每次都没有上一轮上下文，只按本段原文执行）`,
    `你是节点 ${node} 的 ${role}（本段是取单与回执）。Hub：${base}。${head}`,
    "只处理分配给自己的任务，不要认领或改别人的任务。",
    `1. 报到：POST ${base}/api/v1/agents/register ，body {"node":"${node}","role":"${role}","kind":"agent","receive_mode":"http-poll"}`,
    `2. 短轮询取单：GET ${base}/api/v1/agents/${node}/poll?timeout=0 （timeout=0，不要长轮询挂起）`,
    `3. 对返回的每个任务：POST ${base}/api/v1/tasks/<task_id>/claim ，body {"node":"${node}"}`,
    `4. 在本次运行内做完。若预计超过 10 分钟，处理期间 POST ${base}/api/v1/tasks/<task_id>/heartbeat ，body {"node":"${node}","text":"当前进度"}`,
    `5. 成功：POST ${base}/api/v1/tasks/<task_id>/complete ，body {"node":"${node}","text":"结果摘要"}。失败：POST ${base}/api/v1/tasks/<task_id>/fail ，body {"node":"${node}","text":"失败原因"}`,
    `6. 缺信息：POST ${base}/api/v1/tasks/<task_id>/ask ，body {"node":"${node}","text":"缺什么"}，然后停下该任务，不要猜。`,
    `7. 敏感或有副作用、需要机主点头的动作：POST ${base}/api/v1/tasks/<task_id>/auth ，body {"node":"${node}","text":"要做什么、为什么需要批准"}，然后停下。不要自己批准，也不要调用 /api/v1/approvals。`,
    "8. 没有任务就结束。",
  ];
}

function leaderSchedule(base, node, cred, role = "leader") {
  const head = cred.mode === "none" ? "（当前免鉴权，不要加 Authorization）" : `请求头：${cred.header}`;
  return [
    `【定时指令】（每 15 分钟运行一次；每次都没有上一轮上下文，只按本段原文执行）`,
    `你是节点 ${node} 的 ${role}（本段是跟单与派单）。Hub：${base}。${head}`,
    `1. 报到：POST ${base}/api/v1/agents/register ，body {"node":"${node}","role":"${role}","kind":"agent","receive_mode":"http-poll"}`,
    `2. 拉取自上次以来的新动态：GET ${base}/api/v1/agents/${node}/updates?new=1`,
    "3. 对 completed / failed / canceled / rejected：向机主或上游汇报终态结果（无事则静默，不要发空汇报）。",
    `4. 对 input-required：在原任务上答复 POST ${base}/api/v1/tasks/<task_id>/reply ，body {"from":"${node}","text":"你的答复"}。`,
    "5. 对 auth-required：只提醒机主去 Web 控制台审批。绝不以任何方式代批，不要调用 /api/v1/approvals。",
    `6. 需要派单时 POST ${base}/api/v1/tasks ，body 里 from 必须是 "${node}"，idempotencyKey 用该事项的固定标识（同一事项每次相同，避免重复派单）。`,
    "7. 没有新动态、也不需要派单，就静默结束。",
  ];
}

function scheduledPrompt({ base, node, role, cred, skills }) {
  const skillLines = skills.map((s) => `GET ${s.url}`);
  const once = [
    "【一次性接入】（只做一次）",
    `Hub：${base}。节点名：${node}。角色：${role}。`,
    authBullet(cred),
    `读取并遵守协议 Skill：${skillLines.join(" ；")}`,
    `然后注册：POST ${base}/api/v1/agents/register ，body {"node":"${node}","role":"${role}","kind":"agent","receive_mode":"http-poll"}`,
  ];
  let cadence;
  let blocks;
  if (role === "leader") {
    cadence = "请为自己创建定时任务，每 15 分钟运行一次。每次把下面的【定时指令】当作全部任务说明（不要依赖记忆或上一轮对话）。";
    blocks = leaderSchedule(base, node, cred, "leader");
  } else if (role === "hybrid") {
    cadence = "请为自己创建定时任务：每 10 分钟执行下面的 Worker 段，每 15 分钟执行 Leader 段（也可以每 10 分钟两段都做）。每次运行都没有上下文，两段原文都要带上地址、节点名和鉴权头。";
    blocks = [
      ...workerSchedule(base, node, cred, "hybrid"),
      "",
      ...leaderSchedule(base, node, cred, "hybrid"),
    ];
  } else {
    cadence = "请为自己创建定时任务，每 10 分钟运行一次。每次把下面的【定时指令】当作全部任务说明（不要依赖记忆或上一轮对话）。";
    blocks = workerSchedule(base, node, cred, "worker");
  }
  return [
    "你是被定时唤醒的 HTTP Agent，每次运行都没有上一轮上下文。请接入 a2a-hub，并按下面两段执行。",
    ...once,
    "",
    cadence,
    ...blocks,
  ].join("\n");
}

export function buildOnboarding({ hubUrl, node, access, role, authRequired = false, token = "" }) {
  const base = String(hubUrl ?? "").trim().replace(/\/+$/, "") || "http://127.0.0.1:8787";
  const skills = skillNamesFor(access, role).map((name) => ({
    name,
    url: `${base}/api/v1/skills/${name}`,
  }));
  const cred = credentialOf(token, authRequired);
  const authNote = cred.mode === "none"
    ? "当前 Hub 未开启鉴权，无需提供 Token"
    : `携带请求头 ${cred.header}${cred.mode === "placeholder" ? "（请向机主获取真实 Token 替换占位符）" : ""}`;
  // join 认证的是机主 Token，与本次签发的 Agent Token 不是同一把钥匙。
  const tokenFlag = authRequired ? " --api-token <AH_API_TOKEN>" : "";

  let steps;
  let prompt;
  if (access === "host") {
    steps = [
      `若目标宿主机尚未安装 a2a-hub CLI，运行一行安装并接入：curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh -s -- --join ${base} --node ${node}${tokenFlag}`,
      `若目标宿主机已安装 ah CLI，直接执行：ah join ${base} --node ${node}${tokenFlag} --service`,
      "宿主机守护进程上线并登记能力名片后会进入「待接纳」池，请到 Web 控制台「Agent 名片墙 → 待接纳」点击接纳后再派单。",
    ];
    prompt = [
      "请接入 a2a-hub 多 Agent 编排中台：",
      `- Hub 地址：${base}`,
      `- 你的节点名：${node}`,
      `- 接入方式：${access}，角色：${role}`,
      `- 鉴权要求：${cred.promptLine}`,
      "- 本宿主机接入方式无需额外拉取协议 Skill，任务回执规范已内置于调度指令中。",
      `- 职责说明：${roleSummary(role)}`,
    ].join("\n");
  } else if (access === "inbox") {
    steps = [
      `若目标机器尚未安装 a2a-hub CLI，运行一行安装并接入（独立 Agent 模式）：curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh -s -- --join ${base} --node ${node} --kind agent${tokenFlag}`,
      `若已安装 ah CLI，执行（将自动安装 ah-inbox 协议 Skill）：ah join ${base} --node ${node} --kind agent${tokenFlag} --service`,
      "名片上线后会进入「待接纳」池，请在 Web 控制台「Agent 名片墙 → 待接纳」中接纳该节点；随后 Agent 通过 ah inbox 接单并回执。",
    ];
    prompt = [
      "请接入 a2a-hub 多 Agent 编排中台：",
      `- Hub 地址：${base}`,
      `- 你的节点名：${node}`,
      `- 接入方式：${access}，角色：${role}`,
      `- 鉴权要求：${cred.promptLine}`,
      `- 接入后请先拉取并阅读协议 Skill：${skills.map((s) => s.url).join(" ，")}`,
      `- 职责说明：${roleSummary(role)}`,
    ].join("\n");
  } else {
    const scheduleHint = role === "leader"
      ? "每 15 分钟按 prompt 里的【定时指令】跟单：updates?new=1、汇报终态、reply 答复 input-required、auth-required 只提醒机主去控制台审批。"
      : role === "hybrid"
        ? "每 10 分钟按 prompt 里的 Worker【定时指令】取单收尾，每 15 分钟按 Leader【定时指令】跟单与派单。"
        : "每 10 分钟按 prompt 里的【定时指令】执行：register → poll?timeout=0 → claim → 本次运行内完成（超过 10 分钟发 heartbeat）→ complete/fail。";
    steps = [
      `一次性接入：拉取协议 Skill（${authNote}）：${skills.map((s) => `GET ${s.url}`).join("、")}。/api/v1/skills/* 需要鉴权，只有 /.well-known/agent.json 与 /api/v1/health 免鉴权。`,
      `一次性注册：POST ${base}/api/v1/agents/register ，body {"node":"${node}","role":"${role}","kind":"agent","receive_mode":"http-poll"}`,
      `为自己创建定时任务。${scheduleHint}完整原文在 prompt 的【定时指令】中，每次运行无上下文，地址、节点名和鉴权头都已写全。`,
    ];
    prompt = scheduledPrompt({ base, node, role, cred, skills });
  }

  return {
    access,
    role,
    skills,
    steps,
    prompt,
  };
}
