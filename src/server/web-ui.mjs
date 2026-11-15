// LobeHub + LoopForge 风格内置 Web 控制台（零外部构建依赖、无外网 CDN 依赖，局域网/离线可用）。

export function renderWebConsoleHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Lobe-A2A-Hub · 独立多 Agent 编排中台</title>
<style>
  :root {
    --bg: #0b0d14;
    --panel: #121622;
    --panel-2: #181d2d;
    --border: rgba(255,255,255,0.08);
    --border-strong: rgba(255,255,255,0.16);
    --text: #eef1f7;
    --muted: #8b95ab;
    --accent: #6366f1;
    --accent-2: #3b82f6;
    --green: #10b981;
    --amber: #f59e0b;
    --red: #ef4444;
    --purple: #a855f7;
    --cyan: #06b6d4;
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif; font-size: 14px; }
  button, input, textarea, select { font: inherit; color: inherit; }
  a { color: #818cf8; text-decoration: none; }
  .app { display: grid; grid-template-columns: 230px 1fr; height: 100vh; overflow: hidden; }
  .sidebar { background: #0f121c; border-right: 1px solid var(--border); display: flex; flex-direction: column; padding: 18px 14px; gap: 16px; }
  .brand { display: flex; align-items: center; gap: 10px; padding: 4px 6px; }
  .brand-logo { width: 34px; height: 34px; border-radius: 10px; background: linear-gradient(135deg, #6366f1, #06b6d4); display: grid; place-items: center; font-weight: 800; font-size: 15px; color: #fff; box-shadow: 0 4px 14px rgba(99,102,241,0.35); }
  .brand-title { font-weight: 700; font-size: 15px; letter-spacing: 0.2px; }
  .brand-sub { font-size: 11px; color: var(--muted); }
  .nav { display: flex; flex-direction: column; gap: 6px; }
  .nav-btn { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-radius: 10px; border: 1px solid transparent; background: transparent; cursor: pointer; color: var(--muted); text-align: left; transition: all .15s; }
  .nav-btn:hover { background: rgba(255,255,255,0.04); color: var(--text); }
  .nav-btn.active { background: rgba(99,102,241,0.16); border-color: rgba(99,102,241,0.35); color: #fff; font-weight: 600; }
  .badge { padding: 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; background: rgba(255,255,255,0.1); }
  .badge.amber { background: rgba(245,158,11,0.2); color: #fbbf24; }
  .badge.green { background: rgba(16,185,129,0.2); color: #34d399; }
  .badge.red { background: rgba(239,68,68,0.2); color: #f87171; }
  .badge.indigo { background: rgba(99,102,241,0.22); color: #a5b4fc; }
  .sidebar-footer { margin-top: auto; display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); }
  .conn-pill { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; background: var(--panel); border: 1px solid var(--border); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex-shrink: 0; }
  .dot.on { background: var(--green); box-shadow: 0 0 8px var(--green); }
  .dot.err { background: var(--red); }

  .main { display: flex; flex-direction: column; overflow: hidden; }
  .topbar { height: 58px; border-bottom: 1px solid var(--border); padding: 0 22px; display: flex; align-items: center; justify-content: space-between; background: rgba(15,18,28,0.85); backdrop-filter: blur(8px); flex-shrink: 0; }
  .topbar-title { font-size: 16px; font-weight: 650; display: flex; align-items: center; gap: 10px; }
  .topbar-actions { display: flex; align-items: center; gap: 10px; }
  .btn { padding: 8px 14px; border-radius: 9px; border: 1px solid var(--border-strong); background: var(--panel-2); cursor: pointer; font-weight: 500; transition: all .15s; display: inline-flex; align-items: center; gap: 6px; }
  .btn:hover { border-color: rgba(255,255,255,0.28); background: #21283d; }
  .btn.primary { background: linear-gradient(135deg, var(--accent), var(--accent-2)); border-color: transparent; color: #fff; }
  .btn.primary:hover { filter: brightness(1.08); }
  .btn.success { background: rgba(16,185,129,0.18); border-color: rgba(16,185,129,0.45); color: #34d399; }
  .btn.danger { background: rgba(239,68,68,0.16); border-color: rgba(239,68,68,0.45); color: #f87171; }
  .btn.sm { padding: 5px 10px; font-size: 12px; border-radius: 7px; }

  .content { flex: 1; overflow-y: auto; padding: 20px 22px; }
  .grid-4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; margin-bottom: 20px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
  .stat-label { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .stat-val { font-size: 26px; font-weight: 750; letter-spacing: -0.5px; }
  .section-title { font-size: 14px; font-weight: 650; margin: 18px 0 10px; display: flex; align-items: center; justify-content: space-between; }

  .pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; border: 1px solid transparent; }
  .st-submitted { background: rgba(59,130,246,0.16); color: #60a5fa; border-color: rgba(59,130,246,0.3); }
  .st-working { background: rgba(6,182,212,0.16); color: #22d3ee; border-color: rgba(6,182,212,0.3); }
  .st-input-required { background: rgba(168,85,247,0.18); color: #c084fc; border-color: rgba(168,85,247,0.35); }
  .st-auth-required { background: rgba(245,158,11,0.2); color: #fbbf24; border-color: rgba(245,158,11,0.4); }
  .st-completed { background: rgba(16,185,129,0.16); color: #34d399; border-color: rgba(16,185,129,0.3); }
  .st-failed, .st-rejected { background: rgba(239,68,68,0.16); color: #f87171; border-color: rgba(239,68,68,0.3); }
  .st-canceled { background: rgba(148,163,184,0.15); color: #94a3b8; border-color: rgba(148,163,184,0.25); }
  .st-running { background: rgba(99,102,241,0.2); color: #a5b4fc; border-color: rgba(99,102,241,0.4); }

  .agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; }
  .agent-card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 15px; display: flex; flex-direction: column; gap: 10px; transition: border-color .15s; }
  .agent-card:hover { border-color: rgba(99,102,241,0.45); }
  .agent-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
  .agent-name { font-weight: 650; font-size: 15px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .muted { color: var(--muted); }

  .tasks-split { display: grid; grid-template-columns: 360px 1fr; gap: 16px; height: calc(100vh - 122px); }
  .task-list-col { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); display: flex; flex-direction: column; overflow: hidden; }
  .task-filters { padding: 10px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
  .chip-row { display: flex; flex-wrap: wrap; gap: 5px; }
  .chip { padding: 3px 8px; border-radius: 999px; border: 1px solid var(--border); background: transparent; font-size: 11px; color: var(--muted); cursor: pointer; }
  .chip.active { background: rgba(99,102,241,0.22); border-color: rgba(99,102,241,0.5); color: #fff; }
  .task-items { flex: 1; overflow-y: auto; }
  .task-item { padding: 12px 14px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background .12s; }
  .task-item:hover { background: rgba(255,255,255,0.03); }
  .task-item.selected { background: rgba(99,102,241,0.12); border-left: 3px solid var(--accent); }
  .task-detail-col { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 14px; }

  .msg-list { display: flex; flex-direction: column; gap: 10px; }
  .msg-bubble { border-radius: 10px; padding: 12px 14px; border: 1px solid var(--border); background: var(--panel-2); }
  .msg-bubble.user { border-left: 3px solid var(--accent); }
  .msg-bubble.agent { border-left: 3px solid var(--cyan); }
  .msg-bubble.auth { border-left: 3px solid var(--amber); background: rgba(245,158,11,0.06); }
  .msg-head { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .msg-body { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
  .data-box { margin-top: 8px; padding: 8px 10px; background: rgba(0,0,0,0.3); border-radius: 8px; font-family: ui-monospace, monospace; font-size: 12px; overflow-x: auto; white-space: pre-wrap; }

  .action-banner { padding: 14px; border-radius: 10px; border: 1px solid rgba(245,158,11,0.45); background: rgba(245,158,11,0.09); display: flex; flex-direction: column; gap: 10px; }
  .action-banner.ask { border-color: rgba(168,85,247,0.45); background: rgba(168,85,247,0.09); }

  .loop-stages { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
  .stage-node { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel-2); font-size: 12px; display: flex; align-items: center; gap: 6px; }
  .stage-node.current { border-color: var(--accent); background: rgba(99,102,241,0.18); }
  .stage-node.done { border-color: rgba(16,185,129,0.5); color: #34d399; }
  .stage-arrow { color: var(--muted); font-size: 12px; }

  .input { width: 100%; padding: 8px 11px; border-radius: 8px; border: 1px solid var(--border-strong); background: #0c0f18; color: var(--text); outline: none; }
  .input:focus { border-color: var(--accent); }
  textarea.input { min-height: 84px; resize: vertical; }
  .form-row { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
  .form-row label { font-size: 12px; color: var(--muted); font-weight: 500; }

  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.65); backdrop-filter: blur(4px); display: none; align-items: center; justify-content: center; z-index: 50; padding: 16px; }
  .modal-backdrop.open { display: flex; }
  .modal { width: 100%; max-width: 580px; max-height: 90vh; overflow-y: auto; background: var(--panel); border: 1px solid var(--border-strong); border-radius: 14px; padding: 20px; box-shadow: 0 20px 50px rgba(0,0,0,0.55); }
  .modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; font-size: 16px; font-weight: 700; }
  .toast { position: fixed; right: 20px; bottom: 20px; z-index: 80; padding: 10px 14px; border-radius: 10px; background: #1e293b; border: 1px solid var(--border-strong); box-shadow: 0 10px 25px rgba(0,0,0,0.4); display: none; }
  .toast.show { display: block; }
  @media (max-width: 900px) {
    .app { grid-template-columns: 1fr; }
    .sidebar { display: none; }
    .tasks-split { grid-template-columns: 1fr; height: auto; }
  }
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-logo">LA</div>
      <div>
        <div class="brand-title">Lobe-A2A-Hub</div>
        <div class="brand-sub" id="hubNodeLabel">Independent Control Plane</div>
      </div>
    </div>
    <nav class="nav">
      <button class="nav-btn active" data-view="overview">
        <span>总览与终端拓扑</span>
        <span class="badge green" id="navOnlineCount">0</span>
      </button>
      <button class="nav-btn" data-view="agents">
        <span>Agent 名片墙</span>
        <span class="badge" id="navAgentCount">0</span>
      </button>
      <button class="nav-btn" data-view="tasks">
        <span>任务与对话流</span>
        <span class="badge amber" id="navActionCount">0</span>
      </button>
      <button class="nav-btn" data-view="loops">
        <span>LoopForge SOP</span>
        <span class="badge indigo" id="navLoopCount">0</span>
      </button>
    </nav>
    <div class="sidebar-footer">
      <div class="conn-pill">
        <span class="dot" id="pollDot"></span>
        <div>
          <div id="pollText" style="color:var(--text);font-weight:500;">连接中...</div>
          <div id="seqText" class="mono">seq: -</div>
        </div>
      </div>
      <button class="btn sm" id="btnToken">API Token 设置</button>
    </div>
  </aside>

  <main class="main">
    <header class="topbar">
      <div class="topbar-title" id="viewTitle">总览与终端拓扑</div>
      <div class="topbar-actions">
        <button class="btn sm" id="btnRefresh">刷新</button>
        <button class="btn sm" id="btnNewLoop">+ 新建 SOP 闭环</button>
        <button class="btn sm primary" id="btnNewTask">+ 派发新任务</button>
      </div>
    </header>
    <section class="content" id="content"></section>
  </main>
</div>

<!-- New Task Modal -->
<div class="modal-backdrop" id="taskModal">
  <div class="modal">
    <div class="modal-head">
      <span>派发 A2A 任务</span>
      <button class="btn sm" onclick="closeModal('taskModal')">关闭</button>
    </div>
    <form id="taskForm">
      <div class="form-row">
        <label>目标节点 (--to)</label>
        <input class="input" name="to" id="tfTo" placeholder="例如 mac-mini / laptop" required />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div class="form-row">
          <label>能力 / Skill (--cap)</label>
          <input class="input" name="cap" id="tfCap" placeholder="例如 agent / codex / echo" />
        </div>
        <div class="form-row">
          <label>指定 Worker（可选）</label>
          <input class="input" name="worker" id="tfWorker" placeholder="留空由节点默认" />
        </div>
      </div>
      <div class="form-row">
        <label>任务指令 (--text)</label>
        <textarea class="input" name="text" id="tfText" placeholder="清晰描述任务目标与上下文..." required></textarea>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div class="form-row">
          <label>审批门禁</label>
          <select class="input" name="approval" id="tfApproval">
            <option value="">默认</option>
            <option value="auto">auto (自动执行)</option>
            <option value="notify">notify (通知)</option>
            <option value="approve">approve (需机主审批)</option>
          </select>
        </div>
        <div class="form-row">
          <label>Context_ID（可选，串联上下文）</label>
          <input class="input" name="context" id="tfContext" placeholder="留空自动生成" />
        </div>
      </div>
      <div class="form-row">
        <label>验收清单 JSON（可选，[{id, text, evidence_required}])</label>
        <input class="input mono" name="criteria" id="tfCriteria" placeholder='[{"id":"test","text":"测试通过","evidence_required":true}]' />
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">
        <button type="button" class="btn" onclick="closeModal('taskModal')">取消</button>
        <button type="submit" class="btn primary">立即派发</button>
      </div>
    </form>
  </div>
</div>

<!-- New Loop Modal -->
<div class="modal-backdrop" id="loopModal">
  <div class="modal">
    <div class="modal-head">
      <span>新建 LoopForge SOP 闭环</span>
      <button class="btn sm" onclick="closeModal('loopModal')">关闭</button>
    </div>
    <form id="loopForm">
      <div class="form-row">
        <label>SOP 模板</label>
        <select class="input" name="template" id="lfTemplate"></select>
      </div>
      <div class="form-row">
        <label>目标描述 (Goal)</label>
        <textarea class="input" name="goal" id="lfGoal" placeholder="描述希望多阶段闭环完成的目标..." required></textarea>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div class="form-row">
          <label>默认执行节点</label>
          <input class="input" name="to" id="lfTo" placeholder="例如 mac-mini" required />
        </div>
        <div class="form-row">
          <label>默认能力 (--cap)</label>
          <input class="input" name="cap" id="lfCap" value="agent" />
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div class="form-row">
          <label>指定 Worker（可选）</label>
          <input class="input" name="worker" id="lfWorker" placeholder="如 claude / codex" />
        </div>
        <div class="form-row">
          <label>最大迭代次数 (Max Iterations, 1-8)</label>
          <input class="input" type="number" name="maxIterations" id="lfMaxIter" value="5" min="1" max="8" />
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">
        <button type="button" class="btn" onclick="closeModal('loopModal')">取消</button>
        <button type="submit" class="btn primary">启动闭环</button>
      </div>
    </form>
  </div>
</div>

<!-- Token Modal -->
<div class="modal-backdrop" id="tokenModal">
  <div class="modal" style="max-width:420px;">
    <div class="modal-head">
      <span>API 访问令牌设置</span>
      <button class="btn sm" onclick="closeModal('tokenModal')">关闭</button>
    </div>
    <div class="form-row">
      <label>Bearer API Token（若服务端未启用鉴权可留空）</label>
      <input class="input mono" type="password" id="tokenInput" placeholder="输入 node.json 中的 apiToken" />
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px;">
      <button class="btn" onclick="closeModal('tokenModal')">取消</button>
      <button class="btn primary" id="saveTokenBtn">保存并重连</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const state = {
  view: "overview",
  data: null,
  selectedTaskId: null,
  selectedTaskDetail: null,
  statusFilter: "ALL",
  search: "",
  cursor: 0,
  token: localStorage.getItem("lobe_a2a_token") || "",
  templates: [],
};

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 3200);
}

function openModal(id) { document.getElementById(id).classList.add("open"); }
function closeModal(id) { document.getElementById(id).classList.remove("open"); }

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (state.token) headers.Authorization = "Bearer " + state.token;
  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const r = await fetch(path, Object.assign({}, opts, { headers }));
  if (r.status === 401) {
    document.getElementById("tokenInput").value = state.token;
    openModal("tokenModal");
    throw new Error("需要有效的 API Token");
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
  return d;
}

function pill(status) {
  const st = String(status || "unknown");
  return '<span class="pill st-' + esc(st) + '">' + esc(st) + '</span>';
}

async function refreshState() {
  try {
    const d = await api("/api/v1/state");
    state.data = d;
    if (d.seq != null && d.seq > state.cursor) state.cursor = d.seq;
    document.getElementById("hubNodeLabel").textContent = "Hub: " + (d.hubNode || "hub");
    document.getElementById("seqText").textContent = "seq: " + (d.seq ?? 0);
    const online = (d.connectedNodes || []).filter((n) => n.online).length;
    document.getElementById("navOnlineCount").textContent = String(online);
    document.getElementById("navAgentCount").textContent = String((d.agentCards || []).length);
    const needAction = (d.tasks || []).filter((t) => t.status === "auth-required" || t.status === "input-required").length;
    document.getElementById("navActionCount").textContent = String(needAction);
    document.getElementById("navLoopCount").textContent = String((d.loops || []).filter((l) => l.status === "running").length);

    if (state.selectedTaskId) {
      await loadTaskDetail(state.selectedTaskId, true);
    }
    render();
  } catch (e) {
    showToast("拉取状态失败: " + e.message);
  }
}

async function loadTaskDetail(taskId, silent = false) {
  state.selectedTaskId = taskId;
  try {
    const detail = await api("/api/v1/tasks/" + encodeURIComponent(taskId));
    state.selectedTaskDetail = detail;
    if (!silent) render();
  } catch (e) {
    if (!silent) showToast("读取任务详情失败: " + e.message);
  }
}

async function decideApproval(taskId, decision) {
  try {
    const res = await api("/api/v1/approvals/" + encodeURIComponent(taskId) + "/decide", {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
    showToast(res.message || (decision === "approve" ? "已批准" : "已驳回"));
    await refreshState();
  } catch (e) {
    showToast("审批操作失败: " + e.message);
  }
}

async function replyTask(taskId) {
  const input = document.getElementById("replyTextBox");
  const text = input ? input.value.trim() : "";
  if (!text) return showToast("请输入答复内容");
  try {
    await api("/api/v1/tasks/" + encodeURIComponent(taskId) + "/reply", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    showToast("答复已送达总线，节点即将续跑");
    await refreshState();
  } catch (e) {
    showToast("发送答复失败: " + e.message);
  }
}

async function cancelTaskAction(taskId) {
  try {
    await api("/api/v1/tasks/" + encodeURIComponent(taskId) + "/cancel", {
      method: "POST",
      body: JSON.stringify({ text: "控制台手动取消" }),
    });
    showToast("任务已取消");
    await refreshState();
  } catch (e) {
    showToast("取消失败: " + e.message);
  }
}

async function cancelLoopAction(loopId) {
  try {
    await api("/api/v1/loops/" + encodeURIComponent(loopId) + "/cancel", {
      method: "POST",
      body: JSON.stringify({ text: "控制台终止闭环" }),
    });
    showToast("SOP 闭环已终止");
    await refreshState();
  } catch (e) {
    showToast("取消失败: " + e.message);
  }
}

function jumpToTask(taskId) {
  state.view = "tasks";
  syncNav();
  loadTaskDetail(taskId);
}

function openDispatchFor(node, worker, skill) {
  document.getElementById("tfTo").value = node || "";
  document.getElementById("tfWorker").value = worker || "";
  document.getElementById("tfCap").value = skill || "agent";
  openModal("taskModal");
}

function renderOverview(d) {
  const tasks = d.tasks || [];
  const active = tasks.filter((t) => t.status === "submitted" || t.status === "working").length;
  const authList = tasks.filter((t) => t.status === "auth-required");
  const askList = tasks.filter((t) => t.status === "input-required");
  const completed = tasks.filter((t) => t.status === "completed").length;
  const nodes = d.connectedNodes || [];
  const runningLoops = (d.loops || []).filter((l) => l.status === "running");

  let html = '<div class="grid-4">'
    + '<div class="card"><div class="stat-label">活跃运行中任务</div><div class="stat-val" style="color:#22d3ee">' + active + '</div></div>'
    + '<div class="card"><div class="stat-label">待机主审批</div><div class="stat-val" style="color:#fbbf24">' + authList.length + '</div></div>'
    + '<div class="card"><div class="stat-label">待补充答复</div><div class="stat-val" style="color:#c084fc">' + askList.length + '</div></div>'
    + '<div class="card"><div class="stat-label">长轮询在线终端</div><div class="stat-val" style="color:#34d399">' + nodes.filter((n) => n.online).length + ' / ' + nodes.length + '</div></div>'
    + '<div class="card"><div class="stat-label">已完成总单数</div><div class="stat-val">' + completed + '</div></div>'
    + '</div>';

  if (authList.length || askList.length) {
    html += '<div class="section-title"><span>需要人工介入处理</span></div>';
    html += '<div style="display:flex;flex-direction:column;gap:10px;margin-bottom:18px;">';
    for (const t of authList) {
      html += '<div class="action-banner">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">'
        + '<div><strong>' + esc(t.task_id) + '</strong> · ' + esc(t.title) + ' <span class="muted">(' + esc(t.target_node) + ' / ' + esc(t.skill_id) + ')</span></div>'
        + '<div style="display:flex;gap:8px;">'
        + '<button class="btn sm" onclick="jumpToTask(\\'' + esc(t.task_id) + '\\')">查看详情</button>'
        + '<button class="btn sm success" onclick="decideApproval(\\'' + esc(t.task_id) + '\\', \\'approve\\')">批准</button>'
        + '<button class="btn sm danger" onclick="decideApproval(\\'' + esc(t.task_id) + '\\', \\'reject\\')">驳回</button>'
        + '</div></div></div>';
    }
    for (const t of askList) {
      html += '<div class="action-banner ask">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">'
        + '<div><strong>' + esc(t.task_id) + '</strong> · ' + esc(t.title) + ' <span class="muted">(等待提问答复)</span></div>'
        + '<button class="btn sm primary" onclick="jumpToTask(\\'' + esc(t.task_id) + '\\')">前往答复</button>'
        + '</div></div>';
    }
    html += '</div>';
  }

  html += '<div class="section-title"><span>长轮询终端连接状态</span><span class="muted mono">HTTP Long-Polling · 零入站端口</span></div>';
  if (!nodes.length) {
    html += '<div class="card muted">暂无远程长轮询终端接入。请在远程机器使用 <span class="mono">lah setup --hub-url http://&lt;mac-mini-ip&gt;:8787</span> 接入。</div>';
  } else {
    html += '<div class="agent-grid">';
    for (const n of nodes) {
      const ago = Math.max(0, Math.round((Date.now() - n.lastSeenAt) / 1000));
      html += '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;">'
        + '<div style="display:flex;align-items:center;gap:8px;font-weight:650;"><span class="dot ' + (n.online ? 'on' : 'err') + '"></span>' + esc(n.node) + '</div>'
        + '<span class="badge ' + (n.online ? 'green' : 'red') + '">' + (n.polling ? '长轮询挂起中' : (n.online ? '在线' : '离线')) + '</span>'
        + '</div><div class="muted mono" style="margin-top:8px;">addr: ' + esc(n.remoteAddr || '-') + ' · cursor: ' + esc(n.cursor) + ' · ' + ago + 's 前</div></div>';
    }
    html += '</div>';
  }

  if (runningLoops.length) {
    html += '<div class="section-title"><span>进行中的 LoopForge SOP 闭环</span></div>';
    for (const l of runningLoops) {
      html += renderLoopCard(l);
    }
  }
  return html;
}

function renderAgents(d) {
  const cards = d.agentCards || [];
  if (!cards.length) {
    return '<div class="card muted">尚未登记任何 Agent 名片。启动 Hub 或接入节点后将自动同步 AgentCards。</div>';
  }
  const byNode = new Map();
  for (const c of cards) {
    const n = c.node || "unknown";
    if (!byNode.has(n)) byNode.set(n, []);
    byNode.get(n).push(c);
  }
  let html = "";
  for (const [node, list] of byNode.entries()) {
    const nodeDesc = list.find((x) => x.node_desc)?.node_desc || "";
    const ver = list.find((x) => x.daemon_version)?.daemon_version || "";
    html += '<div class="section-title"><span>节点：' + esc(node) + ' <span class="muted" style="font-weight:400;margin-left:8px;">' + esc(nodeDesc) + '</span></span>'
      + '<span class="mono muted">' + esc(ver) + ' · ' + list.length + ' 项能力</span></div>';
    html += '<div class="agent-grid">';
    for (const c of list) {
      const online = String(c.availability || "").toLowerCase() !== "offline";
      const dispatchable = c.dispatchable === "Yes";
      html += '<div class="agent-card">'
        + '<div class="agent-head">'
        + '<div><div class="agent-name">' + esc(c.skill_name || c.skill_id) + '</div><div class="mono muted">' + esc(c.cap_id) + '</div></div>'
        + '<span class="badge ' + (online ? 'green' : 'red') + '">' + esc(c.availability || 'unknown') + '</span>'
        + '</div>'
        + '<div class="muted" style="min-height:34px;">' + esc(c.description || "无说明") + '</div>'
        + '<div style="display:flex;flex-wrap:wrap;gap:6px;">'
        + (c.worker ? '<span class="badge indigo">Worker: ' + esc(c.worker) + '</span>' : '<span class="badge">节点本尊</span>')
        + '<span class="badge">Skill: ' + esc(c.skill_id) + '</span>'
        + '<span class="badge">SideEffect: ' + esc(c.side_effect || "-") + '</span>'
        + '<span class="badge">' + esc(c.receive_mode || "event") + '</span>'
        + '</div>'
        + '<div style="display:flex;justify-content:flex-end;margin-top:auto;">'
        + (dispatchable
          ? '<button class="btn sm primary" onclick="openDispatchFor(\\'' + esc(c.node) + '\\',\\'' + esc(c.worker) + '\\',\\'' + esc(c.skill_id) + '\\')">向此能力派单</button>'
          : '<span class="muted" style="font-size:12px;">已停派 (Dispatchable=No)</span>')
        + '</div></div>';
    }
    html += '</div>';
  }
  return html;
}

function renderTasks(d) {
  const tasks = d.tasks || [];
  const statuses = ["ALL", "auth-required", "input-required", "working", "submitted", "completed", "failed", "canceled"];
  const filtered = tasks.filter((t) => {
    if (state.statusFilter !== "ALL" && t.status !== state.statusFilter) return false;
    if (state.search) {
      const q = state.search.toLowerCase();
      return (t.task_id + " " + t.title + " " + t.target_node + " " + t.skill_id).toLowerCase().includes(q);
    }
    return true;
  });

  let listHtml = '<div class="task-list-col">'
    + '<div class="task-filters">'
    + '<input class="input" id="taskSearchInput" placeholder="搜索 Task_ID / 标题 / 节点..." value="' + esc(state.search) + '" />'
    + '<div class="chip-row">';
  for (const st of statuses) {
    listHtml += '<button class="chip ' + (state.statusFilter === st ? 'active' : '') + '" onclick="setFilter(\\'' + st + '\\')">' + st + '</button>';
  }
  listHtml += '</div></div><div class="task-items">';
  if (!filtered.length) {
    listHtml += '<div class="muted" style="padding:20px;text-align:center;">暂无匹配任务</div>';
  } else {
    for (const t of filtered) {
      const sel = state.selectedTaskId === t.task_id ? " selected" : "";
      listHtml += '<div class="task-item' + sel + '" onclick="loadTaskDetail(\\'' + esc(t.task_id) + '\\')">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">'
        + '<span class="mono" style="font-weight:650;">' + esc(t.task_id) + '</span>'
        + pill(t.status)
        + '</div>'
        + '<div style="font-weight:500;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(t.title) + '</div>'
        + '<div class="muted mono" style="font-size:11px;">' + esc(t.target_node) + ' · ' + esc(t.worker_hint ? t.worker_hint + '/' + t.skill_id : t.skill_id) + ' · hop:' + esc(t.hop_count || 0) + '</div>'
        + '</div>';
    }
  }
  listHtml += '</div></div>';

  let detailHtml = '<div class="task-detail-col">';
  const det = state.selectedTaskDetail;
  if (!det || !det.task) {
    detailHtml += '<div class="muted" style="margin:auto;">请从左侧选择一条任务查看 A2A 对话流、验收结果与执行台账</div>';
  } else {
    const t = det.task;
    detailHtml += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-bottom:1px solid var(--border);padding-bottom:12px;">'
      + '<div><div style="display:flex;align-items:center;gap:10px;"><span class="mono" style="font-size:16px;font-weight:700;">' + esc(t.task_id) + '</span>' + pill(t.status) + '</div>'
      + '<div style="margin-top:6px;font-size:15px;font-weight:600;">' + esc(t.title) + '</div>'
      + '<div class="muted mono" style="margin-top:6px;font-size:12px;">Target: ' + esc(t.target_node) + ' | Worker: ' + esc(t.worker_hint || "daemon") + ' | Skill: ' + esc(t.skill_id) + ' | Context: ' + esc(t.context_id) + ' | Hop: ' + esc(t.hop_count || 0) + '</div></div>'
      + (!["completed","failed","canceled","rejected"].includes(t.status)
        ? '<button class="btn sm danger" onclick="cancelTaskAction(\\'' + esc(t.task_id) + '\\')">取消任务</button>'
        : '')
      + '</div>';

    if (t.status === "auth-required") {
      detailHtml += '<div class="action-banner">'
        + '<div style="font-weight:650;">⏸ 等待机主审批确认 (ed25519 签名)</div>'
        + '<div class="muted">批准后 Hub 将自动用私钥签发 auth_decision 并毫秒级唤醒目标节点。</div>'
        + '<div style="display:flex;gap:10px;">'
        + '<button class="btn success" onclick="decideApproval(\\'' + esc(t.task_id) + '\\', \\'approve\\')">✓ 批准执行</button>'
        + '<button class="btn danger" onclick="decideApproval(\\'' + esc(t.task_id) + '\\', \\'reject\\')">✕ 驳回并取消</button>'
        + '</div></div>';
    }

    if (t.status === "input-required") {
      detailHtml += '<div class="action-banner ask">'
        + '<div style="font-weight:650;">❓ 节点正在等待补充信息</div>'
        + '<textarea class="input" id="replyTextBox" placeholder="输入答复内容，提交后节点将自动从断点续跑..."></textarea>'
        + '<div style="display:flex;justify-content:flex-end;">'
        + '<button class="btn primary" onclick="replyTask(\\'' + esc(t.task_id) + '\\')">发送答复并续跑</button>'
        + '</div></div>';
    }

    detailHtml += '<div class="section-title" style="margin:4px 0;"><span>A2A 消息对话流 (' + (det.messages || []).length + ')</span></div><div class="msg-list">';
    for (const m of (det.messages || [])) {
      const cls = m.kind.startsWith("auth") ? "auth" : (m.role === "user" ? "user" : "agent");
      detailHtml += '<div class="msg-bubble ' + cls + '">'
        + '<div class="msg-head"><span><strong>' + esc(m.kind) + '</strong> · ' + esc(m.from_node) + ' → ' + esc(m.to_node) + ' (' + esc(m.role) + ')</span><span class="mono">' + esc(m.msg_id) + ' · ' + esc(m.created_at) + '</span></div>';
      for (const p of (m.parts || [])) {
        if (p.kind === "text" && p.text) {
          detailHtml += '<div class="msg-body">' + esc(p.text) + '</div>';
        } else if (p.kind === "file") {
          detailHtml += '<div class="data-box">📎 File: ' + esc(p.file_name || p.file_uri) + ' (' + esc(p.file_uri) + ')</div>';
        } else if (p.kind === "data" && p.data) {
          detailHtml += '<div class="data-box">' + esc(p.data) + '</div>';
        }
      }
      detailHtml += '</div>';
    }
    detailHtml += '</div>';

    if (det.runs && det.runs.length) {
      detailHtml += '<div class="section-title" style="margin:6px 0 2px;"><span>Runs 执行台账 (' + det.runs.length + ')</span></div>';
      for (const r of det.runs) {
        detailHtml += '<div class="card mono" style="padding:10px 12px;font-size:12px;">'
          + '<div>' + esc(r.run_id) + ' · node=' + esc(r.node) + ' · worker=' + esc(r.worker) + ' · outcome=<strong>' + esc(r.outcome) + '</strong></div>'
          + '<div class="muted">' + esc(r.started_at) + ' → ' + esc(r.finished_at || "-") + '</div>'
          + (r.error_log ? '<div style="color:#f87171;margin-top:4px;white-space:pre-wrap;">' + esc(r.error_log) + '</div>' : '')
          + '</div>';
      }
    }

    if (det.artifacts && det.artifacts.length) {
      detailHtml += '<div class="section-title" style="margin:6px 0 2px;"><span>Artifacts 交付产物 (' + det.artifacts.length + ')</span></div>';
      for (const a of det.artifacts) {
        detailHtml += '<div class="card" style="padding:10px 12px;">'
          + '<div><strong>' + esc(a.name) + '</strong> <span class="mono muted">' + esc(a.artifact_id) + '</span></div>'
          + '<div class="muted">' + esc(a.description) + '</div>'
          + (a.files || []).map((f) => '<div class="mono" style="margin-top:4px;">📄 ' + esc(f.file_uri) + '</div>').join("")
          + '</div>';
      }
    }
  }
  detailHtml += '</div>';
  return '<div class="tasks-split">' + listHtml + detailHtml + '</div>';
}

function renderLoopCard(l) {
  const stages = l.stages || [];
  let stageHtml = '<div class="loop-stages">';
  stages.forEach((s, idx) => {
    const cls = l.status === "completed" || idx < l.stage_index ? "done" : (idx === l.stage_index && l.status === "running" ? "current" : "");
    stageHtml += '<div class="stage-node ' + cls + '"><span>' + esc(s.name || s.id) + '</span><span class="mono muted">(' + esc(s.to || s.cap) + ')</span></div>';
    if (idx < stages.length - 1) stageHtml += '<span class="stage-arrow">→</span>';
  });
  stageHtml += '</div>';

  return '<div class="card" style="margin-bottom:12px;">'
    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">'
    + '<div><div style="display:flex;align-items:center;gap:8px;"><strong class="mono">' + esc(l.loop_id) + '</strong>' + pill(l.status) + '<span class="badge">iter ' + esc(l.iteration) + '/' + esc(l.max_iterations) + '</span></div>'
    + '<div style="font-size:15px;font-weight:600;margin-top:6px;">' + esc(l.title) + '</div>'
    + '<div class="muted" style="margin-top:4px;">' + esc(l.goal) + '</div></div>'
    + '<div style="display:flex;gap:8px;">'
    + (l.active_task_id ? '<button class="btn sm" onclick="jumpToTask(\\'' + esc(l.active_task_id) + '\\')">查看当前任务 ' + esc(l.active_task_id) + '</button>' : '')
    + (l.status === "running" ? '<button class="btn sm danger" onclick="cancelLoopAction(\\'' + esc(l.loop_id) + '\\')">终止</button>' : '')
    + '</div></div>'
    + stageHtml
    + (l.last_error ? '<div style="margin-top:10px;color:#fbbf24;font-size:12px;" class="mono">最近反馈：' + esc(l.last_error.slice(0, 300)) + '</div>' : '')
    + (l.error ? '<div style="margin-top:6px;color:#f87171;font-size:12px;" class="mono">错误：' + esc(l.error) + '</div>' : '')
    + '</div>';
}

function renderLoops(d) {
  const loops = d.loops || [];
  let html = '<div class="section-title"><span>LoopForge 多阶段 SOP 闭环流水线</span><button class="btn sm primary" onclick="openLoopModal()">+ 新建 SOP 闭环</button></div>';
  if (!loops.length) {
    html += '<div class="card muted">暂无 SOP 闭环任务。点击右上角「新建 SOP 闭环」，可选择 Plan→Code→Verify 等模板自动流转与自愈重试。</div>';
    return html;
  }
  for (const l of loops) html += renderLoopCard(l);
  return html;
}

function setFilter(f) { state.statusFilter = f; render(); }

function render() {
  const d = state.data;
  const el = document.getElementById("content");
  if (!d) { el.innerHTML = '<div class="muted">正在连接 Hub 中台...</div>'; return; }
  if (state.view === "overview") el.innerHTML = renderOverview(d);
  else if (state.view === "agents") el.innerHTML = renderAgents(d);
  else if (state.view === "tasks") {
    el.innerHTML = renderTasks(d);
    const si = document.getElementById("taskSearchInput");
    if (si) si.addEventListener("input", (e) => { state.search = e.target.value; render(); });
  }
  else if (state.view === "loops") el.innerHTML = renderLoops(d);
}

function syncNav() {
  const titles = {
    overview: "总览与终端拓扑",
    agents: "Agent 名片墙 (LobeHub Style)",
    tasks: "任务与 A2A 对话流",
    loops: "LoopForge SOP 闭环工坊",
  };
  document.getElementById("viewTitle").textContent = titles[state.view] || "";
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === state.view);
  });
}

async function openLoopModal() {
  try {
    const res = await api("/api/v1/loop-templates");
    state.templates = res.templates || [];
    const sel = document.getElementById("lfTemplate");
    sel.innerHTML = state.templates.map((t) => '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>').join("");
  } catch { /* ignore */ }
  openModal("loopModal");
}

async function startLongPoll() {
  const dot = document.getElementById("pollDot");
  const txt = document.getElementById("pollText");
  for (;;) {
    try {
      const headers = {};
      if (state.token) headers.Authorization = "Bearer " + state.token;
      const r = await fetch("/api/v1/poll?node=_web&cursor=" + state.cursor + "&timeout=25", { headers });
      if (r.status === 401) {
        dot.className = "dot err";
        txt.textContent = "等待 Token 鉴权";
        await new Promise((res) => setTimeout(res, 3000));
        continue;
      }
      const d = await r.json();
      dot.className = "dot on";
      txt.textContent = "长轮询已实时同步";
      if (d.cursor != null) state.cursor = d.cursor;
      document.getElementById("seqText").textContent = "seq: " + state.cursor;
      if (d.wake) await refreshState();
    } catch {
      dot.className = "dot err";
      txt.textContent = "重连中...";
      await new Promise((res) => setTimeout(res, 2500));
    }
  }
}

document.querySelectorAll(".nav-btn").forEach((b) => {
  b.addEventListener("click", () => {
    state.view = b.dataset.view;
    syncNav();
    render();
  });
});

document.getElementById("btnRefresh").addEventListener("click", refreshState);
document.getElementById("btnNewTask").addEventListener("click", () => openModal("taskModal"));
document.getElementById("btnNewLoop").addEventListener("click", openLoopModal);
document.getElementById("btnToken").addEventListener("click", () => {
  document.getElementById("tokenInput").value = state.token;
  openModal("tokenModal");
});
document.getElementById("saveTokenBtn").addEventListener("click", () => {
  state.token = document.getElementById("tokenInput").value.trim();
  localStorage.setItem("lobe_a2a_token", state.token);
  closeModal("tokenModal");
  refreshState();
});

document.getElementById("taskForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const body = {
      to: document.getElementById("tfTo").value.trim(),
      cap: document.getElementById("tfCap").value.trim(),
      worker: document.getElementById("tfWorker").value.trim(),
      text: document.getElementById("tfText").value,
      approval: document.getElementById("tfApproval").value,
      context: document.getElementById("tfContext").value.trim(),
    };
    const crit = document.getElementById("tfCriteria").value.trim();
    if (crit) body.criteria = JSON.parse(crit);
    const res = await api("/api/v1/tasks", { method: "POST", body: JSON.stringify(body) });
    closeModal("taskModal");
    showToast("已派发任务 " + res.task_id);
    await refreshState();
    jumpToTask(res.task_id);
  } catch (err) {
    showToast("派发失败: " + err.message);
  }
});

document.getElementById("loopForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const body = {
      template: document.getElementById("lfTemplate").value,
      goal: document.getElementById("lfGoal").value,
      to: document.getElementById("lfTo").value.trim(),
      cap: document.getElementById("lfCap").value.trim(),
      worker: document.getElementById("lfWorker").value.trim(),
      maxIterations: Number(document.getElementById("lfMaxIter").value) || 5,
    };
    const res = await api("/api/v1/loops", { method: "POST", body: JSON.stringify(body) });
    closeModal("loopModal");
    showToast("已启动 SOP 闭环 " + res.loopId);
    state.view = "loops";
    syncNav();
    await refreshState();
  } catch (err) {
    showToast("创建 Loop 失败: " + err.message);
  }
});

refreshState();
startLongPoll();
</script>
</body>
</html>`;
}
