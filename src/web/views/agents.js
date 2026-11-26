import { api } from "../api.js";
import { renderAgentCard } from "../components/agent-card.js";
import { resetAddModalState } from "../components/add-modal.js";
import { resetAddWorkerModalState } from "../components/add-worker-modal.js";
import { deviceAvatar, deviceStatusOf, uiIcon } from "../icons.js";
import { setState, store } from "../state.js";
import { copyText, escapeHtml, formatRelativeTime, showToast, sortAgentsForDisplay, sortDevicesForDisplay } from "../utils.js";

function matchesStatus(agent, filterId) {
  if (filterId === "online") return Boolean(agent.online && agent.enabled);
  if (filterId === "running") return Boolean(agent.active_task_id);
  if (filterId === "device") return agent.kind === "device-worker";
  if (filterId === "cloud") return agent.kind !== "device-worker";
  if (filterId === "paused") return !agent.enabled;
  return true;
}

function matchesQuery(agent, qLower) {
  if (!qLower) return true;
  const parts = [
    agent.name,
    agent.id,
    agent.worker_key,
    agent.device_id,
    agent.device_name,
    agent.summary,
    agent.platform,
    agent.default_model,
    ...(Array.isArray(agent.skills) ? agent.skills : []),
    ...(Array.isArray(agent.tools) ? agent.tools : []),
  ];
  return parts.filter(Boolean).join(" ").toLowerCase().includes(qLower);
}

function matchesDeviceQuery(dev, qLower) {
  if (!qLower) return true;
  const parts = [dev.name, dev.id, dev.os_info, dev.platform, dev.summary];
  return parts.filter(Boolean).join(" ").toLowerCase().includes(qLower);
}

function renderDeviceNodeSection(d, allDevWorkers, matchedWorkers, tasks, options) {
  const { isCollapsed, isFocused, isFiltered, hasQuery } = options;
  const onlineCount = allDevWorkers.filter((w) => w.online && w.enabled).length;
  const capBadge = (d.active_count || 0) > 0
    ? `<span class="pill pill-primary">执行中 ${d.active_count}/${d.max_concurrent}</span>`
    : `<span class="pill">并发上限 ${d.max_concurrent}</span>`;

  return `
    <section class="device-node-card ${isFocused ? "is-focused" : ""}" data-device-card="${escapeHtml(d.id)}">
      <div class="device-node-head">
        <div
          class="device-node-toggle"
          role="button"
          tabindex="0"
          aria-expanded="${isCollapsed ? "false" : "true"}"
          data-toggle-device-collapse="${escapeHtml(d.id)}"
        >
          <span class="device-chevron ${isCollapsed ? "" : "is-open"}">${uiIcon("chevron-right", 14)}</span>
          ${deviceAvatar(d, { size: "xl", status: deviceStatusOf(d) })}
          <div style="min-width:0;flex:1">
            <div class="row" style="flex-wrap:wrap;gap:8px">
              <strong class="device-name">${escapeHtml(d.name || d.id)}</strong>
              ${d.is_local ? `<span class="pill pill-primary">本机</span>` : ""}
              <span class="muted mono">${escapeHtml(d.id)}</span>
              <span class="pill">在线 ${onlineCount}/${allDevWorkers.length}</span>
              ${capBadge}
              ${
                (hasQuery || isFiltered) && matchedWorkers.length !== allDevWorkers.length
                  ? `<span class="pill pill-primary">匹配 ${matchedWorkers.length}</span>`
                  : ""
              }
            </div>
            <div class="muted device-sub">
              ${escapeHtml(d.os_info || d.platform || "等待上线")} · 最后心跳 ${formatRelativeTime(d.last_seen_at)}
              ${d.summary ? ` · ${escapeHtml(d.summary)}` : ""}
            </div>
          </div>
        </div>

        <div class="row device-node-actions">
          <button type="button" class="btn btn-sm btn-primary" data-dev-add-worker="${escapeHtml(d.id)}">${uiIcon("plus", 12)} 添加 Worker</button>
          <button type="button" class="btn btn-sm btn-secondary" data-dev-scan-workers="${escapeHtml(d.id)}">${uiIcon("scan", 12)} 扫描 CLI</button>
          <button type="button" class="btn btn-sm btn-secondary" data-dev-toggle="${escapeHtml(d.id)}" data-dev-enabled="${d.enabled ? "1" : "0"}">
            ${d.enabled ? `${uiIcon("pause", 12)} 暂停整机` : `${uiIcon("play", 12)} 恢复整机`}
          </button>
          <button type="button" class="btn btn-sm btn-secondary" data-dev-rotate="${escapeHtml(d.id)}" title="重置 Device Token 并复制新挂载命令">${uiIcon("link", 12)} 挂载命令</button>
          <button type="button" class="btn btn-sm btn-ghost btn-icon btn-danger-ghost" data-dev-delete="${escapeHtml(d.id)}" title="移除设备" aria-label="移除设备">${uiIcon("trash", 13)}</button>
        </div>
      </div>

      ${
        isCollapsed
          ? ""
          : `<div class="device-node-body">
              ${
                matchedWorkers.length
                  ? `<div class="device-worker-grid">${matchedWorkers
                      .map((a) => renderAgentCard(a, tasks, { compactInDevice: true }))
                      .join("")}</div>`
                  : `<div class="device-empty-note muted">当前设备暂无 Worker，点击上方「扫描 CLI」或「+ 添加 Worker」</div>`
              }
            </div>`
      }
    </section>
  `;
}

export function renderAgentsView(container, refreshFn) {
  const s = store.state;
  if (!s) return;

  const agents = sortAgentsForDisplay(s.agents || []);
  const devices = sortDevicesForDisplay(s.devices || []);
  const tasks = s.tasks || [];
  const f = store.agentFilter || "all";
  const qRaw = String(store.agentSearch || "");
  const q = qRaw.trim().toLowerCase();
  const collapsedSet = new Set(Array.isArray(store.collapsedDeviceIds) ? store.collapsedDeviceIds : []);
  const focusId = store.focusDeviceId || "";

  const cloudAgents = agents.filter((a) => a.kind !== "device-worker");
  const deviceWorkers = agents.filter((a) => a.kind === "device-worker");

  const FILTERS = [
    { id: "all", label: `全部 (${agents.length})` },
    { id: "online", label: `在线 (${agents.filter((a) => a.online && a.enabled).length})` },
    { id: "running", label: `执行中 (${agents.filter((a) => Boolean(a.active_task_id)).length})` },
    { id: "device", label: `电脑节点 (${deviceWorkers.length})` },
    { id: "cloud", label: `独立 / 云端 (${cloudAgents.length})` },
    { id: "paused", label: `已暂停 (${agents.filter((a) => !a.enabled).length})` },
  ];

  const cloudFiltered = cloudAgents.filter((a) => matchesStatus(a, f) && matchesQuery(a, q));
  const showCloudSection = f !== "device" && (cloudFiltered.length > 0 || f === "cloud");

  const deviceEntries = [];
  if (f !== "cloud") {
    for (const d of devices) {
      const allDevWorkers = deviceWorkers.filter((a) => a.device_id === d.id);
      const matchedWorkers = allDevWorkers.filter((a) => matchesStatus(a, f) && matchesQuery(a, q));
      const statusAllOrDevice = f === "all" || f === "device";
      const includeDevice = q
        ? matchedWorkers.length > 0 || (statusAllOrDevice && matchesDeviceQuery(d, q))
        : statusAllOrDevice || matchedWorkers.length > 0;
      if (!includeDevice) continue;
      const isFocused = Boolean(focusId && d.id === focusId);
      const isCollapsed = q || isFocused ? false : collapsedSet.has(d.id);
      deviceEntries.push({ device: d, allDevWorkers, matchedWorkers, isCollapsed, isFocused });
    }
  }

  const allShownCollapsed = deviceEntries.length > 0 && deviceEntries.every((item) => item.isCollapsed);
  const showEmptyGlobal = agents.length === 0 && devices.length === 0;
  const showNoMatches = !showEmptyGlobal && !showCloudSection && deviceEntries.length === 0;

  container.innerHTML = `
    <div class="section-header" style="margin-top:0">
      <div class="filter-bar">
        ${FILTERS.map(
          (item) => `
          <button type="button" class="filter-chip ${f === item.id ? "active" : ""}" data-filter="${item.id}">${escapeHtml(item.label)}</button>
        `
        ).join("")}
      </div>
      <div class="row" style="flex-wrap:wrap">
        <input
          type="text"
          id="agent-search-input"
          class="toolbar-search"
          value="${escapeHtml(qRaw)}"
          placeholder="搜索 Agent、设备、模型、技能..."
        />
        ${
          deviceEntries.length && !q
            ? `<button type="button" class="btn btn-secondary btn-sm" id="btn-toggle-all-devices">${allShownCollapsed ? "全部展开" : "全部收起"}</button>`
            : ""
        }
      </div>
    </div>

    ${
      showEmptyGlobal
        ? `<div class="empty-box">
            <div style="margin-bottom:10px">还没有接入任何 Agent 或电脑节点。</div>
            <button type="button" class="btn btn-primary btn-sm" id="agents-empty-onboard-btn">+ 接入第一个 Agent / 电脑</button>
          </div>`
        : ""
    }

    ${
      showCloudSection
        ? `<section style="margin-bottom:22px">
            <div class="section-header" style="margin-top:8px">
              <h2 class="section-title">独立 / 云端 Agent (${cloudFiltered.length})</h2>
            </div>
            ${
              cloudFiltered.length
                ? `<div class="agent-grid">${cloudFiltered.map((a) => renderAgentCard(a, tasks)).join("")}</div>`
                : `<div class="empty-box">当前筛选条件下暂无独立 / 云端 Agent。</div>`
            }
          </section>`
        : ""
    }

    ${
      deviceEntries.length
        ? `<section>
            <div class="section-header" style="margin-top:${showCloudSection ? "6px" : "8px"}">
              <h2 class="section-title">电脑节点 (${deviceEntries.length})</h2>
            </div>
            <div class="stack-md">
              ${deviceEntries
                .map(({ device, allDevWorkers, matchedWorkers, isCollapsed, isFocused }) =>
                  renderDeviceNodeSection(device, allDevWorkers, matchedWorkers, tasks, {
                    isCollapsed,
                    isFocused,
                    isFiltered: f !== "all" && f !== "device",
                    hasQuery: Boolean(q),
                  })
                )
                .join("")}
            </div>
          </section>`
        : ""
    }

    ${
      showNoMatches
        ? `<div class="empty-box">当前筛选条件下暂无匹配的 Agent 或电脑节点。</div>`
        : ""
    }
  `;

  if (focusId) {
    const focusedCard = container.querySelector(`[data-device-card="${CSS.escape(focusId)}"]`);
    focusedCard?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    store.focusDeviceId = "";
  }

  container.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => setState({ agentFilter: btn.getAttribute("data-filter") }));
  });

  const searchInput = container.querySelector("#agent-search-input");
  searchInput?.addEventListener("input", (e) => {
    store.agentSearch = e.target.value;
    renderAgentsView(container, refreshFn);
    const nextInput = container.querySelector("#agent-search-input");
    if (nextInput) {
      nextInput.focus();
      nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
    }
  });

  container.querySelector("#agents-empty-onboard-btn")?.addEventListener("click", () => {
    resetAddModalState("agent");
    setState({ showAddModal: "agent" });
  });

  container.querySelector("#btn-toggle-all-devices")?.addEventListener("click", () => {
    const next = new Set(collapsedSet);
    if (allShownCollapsed) {
      for (const item of deviceEntries) next.delete(item.device.id);
    } else {
      for (const item of deviceEntries) next.add(item.device.id);
    }
    setState({ collapsedDeviceIds: [...next] });
  });

  const toggleOneDevice = (id) => {
    if (!id) return;
    const next = new Set(collapsedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setState({ collapsedDeviceIds: [...next] });
  };

  container.querySelectorAll("[data-toggle-device-collapse]").forEach((el) => {
    el.addEventListener("click", () => toggleOneDevice(el.getAttribute("data-toggle-device-collapse")));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleOneDevice(el.getAttribute("data-toggle-device-collapse"));
      }
    });
  });

  container.querySelectorAll("[data-dev-add-worker]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      resetAddWorkerModalState();
      setState({ showAddWorkerDeviceId: btn.getAttribute("data-dev-add-worker") });
    });
  });

  container.querySelectorAll("[data-dev-scan-workers]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-dev-scan-workers");
      try {
        const res = await api.scanDeviceWorkers(id, {});
        if (res.local) {
          const added = Array.isArray(res.added) ? res.added : [];
          showToast(
            added.length
              ? `扫描到 ${res.discovered_count} 个 CLI，已新增上线: ${added.join(", ")}`
              : `共检测到 ${res.discovered_count || 0} 个本机 CLI，均已在列表中`
          );
          await refreshFn();
        } else {
          await copyText(res.cli_command || "ah workers scan", "远端电脑请在终端执行扫描命令（已复制：ah workers scan）");
        }
      } catch (err) {
        showToast(err.message, true);
      }
    });
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
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
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
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
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
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
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
