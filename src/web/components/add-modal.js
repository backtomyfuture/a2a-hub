import { api } from "../api.js";
import { setState, store } from "../state.js";
import { copyText, escapeHtml, showToast } from "../utils.js";

let modalTab = "agent";
let selectedTemplateId = "muse";
let createdResult = null;

export function resetAddModalState(defaultTab = "agent") {
  modalTab = defaultTab;
  selectedTemplateId = "muse";
  createdResult = null;
}

export function renderAddModal(root, refreshFn) {
  if (!store.showAddModal) {
    root.innerHTML = "";
    return;
  }

  const templates = store.templates?.length
    ? store.templates
    : [
        { id: "muse", name: "Muse / 云端协调", badge: "Leader", role: "leader", transport: "poll", poll_interval_min: 1, summary_hint: "云端主调度 Agent，负责拆分目标并协调各执行节点" },
        { id: "grok-bot", name: "Grok Bot", badge: "Worker", role: "worker", transport: "poll", poll_interval_min: 5, summary_hint: "实时检索与舆情分析 Bot" },
        { id: "generic-poll", name: "通用 Poll Agent", badge: "Worker", role: "worker", transport: "poll", poll_interval_min: 5, summary_hint: "通用定时轮询 Agent" },
      ];
  const activeTpl = templates.find((t) => t.id === selectedTemplateId) || templates[0];

  root.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal-card">
        <div class="row-between" style="margin-bottom:14px">
          <h2 style="margin:0;font-size:18px">接入能力节点</h2>
          <button class="btn btn-ghost btn-sm" id="add-modal-close">关闭</button>
        </div>

        <div class="filter-bar" style="margin-bottom:16px">
          <button class="filter-chip ${modalTab === "agent" ? "active" : ""}" data-add-tab="agent">
            接入独立 Agent（云端 / Bot / 脚本）
          </button>
          <button class="filter-chip ${modalTab === "device" ? "active" : ""}" data-add-tab="device">
            挂载一台电脑（自动发现本机 Claude / Codex 等）
          </button>
        </div>

        ${
          createdResult
            ? renderResultStep(createdResult)
            : modalTab === "agent"
              ? renderAgentForm(templates, activeTpl)
              : renderDeviceForm()
        }
      </div>
    </div>
  `;

  root.querySelector("[data-modal-backdrop]")?.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-modal-backdrop")) {
      setState({ showAddModal: null });
    }
  });
  root.querySelector("#add-modal-close")?.addEventListener("click", () => setState({ showAddModal: null }));

  root.querySelectorAll("[data-add-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      modalTab = btn.getAttribute("data-add-tab");
      createdResult = null;
      renderAddModal(root, refreshFn);
    });
  });

  if (createdResult) {
    root.querySelector("#btn-copy-created")?.addEventListener("click", () => {
      copyText(createdResult.copyText, "已复制到剪贴板");
    });
    root.querySelector("#btn-copy-token")?.addEventListener("click", () => {
      copyText(createdResult.token, "Token 已复制");
    });
    root.querySelector("#btn-finish-add")?.addEventListener("click", () => {
      createdResult = null;
      setState({ showAddModal: null, activeTab: "agents" });
    });
    return;
  }

  root.querySelectorAll("[data-pick-tpl]").forEach((el) => {
    el.addEventListener("click", () => {
      selectedTemplateId = el.getAttribute("data-pick-tpl");
      renderAddModal(root, refreshFn);
    });
  });

  root.querySelector("#form-create-agent")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const res = await api.createAgent({
        platform: selectedTemplateId,
        name: String(fd.get("name") || "").trim(),
        id: String(fd.get("id") || "").trim() || undefined,
        role: String(fd.get("role") || activeTpl.role),
        transport: String(fd.get("transport") || activeTpl.transport),
        poll_interval_min: Number(fd.get("poll_interval_min") || activeTpl.poll_interval_min || 5),
        summary: String(fd.get("summary") || "").trim(),
        webhook_url: String(fd.get("webhook_url") || "").trim(),
        webhook_secret: String(fd.get("webhook_secret") || "").trim(),
      });
      createdResult = {
        kind: "agent",
        title: `Agent「${res.agent.name}」已创建并立即激活`,
        token: res.token,
        copyLabel: "复制发给对方的接入提示词",
        copyText: res.onboarding_prompt,
      };
      showToast("Agent 创建成功");
      await refreshFn();
      renderAddModal(root, refreshFn);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  root.querySelector("#form-create-device")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const res = await api.createDevice({
        name: String(fd.get("name") || "").trim(),
        id: String(fd.get("id") || "").trim() || undefined,
        max_concurrent: Number(fd.get("max_concurrent") || 4),
        summary: String(fd.get("summary") || "").trim(),
      });
      createdResult = {
        kind: "device",
        title: `设备「${res.device.name}」凭据已生成`,
        token: res.token,
        copyLabel: "复制电脑端一键挂载命令",
        copyText: res.join_command,
      };
      showToast("设备已创建，请在目标电脑运行命令完成挂载");
      await refreshFn();
      renderAddModal(root, refreshFn);
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

function renderAgentForm(templates, activeTpl) {
  return `
    <form id="form-create-agent" class="stack-md">
      <div class="field">
        <span>1. 选择接入平台 / 接入方式</span>
        <div class="tile-grid">
          ${templates
            .map(
              (t) => `
            <button type="button" class="tile ${t.id === activeTpl.id ? "selected" : ""}" data-pick-tpl="${escapeHtml(t.id)}">
              <div class="tile-title">${escapeHtml(t.name)}</div>
              <div class="tile-sub">${escapeHtml(t.badge || t.transport)}</div>
            </button>
          `
            )
            .join("")}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field">
          <span>2. 显示名称 *</span>
          <input type="text" name="name" placeholder="例如：Muse / 科研助手 / Grok" required />
        </label>
        <label class="field">
          <span>英文 ID（可选，自动生成）</span>
          <input type="text" name="id" placeholder="如 muse-leader" />
        </label>
      </div>

      <label class="field">
        <span>能力定位（清晰说明它擅长什么、合适接什么任务）*</span>
        <textarea name="summary" rows="2" required>${escapeHtml(activeTpl.summary_hint || "")}</textarea>
      </label>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
        <label class="field">
          <span>角色</span>
          <select name="role">
            <option value="leader" ${activeTpl.role === "leader" ? "selected" : ""}>Leader (可调度)</option>
            <option value="worker" ${activeTpl.role !== "leader" ? "selected" : ""}>Worker (执行者)</option>
          </select>
        </label>
        <label class="field">
          <span>接收模式</span>
          <select name="transport">
            <option value="poll" ${activeTpl.transport === "poll" ? "selected" : ""}>定时轮询 (Poll)</option>
            <option value="longpoll" ${activeTpl.transport === "longpoll" ? "selected" : ""}>长连接 (Longpoll)</option>
            <option value="webhook" ${activeTpl.transport === "webhook" ? "selected" : ""}>Webhook 回调</option>
          </select>
        </label>
        <label class="field">
          <span>在线窗口 (分钟)</span>
          <input type="number" name="poll_interval_min" min="1" max="120" value="${Number(activeTpl.poll_interval_min || 5)}" />
        </label>
      </div>

      ${
        activeTpl.transport === "webhook"
          ? `
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">
          <label class="field">
            <span>Webhook URL *</span>
            <input type="url" name="webhook_url" placeholder="https://..." required />
          </label>
          <label class="field">
            <span>HMAC 签名密钥（可选）</span>
            <input type="text" name="webhook_secret" placeholder="secret" />
          </label>
        </div>
      `
          : ""
      }

      <div class="row-between" style="padding-top:6px">
        <span class="muted" style="font-size:12px">创建后立即激活可用，无需再手动通过准入池。</span>
        <button type="submit" class="btn btn-primary">创建并生成接入提示词</button>
      </div>
    </form>
  `;
}

function renderDeviceForm() {
  return `
    <form id="form-create-device" class="stack-md">
      <div class="card" style="background:var(--bg);padding:12px">
        <div style="font-weight:600;margin-bottom:4px">电脑自动挂载说明</div>
        <div class="muted" style="font-size:12px">
          在目标 Mac / Linux / Windows 电脑运行生成的 <code>ah join</code> 命令后，设备会自动探测本机已安装的 Claude Code、Codex、OpenCode、Gemini 等 CLI，并将所有能力卡片实时同步到中台。
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field">
          <span>设备名称 *</span>
          <input type="text" name="name" placeholder="例如：家里的 Mac mini" required />
        </label>
        <label class="field">
          <span>设备英文 ID（可选）</span>
          <input type="text" name="id" placeholder="如 mac-mini" />
        </label>
      </div>

      <div style="display:grid;grid-template-columns:1fr 2fr;gap:10px">
        <label class="field">
          <span>最大并发执行数</span>
          <input type="number" name="max_concurrent" min="1" max="16" value="4" />
        </label>
        <label class="field">
          <span>设备用途说明（可选）</span>
          <input type="text" name="summary" placeholder="例如：常驻内网开发机，运行 Claude 与 Codex" />
        </label>
      </div>

      <div style="display:flex;justify-content:flex-end">
        <button type="submit" class="btn btn-primary">生成挂载凭据与命令</button>
      </div>
    </form>
  `;
}

function renderResultStep(res) {
  return `
    <div class="stack-md">
      <div class="pill pill-success">${escapeHtml(res.title)}</div>
      ${
        res.token
          ? `<div class="row-between card" style="padding:10px 12px;background:var(--bg)">
              <div style="min-width:0">
                <div class="muted" style="font-size:11px">专属访问 Token（明文仅本次可见）</div>
                <div class="mono truncate">${escapeHtml(res.token)}</div>
              </div>
              <button type="button" class="btn btn-sm btn-secondary" id="btn-copy-token">复制 Token</button>
            </div>`
          : ""
      }
      <div class="field">
        <span>${res.kind === "agent" ? "请把下面整段提示词发给目标 Agent：" : "请在目标电脑终端运行以下命令："}</span>
        <div class="code-box">${escapeHtml(res.copyText)}</div>
      </div>
      <div class="row-between">
        <button type="button" class="btn btn-primary" id="btn-copy-created">${escapeHtml(res.copyLabel)}</button>
        <button type="button" class="btn btn-secondary" id="btn-finish-add">完成</button>
      </div>
    </div>
  `;
}
