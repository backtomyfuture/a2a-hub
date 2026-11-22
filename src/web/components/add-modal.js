import { api } from "../api.js";
import { setState, store } from "../state.js";
import { copyText, escapeHtml, showToast } from "../utils.js";

let modalTab = "agent";
let selectedTemplateId = "generic";
let selectedJoinPlatform = "unix";
let createdResult = null;

export function resetAddModalState(defaultTab = "agent") {
  modalTab = defaultTab;
  selectedTemplateId = "generic";
  selectedJoinPlatform = "unix";
  createdResult = null;
}

const FALLBACK_TEMPLATES = [
  {
    id: "generic",
    name: "通用（自定义参数）",
    default_name: "",
    default_id: "",
    role: "worker",
    transport: "poll",
    poll_interval_min: 5,
    badge: "自由配置",
    summary_hint: "",
  },
  {
    id: "muse",
    name: "Muse（云端主协调）",
    default_name: "Muse",
    default_id: "muse",
    role: "leader",
    transport: "longpoll",
    poll_interval_min: 2,
    badge: "Leader · 长连接",
    summary_hint: "云端主调度 Agent，负责拆解目标并编排本机与云端 Worker 协同完成",
  },
];

export function renderAddModal(root, refreshFn) {
  if (!store.showAddModal) {
    root.innerHTML = "";
    return;
  }

  const templates = store.templates?.length ? store.templates : FALLBACK_TEMPLATES;
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
            挂载一台电脑（自动发现本机 26 种常见 CLI Agent）
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
    root.querySelectorAll("[data-join-plat]").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedJoinPlatform = btn.getAttribute("data-join-plat") || "unix";
        if (createdResult.joinCommands) {
          createdResult.copyText = createdResult.joinCommands[selectedJoinPlatform] || createdResult.copyText;
        }
        renderAddModal(root, refreshFn);
      });
    });
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

  const formEl = root.querySelector("#form-create-agent");
  if (formEl) {
    const tplSelect = formEl.querySelector("#select-agent-template");
    const roleSelect = formEl.querySelector('select[name="role"]');
    const transportSelect = formEl.querySelector('select[name="transport"]');
    const pollInput = formEl.querySelector('input[name="poll_interval_min"]');
    const nameInput = formEl.querySelector('input[name="name"]');
    const idInput = formEl.querySelector('input[name="id"]');
    const summaryInput = formEl.querySelector('textarea[name="summary"]');
    const webhookBox = formEl.querySelector("#agent-webhook-fields");
    const webhookUrlInput = formEl.querySelector('input[name="webhook_url"]');
    const hintEl = formEl.querySelector("#tpl-preset-hint");

    const syncWebhookVisibility = () => {
      const isWh = transportSelect?.value === "webhook";
      if (webhookBox) webhookBox.classList.toggle("hidden", !isWh);
      if (webhookUrlInput) webhookUrlInput.required = isWh;
    };

    const formatPresetHint = (tpl) => {
      if (!tpl || tpl.id === "generic") {
        return "通用模式：可自由组合下方角色与接收方式（定时轮询 / 长连接 / Webhook 回调）。";
      }
      return `已套用「${tpl.name}」预设：角色 ${tpl.role}、接收模式 ${tpl.transport}、在线窗口 ${tpl.poll_interval_min} 分钟（仍可下方微调）。`;
    };

    tplSelect?.addEventListener("change", () => {
      const prevTpl = templates.find((t) => t.id === selectedTemplateId) || templates[0];
      selectedTemplateId = tplSelect.value;
      const nextTpl = templates.find((t) => t.id === selectedTemplateId) || templates[0];

      if (roleSelect) roleSelect.value = nextTpl.role || "worker";
      if (transportSelect) transportSelect.value = nextTpl.transport || "poll";
      if (pollInput) pollInput.value = String(nextTpl.poll_interval_min || 5);

      if (nameInput && (!nameInput.value.trim() || nameInput.value.trim() === (prevTpl.default_name || ""))) {
        nameInput.value = nextTpl.default_name || "";
      }
      if (idInput && (!idInput.value.trim() || idInput.value.trim() === (prevTpl.default_id || ""))) {
        idInput.value = nextTpl.default_id || "";
      }
      if (summaryInput && (!summaryInput.value.trim() || summaryInput.value.trim() === (prevTpl.summary_hint || ""))) {
        summaryInput.value = nextTpl.summary_hint || "";
      }
      if (hintEl) hintEl.textContent = formatPresetHint(nextTpl);
      syncWebhookVisibility();
    });

    transportSelect?.addEventListener("change", syncWebhookVisibility);
    syncWebhookVisibility();

    formEl.addEventListener("submit", async (e) => {
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
  }

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
      const joinCommands = res.join_commands || {
        unix: res.join_command || "",
        windows: res.join_command || "",
        cli: res.join_command || "",
      };
      selectedJoinPlatform = "unix";
      createdResult = {
        kind: "device",
        title: `设备「${res.device.name}」凭据已生成`,
        token: res.token,
        copyLabel: "复制一行安装挂载命令",
        copyText: joinCommands[selectedJoinPlatform] || res.join_command,
        joinCommands,
      };
      showToast("设备已创建，请在目标电脑运行命令完成安装并挂载");
      await refreshFn();
      renderAddModal(root, refreshFn);
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

function renderAgentForm(templates, activeTpl) {
  const hint =
    activeTpl.id === "generic"
      ? "通用模式：可自由组合下方角色与接收方式（定时轮询 / 长连接 / Webhook 回调）。"
      : `已套用「${activeTpl.name}」预设：角色 ${activeTpl.role}、接收模式 ${activeTpl.transport}、在线窗口 ${activeTpl.poll_interval_min} 分钟（仍可下方微调）。`;

  return `
    <form id="form-create-agent" class="stack-md">
      <label class="field">
        <span>1. 平台模板（通用为自由配置，选平台则自动填好参数）</span>
        <select id="select-agent-template" name="platform">
          ${templates
            .map(
              (t) => `
            <option value="${escapeHtml(t.id)}" ${t.id === activeTpl.id ? "selected" : ""}>
              ${escapeHtml(t.name)}${t.badge ? ` — ${escapeHtml(t.badge)}` : ""}
            </option>
          `
            )
            .join("")}
        </select>
        <div class="muted" id="tpl-preset-hint" style="font-size:12px">${escapeHtml(hint)}</div>
      </label>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field">
          <span>2. 显示名称 *</span>
          <input type="text" name="name" value="${escapeHtml(activeTpl.default_name || "")}" placeholder="例如：Muse / 科研助手 / Grok" required />
        </label>
        <label class="field">
          <span>英文 ID（可选，自动生成）</span>
          <input type="text" name="id" value="${escapeHtml(activeTpl.default_id || "")}" placeholder="如 muse-leader" />
        </label>
      </div>

      <label class="field">
        <span>能力定位（清晰说明它擅长什么、合适接什么任务）*</span>
        <textarea name="summary" rows="2" placeholder="一句话描述该 Agent 的职责与专长..." required>${escapeHtml(activeTpl.summary_hint || "")}</textarea>
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

      <div id="agent-webhook-fields" class="${activeTpl.transport === "webhook" ? "" : "hidden"}" style="display:grid;grid-template-columns:2fr 1fr;gap:10px">
        <label class="field">
          <span>Webhook URL *</span>
          <input type="url" name="webhook_url" placeholder="https://..." ${activeTpl.transport === "webhook" ? "required" : ""} />
        </label>
        <label class="field">
          <span>HMAC 签名密钥（可选）</span>
          <input type="text" name="webhook_secret" placeholder="secret" />
        </label>
      </div>

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
        <div style="font-weight:600;margin-bottom:4px">零前置一行挂载说明</div>
        <div class="muted" style="font-size:12px">
          生成的命令已融合「安装 <code>Node 24</code> + 安装 <code>ah</code> + 挂载上线 + 开机自启」。在目标 Mac / Linux / Windows 电脑直接粘贴运行即可自动探测本机 26 种常见 CLI Agent，纯出站连接，无需开放入站端口。
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
  const isDevice = res.kind === "device" && res.joinCommands;
  const activeCmd = isDevice ? (res.joinCommands[selectedJoinPlatform] || res.copyText) : res.copyText;
  const platLabels = [
    { id: "unix", label: "macOS / Linux 一键安装挂载" },
    { id: "windows", label: "Windows PowerShell" },
    { id: "cli", label: "已装 ah 快捷接入" },
  ];

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
      ${
        isDevice
          ? `<div class="filter-bar">
              ${platLabels
                .map(
                  (p) => `
                <button type="button" class="filter-chip ${selectedJoinPlatform === p.id ? "active" : ""}" data-join-plat="${p.id}">
                  ${p.label}
                </button>
              `
                )
                .join("")}
            </div>`
          : ""
      }
      <div class="field">
        <span>${res.kind === "agent" ? "请把下面整段提示词发给目标 Agent：" : "请在目标电脑终端运行以下命令（也可直接发给该电脑上的 AI 助手代为执行）："}</span>
        <div class="code-box" id="created-command-box">${escapeHtml(activeCmd)}</div>
        ${
          isDevice && selectedJoinPlatform !== "cli"
            ? `<span class="muted" style="font-size:11px">零前置：会自动检测并安装 Node 24 与 <code>ah</code>，同步本机 26 种 CLI 并注册系统后台自启。</span>`
            : ""
        }
      </div>
      <div class="row-between">
        <button type="button" class="btn btn-primary" id="btn-copy-created">${escapeHtml(res.copyLabel)}</button>
        <button type="button" class="btn btn-secondary" id="btn-finish-add">完成</button>
      </div>
    </div>
  `;
}
