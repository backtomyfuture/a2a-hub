import { agentSourceLabel, escapeHtml, formatRelativeTime } from "../utils.js";

export function renderAgentCard(agent, tasks = [], options = {}) {
  const compactInDevice = Boolean(options?.compactInDevice);
  const dotClass = !agent.enabled ? "dot-paused" : agent.online ? "dot-online" : "dot-offline";
  const statusText = !agent.enabled ? "已暂停" : agent.online ? "在线" : "离线";
  const roleBadge = agent.role === "leader"
    ? `<span class="pill pill-primary">Leader 协调</span>`
    : `<span class="pill">Worker 执行</span>`;

  const subId = compactInDevice ? (agent.worker_key || agent.id) : agent.id;
  const footText = compactInDevice
    ? `${statusText}${agent.approval_policy && agent.approval_policy !== "never" ? " · 需审批" : ""}`
    : `${agentSourceLabel(agent)} · ${statusText}`;
  const footTitle = compactInDevice
    ? `${footText} · ${formatRelativeTime(agent.last_seen_at)}`
    : `${agentSourceLabel(agent)} · ${formatRelativeTime(agent.last_seen_at)}`;

  const summary = agent.summary || "未填写定位描述 — 点击卡片补充该 Agent 擅长的任务边界";
  const tags = [
    ...(Array.isArray(agent.skills) ? agent.skills : []),
    ...(Array.isArray(agent.tools) ? agent.tools.map((t) => `tool:${t}`) : []),
  ];
  const visibleTags = tags.slice(0, 4);
  const extraCount = Math.max(0, tags.length - visibleTags.length);

  const activeTask = agent.active_task_id
    ? tasks.find((t) => t.id === agent.active_task_id)
    : null;

  return `
    <article class="agent-card ${compactInDevice ? "is-in-device" : ""} ${agent.enabled ? "" : "is-paused"}" data-open-agent="${escapeHtml(agent.id)}">
      <div class="agent-card-head">
        <div class="agent-name-wrap">
          <span class="dot ${dotClass}" title="${statusText}"></span>
          <div style="min-width:0">
            <div class="agent-name truncate">${escapeHtml(agent.name)}</div>
            <div class="muted mono truncate">${escapeHtml(subId)}</div>
          </div>
        </div>
        ${roleBadge}
      </div>

      <div class="agent-summary">${escapeHtml(summary)}</div>

      <div class="chip-row">
        ${agent.default_model ? `<span class="chip chip-model">${escapeHtml(agent.default_model)}</span>` : ""}
        ${visibleTags.map((tag) => `<span class="chip">#${escapeHtml(tag)}</span>`).join("")}
        ${extraCount > 0 ? `<span class="chip">+${extraCount}</span>` : ""}
      </div>

      ${
        activeTask
          ? `<div class="pill pill-primary truncate">执行中：${escapeHtml(activeTask.title)}</div>`
          : ""
      }

      <div class="agent-card-foot">
        <span class="muted truncate" title="${escapeHtml(footTitle)}">
          ${escapeHtml(footText)}
        </span>
        <button
          class="btn btn-sm btn-secondary"
          type="button"
          data-quick-dispatch="${escapeHtml(agent.id)}"
          ${agent.enabled ? "" : "disabled"}
        >
          派任务
        </button>
      </div>
    </article>
  `;
}
