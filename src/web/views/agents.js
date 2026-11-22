import { api } from "../api.js";
import { renderAgentCard } from "../components/agent-card.js";
import { resetAddModalState } from "../components/add-modal.js";
import { setState, store } from "../state.js";
import { copyText, escapeHtml, formatRelativeTime, showToast } from "../utils.js";

const FILTERS = [
  { id: "all", label: "全部 Agent" },
  { id: "running", label: "执行中" },
  { id: "cloud", label: "独立 / 云端 Agent" },
  { id: "device", label: "电脑 CLI Worker" },
  { id: "leader", label: "Leader 协调者" },
  { id: "paused", label: "已暂停" },
];

export function renderAgentsView(container, refreshFn) {
  const s = store.state;
  if (!s) return;

  const agents = s.agents || [];
  const devices = s.devices || [];
  const tasks = s.tasks || [];
  const f = store.agentFilter || "all";

  const filtered = agents.filter((a) => {
    if (f === "running") return Boolean(a.active_task_id);
    if (f === "cloud") return a.kind !== "device-worker";
    if (f === "device") return a.kind === "device-worker";
    if (f === "leader") return a.role === "leader";
    if (f === "paused") return !a.enabled;
    return true;
  });

  container.innerHTML = `
    <div class="section-header" style="margin-top:0">
      <div class="filter-bar">
        ${FILTERS.map(
          (item) => `
          <button class="filter-chip ${f === item.id ? "active" : ""}" data-filter="${item.id}">${item.label}</button>
        `
        ).join("")}
      </div>
      <div class="row">
        <button class="btn btn-secondary btn-sm" id="agents-add-device">+ 挂载一台电脑</button>
        <button class="btn btn-primary btn-sm" id="agents-add-agent">+ 接入独立 Agent</button>
      </div>
    </div>

    ${
      filtered.length
        ? `<div class="agent-grid">${filtered.map((a) => renderAgentCard(a, tasks)).join("")}</div>`
        : `<div class="empty-box">当前筛选条件下暂无 Agent。</div>`
    }

    <div class="section-header" style="margin-top:28px">
      <h2 class="section-title">已挂载电脑宿主 (${devices.length})</h2>
    </div>
    ${
      devices.length
        ? `<div class="stack-sm">
            ${devices
              .map(
                (d) => `
              <div class="card row-between" style="flex-wrap:wrap;gap:12px">
                <div style="min-width:220px">
                  <div class="row">
                    <span class="dot ${!d.enabled ? "dot-paused" : d.online ? "dot-online" : "dot-offline"}"></span>
                    <strong>${escapeHtml(d.name)}</strong>
                    <span class="pill">${d.worker_count || 0} 个 Worker</span>
                    <span class="muted mono">${escapeHtml(d.id)}</span>
                  </div>
                  <div class="muted" style="font-size:12px;margin-top:3px">
                    ${escapeHtml(d.os_info || d.platform || "等待上线")} · 并发上限 ${d.max_concurrent} · 最后心跳 ${formatRelativeTime(d.last_seen_at)}
                    ${d.summary ? ` · ${escapeHtml(d.summary)}` : ""}
                  </div>
                </div>
                <div class="row">
                  <button class="btn btn-sm btn-secondary" data-dev-toggle="${escapeHtml(d.id)}" data-dev-enabled="${d.enabled ? "1" : "0"}">
                    ${d.enabled ? "暂停整机" : "恢复整机"}
                  </button>
                  <button class="btn btn-sm btn-secondary" data-dev-rotate="${escapeHtml(d.id)}">复制挂载命令 / 重置 Token</button>
                  <button class="btn btn-sm btn-danger" data-dev-delete="${escapeHtml(d.id)}">移除</button>
                </div>
              </div>
            `
              )
              .join("")}
          </div>`
        : `<div class="empty-box">暂未挂载电脑宿主。</div>`
    }
  `;

  container.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => setState({ agentFilter: btn.getAttribute("data-filter") }));
  });

  container.querySelector("#agents-add-agent")?.addEventListener("click", () => {
    resetAddModalState("agent");
    setState({ showAddModal: "agent" });
  });
  container.querySelector("#agents-add-device")?.addEventListener("click", () => {
    resetAddModalState("device");
    setState({ showAddModal: "device" });
  });

  container.querySelectorAll("[data-open-agent]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-quick-dispatch]")) return;
      setState({ selectedAgentId: el.getAttribute("data-open-agent") });
    });
  });

  container.querySelectorAll("[data-quick-dispatch]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setState({
        showDispatchModal: true,
        dispatchPreselect: [btn.getAttribute("data-quick-dispatch")],
        dispatchContextId: "",
      });
    });
  });

  container.querySelectorAll("[data-dev-toggle]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-dev-toggle");
      const cur = btn.getAttribute("data-dev-enabled") === "1";
      try {
        await api.updateDevice(id, { enabled: !cur });
        showToast(cur ? "已暂停整机接单" : "已恢复整机接单");
        await refreshFn();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  container.querySelectorAll("[data-dev-rotate]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-dev-rotate");
      try {
        const res = await api.rotateDeviceToken(id);
        await copyText(res.join_command, "已重置设备 Token 并复制新挂载命令");
        await refreshFn();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  container.querySelectorAll("[data-dev-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-dev-delete");
      if (!confirm(`确定移除电脑设备「${id}」及其同步的本机 CLI Worker 吗？`)) return;
      try {
        await api.deleteDevice(id);
        showToast("已移除设备");
        await refreshFn();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}
