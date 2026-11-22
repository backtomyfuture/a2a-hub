import { api } from "../api.js";
import { setState, store } from "../state.js";
import { escapeHtml, formatDateTime, formatRelativeTime, showToast, stateLabel, stateTone } from "../utils.js";

let loadingContextId = "";

export function renderThreadsView(container, refreshFn) {
  const s = store.state;
  if (!s) return;
  const threads = s.threads || [];
  if (!threads.length) {
    container.innerHTML = `<div class="empty-box">暂无对话线程。点击右上角「+ 派发任务」开始多 Agent 协同工作。</div>`;
    return;
  }

  const activeContextId = store.selectedThreadId || threads[0].context_id;
  if (store.selectedThreadDetail?.context_id !== activeContextId && loadingContextId !== activeContextId) {
    loadingContextId = activeContextId;
    void api.getThread(activeContextId).then((res) => {
      loadingContextId = "";
      setState({ selectedThreadId: activeContextId, selectedThreadDetail: res.thread });
    }).catch(() => {
      loadingContextId = "";
    });
  }

  const detail = store.selectedThreadDetail?.context_id === activeContextId ? store.selectedThreadDetail : null;

  container.innerHTML = `
    <div class="thread-layout">
      <div class="thread-list">
        ${threads
          .map(
            (th) => `
          <div class="thread-item ${th.context_id === activeContextId ? "active" : ""}" data-select-thread="${escapeHtml(th.context_id)}">
            <div class="row-between">
              <strong class="truncate">${escapeHtml(th.title || th.context_id)}</strong>
              ${th.pending_action_count ? `<span class="pill pill-danger">${th.pending_action_count} 待处理</span>` : ""}
            </div>
            <div class="muted" style="font-size:12px;margin-top:4px">
              ${th.agents.map((a) => escapeHtml(a)).join(" · ")}
            </div>
            <div class="row-between muted" style="font-size:11px;margin-top:4px">
              <span>${th.task_count} 个任务</span>
              <span>${formatRelativeTime(th.updated_at)}</span>
            </div>
          </div>
        `
          )
          .join("")}
      </div>

      <div class="card">
        ${
          detail
            ? renderThreadDetail(detail)
            : `<div class="muted" style="padding:30px;text-align:center">正在加载线程详情...</div>`
        }
      </div>
    </div>
  `;

  container.querySelectorAll("[data-select-thread]").forEach((el) => {
    el.addEventListener("click", () => {
      const cid = el.getAttribute("data-select-thread");
      setState({ selectedThreadId: cid, selectedThreadDetail: null });
    });
  });

  bindThreadActions(container, refreshFn);
}

function renderThreadDetail(detail) {
  return `
    <div class="row-between" style="padding-bottom:12px;border-bottom:1px solid var(--border);margin-bottom:14px">
      <div style="min-width:0">
        <h2 style="margin:0;font-size:17px">${escapeHtml(detail.title)}</h2>
        <div class="muted mono">Context ID: ${escapeHtml(detail.context_id)} · 发起方: ${escapeHtml(detail.from_node)}</div>
      </div>
      <button class="btn btn-primary btn-sm" id="thread-continue-btn" data-ctx="${escapeHtml(detail.context_id)}" data-agents="${escapeHtml(detail.agents.join(","))}">
        + 在此线程继续派单
      </button>
    </div>

    <div class="stack-md">
      ${detail.tasks
        .map(
          (t) => `
        <div class="card" style="background:var(--bg);padding:14px">
          <div class="row-between">
            <div class="row">
              <span class="pill ${stateTone(t.state)}">${stateLabel(t.state)}</span>
              <strong>${escapeHtml(t.title)}</strong>
              <span class="muted">→ ${escapeHtml(t.to_agent_id)}</span>
              ${t.model ? `<span class="chip chip-model">${escapeHtml(t.model)}</span>` : ""}
            </div>
            <div class="row">
              ${
                !["completed", "failed", "canceled", "rejected"].includes(t.state)
                  ? `<button class="btn btn-sm btn-danger" data-cancel-task="${escapeHtml(t.id)}">取消任务</button>`
                  : ""
              }
            </div>
          </div>

          <div class="msg-timeline">
            ${(t.messages || [])
              .map((m) => {
                const cls =
                  m.kind === "receipt"
                    ? "is-receipt"
                    : m.kind === "error"
                      ? "is-error"
                      : m.kind === "auth_request" || m.kind === "auth_decision" || m.kind === "question"
                        ? "is-auth"
                        : "";
                return `
                  <div class="msg-bubble ${cls}">
                    <div class="msg-head">
                      <span><strong>${escapeHtml(m.from_node)}</strong> · ${escapeHtml(m.kind)} ${m.signature ? "· 已签名验真 ✓" : ""}</span>
                      <span>${formatDateTime(m.created_at)}</span>
                    </div>
                    <div class="msg-body">${escapeHtml(m.body || JSON.stringify(m.data || {}))}</div>
                  </div>
                `;
              })
              .join("")}
          </div>

          ${
            t.state === "auth-required"
              ? `<div class="row-between" style="margin-top:10px">
                  <input type="text" placeholder="审批备注..." data-thread-note="${escapeHtml(t.id)}" style="max-width:300px" />
                  <div class="row">
                    <button class="btn btn-sm btn-danger" data-thread-deny="${escapeHtml(t.id)}">拒绝</button>
                    <button class="btn btn-sm btn-primary" data-thread-approve="${escapeHtml(t.id)}">签名批准</button>
                  </div>
                </div>`
              : t.state === "input-required"
                ? `<form class="row" style="margin-top:10px" data-thread-reply="${escapeHtml(t.id)}">
                    <input type="text" name="body" placeholder="输入补充说明..." required />
                    <button type="submit" class="btn btn-sm btn-primary">回复并恢复</button>
                  </form>`
                : ""
          }
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function bindThreadActions(container, refreshFn) {
  const contBtn = container.querySelector("#thread-continue-btn");
  contBtn?.addEventListener("click", () => {
    const ctx = contBtn.getAttribute("data-ctx") || "";
    const agents = (contBtn.getAttribute("data-agents") || "").split(",").filter(Boolean);
    setState({
      showDispatchModal: true,
      dispatchContextId: ctx,
      dispatchPreselect: agents,
    });
  });

  const reloadThreadAndState = async () => {
    if (store.selectedThreadId) {
      const r = await api.getThread(store.selectedThreadId);
      setState({ selectedThreadDetail: r.thread });
    }
    await refreshFn();
  };

  container.querySelectorAll("[data-cancel-task]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api.cancelTask(btn.getAttribute("data-cancel-task"), "控制台手动取消");
        showToast("任务已取消");
        await reloadThreadAndState();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  container.querySelectorAll("[data-thread-approve]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-thread-approve");
      const note = container.querySelector(`[data-thread-note="${CSS.escape(id)}"]`)?.value || "";
      try {
        await api.decideApproval(id, "approve", note);
        showToast("已签名批准");
        await reloadThreadAndState();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  container.querySelectorAll("[data-thread-deny]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-thread-deny");
      const note = container.querySelector(`[data-thread-note="${CSS.escape(id)}"]`)?.value || "拒绝";
      try {
        await api.decideApproval(id, "deny", note);
        showToast("已拒绝");
        await reloadThreadAndState();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  container.querySelectorAll("[data-thread-reply]").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = form.getAttribute("data-thread-reply");
      const text = new FormData(form).get("body");
      try {
        await api.replyTask(id, String(text || "").trim());
        showToast("已发送回复");
        await reloadThreadAndState();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}
