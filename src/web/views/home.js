import { api } from "../api.js";
import { agentAvatar, agentStatusOf, deviceAvatar, deviceStatusOf, uiIcon } from "../icons.js";
import { setState, store } from "../state.js";
import { bindAttachmentPreview, escapeHtml, formatRelativeTime, renderAttachmentsBar, showToast, stateLabel, stateTone } from "../utils.js";

function isActiveTaskState(state) {
  return state === "working" || state === "submitted" || state === "input-required" || state === "auth-required";
}

function isFailedTaskState(state) {
  return state === "failed" || state === "rejected";
}

function isAbnormalSchedule(sch) {
  return sch.health === "missed" || sch.health === "failing" || sch.health === "attention";
}

function taskStatusDotClass(state) {
  if (state === "completed") return "is-ok";
  if (state === "failed" || state === "rejected") return "is-fail";
  if (state === "working" || state === "submitted") return "is-run";
  if (state === "input-required" || state === "auth-required") return "is-warn";
  return "is-idle";
}

function scheduleStatusDotClass(sch) {
  const h = sch.health || "idle";
  if (h === "missed" || h === "failing") return "is-fail";
  if (h === "attention") return "is-warn";
  if (h === "running") return "is-run";
  if (h === "healthy") return "is-ok";
  return "is-idle";
}

function cleanExcerpt(raw) {
  return String(raw || "")
    .replace(/\r?\n+/g, " ")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function renderActionCard(task, agentMap) {
  const isAuth = task.state === "auth-required";
  const ag = agentMap.get(task.to_agent_id);
  const agentLabel = ag?.device_name ? `${ag.device_name} / ${ag.name}` : ag?.name || task.to_agent_id;
  const msgs = task.messages || [];
  const lastMsg = [...msgs].reverse().find((m) => m.kind === (isAuth ? "auth_request" : "question"));
  const promptText = lastMsg?.body || task.title;

  return `
    <div class="action-card ${isAuth ? "is-auth" : ""}">
      <div class="action-card-head">
        ${agentAvatar(ag || { id: task.to_agent_id }, { size: "lg", status: ag ? agentStatusOf(ag) : "" })}
        <div class="action-card-title">
          <div class="row" style="gap:8px;min-width:0">
            <span class="pill ${stateTone(task.state)}">${stateLabel(task.state)}</span>
            <strong class="truncate">${escapeHtml(task.title)}</strong>
          </div>
          <div class="muted truncate action-card-sub">指派给 ${escapeHtml(agentLabel)} · ${formatRelativeTime(task.updated_at)}</div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" data-view-thread="${escapeHtml(task.context_id)}">查看线程 ${uiIcon("arrow-right", 12)}</button>
      </div>
      <div class="action-prompt">${escapeHtml(promptText)}</div>
      ${renderAttachmentsBar(task.attachments || [])}
      ${
        isAuth
          ? `<div class="action-reply-row">
              <input type="text" placeholder="可选审批备注..." data-auth-note="${escapeHtml(task.id)}" />
              <button type="button" class="btn btn-sm btn-danger" data-decide-deny="${escapeHtml(task.id)}">${uiIcon("x", 12)} 拒绝</button>
              <button type="button" class="btn btn-sm btn-primary" data-decide-approve="${escapeHtml(task.id)}">${uiIcon("shield", 12)} 签名并放行</button>
            </div>`
          : `<form class="action-reply-row" data-reply-form="${escapeHtml(task.id)}">
              <input type="text" name="reply" placeholder="输入补充说明并恢复执行..." required />
              <button type="submit" class="btn btn-sm btn-primary">${uiIcon("send", 12)} 发送回复</button>
            </form>`
      }
    </div>
  `;
}

function renderTaskFeed(tasks, agentMap) {
  if (!tasks.length) {
    return `<div class="panel-empty">当前筛选条件下暂无任务记录。</div>`;
  }
  return `
    <div class="task-feed">
      ${tasks
        .map((t) => {
          const ag = agentMap.get(t.to_agent_id);
          const agentLabel = ag?.device_name ? `${ag.device_name} / ${ag.name}` : ag?.name || t.to_agent_id;
          const isErr = Boolean(t.error_message) || isFailedTaskState(t.state);
          const excerpt = cleanExcerpt(t.error_message || t.receipt?.summary || "");
          const canCancel = t.state === "working" || t.state === "submitted";
          const fromSuffix = t.from_node && t.from_node !== "owner" ? ` ← ${t.from_node}` : "";
          const attCount = Number.isFinite(Number(t.attachment_count))
            ? Number(t.attachment_count)
            : (t.attachments?.length || 0) + (t.receipt?.attachments?.length || 0);

          // 固定列网格：状态 / 时间 / 操作三列定宽，避免有无「取消」按钮时时间列左右跳动
          return `
            <div class="task-feed-row ${isFailedTaskState(t.state) ? "is-err" : ""}" data-view-thread="${escapeHtml(t.context_id)}">
              ${agentAvatar(ag || { id: t.to_agent_id }, { size: "md" })}
              <div class="task-feed-body">
                <div class="task-feed-title">
                  <strong class="truncate">${escapeHtml(t.title)}</strong>
                  ${attCount ? `<span class="attachment-tag" title="含 ${attCount} 个附件">📎 ${attCount}</span>` : ""}
                </div>
                <div class="task-feed-sub">
                  <span class="task-feed-target">${escapeHtml(agentLabel)}${escapeHtml(fromSuffix)}</span>
                  ${excerpt ? `<span class="task-excerpt ${isErr ? "is-err" : ""}">${escapeHtml(excerpt)}</span>` : ""}
                </div>
              </div>
              <span class="task-state is-${taskStatusDotClass(t.state).slice(3)}"><span class="status-dot ${taskStatusDotClass(t.state)}"></span>${escapeHtml(stateLabel(t.state))}</span>
              <span class="task-time" title="${escapeHtml(formatRelativeTime(t.updated_at))}">${formatRelativeTime(t.updated_at)}</span>
              <span class="task-action">${
                canCancel
                  ? `<button type="button" class="btn btn-ghost btn-sm btn-icon" data-cancel-task="${escapeHtml(t.id)}" title="取消任务" aria-label="取消任务">${uiIcon("x", 13)}</button>`
                  : ""
              }</span>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderNodeCapacityPanel(devices, agents) {
  const cloudAgents = agents.filter((a) => a.kind !== "device-worker");
  const cloudOnline = cloudAgents.filter((a) => a.online && a.enabled).length;
  const sortedDevices = [...devices].sort((a, b) => {
    if (Boolean(a.is_local) !== Boolean(b.is_local)) return a.is_local ? -1 : 1;
    if (Boolean(a.online) !== Boolean(b.online)) return a.online ? -1 : 1;
    return String(a.name || a.id).localeCompare(String(b.name || b.id), "zh-CN");
  });

  return `
    <section class="panel">
      <div class="panel-head">
        <h3 class="panel-title">${uiIcon("cpu", 14)} 节点负载</h3>
        <button type="button" class="btn btn-ghost btn-sm" id="home-goto-agents">管理全部 →</button>
      </div>
      ${
        !sortedDevices.length && !cloudAgents.length
          ? `<div class="panel-empty">暂未接入电脑节点或独立 Agent，可点击顶栏「+ 接入 Agent / 电脑」。</div>`
          : `<div>
              ${sortedDevices
                .map((d) => {
                  const devWorkers = agents.filter((a) => a.kind === "device-worker" && a.device_id === d.id);
                  const devOnline = devWorkers.filter((a) => a.online && a.enabled).length;
                  const used = Number(d.active_count || 0);
                  const cap = Math.max(Number(d.max_concurrent || 1), 1);
                  const pct = Math.min(100, Math.round((used / cap) * 100));
                  return `
                    <div class="host-row" data-focus-device="${escapeHtml(d.id)}">
                      ${deviceAvatar(d, { size: "lg", status: deviceStatusOf(d) })}
                      <div class="host-main">
                        <div class="row" style="min-width:0;gap:6px">
                          <strong class="truncate host-name">${escapeHtml(d.name || d.id)}</strong>
                          ${d.is_local ? `<span class="tag-subtle">本机</span>` : ""}
                        </div>
                        <div class="host-sub">
                          <span class="host-workers">${devWorkers
                            .slice(0, 5)
                            .map((w) => agentAvatar(w, { size: "xs", title: w.name }))
                            .join("")}</span>
                          <span>在线 ${devOnline}/${devWorkers.length} · ${formatRelativeTime(d.last_seen_at)}</span>
                        </div>
                      </div>
                      <div class="host-load" title="并发槽位 ${used}/${cap}">
                        <span class="mono">${used}/${cap}</span>
                        <div class="mini-meter">
                          <div class="mini-meter-fill ${pct >= 80 ? "is-warn" : used > 0 ? "is-busy" : ""}" style="width:${pct}%"></div>
                        </div>
                      </div>
                    </div>
                  `;
                })
                .join("")}
              ${
                cloudAgents.length
                  ? `<div class="host-row" id="home-goto-cloud">
                      <span class="avatar avatar-lg avatar-glyph">${uiIcon("sparkles", 18)}</span>
                      <div class="host-main">
                        <strong class="truncate host-name">独立 / 云端 Agent</strong>
                        <div class="host-sub">
                          <span class="host-workers">${cloudAgents
                            .slice(0, 5)
                            .map((a) => agentAvatar(a, { size: "xs", title: a.name }))
                            .join("")}</span>
                          <span>${cloudAgents.length} 个</span>
                        </div>
                      </div>
                      <div class="host-load">
                        <span class="mono">${cloudOnline}/${cloudAgents.length}</span>
                        <span class="muted" style="font-size:11px">在线</span>
                      </div>
                    </div>`
                  : ""
              }
            </div>`
      }
    </section>
  `;
}

function renderScheduleSummaryPanel(schedules, agentMap) {
  const priority = (s) => (isAbnormalSchedule(s) ? 0 : s.health === "running" ? 1 : 2);
  const topSchedules = [...schedules]
    .sort((a, b) => {
      const pDiff = priority(a) - priority(b);
      if (pDiff !== 0) return pDiff;
      return Number(b.last_run_at || 0) - Number(a.last_run_at || 0);
    })
    .slice(0, 4);

  return `
    <section class="panel">
      <div class="panel-head">
        <h3 class="panel-title">${uiIcon("clock", 14)} 定时巡检</h3>
        <button type="button" class="btn btn-ghost btn-sm" id="home-goto-schedules">查看全部 →</button>
      </div>
      ${
        topSchedules.length
          ? `<div>
              ${topSchedules
                .map((sch) => {
                  const ag = agentMap.get(sch.agent_id);
                  const targetAttr = sch.last_context_id
                    ? `data-view-thread="${escapeHtml(sch.last_context_id)}"`
                    : `data-goto-schedules="1"`;
                  return `
                    <div class="schedule-mini-row" ${targetAttr}>
                      ${agentAvatar(ag || { id: sch.agent_id }, { size: "lg" })}
                      <div class="host-main">
                        <div class="truncate host-name">${escapeHtml(sch.name)}</div>
                        <div class="host-sub truncate">${escapeHtml(ag?.name || sch.agent_id)}</div>
                      </div>
                      <div class="host-load">
                        <span class="status-dot ${scheduleStatusDotClass(sch)}"></span>
                        <span class="muted" style="font-size:11px">${sch.last_run_at ? formatRelativeTime(sch.last_run_at) : "待首报"}</span>
                      </div>
                    </div>
                  `;
                })
                .join("")}
            </div>`
          : `<div class="panel-empty">暂无已登记的定时任务</div>`
      }
    </section>
  `;
}

export function renderHomeView(container, refreshFn) {
  const s = store.state;
  if (!s) return;

  const agents = s.agents || [];
  const devices = s.devices || [];
  const tasks = s.tasks || [];
  const actions = s.pending_actions || [];
  const schedules = s.schedules || [];
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const cutoff24h = Date.now() - 86_400_000;
  const authCount = actions.filter((t) => t.state === "auth-required").length;
  const inputCount = actions.length - authCount;
  const activeTasks = tasks.filter((t) => isActiveTaskState(t.state));
  const failedTasks = tasks.filter((t) => isFailedTaskState(t.state));
  const completedTasks = tasks.filter((t) => t.state === "completed" || t.state === "canceled");

  const done24h = tasks.filter((t) => t.state === "completed" && Number(t.updated_at || t.created_at || 0) >= cutoff24h).length;
  const fail24h = tasks.filter((t) => isFailedTaskState(t.state) && Number(t.updated_at || t.created_at || 0) >= cutoff24h).length;

  const onlineDevices = devices.filter((d) => d.online).length;
  const onlineAgents = agents.filter((a) => a.online && a.enabled).length;
  const activeSlots = devices.reduce((sum, d) => sum + Number(d.active_count || 0), 0);
  const totalSlots = devices.filter((d) => d.enabled !== false).reduce((sum, d) => sum + Number(d.max_concurrent || 0), 0);

  const abnormalCount = schedules.filter(isAbnormalSchedule).length;
  const healthyCount = schedules.filter((sch) => sch.health === "healthy").length;
  const runningSchCount = schedules.filter((sch) => sch.health === "running").length;

  const taskFilter = store.homeTaskFilter || "all";
  const filteredTasks = tasks.filter((t) => {
    if (taskFilter === "active") return isActiveTaskState(t.state);
    if (taskFilter === "failed") return isFailedTaskState(t.state);
    if (taskFilter === "completed") return t.state === "completed" || t.state === "canceled";
    return true;
  });

  const TASK_FILTERS = [
    { id: "all", label: `全部 ${tasks.length}` },
    { id: "active", label: `进行中 ${activeTasks.length}` },
    { id: "failed", label: `失败`, errCount: failedTasks.length },
    { id: "completed", label: `已完成 ${completedTasks.length}` },
  ];

  container.innerHTML = `
    <section class="kpi-strip">
      <div class="kpi-cell" id="kpi-actions">
        <div class="kpi-cell-head">
          <span class="kpi-label-text">${uiIcon("inbox", 13)} 待我处理</span>
          <span class="status-dot ${actions.length ? "is-fail" : "is-ok"}"></span>
        </div>
        <div class="kpi-num ${actions.length ? "is-alert" : ""}">${actions.length}</div>
        <div class="kpi-meta">${actions.length ? `审批 ${authCount} · 追问 ${inputCount}` : "队列无阻塞"}</div>
      </div>

      <div class="kpi-cell" id="kpi-tasks">
        <div class="kpi-cell-head">
          <span class="kpi-label-text">${uiIcon("activity", 13)} 任务队列</span>
          <span class="status-dot ${activeTasks.length ? "is-run" : "is-idle"}"></span>
        </div>
        <div class="kpi-num">${activeTasks.length} <span class="kpi-num-unit">执行中</span></div>
        <div class="kpi-meta">24h 完成 ${done24h}${fail24h ? ` · 失败 ${fail24h}` : ""}</div>
      </div>

      <div class="kpi-cell" id="kpi-nodes">
        <div class="kpi-cell-head">
          <span class="kpi-label-text">${uiIcon("cpu", 13)} 节点与算力</span>
          <span class="status-dot ${onlineDevices ? "is-ok" : "is-idle"}"></span>
        </div>
        <div class="kpi-num">${onlineDevices}/${devices.length} <span class="kpi-num-unit">台在线</span></div>
        <div class="kpi-meta">Agent ${onlineAgents}/${agents.length} · 并发 ${activeSlots}/${totalSlots}</div>
      </div>

      <div class="kpi-cell" id="kpi-schedules">
        <div class="kpi-cell-head">
          <span class="kpi-label-text">${uiIcon("clock", 13)} 定时巡检</span>
          <span class="status-dot ${abnormalCount ? "is-fail" : schedules.length ? "is-ok" : "is-idle"}"></span>
        </div>
        <div class="kpi-num ${abnormalCount ? "is-alert" : ""}">
          ${abnormalCount ? `${abnormalCount} <span class="kpi-num-unit">异常</span>` : `${healthyCount}/${schedules.length}`}
        </div>
        <div class="kpi-meta">
          ${
            abnormalCount
              ? `共 ${schedules.length} 项定时任务`
              : runningSchCount
                ? `${runningSchCount} 运行中`
                : schedules.length
                  ? "巡检正常"
                  : "暂未登记"
          }
        </div>
      </div>
    </section>

    ${
      actions.length
        ? `<section id="home-actions-section" style="margin-bottom:18px">
            <div class="section-header" style="margin-top:0">
              <h2 class="section-title">待我处理 <span class="section-count">${actions.length}</span></h2>
            </div>
            <div class="action-list">${actions.map((t) => renderActionCard(t, agentMap)).join("")}</div>
          </section>`
        : ""
    }

    <div class="dashboard-grid">
      <div class="dashboard-main">
        <section class="panel">
          <div class="panel-head">
            <div class="row" style="gap:10px;flex-wrap:wrap">
              <h2 class="panel-title">${uiIcon("activity", 14)} 任务动态</h2>
              <div class="seg-control">
                ${TASK_FILTERS.map(
                  (item) => `
                  <button type="button" class="seg-btn ${taskFilter === item.id ? "active" : ""}" data-home-task-filter="${item.id}">
                    ${escapeHtml(item.label)}${item.errCount ? `<span class="seg-err-count">${item.errCount}</span>` : ""}
                  </button>
                `
                ).join("")}
              </div>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" id="home-goto-threads">全部线程 →</button>
          </div>
          ${renderTaskFeed(filteredTasks.slice(0, 12), agentMap)}
        </section>
      </div>

      <aside class="dashboard-side">
        ${renderNodeCapacityPanel(devices, agents)}
        ${renderScheduleSummaryPanel(schedules, agentMap)}
      </aside>
    </div>
  `;

  container.querySelector("#kpi-actions")?.addEventListener("click", () => {
    const actionsEl = container.querySelector("#home-actions-section");
    if (actionsEl) actionsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    else setState({ activeTab: "threads" });
  });
  container.querySelector("#kpi-tasks")?.addEventListener("click", () => setState({ activeTab: "threads" }));
  container.querySelector("#kpi-nodes")?.addEventListener("click", () => setState({ activeTab: "agents" }));
  container.querySelector("#kpi-schedules")?.addEventListener("click", () => {
    setState(abnormalCount > 0 ? { activeTab: "schedules", scheduleFilter: "abnormal" } : { activeTab: "schedules" });
  });

  container.querySelector("#home-goto-threads")?.addEventListener("click", () => setState({ activeTab: "threads" }));
  container.querySelector("#home-goto-agents")?.addEventListener("click", () => setState({ activeTab: "agents" }));
  container.querySelector("#home-goto-cloud")?.addEventListener("click", () => {
    setState({ activeTab: "agents", agentFilter: "cloud" });
  });
  container.querySelector("#home-goto-schedules")?.addEventListener("click", () => setState({ activeTab: "schedules" }));

  container.querySelectorAll("[data-goto-schedules]").forEach((el) => {
    el.addEventListener("click", () => setState({ activeTab: "schedules" }));
  });

  container.querySelectorAll("[data-focus-device]").forEach((el) => {
    el.addEventListener("click", () => {
      const devId = el.getAttribute("data-focus-device");
      const nextCollapsed = (store.collapsedDeviceIds || []).filter((id) => id !== devId);
      setState({
        activeTab: "agents",
        agentFilter: "all",
        collapsedDeviceIds: nextCollapsed,
        focusDeviceId: devId,
      });
    });
  });

  container.querySelectorAll("[data-home-task-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setState({ homeTaskFilter: btn.getAttribute("data-home-task-filter") });
    });
  });

  bindHomeEvents(container, refreshFn);
}

function bindHomeEvents(container, refreshFn) {
  container.querySelectorAll("[data-view-thread]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-cancel-task]") || e.target.closest(".attachment-bar")) return;
      setState({ activeTab: "threads", selectedThreadId: el.getAttribute("data-view-thread"), selectedThreadDetail: null });
    });
  });

  container.querySelectorAll("[data-cancel-task]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-cancel-task");
      try {
        await api.cancelTask(id, "机主在概览取消任务");
        showToast("任务已取消");
        await refreshFn();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  container.querySelectorAll("[data-decide-approve]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-decide-approve");
      const note = container.querySelector(`[data-auth-note="${CSS.escape(id)}"]`)?.value || "";
      try {
        await api.decideApproval(id, "approve", note);
        showToast("已使用 Hub 私钥签名放行");
        await refreshFn();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  container.querySelectorAll("[data-decide-deny]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-decide-deny");
      const note = container.querySelector(`[data-auth-note="${CSS.escape(id)}"]`)?.value || "机主拒绝";
      try {
        await api.decideApproval(id, "deny", note);
        showToast("已拒绝该任务");
        await refreshFn();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  container.querySelectorAll("[data-reply-form]").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = form.getAttribute("data-reply-form");
      const text = new FormData(form).get("reply");
      try {
        await api.replyTask(id, String(text || "").trim());
        showToast("回复已投递，任务恢复排队");
        await refreshFn();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  bindAttachmentPreview(container);
}
