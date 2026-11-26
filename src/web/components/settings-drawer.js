import { api } from "../api.js";
import { setState, store } from "../state.js";
import { bindBackdropClose, copyText, escapeHtml, showToast } from "../utils.js";

let loadedSettings = null;
let loadingSettings = false;

export function resetSettingsCache() {
  loadedSettings = null;
}

export function renderSettingsDrawer(root) {
  if (!store.showSettingsDrawer) {
    return;
  }
  const s = store.state;
  if (!s) return;

  if (!loadedSettings && !loadingSettings) {
    loadingSettings = true;
    void api
      .getSettings()
      .then((res) => {
        loadedSettings = res;
      })
      .catch(() => {
        loadedSettings = { hub_url: s.hub_url, public_key: s.public_key, notifier: {} };
      })
      .finally(() => {
        loadingSettings = false;
        if (store.showSettingsDrawer) renderSettingsDrawer(root);
      });
  }

  const n = loadedSettings?.notifier || {};
  const channels = [
    { label: "飞书", on: Boolean(n.feishu_webhook || s.notifier?.feishu) },
    { label: "Bark", on: Boolean(n.bark_url || s.notifier?.bark) },
    { label: "Telegram", on: Boolean(n.telegram_bot_token_set || s.notifier?.telegram) },
    { label: "Webhook", on: Boolean(n.notify_webhook || s.notifier?.webhook) },
  ];

  const ap = loadedSettings?.approval || {};
  const fa = loadedSettings?.feishu_app || {};
  const FEISHU_STATE_TEXT = {
    connected: "已连接",
    connecting: "连接中",
    reconnecting: "重连中",
    disabled: "未配置",
    idle: "未运行",
    error: "异常",
  };
  const feishuState = fa.status?.configured ? fa.status?.state || "idle" : "disabled";
  const feishuStateText = FEISHU_STATE_TEXT[feishuState] || feishuState;
  const feishuOn = feishuState === "connected";

  root.innerHTML = `
    <div class="drawer-backdrop" data-settings-backdrop>
      <aside class="drawer-panel">
        <div class="row-between" style="margin-bottom:14px">
          <div>
            <h2 style="margin:0;font-size:18px">系统通知与安全设置</h2>
            <div class="muted" style="font-size:12px">低频基础配置，保存至本机 app.env（0600 权限）</div>
          </div>
          <button class="btn btn-ghost btn-sm" id="settings-drawer-close" type="button">关闭</button>
        </div>

        <div class="chip-row" style="margin-bottom:16px">
          ${channels
            .map((c) => `<span class="pill ${c.on ? "pill-success" : ""}">${c.label}${c.on ? " · 已配置" : " · 未配"}</span>`)
            .join("")}
        </div>

        <section class="card" style="background:var(--bg);margin-bottom:16px">
          <h3 class="section-title" style="font-size:14px;margin-bottom:6px">机主实时告警推送</h3>
          <p class="muted" style="margin:0 0 12px;font-size:12px">当任务命中高危审批、Agent 追问或执行失败时，即时推送控制台深链到手机 / IM。</p>

          <form id="settings-notifier-form" class="stack-md">
            <label class="field">
              <span>Hub 对外访问基址（通知深链跳转用）</span>
              <input type="url" name="public_url" value="${escapeHtml(loadedSettings?.hub_url || s.hub_url || "")}" placeholder="https://hub.example.com" />
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
              <button type="button" class="btn btn-secondary btn-sm" id="btn-test-notifier">发送测试告警</button>
              <button type="submit" class="btn btn-primary btn-sm">保存设置</button>
            </div>
          </form>
        </section>

        <section class="card" style="background:var(--bg);margin-bottom:16px">
          <h3 class="section-title" style="font-size:14px;margin-bottom:6px">审批渠道</h3>
          <p class="muted" style="margin:0 0 12px;font-size:12px">除控制台外，还可以在推送通知或飞书卡片里直接审批。放行签名始终由 Hub 私钥完成。</p>
          <div class="chip-row" style="margin-bottom:12px">
            <span class="pill ${ap.links_enabled ? "pill-success" : ""}">一次性审批链接 · ${ap.links_enabled ? "已开启" : "未开启"}</span>
            <span class="pill ${feishuOn ? "pill-success" : ""}">飞书应用 · ${escapeHtml(feishuStateText)}</span>
          </div>
          <form id="settings-approval-form" class="stack-md">
            <label class="field" style="flex-direction:row;align-items:center;gap:8px">
              <input type="checkbox" name="approval_links" ${ap.links_enabled ? "checked" : ""} />
              <span>在通知里附带一次性审批链接（打开后需再点一次确认）</span>
            </label>
            <p class="muted" style="margin:0;font-size:12px">拿到链接的人都能审批。飞书群机器人这类多人可见的渠道请谨慎开启。</p>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <label class="field">
                <span>链接有效期（分钟）</span>
                <input type="number" min="1" max="1440" name="approval_link_ttl_min" value="${escapeHtml(String(ap.link_ttl_min ?? 30))}" />
              </label>
              <label class="field">
                <span>审批超时自动拒绝（分钟，0 关闭）</span>
                <input type="number" min="0" max="43200" name="approval_timeout_min" value="${escapeHtml(String(ap.timeout_min ?? 1440))}" />
              </label>
            </div>
            <h4 style="margin:6px 0 0;font-size:13px">飞书应用审批（长连接，无需公网回调）</h4>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <label class="field">
                <span>App ID</span>
                <input type="text" name="feishu_app_id" value="${escapeHtml(fa.app_id || "")}" placeholder="cli_xxxxxxxxxxxxxxxx" />
              </label>
              <label class="field">
                <span>App Secret</span>
                <input type="password" name="feishu_app_secret" placeholder="${fa.app_secret_set ? "已配置（留空不改）" : ""}" />
              </label>
            </div>
            <label class="field">
              <span>审批人（邮箱 / 手机号 / 本应用的 open_id，逗号分隔；只有他们的点击有效，并会收到私聊卡片）</span>
              <input type="text" name="feishu_approvers" value="${escapeHtml(fa.approvers || "")}" placeholder="you@company.com, 13800000000" />
            </label>
            <label class="field">
              <span>额外推送到群（chat_id，可选）</span>
              <input type="text" name="feishu_chat_id" value="${escapeHtml(fa.chat_id || "")}" placeholder="oc_xxx" />
            </label>
            ${fa.status?.last_send?.error ? `<div class="muted" style="font-size:12px;color:var(--danger)">最近一次推送卡片失败：${escapeHtml(fa.status.last_send.error)}</div>` : ""}
            ${fa.status?.last_error ? `<div class="muted" style="font-size:12px;color:var(--danger)">最近错误：${escapeHtml(fa.status.last_error)}</div>` : ""}
            <div class="row-between">
              <span></span>
              <button type="submit" class="btn btn-primary btn-sm">保存审批设置</button>
            </div>
          </form>
        </section>

        <section class="card" style="background:var(--bg)">
          <h3 class="section-title" style="font-size:14px;margin-bottom:8px">网关安全与验签公钥</h3>
          <div class="stack-sm">
            <div class="muted" style="font-size:12px">Hub 地址：<span class="mono">${escapeHtml(s.hub_url || "-")}</span></div>
            <div class="muted" style="font-size:12px">控制台口令鉴权：${s.auth_required ? "已启用 ✓" : "未设置（本地开放模式）"}</div>
            <div class="field" style="margin-top:6px">
              <span>Ed25519 审批验签公钥（只读分发给设备端）</span>
              <div class="code-box" style="max-height:110px">${escapeHtml(s.public_key || "")}</div>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-pubkey" style="align-self:flex-start">复制公钥</button>
          </div>
        </section>
      </aside>
    </div>
  `;

  bindBackdropClose(root.querySelector("[data-settings-backdrop]"), () => {
    setState({ showSettingsDrawer: false });
  });
  root.querySelector("#settings-drawer-close")?.addEventListener("click", () => {
    setState({ showSettingsDrawer: false });
  });

  root.querySelector("#btn-copy-pubkey")?.addEventListener("click", () => {
    copyText(s.public_key || "", "已复制 Hub 审批公钥");
  });

  root.querySelector("#btn-test-notifier")?.addEventListener("click", async () => {
    try {
      const r = await api.testNotifier();
      if (r.result?.total === 0) showToast("尚未配置任何通知渠道", true);
      else showToast(`测试消息已发送（成功 ${r.result?.sent || 0}/${r.result?.total || 0}）`);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  root.querySelector("#settings-approval-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.saveSettings({
        approval_links: fd.get("approval_links") === "on",
        approval_link_ttl_min: String(fd.get("approval_link_ttl_min") || "30"),
        approval_timeout_min: String(fd.get("approval_timeout_min") ?? "1440"),
        feishu_app_id: String(fd.get("feishu_app_id") || "").trim(),
        feishu_app_secret: String(fd.get("feishu_app_secret") || "").trim(),
        feishu_approvers: String(fd.get("feishu_approvers") || "").trim(),
        feishu_chat_id: String(fd.get("feishu_chat_id") || "").trim(),
      });
      loadedSettings = await api.getSettings();
      showToast("审批设置已保存到 app.env");
      renderSettingsDrawer(root);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  root.querySelector("#settings-notifier-form")?.addEventListener("submit", async (e) => {
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
      renderSettingsDrawer(root);
    } catch (err) {
      showToast(err.message, true);
    }
  });
}
