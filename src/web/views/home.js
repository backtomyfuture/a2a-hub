import { api } from "../api.js";
import { renderAgentCard } from "../components/agent-card.js";
import { resetAddModalState } from "../components/add-modal.js";
import { setState, store } from "../state.js";
import { escapeHtml, formatRelativeTime, showToast, stateLabel, stateTone } from "../utils.js";

export function renderHomeView(container, refreshFn) {
  const s = store.state;
  if (!s) return;

  const agents = s.agents || [];
  const devices = s.devices || [];
  const tasks = s.tasks || [];
  const actions = s.pending_actions || [];
  const activeTasks = tasks.filter((t) => t.state === "working" || t.state === "submitted");
  const onlineAgents = agents.filter((a) => a.online && a.enabled).length;

  container.innerHTML = `
    <section class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">在线可用 Agent</div>
        <div class="kpi-val">${onlineAgents} <span class="muted" style="font-size:14px">/ ${agents.length}</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">待我处理（审批 / 追问）</div>
        <div class="kpi-val" style="color:${actions.length ? "var(--danger)" : "var(--text)"}">${actions.length}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">在途任务</div>
        <div class="kpi-val">${activeTasks.length}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">已挂载电脑</div>
        <div class="kpi-val">${devices.filter((d) => d.online).length} <span class="muted" style="font-size:14px">/ ${devices.length}</span></div>
      </div>
    </section>

    <section>
      <div class="section-header">
        <h2 class="section-title">待我处理 (${actions.length})</h2>
        <div class="row">
          <button class="btn btn-sm btn-secondary" id="home-add-btn">+ 接入 Agent / 电脑</button>
          <button class="btn btn-sm btn-primary" id="home-dispatch-btn">+ 派发新任务</button>
        </div>
      </div>

      ${
        actions.length
          ? `<div class="action-list">${actions.map(renderActionCard).join("")}</div>`
          : `<div class="empty-box">所有队列运转平稳，当前没有需要机主确认或补充的阻塞任务。</div>`
      }
    </section>

    <section>
      <div class="section-header">
        <h2 class="section-title">在途与最近任务</h2>
        <button class="btn btn-ghost btn-sm" id="home-goto-threads">查看全部对话线程 →</button>
      </div>
      ${renderRecentTasks(tasks.slice(0, 8), agents)}
    </section>

    <section>
      <div class="section-header">
        <h2 class="section-title">可用 Agent 能力总览</h2>
        <button class="btn btn-ghost btn-sm" id="home-goto-agents">管理全部 Agent 与电脑 →</button>
      </div>
      ${
        agents.length
          ? `<div class="agent-grid">${agents.slice(0, 6).map((a) => renderAgentCard(a, tasks)).join("")}</div>`
          : `<div class="empty-box">还没有接入任何 Agent。点击右上角「+ 接入 Agent / 电脑」即可 30 秒上手。</div>`
      }
    </section>
  `;

  container.querySelector("#home-add-btn")?.addEventListener("click", () => {
    resetAddModalState("agent");
    setState({ showAddModal: "agent" });
  });
  container.querySelector("#home-dispatch-btn")?.addEventListener("click", () => {
    setState({ showDispatchModal: true, dispatchPreselect: [], dispatchContextId: "" });
  });
  container.querySelector("#home-goto-threads")?.addEventListener("click", () => setState({ activeTab: "threads" }));
  container.querySelector("#home-goto-agents")?.addEventListener("click", () => setState({ activeTab: "agents" }));

  bindHomeEvents(container, refreshFn);
}

function renderActionCard(task) {
  const isAuth = task.state === "auth-required";
  const msgs = task.messages || [];
  const lastMsg = [...msgs].reverse().find((m) => m.kind === (isAuth ? "auth_request" : "question"));
  const promptText = lastMsg?.body || task.title;

  return `
    <div class="action-card ${isAuth ? "is-auth" : ""}">
      <div class="row-between">
        <div class="row">
          <span class="pill ${stateTone(task.state)}">${stateLabel(task.state)}</span>
          <strong>${escapeHtml(task.title)}</strong>
          <span class="muted">· 指派给 ${escapeHtml(task.to_agent_id)}</span>
        </div>
        <button class="btn btn-ghost btn-sm" data-view-thread="${escapeHtml(task.context_id)}">查看线程</button>
      </div>
      <div class="msg-body">${escapeHtml(promptText)}</div>
      ${
        isAuth
          ? `<div class="row-between">
              <input type="text" placeholder="可选审批备注..." data-auth-note="${escapeHtml(task.id)}" style="max-width:340px" />
              <div class="row">
                <button class="btn btn-sm btn-danger" data-decide-deny="${escapeHtml(task.id)}">拒绝</button>
                <button class="btn btn-sm btn-primary" data-decide-approve="${escapeHtml(task.id)}">签名并放行</button>
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

function renderRecentTasks(tasks, agents) {
  if (!tasks.length) {
    return `<div class="empty-box">暂无任务记录。</div>`;
  }
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  return `
    <div class="card table-wrap" style="padding:8px 14px">
      <table>
        <thead>
          <tr>
            <th>状态</th>
            <th>任务</th>
            <th>执行 Agent</th>
            <th>发起方</th>
            <th>更新时间</th>
          </tr>
        </thead>
        <tbody>
          ${tasks
            .map((t) => {
              const ag = agentMap.get(t.to_agent_id);
              return `
                <tr style="cursor:pointer" data-view-thread="${escapeHtml(t.context_id)}">
                  <td><span class="pill ${stateTone(t.state)}">${stateLabel(t.state)}</span></td>
                  <td><strong>${escapeHtml(t.title)}</strong></td>
                  <td>${escapeHtml(ag?.name || t.to_agent_id)}</td>
                  <td class="muted">${escapeHtml(t.from_node)}</td>
                  <td class="muted">${formatRelativeTime(t.updated_at)}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function bindHomeEvents(container, refreshFn) {
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

  container.querySelectorAll("[data-view-thread]").forEach((el) => {
    el.addEventListener("click", () => {
      setState({ activeTab: "threads", selectedThreadId: el.getAttribute("data-view-thread") });
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
