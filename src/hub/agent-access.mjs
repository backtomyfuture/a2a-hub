// Agent Token 的路由矩阵与身份绑定。机主（owner）与未开鉴权（open）不走这里。

import { httpError } from "./admission.mjs";

function hasAdmin(principal) {
  return Array.isArray(principal?.scopes) && principal.scopes.includes("admin");
}

function decodeSeg(raw) {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    throw httpError(400, "路径参数编码不合法");
  }
}

function foreverDeny(pathname) {
  if (pathname.startsWith("/api/v1/approvals")) return "Agent 身份不能访问审批接口 /api/v1/approvals/*";
  if (pathname === "/api/v1/admin/agents" || pathname.startsWith("/api/v1/admin/agents/")) {
    return "Agent 身份不能调用 /api/v1/admin/agents";
  }
  if (pathname === "/api/v1/admin/tokens" || pathname.startsWith("/api/v1/admin/tokens/")) {
    return "Agent 身份不能管理 Token（/api/v1/admin/tokens）";
  }
  if (pathname === "/api/v1/state") return "Agent 身份不能访问 /api/v1/state";
  if (pathname.startsWith("/api/v1/tables/")) return "Agent 身份不能访问总线表 /api/v1/tables/*";
  if (pathname === "/api/v1/poll") return "Agent 身份不能使用 Hub 长轮询 /api/v1/poll";
  return "";
}

function routeAllowed(principal, method, pathname) {
  if (method === "GET" && (pathname === "/api/v1/skills" || /^\/api\/v1\/skills\/[^/]+$/.test(pathname))) return true;
  if (method === "GET" && /^\/api\/v1\/kit\/a2a_check\.(py|sh)$/.test(pathname)) return true;
  if (method === "POST" && pathname === "/api/v1/agents/register") return true;
  if (method === "GET" && pathname === "/api/v1/agents") return true;
  // 只读检查不区分角色：worker 看任务，leader 看 updates 条数，hybrid 两边都看。具体算哪些由网关按 role 决定。
  if (method === "GET" && /^\/api\/v1\/agents\/[^/]+\/check$/.test(pathname)) return true;

  const role = principal.role;
  const workerish = role === "worker" || role === "hybrid";
  const leaderish = role === "leader" || role === "hybrid";

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
    if (pathname === "/api/v1/loops" && (method === "GET" || method === "POST")) return true;
    if (/^\/api\/v1\/loops\/[^/]+\/cancel$/.test(pathname) && method === "POST") return true;
  }
  if (leaderish && hasAdmin(principal)) {
    if (method === "POST" && /^\/api\/v1\/admin\/cards\/[^/]+\/admission$/.test(pathname)) return true;
    if (method === "POST" && /^\/api\/v1\/admin\/nodes\/[^/]+\/admission$/.test(pathname)) return true;
    if ((method === "POST" || method === "PATCH") && /^\/api\/v1\/admin\/cards\/[^/]+\/profile$/.test(pathname)) return true;
    if (method === "GET" && pathname === "/api/v1/admin/onboarding") return true;
  }
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
      if (val) claims.push(val);
    }
  }
  const headerNode = String(headers?.["x-a2a-node"] ?? "").trim();
  if (headerNode) claims.push(headerNode);
  return claims;
}

export function assertAgentRoute(principal, { method, pathname, searchParams, headers } = {}) {
  if (principal?.kind !== "agent") return;
  const denied = foreverDeny(pathname);
  if (denied) throw httpError(403, denied);
  if (!routeAllowed(principal, method, pathname)) {
    throw httpError(403, `角色 ${principal.role} 无权访问 ${method} ${pathname}`);
  }
  // 带 admin scope 的 Leader 替别的节点生成接入提示词是本意，查询串里的 node 是操作对象而非调用者身份。
  const claimSearch = pathname === "/api/v1/admin/onboarding" ? null : searchParams;
  for (const claimed of collectClaims({ pathname, searchParams: claimSearch, headers })) {
    if (claimed !== principal.node) throw impersonation(principal.node, claimed);
  }
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
