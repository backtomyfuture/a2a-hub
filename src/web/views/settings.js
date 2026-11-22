import { api } from "../api.js";
import { store } from "../state.js";
import { copyText, escapeHtml, formatRelativeTime, showToast } from "../utils.js";

let loadedSettings = null;

export async function renderSettingsView(container) {
  const s = store.state;
  if (!s) return;

  if (!loadedSettings) {
    try {
      loadedSettings = await api.getSettings();
    } catch {
      loadedSettings = { hub_url: s.hub_url, public_key: s.public_key, notifier: {} };
    }
    if (store.activeTab !== "settings") return;
  }

  const n = loadedSettings.notifier || {};
  const schedules = s.schedules || [];

  container.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:18px;align-items:start">
      <section class="card">
        <h2 class="section-title" style="margin-bottom:6px">机主实时提醒推送</h2>
        <p class="muted" style="margin-top:0;font-size:12px">当任务命中高危审批、Agent 追问或执行失败时，即时推送深链到你的手机 / IM。</p>

        <form id="settings-notifier-form" class="stack-md">
          <label class="field">
            <span>Hub 对外访问基址（通知内深链跳转使用）</span>
            <input type="url" name="public_url" value="${escapeHtml(loadedSettings.hub_url || s.hub_url || "")}" placeholder="https://hub.example.com" />
          </label>
          <label class="field">
            <span>触发条件</span>
            <select name="notify_on">
              <option value="action" ${n.notify_on !== "all" ? "selected" : ""}>仅在需要介入或失败时提醒（推荐）</option>
              <option value="all" ${n.notify_on === "all" ? "selected" : ""}>任务完成时也发送提醒</option>
            </select>
          </label>
          <label class="field">
            <span>飞书群机器人 Webhook</span>
            <input type="url" name="feishu_webhook" value="${escapeHtml(n.feishu_webhook || "")}" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." />
          </label>
          <label class="field">
            <span>Bark 推送地址</span>
            <input type="url" name="bark_url" value="${escapeHtml(n.bark_url || "")}" placeholder="https://api.day.app/<key>/" />
          </label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <label class="field">
              <span>Telegram Bot Token</span>
              <input type="password" name="telegram_bot_token" placeholder="${n.telegram_bot_token_set ? "已配置（留空不改）" : "123456:ABC..."}" />
            </label>
            <label class="field">
              <span>Telegram Chat ID</span>
              <input type="text" name="telegram_chat_id" value="${escapeHtml(n.telegram_chat_id || "")}" />
            </label>
          </div>
          <label class="field">
            <span>通用 JSON Webhook</span>
            <input type="url" name="notify_webhook" value="${escapeHtml(n.notify_webhook || "")}" placeholder="https://..." />
          </label>
          <div class="row-between">
            <button type="button" class="btn btn-secondary" id="btn-test-notifier">发送测试告警</button>
            <button type="submit" class="btn btn-primary">保存通知设置</button>
          </div>
        </form>
      </section>

      <section class="stack-md">
        <div class="card">
          <h2 class="section-title" style="margin-bottom:8px">网关安全与验签公钥</h2>
          <div class="stack-sm">
            <div class="muted" style="font-size:12px">Hub 地址：<span class="mono">${escapeHtml(s.hub_url || "-")}</span></div>
            <div class="muted" style="font-size:12px">控制台口令鉴权：${s.auth_required ? "已启用 ✓" : "未设置（本地开放模式）"}</div>
            <div class="field" style="margin-top:6px">
              <span>Ed25519 审批验签公钥（只读分发给设备端）</span>
              <div class="code-box" style="max-height:110px">${escapeHtml(s.public_key || "")}</div>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-pubkey" style="align-self:flex-start">复制公钥</button>
          </div>
        </div>

        <div class="card">
          <h2 class="section-title" style="margin-bottom:8px">定时任务自报观测 (${schedules.length})</h2>
          ${
            schedules.length
              ? `<div class="table-wrap">
                  <table>
                    <thead><tr><th>Agent</th><th>任务</th><th>间隔</th><th>上次上报</th><th>状态</th></tr></thead>
                    <tbody>
                      ${schedules
                        .map(
                          (sch) => `
                        <tr>
                          <td>${escapeHtml(sch.agent_name || sch.agent_id)}</td>
                          <td>${escapeHtml(sch.name)}</td>
                          <td class="muted">${sch.interval_min}m</td>
                          <td class="muted">${formatRelativeTime(sch.last_run_at)}</td>
                          <td>${sch.missed ? `<span class="pill pill-danger">超时未报</span>` : `<span class="pill pill-success">正常</span>`}</td>
                        </tr>
                      `
                        )
                        .join("")}
                    </tbody>
                  </table>
                </div>`
              : `<div class="empty-box" style="padding:16px">暂无 Agent 上报的定时自报条目。</div>`
          }
        </div>
      </section>
    </div>
  `;

  container.querySelector("#btn-copy-pubkey")?.addEventListener("click", () => {
    copyText(s.public_key || "", "已复制 Hub 审批公钥");
  });

  container.querySelector("#btn-test-notifier")?.addEventListener("click", async () => {
    try {
      const r = await api.testNotifier();
      if (r.result?.total === 0) showToast("尚未配置任何通知渠道", true);
      else showToast(`测试消息已发送（成功 ${r.result?.sent || 0}/${r.result?.total || 0}）`);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  container.querySelector("#settings-notifier-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.saveSettings({
        public_url: String(fd.get("public_url") || "").trim(),
        notify_on: String(fd.get("notify_on") || "action"),
        feishu_webhook: String(fd.get("feishu_webhook") || "").trim(),
        bark_url: String(fd.get("bark_url") || "").trim(),
        telegram_bot_token: String(fd.get("telegram_bot_token") || "").trim(),
        telegram_chat_id: String(fd.get("telegram_chat_id") || "").trim(),
        notify_webhook: String(fd.get("notify_webhook") || "").trim(),
      });
      loadedSettings = await api.getSettings();
      showToast("通知配置已保存到 app.env");
    } catch (err) {
      showToast(err.message, true);
    }
  });
}
