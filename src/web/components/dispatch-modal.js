import { api } from "../api.js";
import { setState, store } from "../state.js";
import { agentSourceLabel, escapeHtml, showToast } from "../utils.js";

export function renderDispatchModal(root, refreshFn) {
  if (!store.showDispatchModal) {
    root.innerHTML = "";
    return;
  }

  const agents = (store.state?.agents || []).filter((a) => a.enabled);
  const preselect = new Set(store.dispatchPreselect || []);
  const contextId = store.dispatchContextId || "";

  root.innerHTML = `
    <div class="modal-backdrop" data-dispatch-backdrop>
      <div class="modal-card">
        <div class="row-between" style="margin-bottom:14px">
          <h2 style="margin:0;font-size:18px">${contextId ? "在同一对话线程追派任务" : "派发新任务（支持多 Agent 并发扇出）"}</h2>
          <button class="btn btn-ghost btn-sm" id="dispatch-close">关闭</button>
        </div>

        <form id="dispatch-form" class="stack-md">
          <div class="field">
            <span>选择执行 Agent（可多选，自动共享同一个 Thread 上下文）*</span>
            ${
              agents.length
                ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px">
                    ${agents
                      .map(
                        (a) => `
                      <label class="card" style="padding:9px 11px;display:flex;gap:8px;align-items:flex-start;cursor:pointer">
                        <input type="checkbox" name="targets" value="${escapeHtml(a.id)}" ${preselect.has(a.id) ? "checked" : ""} style="margin-top:3px" />
                        <div style="min-width:0">
                          <div style="font-weight:600;font-size:13px" class="truncate">${escapeHtml(a.name)}</div>
                          <div class="muted truncate" style="font-size:11px">${escapeHtml(a.summary || agentSourceLabel(a))}</div>
                        </div>
                      </label>
                    `
                      )
                      .join("")}
                  </div>`
                : `<div class="error-banner">暂无已启用的 Agent，请先接入 Agent 或恢复暂停中的 Agent。</div>`
            }
          </div>

          <label class="field">
            <span>任务标题（可选，缺省自动截取正文）</span>
            <input type="text" name="title" placeholder="例如：排查 PR #42 单测失败原因" />
          </label>

          <label class="field">
            <span>任务详细指令 *</span>
            <textarea name="input_text" rows="4" placeholder="描述你想让 Agent 完成的工作目标与验收标准..." required></textarea>
          </label>

          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
            <label class="field">
              <span>线程 ID（留空新建）</span>
              <input type="text" name="context_id" value="${escapeHtml(contextId)}" placeholder="ctx_..." />
            </label>
            <label class="field">
              <span>模型覆盖（可选）</span>
              <input type="text" name="model" placeholder="默认随 Agent 配置" />
            </label>
            <label class="field">
              <span>优先级 (1-10)</span>
              <input type="number" name="priority" min="1" max="10" value="5" />
            </label>
          </div>

          <div class="row-between">
            <span class="muted" style="font-size:12px">选择多个 Agent 时，将同时创建子任务并汇总在同一 Thread 内。</span>
            <button type="submit" class="btn btn-primary" ${agents.length ? "" : "disabled"}>立即派发</button>
          </div>
        </form>
      </div>
    </div>
  `;

  root.querySelector("[data-dispatch-backdrop]")?.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-dispatch-backdrop")) {
      setState({ showDispatchModal: false, dispatchPreselect: [], dispatchContextId: "" });
    }
  });
  root.querySelector("#dispatch-close")?.addEventListener("click", () => {
    setState({ showDispatchModal: false, dispatchPreselect: [], dispatchContextId: "" });
  });

  root.querySelector("#dispatch-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const targets = fd.getAll("targets").map(String).filter(Boolean);
    if (!targets.length) {
      showToast("请至少勾选一个目标 Agent", true);
      return;
    }
    try {
      const res = await api.dispatchTask({
        to: targets,
        title: String(fd.get("title") || "").trim(),
        input_text: String(fd.get("input_text") || "").trim(),
        context_id: String(fd.get("context_id") || "").trim() || undefined,
        model: String(fd.get("model") || "").trim() || undefined,
        priority: Number(fd.get("priority") || 5),
      });
      showToast(`已派发 ${res.tasks.length} 个任务`);
      setState({
        showDispatchModal: false,
        dispatchPreselect: [],
        dispatchContextId: "",
        activeTab: "threads",
        selectedThreadId: res.context_id,
      });
      await refreshFn();
    } catch (err) {
      showToast(err.message, true);
    }
  });
}
