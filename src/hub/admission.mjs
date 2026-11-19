// 名片接纳与新 Agent 接入引导纯函数：归一化 Admission、校验管理请求参数、构造 onboarding 指引。

import { f1 } from "../bus/tables.mjs";
import { capIdOf } from "../config.mjs";
import { BROWSER_USER_AGENT } from "../kernel-util.mjs";

export const ADMISSION_VALUES = Object.freeze(["admitted", "pending", "rejected"]);
export const ACCESS_VALUES = Object.freeze(["http", "host", "inbox"]);
export const ROLE_VALUES = Object.freeze(["worker", "leader", "hybrid"]);
export const RECEIVE_VALUES = Object.freeze(["poll", "longpoll", "webhook"]);

const ADMISSION_SET = new Set(ADMISSION_VALUES);
const ACCESS_SET = new Set(ACCESS_VALUES);
const ROLE_SET = new Set(ROLE_VALUES);
const RECEIVE_SET = new Set(RECEIVE_VALUES);

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

// hybrid 是旧值。鉴权与提示词按 leader 处理；新签发的 Token 与新名片不再写 hybrid。
export function actsAsLeader(role) {
  return role === "leader" || role === "hybrid";
}

export function issuedRole(role) {
  const value = validateRole(role);
  return value === "hybrid" ? "leader" : value;
}

function minuteStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

// HTTP Agent 的默认可派单名片。Leader 与 Worker 同一张形状，差别只在 Metadata.role。
export function presetHttpCardFields({
  node,
  role,
  receiveMode,
  displayName = "",
  description = "",
  adminNote = "",
  availability = "offline",
  updatedAt,
} = {}) {
  const storedRole = role === "hybrid" ? "leader" : role;
  return {
    Cap_ID: capIdOf("agent", {}, node),
    Node: node,
    Worker: "",
    Skill_ID: "agent",
    Skill_Name: displayName || `${node} Agent`,
    Description: description,
    Side_Effect: "write",
    Approval_Class: "auto",
    Availability: availability,
    Dispatchable: "Yes",
    Receive_Mode: receiveMode,
    Zone: "cloud",
    Daemon_Version: "http-agent",
    Admission: "admitted",
    Display_Name: displayName,
    Admin_Note: adminNote,
    Updated_At: updatedAt || minuteStamp(),
    Metadata: JSON.stringify({ kind: "agent", role: storedRole, mode: receiveMode, preset: true }),
  };
}

// 启动时给已签发、但还没有任何名片的 leader / hybrid 补一张身份名片。已有名片不改 Admission。
export async function ensureLeaderIdentityCards({ bus, tokenStore, webhookStore, now = () => new Date() } = {}) {
  if (!tokenStore || !bus?.tables?.agentCards || typeof bus.listRecords !== "function" || typeof bus.createRecord !== "function") {
    return 0;
  }
  const tokens = tokenStore.listPublic();
  const cards = await bus.listRecords(bus.tables.agentCards);
  let created = 0;
  for (const token of tokens) {
    if (!actsAsLeader(token.role)) continue;
    const mine = cards.filter((card) => f1(card, "Node") === token.node);
    if (mine.length) continue;
    const receiveMode = webhookStore?.get?.(token.node) ? "webhook" : "http-poll";
    await bus.createRecord(bus.tables.agentCards, presetHttpCardFields({
      node: token.node,
      role: "leader",
      receiveMode,
      updatedAt: minuteStamp(now()),
    }));
    created += 1;
  }
  return created;
}

export function validateReceive(raw) {
  const val = String(raw ?? "").trim().toLowerCase();
  if (!val) return "poll";
  if (!RECEIVE_SET.has(val)) {
    throw httpError(400, `receive 只能是 ${RECEIVE_VALUES.join(" / ")}`);
  }
  return val;
}

export function receiveModeFor(receive) {
  if (receive === "longpoll") return "http-longpoll";
  if (receive === "webhook") return "webhook";
  return "http-poll";
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
  const empty = { kind: "", role: "", manual: false, preset: false };
  if (!rawMeta) return empty;
  try {
    const meta = typeof rawMeta === "object" ? rawMeta : JSON.parse(String(rawMeta));
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return empty;
    return {
      kind: meta.kind == null ? "" : String(meta.kind),
      role: meta.role == null ? "" : String(meta.role),
      manual: meta.manual === true,
      preset: meta.preset === true,
    };
  } catch {
    return empty;
  }
}

export function formatAgentCard(c) {
  const { kind, role, manual, preset } = parseCardMetadata(c);
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
    // 控制台据此只对机主手动添加或向导预置的名片显示「删除」，其余名片由节点对账维护。
    manual,
    preset,
  };
}

function promptRole(role) {
  return actsAsLeader(role) ? "leader" : "worker";
}

function skillNamesFor(access, role) {
  if (access === "host") return [];
  if (access === "inbox") return ["ah-inbox"];
  // leader 同时接单和派单，两份协议都要。旧 hybrid 与 leader 同一套。
  if (actsAsLeader(role)) return ["a2a-worker", "a2a-leader"];
  return ["a2a-worker"];
}

function roleSummary(role) {
  if (actsAsLeader(role)) return "作为调度控制端（leader），既可认领分配给本节点的任务并回执结果，也可向其他节点派发协同任务并跟踪结果。";
  return "作为执行端（worker），负责轮询认领分配给本节点的任务、按要求回执进度与结果。";
}

// token 有值时内嵌这一次明文；没有则只用占位符。host/inbox 的 join 用的是机主 Token，命令行仍写占位符，不把 Agent Token 写进去。
function credentialOf(token, authRequired) {
  const secret = String(token ?? "").trim();
  if (secret) {
    return {
      mode: "token",
      secret,
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

const UA_HEADER = `User-Agent: ${BROWSER_USER_AGENT}`;
const UA_NOTE = `所有请求（含免鉴权地址）都要带浏览器请求头 ${UA_HEADER}。Hub 在 Cloudflare 之后，默认 UA（curl、python-requests、node 等）会被 403 / error 1010 拦截。`;

function authBullet(cred) {
  if (cred.mode === "none") return `当前 Hub 未开启鉴权，请求不带 Authorization 头。${UA_NOTE}`;
  const header = cred.mode === "token" ? "Authorization: Bearer $A2A_HUB_TOKEN" : cred.header;
  return `除 GET /.well-known/agent.json 与 GET /api/v1/health 外，所有 /api/*（含 /api/v1/skills/* 与 /api/v1/kit/*）都要带请求头 ${header}。不要把 Skill 或检查脚本地址当成免鉴权。${UA_NOTE}`;
}

function scheduleHeaders(cred) {
  if (cred.mode === "none") {
    return `（当前免鉴权，不要加 Authorization）请求头：${UA_HEADER}`;
  }
  // 明文只在一次性接入里出现一次。处理流程用环境变量，避免每段定时指令都带着密钥。
  const auth = cred.mode === "token"
    ? "Authorization: Bearer $A2A_HUB_TOKEN（从平台安全密钥空间或环境变量读取；没有安全存储时，把 $A2A_HUB_TOKEN 换成一次性接入给出的明文）"
    : "Authorization: Bearer <AH_API_TOKEN>（向机主索取后存为 A2A_HUB_TOKEN；没有安全存储时再写明文）";
  return `请求头：${auth}；${UA_HEADER}（不带浏览器 UA 会被 Cloudflare 403 / 1010 拦截）`;
}

function workerSchedule(base, node, cred, role = "worker") {
  const head = scheduleHeaders(cred);
  return [
    "【处理流程】（输出 WORK 或走回退时执行；每次都没有上一轮上下文，只按本段原文执行）",
    `你是节点 ${node} 的 ${role}（本段是取单与回执）。Hub：${base}。${head}`,
    "只处理分配给自己的任务，不要认领或改别人的任务。",
    `1. 报到：POST ${base}/api/v1/agents/register ，body {"node":"${node}","role":"${role}","kind":"agent","receive_mode":"http-poll"}`,
    `2. 短轮询取单：GET ${base}/api/v1/agents/${node}/poll?timeout=0 （timeout=0，不要长轮询挂起）`,
    `3. 对返回的每个任务：POST ${base}/api/v1/tasks/<task_id>/claim ，body {"node":"${node}"}。check 返回的 working 里是你已认领、仍为 working 的任务，直接续心跳或收尾，不要重复认领。`,
    `4. 在本次运行内做完。若预计超过 10 分钟，处理期间 POST ${base}/api/v1/tasks/<task_id>/heartbeat ，body {"node":"${node}","text":"当前进度"}`,
    `5. 成功：POST ${base}/api/v1/tasks/<task_id>/complete ，body {"node":"${node}","text":"结果摘要"}。失败：POST ${base}/api/v1/tasks/<task_id>/fail ，body {"node":"${node}","text":"失败原因"}`,
    `6. 缺信息：POST ${base}/api/v1/tasks/<task_id>/ask ，body {"node":"${node}","text":"缺什么"}，然后停下该任务，不要猜。`,
    `7. 敏感或有副作用、需要机主点头的动作：POST ${base}/api/v1/tasks/<task_id>/auth ，body {"node":"${node}","text":"要做什么、为什么需要批准"}，然后停下。不要自己批准，也不要调用 /api/v1/approvals。`,
    "8. 没有任务就结束。",
  ];
}

function leaderSchedule(base, node, cred, role = "leader") {
  const head = scheduleHeaders(cred);
  return [
    "【处理流程】（输出 WORK 或走回退时执行；每次都没有上一轮上下文，只按本段原文执行）",
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

function tokenSaveLines(cred) {
  const how = "首选存进你所在平台的安全密钥空间（Secrets / Vault / 凭据管理 / 加密环境变量等），名称 A2A_HUB_TOKEN，之后以环境变量或引用方式取用，不要把明文写进定时指令、日志或回复。只有平台没有任何安全存储机制时，才把明文写进本地配置文件（尽量 0600）或直接写进定时指令。";
  if (cred.mode === "none") {
    return ["当前 Hub 未开启鉴权，不必保存 Token，运行检查脚本时不要加 --token。"];
  }
  if (cred.mode === "token") {
    return [
      `Token 保存：${how}`,
      `这一次的明文 Token（只为存起来，不要再抄进定时指令）：${cred.secret}`,
    ];
  }
  return [
    `Token 保存：向机主索取真实 Token 后，${how}`,
    cred.promptLine,
  ];
}

function gateLines(base, node) {
  return [
    "【定时任务】",
    "创建定时任务，每 5 分钟运行一次。每次唤醒都没有上一轮上下文。【定时指令】只有下面这几行：",
    `运行 python3 <保存路径>/a2a_check.py --hub ${base} --node ${node}。没有 python3 时改为 sh <保存路径>/a2a_check.sh --hub ${base} --node ${node}。`,
    "Token 从环境变量 A2A_HUB_TOKEN 或平台安全空间引用读取，不要写进这几行。免鉴权 Hub 不要传 --token。",
    "输出 IDLE 就立即结束，不回复、不做任何其它调用。",
    "输出 ERROR 就结束（不重试，不要改用其它方式猜）。",
    "输出 WORK 就读取已保存的【处理流程】并按其执行。",
    "若平台支持「脚本有输出才唤醒模型」，给命令加上 --silent-idle：空闲时脚本没有输出，模型不会被叫醒。",
  ];
}

function fallbackLines() {
  return ["【回退】", "若无法运行任何脚本，每 5 分钟直接执行上面的【处理流程】。"];
}

function longpollBackoffLine() {
  return "断线（网络错误、超时或非 2xx）后按 1 秒、3 秒、8 秒、30 秒指数退避再连，连上后把退避归零。";
}

function longpollWorkerLoop(base, node, cred) {
  return [
    "【主循环】（常驻进程；不要创建定时任务，也不要下载或运行 a2a_check.py）",
    `你是节点 ${node} 的执行端。Hub：${base}。${scheduleHeaders(cred)}`,
    `1. GET ${base}/api/v1/agents/${node}/poll?timeout=25 ，挂起等待新任务。timeout 用 25 秒，不要用 0。`,
    `2. 对返回的每个任务：POST ${base}/api/v1/tasks/<task_id>/claim ，body {"node":"${node}"}。已经是 working 的任务直接续做，不要重复认领。`,
    "3. 在本进程内做完。若预计超过 10 分钟，处理期间 POST " + `${base}/api/v1/tasks/<task_id>/heartbeat ，body {"node":"${node}","text":"当前进度"}`,
    `4. 成功：POST ${base}/api/v1/tasks/<task_id>/complete ，body {"node":"${node}","text":"结果摘要"}。失败：POST ${base}/api/v1/tasks/<task_id>/fail ，body {"node":"${node}","text":"失败原因"}`,
    `5. 缺信息：POST ${base}/api/v1/tasks/<task_id>/ask ，body {"node":"${node}","text":"缺什么"}，然后停下该任务，不要猜。`,
    `6. 需要机主点头：POST ${base}/api/v1/tasks/<task_id>/auth ，body {"node":"${node}","text":"要做什么、为什么需要批准"}，然后停下。不要自己批准，也不要调用 /api/v1/approvals。`,
    "7. 本轮处理完或没有任务，立刻回到第 1 步。",
    longpollBackoffLine(),
  ];
}

function longpollLeaderLoop(base, node, cred) {
  return [
    "【主循环】（常驻进程；不要创建定时任务，也不要下载或运行 a2a_check.py）",
    `你是节点 ${node} 的调度端。Hub：${base}。${scheduleHeaders(cred)}`,
    `1. GET ${base}/api/v1/agents/${node}/updates?new=1`,
    "2. 对 completed / failed / canceled / rejected：向机主或上游汇报终态结果（无事则静默）。",
    `3. 对 input-required：POST ${base}/api/v1/tasks/<task_id>/reply ，body {"from":"${node}","text":"你的答复"}。`,
    "4. 对 auth-required：只提醒机主去 Web 控制台审批。绝不以任何方式代批，不要调用 /api/v1/approvals。",
    `5. 需要派单时 POST ${base}/api/v1/tasks ，body 里 from 必须是 "${node}"，idempotencyKey 用该事项的固定标识。`,
    "6. 立刻回到第 1 步。",
    longpollBackoffLine(),
  ];
}

// Muse 一类临时 VM 换机后 /etc 和 /tmp 会清空，仅家目录持久化留存。探针只在命令成功时落下，失败下一轮再收敛。
function officialAhVmLines(node) {
  const home = `~/.a2a-hub-${node}`;
  const probe = `/tmp/a2a-hub-${node}.ready`;
  return [
    "【Linux VM 官方 ah（推荐，Node >= 24，如 Muse 临时机）】",
    "用官方 install.sh 装到家目录（~/.a2a-hub/app，软链 ~/.local/bin/ah）。家目录跨换机持久留存，不要装到会随换机清空的 /etc 或 /tmp。",
    `配置目录用 ${home}：先将分 Agent Token 写入 0600 凭据文件（如 ${home}/agent.token），再用 ah join <HUB_URL> --agent --node ${node} --config ${home} --token-file ${home}/agent.token --no-daemon 初始化（或在 node.json 写 busType="agent" 与 tokenFile）。Token 绝不写进命令行、node.json、systemd unit 或日志。`,
    `安装或重建系统级服务用一条幂等命令：ah service --system --config ${home}`,
    "这条命令会按当前环境把代理变量与 NODE_USE_ENV_PROXY=1 写入 0600 的 service.env 并重启服务，仅 is-active 为 active 时返回 0，输出不泄露凭据。",
    "【临时 VM 换机自愈】",
    "把 ah、配置、tokenFile 和恢复脚本放在家目录（例如 ~/.local/state/）。换机后 /etc/systemd/system 与 /tmp 会清空。",
    `开机探针是 ${probe}（换机必空）。runtime hook 每 5 秒检查一次，探针缺失时执行单入口幂等命令：ah service --system --config ${home} && touch ${probe}`,
    "只有退出码为 0 才落探针；失败不 touch，5 秒后自动重试直到收敛。",
  ];
}

function longpollPrompt({ base, node, role, cred, skills }) {
  const shown = promptRole(role);
  const skillLines = skills.map((s) => `GET ${s.url}`);
  const once = [
    "【一次性接入】（只做一次）",
    `Hub：${base}。节点名：${node}。角色：${shown}。`,
    ...tokenSaveLines(cred),
    authBullet(cred),
    `读取并遵守协议 Skill：${skillLines.join(" ；")}`,
    `然后注册：POST ${base}/api/v1/agents/register ，body {"node":"${node}","role":"${shown}","kind":"agent","receive_mode":"http-longpoll"}`,
    "不要创建定时任务，不要下载 a2a_check.py 或 a2a_check.sh。",
  ];
  const loops = actsAsLeader(role)
    ? [...longpollWorkerLoop(base, node, cred), "", ...longpollLeaderLoop(base, node, cred)]
    : longpollWorkerLoop(base, node, cred);
  return [
    "你是常驻运行的 HTTP Agent。进程保持在线，向 Hub 发起出站长轮询，不开监听端口。请接入 a2a-hub。",
    ...once,
    "",
    ...loops,
    "",
    ...officialAhVmLines(node),
  ].join("\n");
}

function webhookVerifyLine() {
  return "自建接收端可以验签：读取未经改写的原始请求体 rawBody（不要先 JSON.parse 再 stringify）。用 HMAC-SHA256，密钥就是接收端自己配置、机主登记到中台的那一把，消息是 ${timestamp}.${rawBody}（timestamp 取请求头 X-A2A-Timestamp 的原文）。把摘要转成十六进制小写，与请求头 X-A2A-Signature 去掉 sha256= 前缀后的值做时序安全比较。X-A2A-Timestamp 是 unix 秒，与当前时间相差超过 300 秒（5 分钟）则拒绝。验签失败或过期时返回非 2xx，中台会按 0/1/3/8 秒重试后放弃。只把正文当触发上下文的接收端可以不验签。不要再保存一份名为 A2A_HUB_WEBHOOK_SECRET 的中台密钥。";
}

function webhookWorkerFlow(base, node) {
  return [
    "【处理流程】（task.assigned 或兜底输出 WORK 时执行；每次都没有上一轮上下文）",
    `1. GET ${base}/api/v1/agents/${node}/poll?timeout=0 （timeout=0，不要长轮询挂起）。指令正文只在这个响应里，不在门铃里。`,
    `2. POST ${base}/api/v1/tasks/<task_id>/claim ，body {"node":"${node}"}`,
    `3. 在本次运行内做完。超过 10 分钟就 POST ${base}/api/v1/tasks/<task_id>/heartbeat ，body {"node":"${node}","text":"当前进度"}`,
    `4. 成功走 complete，失败走 fail，body {"node":"${node}","text":"..."}`,
    `5. 缺信息走 ask，需要批准走 auth，然后停下。不要自己批准，也不要调用 /api/v1/approvals。`,
  ];
}

function webhookLeaderFlow(base, node) {
  return [
    "【处理流程】（task.updated 或兜底输出 WORK 时执行；每次都没有上一轮上下文）",
    `1. GET ${base}/api/v1/agents/${node}/updates?new=1`,
    "2. 对 completed / failed / canceled / rejected：向机主或上游汇报终态（无事则静默）。",
    `3. 对 input-required：POST ${base}/api/v1/tasks/<task_id>/reply ，body {"from":"${node}","text":"你的答复"}。`,
    "4. 对 auth-required：只提醒机主去 Web 控制台审批。绝不以任何方式代批。",
    `5. 需要派单时 POST ${base}/api/v1/tasks ，body 里 from 必须是 "${node}"，idempotencyKey 用该事项的固定标识。`,
  ];
}

function webhookPrompt({ base, node, role, cred, skills }) {
  const shown = promptRole(role);
  const skillLines = skills.map((s) => `GET ${s.url}`);
  const handle = [
    "【收到推送后的处理】",
    "中台会用接收端已经配置的密钥调用这个 URL，只推门铃。默认请求头是 Authorization: Bearer <密钥>；若机主登记了自定义请求头名，则该头的值就是密钥原文，不加 Bearer。同一把密钥同时用来计算 X-A2A-Signature。",
    "JSON 有 event、node、task_id、status、seq、hub、at、text。text 只是一句提醒，没有指令正文，也没有参数。收到后用自己的 Agent Token 走现有 poll、claim 或 updates 拉详情。",
    `请求头还有 Content-Type: application/json、${UA_HEADER}、X-A2A-Event、X-A2A-Delivery、X-A2A-Timestamp、X-A2A-Signature。`,
    webhookVerifyLine(),
    "event=ping：直接返回 2xx，不必访问 Hub。",
    scheduleHeaders(cred),
  ];
  if (actsAsLeader(role)) {
    handle.push("event=task.assigned：按【处理流程】GET poll?timeout=0 后 claim。");
    handle.push("event=task.updated：按【处理流程】GET updates?new=1。");
  } else {
    handle.push("event=task.assigned：按【处理流程】GET poll?timeout=0 后 claim。worker 忽略 task.updated。");
  }
  const flows = actsAsLeader(role)
    ? [...webhookWorkerFlow(base, node), "", ...webhookLeaderFlow(base, node)]
    : webhookWorkerFlow(base, node);
  return [
    "你是由中台 Webhook 门铃唤醒的 HTTP Agent。推送不含指令正文。请接入 a2a-hub。",
    "【一次性接入】（只做一次）",
    `Hub：${base}。节点名：${node}。角色：${shown}。`,
    ...tokenSaveLines(cred),
    authBullet(cred),
    `读取并遵守协议 Skill：${skillLines.join(" ；")}`,
    `然后注册：POST ${base}/api/v1/agents/register ，body {"node":"${node}","role":"${shown}","kind":"agent","receive_mode":"webhook"}`,
    `下载检查脚本：GET ${base}/api/v1/kit/a2a_check.py （带与其它接口相同的鉴权头和浏览器 UA），保存到自己的空间，例如 <保存路径>/a2a_check.py。没有 python3 就改下载 GET ${base}/api/v1/kit/a2a_check.sh ，保存为 <保存路径>/a2a_check.sh。`,
    `把下面的【处理流程】原文保存为自己空间里的文件（如 a2a-hub-${node}-流程.md）。`,
    "",
    ...handle,
    "",
    ...flows,
    "",
    "【兜底】",
    `每 30 分钟运行一次 python3 <保存路径>/a2a_check.py --hub ${base} --node ${node}，防止门铃漏推。没有 python3 时改为 sh <保存路径>/a2a_check.sh --hub ${base} --node ${node}。`,
    "Token 从环境变量 A2A_HUB_TOKEN 读取，不要写进命令。输出 IDLE 就立即结束；输出 WORK 再按【处理流程】执行；输出 ERROR 就结束。",
  ].join("\n");
}

function scheduledPrompt({ base, node, role, cred, skills }) {
  const shown = promptRole(role);
  const skillLines = skills.map((s) => `GET ${s.url}`);
  const once = [
    "【一次性接入】（只做一次）",
    `Hub：${base}。节点名：${node}。角色：${shown}。`,
    ...tokenSaveLines(cred),
    authBullet(cred),
    `读取并遵守协议 Skill：${skillLines.join(" ；")}`,
    `然后注册：POST ${base}/api/v1/agents/register ，body {"node":"${node}","role":"${shown}","kind":"agent","receive_mode":"http-poll"}`,
    `下载检查脚本：GET ${base}/api/v1/kit/a2a_check.py （带与其它接口相同的鉴权头和浏览器 UA），保存到自己的空间，例如 <保存路径>/a2a_check.py。没有 python3 就改下载 GET ${base}/api/v1/kit/a2a_check.sh ，保存为 <保存路径>/a2a_check.sh。`,
    `把下面的【处理流程】原文保存为自己空间里的文件（如 a2a-hub-${node}-流程.md）。`,
  ];
  const blocks = actsAsLeader(role)
    ? [
      ...workerSchedule(base, node, cred, "leader"),
      "",
      ...leaderSchedule(base, node, cred, "leader"),
    ]
    : workerSchedule(base, node, cred, "worker");
  return [
    "你是被定时唤醒的 HTTP Agent，每次运行都没有上一轮上下文。请接入 a2a-hub。能跑脚本时只执行【定时指令】；输出 WORK 才读取已保存的【处理流程】。",
    ...once,
    "",
    ...gateLines(base, node),
    "",
    ...blocks,
    "",
    ...fallbackLines(),
  ].join("\n");
}

export function buildOnboarding({
  hubUrl,
  node,
  access,
  role,
  authRequired = false,
  token = "",
  receive = "poll",
}) {
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
  // receive 只对 HTTP Agent 有意义；host / inbox 始终是 ah daemon 出站长轮询。
  const receiveMode = access === "http" && (receive === "longpoll" || receive === "webhook") ? receive : "poll";

  let steps;
  let prompt;
  if (access === "host") {
    steps = [
      `若目标宿主机尚未安装 a2a-hub CLI，运行一行安装并接入：curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh -s -- --join ${base} --node ${node}${tokenFlag}`,
      `若目标宿主机已安装 ah CLI，直接执行：ah join ${base} --node ${node}${tokenFlag} --service`,
      "这是常驻长连接：目标机器上的 ah daemon 向 Hub 发起出站长轮询，不开监听端口。守护进程登记名片后会进入「待接纳」池，请到 Web 控制台「节点 → 待接纳」点击接纳后再派单。",
    ];
    prompt = [
      "请接入 a2a-hub 多 Agent 编排中台：",
      `- Hub 地址：${base}`,
      `- 你的节点名：${node}`,
      `- 接入方式：${access}，角色：${role}`,
      `- 鉴权要求：${cred.promptLine}`,
      "- 运行形态：常驻长连接。ah daemon 向 Hub 出站长轮询取任务，本机不开监听端口。",
      "- 本宿主机接入方式无需额外拉取协议 Skill，任务回执规范已内置于调度指令中。",
      "- 接入后到 Web 控制台「节点 → 待接纳」接纳该节点，然后再派单。",
      `- 职责说明：${roleSummary(role)}`,
    ].join("\n");
  } else if (access === "inbox") {
    steps = [
      `若目标机器尚未安装 a2a-hub CLI，运行一行安装并接入（独立 Agent 模式）：curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh -s -- --join ${base} --node ${node} --kind agent${tokenFlag}`,
      `若已安装 ah CLI，执行（将自动安装 ah-inbox 协议 Skill）：ah join ${base} --node ${node} --kind agent${tokenFlag} --service`,
      "这是常驻长连接：ah daemon 向 Hub 出站长轮询，认领后写入本机收件箱。名片上线后到 Web 控制台「节点 → 待接纳」接纳该节点；随后 Agent 通过 ah inbox 接单并回执。",
    ];
    prompt = [
      "请接入 a2a-hub 多 Agent 编排中台：",
      `- Hub 地址：${base}`,
      `- 你的节点名：${node}`,
      `- 接入方式：${access}，角色：${role}`,
      `- 鉴权要求：${cred.promptLine}`,
      "- 运行形态：常驻长连接。ah daemon 向 Hub 出站长轮询，不开监听端口；认领后的任务在本机收件箱里。",
      `- 接入后请先拉取并阅读协议 Skill：${skills.map((s) => s.url).join(" ，")}`,
      "- 接入后到 Web 控制台「节点 → 待接纳」接纳该节点，再通过 ah inbox 接单并回执。",
      `- 职责说明：${roleSummary(role)}`,
    ].join("\n");
  } else if (receiveMode === "poll") {
    const shown = promptRole(role);
    const scheduleHint = actsAsLeader(role)
      ? `每 5 分钟运行 a2a_check.py --hub ${base} --node ${node}。输出 IDLE 立即结束；输出 WORK 时取单与跟单两段【处理流程】都做。无法跑脚本时每 5 分钟直接执行【处理流程】。`
      : `每 5 分钟运行 a2a_check.py --hub ${base} --node ${node}。输出 IDLE 立即结束；输出 WORK 再按【处理流程】取单收尾（register → poll?timeout=0 → claim → 本次运行内完成，超过 10 分钟发 heartbeat → complete/fail）。无法跑脚本时回退为每 5 分钟直接执行【处理流程】。`;
    const authNoteHttp = cred.mode === "token"
      ? "携带请求头 Authorization: Bearer $A2A_HUB_TOKEN（明文只在 prompt 的一次性接入里出现一次，请存进名为 A2A_HUB_TOKEN 的安全空间）"
      : authNote;
    steps = [
      `一次性接入：把 Token 存进平台安全密钥空间，名称 A2A_HUB_TOKEN（没有任何安全存储时才写明文）。拉取协议 Skill（${authNoteHttp}；${UA_HEADER}）：${skills.map((s) => `GET ${s.url}`).join("、")}。下载 GET ${base}/api/v1/kit/a2a_check.py（无 python3 则 GET ${base}/api/v1/kit/a2a_check.sh）。把【处理流程】原文保存为 a2a-hub-${node}-流程.md。/api/v1/skills/* 与 /api/v1/kit/* 需要鉴权，只有 /.well-known/agent.json 与 /api/v1/health 免鉴权。`,
      `一次性注册：POST ${base}/api/v1/agents/register ，body {"node":"${node}","role":"${shown}","kind":"agent","receive_mode":"http-poll"}`,
      `为自己创建定时任务。${scheduleHint}【定时指令】只有运行检查脚本那几行；完整处理步骤在 prompt 的【处理流程】中。`,
    ];
    prompt = scheduledPrompt({ base, node, role, cred, skills });
  }
  if (receiveMode === "longpoll") {
    const authNoteHttp = cred.mode === "token"
      ? "携带请求头 Authorization: Bearer $A2A_HUB_TOKEN（明文只在 prompt 的一次性接入里出现一次，请存进名为 A2A_HUB_TOKEN 的安全空间）"
      : authNote;
    const shown = promptRole(role);
    const loopHint = actsAsLeader(role)
      ? `常驻进程循环 GET ${base}/api/v1/agents/${node}/poll?timeout=25 ，claim 后执行并 complete/fail；每轮再 GET updates?new=1。`
      : `常驻进程循环 GET ${base}/api/v1/agents/${node}/poll?timeout=25 ，claim 后执行，必要时 heartbeat，然后 complete 或 fail。`;
    steps = [
      `一次性接入：把 Token 存进平台安全密钥空间，名称 A2A_HUB_TOKEN（没有任何安全存储时才写明文）。拉取协议 Skill（${authNoteHttp}；${UA_HEADER}）：${skills.map((s) => `GET ${s.url}`).join("、")}。不要创建定时任务，不要下载 a2a_check.py。`,
      `一次性注册：POST ${base}/api/v1/agents/register ，body {"node":"${node}","role":"${shown}","kind":"agent","receive_mode":"http-longpoll"}`,
      `${loopHint}断线按 1 秒、3 秒、8 秒、30 秒退避后重连。`,
      ...officialAhVmLines(node),
    ];
    prompt = longpollPrompt({ base, node, role, cred, skills });
  } else if (receiveMode === "webhook") {
    const authNoteHttp = cred.mode === "token"
      ? "携带请求头 Authorization: Bearer $A2A_HUB_TOKEN（明文只在 prompt 的一次性接入里出现一次，请存进名为 A2A_HUB_TOKEN 的安全空间）"
      : authNote;
    const shown = promptRole(role);
    const webhookStep = actsAsLeader(role)
      ? "中台用接收端配置的密钥调用 URL（默认 Authorization: Bearer，自定义头名则值为密钥原文），并附带 HMAC-SHA256 签名。task.assigned 用 poll?timeout=0 取单再 claim；task.updated 用 updates?new=1。门铃不含指令正文。不要保存 A2A_HUB_WEBHOOK_SECRET。"
      : "中台用接收端配置的密钥调用 URL（默认 Authorization: Bearer，自定义头名则值为密钥原文），并附带 HMAC-SHA256 签名。task.assigned 用 poll?timeout=0 取单再 claim。门铃不含指令正文。不要保存 A2A_HUB_WEBHOOK_SECRET。";
    steps = [
      `一次性接入：把 Token 存进 A2A_HUB_TOKEN。密钥只配在接收端，不要让 Agent 再存一份。拉取协议 Skill（${authNoteHttp}；${UA_HEADER}）：${skills.map((s) => `GET ${s.url}`).join("、")}。下载 GET ${base}/api/v1/kit/a2a_check.py（无 python3 则 a2a_check.sh）。`,
      `一次性注册：POST ${base}/api/v1/agents/register ，body {"node":"${node}","role":"${shown}","kind":"agent","receive_mode":"webhook"}`,
      webhookStep,
      `兜底：每 30 分钟运行一次 a2a_check.py --hub ${base} --node ${node}，防止漏推。`,
    ];
    prompt = webhookPrompt({ base, node, role, cred, skills });
  }

  return {
    access,
    role,
    skills,
    steps,
    prompt,
  };
}
