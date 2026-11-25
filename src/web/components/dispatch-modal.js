import { api } from "../api.js";
import { setState, store } from "../state.js";
import { agentSourceLabel, bindBackdropClose, escapeHtml, formatBytes, showToast } from "../utils.js";

let pendingFiles = [];

export function resetDispatchModalState() {
  pendingFiles = [];
}

function appendPendingFiles(fileList) {
  for (const f of Array.from(fileList || [])) {
    if (!f) continue;
    const dup = pendingFiles.some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified);
    if (!dup) pendingFiles.push(f);
  }
}

function groupEnabledAgents(agents, devices) {
  const devOrder = [...devices].sort((a, b) => {
    if (Boolean(a.is_local) !== Boolean(b.is_local)) return a.is_local ? -1 : 1;
    if (Boolean(a.online) !== Boolean(b.online)) return a.online ? -1 : 1;
    return String(a.name || a.id).localeCompare(String(b.name || b.id), "zh-CN");
  });
  const devMap = new Map(devices.map((d) => [d.id, d]));
  const groups = [];
  const handledDeviceIds = new Set();

  for (const d of devOrder) {
    const items = agents.filter((a) => a.kind === "device-worker" && a.device_id === d.id);
    if (!items.length) continue;
    handledDeviceIds.add(d.id);
    groups.push({
      id: `dev:${d.id}`,
      title: d.name || d.id,
      subtitle: d.id,
      isLocal: Boolean(d.is_local),
      items,
    });
  }

  for (const a of agents) {
    if (a.kind !== "device-worker" || !a.device_id || handledDeviceIds.has(a.device_id)) continue;
    handledDeviceIds.add(a.device_id);
    const items = agents.filter((x) => x.kind === "device-worker" && x.device_id === a.device_id);
    const d = devMap.get(a.device_id);
    groups.push({
      id: `dev:${a.device_id}`,
      title: d?.name || a.device_name || a.device_id,
      subtitle: a.device_id,
      isLocal: Boolean(d?.is_local),
      items,
    });
  }

  const cloudItems = agents.filter((a) => a.kind !== "device-worker");
  if (cloudItems.length) {
    groups.push({
      id: "cloud",
      title: "独立 / 云端 Agent",
      subtitle: "",
      isLocal: false,
      items: cloudItems,
    });
  }

  return groups;
}

function renderDispatchOption(agent, preselect) {
  const searchBlob = [
    agent.name,
    agent.id,
    agent.worker_key,
    agent.device_id,
    agent.device_name,
    agent.default_model,
    agent.summary,
    ...(Array.isArray(agent.skills) ? agent.skills : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const dotCls = agent.online ? "dot-online" : "dot-offline";
  const sub = agent.summary || agent.worker_key || agentSourceLabel(agent);

  return `
    <label
      class="card dispatch-option"
      data-dispatch-item
      data-search-text="${escapeHtml(searchBlob)}"
    >
      <input type="checkbox" name="targets" value="${escapeHtml(agent.id)}" ${preselect.has(agent.id) ? "checked" : ""} style="margin-top:3px" />
      <div style="min-width:0;flex:1">
        <div class="row" style="gap:6px">
          <span class="dot ${dotCls}"></span>
          <span style="font-weight:600;font-size:13px" class="truncate">${escapeHtml(agent.name)}</span>
          ${agent.default_model ? `<span class="chip chip-model">${escapeHtml(agent.default_model)}</span>` : ""}
        </div>
        <div class="muted truncate" style="font-size:11px;margin-top:2px">${escapeHtml(sub)}</div>
      </div>
    </label>
  `;
}

export function renderDispatchModal(root, refreshFn) {
  if (!store.showDispatchModal) {
    root.innerHTML = "";
    return;
  }

  const agents = (store.state?.agents || []).filter((a) => a.enabled);
  const devices = store.state?.devices || [];
  const groups = groupEnabledAgents(agents, devices);
  const preselect = new Set(store.dispatchPreselect || []);
  const contextId = store.dispatchContextId || "";

  root.innerHTML = `
    <div class="modal-backdrop" data-dispatch-backdrop>
      <div class="modal-card">
        <div class="row-between" style="margin-bottom:14px">
          <h2 style="margin:0;font-size:18px">${contextId ? "在同一对话线程追派任务" : "派发新任务（支持多 Agent 并发扇出）"}</h2>
          <button class="btn btn-ghost btn-sm" id="dispatch-close">关闭</button>
        </div>

        <form id="dispatch-form" class="stack-md">
          <div class="field">
            <div class="row-between" style="flex-wrap:wrap;gap:8px">
              <span>选择执行 Agent（可多选，自动共享同一个 Thread 上下文）*</span>
              ${
                agents.length > 4
                  ? `<input type="text" id="dispatch-agent-search" class="toolbar-search" style="max-width:240px" placeholder="快速筛选 Agent 名称、设备或能力..." />`
                  : ""
              }
            </div>
            ${
              agents.length
                ? `<div class="stack-sm" style="max-height:290px;overflow-y:auto;padding-right:2px">
                    ${groups
                      .map(
                        (g) => `
                      <div class="dispatch-group" data-dispatch-group>
                        <div class="dispatch-group-title">
                          <span>${escapeHtml(g.title)}</span>
                          ${g.isLocal ? `<span class="pill pill-primary">本机</span>` : ""}
                          ${g.subtitle ? `<span class="muted mono">${escapeHtml(g.subtitle)}</span>` : ""}
                          <span class="muted">(${g.items.length})</span>
                        </div>
                        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px">
                          ${g.items.map((a) => renderDispatchOption(a, preselect)).join("")}
                        </div>
                      </div>
                    `
                      )
                      .join("")}
                    <div id="dispatch-search-empty" class="empty-box hidden" style="padding:16px">未找到匹配的 Agent</div>
                  </div>`
                : `<div class="error-banner">暂无已启用的 Agent，请先接入 Agent 或恢复暂停中的 Agent。</div>`
            }
          </div>

          <label class="field">
            <span>任务标题（可选，缺省自动截取正文）</span>
            <input type="text" name="title" placeholder="例如：排查 PR #42 单测失败原因" />
          </label>

          <label class="field">
            <span>任务详细指令 *</span>
            <textarea name="input_text" rows="4" placeholder="描述你想让 Agent 完成的工作目标与验收标准..." required></textarea>
          </label>

          <div class="field">
            <span>任务附件（可选，扇出时自动授权给所有目标 Agent）</span>
            <div class="attachment-dropzone" id="dispatch-dropzone">
              <input type="file" id="dispatch-file-input" multiple class="hidden" />
              <div class="row-between" style="flex-wrap:wrap;gap:8px">
                <span class="muted" style="font-size:12px">拖拽文件到此区域，或点击右侧按钮选择本地文件</span>
                <button type="button" class="btn btn-secondary btn-sm" id="dispatch-file-pick-btn">+ 选择文件</button>
              </div>
              <div id="dispatch-file-list" class="attachment-pending-list"></div>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
            <label class="field">
              <span>线程 ID（留空新建）</span>
              <input type="text" name="context_id" value="${escapeHtml(contextId)}" placeholder="ctx_..." />
            </label>
            <label class="field">
              <span>模型覆盖（可选）</span>
              <input type="text" name="model" placeholder="默认随 Agent 配置" />
            </label>
            <label class="field">
              <span>优先级 (1-10)</span>
              <input type="number" name="priority" min="1" max="10" value="5" />
            </label>
          </div>

          <div class="row-between">
            <span class="muted" style="font-size:12px">选择多个 Agent 时，将同时创建子任务并汇总在同一 Thread 内。</span>
            <button type="submit" id="dispatch-submit-btn" class="btn btn-primary" ${agents.length ? "" : "disabled"}>立即派发</button>
          </div>
        </form>
      </div>
    </div>
  `;

  bindBackdropClose(root.querySelector("[data-dispatch-backdrop]"), () => {
    resetDispatchModalState();
    setState({ showDispatchModal: false, dispatchPreselect: [], dispatchContextId: "" });
  });
  root.querySelector("#dispatch-close")?.addEventListener("click", () => {
    resetDispatchModalState();
    setState({ showDispatchModal: false, dispatchPreselect: [], dispatchContextId: "" });
  });

  const fileListEl = root.querySelector("#dispatch-file-list");
  const fileInputEl = root.querySelector("#dispatch-file-input");
  const dropzoneEl = root.querySelector("#dispatch-dropzone");
  const renderPendingFiles = () => {
    if (!fileListEl) return;
    if (!pendingFiles.length) {
      fileListEl.innerHTML = "";
      return;
    }
    fileListEl.innerHTML = pendingFiles
      .map(
        (f, idx) => `
      <span class="attachment-chip">
        <span>📎</span>
        <span class="attachment-name truncate">${escapeHtml(f.name)}</span>
        <span class="attachment-size">${escapeHtml(formatBytes(f.size))}</span>
        <button type="button" class="btn btn-ghost btn-sm attachment-action-btn" data-remove-dispatch-file="${idx}" title="移除">×</button>
      </span>
    `
      )
      .join("");
    fileListEl.querySelectorAll("[data-remove-dispatch-file]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute("data-remove-dispatch-file"));
        if (Number.isInteger(idx) && idx >= 0) {
          pendingFiles.splice(idx, 1);
          renderPendingFiles();
        }
      });
    });
  };
  renderPendingFiles();

  root.querySelector("#dispatch-file-pick-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    fileInputEl?.click();
  });
  dropzoneEl?.addEventListener("click", (e) => {
    if (e.target.closest("button") || e.target.closest("input")) return;
    fileInputEl?.click();
  });
  fileInputEl?.addEventListener("change", () => {
    appendPendingFiles(fileInputEl.files);
    fileInputEl.value = "";
    renderPendingFiles();
  });
  dropzoneEl?.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzoneEl.classList.add("is-dragover");
  });
  dropzoneEl?.addEventListener("dragleave", () => {
    dropzoneEl.classList.remove("is-dragover");
  });
  dropzoneEl?.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzoneEl.classList.remove("is-dragover");
    appendPendingFiles(e.dataTransfer?.files);
    renderPendingFiles();
  });

  // 使用 classList.toggle 原地过滤，避免重绘 DOM 导致已勾选状态与表单草稿丢失
  const searchEl = root.querySelector("#dispatch-agent-search");
  searchEl?.addEventListener("input", (e) => {
    const q = String(e.target.value || "").trim().toLowerCase();
    let visibleCount = 0;
    root.querySelectorAll("[data-dispatch-group]").forEach((grp) => {
      let grpVisible = 0;
      grp.querySelectorAll("[data-dispatch-item]").forEach((item) => {
        const hay = item.getAttribute("data-search-text") || "";
        const matched = !q || hay.includes(q);
        item.classList.toggle("hidden", !matched);
        if (matched) {
          grpVisible++;
          visibleCount++;
        }
      });
      grp.classList.toggle("hidden", grpVisible === 0);
    });
    root.querySelector("#dispatch-search-empty")?.classList.toggle("hidden", visibleCount > 0);
  });

  root.querySelector("#dispatch-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const targets = fd.getAll("targets").map(String).filter(Boolean);
    if (!targets.length) {
      showToast("请至少勾选一个目标 Agent", true);
      return;
    }
    const submitBtn = root.querySelector("#dispatch-submit-btn");
    const origBtnText = submitBtn?.textContent || "立即派发";
    if (submitBtn) submitBtn.disabled = true;

    try {
      const uploadedAttachments = [];
      for (let i = 0; i < pendingFiles.length; i++) {
        if (submitBtn) submitBtn.textContent = `正在上传附件 (${i + 1}/${pendingFiles.length})...`;
        const up = await api.uploadFile(pendingFiles[i]);
        const f = up.file;
        uploadedAttachments.push({
          id: f.id,
          uri: f.uri,
          name: f.name,
          mime: f.mime,
          size: f.size,
          sha256: f.sha256,
        });
      }
      if (submitBtn) submitBtn.textContent = "正在派发...";

      const res = await api.dispatchTask({
        to: targets,
        title: String(fd.get("title") || "").trim(),
        input_text: String(fd.get("input_text") || "").trim(),
        context_id: String(fd.get("context_id") || "").trim() || undefined,
        model: String(fd.get("model") || "").trim() || undefined,
        priority: Number(fd.get("priority") || 5),
        ...(uploadedAttachments.length ? { attachments: uploadedAttachments } : {}),
      });
      resetDispatchModalState();
      showToast(`已派发 ${res.tasks.length} 个任务`);
      setState({
        showDispatchModal: false,
        dispatchPreselect: [],
        dispatchContextId: "",
        activeTab: "threads",
        selectedThreadId: res.context_id,
      });
      await refreshFn();
    } catch (err) {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = origBtnText;
      }
      showToast(err.message, true);
    }
  });
}
