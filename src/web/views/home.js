import { api } from "../api.js";
import { setState, store } from "../state.js";
import { escapeHtml, formatRelativeTime, showToast, stateLabel, stateTone } from "../utils.js";

function isActiveTaskState(state) {
  return state === "working" || state === "submitted" || state === "input-required" || state === "auth-required";
}

function isFailedTaskState(state) {
  return state === "failed" || state === "rejected";
}

function isAbnormalSchedule(sch) {
  return sch.health === "missed" || sch.health === "failing" || sch.health === "attention";
}

function miniScheduleBadge(sch) {
  const h = sch.health || "idle";
  if (h === "paused") return `<span class="pill">已暂停</span>`;
  if (h === "running") return `<span class="pill pill-primary">运行中</span>`;
  if (h === "attention") return `<span class="pill pill-warning">待介入</span>`;
  if (h === "missed") return `<span class="pill pill-danger">超时</span>`;
  if (h === "failing") return `<span class="pill pill-danger">失败</span>`;
  if (h === "healthy") return `<span class="pill pill-success">正常</span>`;
  return `<span class="pill">待首报</span>`;
}

function renderActionCard(task) {
  const isAuth = task.state === "auth-required";
  const msgs = task.messages || [];
  const lastMsg = [...msgs].reverse().find((m) => m.kind === (isAuth ? "auth_request" : "question"));
  const promptText = lastMsg?.body || task.title;

  return `
    <div class="action-card ${isAuth ? "is-auth" : ""}">
      <div class="row-between">
        <div class="row" style="flex-wrap:wrap">
          <span class="pill ${stateTone(task.state)}">${stateLabel(task.state)}</span>
          <strong>${escapeHtml(task.title)}</strong>
          <span class="muted">· 指派给 ${escapeHtml(task.to_agent_id)}</span>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" data-view-thread="${escapeHtml(task.context_id)}">查看线程</button>
      </div>
      <div class="msg-body">${escapeHtml(promptText)}</div>
      ${
        isAuth
          ? `<div class="row-between" style="flex-wrap:wrap">
              <input type="text" placeholder="可选审批备注..." data-auth-note="${escapeHtml(task.id)}" style="max-width:340px" />
              <div class="row">
                <button type="button" class="btn btn-sm btn-danger" data-decide-deny="${escapeHtml(task.id)}">拒绝</button>
                <button type="button" class="btn btn-sm btn-primary" data-decide-approve="${escapeHtml(task.id)}">签名并放行</button>
              </div>
            </div>`
          : `<form class="row" data-reply-form="${escapeHtml(task.id)}">
              <input type="text" name="reply" placeholder="输入补充说明并恢复执行..." required />
              <button type="submit" class="btn btn-sm btn-primary" style="white-space:nowrap">发送回复</button>
            </form>`
      }
    </div>
  `;
}

function renderTaskFeed(tasks, agentMap) {
  if (!tasks.length) {
    return `<div class="empty-box" style="padding:22px">当前筛选条件下暂无任务动态。</div>`;
  }
  return `
    <div class="card task-feed" style="padding:0">
      ${tasks
        .map((t) => {
          const ag = agentMap.get(t.to_agent_id);
          const agentLabel = ag?.device_name ? `${ag.device_name} · ${ag.name}` : ag?.name || t.to_agent_id;
          const snippet = t.error_message || t.receipt?.summary || "";
          const canCancel = t.state === "working" || t.state === "submitted";

          return `
            <div class="task-feed-row" data-view-thread="${escapeHtml(t.context_id)}">
              <div class="row-between" style="gap:10px">
                <div class="row" style="min-width:0;flex:1">
                  <span class="pill ${stateTone(t.state)}">${stateLabel(t.state)}</span>
                  <strong class="truncate">${escapeHtml(t.title)}</strong>
                </div>
                <div class="row" style="flex-shrink:0">
                  <span class="muted" style="font-size:12px">${formatRelativeTime(t.updated_at)}</span>
                  ${
                    canCancel
                      ? `<button type="button" class="btn btn-ghost btn-sm" data-cancel-task="${escapeHtml(t.id)}">取消</button>`
                      : ""
                  }
                </div>
              </div>
              <div class="muted" style="font-size:12px;margin-top:4px">
                执行方：${escapeHtml(agentLabel)} · 发起方：${escapeHtml(t.from_node || "-")}
              </div>
              ${
                snippet
                  ? `<div class="task-snippet ${t.error_message ? "is-err" : ""}">${escapeHtml(snippet)}</div>`
                  : ""
              }
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

  if (!sortedDevices.length && !cloudAgents.length) {
    return `
      <div class="card">
        <div class="row-between" style="margin-bottom:10px">
          <h3 class="section-title" style="font-size:15px">节点负载</h3>
          <button type="button" class="btn btn-ghost btn-sm" id="home-goto-agents">管理全部 →</button>
        </div>
        <div class="muted" style="font-size:12px">
          暂未挂载电脑或独立 Agent，请点击右上角「+ 接入 Agent / 电脑」开始配置。
        </div>
      </div>
    `;
  }

  return `
    <div class="card">
      <div class="row-between" style="margin-bottom:10px">
        <h3 class="section-title" style="font-size:15px">节点负载</h3>
        <button type="button" class="btn btn-ghost btn-sm" id="home-goto-agents">管理全部 →</button>
      </div>
      <div class="stack-sm">
        ${sortedDevices
          .map((d) => {
            const devWorkers = agents.filter((a) => a.kind === "device-worker" && a.device_id === d.id);
            const devOnline = devWorkers.filter((a) => a.online && a.enabled).length;
            const used = Number(d.active_count || 0);
            const cap = Math.max(Number(d.max_concurrent || 1), 1);
            const pct = Math.min(100, Math.round((used / cap) * 100));
            const dotCls = !d.enabled ? "dot-paused" : d.online ? "dot-online" : "dot-offline";
            return `
              <div class="host-row" data-focus-device="${escapeHtml(d.id)}">
                <div class="row-between">
                  <div class="row" style="min-width:0">
                    <span class="dot ${dotCls}"></span>
                    <strong class="truncate">${escapeHtml(d.name || d.id)}</strong>
                    ${d.is_local ? `<span class="pill pill-primary">本机</span>` : ""}
                  </div>
                  <span class="muted mono">${used}/${cap} 并发</span>
                </div>
                <div class="cap-bar">
                  <div class="cap-bar-fill ${pct >= 80 ? "is-warn" : used > 0 ? "is-busy" : ""}" style="width:${pct}%"></div>
                </div>
                <div class="muted" style="font-size:11px">
                  在线 Worker ${devOnline}/${devWorkers.length} · 心跳 ${formatRelativeTime(d.last_seen_at)}
                </div>
              </div>
            `;
          })
          .join("")}
        ${
          cloudAgents.length
            ? `<div class="host-row" id="home-goto-cloud">
                <div class="row-between">
                  <strong>独立 / 云端 Agent</strong>
                  <span class="pill">${cloudOnline}/${cloudAgents.length} 在线</span>
                </div>
              </div>`
            : ""
        }
      </div>
    </div>
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
    <div class="card">
      <div class="row-between" style="margin-bottom:10px">
        <h3 class="section-title" style="font-size:15px">定时巡检</h3>
        <button type="button" class="btn btn-ghost btn-sm" id="home-goto-schedules">查看全部 →</button>
      </div>
      ${
        topSchedules.length
          ? `<div class="stack-sm">
              ${topSchedules
                .map((sch) => {
                  const ag = agentMap.get(sch.agent_id);
                  const targetAttr = sch.last_context_id
                    ? `data-view-thread="${escapeHtml(sch.last_context_id)}"`
                    : `data-goto-schedules="1"`;
                  return `
                    <div class="schedule-mini-row" ${targetAttr}>
                      <div class="row-between" style="gap:8px">
                        <div class="row" style="min-width:0;flex:1">
                          ${miniScheduleBadge(sch)}
                          <strong class="truncate" style="font-size:13px">${escapeHtml(sch.name)}</strong>
                        </div>
                        <span class="muted" style="font-size:11px;flex-shrink:0">
                          ${sch.last_run_at ? formatRelativeTime(sch.last_run_at) : "待首报"}
                        </span>
                      </div>
                      <div class="muted truncate" style="font-size:11px;margin-top:3px">
                        ${escapeHtml(ag?.name || sch.agent_id)}
                      </div>
                    </div>
                  `;
                })
                .join("")}
            </div>`
          : `<div class="muted" style="font-size:12px">暂无已登记的定时任务</div>`
      }
    </div>
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
    { id: "all", label: `全部 (${tasks.length})` },
    { id: "active", label: `进行中 (${activeTasks.length})` },
    { id: "failed", label: `失败 (${failedTasks.length})` },
    { id: "completed", label: `已完成 (${completedTasks.length})` },
  ];

  container.innerHTML = `
    <section class="kpi-grid">
      <div class="kpi-card is-clickable" id="kpi-actions">
        <div class="kpi-label">待我处理</div>
        <div class="kpi-val" style="color:${actions.length ? "var(--danger)" : "var(--text)"}">${actions.length}</div>
        <div class="kpi-sub">${actions.length ? `审批 ${authCount} · 追问 ${inputCount}` : "队列无阻塞"}</div>
      </div>

      <div class="kpi-card is-clickable" id="kpi-tasks">
        <div class="kpi-label">任务队列</div>
        <div class="kpi-val">${activeTasks.length} <span class="muted" style="font-size:13px;font-weight:500">执行中</span></div>
        <div class="kpi-sub">近 24h 完成 ${done24h} · 失败 ${fail24h}</div>
      </div>

      <div class="kpi-card is-clickable" id="kpi-nodes">
        <div class="kpi-label">节点与算力</div>
        <div class="kpi-val">${onlineDevices}<span class="muted" style="font-size:14px"> / ${devices.length}</span></div>
        <div class="kpi-sub">Agent ${onlineAgents}/${agents.length} · 并发 ${activeSlots}/${totalSlots}</div>
      </div>

      <div class="kpi-card is-clickable" id="kpi-schedules">
        <div class="kpi-label">定时巡检</div>
        <div class="kpi-val" style="color:${abnormalCount ? "var(--danger)" : "var(--text)"}">
          ${abnormalCount ? `${abnormalCount} <span style="font-size:13px;font-weight:500">异常</span>` : `${healthyCount}<span class="muted" style="font-size:14px"> / ${schedules.length}</span>`}
        </div>
        <div class="kpi-sub">
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

    <div class="dashboard-grid">
      <div class="dashboard-main">
        <section id="home-actions-section">
          ${
            actions.length
              ? `
                <div class="section-header" style="margin-top:0">
                  <h2 class="section-title">待我处理 (${actions.length})</h2>
                </div>
                <div class="action-list">${actions.map(renderActionCard).join("")}</div>
              `
              : `<div class="all-clear-bar">✓ 队列运转平稳，当前没有需要审批或回复的阻塞任务</div>`
          }
        </section>

        <section>
          <div class="section-header">
            <h2 class="section-title">任务动态</h2>
            <div class="row" style="flex-wrap:wrap">
              <div class="filter-bar">
                ${TASK_FILTERS.map(
                  (item) => `
                  <button type="button" class="filter-chip ${taskFilter === item.id ? "active" : ""}" data-home-task-filter="${item.id}">
                    ${escapeHtml(item.label)}
                  </button>
                `
                ).join("")}
              </div>
              <button type="button" class="btn btn-ghost btn-sm" id="home-goto-threads">全部线程 →</button>
            </div>
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
    container.querySelector("#home-actions-section")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
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
      if (e.target.closest("[data-cancel-task]")) return;
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
}
