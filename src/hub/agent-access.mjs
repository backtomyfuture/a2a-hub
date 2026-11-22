// Agent Token 的路由矩阵、身份绑定与表级写守卫。机主（owner）与未开鉴权（open）不走这里。

import { f1 } from "../bus/tables.mjs";
import { httpError } from "./admission.mjs";

function hasAdmin(principal) {
  return Array.isArray(principal?.scopes) && principal.scopes.includes("admin");
}

function isLeaderRole(role) {
  return role === "leader" || role === "hybrid";
}

function isBusNode(principal) {
  return principal?.access === "host" || principal?.access === "inbox";
}

function decodeSeg(raw) {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    throw httpError(400, "路径参数编码不合法");
  }
}

function foreverDeny(principal, pathname, method) {
  if (pathname.startsWith("/api/v1/approvals")) return "Agent 身份不能访问审批接口 /api/v1/approvals/*";
  if (pathname === "/api/v1/admin/agents" || pathname.startsWith("/api/v1/admin/agents/")) {
    return "Agent 身份不能调用 /api/v1/admin/agents";
  }
  if (pathname === "/api/v1/admin/tokens" || pathname.startsWith("/api/v1/admin/tokens/")) {
    return "Agent 身份不能管理 Token（/api/v1/admin/tokens）";
  }
  // Webhook URL 与接收端密钥只能由机主配置，Agent 不能自报接收地址。
  if (pathname === "/api/v1/admin/webhooks" || pathname.startsWith("/api/v1/admin/webhooks/")) {
    return "Agent 身份不能管理 Webhook（/api/v1/admin/webhooks）";
  }
  if (pathname === "/api/v1/state") return "Agent 身份不能访问 /api/v1/state";
  if (!isBusNode(principal)) {
    if (pathname.startsWith("/api/v1/tables/")) return "Agent 身份不能访问总线表 /api/v1/tables/*";
    if (pathname === "/api/v1/poll") return "Agent 身份不能使用 Hub 长轮询 /api/v1/poll";
  }
  if (pathname === "/api/v1/schedules") return "Agent 身份不能查看定时任务 /api/v1/schedules";
  if (pathname === "/api/v1/admin/commands-snippet") return "Agent 身份不能生成 commands.json 片段";
  if (pathname === "/api/v1/admin/audit") return "Agent 身份不能查看名录变更审计日志";
  if (method === "DELETE" && /^\/api\/v1\/admin\/cards\/[^/]+$/.test(pathname)) {
    return "Agent 身份不能删除能力名片";
  }
  return "";
}

function routeAllowed(principal, method, pathname) {
  if (method === "GET" && (pathname === "/api/v1/skills" || /^\/api\/v1\/skills\/[^/]+$/.test(pathname))) return true;
  if (method === "GET" && /^\/api\/v1\/kit\/a2a_check\.(py|sh)$/.test(pathname)) return true;
  if (method === "POST" && pathname === "/api/v1/agents/register") return true;
  if (method === "GET" && pathname === "/api/v1/agents") return true;
  // 只读检查不区分角色。worker 看任务，leader 看任务和 updates。旧 hybrid 与 leader 相同。
  if (method === "GET" && /^\/api\/v1\/agents\/[^/]+\/check$/.test(pathname)) return true;
  // 附件上传与下载对所有 agent 角色放行，具体文件可见性在路由内按 uploaded_by / 引用任务判定。
  if (method === "POST" && pathname === "/api/v1/files") return true;
  if (method === "GET" && /^\/api\/v1\/files\/[^/]+(?:\/meta)?$/.test(pathname)) return true;

  if (isBusNode(principal)) {
    if (method === "GET" && pathname === "/api/v1/poll") return true;
    if (/^\/api\/v1\/tables\/[^/]+\/records(?:\/[^/]+)?$/.test(pathname)
      && (method === "GET" || method === "POST" || method === "PUT")) {
      return true;
    }
  }

  const role = principal.role;
  const leaderish = isLeaderRole(role);
  // leader 同时接单。worker 仍不能派单。
  const workerish = role === "worker" || leaderish;

  if (workerish) {
    if (/^\/api\/v1\/agents\/[^/]+\/poll$/.test(pathname) && (method === "GET" || method === "POST")) return true;
    if (/^\/api\/v1\/agents\/[^/]+\/inbox$/.test(pathname) && method === "GET") return true;
    if (/^\/api\/v1\/tasks\/[^/]+\/(claim|heartbeat|complete|fail|ask|auth)$/.test(pathname) && method === "POST") return true;
  }
  if (leaderish) {
    if (/^\/api\/v1\/agents\/[^/]+\/updates$/.test(pathname) && method === "GET") return true;
    if (pathname === "/api/v1/tasks" && (method === "GET" || method === "POST")) return true;
    if (/^\/api\/v1\/tasks\/[^/]+$/.test(pathname) && method === "GET") return true;
    if (/^\/api\/v1\/tasks\/[^/]+\/(reply|cancel)$/.test(pathname) && method === "POST") return true;
  }
  if (leaderish && hasAdmin(principal)) {
    if (method === "POST" && /^\/api\/v1\/admin\/cards\/[^/]+\/admission$/.test(pathname)) return true;
    if (method === "POST" && /^\/api\/v1\/admin\/nodes\/[^/]+\/admission$/.test(pathname)) return true;
    if ((method === "POST" || method === "PATCH") && /^\/api\/v1\/admin\/cards\/[^/]+\/profile$/.test(pathname)) return true;
    if (method === "GET" && pathname === "/api/v1/admin/onboarding") return true;
    if (method === "POST" && pathname === "/api/v1/admin/cards") return true;
  }
  if ((method === "PUT" || method === "DELETE") && /^\/api\/v1\/agents\/[^/]+\/schedules\/[^/]+$/.test(pathname)) return true;
  return false;
}

function callerFromPath(pathname) {
  const m = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/(?:poll|inbox|updates|check)$/);
  if (!m) return "";
  return decodeSeg(m[1]);
}

function impersonation(bound, claimed) {
  return httpError(403, `Token 绑定节点 ${bound}，不能以 ${claimed} 身份调用`);
}

function collectClaims({ pathname, searchParams, headers }) {
  const claims = [];
  const pathNode = callerFromPath(pathname);
  if (pathNode) claims.push(pathNode);
  if (searchParams) {
    for (const key of ["node", "from"]) {
      const val = String(searchParams.get(key) ?? "").trim();
      if (!val) continue;
      // /api/v1/poll 允许不带具体节点名时传 node=*，服务端会再强制收敛为 principal.node。
      if (pathname === "/api/v1/poll" && key === "node" && val === "*") continue;
      claims.push(val);
    }
  }
  const headerNode = String(headers?.["x-a2a-node"] ?? "").trim();
  if (headerNode) claims.push(headerNode);
  return claims;
}

export function assertAgentRoute(principal, { method, pathname, searchParams, headers } = {}) {
  if (principal?.kind !== "agent") return;
  const denied = foreverDeny(principal, pathname, method);
  if (denied) throw httpError(403, denied);
  if (!routeAllowed(principal, method, pathname)) {
    throw httpError(403, `角色 ${principal.role} 无权访问 ${method} ${pathname}`);
  }
  // 带 admin scope 的 Leader 替别的节点生成接入提示词是本意，查询串里的 node 是操作对象而非调用者身份。
  const claimSearch = pathname === "/api/v1/admin/onboarding" ? null : searchParams;
  for (const claimed of collectClaims({ pathname, searchParams: claimSearch, headers })) {
    if (claimed !== principal.node) throw impersonation(principal.node, claimed);
  }
  const schedMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/schedules\/[^/]+$/);
  if (schedMatch) {
    const claimed = decodeSeg(schedMatch[1]);
    if (claimed !== principal.node) throw impersonation(principal.node, claimed);
  }
}

async function resolveTaskInitiator(bus, taskRow) {
  const taskId = String(f1(taskRow, "Task_ID") ?? "").trim();
  if (taskId && bus?.tables?.messages) {
    const messages = await bus.listRecords(bus.tables.messages);
    const instr = messages.find((m) => String(f1(m, "Task_ID") ?? "").trim() === taskId && f1(m, "Kind") === "instruction");
    const from = instr ? String(f1(instr, "From_Node") ?? "").trim() : "";
    if (from) return from;
  }
  return String(f1(taskRow, "Source") ?? "").trim() || "hub";
}

// 远端宿主/收件箱节点通过 /api/v1/tables/* 写入时，服务端强制守卫节点身份与受保护字段。
export async function assertAgentTableWrite({ principal, bus, realTable, method, recordId = "", fields }) {
  if (principal?.kind !== "agent") return fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw httpError(400, "fields 必须是 JSON 对象");
  }
  const T = bus?.tables ?? {};
  const self = principal.node;
  const leaderish = isLeaderRole(principal.role);

  if (realTable === T.agentCards) {
    if (method === "POST") {
      if (!Object.hasOwn(fields, "Node") || String(fields.Node ?? "").trim() === "") {
        fields.Node = self;
      } else if (String(fields.Node).trim() !== self) {
        throw impersonation(self, String(fields.Node).trim());
      }
      if (Object.hasOwn(fields, "Admission") && !["", "pending"].includes(String(fields.Admission ?? "").trim())) {
        throw httpError(403, "远端节点不能自授或修改名片 Admission 状态");
      }
      if ((Object.hasOwn(fields, "Display_Name") && String(fields.Display_Name ?? "") !== "")
        || (Object.hasOwn(fields, "Admin_Note") && String(fields.Admin_Note ?? "") !== "")) {
        throw httpError(403, "远端节点不能设置名片 Display_Name 或 Admin_Note");
      }
      return fields;
    }
    if (method === "PUT") {
      const existing = await bus.getRecord(realTable, recordId);
      if (existing) {
        const ownerNode = String(f1(existing, "Node") ?? "").trim();
        if (ownerNode !== self) throw impersonation(self, ownerNode);
      }
      if (Object.hasOwn(fields, "Node") && String(fields.Node ?? "").trim() !== self) {
        throw impersonation(self, String(fields.Node ?? "").trim());
      }
      if (Object.hasOwn(fields, "Admission") || Object.hasOwn(fields, "Display_Name") || Object.hasOwn(fields, "Admin_Note")) {
        throw httpError(403, "远端节点不能修改名片 Admission / Display_Name / Admin_Note");
      }
      return fields;
    }
  }

  if (realTable === T.messages) {
    if (method === "PUT") throw httpError(403, "Messages 表只追加，不允许修改");
    if (method === "POST") {
      if (!Object.hasOwn(fields, "From_Node") || String(fields.From_Node ?? "").trim() === "") {
        fields.From_Node = self;
      } else if (String(fields.From_Node).trim() !== self) {
        throw impersonation(self, String(fields.From_Node).trim());
      }
      const kind = String(fields.Kind ?? "").trim();
      if (kind === "auth_decision") {
        throw httpError(403, "远端节点不能写入 auth_decision 审批决定");
      }
      if (!leaderish && (kind === "instruction" || kind === "answer")) {
        throw httpError(403, `角色 ${principal.role} 无权发送 ${kind} 消息`);
      }
      return fields;
    }
  }

  if (realTable === T.parts) {
    if (method === "PUT") throw httpError(403, "Parts 表只追加，不允许修改");
    return fields;
  }

  if (realTable === T.artifacts) {
    if (method === "PUT") throw httpError(403, "Artifacts 表只追加，不允许修改");
    if (method === "POST") {
      if (!Object.hasOwn(fields, "Produced_By") || String(fields.Produced_By ?? "").trim() === "") {
        fields.Produced_By = self;
      } else if (String(fields.Produced_By).trim() !== self) {
        throw impersonation(self, String(fields.Produced_By).trim());
      }
      return fields;
    }
  }

  if (realTable === T.tasks) {
    if (method === "POST") {
      if (!leaderish) throw httpError(403, `角色 ${principal.role} 无权直接创建任务`);
      return fields;
    }
    if (method === "PUT") {
      const existing = await bus.getRecord(realTable, recordId);
      if (existing) {
        const target = String(f1(existing, "Target_Node") ?? "").trim();
        if (Object.hasOwn(fields, "Claimed_By")) {
          const claimedBy = String(fields.Claimed_By ?? "").trim();
          if (claimedBy && claimedBy !== self) throw impersonation(self, claimedBy);
        }
        const nextStatus = Object.hasOwn(fields, "Status") ? String(fields.Status ?? "").trim() : "";
        if (target !== self) {
          if (!leaderish) throw httpError(403, "只能更新目标节点为本节点的任务");
          const initiator = await resolveTaskInitiator(bus, existing);
          if (initiator !== self) throw httpError(403, "只能撤销或操作本节点发起的任务");
          const keys = Object.keys(fields);
          if (!keys.length || keys.some((k) => k !== "Status") || nextStatus !== "canceled") {
            throw httpError(403, "发起方仅可取消目标节点为其他节点的任务");
          }
        } else if (nextStatus === "canceled") {
          if (!leaderish) throw httpError(403, `角色 ${principal.role} 无权取消任务`);
          const initiator = await resolveTaskInitiator(bus, existing);
          if (initiator !== self) throw httpError(403, "只能撤销本节点发起的任务");
        }
      }
      return fields;
    }
  }

  throw httpError(403, `Agent 身份无权写入表 ${realTable}`);
}

// 省略 node/from 时补成绑定节点；写了别人的身份则拒绝。只看顶层字段。
export function bindAgentBody(principal, body) {
  if (principal?.kind !== "agent") return body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  for (const key of ["node", "from"]) {
    if (!Object.hasOwn(body, key) || body[key] == null) continue;
    const claimed = String(body[key]).trim();
    if (!claimed) continue;
    if (claimed !== principal.node) throw impersonation(principal.node, claimed);
  }
  if (!String(body.node ?? "").trim()) body.node = principal.node;
  if (!String(body.from ?? "").trim()) body.from = principal.node;
  return body;
}

export function agentCanSeeTask(principal, fromNode, source, targetNode) {
  if (principal?.kind !== "agent") return true;
  const self = principal.node;
  return fromNode === self || source === self || targetNode === self;
}
