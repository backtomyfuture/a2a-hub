import { api } from "../api.js";
import { setState, store } from "../state.js";
import {
  agentSourceLabel,
  escapeHtml,
  formatDateTime,
  formatDuration,
  formatInterval,
  formatRelativeTime,
  showToast,
  stateLabel,
} from "../utils.js";

const SCHEDULE_FILTERS = [
  { id: "all", label: "全部" },
  { id: "abnormal", label: "异常 / 超时" },
  { id: "running", label: "执行中" },
  { id: "healthy", label: "正常健康" },
  { id: "paused", label: "已暂停" },
];

let showCreatePanel = false;

function healthBadge(sch) {
  const h = sch.health || "idle";
  if (h === "paused") return `<span class="pill">已暂停</span>`;
  if (h === "running") return `<span class="pill pill-primary">执行中</span>`;
  if (h === "attention") return `<span class="pill pill-warning">待你介入</span>`;
  if (h === "missed") return `<span class="pill pill-danger">超时未报</span>`;
  if (h === "failing") return `<span class="pill pill-danger">上次失败</span>`;
  if (h === "healthy") return `<span class="pill pill-success">正常</span>`;
  return `<span class="pill">待首报</span>`;
}

function isAbnormal(sch) {
  return sch.health === "missed" || sch.health === "failing" || sch.health === "attention";
}

function runBarClass(state) {
  if (state === "completed") return "is-ok";
  if (state === "failed" || state === "rejected" || state === "canceled") return "is-fail";
  if (state === "input-required" || state === "auth-required") return "is-warn";
  if (state === "working" || state === "submitted") return "is-run";
  return "is-empty";
}

function renderSparkline(sch) {
  const runs = Array.isArray(sch.recent_runs) ? sch.recent_runs : [];
  const totalSlots = 10;
  const emptyCount = Math.max(0, totalSlots - runs.length);
  const bars = [];
  for (let i = 0; i < emptyCount; i++) {
    bars.push(`<span class="run-bar is-empty" title="暂无历史记录"></span>`);
  }
  for (const r of runs.slice(-totalSlots)) {
    const cls = runBarClass(r.state);
    const tip = `${formatDateTime(r.created_at)} · ${stateLabel(r.state)}${r.duration_ms != null ? ` (${formatDuration(r.duration_ms)})` : ""}${r.summary ? ` — ${r.summary.slice(0, 60)}` : ""}`;
    bars.push(
      `<button type="button" class="run-bar ${cls}" data-jump-thread="${escapeHtml(r.context_id)}" title="${escapeHtml(tip)}"></button>`
    );
  }
  return `<div class="run-sparkline" title="最近 ${totalSlots} 次执行轨迹（点击柱条跳对应线程）">${bars.join("")}</div>`;
}

function renderNextWindow(sch) {
  if (!sch.enabled) return `<span class="muted">已暂停巡检</span>`;
  if (!sch.last_run_at) return `<span class="muted">等待首次上报</span>`;
  if (sch.missed) {
    const overMin = Math.max(1, Math.round((sch.overdue_ms || 0) / 60_000));
    return `<span style="color:var(--danger);font-weight:600">已超时 ${overMin} 分钟未报</span>`;
  }
  if (sch.next_expected_at) {
    const diffMin = Math.round((Number(sch.next_expected_at) - Date.now()) / 60_000);
    if (diffMin <= 0) return `<span class="muted">即将触发</span>`;
    if (diffMin < 60) return `<span class="muted">约 ${diffMin} 分钟后</span>`;
    return `<span class="muted">约 ${Math.round(diffMin / 60)} 小时后</span>`;
  }
  return "";
}

function renderScheduleRow(sch) {
  const lastRun = sch.last_run;
  const snippet = lastRun?.error_message || lastRun?.summary || "";
  const rateText = sch.success_rate !== null && sch.success_rate !== undefined ? `${sch.success_rate}% 成功率` : "无终态样本";

  return `
    <div class="schedule-row ${isAbnormal(sch) ? "is-alert" : ""}">
      <div class="schedule-main">
        <div class="row" style="flex-wrap:wrap;gap:8px">
          ${healthBadge(sch)}
          <strong style="font-size:14px">${escapeHtml(sch.name)}</strong>
          ${sch.cron_expr ? `<span class="chip mono">${escapeHtml(sch.cron_expr)}</span>` : ""}
          <span class="chip">${escapeHtml(formatInterval(sch.interval_min))}</span>
          <span class="muted mono">${escapeHtml(sch.id)}</span>
        </div>

        ${sch.summary ? `<div class="muted" style="font-size:12px;margin-top:4px">${escapeHtml(sch.summary)}</div>` : ""}

        <div class="schedule-telemetry">
          <span>上次上报：<strong>${sch.last_run_at ? formatRelativeTime(sch.last_run_at) : "从未上报"}</strong></span>
          <span>耗时：${lastRun?.duration_ms != null ? formatDuration(lastRun.duration_ms) : "-"}</span>
          <span>${rateText}</span>
          <span>下次预期：${renderNextWindow(sch)}</span>
        </div>

        ${
          snippet
            ? `<div class="schedule-snippet ${lastRun?.error_message ? "is-err" : ""}">${escapeHtml(snippet)}</div>`
            : ""
        }
      </div>

      <div class="schedule-side">
        ${renderSparkline(sch)}
        <div class="row" style="justify-content:flex-end;flex-wrap:wrap">
          ${
            sch.last_context_id
              ? `<button type="button" class="btn btn-ghost btn-sm" data-jump-thread="${escapeHtml(sch.last_context_id)}">查看线程</button>`
              : ""
          }
          <button type="button" class="btn btn-secondary btn-sm" data-sch-run="${escapeHtml(sch.agent_id)}:::${escapeHtml(sch.id)}">立即触发</button>
          <button type="button" class="btn btn-secondary btn-sm" data-sch-toggle="${escapeHtml(sch.agent_id)}:::${escapeHtml(sch.id)}" data-sch-enabled="${sch.enabled ? "1" : "0"}">
            ${sch.enabled ? "暂停" : "启用"}
          </button>
          <button type="button" class="btn btn-danger btn-sm" data-sch-del="${escapeHtml(sch.agent_id)}:::${escapeHtml(sch.id)}">移除</button>
        </div>
      </div>
    </div>
  `;
}

function renderCreatePanel(agents) {
  if (!showCreatePanel) return "";
  return `
    <section class="card" id="new-schedule-panel" style="margin-bottom:18px">
      <div class="row-between" style="margin-bottom:10px">
        <h3 class="section-title" style="font-size:15px">在指定 Worker 下登记定时任务</h3>
        <button type="button" class="btn btn-ghost btn-sm" id="btn-close-new-sch">收起</button>
      </div>
      <form id="form-create-schedule" class="stack-md">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px">
          <label class="field">
            <span>挂载目标 Agent / Worker *</span>
            <select name="agent_id" required>
              ${agents.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)} (${escapeHtml(a.id)})</option>`).join("")}
            </select>
          </label>
          <label class="field">
            <span>任务名称 *</span>
            <input type="text" name="name" placeholder="例如：每日代码仓库巡检" required />
          </label>
          <label class="field">
            <span>英文 ID（可选）</span>
            <input type="text" name="id" placeholder="daily-audit" />
          </label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 2fr;gap:10px">
          <label class="field">
            <span>Cron 表达式（展示用）</span>
            <input type="text" name="cron_expr" placeholder="0 9 * * *" />
          </label>
          <label class="field">
            <span>心跳间隔（分钟）*</span>
            <input type="number" name="interval_min" min="1" max="10080" value="60" required />
          </label>
          <label class="field">
            <span>定时任务目标说明（若勾选立即触发将作为派单正文）</span>
            <input type="text" name="summary" placeholder="每天早上检查未合并 PR 与失败单测" />
          </label>
        </div>
        <div class="row-between">
          <label class="row" style="font-size:12px;cursor:pointer">
            <input type="checkbox" name="run" value="1" />
            <span>登记同时立即下发执行一次</span>
          </label>
          <button type="submit" class="btn btn-primary btn-sm" ${agents.length ? "" : "disabled"}>保存定时条目</button>
        </div>
      </form>
    </section>
  `;
}

export function renderSchedulesView(container, refreshFn) {
  const s = store.state;
  if (!s) return;

  const schedules = s.schedules || [];
  const agents = s.agents || [];
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const totalCount = schedules.length;
  const workerCount = new Set(schedules.map((x) => x.agent_id)).size;
  const healthyCount = schedules.filter((x) => x.health === "healthy" || x.health === "running").length;
  const abnormalCount = schedules.filter((x) => isAbnormal(x)).length;
  const pausedOrIdleCount = schedules.filter((x) => x.health === "paused" || x.health === "idle").length;

  const filter = store.scheduleFilter || "all";
  const query = String(store.scheduleSearch || "").trim().toLowerCase();

  const filtered = schedules.filter((sch) => {
    if (filter === "abnormal" && !isAbnormal(sch)) return false;
    if (filter === "running" && sch.health !== "running") return false;
    if (filter === "healthy" && sch.health !== "healthy") return false;
    if (filter === "paused" && sch.health !== "paused") return false;
    if (query) {
      const hay = `${sch.name} ${sch.id} ${sch.agent_name} ${sch.agent_id} ${sch.summary}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  // 按挂载 Worker 分组，异常任务所在组优先置顶
  const groupMap = new Map();
  for (const sch of filtered) {
    let g = groupMap.get(sch.agent_id);
    if (!g) {
      const ag = agentMap.get(sch.agent_id);
      g = {
        agent_id: sch.agent_id,
        agent: ag,
        agent_name: ag?.name || sch.agent_name || sch.agent_id,
        online: Boolean(ag?.online),
        enabled: ag ? Boolean(ag.enabled) : true,
        source: ag ? agentSourceLabel(ag) : sch.agent_device_name || "独立 Agent",
        items: [],
        abnormal_count: 0,
      };
      groupMap.set(sch.agent_id, g);
    }
    if (isAbnormal(sch)) g.abnormal_count += 1;
    g.items.push(sch);
  }
  const groups = [...groupMap.values()].sort((a, b) => b.abnormal_count - a.abnormal_count || a.agent_name.localeCompare(b.agent_name));

  container.innerHTML = `
    <section class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">已挂载定时任务</div>
        <div class="kpi-val">${totalCount} <span class="muted" style="font-size:13px">· 分布在 ${workerCount} 个 Worker</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">正常健康 / 执行中</div>
        <div class="kpi-val" style="color:var(--success)">${healthyCount}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">异常 / 超时未报</div>
        <div class="kpi-val" style="color:${abnormalCount ? "var(--danger)" : "var(--text)"}">${abnormalCount}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">已暂停 / 待首报</div>
        <div class="kpi-val">${pausedOrIdleCount}</div>
      </div>
    </section>

    <div class="section-header" style="margin-top:0">
      <div class="filter-bar">
        ${SCHEDULE_FILTERS.map(
          (item) => `
          <button class="filter-chip ${filter === item.id ? "active" : ""}" data-sch-filter="${item.id}">${item.label}</button>
        `
        ).join("")}
      </div>
      <div class="row" style="flex-wrap:wrap">
        <input type="text" id="sch-search-input" value="${escapeHtml(store.scheduleSearch || "")}" placeholder="搜索任务名或 Worker..." style="width:200px" />
        <button type="button" class="btn btn-primary btn-sm" id="btn-toggle-new-sch">+ 登记定时任务</button>
      </div>
    </div>

    ${renderCreatePanel(agents)}

    ${
      groups.length
        ? `<div class="stack-md">
            ${groups
              .map(
                (g) => `
              <section class="card schedule-group" style="padding:0;overflow:hidden">
                <header class="schedule-group-head row-between">
                  <div class="row" style="min-width:0;flex-wrap:wrap">
                    <span class="dot ${!g.enabled ? "dot-paused" : g.online ? "dot-online" : "dot-offline"}"></span>
                    <button type="button" class="btn btn-ghost btn-sm" style="padding:2px 6px;font-weight:700;font-size:14px;color:var(--text)" data-open-agent="${escapeHtml(g.agent_id)}">
                      ${escapeHtml(g.agent_name)}
                    </button>
                    <span class="muted mono">${escapeHtml(g.agent_id)}</span>
                    <span class="pill">${escapeHtml(g.source)}</span>
                  </div>
                  <div class="row">
                    ${g.abnormal_count ? `<span class="pill pill-danger">${g.abnormal_count} 项异常</span>` : `<span class="pill pill-success">全正常</span>`}
                    <span class="muted" style="font-size:12px">${g.items.length} 个定时</span>
                  </div>
                </header>
                <div class="schedule-group-body">
                  ${g.items.map(renderScheduleRow).join("")}
                </div>
              </section>
            `
              )
              .join("")}
          </div>`
        : `<div class="empty-box">
            <div style="font-weight:600;margin-bottom:6px">${schedules.length ? "当前筛选下暂无定时任务" : "暂无定时自报任务"}</div>
            <div style="font-size:12px;margin-bottom:14px">
              各 Worker 或云端 Agent 可通过 <code>PUT /api/v1/agents/&lt;id&gt;/schedules/&lt;sid&gt;</code> 自动向中台登记与续报心跳，也可由你手动登记观测条目。
            </div>
            ${!schedules.length ? `<button type="button" class="btn btn-primary btn-sm" id="btn-empty-new-sch">+ 登记一条定时任务</button>` : ""}
          </div>`
    }
  `;

  container.querySelectorAll("[data-sch-filter]").forEach((btn) => {
    btn.addEventListener("click", () => setState({ scheduleFilter: btn.getAttribute("data-sch-filter") }));
  });

  const searchInput = container.querySelector("#sch-search-input");
  searchInput?.addEventListener("input", (e) => {
    store.scheduleSearch = e.target.value;
    renderSchedulesView(container, refreshFn);
    const nextInput = container.querySelector("#sch-search-input");
    if (nextInput) {
      nextInput.focus();
      nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
    }
  });

  const toggleCreate = (open) => {
    showCreatePanel = open;
    renderSchedulesView(container, refreshFn);
  };
  container.querySelector("#btn-toggle-new-sch")?.addEventListener("click", () => toggleCreate(!showCreatePanel));
  container.querySelector("#btn-empty-new-sch")?.addEventListener("click", () => toggleCreate(true));
  container.querySelector("#btn-close-new-sch")?.addEventListener("click", () => toggleCreate(false));

  container.querySelector("#form-create-schedule")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const agentId = String(fd.get("agent_id") || "").trim();
    const name = String(fd.get("name") || "").trim();
    const rawId = String(fd.get("id") || "").trim();
    const schId =
      rawId ||
      name
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "") ||
      `sch-${Date.now()}`;
    try {
      await api.upsertSchedule(agentId, schId, {
        name,
        cron_expr: String(fd.get("cron_expr") || "").trim(),
        interval_min: Number(fd.get("interval_min") || 60),
        summary: String(fd.get("summary") || "").trim(),
        run: Boolean(fd.get("run")),
        enabled: true,
      });
      showCreatePanel = false;
      showToast("已登记定时任务");
      await refreshFn();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  container.querySelectorAll("[data-open-agent]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setState({ selectedAgentId: btn.getAttribute("data-open-agent"), showSettingsDrawer: false });
    });
  });

  container.querySelectorAll("[data-jump-thread]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setState({ activeTab: "threads", selectedThreadId: btn.getAttribute("data-jump-thread"), selectedThreadDetail: null });
    });
  });

  container.querySelectorAll("[data-sch-run]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const [agentId, schId] = btn.getAttribute("data-sch-run").split(":::");
      const target = schedules.find((x) => x.agent_id === agentId && x.id === schId);
      if (!target) return;
      try {
        await api.upsertSchedule(agentId, schId, {
          name: target.name,
          cron_expr: target.cron_expr,
          interval_min: target.interval_min,
          summary: target.summary,
          enabled: true,
          run: true,
        });
        showToast(`已触发「${target.name}」派单执行`);
        await refreshFn();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  container.querySelectorAll("[data-sch-toggle]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const [agentId, schId] = btn.getAttribute("data-sch-toggle").split(":::");
      const cur = btn.getAttribute("data-sch-enabled") === "1";
      const target = schedules.find((x) => x.agent_id === agentId && x.id === schId);
      if (!target) return;
      try {
        await api.upsertSchedule(agentId, schId, {
          name: target.name,
          cron_expr: target.cron_expr,
          interval_min: target.interval_min,
          summary: target.summary,
          enabled: !cur,
        });
        showToast(cur ? "已暂停该定时监测" : "已恢复定时监测");
        await refreshFn();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  container.querySelectorAll("[data-sch-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const [agentId, schId] = btn.getAttribute("data-sch-del").split(":::");
      if (!confirm(`确认从观测列表中移除定时任务「${schId}」吗？`)) return;
      try {
        await api.deleteSchedule(agentId, schId);
        showToast("已移除定时任务");
        await refreshFn();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}
