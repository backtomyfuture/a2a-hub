// 外部机主告警通知器（飞书自定义群机器人 / Bark / Telegram / 通用 Webhook）。
// 默认仅在需要机主介入（auth-required / input-required / failed）时主动推送，避免完成态轰炸。

import { validateWebhookUrl } from "./webhooks.mjs";
import { BROWSER_USER_AGENT } from "./config.mjs";

export class ExternalNotifier {
  constructor(env = {}, { fetchFn = globalThis.fetch, hubUrlResolver = null } = {}) {
    this.env = env;
    this.fetchFn = fetchFn;
    this.hubUrlResolver = hubUrlResolver;
    this._dedupe = new Map();
  }

  updateEnv(nextEnv = {}) {
    this.env = { ...this.env, ...nextEnv };
  }

  _remember(key, ttlMs = 30_000) {
    const now = Date.now();
    const prev = this._dedupe.get(key);
    if (prev && now - prev < ttlMs) return false;
    this._dedupe.set(key, now);
    if (this._dedupe.size > 1000) {
      const first = this._dedupe.keys().next().value;
      if (first) this._dedupe.delete(first);
    }
    return true;
  }

  _deepLink(event) {
    const base = typeof this.hubUrlResolver === "function" ? String(this.hubUrlResolver() || "").replace(/\/+$/, "") : "";
    if (!base) return "";
    const qs = new URLSearchParams();
    if (event.contextId) qs.set("thread", event.contextId);
    if (event.taskId) qs.set("task", event.taskId);
    return `${base}/?${qs.toString()}`;
  }

  configuredChannels() {
    const e = this.env;
    return {
      feishu: Boolean(e.AH_FEISHU_WEBHOOK),
      bark: Boolean(e.AH_BARK_URL),
      telegram: Boolean(e.AH_TELEGRAM_BOT_TOKEN && e.AH_TELEGRAM_CHAT_ID),
      webhook: Boolean(e.AH_NOTIFY_WEBHOOK),
      notify_on: String(e.AH_NOTIFY_ON || "action").toLowerCase(),
    };
  }

  async sendAlert({ title, body, link = "", event = {} } = {}) {
    const e = this.env;
    const tasks = [];
    const fullText = link ? `${body}\n处理链接：${link}` : body;

    if (e.AH_FEISHU_WEBHOOK) {
      const v = validateWebhookUrl(e.AH_FEISHU_WEBHOOK);
      if (v.ok) {
        tasks.push(this._postJson(v.url, {
          msg_type: "text",
          content: { text: `【${title}】\n${fullText}` },
        }));
      }
    }

    if (e.AH_BARK_URL) {
      const v = validateWebhookUrl(e.AH_BARK_URL);
      if (v.ok) {
        const url = v.url.replace(/\/+$/, "");
        tasks.push(this._postJson(url, {
          title,
          body: fullText,
          ...(link ? { url: link } : {}),
        }));
      }
    }

    if (e.AH_TELEGRAM_BOT_TOKEN && e.AH_TELEGRAM_CHAT_ID) {
      const tgUrl = `https://api.telegram.org/bot${e.AH_TELEGRAM_BOT_TOKEN}/sendMessage`;
      tasks.push(this._postJson(tgUrl, {
        chat_id: e.AH_TELEGRAM_CHAT_ID,
        text: `*${title}*\n${fullText}`,
        parse_mode: "Markdown",
      }));
    }

    if (e.AH_NOTIFY_WEBHOOK) {
      const v = validateWebhookUrl(e.AH_NOTIFY_WEBHOOK);
      if (v.ok) {
        tasks.push(this._postJson(v.url, {
          title,
          body,
          link,
          event,
          timestamp: Date.now(),
        }));
      }
    }

    if (!tasks.length) return { ok: true, sent: 0 };
    const results = await Promise.allSettled(tasks);
    const okCount = results.filter((r) => r.status === "fulfilled" && r.value).length;
    return { ok: okCount > 0, sent: okCount, total: tasks.length };
  }

  async _postJson(url, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": BROWSER_USER_AGENT,
        },
        body: JSON.stringify(payload),
        redirect: "manual",
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  handleEvent(event) {
    if (!event || !event.taskId) return;
    const mode = String(this.env.AH_NOTIFY_ON || "action").toLowerCase();
    const actionable = ["task.auth_required", "task.input_required", "task.failed"].includes(event.type);
    const completed = event.type === "task.completed";
    if (!actionable && !(mode === "all" && completed)) return;

    const dedupeKey = `${event.type}:${event.taskId}:${event.seq || 0}`;
    if (!this._remember(dedupeKey)) return;

    const labelMap = {
      "task.auth_required": "待审批确认",
      "task.input_required": "Agent 向你追问",
      "task.failed": "任务执行失败",
      "task.completed": "任务已完成",
    };
    const title = `a2a-hub · ${labelMap[event.type] || event.type}`;
    const detail = event.prompt || event.reason || event.error || event.summary || event.title || event.taskId;
    const body = `Agent: ${event.agentId || "-"}\n任务: ${event.title || event.taskId}\n详情: ${detail}`;
    const link = this._deepLink(event);
    void this.sendAlert({ title, body, link, event }).catch(() => {});
  }
}
