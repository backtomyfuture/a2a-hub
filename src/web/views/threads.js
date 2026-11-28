import { api } from "../api.js";
import { agentAvatar, uiIcon } from "../icons.js";
import { setState, store } from "../state.js";
import {
  attachmentUniqueKey,
  bindAttachmentPreview,
  escapeHtml,
  formatBytes,
  formatDateTime,
  formatRelativeTime,
  renderAttachmentsBar,
  showToast,
  stateLabel,
  stateTone,
} from "../utils.js";

let loadingContextId = "";
const replyPendingFiles = new Map();

function countTaskUniqueAttachments(t) {
  const keys = new Set();
  for (const att of t.attachments || []) {
    keys.add(attachmentUniqueKey(att));
  }
  for (const m of t.messages || []) {
    for (const att of m.attachments || []) {
      keys.add(attachmentUniqueKey(att));
    }
  }
  return keys.size;
}

function getOrphanTaskAttachments(t) {
  const inMessages = new Set();
  for (const m of t.messages || []) {
    for (const att of m.attachments || []) {
      inMessages.add(attachmentUniqueKey(att));
    }
  }
  return (t.attachments || []).filter((att) => !inMessages.has(attachmentUniqueKey(att)));
}

function renderReplyPendingFilesHtml(taskId) {
  const files = replyPendingFiles.get(taskId) || [];
  return files
    .map(
      (f, idx) => `
    <span class="attachment-chip">
      <span>📎</span>
      <span class="attachment-name truncate">${escapeHtml(f.name)}</span>
      <span class="attachment-size">${escapeHtml(formatBytes(f.size))}</span>
      <button type="button" class="btn btn-ghost btn-sm attachment-action-btn" data-reply-file-rm="${escapeHtml(taskId)}:${idx}">×</button>
    </span>
  `
    )
    .join("");
}

function updateReplyPendingList(container, taskId) {
  const listEl = container.querySelector(`[data-reply-pending-list="${CSS.escape(taskId)}"]`);
  if (!listEl) return;
  listEl.innerHTML = renderReplyPendingFilesHtml(taskId);
  listEl.querySelectorAll("[data-reply-file-rm]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const raw = btn.getAttribute("data-reply-file-rm") || "";
      const sep = raw.lastIndexOf(":");
      const id = raw.slice(0, sep);
      const idx = Number(raw.slice(sep + 1));
      const cur = replyPendingFiles.get(id) || [];
      if (Number.isInteger(idx) && idx >= 0) {
        cur.splice(idx, 1);
        if (cur.length) replyPendingFiles.set(id, cur);
        else replyPendingFiles.delete(id);
        updateReplyPendingList(container, id);
      }
    });
  });
}

const THREAD_PAGE_SIZE = 12;
const THREAD_TASK_STEP = 5;
const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "rejected"]);
const FAILED_STATES = new Set(["failed", "rejected"]);

function threadUnresolvedFailCount(th) {
  if (Number.isFinite(Number(th?.unresolved_failed_count))) {
    return Number(th.unresolved_failed_count);
  }
  return Number(th?.states?.failed || 0) + Number(th?.states?.rejected || 0);
}

const THREAD_FILTERS = [
  { id: "all", label: "全部", match: () => true },
  { id: "pending", label: "待处理", match: (th) => th.pending_action_count > 0 },
  { id: "active", label: "进行中", match: (th) => Boolean(th.states?.working || th.states?.submitted) },
  { id: "failed", label: "有失败", match: (th) => threadUnresolvedFailCount(th) > 0 },
];

function threadMatchesSearch(th, q, agentName) {
  if (!q) return true;
  const hay = [th.title, th.context_id, th.from_node, ...(th.agents || []).map(agentName)].join(" ").toLowerCase();
  return hay.includes(q);
}

function renderThreadStateSummary(th) {
  const states = th?.states || {};
  const parts = [
    ["working", "is-run", (states.working || 0) + (states.submitted || 0), "进行中"],
    ["pending", "is-warn", (states["input-required"] || 0) + (states["auth-required"] || 0), "待处理"],
    ["failed", "is-fail", threadUnresolvedFailCount(th), "未处理失败"],
    ["completed", "is-ok", states.completed || 0, "完成"],
  ].filter(([, , n]) => n > 0);
  return parts
    .map(([, cls, n, label]) => `<span class="thread-state-chip" title="${label} ${n}"><span class="status-dot ${cls}"></span>${n}</span>`)
    .join("");
}

function renderThreadItems(pageThreads, activeContextId, agentMap, agentName) {
  if (!pageThreads.length) return `<div class="panel-empty">没有符合条件的线程</div>`;
  return pageThreads
    .map(
      (th) => `
    <div class="thread-item ${th.context_id === activeContextId ? "active" : ""}" data-select-thread="${escapeHtml(th.context_id)}">
      <div class="thread-item-head">
        <strong class="truncate">${escapeHtml(th.title || th.context_id)}</strong>
        <span class="thread-item-time">${formatRelativeTime(th.updated_at)}</span>
      </div>
      <div class="thread-agents">
        <span class="avatar-stack">${(th.agents || [])
          .slice(0, 4)
          .map((id) => agentAvatar(agentMap.get(id) || { id }, { size: "xs", title: agentName(id) }))
          .join("")}</span>
        <span class="muted truncate">${(th.agents || []).map((id) => escapeHtml(agentName(id))).join(" · ")}</span>
      </div>
      <div class="thread-item-foot">
        <span class="thread-state-summary">${renderThreadStateSummary(th)}</span>
        <span class="muted">${th.task_count} 个任务${th.attachment_count ? ` · 📎 ${th.attachment_count}` : ""}${
          th.pending_action_count ? ` · <span class="thread-pending">${th.pending_action_count} 待处理</span>` : ""
        }</span>
      </div>
    </div>
  `
    )
    .join("");
}

export function renderThreadsView(container, refreshFn) {
  const s = store.state;
  if (!s) return;
  const threads = s.threads || [];
  if (!threads.length) {
    container.innerHTML = `<div class="empty-box">暂无对话线程。点击右上角「+ 派发任务」开始多 Agent 协同工作。</div>`;
    return;
  }

  const agentMap = new Map((s.agents || []).map((a) => [a.id, a]));
  const agentName = (id) => agentMap.get(id)?.name || id;
  const filterId = THREAD_FILTERS.some((f) => f.id === store.threadFilter) ? store.threadFilter : "all";
  const byFilter = threads.filter(THREAD_FILTERS.find((f) => f.id === filterId).match);

  const activeContextId = store.selectedThreadId || byFilter[0]?.context_id || threads[0].context_id;
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

  const counts = Object.fromEntries(THREAD_FILTERS.map((f) => [f.id, threads.filter(f.match).length]));

  container.innerHTML = `
    <div class="thread-layout">
      <aside class="thread-sidebar">
        <div class="thread-toolbar">
          <label class="thread-search">
            ${uiIcon("search", 14)}
            <input type="search" id="thread-search" placeholder="搜索标题、Agent 或 Context ID" value="${escapeHtml(store.threadSearch || "")}" />
          </label>
          <div class="seg-control thread-filter">
            ${THREAD_FILTERS.map(
              (f) => `<button type="button" class="seg-btn ${filterId === f.id ? "active" : ""}" data-thread-filter="${f.id}">${f.label}${
                f.id === "all" || counts[f.id] ? ` <span class="${f.id === "failed" || f.id === "pending" ? "seg-err-count" : ""}">${counts[f.id]}</span>` : ""
              }</button>`
            ).join("")}
          </div>
        </div>
        <div class="thread-list" id="thread-list"></div>
        <div class="thread-pager" id="thread-pager"></div>
      </aside>

      <div class="card thread-detail">
        ${
          detail
            ? renderThreadDetail(detail, agentMap)
            : `<div class="muted" style="padding:30px;text-align:center">正在加载线程详情...</div>`
        }
      </div>
    </div>
  `;

  const listEl = container.querySelector("#thread-list");
  const pagerEl = container.querySelector("#thread-pager");

  // 搜索框聚焦时主区域整体重绘会被暂停（防止丢草稿），因此列表与分页需要能独立局部刷新
  const renderListRegion = () => {
    const q = String(store.threadSearch || "").trim().toLowerCase();
    const matched = byFilter.filter((th) => threadMatchesSearch(th, q, agentName));
    const pageCount = Math.max(1, Math.ceil(matched.length / THREAD_PAGE_SIZE));
    const page = Math.min(Math.max(Number(store.threadPage) || 1, 1), pageCount);
    store.threadPage = page;
    const start = (page - 1) * THREAD_PAGE_SIZE;
    listEl.innerHTML = renderThreadItems(matched.slice(start, start + THREAD_PAGE_SIZE), activeContextId, agentMap, agentName);
    pagerEl.innerHTML =
      matched.length > THREAD_PAGE_SIZE
        ? `<button type="button" class="btn btn-ghost btn-sm btn-icon" data-thread-page="${page - 1}" ${page <= 1 ? "disabled" : ""} aria-label="上一页">${uiIcon("chevron-right", 14, "is-flipped")}</button>
           <span class="thread-pager-text">第 <strong>${page}</strong> / ${pageCount} 页 · 共 ${matched.length} 个线程</span>
           <button type="button" class="btn btn-ghost btn-sm btn-icon" data-thread-page="${page + 1}" ${page >= pageCount ? "disabled" : ""} aria-label="下一页">${uiIcon("chevron-right", 14)}</button>`
        : matched.length
          ? `<span class="thread-pager-text">共 ${matched.length} 个线程</span>`
          : "";

    listEl.querySelectorAll("[data-select-thread]").forEach((el) => {
      el.addEventListener("click", () => {
        const cid = el.getAttribute("data-select-thread");
        setState({ selectedThreadId: cid, selectedThreadDetail: null });
      });
    });
    pagerEl.querySelectorAll("[data-thread-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        store.threadPage = Number(btn.getAttribute("data-thread-page"));
        renderListRegion();
        listEl.scrollIntoView({ block: "nearest" });
      });
    });
  };
  renderListRegion();

  container.querySelector("#thread-search")?.addEventListener("input", (e) => {
    store.threadSearch = e.target.value;
    store.threadPage = 1;
    renderListRegion();
  });
  container.querySelectorAll("[data-thread-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setState({ threadFilter: btn.getAttribute("data-thread-filter"), threadPage: 1 });
    });
  });

  container.querySelector("[data-thread-more]")?.addEventListener("click", (e) => {
    const cid = e.currentTarget.getAttribute("data-thread-more");
    store.threadTaskVisible = { ...(store.threadTaskVisible || {}), [cid]: visibleTaskCount(cid) + THREAD_TASK_STEP };
    setState({});
  });

  bindThreadActions(container, refreshFn);
}

function visibleTaskCount(contextId) {
  return Number(store.threadTaskVisible?.[contextId]) || THREAD_TASK_STEP;
}

function renderThreadDetail(detail, agentMap = new Map()) {
  const total = detail.tasks.length;
  const visible = Math.min(total, visibleTaskCount(detail.context_id));
  const hidden = total - visible;
  // 最新的任务在最下方，与对话阅读顺序一致；更早的任务按需展开，避免长线程一次铺满整屏
  const shownTasks = detail.tasks.slice(total - visible);
  const doneCount = detail.tasks.filter((t) => t.state === "completed").length;
  const canDeleteThread = detail.tasks.every((t) => TERMINAL_STATES.has(t.state));
  return `
    <div class="thread-detail-head">
      <div style="min-width:0">
        <h2 class="thread-detail-title">${escapeHtml(detail.title)}</h2>
        <div class="thread-detail-meta">
          <span class="avatar-stack">${detail.agents
            .slice(0, 6)
            .map((id) => agentAvatar(agentMap.get(id) || { id }, { size: "xs", title: agentMap.get(id)?.name || id }))
            .join("")}</span>
          <span>${total} 个任务 · 完成 ${doneCount}</span>
          <span>发起方 ${escapeHtml(detail.from_node)}</span>
          <span class="mono truncate" title="Context ID">${escapeHtml(detail.context_id)}</span>
        </div>
      </div>
      <div class="thread-detail-actions">
        <button class="btn btn-primary btn-sm" id="thread-continue-btn" data-ctx="${escapeHtml(detail.context_id)}" data-agents="${escapeHtml(detail.agents.join(","))}">
          ${uiIcon("plus", 12)} 在此线程继续派单
        </button>
        ${
          canDeleteThread
            ? `<button type="button" class="btn btn-ghost btn-sm btn-icon btn-danger-ghost" data-delete-thread="${escapeHtml(detail.context_id)}" title="删除整个线程" aria-label="删除整个线程">${uiIcon("trash", 14)}</button>`
            : ""
        }
      </div>
    </div>

    ${
      hidden > 0
        ? `<button type="button" class="thread-more-btn" data-thread-more="${escapeHtml(detail.context_id)}">
            ${uiIcon("chevron-down", 13, "is-flipped-v")} 显示更早的 ${Math.min(hidden, THREAD_TASK_STEP)} 个任务 <span class="muted">（还有 ${hidden} 个）</span>
          </button>`
        : ""
    }

    <div class="stack-md">
      ${shownTasks
        .map((t) => {
          const taskAttCount = countTaskUniqueAttachments(t);
          const orphanAtts = getOrphanTaskAttachments(t);
          const isTerminal = TERMINAL_STATES.has(t.state);
          const isFailed = FAILED_STATES.has(t.state);
          const isResolvedFail = isFailed && Boolean(t.resolved_at);
          const canRetry = isFailed || t.state === "canceled";
          const pillHtml = isResolvedFail
            ? `<span class="pill" title="该失败已处理，不再触发告警">${escapeHtml(stateLabel(t.state))} · 已处理</span>`
            : `<span class="pill ${stateTone(t.state)}">${stateLabel(t.state)}</span>`;
          return `
        <div class="card thread-task-card${isResolvedFail ? " is-resolved-fail" : ""}" style="background:var(--bg);padding:14px">
          <div class="row-between">
            <div class="row" style="flex-wrap:wrap">
              ${pillHtml}
              <strong>${escapeHtml(t.title)}</strong>
              <span class="thread-task-target">${uiIcon("arrow-right", 12)}${agentAvatar(agentMap.get(t.to_agent_id) || { id: t.to_agent_id }, { size: "xs" })}<span>${escapeHtml(agentMap.get(t.to_agent_id)?.name || t.to_agent_id)}</span></span>
              ${t.model ? `<span class="chip chip-model">${escapeHtml(t.model)}</span>` : ""}
              ${taskAttCount ? `<span class="attachment-tag">📎 ${taskAttCount}</span>` : ""}
            </div>
            <div class="row" style="gap:6px;flex-shrink:0">
              ${
                !isTerminal
                  ? `<button type="button" class="btn btn-sm btn-danger" data-cancel-task="${escapeHtml(t.id)}">取消任务</button>`
                  : `
                    ${
                      canRetry
                        ? `<button type="button" class="btn btn-sm ${isFailed && !isResolvedFail ? "btn-secondary" : "btn-ghost"}" data-retry-task="${escapeHtml(t.id)}">${uiIcon("retry", 12)} 重试</button>`
                        : ""
                    }
                    ${
                      isFailed && !isResolvedFail
                        ? `<button type="button" class="btn btn-sm btn-ghost" data-resolve-task="${escapeHtml(t.id)}">${uiIcon("check", 12)} 已处理</button>`
                        : ""
                    }
                    <button type="button" class="btn btn-sm btn-ghost btn-icon btn-danger-ghost" data-delete-task="${escapeHtml(t.id)}" title="删除这条任务记录" aria-label="删除任务">${uiIcon("trash", 13)}</button>
                  `
              }
            </div>
          </div>

          ${orphanAtts.length ? `<div style="margin-top:8px">${renderAttachmentsBar(orphanAtts)}</div>` : ""}

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
                    ${renderAttachmentsBar(m.attachments || [])}
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
                ? `<form class="stack-sm" style="margin-top:10px" data-thread-reply="${escapeHtml(t.id)}">
                    <div class="row">
                      <input type="text" name="body" placeholder="输入补充说明..." />
                      <input type="file" multiple class="hidden" data-reply-file-input="${escapeHtml(t.id)}" />
                      <button type="button" class="btn btn-sm btn-secondary" data-reply-file-btn="${escapeHtml(t.id)}" style="white-space:nowrap">📎 附件</button>
                      <button type="submit" class="btn btn-sm btn-primary" style="white-space:nowrap">回复并恢复</button>
                    </div>
                    <div class="attachment-pending-list" data-reply-pending-list="${escapeHtml(t.id)}">${renderReplyPendingFilesHtml(t.id)}</div>
                  </form>`
                : ""
          }
        </div>
      `;
        })
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

  container.querySelectorAll("[data-retry-task]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        const res = await api.retryTask(btn.getAttribute("data-retry-task"));
        const dropped = Number(res?.dropped_attachments || 0);
        showToast(
          dropped > 0
            ? `已重新派发任务（原任务有 ${dropped} 个临时附件已过期未携带）`
            : "已重新派发任务，旧失败已自动消红"
        );
        await reloadThreadAndState();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  container.querySelectorAll("[data-resolve-task]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api.resolveTask(btn.getAttribute("data-resolve-task"));
        showToast("已标为已处理");
        await reloadThreadAndState();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  container.querySelectorAll("[data-delete-task]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("确认删除这条任务记录吗？将一并删除该任务下的全部历史消息与附件关联，删除后不可恢复。")) return;
      const id = btn.getAttribute("data-delete-task");
      const wasOnlyTask = (store.selectedThreadDetail?.tasks?.length || 0) <= 1;
      try {
        await api.deleteTask(id);
        showToast("任务记录已删除");
        if (wasOnlyTask) {
          setState({ selectedThreadId: null, selectedThreadDetail: null });
          await refreshFn();
        } else {
          await reloadThreadAndState();
        }
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  container.querySelectorAll("[data-delete-thread]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("确认删除整个对话线程及其全部任务记录吗？将一并删除线程内的全部历史消息与附件关联，删除后不可恢复。")) return;
      const cid = btn.getAttribute("data-delete-thread");
      try {
        await api.deleteThread(cid);
        showToast("对话线程已删除");
        setState({ selectedThreadId: null, selectedThreadDetail: null });
        await refreshFn();
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

  container.querySelectorAll("[data-reply-file-btn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-reply-file-btn");
      const input = container.querySelector(`[data-reply-file-input="${CSS.escape(id)}"]`);
      input?.click();
    });
  });

  container.querySelectorAll("[data-reply-file-input]").forEach((input) => {
    input.addEventListener("change", () => {
      const id = input.getAttribute("data-reply-file-input");
      const cur = replyPendingFiles.get(id) || [];
      for (const f of Array.from(input.files || [])) {
        const dup = cur.some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified);
        if (!dup) cur.push(f);
      }
      replyPendingFiles.set(id, cur);
      input.value = "";
      updateReplyPendingList(container, id);
    });
  });

  for (const form of container.querySelectorAll("[data-thread-reply]")) {
    const id = form.getAttribute("data-thread-reply");
    if (id) updateReplyPendingList(container, id);
  }

  container.querySelectorAll("[data-thread-reply]").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = form.getAttribute("data-thread-reply");
      const text = String(new FormData(form).get("body") || "").trim();
      const files = replyPendingFiles.get(id) || [];
      if (!text && !files.length) {
        showToast("请输入补充说明或附加文件", true);
        return;
      }
      try {
        const uploaded = [];
        for (const f of files) {
          const up = await api.uploadFile(f, { taskId: id });
          uploaded.push({
            id: up.file.id,
            uri: up.file.uri,
            name: up.file.name,
            mime: up.file.mime,
            size: up.file.size,
            sha256: up.file.sha256,
          });
        }
        await api.replyTask(id, text, uploaded);
        replyPendingFiles.delete(id);
        showToast("已发送回复");
        await reloadThreadAndState();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  bindAttachmentPreview(container);
}
