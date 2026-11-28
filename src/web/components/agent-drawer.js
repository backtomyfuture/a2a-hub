import { api } from "../api.js";
import { agentAvatar } from "../icons.js";
import { getAgentById, setState, store } from "../state.js";
import {
  agentSourceLabel,
  bindBackdropClose,
  copyText,
  escapeHtml,
  formatRelativeTime,
  showToast,
  stateLabel,
  stateTone,
} from "../utils.js";

// 长轮询刷新时只更新状态区文字，避免重建整个抽屉导致表单草稿、焦点与滚动位置丢失
export function refreshAgentDrawerStatus(root) {
  const agent = store.selectedAgentId ? getAgentById(store.selectedAgentId) : null;
  const box = root.querySelector("[data-drawer-status]");
  if (!agent || !box) return;
  const title = box.querySelector("div > div:first-child");
  const meta = box.querySelector("div > div:nth-child(2)");
  const btn = box.querySelector("#drawer-toggle-enabled");
  if (title) title.textContent = agent.enabled ? "当前已启用接单" : "当前已暂停接单";
  if (meta) meta.textContent = `最后活跃：${formatRelativeTime(agent.last_seen_at)} · ${agent.online ? "在线" : "离线"}`;
  if (btn) {
    btn.textContent = agent.enabled ? "暂停 Agent" : "恢复启用";
    btn.className = `btn btn-sm ${agent.enabled ? "btn-secondary" : "btn-primary"}`;
  }
}

export function renderAgentDrawer(root, refreshFn) {
  const agent = store.selectedAgentId ? getAgentById(store.selectedAgentId) : null;
  if (!agent) {
    root.innerHTML = "";
    return;
  }

  const tasks = (store.state?.tasks || []).filter((t) => t.to_agent_id === agent.id).slice(0, 8);
  const isDeviceWorker = agent.kind === "device-worker";
  const parentDev = isDeviceWorker
    ? (store.state?.devices || []).find((d) => d.id === agent.device_id)
    : null;

  root.innerHTML = `
    <div class="drawer-backdrop" data-drawer-backdrop>
      <aside class="drawer-panel">
        <div class="row-between" style="margin-bottom:14px">
          <div class="row" style="min-width:0;gap:12px">
            ${agentAvatar(agent, { size: "xl" })}
            <div style="min-width:0">
              <h2 style="margin:0;font-size:18px" class="truncate">${escapeHtml(agent.name)}</h2>
              <div class="muted mono truncate">${escapeHtml(agent.id)} · ${escapeHtml(agentSourceLabel(agent))}</div>
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" id="drawer-close-btn">关闭</button>
        </div>

        <div class="row-between card" style="padding:10px 14px;margin-bottom:14px" data-drawer-status>
          <div>
            <div style="font-weight:600">${agent.enabled ? "当前已启用接单" : "当前已暂停接单"}</div>
            <div class="muted" style="font-size:12px">最后活跃：${formatRelativeTime(agent.last_seen_at)} · ${agent.online ? "在线" : "离线"}</div>
          </div>
          <button class="btn btn-sm ${agent.enabled ? "btn-secondary" : "btn-primary"}" id="drawer-toggle-enabled">
            ${agent.enabled ? "暂停 Agent" : "恢复启用"}
          </button>
        </div>

        <form id="drawer-agent-form" class="stack-md">
          <label class="field">
            <span>显示名称</span>
            <input type="text" name="name" value="${escapeHtml(agent.name)}" required />
          </label>
          <label class="field">
            <span>能力定位（清晰展示在卡片正面，让调度者 3 秒看懂它能做什么）</span>
            <textarea name="summary" rows="2">${escapeHtml(agent.summary || "")}</textarea>
          </label>
          <label class="field">
            <span>机主内部备注（仅在详情抽屉可见）</span>
            <input type="text" name="note" value="${escapeHtml(agent.note || "")}" placeholder="例如：高费用模型慎用 / 仅工作时间运行" />
          </label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <label class="field">
              <span>角色定位</span>
              <select name="role">
                <option value="worker" ${agent.role === "worker" ? "selected" : ""}>Worker (执行者)</option>
                <option value="leader" ${agent.role === "leader" ? "selected" : ""}>Leader (协调调度者)</option>
              </select>
            </label>
            <label class="field">
              <span>审批策略</span>
              <select name="approval_policy">
                <option value="never" ${agent.approval_policy === "never" ? "selected" : ""}>never (自动执行)</option>
                <option value="risk" ${agent.approval_policy === "risk" ? "selected" : ""}>risk (高危命令需确认)</option>
                <option value="always" ${agent.approval_policy === "always" ? "selected" : ""}>always (每次均需签名审批)</option>
              </select>
            </label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <label class="field">
              <span>默认模型</span>
              <input type="text" name="default_model" value="${escapeHtml(agent.default_model || "")}" placeholder="如 claude-sonnet-4-5" />
            </label>
            <label class="field">
              <span>技能标签（逗号分隔）</span>
              <input type="text" name="skills" value="${escapeHtml((agent.skills || []).join(", "))}" />
            </label>
          </div>

          ${
            !isDeviceWorker
              ? `
            <label class="field">
              <span>Webhook 回调 URL（可选，新任务门铃通知）</span>
              <input type="url" name="webhook_url" value="${escapeHtml(agent.webhook_url || "")}" placeholder="https://..." />
            </label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <label class="field">
                <span>Webhook 签名密钥（留空保持不变）</span>
                <input type="password" name="webhook_secret" placeholder="${agent.webhook_has_secret ? "已设置 (" + escapeHtml(agent.webhook_secret_masked) + ")" : "未设置"}" />
              </label>
              <label class="field">
                <span>签名请求头</span>
                <input type="text" name="webhook_header" value="${escapeHtml(agent.webhook_header || "X-A2A-Signature")}" />
              </label>
            </div>
          `
              : agent.is_local_worker
                ? `
            <label class="field">
              <span>工作目录 cwd（Hub 本机 Worker，保存后写入 workers.json）</span>
              <input type="text" name="cwd" value="${escapeHtml(agent.worker_config?.cwd || "~")}" />
            </label>
            <label class="field">
              <span>执行命令模板</span>
              <input type="text" name="command" value="${escapeHtml(agent.worker_config?.command || "")}" />
            </label>
            <label class="field">
              <span>续接会话命令模板（可选）</span>
              <input type="text" name="resume_command" value="${escapeHtml(agent.worker_config?.resume_command || "")}" placeholder="含 {session} 占位符" />
            </label>
          `
                : `
            <div class="card" style="padding:12px;background:var(--bg)">
              <div style="font-weight:600;margin-bottom:4px">所属设备：${escapeHtml(parentDev?.name || agent.device_id)}</div>
              <div class="muted" style="font-size:12px">远端 CLI Worker 的执行命令与工作目录由该电脑上的 workers.json 本地管理（系统参数 ${escapeHtml(parentDev?.os_info || "-")}，并发 ${parentDev?.max_concurrent || 4}）。</div>
            </div>
          `
          }

          <div class="row-between">
            <button type="submit" class="btn btn-primary">保存配置</button>
            <div class="row">
              ${!isDeviceWorker && agent.webhook_url ? `<button type="button" class="btn btn-secondary btn-sm" id="drawer-test-webhook">测试 Webhook</button>` : ""}
              <button type="button" class="btn btn-danger btn-sm" id="drawer-delete-agent">删除</button>
            </div>
          </div>
        </form>

        ${
          !isDeviceWorker
            ? `
          <div class="section-header" style="margin-top:20px">
            <h3 style="margin:0;font-size:14px">连接凭据与接入提示词</h3>
            <div class="row">
              <button class="btn btn-secondary btn-sm" id="drawer-view-onboarding">查看提示词</button>
              <button class="btn btn-secondary btn-sm" id="drawer-rotate-token">重新生成 Token</button>
            </div>
          </div>
          <div class="muted mono">当前 Token 前缀：${escapeHtml(agent.token_prefix || "无")}</div>
          <div id="drawer-onboarding-box" class="stack-sm hidden" style="margin-top:10px"></div>
        `
            : ""
        }

        <div class="section-header" style="margin-top:22px">
          <h3 style="margin:0;font-size:14px">最近任务</h3>
          <button class="btn btn-sm btn-primary" id="drawer-dispatch-btn">向它派任务</button>
        </div>
        ${
          tasks.length
            ? `<div class="stack-sm">${tasks
                .map(
                  (t) => {
                    const isResolvedFail = (t.state === "failed" || t.state === "rejected") && Boolean(t.resolved_at);
                    return `
              <div class="card" style="padding:10px 12px;cursor:pointer" data-jump-thread="${escapeHtml(t.context_id)}">
                <div class="row-between">
                  <span class="truncate" style="font-weight:550">${escapeHtml(t.title)}</span>
                  <span class="pill ${isResolvedFail ? "" : stateTone(t.state)}">${stateLabel(t.state)}${isResolvedFail ? " · 已处理" : ""}</span>
                </div>
                <div class="muted" style="font-size:11px;margin-top:3px">${formatRelativeTime(t.updated_at)} · <span class="mono">${escapeHtml(t.id)}</span></div>
              </div>
            `;
                  }
                )
                .join("")}</div>`
            : `<div class="empty-box" style="padding:16px">暂无分配给该 Agent 的任务</div>`
        }
      </aside>
    </div>
  `;

  bindBackdropClose(root.querySelector("[data-drawer-backdrop]"), () => {
    setState({ selectedAgentId: null });
  });
  root.querySelector("#drawer-close-btn")?.addEventListener("click", () => setState({ selectedAgentId: null }));

  root.querySelector("#drawer-toggle-enabled")?.addEventListener("click", async () => {
    try {
      await api.updateAgent(agent.id, { enabled: !agent.enabled });
      showToast(agent.enabled ? "已暂停该 Agent" : "已恢复启用");
      await refreshFn();
      renderAgentDrawer(root, refreshFn);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  root.querySelector("#drawer-dispatch-btn")?.addEventListener("click", () => {
    setState({
      selectedAgentId: null,
      showDispatchModal: true,
      dispatchPreselect: [agent.id],
      dispatchContextId: "",
    });
  });

  root.querySelector("#drawer-agent-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const patch = {
      name: String(fd.get("name") || "").trim(),
      summary: String(fd.get("summary") || "").trim(),
      note: String(fd.get("note") || "").trim(),
      role: String(fd.get("role") || "worker"),
      approval_policy: String(fd.get("approval_policy") || "never"),
      default_model: String(fd.get("default_model") || "").trim(),
      skills: String(fd.get("skills") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
    if (!isDeviceWorker) {
      patch.webhook_url = String(fd.get("webhook_url") || "").trim();
      patch.webhook_header = String(fd.get("webhook_header") || "X-A2A-Signature").trim();
      const sec = String(fd.get("webhook_secret") || "");
      if (sec) patch.webhook_secret = sec;
    } else if (agent.is_local_worker) {
      patch.cwd = String(fd.get("cwd") || "").trim();
      patch.command = String(fd.get("command") || "").trim();
      patch.resume_command = String(fd.get("resume_command") || "").trim();
    }
    try {
      await api.updateAgent(agent.id, patch);
      showToast("已保存配置");
      await refreshFn();
      renderAgentDrawer(root, refreshFn);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  root.querySelector("#drawer-test-webhook")?.addEventListener("click", async () => {
    try {
      const res = await api.testWebhook(agent.id);
      showToast(`Webhook 测试成功（HTTP ${res.result?.status || 200}，耗时 ${res.result?.latency_ms || 0}ms）`);
    } catch (err) {
      showToast(`Webhook 测试失败：${err.message}`, true);
    }
  });

  root.querySelector("#drawer-delete-agent")?.addEventListener("click", async () => {
    if (!confirm(`确认删除 Agent「${agent.name}」吗？历史任务与消息仍将保留在 Thread 中。`)) return;
    try {
      await api.deleteAgent(agent.id);
      setState({ selectedAgentId: null });
      showToast("已删除 Agent");
      await refreshFn();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  let drawerConnectMode = "http";
  let drawerMcpTab = "http_json";

  const getMcpSnippet = (mcp, tab) => {
    if (!mcp) return "";
    if (tab === "npx_json") return mcp.npx_json || "";
    if (tab === "stdio_json") return mcp.stdio_json || "";
    if (tab === "gemini_cli") return mcp.cli_commands?.gemini || "";
    if (tab === "claude_cli") return mcp.cli_commands?.claude || "";
    return mcp.http_json || "";
  };

  const renderPromptBox = (promptText, token = "", mcpOnboarding = null) => {
    const box = root.querySelector("#drawer-onboarding-box");
    if (!box) return;
    box.classList.remove("hidden");
    const isMcp = Boolean(mcpOnboarding && drawerConnectMode === "mcp");
    const activePrompt = isMcp ? mcpOnboarding.mcp_prompt : promptText;
    const mcpCfgText = isMcp ? getMcpSnippet(mcpOnboarding, drawerMcpTab) : "";

    box.innerHTML = `
      ${token ? `<div class="pill pill-warning">新 Token（仅显示本次）：<span class="mono">${escapeHtml(token)}</span></div>` : ""}
      ${
        mcpOnboarding
          ? `<div class="filter-bar">
              <button type="button" class="filter-chip ${drawerConnectMode === "http" ? "active" : ""}" data-drawer-connect="http">🌐 HTTP 提示词${mcpOnboarding.preferred_connect === "http" ? " · 推荐" : ""}</button>
              <button type="button" class="filter-chip ${drawerConnectMode === "mcp" ? "active" : ""}" data-drawer-connect="mcp">🔌 MCP 原生接入${mcpOnboarding.preferred_connect === "mcp" ? " · 推荐" : ""}</button>
            </div>`
          : ""
      }
      ${
        isMcp
          ? `<div class="card stack-sm" style="padding:10px;background:var(--bg)">
              <div class="row-between">
                <span class="muted" style="font-size:11px">步骤 1：客户端 MCP 挂载配置（凭据隔离）</span>
                <button type="button" class="btn btn-secondary btn-sm" id="drawer-copy-mcp-cfg">复制 MCP 配置</button>
              </div>
              <div class="filter-bar">
                <button type="button" class="filter-chip ${drawerMcpTab === "http_json" ? "active" : ""}" data-drawer-mcp-tab="http_json">HTTP 直连</button>
                <button type="button" class="filter-chip ${drawerMcpTab === "npx_json" ? "active" : ""}" data-drawer-mcp-tab="npx_json">npx 免安装</button>
                <button type="button" class="filter-chip ${drawerMcpTab === "stdio_json" ? "active" : ""}" data-drawer-mcp-tab="stdio_json">本机 ah mcp</button>
                <button type="button" class="filter-chip ${drawerMcpTab === "gemini_cli" ? "active" : ""}" data-drawer-mcp-tab="gemini_cli">Gemini CLI</button>
                <button type="button" class="filter-chip ${drawerMcpTab === "claude_cli" ? "active" : ""}" data-drawer-mcp-tab="claude_cli">Claude CLI</button>
              </div>
              <div class="code-box" style="max-height:130px">${escapeHtml(mcpCfgText)}</div>
            </div>`
          : ""
      }
      <div class="code-box">${escapeHtml(activePrompt)}</div>
      <button type="button" class="btn btn-primary btn-sm" id="drawer-copy-prompt">${isMcp ? "复制 MCP 脱敏激活提示词" : "复制完整接入提示词"}</button>
    `;
    box.querySelectorAll("[data-drawer-connect]").forEach((btn) => {
      btn.addEventListener("click", () => {
        drawerConnectMode = btn.getAttribute("data-drawer-connect") || "http";
        renderPromptBox(promptText, token, mcpOnboarding);
      });
    });
    box.querySelectorAll("[data-drawer-mcp-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        drawerMcpTab = btn.getAttribute("data-drawer-mcp-tab") || "http_json";
        renderPromptBox(promptText, token, mcpOnboarding);
      });
    });
    box.querySelector("#drawer-copy-mcp-cfg")?.addEventListener("click", () => copyText(mcpCfgText, "已复制 MCP 配置"));
    box.querySelector("#drawer-copy-prompt")?.addEventListener("click", () => copyText(activePrompt, "已复制接入提示词"));
  };

  root.querySelector("#drawer-view-onboarding")?.addEventListener("click", async () => {
    try {
      const r = await api.agentOnboarding(agent.id);
      drawerConnectMode = r.mcp_onboarding?.preferred_connect || "http";
      renderPromptBox(r.onboarding_prompt, "", r.mcp_onboarding || null);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  root.querySelector("#drawer-rotate-token")?.addEventListener("click", async () => {
    if (!confirm("重新生成 Token 会立即使旧 Token 失效，确定继续？")) return;
    try {
      const r = await api.rotateAgentToken(agent.id);
      drawerConnectMode = r.mcp_onboarding?.preferred_connect || "http";
      renderPromptBox(r.onboarding_prompt, r.token, r.mcp_onboarding || null);
      showToast("已生成新 Token 并更新接入提示词");
      await refreshFn();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  root.querySelectorAll("[data-jump-thread]").forEach((el) => {
    el.addEventListener("click", () => {
      setState({
        selectedAgentId: null,
        activeTab: "threads",
        selectedThreadId: el.getAttribute("data-jump-thread"),
      });
    });
  });
}
