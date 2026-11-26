// 飞书应用审批渠道：任务进入 auth-required 时给审批人推送互动卡片，审批人点按钮即可签名放行或拒绝。
// 卡片回调走飞书长连接（FeishuLongConnection），不需要 Hub 暴露公网回调地址。
// 安全边界：飞书只负责证明「谁点了按钮」，放行签名仍由 TaskService 用 Hub 私钥完成；
// 只有 AH_FEISHU_APPROVERS 白名单里的用户（open_id / user_id / union_id）的点击会被采纳。

import { extractLastAuthRequest } from "./approval-sign.mjs";
import { FeishuLongConnection } from "./feishu-ws.mjs";

const CARD_SCOPE = "feishu_card";
const RESOLVED_EVENTS = new Set(["task.resumed", "task.rejected", "task.canceled"]);

function splitList(v) {
  return String(v || "")
    .split(/[\s,;，；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function resolveFeishuAppConfig(env = {}) {
  const domainRaw = String(env.AH_FEISHU_DOMAIN || "https://open.feishu.cn").trim().replace(/\/+$/, "");
  let domain = "https://open.feishu.cn";
  try {
    const u = new URL(domainRaw);
    if (u.protocol === "https:") domain = u.origin;
  } catch {}
  const appId = String(env.AH_FEISHU_APP_ID || "").trim();
  const appSecret = String(env.AH_FEISHU_APP_SECRET || "").trim();
  const approvers = splitList(env.AH_FEISHU_APPROVERS);
  const chatId = String(env.AH_FEISHU_CHAT_ID || "").trim();
  return {
    appId,
    appSecret,
    domain,
    approvers,
    chatId,
    // 没有审批人白名单就无人能批，卡片也无意义，视为未配置
    configured: Boolean(appId && appSecret && approvers.length),
  };
}

// 手机号与 user_id 都可能是纯数字，这里只把 11~15 位（可带 +）的数字串当手机号。
// 通讯录里常见 "+86-181xxxxxxxx" 写法，去掉分隔符；大陆号码按飞书接口习惯去掉 +86 区号，其他地区保留 + 区号。
function normalizeMobile(id) {
  const s = String(id).replace(/[\s\-()]/g, "");
  if (!/^\+?\d{11,15}$/.test(s)) return "";
  const cn = /^\+?86(1\d{10})$/.exec(s);
  return cn ? cn[1] : s;
}

const SEND_HINTS = {
  99992361: "审批人的 open_id 属于另一个飞书应用（open_id 按应用隔离）。请改填该用户的邮箱或手机号，Hub 会自动换成本应用下的 open_id；或用本应用拿到的 open_id。",
  99991672: "应用缺少权限，请在飞书开放平台开通「以应用身份发消息」(im:message:send_as_bot) 并发布版本。",
  230013: "审批人不在应用的可用范围内，请在开放平台把他加入应用可用范围。",
};

function receiveIdType(id) {
  if (id.startsWith("ou_")) return "open_id";
  if (id.startsWith("on_")) return "union_id";
  if (id.startsWith("oc_")) return "chat_id";
  if (id.includes("@")) return "email";
  return "user_id";
}

// 任务内容来自 Agent，可能夹带 <at>、链接等 markdown 语法，一律用 plain_text 渲染，不让飞书解析。
function plainDiv(label, v, max = 500) {
  return { tag: "div", text: { tag: "plain_text", content: `${label}：${String(v ?? "").slice(0, max) || "-"}` } };
}

const RESULT_VIEW = {
  approved: { template: "green", title: "a2a-hub · 已签名放行" },
  rejected: { template: "red", title: "a2a-hub · 已拒绝" },
  canceled: { template: "grey", title: "a2a-hub · 任务已取消" },
  stale: { template: "grey", title: "a2a-hub · 审批已失效" },
};

const CHANNEL_LABEL = { console: "控制台", link: "审批链接", feishu: "飞书", timeout: "超时自动处理", cli: "命令行" };

export function buildApprovalCard({ task, authReq, outcome = "pending", decisionMsg = null, consoleLink = "" }) {
  const d = authReq?.data || {};
  const elements = [
    plainDiv("任务", task?.title || task?.id, 200),
    plainDiv("执行节点", task?.to_agent_id, 120),
    plainDiv("发起方", task?.from_node, 120),
    plainDiv("风险级别", d.risk_level, 40),
    plainDiv("原因", d.reason || authReq?.body, 500),
  ];
  const preview = String(d.command_preview || "").trim();
  if (preview) elements.push(plainDiv("拟执行", preview, 600));

  const value = (decision) => ({ ah: "approval", task_id: task.id, request_id: String(d.request_id || "default"), decision });
  if (outcome === "pending") {
    elements.push({
      tag: "column_set",
      flex_mode: "none",
      horizontal_spacing: "8px",
      columns: [
        {
          tag: "column",
          width: "auto",
          elements: [{
            tag: "button",
            text: { tag: "plain_text", content: "签名并放行" },
            type: "primary_filled",
            confirm: {
              title: { tag: "plain_text", content: "确认放行？" },
              text: { tag: "plain_text", content: "放行后执行端会立即执行该任务。" },
            },
            behaviors: [{ type: "callback", value: value("approve") }],
          }],
        },
        {
          tag: "column",
          width: "auto",
          elements: [{
            tag: "button",
            text: { tag: "plain_text", content: "拒绝" },
            type: "danger",
            behaviors: [{ type: "callback", value: value("deny") }],
          }],
        },
      ],
    });
  } else {
    const dd = decisionMsg?.data || {};
    const via = CHANNEL_LABEL[dd.channel] || dd.channel || "";
    if (via) elements.push(plainDiv("处理方式", via, 40));
    if (dd.note) elements.push(plainDiv("备注", dd.note, 300));
  }
  if (consoleLink) {
    elements.push({ tag: "markdown", content: `[在控制台查看](${consoleLink})` });
  }

  const view = outcome === "pending" ? { template: "orange", title: "a2a-hub · 待你审批" } : RESULT_VIEW[outcome] || RESULT_VIEW.stale;
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: view.title }, template: view.template },
    body: { elements },
  };
}

export class FeishuApprovalChannel {
  constructor({
    store,
    taskService,
    envResolver = () => ({}),
    hubUrlResolver = null,
    fetchFn = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    logger = console,
  } = {}) {
    this.store = store;
    this.taskService = taskService;
    this.envResolver = envResolver;
    this.hubUrlResolver = hubUrlResolver;
    this.fetchFn = fetchFn;
    this.WebSocketImpl = WebSocketImpl;
    this.logger = logger;
    this.cfg = resolveFeishuAppConfig({});
    this.conn = null;
    this._token = null;
    this._resolved = new Map();
    this._lastSend = null;
  }

  status() {
    return {
      configured: this.cfg.configured,
      app_id: this.cfg.appId,
      approvers: this.cfg.approvers.length,
      chat_id: this.cfg.chatId,
      last_send: this._lastSend,
      ...(this.conn ? this.conn.status() : { state: "disabled", last_error: "", connected_at: null }),
    };
  }

  start() {
    this.cfg = resolveFeishuAppConfig(this.envResolver() || {});
    this._token = null;
    this._resolved = new Map();
    this._lastSend = null;
    if (!this.cfg.configured) return;
    this.conn = new FeishuLongConnection({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      domain: this.cfg.domain,
      fetchFn: this.fetchFn,
      WebSocketImpl: this.WebSocketImpl,
      logger: this.logger,
      onEvent: (payload) => this.handleCallback(payload),
    });
    this.conn.start();
  }

  async stop() {
    const c = this.conn;
    this.conn = null;
    if (c) await c.stop();
  }

  async reload() {
    await this.stop();
    this.start();
  }

  _consoleLink(task) {
    const base = typeof this.hubUrlResolver === "function" ? String(this.hubUrlResolver() || "").replace(/\/+$/, "") : "";
    if (!base || !/^https?:\/\//.test(base)) return "";
    const qs = new URLSearchParams({ thread: task.context_id, task: task.id });
    return `${base}/?${qs.toString()}`;
  }

  async _api(method, apiPath, body, { auth = true } = {}) {
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (auth) headers.Authorization = `Bearer ${await this._tenantToken()}`;
    const res = await this.fetchFn(`${this.cfg.domain}${apiPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json().catch(() => ({}));
    if (json?.code !== 0) {
      throw new Error(`飞书接口 ${apiPath} 失败: code=${json?.code ?? res.status} ${json?.msg || ""}`.trim());
    }
    return json;
  }

  async _tenantToken() {
    const now = Date.now();
    if (this._token && this._token.exp > now) return this._token.value;
    const json = await this._api("POST", "/open-apis/auth/v3/tenant_access_token/internal", {
      app_id: this.cfg.appId,
      app_secret: this.cfg.appSecret,
    }, { auth: false });
    const ttl = Math.max(Number(json.expire || 7200) - 300, 60) * 1000;
    this._token = { value: json.tenant_access_token, exp: now + ttl };
    return this._token.value;
  }

  // 邮箱 / 手机号换成本应用下的 open_id：发消息用它，卡片回调的白名单比对也靠它。
  // 需要应用开通通讯录权限 contact:user.id:readonly；失败时邮箱仍可直接作为收件人，只是点击无法比对身份。
  async _resolveApprovers() {
    const pending = this.cfg.approvers.filter((id) => !this._resolved.has(id) && (id.includes("@") || normalizeMobile(id)));
    if (pending.length) {
      const emails = pending.filter((id) => id.includes("@"));
      const mobiles = [...new Set(pending.filter((id) => !id.includes("@")).map(normalizeMobile))];
      try {
        const r = await this._api("POST", "/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id", { emails, mobiles });
        for (const u of r?.data?.user_list || []) {
          const um = normalizeMobile(u.mobile || "");
          if (!u.user_id) continue;
          for (const id of pending) {
            if ((u.email && id === u.email) || (um && normalizeMobile(id) === um)) this._resolved.set(id, u.user_id);
          }
        }
      } catch (err) {
        this.logger.warn?.(`[feishu-approval] 解析审批人邮箱/手机号失败: ${err?.message || err}`);
      }
    }
    return this.cfg.approvers.map((raw) => ({ raw, openId: this._resolved.get(raw) || "" }));
  }

  _loadCardRecord(taskId) {
    return this.store.getIdempotency(CARD_SCOPE, taskId);
  }

  _taskView(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    const messages = this.store.listMessages(taskId);
    const authReq = extractLastAuthRequest({ messages });
    const decisionMsg = [...messages].reverse().find((m) => m.kind === "auth_decision") || null;
    return { task, authReq, decisionMsg };
  }

  _outcomeFor(view) {
    const { task, authReq, decisionMsg } = view;
    if (task.state === "auth-required") return "pending";
    if (task.state === "canceled") return "canceled";
    const reqId = String(authReq?.data?.request_id || "default");
    if (decisionMsg && String(decisionMsg.data?.request_id || "") === reqId) {
      return decisionMsg.data?.decision === "approved" ? "approved" : "rejected";
    }
    return "stale";
  }

  handleEvent(event) {
    if (!this.cfg.configured || !event?.taskId) return;
    if (event.type === "task.auth_required") {
      void this.sendApprovalCards(event.taskId).catch((err) => {
        this.logger.warn?.(`[feishu-approval] 推送审批卡片失败: ${err?.message || err}`);
      });
    } else if (RESOLVED_EVENTS.has(event.type)) {
      void this.refreshCards(event.taskId).catch((err) => {
        this.logger.warn?.(`[feishu-approval] 更新审批卡片失败: ${err?.message || err}`);
      });
    }
  }

  async sendApprovalCards(taskId) {
    const view = this._taskView(taskId);
    if (!view || view.task.state !== "auth-required") return [];
    const card = buildApprovalCard({ ...view, outcome: "pending", consoleLink: this._consoleLink(view.task) });
    const content = JSON.stringify(card);
    const targets = (await this._resolveApprovers()).map((a) => a.openId || a.raw);
    if (this.cfg.chatId) targets.push(this.cfg.chatId);
    const messageIds = [];
    const errors = [];
    for (const id of targets) {
      try {
        const r = await this._api("POST", `/open-apis/im/v1/messages?receive_id_type=${receiveIdType(id)}`, {
          receive_id: id,
          msg_type: "interactive",
          content,
        });
        if (r?.data?.message_id) messageIds.push(r.data.message_id);
      } catch (err) {
        const msg = String(err?.message || err);
        const code = Number(/code=(\d+)/.exec(msg)?.[1]);
        errors.push(`发送给 ${id} 失败: ${msg}${SEND_HINTS[code] ? `。${SEND_HINTS[code]}` : ""}`);
        this.logger.warn?.(`[feishu-approval] 发送给 ${id} 失败: ${msg}`);
      }
    }
    this._lastSend = { at: Date.now(), task_id: taskId, ok: messageIds.length, failed: errors.length, error: errors[0] || "" };
    // 同一任务可能多次申请审批：保留历史卡片 id，结束时一并刷新成最终状态
    const prev = this._loadCardRecord(taskId)?.message_ids || [];
    this.store.saveIdempotency(CARD_SCOPE, taskId, {
      request_id: String(view.authReq?.data?.request_id || "default"),
      message_ids: [...new Set([...prev, ...messageIds])].slice(-50),
    });
    return messageIds;
  }

  // 在控制台、链接或超时处理后，把各审批人手里的卡片同步成最终状态，避免有人对着旧卡片再点。
  async refreshCards(taskId) {
    const rec = this._loadCardRecord(taskId);
    if (!rec?.message_ids?.length) return 0;
    const view = this._taskView(taskId);
    if (!view) return 0;
    const card = buildApprovalCard({ ...view, outcome: this._outcomeFor(view), consoleLink: this._consoleLink(view.task) });
    const content = JSON.stringify(card);
    let n = 0;
    for (const mid of rec.message_ids) {
      try {
        await this._api("PATCH", `/open-apis/im/v1/messages/${encodeURIComponent(mid)}`, { content });
        n += 1;
      } catch (err) {
        this.logger.warn?.(`[feishu-approval] 更新卡片 ${mid} 失败: ${err?.message || err}`);
      }
    }
    return n;
  }

  _isApprover(operator = {}) {
    const ids = [operator.open_id, operator.user_id, operator.union_id].filter(Boolean).map(String);
    const allowed = new Set([...this.cfg.approvers, ...this._resolved.values()]);
    return ids.some((id) => allowed.has(id));
  }

  // 长连接收到的事件入口；返回值即卡片回调的响应体（toast + 替换后的卡片）。
  async handleCallback(payload) {
    const header = payload?.header || {};
    if (header.event_type !== "card.action.trigger") return null;
    if (header.app_id && this.cfg.appId && header.app_id !== this.cfg.appId) return null;
    const ev = payload.event || {};
    const value = ev.action?.value || {};
    if (value.ah !== "approval" || !value.task_id) return null;

    const toast = (type, content) => ({ toast: { type, content } });
    await this._resolveApprovers();
    if (!this._isApprover(ev.operator)) {
      return toast("error", "你不在 a2a-hub 审批人白名单中，无权审批");
    }
    const decision = value.decision === "approve" ? "approve" : value.decision === "deny" ? "deny" : "";
    if (!decision) return toast("error", "无效的审批操作");

    const operatorId = String(ev.operator?.open_id || ev.operator?.user_id || ev.operator?.union_id || "");
    let resultToast;
    try {
      this.taskService.decideApproval(String(value.task_id), {
        fromNode: "owner",
        decision,
        requestId: String(value.request_id || ""),
        note: `飞书审批（${operatorId}）`,
        channel: "feishu",
        operator: operatorId,
      });
      resultToast = decision === "approve" ? toast("success", "已签名放行") : toast("info", "已拒绝");
    } catch (err) {
      resultToast = toast("warning", err?.message || "审批失败");
    }

    const view = this._taskView(String(value.task_id));
    if (!view) return resultToast;
    return {
      ...resultToast,
      card: {
        type: "raw",
        data: buildApprovalCard({ ...view, outcome: this._outcomeFor(view), consoleLink: this._consoleLink(view.task) }),
      },
    };
  }
}
