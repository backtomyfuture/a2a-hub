import { agentAvatar, agentStatusOf, uiIcon } from "../icons.js";
import { agentSourceLabel, escapeHtml, formatRelativeTime } from "../utils.js";

export function renderAgentCard(agent, tasks = [], options = {}) {
  const compactInDevice = Boolean(options?.compactInDevice);
  const statusText = !agent.enabled ? "已暂停" : agent.online ? "在线" : "离线";
  const roleBadge = agent.role === "leader"
    ? `<span class="pill pill-primary">Leader</span>`
    : `<span class="pill">Worker</span>`;

  const subId = compactInDevice ? (agent.worker_key || agent.id) : agent.id;
  const needsApproval = Boolean(agent.approval_policy && agent.approval_policy !== "never");
  const footMeta = compactInDevice ? (needsApproval ? "需审批" : "") : agentSourceLabel(agent);
  const footTitle = [statusText, footMeta, formatRelativeTime(agent.last_seen_at)].filter(Boolean).join(" · ");

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
          ${agentAvatar(agent, { size: "lg", status: agentStatusOf(agent), title: statusText })}
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
          ? `<div class="agent-running truncate"><span class="status-dot is-run"></span>执行中：${escapeHtml(activeTask.title)}</div>`
          : ""
      }

      <div class="agent-card-foot">
        <span class="agent-foot-meta truncate" title="${escapeHtml(footTitle)}">
          <span class="agent-status-text is-${agentStatusOf(agent)}">${escapeHtml(statusText)}</span>${
            footMeta ? `<span class="muted"> · ${escapeHtml(footMeta)}</span>` : ""
          }
        </span>
        <button
          class="btn btn-sm btn-secondary"
          type="button"
          data-quick-dispatch="${escapeHtml(agent.id)}"
          ${agent.enabled ? "" : "disabled"}
        >
          ${uiIcon("send", 12)} 派任务
        </button>
      </div>
    </article>
  `;
}
