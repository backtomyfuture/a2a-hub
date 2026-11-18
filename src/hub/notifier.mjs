// 可选外部通知器：在任务进入 auth-required、input-required 或终态/告警时，
// 通过飞书群机器人 Webhook（可选通知渠道）、Bark、Telegram 或通用 Webhook 推送提醒。

import { f1 } from "../bus/tables.mjs";

const DEFAULT_EVENTS = new Set(["auth-required", "input-required", "completed", "failed", "rejected"]);

export class ExternalNotifier {
  constructor({ config = {}, publicUrl = "", log, fetchImpl } = {}) {
    this.config = config && typeof config === "object" ? config : {};
    this.publicUrl = String(publicUrl ?? this.config.publicUrl ?? "").trim().replace(/\/+$/, "");
    this.log = log ?? (() => {});
    this.fetch = fetchImpl ?? globalThis.fetch;
    const evList = Array.isArray(this.config.events) && this.config.events.length
      ? this.config.events
      : Array.from(DEFAULT_EVENTS);
    this.events = new Set(evList.map((s) => String(s).trim()).filter(Boolean));
    this._sent = new Map();
  }

  isEnabled() {
    return Boolean(
      this.config.feishuWebhookUrl
      || this.config.barkUrl
      || (this.config.telegramBotToken && this.config.telegramChatId)
      || this.config.webhookUrl,
    );
  }

  _dedupKey(kind, taskId, statusMsg = "") {
    return `${kind}:${taskId}:${statusMsg}`;
  }

  _seenRecently(key, ttlMs = 300_000) {
    const prev = this._sent.get(key);
    if (prev && Date.now() - prev < ttlMs) return true;
    this._sent.set(key, Date.now());
    if (this._sent.size > 512) {
      const oldest = this._sent.keys().next().value;
      this._sent.delete(oldest);
    }
    return false;
  }

  async onBusEvent(ev) {
    if (!this.isEnabled() || !ev?.fields) return;
    const fields = ev.fields;
    const taskId = String(fields.Task_ID ?? "").trim();
    const status = String(fields.Status ?? "").trim();
    if (!taskId || !status || !this.events.has(status)) return;
    const statusMsg = String(fields.Status_Msg ?? "").trim();
    const key = this._dedupKey(status, taskId, statusMsg);
    if (this._seenRecently(key)) return;

    const title = String(fields.Title ?? taskId);
    const node = String(fields.Target_Node ?? "");
    const skill = String(fields.Skill_ID ?? "");
    const link = this.publicUrl ? `\n控制台：${this.publicUrl}/#task=${encodeURIComponent(taskId)}` : "";

    const badge = {
      "auth-required": "⏸ 待机主审批",
      "input-required": "❓ 等待补充答复",
      completed: "✅ 任务完成",
      failed: "❌ 任务失败",
      rejected: "🚫 任务拒收",
    }[status] ?? `📌 状态变更 (${status})`;

    await this.notify({
      event: status,
      taskId,
      title: `${badge} · ${taskId}`,
      body: `任务：${title}\n节点：${node || "-"}  能力：${skill || "-"}${link}`,
    });
  }

  async notifyTaskAlert({ event = "stale", task, message = "" } = {}) {
    if (!this.isEnabled() || !this.events.has(event)) return;
    const taskId = f1(task, "Task_ID");
    if (!taskId) return;
    const key = this._dedupKey(event, taskId, message.slice(0, 40));
    if (this._seenRecently(key)) return;
    const link = this.publicUrl ? `\n控制台：${this.publicUrl}/#task=${encodeURIComponent(taskId)}` : "";
    await this.notify({
      event,
      taskId,
      title: `⚠️ ${event} · ${taskId}`,
      body: `${message}${link}`,
    });
  }

  async notify({ event, taskId = "", title, body }) {
    if (!this.isEnabled() || typeof this.fetch !== "function") return;
    const jobs = [];

    if (this.config.feishuWebhookUrl) {
      jobs.push(this._postJson(this.config.feishuWebhookUrl, {
        msg_type: "text",
        content: { text: `${title}\n${body}` },
      }));
    }

    if (this.config.barkUrl) {
      const base = String(this.config.barkUrl).trim().replace(/\/+$/, "");
      jobs.push(this._postJson(base, {
        title,
        body,
        group: "a2a-hub",
        url: this.publicUrl ? `${this.publicUrl}/#task=${encodeURIComponent(taskId)}` : undefined,
      }));
    }

    if (this.config.telegramBotToken && this.config.telegramChatId) {
      const tgUrl = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
      jobs.push(this._postJson(tgUrl, {
        chat_id: this.config.telegramChatId,
        text: `${title}\n\n${body}`,
      }));
    }

    if (this.config.webhookUrl) {
      jobs.push(this._postJson(this.config.webhookUrl, {
        event,
        task_id: taskId,
        title,
        body,
        url: this.publicUrl || "",
        timestamp: new Date().toISOString(),
      }));
    }

    await Promise.allSettled(jobs);
  }

  async _postJson(url, body) {
    try {
      const r = await this.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        this.log(`external notifier HTTP ${r.status} for ${url.split("?")[0]}`);
      }
    } catch (e) {
      this.log(`external notifier error: ${e?.message ?? e}`);
    }
  }
}
