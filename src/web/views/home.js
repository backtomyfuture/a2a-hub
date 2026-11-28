import { api } from "../api.js";
import { agentAvatar, agentStatusOf, deviceAvatar, deviceStatusOf, uiIcon } from "../icons.js";
import { setState, store } from "../state.js";
import {
  bindAttachmentPreview,
  escapeHtml,
  formatRelativeTime,
  renderAttachmentsBar,
  showToast,
  sortAgentsForDisplay,
  sortDevicesForDisplay,
  stateLabel,
  stateTone,
} from "../utils.js";

function isActiveTaskState(state) {
  return state === "working" || state === "submitted" || state === "input-required" || state === "auth-required";
}

function isFailedTaskState(state) {
  return state === "failed" || state === "rejected";
}

function isUnresolvedFailedTask(t) {
  return Boolean(t && isFailedTaskState(t.state) && !t.resolved_at);
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
              <button type="button" class="btn btn-sm btn-danger" data-cancel-task="${escapeHtml(task.id)}">${uiIcon("x", 12)} 取消</button>
              <button type="submit" class="btn btn-sm btn-primary">${uiIcon("send", 12)} 发送回复</button>
            </form>`
      }
    </div>
  `;
}

function shortDuration(ms) {
  const sec = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return min % 60 ? `${hr}h ${min % 60}m` : `${hr}h`;
}

function taskRunMs(t) {
  const start = Number(t.claimed_at || t.created_at || 0);
  const end = Number(t.completed_at || t.updated_at || 0);
  return start && end >= start ? end - start : null;
}

// 看板关注「此刻」：进行中显示已运行时长，完成显示耗时，失败显示发生时间
function taskTimeCell(t, now) {
  if (t.state === "working") return { text: `已运行 ${shortDuration(now - Number(t.claimed_at || t.created_at))}`, title: "开始执行至今" };
  if (t.state === "submitted") return { text: `排队 ${shortDuration(now - Number(t.created_at))}`, title: "进入队列至今" };
  if (t.state === "completed") {
    const ms = taskRunMs(t);
    return { text: ms === null ? formatRelativeTime(t.updated_at) : `耗时 ${shortDuration(ms)}`, title: `完成于 ${formatRelativeTime(t.completed_at || t.updated_at)}` };
  }
  return { text: formatRelativeTime(t.updated_at), title: formatRelativeTime(t.updated_at) };
}

function renderTaskFeed(tasks, agentMap, emptyText) {
  if (!tasks.length) {
    return `<div class="panel-empty board-empty">${uiIcon("check", 16)}<span>${escapeHtml(emptyText)}</span></div>`;
  }
  const now = Date.now();
  return `
    <div class="task-feed">
      ${tasks
        .map((t) => {
          const ag = agentMap.get(t.to_agent_id);
          const agentLabel = ag?.device_name ? `${ag.device_name} / ${ag.name}` : ag?.name || t.to_agent_id;
          const isErr = Boolean(t.error_message) || isFailedTaskState(t.state);
          const excerpt = cleanExcerpt(t.error_message || t.receipt?.summary || "");
          const canCancel = t.state === "working" || t.state === "submitted";
          const canHandleFail = isUnresolvedFailedTask(t);
          const fromSuffix = t.from_node && t.from_node !== "owner" ? ` ← ${t.from_node}` : "";
          const attCount = Number.isFinite(Number(t.attachment_count))
            ? Number(t.attachment_count)
            : (t.attachments?.length || 0) + (t.receipt?.attachments?.length || 0);
          const time = taskTimeCell(t, now);

          // 固定列网格：状态 / 时间 / 操作三列定宽，避免有无按钮时时间列左右跳动
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
              <span class="task-time" title="${escapeHtml(time.title)}">${escapeHtml(time.text)}</span>
              <span class="task-action">${
                canCancel
                  ? `<button type="button" class="btn btn-ghost btn-sm btn-icon" data-cancel-task="${escapeHtml(t.id)}" title="取消任务" aria-label="取消任务">${uiIcon("x", 13)}</button>`
                  : canHandleFail
                    ? `<button type="button" class="btn btn-ghost btn-sm btn-icon" data-retry-task="${escapeHtml(t.id)}" title="重试任务" aria-label="重试任务">${uiIcon("retry", 13)}</button><button type="button" class="btn btn-ghost btn-sm btn-icon" data-resolve-task="${escapeHtml(t.id)}" title="标为已处理（消红）" aria-label="标为已处理">${uiIcon("check", 13)}</button>`
                    : ""
              }</span>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderThroughputPanel(tasks, agentMap) {
  const now = Date.now();
  const HOUR = 3_600_000;
  const endHour = Math.floor(now / HOUR) * HOUR + HOUR;
  const startMs = endHour - 24 * HOUR;
  const buckets = Array.from({ length: 24 }, () => ({ ok: 0, fail: 0 }));
  const perAgent = new Map();
  const durations = [];
  let ok = 0;
  let fail = 0;

  for (const t of tasks) {
    const isOk = t.state === "completed";
    const isFail = isUnresolvedFailedTask(t);
    if (!isOk && !isFail) continue;
    const at = Number(t.completed_at || t.updated_at || 0);
    if (at < startMs) continue;
    const idx = Math.min(23, Math.floor((at - startMs) / HOUR));
    if (isOk) {
      ok += 1;
      buckets[idx].ok += 1;
      const ms = taskRunMs(t);
      if (ms !== null) durations.push(ms);
    } else {
      fail += 1;
      buckets[idx].fail += 1;
    }
    const rec = perAgent.get(t.to_agent_id) || { ok: 0, fail: 0 };
    rec[isOk ? "ok" : "fail"] += 1;
    perAgent.set(t.to_agent_id, rec);
  }

  const total = ok + fail;
  const max = Math.max(1, ...buckets.map((b) => b.ok + b.fail));
  durations.sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : null;
  const topAgents = [...perAgent.entries()].sort((a, b) => b[1].ok + b[1].fail - (a[1].ok + a[1].fail)).slice(0, 3);
  const hourLabel = (i) => String(new Date(startMs + i * HOUR).getHours()).padStart(2, "0") + ":00";

  return `
    <section class="panel">
      <div class="panel-head">
        <h3 class="panel-title">${uiIcon("activity", 14)} 近 24 小时</h3>
        <div class="tp-metrics">
          <span><strong>${ok}</strong> 完成</span>
          <span class="${fail ? "is-fail" : ""}" title="仅统计尚未标为已处理的失败"><strong>${fail}</strong> 未处理失败</span>
          <span><strong>${total ? Math.round((ok / total) * 100) : "-"}${total ? "%" : ""}</strong> 成功率</span>
          <span><strong>${median === null ? "-" : shortDuration(median)}</strong> 中位耗时</span>
        </div>
      </div>
      ${
        total
          ? `<div class="tp-body">
              <div class="tp-chart">
                <div class="tp-bars">
                  ${buckets
                    .map((b, i) => {
                      const n = b.ok + b.fail;
                      const h = n ? Math.max(8, Math.round((n / max) * 100)) : 0;
                      return `<div class="tp-col" title="${hourLabel(i)} · 完成 ${b.ok} · 失败 ${b.fail}">
                        <div class="tp-stack" style="height:${h}%">
                          ${b.fail ? `<span class="tp-fail" style="flex:${b.fail}"></span>` : ""}
                          ${b.ok ? `<span class="tp-ok" style="flex:${b.ok}"></span>` : ""}
                        </div>
                      </div>`;
                    })
                    .join("")}
                </div>
                <div class="tp-axis"><span>${hourLabel(0)}</span><span>${hourLabel(8)}</span><span>${hourLabel(16)}</span><span>现在</span></div>
              </div>
              <div class="tp-top">
                <div class="tp-top-title">最活跃</div>
                ${topAgents
                  .map(([id, rec]) => {
                    const ag = agentMap.get(id);
                    return `<div class="tp-top-row" title="完成 ${rec.ok} · 失败 ${rec.fail}">
                      ${agentAvatar(ag || { id }, { size: "sm" })}
                      <span class="truncate">${escapeHtml(ag?.name || id)}</span>
                      <span class="tp-top-num">${rec.ok + rec.fail}${rec.fail ? `<span class="is-fail"> · ${rec.fail}✕</span>` : ""}</span>
                    </div>`;
                  })
                  .join("")}
              </div>
            </div>`
          : `<div class="panel-empty">近 24 小时还没有结束的任务</div>`
      }
    </section>
  `;
}
function renderNodeCapacityPanel(devices, allAgents) {
  const agents = sortAgentsForDisplay(allAgents);
  const cloudAgents = agents.filter((a) => a.kind !== "device-worker");
  const cloudOnline = cloudAgents.filter((a) => a.online && a.enabled).length;
  const sortedDevices = sortDevicesForDisplay(devices);

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
      return Number(b.last_tick_at || b.last_run_at || 0) - Number(a.last_tick_at || a.last_run_at || 0);
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
                  const jumpCtx = sch.driver === "hub" ? sch.last_context_id : sch.last_run?.context_id;
                  const targetAttr = jumpCtx
                    ? `data-view-thread="${escapeHtml(jumpCtx)}"`
                    : `data-goto-schedules="1"`;
                  const lastAt = sch.last_tick_at || sch.last_run_at;
                  const timeText = lastAt ? formatRelativeTime(lastAt) : (sch.driver === "hub" ? "待触发" : "待首报");
                  return `
                    <div class="schedule-mini-row" ${targetAttr}>
                      ${agentAvatar(ag || { id: sch.agent_id }, { size: "lg" })}
                      <div class="host-main">
                        <div class="truncate host-name">${escapeHtml(sch.name)}</div>
                        <div class="host-sub truncate">${escapeHtml(ag?.name || sch.agent_id)}</div>
                      </div>
                      <div class="host-load">
                        <span class="status-dot ${scheduleStatusDotClass(sch)}"></span>
                        <span class="muted" style="font-size:11px">${escapeHtml(timeText)}</span>
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
  const failedTasks = tasks.filter(isUnresolvedFailedTask);

  const done24h = tasks.filter((t) => t.state === "completed" && Number(t.updated_at || t.created_at || 0) >= cutoff24h).length;
  const fail24h = failedTasks.filter((t) => Number(t.updated_at || t.created_at || 0) >= cutoff24h).length;

  const onlineDevices = devices.filter((d) => d.online).length;
  const onlineAgents = agents.filter((a) => a.online && a.enabled).length;
  const activeSlots = devices.reduce((sum, d) => sum + Number(d.active_count || 0), 0);
  const totalSlots = devices.filter((d) => d.enabled !== false).reduce((sum, d) => sum + Number(d.max_concurrent || 0), 0);

  const abnormalCount = schedules.filter(isAbnormalSchedule).length;
  const healthyCount = schedules.filter((sch) => sch.health === "healthy" || sch.health === "running").length;
  const runningSchCount = schedules.filter((sch) => sch.health === "running").length;

  // 首页只回答「此刻要关注什么」；按线程翻历史交给「对话线程」页。待我处理的任务已在上方卡片展示，看板不再重复
  const runningTasks = tasks.filter((t) => t.state === "working" || t.state === "submitted");
  const recentFailed = failedTasks.filter((t) => Number(t.updated_at || 0) >= cutoff24h);
  const recentDone = tasks
    .filter((t) => t.state === "completed" && Number(t.completed_at || t.updated_at || 0) >= cutoff24h)
    .sort((a, b) => Number(b.completed_at || b.updated_at) - Number(a.completed_at || a.updated_at));

  const BOARD_FILTERS = [
    { id: "running", label: `进行中 ${runningTasks.length}`, items: runningTasks, empty: "没有正在执行或排队的任务" },
    { id: "failed", label: `失败`, errCount: recentFailed.length, items: recentFailed, empty: "近 24 小时没有失败的任务" },
    { id: "done", label: `最近完成 ${recentDone.length}`, items: recentDone, empty: "近 24 小时还没有完成的任务" },
  ];
  const boardFilter = BOARD_FILTERS.find((f) => f.id === store.homeTaskFilter) || (runningTasks.length ? BOARD_FILTERS[0] : recentFailed.length ? BOARD_FILTERS[1] : BOARD_FILTERS[2]);
  const BOARD_LIMIT = 8;
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
        <div class="kpi-meta">24h 完成 ${done24h}${fail24h ? ` · 未处理失败 ${fail24h}` : ""}</div>
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
        ${renderThroughputPanel(tasks, agentMap)}
        <section class="panel">
          <div class="panel-head">
            <div class="row" style="gap:10px;flex-wrap:nowrap;min-width:0">
              <h2 class="panel-title">${uiIcon("cpu", 14)} 执行看板</h2>
              <div class="seg-control">
                ${BOARD_FILTERS.map(
                  (item) => `
                  <button type="button" class="seg-btn ${boardFilter.id === item.id ? "active" : ""}" data-home-task-filter="${item.id}">
                    ${escapeHtml(item.label)}${item.errCount ? `<span class="seg-err-count">${item.errCount}</span>` : ""}
                  </button>
                `
                ).join("")}
              </div>
            </div>
            <div class="row" style="gap:6px;flex-shrink:0">
              ${
                boardFilter.id === "failed" && recentFailed.length > 0
                  ? `<button type="button" class="btn btn-ghost btn-sm" id="home-resolve-all-failed" data-resolve-since="${cutoff24h}" data-resolve-count="${recentFailed.length}" title="将近 24 小时内的未处理失败标为已处理">${uiIcon("check", 12)} 全部已处理</button>`
                  : ""
              }
              <button type="button" class="btn btn-ghost btn-sm" id="home-goto-threads">历史线程 →</button>
            </div>
          </div>
          ${renderTaskFeed(boardFilter.items.slice(0, BOARD_LIMIT), agentMap, boardFilter.empty)}
          ${
            boardFilter.items.length > BOARD_LIMIT
              ? `<button type="button" class="board-more" id="home-board-more">还有 ${boardFilter.items.length - BOARD_LIMIT} 个，去对话线程查看 →</button>`
              : ""
          }
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
  container.querySelector("#home-board-more")?.addEventListener("click", () => {
    const threadFilter = boardFilter.id === "running" ? "active" : boardFilter.id === "failed" ? "failed" : "all";
    setState({ activeTab: "threads", threadFilter, threadPage: 1 });
  });
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
      if (
        e.target.closest("[data-cancel-task]") ||
        e.target.closest("[data-retry-task]") ||
        e.target.closest("[data-resolve-task]") ||
        e.target.closest(".attachment-bar")
      ) {
        return;
      }
      setState({ activeTab: "threads", selectedThreadId: el.getAttribute("data-view-thread"), selectedThreadDetail: null });
    });
  });

  container.querySelectorAll("[data-cancel-task]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-cancel-task");
      if (btn.closest(".action-card") && !confirm("确认取消这个等待回复的任务吗？")) return;
      try {
        await api.cancelTask(id, "机主在概览取消任务");
        showToast("任务已取消");
        await refreshFn();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  container.querySelectorAll("[data-retry-task]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-retry-task");
      try {
        const res = await api.retryTask(id);
        const dropped = Number(res?.dropped_attachments || 0);
        showToast(
          dropped > 0
            ? `已重新派发任务（原任务有 ${dropped} 个临时附件已过期未携带）`
            : "已重新派发任务，旧失败已自动消红"
        );
        await refreshFn();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  container.querySelectorAll("[data-resolve-task]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-resolve-task");
      try {
        await api.resolveTask(id);
        showToast("已标为已处理");
        await refreshFn();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  container.querySelector("#home-resolve-all-failed")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const sinceMs = Number(btn?.getAttribute?.("data-resolve-since") || 0) || undefined;
    const cnt = Number(btn?.getAttribute?.("data-resolve-count") || 0);
    if (!confirm(`确认将近 24 小时内的 ${cnt || "全部"} 条未处理失败标为已处理吗？`)) return;
    try {
      const res = await api.resolveAllFailed(sinceMs ? { sinceMs } : {});
      showToast(res.resolved_count ? `已将 ${res.resolved_count} 条失败标为已处理` : "当前没有未处理的失败任务");
      await refreshFn();
    } catch (err) {
      showToast(err.message, true);
    }
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
