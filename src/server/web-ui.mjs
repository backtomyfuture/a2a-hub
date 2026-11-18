// 内置 Web 控制台（零外部构建依赖、无外网 CDN 依赖，局域网/离线可用）。
// 面向非开发者机主视角设计：用大白话表达状态与操作，把技术参数折叠在高级/技术详情中。

export function renderWebConsoleHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>A2A-Hub · 我的 Agent 控制台</title>
<style>
  :root {
    --bg: #09090b;
    --surface: #111114;
    --surface-2: #18181b;
    --surface-hover: #222228;
    --border: rgba(255,255,255,0.08);
    --border-strong: rgba(255,255,255,0.16);
    --text: #f4f4f5;
    --text-2: #d4d4d8;
    --muted: #a1a1aa;
    --input-bg: #09090b;
    --accent: #6366f1;
    --accent-hover: #818cf8;
    --accent-soft: rgba(99,102,241,0.15);
    --green: #10b981;
    --green-soft: rgba(16,185,129,0.14);
    --green-text: #34d399;
    --amber: #f59e0b;
    --amber-soft: rgba(245,158,11,0.14);
    --amber-text: #fbbf24;
    --red: #ef4444;
    --red-soft: rgba(239,68,68,0.14);
    --red-text: #f87171;
    --purple: #a855f7;
    --purple-soft: rgba(168,85,247,0.15);
    --purple-text: #c084fc;
    --cyan: #0ea5e9;
    --cyan-soft: rgba(14,165,233,0.15);
    --cyan-text: #38bdf8;
    --slate-soft: rgba(148,163,184,0.14);
    --slate-text: #94a3b8;
    --shadow: 0 20px 50px rgba(0,0,0,0.48);
    --radius: 10px;
  }

  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      --bg: #f8fafc;
      --surface: #ffffff;
      --surface-2: #f1f5f9;
      --surface-hover: #e2e8f0;
      --border: rgba(15,23,42,0.08);
      --border-strong: rgba(15,23,42,0.16);
      --text: #0f172a;
      --text-2: #334155;
      --muted: #64748b;
      --input-bg: #ffffff;
      --accent: #4f46e5;
      --accent-hover: #4338ca;
      --accent-soft: rgba(79,70,229,0.10);
      --green: #059669;
      --green-soft: rgba(5,150,105,0.10);
      --green-text: #047857;
      --amber: #d97706;
      --amber-soft: rgba(217,119,6,0.12);
      --amber-text: #b45309;
      --red: #dc2626;
      --red-soft: rgba(220,38,38,0.10);
      --red-text: #b91c1c;
      --purple: #9333ea;
      --purple-soft: rgba(147,51,234,0.10);
      --purple-text: #7e22ce;
      --cyan: #0284c7;
      --cyan-soft: rgba(2,132,199,0.10);
      --cyan-text: #0369a1;
      --slate-soft: rgba(100,116,139,0.12);
      --slate-text: #475569;
      --shadow: 0 18px 44px rgba(15,23,42,0.12);
    }
  }

  :root[data-theme="light"] {
    --bg: #f8fafc;
    --surface: #ffffff;
    --surface-2: #f1f5f9;
    --surface-hover: #e2e8f0;
    --border: rgba(15,23,42,0.08);
    --border-strong: rgba(15,23,42,0.16);
    --text: #0f172a;
    --text-2: #334155;
    --muted: #64748b;
    --input-bg: #ffffff;
    --accent: #4f46e5;
    --accent-hover: #4338ca;
    --accent-soft: rgba(79,70,229,0.10);
    --green: #059669;
    --green-soft: rgba(5,150,105,0.10);
    --green-text: #047857;
    --amber: #d97706;
    --amber-soft: rgba(217,119,6,0.12);
    --amber-text: #b45309;
    --red: #dc2626;
    --red-soft: rgba(220,38,38,0.10);
    --red-text: #b91c1c;
    --purple: #9333ea;
    --purple-soft: rgba(147,51,234,0.10);
    --purple-text: #7e22ce;
    --cyan: #0284c7;
    --cyan-soft: rgba(2,132,199,0.10);
    --cyan-text: #0369a1;
    --slate-soft: rgba(100,116,139,0.12);
    --slate-text: #475569;
    --shadow: 0 18px 44px rgba(15,23,42,0.12);
  }

  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%;
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif;
    font-size: 14px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  button, input, textarea, select { font: inherit; color: inherit; }
  a { color: var(--accent-hover); text-decoration: none; }
  a:hover { text-decoration: underline; }

  .app { display: grid; grid-template-columns: 224px 1fr; height: 100vh; overflow: hidden; }
  .sidebar {
    background: var(--surface); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; padding: 18px 12px; gap: 18px;
  }
  .brand { display: flex; align-items: center; gap: 10px; padding: 2px 8px; }
  .brand-logo {
    width: 30px; height: 30px; border-radius: 8px; background: var(--accent);
    display: grid; place-items: center; font-weight: 700; font-size: 13px; color: #fff; flex-shrink: 0;
  }
  .brand-title { font-weight: 650; font-size: 14px; letter-spacing: -0.01em; }
  .brand-sub { font-size: 11px; color: var(--muted); }

  .nav { display: flex; flex-direction: column; gap: 4px; }
  .nav-btn {
    display: flex; align-items: center; justify-content: space-between;
    padding: 9px 10px; border-radius: 8px; border: 1px solid transparent;
    background: transparent; cursor: pointer; color: var(--muted); text-align: left;
    transition: background .12s, color .12s;
  }
  .nav-btn:hover { background: var(--surface-2); color: var(--text); }
  .nav-btn.active { background: var(--accent-soft); color: var(--text); font-weight: 600; border-color: rgba(99,102,241,0.25); }

  .badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600;
    background: var(--slate-soft); color: var(--text-2); white-space: nowrap;
  }
  .badge.green { background: var(--green-soft); color: var(--green-text); }
  .badge.amber { background: var(--amber-soft); color: var(--amber-text); }
  .badge.red { background: var(--red-soft); color: var(--red-text); }
  .badge.indigo { background: var(--accent-soft); color: var(--accent-hover); }
  .badge.purple { background: var(--purple-soft); color: var(--purple-text); }
  .badge.cyan { background: var(--cyan-soft); color: var(--cyan-text); }

  .sidebar-footer {
    margin-top: auto; display: flex; flex-direction: column; gap: 8px;
    padding-top: 12px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted);
  }
  .conn-pill {
    display: flex; align-items: center; gap: 8px; padding: 8px 10px;
    border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex-shrink: 0; }
  .dot.on { background: var(--green); box-shadow: 0 0 0 3px var(--green-soft); }
  .dot.err { background: var(--red); }

  .main { display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
  .topbar {
    min-height: 56px; border-bottom: 1px solid var(--border); padding: 10px 24px;
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    background: var(--surface); flex-shrink: 0; flex-wrap: wrap;
  }
  .topbar-title { font-size: 15px; font-weight: 650; display: flex; align-items: center; gap: 10px; }
  .topbar-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

  .mobile-nav {
    display: none; border-bottom: 1px solid var(--border); background: var(--surface);
    padding: 8px 14px; gap: 6px; overflow-x: auto; flex-shrink: 0;
  }
  .mobile-nav .nav-btn { padding: 6px 10px; font-size: 13px; white-space: nowrap; gap: 6px; }

  .btn {
    padding: 7px 13px; border-radius: 8px; border: 1px solid var(--border-strong);
    background: var(--surface-2); cursor: pointer; font-weight: 500; font-size: 13px;
    transition: background .12s, border-color .12s; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    white-space: nowrap;
  }
  .btn:hover { background: var(--surface-hover); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .btn.success { background: var(--green-soft); border-color: rgba(16,185,129,0.35); color: var(--green-text); }
  .btn.success:hover { border-color: var(--green); }
  .btn.danger { background: var(--red-soft); border-color: rgba(239,68,68,0.35); color: var(--red-text); }
  .btn.danger:hover { border-color: var(--red); }
  .btn.ghost { background: transparent; border-color: transparent; color: var(--muted); }
  .btn.ghost:hover { background: var(--surface-2); color: var(--text); }
  .btn.sm { padding: 5px 10px; font-size: 12px; border-radius: 7px; }

  .content { flex: 1; overflow-y: auto; padding: 24px; }
  .page-wrap { max-width: 1120px; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }

  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 16px 18px;
  }
  .section-head {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    margin-bottom: 10px; flex-wrap: wrap;
  }
  .section-title { font-size: 14px; font-weight: 650; display: flex; align-items: center; gap: 8px; }
  .section-sub { font-size: 12px; color: var(--muted); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
  .muted { color: var(--muted); }

  .all-clear {
    display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;
    padding: 16px 18px; border-radius: var(--radius);
    background: var(--green-soft); border: 1px solid rgba(16,185,129,0.28);
  }
  .all-clear-title { font-weight: 650; font-size: 15px; color: var(--green-text); }

  .action-list { display: flex; flex-direction: column; gap: 10px; }
  .action-item {
    display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;
    padding: 13px 16px; border-radius: var(--radius); background: var(--surface);
    border: 1px solid var(--border); border-left-width: 3px;
  }
  .action-item.auth { border-left-color: var(--amber); background: linear-gradient(90deg, var(--amber-soft), transparent 45%), var(--surface); }
  .action-item.ask { border-left-color: var(--purple); background: linear-gradient(90deg, var(--purple-soft), transparent 45%), var(--surface); }
  .action-item.alert { border-left-color: var(--red); background: linear-gradient(90deg, var(--red-soft), transparent 45%), var(--surface); }
  .action-item.pending { border-left-color: var(--cyan); background: linear-gradient(90deg, var(--cyan-soft), transparent 45%), var(--surface); }

  .table-wrap { overflow-x: auto; }
  .clean-table { width: 100%; border-collapse: collapse; }
  .clean-table th, .clean-table td {
    text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: middle;
  }
  .clean-table th { font-size: 12px; font-weight: 600; color: var(--muted); white-space: nowrap; }
  .clean-table tr:last-child td { border-bottom: none; }
  .clean-table tbody tr.clickable { cursor: pointer; }
  .clean-table tbody tr.clickable:hover { background: var(--surface-2); }

  .pill {
    display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px;
    border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap;
  }
  .st-submitted { background: var(--slate-soft); color: var(--slate-text); }
  .st-working, .st-running { background: var(--cyan-soft); color: var(--cyan-text); }
  .st-input-required { background: var(--purple-soft); color: var(--purple-text); }
  .st-auth-required { background: var(--amber-soft); color: var(--amber-text); }
  .st-completed { background: var(--green-soft); color: var(--green-text); }
  .st-failed, .st-rejected { background: var(--red-soft); color: var(--red-text); }
  .st-canceled { background: var(--slate-soft); color: var(--slate-text); }

  .glossary {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 14px;
  }
  .glossary summary { cursor: pointer; font-size: 13px; font-weight: 550; color: var(--text-2); user-select: none; }
  .glossary-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border);
  }
  .glossary-card { padding: 10px 12px; border-radius: 8px; background: var(--surface-2); font-size: 12px; line-height: 1.55; }
  .glossary-card strong { display: block; margin-bottom: 3px; color: var(--text); }

  .node-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
  .node-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 16px; display: flex; flex-direction: column; gap: 12px;
  }
  .node-card:hover { border-color: var(--border-strong); }
  .node-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
  .node-name { font-size: 15px; font-weight: 650; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .token-box {
    padding: 10px 12px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border);
    display: flex; flex-direction: column; gap: 8px; font-size: 12px;
  }
  .cap-list {
    display: flex; flex-direction: column; gap: 10px;
    padding-top: 10px; border-top: 1px solid var(--border);
  }
  .cap-item {
    padding: 11px 12px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border);
    display: flex; flex-direction: column; gap: 8px;
  }
  .tech-details { font-size: 12px; color: var(--muted); }
  .tech-details summary { cursor: pointer; user-select: none; }
  .tech-kv {
    margin-top: 8px; padding: 8px 10px; border-radius: 6px; background: var(--surface);
    border: 1px solid var(--border); display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 6px 12px;
  }

  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .seg { display: inline-flex; gap: 4px; padding: 3px; border-radius: 9px; background: var(--surface); border: 1px solid var(--border); flex-wrap: wrap; }
  .chip {
    padding: 5px 10px; border-radius: 6px; border: 1px solid transparent; background: transparent;
    font-size: 12px; color: var(--muted); cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
  }
  .chip:hover { color: var(--text); }
  .chip.active { background: var(--surface-2); color: var(--text); border-color: var(--border-strong); font-weight: 600; }

  .tasks-split { display: grid; grid-template-columns: 350px 1fr; gap: 16px; height: calc(100vh - 108px); }
  .task-list-col {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    display: flex; flex-direction: column; overflow: hidden;
  }
  .task-filters { padding: 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
  .chip-row { display: flex; flex-wrap: wrap; gap: 4px; }
  .task-items { flex: 1; overflow-y: auto; }
  .task-item { padding: 12px 14px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background .1s; }
  .task-item:hover { background: var(--surface-2); }
  .task-item.selected { background: var(--accent-soft); border-left: 3px solid var(--accent); }
  .task-detail-col {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px;
  }

  .msg-list { display: flex; flex-direction: column; gap: 10px; }
  .msg-bubble { border-radius: 9px; padding: 12px 14px; border: 1px solid var(--border); background: var(--surface-2); }
  .msg-bubble.user { border-left: 3px solid var(--accent); }
  .msg-bubble.agent { border-left: 3px solid var(--cyan); }
  .msg-bubble.auth { border-left: 3px solid var(--amber); }
  .msg-head { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .msg-body { white-space: pre-wrap; word-break: break-word; line-height: 1.55; }
  .data-box {
    margin-top: 8px; padding: 8px 10px; background: var(--surface); border: 1px solid var(--border);
    border-radius: 7px; font-family: ui-monospace, monospace; font-size: 12px; overflow-x: auto; white-space: pre-wrap;
  }

  .action-banner {
    padding: 14px 16px; border-radius: 9px; border: 1px solid rgba(245,158,11,0.35);
    background: var(--amber-soft); display: flex; flex-direction: column; gap: 10px;
  }
  .action-banner.ask { border-color: rgba(168,85,247,0.35); background: var(--purple-soft); }

  .loop-stages { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
  .stage-node {
    padding: 6px 11px; border-radius: 8px; border: 1px solid var(--border);
    background: var(--surface-2); font-size: 12px; display: flex; align-items: center; gap: 6px;
  }
  .stage-node.current { border-color: var(--accent); background: var(--accent-soft); font-weight: 600; }
  .stage-node.done { border-color: rgba(16,185,129,0.45); background: var(--green-soft); color: var(--green-text); }
  .stage-arrow { color: var(--muted); font-size: 12px; }

  .input {
    width: 100%; padding: 8px 11px; border-radius: 8px;
    border: 1px solid var(--border-strong); background: var(--input-bg); color: var(--text); outline: none;
  }
  .input:focus { border-color: var(--accent); }
  textarea.input { min-height: 84px; resize: vertical; }
  .form-row { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
  .form-row label { font-size: 12px; color: var(--text-2); font-weight: 550; }
  .hint { font-size: 12px; color: var(--muted); }
  .checkbox-row {
    display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px;
    border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); cursor: pointer;
  }
  .checkbox-row input { margin-top: 3px; }
  .adv-box {
    margin: 10px 0 14px; padding: 10px 12px; border-radius: 8px;
    background: var(--surface-2); border: 1px solid var(--border);
  }
  .adv-box summary { cursor: pointer; font-size: 13px; font-weight: 550; color: var(--text-2); user-select: none; }
  .adv-body { margin-top: 12px; }
  .crit-row { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center; margin-bottom: 8px; }

  .wizard-steps { display: flex; gap: 8px; margin-bottom: 16px; }
  .wizard-step {
    flex: 1; padding: 7px 10px; border-radius: 8px; font-size: 12px; text-align: center;
    background: var(--surface-2); color: var(--muted); border: 1px solid var(--border);
  }
  .wizard-step.active { background: var(--accent-soft); color: var(--text); border-color: rgba(99,102,241,0.35); font-weight: 600; }
  .wizard-step.done { color: var(--green-text); border-color: rgba(16,185,129,0.3); }

  .choice-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; }
  .choice-card {
    display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px;
    border-radius: 9px; border: 1px solid var(--border-strong); background: var(--surface-2); cursor: pointer;
  }
  .choice-card.selected { border-color: var(--accent); background: var(--accent-soft); }
  .choice-card input { margin-top: 3px; }

  .token-reveal {
    padding: 14px; border-radius: 9px; border: 1px solid rgba(245,158,11,0.45);
    background: var(--amber-soft); margin-bottom: 14px; display: flex; flex-direction: column; gap: 8px;
  }
  .token-reveal-title { font-weight: 700; color: var(--amber-text); }
  .err-banner {
    padding: 10px 12px; border-radius: 8px; background: var(--red-soft); border: 1px solid rgba(239,68,68,0.35);
    color: var(--red-text); font-size: 13px; margin-bottom: 12px;
  }

  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.58); backdrop-filter: blur(4px);
    display: none; align-items: center; justify-content: center; z-index: 50; padding: 16px;
  }
  .modal-backdrop.open { display: flex; }
  .modal {
    width: 100%; max-width: 600px; max-height: 90vh; overflow-y: auto;
    background: var(--surface); border: 1px solid var(--border-strong);
    border-radius: 12px; padding: 20px; box-shadow: var(--shadow);
  }
  .modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; font-size: 16px; font-weight: 650; }
  .toast {
    position: fixed; right: 20px; bottom: 20px; z-index: 80; padding: 10px 14px;
    border-radius: 9px; background: var(--surface); color: var(--text);
    border: 1px solid var(--border-strong); box-shadow: var(--shadow); display: none; max-width: 380px;
  }
  .toast.show { display: block; }
  .steps { margin: 4px 0 12px; padding-left: 18px; line-height: 1.65; }

  @media (max-width: 900px) {
    .app { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
    .sidebar { display: none; }
    .mobile-nav { display: flex; }
    .topbar { padding: 10px 14px; }
    .content { padding: 14px; }
    .node-grid { grid-template-columns: 1fr; }
    .tasks-split { grid-template-columns: 1fr; height: auto; }
    .task-list-col { max-height: 360px; }
    .crit-row { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-logo">AH</div>
      <div>
        <div class="brand-title">A2A-Hub</div>
        <div class="brand-sub" id="hubNodeLabel">个人编排中台</div>
      </div>
    </div>
    <nav class="nav" id="desktopNav">
      <button class="nav-btn active" data-view="overview">
        <span>首页</span>
        <span class="badge" id="navTodoCount">0</span>
      </button>
      <button class="nav-btn" data-view="agents">
        <span>Agent</span>
        <span class="badge" id="navAgentCount">0</span>
      </button>
      <button class="nav-btn" data-view="tasks">
        <span>任务</span>
        <span class="badge" id="navTaskCount">0</span>
      </button>
      <button class="nav-btn" data-view="loops">
        <span>SOP 闭环</span>
        <span class="badge indigo" id="navLoopCount">0</span>
      </button>
    </nav>
    <div class="sidebar-footer">
      <div class="conn-pill">
        <span class="dot" id="pollDot"></span>
        <div style="min-width:0;">
          <div id="pollText" style="color:var(--text);font-weight:500;">连接中...</div>
          <div id="seqText" class="mono muted" style="font-size:11px;">同步序号: -</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;">
        <button class="btn sm" style="flex:1;" id="btnTheme">深浅切换</button>
        <button class="btn sm" style="flex:1;" id="btnToken">管理密钥</button>
      </div>
    </div>
  </aside>

  <main class="main">
    <header class="topbar">
      <div class="topbar-title" id="viewTitle">首页 · 待我处理</div>
      <div class="topbar-actions">
        <button class="btn sm" id="btnRefresh">刷新</button>
        <button class="btn sm" id="btnNewLoop">+ 新建闭环</button>
        <button class="btn sm primary" id="btnNewTask">+ 派发任务</button>
      </div>
    </header>
    <nav class="mobile-nav" id="mobileNav">
      <button class="nav-btn active" data-view="overview">首页</button>
      <button class="nav-btn" data-view="agents">Agent</button>
      <button class="nav-btn" data-view="tasks">任务</button>
      <button class="nav-btn" data-view="loops">SOP 闭环</button>
      <button class="nav-btn" id="mobileThemeBtn" type="button">深浅</button>
      <button class="nav-btn" id="mobileTokenBtn" type="button">密钥</button>
    </nav>
    <section class="content" id="content"></section>
  </main>
</div>

<!-- 派发任务弹窗：默认只露 3 项，技术参数与可视化验收编辑器收进高级选项 -->
<div class="modal-backdrop" id="taskModal">
  <div class="modal">
    <div class="modal-head">
      <span>派发新任务</span>
      <button class="btn sm" type="button" data-close-modal="taskModal">关闭</button>
    </div>
    <form id="taskForm">
      <div class="form-row">
        <label>交给谁</label>
        <select class="input" id="tfTargetSelect"></select>
        <div class="hint" id="tfTargetHint">只列出您已接纳且可接收任务的 Agent 能力。</div>
      </div>
      <div class="form-row">
        <label>要做什么</label>
        <textarea class="input" id="tfText" placeholder="用大白话描述您想让它完成什么事情、有什么背景要求..." required></textarea>
      </div>
      <div class="form-row">
        <label class="checkbox-row">
          <input type="checkbox" id="tfRequireApproval" />
          <span>
            <strong style="display:block;font-size:13px;">执行前需要我批准</strong>
            <span class="hint">勾选后，Agent 动手前会先向您发审批请求，点「批准」才会开始干活。</span>
          </span>
        </label>
      </div>
      <details class="adv-box" id="tfAdvanced">
        <summary>高级选项（指定执行者、关联会话、验收清单）</summary>
        <div class="adv-body">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div class="form-row">
              <label>目标节点名称</label>
              <input class="input" id="tfTo" list="admittedNodes" placeholder="例如 grok-bot / mac-mini" />
              <datalist id="admittedNodes"></datalist>
            </div>
            <div class="form-row">
              <label>能力标识</label>
              <input class="input" id="tfCap" placeholder="例如 agent / echo" />
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div class="form-row">
              <label>指定执行者（Worker，可选）</label>
              <input class="input" id="tfWorker" placeholder="留空由节点默认处理" />
            </div>
            <div class="form-row">
              <label>关联会话编号（可选）</label>
              <input class="input" id="tfContext" placeholder="填相同编号可串起上下文" />
            </div>
          </div>
          <div class="form-row" style="margin-bottom:4px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <label>验收清单（可选）</label>
              <button type="button" class="btn sm" id="addCritBtn">+ 添加一条要求</button>
            </div>
            <div class="hint" style="margin-bottom:6px;">任务完成时，Agent 需要逐条核对以下要求。</div>
            <div id="criteriaRows"></div>
          </div>
        </div>
      </details>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">
        <button type="button" class="btn" data-close-modal="taskModal">取消</button>
        <button type="submit" class="btn primary">立即派发</button>
      </div>
    </form>
  </div>
</div>

<!-- 新建 SOP 闭环弹窗 -->
<div class="modal-backdrop" id="loopModal">
  <div class="modal">
    <div class="modal-head">
      <span>新建 SOP 闭环</span>
      <button class="btn sm" type="button" data-close-modal="loopModal">关闭</button>
    </div>
    <form id="loopForm">
      <div class="form-row">
        <label>选择工作流模板</label>
        <select class="input" id="lfTemplate"></select>
        <div class="token-box" id="lfTemplateDesc" style="margin-top:6px;"></div>
      </div>
      <div class="form-row">
        <label>交给哪个节点执行</label>
        <select class="input" id="lfTargetSelect"></select>
      </div>
      <div class="form-row">
        <label>闭环总目标</label>
        <textarea class="input" id="lfGoal" placeholder="描述希望多个步骤接力完成的最终目标..." required></textarea>
      </div>
      <details class="adv-box" id="lfAdvanced">
        <summary>高级选项（手动节点、能力与轮次上限）</summary>
        <div class="adv-body">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div class="form-row">
              <label>手动指定节点</label>
              <input class="input" id="lfTo" placeholder="例如 mac-mini" />
            </div>
            <div class="form-row">
              <label>默认能力</label>
              <input class="input" id="lfCap" value="agent" />
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div class="form-row">
              <label>指定执行者（Worker，可选）</label>
              <input class="input" id="lfWorker" placeholder="留空由节点默认" />
            </div>
            <div class="form-row">
              <label>最多来回几轮（1-8）</label>
              <input class="input" type="number" id="lfMaxIter" value="5" min="1" max="8" />
            </div>
          </div>
        </div>
      </details>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">
        <button type="button" class="btn" data-close-modal="loopModal">取消</button>
        <button type="submit" class="btn primary">启动闭环</button>
      </div>
    </form>
  </div>
</div>

<!-- 管理 API Token 弹窗 -->
<div class="modal-backdrop" id="tokenModal">
  <div class="modal" style="max-width:440px;">
    <div class="modal-head">
      <span>管理密钥设置</span>
      <button class="btn sm" type="button" data-close-modal="tokenModal">关闭</button>
    </div>
    <div class="form-row">
      <label>机主管理密钥（Bearer API Token）</label>
      <input class="input mono" type="password" id="tokenInput" placeholder="若 Hub 未启用鉴权可留空" />
      <div class="hint">仅保存在当前浏览器的本地存储中，用于验证机主操作权限。</div>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px;">
      <button class="btn" type="button" data-close-modal="tokenModal">取消</button>
      <button class="btn primary" type="button" id="saveTokenBtn">保存并连接</button>
    </div>
  </div>
</div>

<!-- 添加 Agent 三步向导弹窗 -->
<div class="modal-backdrop" id="agentModal">
  <div class="modal" style="max-width:640px;">
    <div class="modal-head">
      <span>添加新 Agent</span>
      <button class="btn sm" type="button" data-close-modal="agentModal">关闭</button>
    </div>
    <div class="wizard-steps" id="wizardSteps">
      <div class="wizard-step active" data-step="1">1. 选择接入类型</div>
      <div class="wizard-step" data-step="2">2. 填写名字与角色</div>
      <div class="wizard-step" data-step="3">3. 获取密钥与接入指引</div>
    </div>
    <div id="agentErrBox" class="err-banner" style="display:none;"></div>

    <div id="agentStep1">
      <div class="choice-list" id="accessChoices">
        <label class="choice-card selected" data-access="http">
          <input type="radio" name="afAccessRadio" value="http" checked />
          <div>
            <div style="font-weight:650;">云端 / HTTP Agent（如 Muse、Grok Bot）</div>
            <div class="hint">适合跑在云端或定时脚本里的 Agent，通过网址定时来取单或派单，不用装本地守护进程。</div>
          </div>
        </label>
        <label class="choice-card" data-access="host">
          <input type="radio" name="afAccessRadio" value="host" />
          <div>
            <div style="font-weight:650;">另一台电脑（工作机节点）</div>
            <div class="hint">适合您自己的另一台 Mac / Linux / Windows 电脑，接入后可执行本地命令或 AI 编程任务。</div>
          </div>
        </label>
        <label class="choice-card" data-access="inbox">
          <input type="radio" name="afAccessRadio" value="inbox" />
          <div>
            <div style="font-weight:650;">本机独立 Agent</div>
            <div class="hint">适合跑在同一台机器上、由脚本自主读取收件箱来消费任务的 Agent。</div>
          </div>
        </label>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button type="button" class="btn" data-close-modal="agentModal">取消</button>
        <button type="button" class="btn primary" id="agentNextBtn">下一步</button>
      </div>
    </div>

    <form id="agentStep2" style="display:none;">
      <div class="form-row">
        <label>节点标识（英文/数字，用于系统唯一识别）</label>
        <input class="input mono" id="afNode" placeholder="例如 muse-leader 或 grok-bot" required />
        <div class="hint">只允许字母、数字、点、下划线或短横线，添加后不可更改。</div>
      </div>
      <div class="form-row">
        <label>显示名称（您自己看的友好名字，可选）</label>
        <input class="input" id="afName" maxlength="64" placeholder="例如：云端 Muse / Grok 助手" />
      </div>
      <div class="form-row">
        <label>它的角色</label>
        <select class="input" id="afRole">
          <option value="worker">执行任务的 Worker（接收并完成派单）</option>
          <option value="leader">负责派单的 Leader（如 Muse，只派单与跟进）</option>
          <option value="hybrid">两者都做（既能派单，也能接活执行）</option>
        </select>
      </div>
      <div class="form-row" id="afDescRow">
        <label>它擅长做什么（能力说明，可选）</label>
        <input class="input" id="afDesc" placeholder="例如：擅长写文章、查资料、整理日报" />
      </div>
      <div class="form-row">
        <label>备注（只给您自己看，可选）</label>
        <textarea class="input" id="afNote" maxlength="500" style="min-height:60px;" placeholder="例如：每 15 分钟唤醒一次"></textarea>
      </div>
      <div style="display:flex;justify-content:space-between;gap:8px;">
        <button type="button" class="btn" id="agentPrevBtn">上一步</button>
        <div style="display:flex;gap:8px;">
          <button type="button" class="btn" data-close-modal="agentModal">取消</button>
          <button type="submit" class="btn primary" id="agentSubmitBtn">创建并生成接入指引</button>
        </div>
      </div>
    </form>

    <div id="agentStep3" style="display:none;">
      <div id="onboardBox"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">
        <button type="button" class="btn" id="agentAddAnotherBtn">继续添加</button>
        <button type="button" class="btn primary" data-close-modal="agentModal">完成</button>
      </div>
    </div>
  </div>
</div>

<!-- 编辑名片显示名与备注 -->
<div class="modal-backdrop" id="profileModal">
  <div class="modal" style="max-width:460px;">
    <div class="modal-head">
      <span>编辑显示名与备注</span>
      <button class="btn sm" type="button" data-close-modal="profileModal">关闭</button>
    </div>
    <form id="profileForm">
      <input type="hidden" id="pfCap" />
      <div class="form-row">
        <label>显示名（留空则使用默认技能名）</label>
        <input class="input" id="pfName" maxlength="64" placeholder="例如：写作助手" />
      </div>
      <div class="form-row">
        <label>机主备注（可选）</label>
        <textarea class="input" id="pfNote" maxlength="500"></textarea>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button type="button" class="btn" data-close-modal="profileModal">取消</button>
        <button type="submit" class="btn primary">保存</button>
      </div>
    </form>
  </div>
</div>

<!-- Token 轮换 / 吊销确认与一次性密钥展示弹窗 -->
<div class="modal-backdrop" id="tokenManageModal">
  <div class="modal" style="max-width:560px;">
    <div class="modal-head">
      <span id="tmTitle">密钥管理</span>
      <button class="btn sm" type="button" data-close-modal="tokenManageModal">关闭</button>
    </div>
    <div id="tmBody"></div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
(() => {
  try {
    const params = new URLSearchParams(location.search);
    const t = params.get("token");
    if (t) {
      localStorage.setItem("a2a_hub_token", t.trim());
      params.delete("token");
      const next = location.pathname + (params.toString() ? "?" + params.toString() : "") + location.hash;
      history.replaceState(null, "", next);
    }
  } catch {}
})();

const DISMISS_STORAGE_KEY = "a2a_hub_dismissed_alerts";
const THEME_STORAGE_KEY = "a2a_hub_theme";

function loadDismissedAlerts() {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISS_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

const state = {
  view: "overview",
  data: null,
  selectedTaskId: null,
  selectedTaskDetail: null,
  statusFilter: "ALL",
  search: "",
  agentFilter: "admitted",
  expandedNodes: new Set(),
  tokensApiAvailable: false,
  tokensByNode: new Map(),
  dismissedFailed: loadDismissedAlerts(),
  cursor: 0,
  token: localStorage.getItem("a2a_hub_token") || localStorage.getItem("lobe_a2a_token") || "",
  templates: [],
  wizardStep: 1,
  wizardAccess: "http",
};

const TASK_STATUS_META = {
  submitted: { label: "待认领", cls: "submitted", tip: "submitted · 任务已发出，等待 Agent 取单" },
  working: { label: "执行中", cls: "working", tip: "working · Agent 正在执行" },
  "input-required": { label: "等待答复", cls: "input-required", tip: "input-required · Agent 提问，等您补充信息" },
  "auth-required": { label: "等待审批", cls: "auth-required", tip: "auth-required · 等待机主批准后执行" },
  completed: { label: "已完成", cls: "completed", tip: "completed · 已顺利完成" },
  failed: { label: "已失败", cls: "failed", tip: "failed · 执行失败或超时" },
  canceled: { label: "已取消", cls: "canceled", tip: "canceled · 已手动取消" },
  rejected: { label: "已拒收", cls: "rejected", tip: "rejected · 目标无法接收此任务" },
};

const LOOP_STATUS_META = {
  running: { label: "进行中", cls: "running", tip: "running · 闭环正在按阶段流转" },
  completed: { label: "已完成", cls: "completed", tip: "completed · 闭环所有阶段已通过" },
  failed: { label: "已失败", cls: "failed", tip: "failed · 闭环执行失败或达到上限" },
  canceled: { label: "已终止", cls: "canceled", tip: "canceled · 已手动终止" },
};

const MSG_KIND_LABELS = {
  instruction: "派发指令",
  progress: "进度汇报",
  question: "Agent 提问",
  answer: "机主答复",
  auth_request: "申请审批",
  auth_decision: "审批决定",
  result: "交付结果",
  notice: "系统提醒",
};

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function admissionOf(card) {
  const v = String(card && card.admission != null ? card.admission : "").trim();
  return v === "admitted" || v === "pending" || v === "rejected" ? v : "pending";
}

function parseTs(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e11 ? raw : raw * 1000;
  }
  let s = String(raw).trim();
  if (!s) return null;
  const off = /^(\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(?::\\d{2})?)([+-])(\\d{2})(\\d{2})$/.exec(s);
  if (off) {
    let head = off[1].replace(" ", "T");
    if (head.length === 16) head += ":00";
    s = head + off[2] + off[3] + ":" + off[4];
  } else {
    s = s.replace(" ", "T");
    if (/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$/.test(s)) s += ":00";
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function formatRelativeTime(raw) {
  const ms = parseTs(raw);
  if (ms == null) return "暂无记录";
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return "刚刚";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return mins + " 分钟前";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + " 小时前";
  const days = Math.floor(hrs / 24);
  return days + " 天前";
}

function isTaskStale(task) {
  if (!task || task.status !== "working") return false;
  const ms = parseTs(task.heartbeat_at);
  if (ms == null) return true;
  return (Date.now() - ms) > 20 * 60 * 1000;
}

function statusPill(status, isLoop = false) {
  const st = String(status || "unknown");
  const dict = isLoop ? LOOP_STATUS_META : TASK_STATUS_META;
  const info = dict[st] || { label: st, cls: st, tip: st };
  return '<span class="pill st-' + esc(info.cls) + '" title="' + esc(info.tip) + '">' + esc(info.label) + '</span>';
}

function roleLabelZh(role) {
  if (role === "leader") return "派单方 (Leader)";
  if (role === "hybrid") return "派单 + 执行";
  if (role === "worker") return "执行方 (Worker)";
  return "";
}

function kindLabelZh(kind, mode) {
  if (mode === "http-poll") return "云端 HTTP Agent";
  if (kind === "agent") return "独立 Agent";
  return "工作机节点";
}

function agentTypeSummary(kind, role, mode) {
  const k = kindLabelZh(kind, mode);
  const r = roleLabelZh(role);
  return r ? (k + " · " + r) : k;
}

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 3400);
}

function openModal(id) { document.getElementById(id).classList.add("open"); }
function closeModal(id) {
  document.getElementById(id).classList.remove("open");
  if (id === "tokenManageModal") document.getElementById("tmBody").innerHTML = "";
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") {
    root.setAttribute("data-theme", theme);
  } else {
    root.removeAttribute("data-theme");
  }
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
  const effective = cur || (prefersLight ? "light" : "dark");
  const next = effective === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_STORAGE_KEY, next);
  applyTheme(next);
  showToast("已切换为" + (next === "light" ? "浅色" : "深色") + "模式");
}

try {
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  if (savedTheme === "light" || savedTheme === "dark") applyTheme(savedTheme);
} catch {}

async function copyText(text, okMsg) {
  if (!text) return showToast("没有可复制的内容");
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      showToast(okMsg || "已复制到剪贴板");
      return;
    }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    showToast(ok ? (okMsg || "已复制到剪贴板") : "复制失败，请手动选中复制");
  } catch (e) {
    showToast("复制失败: " + e.message);
  }
}

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (state.token) headers.Authorization = "Bearer " + state.token;
  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const r = await fetch(path, Object.assign({}, opts, { headers }));
  if (r.status === 401) {
    document.getElementById("tokenInput").value = state.token;
    openModal("tokenModal");
    throw new Error("需要有效的管理密钥 (API Token)");
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(d.error || ("请求失败 (HTTP " + r.status + ")"));
    err.status = r.status;
    throw err;
  }
  return d;
}

// 兼容约定 A 可能尚未合并的场景：404 时静默隐藏 Token 管理区，绝不弹窗或白屏。
async function refreshTokens() {
  try {
    const headers = {};
    if (state.token) headers.Authorization = "Bearer " + state.token;
    const r = await fetch("/api/v1/admin/tokens", { headers });
    if (r.status === 404) {
      state.tokensApiAvailable = false;
      state.tokensByNode = new Map();
      return;
    }
    if (!r.ok) return;
    const d = await r.json().catch(() => null);
    if (d && Array.isArray(d.tokens)) {
      state.tokensApiAvailable = true;
      state.tokensByNode = new Map(d.tokens.map((t) => [t.node, t]));
    }
  } catch {
    // 网络波动时不推翻已有状态
  }
}

function buildNodeGroups(d) {
  const cards = (d && d.agentCards) || [];
  const connNodes = (d && d.connectedNodes) || [];
  const map = new Map();

  function ensure(nodeName) {
    const key = nodeName || "unknown";
    if (!map.has(key)) {
      map.set(key, {
        node: key,
        conn: null,
        cards: [],
        admittedCards: [],
        pendingCards: [],
        rejectedCards: [],
      });
    }
    return map.get(key);
  }

  for (const n of connNodes) {
    const g = ensure(n.node);
    g.conn = n;
  }
  for (const c of cards) {
    const g = ensure(c.node);
    g.cards.push(c);
    const adm = admissionOf(c);
    if (adm === "admitted") g.admittedCards.push(c);
    else if (adm === "pending") g.pendingCards.push(c);
    else g.rejectedCards.push(c);
  }

  const out = [];
  for (const g of map.values()) {
    const primaryCard = g.cards.find((c) => c.skill_id === "agent" && !c.worker && c.display_name)
      || g.cards.find((c) => c.display_name)
      || g.cards[0]
      || null;
    const displayName = (primaryCard && String(primaryCard.display_name || "").trim()) || g.node;
    const kind = (g.conn && g.conn.kind) || (primaryCard && primaryCard.kind) || "host";
    const role = (g.conn && g.conn.role) || (g.cards.find((c) => c.role) && g.cards.find((c) => c.role).role) || "";
    const mode = (g.conn && g.conn.mode) || (primaryCard && primaryCard.receive_mode) || "longpoll";
    const online = g.conn
      ? Boolean(g.conn.online)
      : g.cards.some((c) => String(c.availability || "").toLowerCase() !== "offline");
    const lastSeenAt = g.conn ? g.conn.lastSeenAt : null;
    const nodeDesc = (g.cards.find((c) => c.node_desc) && g.cards.find((c) => c.node_desc).node_desc) || "";
    const adminNote = (g.cards.find((c) => c.admin_note) && g.cards.find((c) => c.admin_note).admin_note) || "";
    const daemonVersion = (g.cards.find((c) => c.daemon_version) && g.cards.find((c) => c.daemon_version).daemon_version) || "";
    out.push({
      ...g,
      displayName,
      kind,
      role,
      mode,
      online,
      polling: Boolean(g.conn && g.conn.polling),
      lastSeenAt,
      nodeDesc,
      adminNote,
      daemonVersion,
    });
  }
  return out.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.displayName.localeCompare(b.displayName, "zh-CN");
  });
}

function nodeFriendlyName(d, node) {
  if (!node) return "-";
  const cards = (d && d.agentCards) || [];
  const match = cards.find((c) => c.node === node && c.skill_id === "agent" && !c.worker && c.display_name)
    || cards.find((c) => c.node === node && c.display_name);
  const dn = match && String(match.display_name || "").trim();
  return dn && dn !== node ? (dn + " (" + node + ")") : node;
}

function computeTodos(d) {
  const tasks = (d && d.tasks) || [];
  const cards = (d && d.agentCards) || [];
  const authList = tasks.filter((t) => t.status === "auth-required");
  const askList = tasks.filter((t) => t.status === "input-required");
  const staleList = tasks.filter((t) => isTaskStale(t));
  const failedList = tasks.filter((t) => (t.status === "failed" || t.status === "rejected") && !state.dismissedFailed.has(t.task_id));
  const pendingCards = cards.filter((c) => admissionOf(c) === "pending");
  const pendingByNode = new Map();
  for (const c of pendingCards) {
    const n = c.node || "unknown";
    if (!pendingByNode.has(n)) pendingByNode.set(n, []);
    pendingByNode.get(n).push(c);
  }
  const pendingNodes = Array.from(pendingByNode.entries()).map(([node, list]) => ({ node, cards: list }));
  const total = authList.length + askList.length + staleList.length + failedList.length + pendingNodes.length;
  return { authList, askList, staleList, failedList, pendingCards, pendingNodes, total };
}

async function refreshState() {
  try {
    const [d] = await Promise.all([api("/api/v1/state"), refreshTokens()]);
    state.data = d;
    if (d.seq != null && d.seq > state.cursor) state.cursor = d.seq;
    document.getElementById("hubNodeLabel").textContent = "中台节点: " + (d.hubNode || "hub");
    document.getElementById("seqText").textContent = "同步序号: " + (d.seq ?? 0);

    const todos = computeTodos(d);
    const navTodo = document.getElementById("navTodoCount");
    navTodo.textContent = String(todos.total);
    navTodo.className = "badge " + (todos.total > 0 ? "amber" : "green");

    const groups = buildNodeGroups(d);
    const activeNodes = groups.filter((g) => g.admittedCards.length > 0 || (g.conn && g.role === "leader")).length;
    const navAgent = document.getElementById("navAgentCount");
    navAgent.textContent = todos.pendingCards.length > 0 ? (activeNodes + " · 待" + todos.pendingCards.length) : String(activeNodes);
    navAgent.className = "badge" + (todos.pendingCards.length > 0 ? " amber" : "");

    const activeTasks = (d.tasks || []).filter((t) => ["submitted", "working", "auth-required", "input-required"].includes(t.status)).length;
    document.getElementById("navTaskCount").textContent = String(activeTasks);
    document.getElementById("navLoopCount").textContent = String((d.loops || []).filter((l) => l.status === "running").length);

    fillDispatchCandidates();
    fillLoopCandidates();

    if (state.selectedTaskId) {
      await loadTaskDetail(state.selectedTaskId, true);
    }
    render();
  } catch (e) {
    showToast("同步状态失败: " + e.message);
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
    showToast(res.message || (decision === "approve" ? "已批准执行" : "已驳回"));
    await refreshState();
  } catch (e) {
    showToast("审批操作失败: " + e.message);
  }
}

async function replyTask(taskId) {
  const input = document.getElementById("replyTextBox");
  const text = input ? input.value.trim() : "";
  if (!text) return showToast("请输入要回复的内容");
  try {
    await api("/api/v1/tasks/" + encodeURIComponent(taskId) + "/reply", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    showToast("回复已发送，Agent 即将继续执行");
    await refreshState();
  } catch (e) {
    showToast("发送答复失败: " + e.message);
  }
}

async function cancelTaskAction(taskId) {
  try {
    await api("/api/v1/tasks/" + encodeURIComponent(taskId) + "/cancel", {
      method: "POST",
      body: JSON.stringify({ text: "机主在控制台取消任务" }),
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
      body: JSON.stringify({ text: "机主在控制台终止闭环" }),
    });
    showToast("SOP 闭环已终止");
    await refreshState();
  } catch (e) {
    showToast("终止失败: " + e.message);
  }
}

function dismissFailedAlert(taskId) {
  state.dismissedFailed.add(taskId);
  try {
    localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify(Array.from(state.dismissedFailed).slice(-200)));
  } catch {}
  render();
}

function jumpToTask(taskId) {
  state.view = "tasks";
  syncNav();
  loadTaskDetail(taskId);
}

function fillDispatchCandidates() {
  const sel = document.getElementById("tfTargetSelect");
  const list = document.getElementById("admittedNodes");
  const cards = ((state.data && state.data.agentCards) || []).filter((c) => admissionOf(c) === "admitted");
  const dispatchableCards = cards.filter((c) => c.dispatchable === "Yes");
  if (sel) {
    const prev = sel.value;
    let html = "";
    if (!dispatchableCards.length) {
      html += '<option value="__manual__">暂无已接纳的能力（点此或下方手动指定）</option>';
    } else {
      html += '<option value="">请选择一个 Agent 能力...</option>';
      for (const c of dispatchableCards) {
        const capName = (c.display_name && String(c.display_name).trim()) || c.skill_name || c.skill_id || "通用能力";
        const sub = (c.worker ? c.worker + " · " : "") + (c.node || "");
        html += '<option value="' + esc(c.cap_id) + '">' + esc(capName + "（" + sub + "）") + '</option>';
      }
      html += '<option value="__manual__">手动填写节点（高级）</option>';
    }
    sel.innerHTML = html;
    if (prev && [...sel.options].some((o) => o.value === prev)) {
      sel.value = prev;
    } else if (!dispatchableCards.length) {
      sel.value = "__manual__";
    }
  }
  if (list) {
    const nodes = [...new Set(cards.map((c) => c.node).filter(Boolean))];
    list.innerHTML = nodes.map((n) => '<option value="' + esc(n) + '"></option>').join("");
  }
}

function applyDispatchSelect() {
  const val = document.getElementById("tfTargetSelect").value;
  if (val === "__manual__") {
    document.getElementById("tfAdvanced").open = true;
    return;
  }
  if (!val) return;
  const c = ((state.data && state.data.agentCards) || []).find((x) => x.cap_id === val && admissionOf(x) === "admitted");
  if (!c) return;
  document.getElementById("tfTo").value = c.node || "";
  document.getElementById("tfCap").value = c.skill_id || "";
  document.getElementById("tfWorker").value = c.worker || "";
}

function openDispatchFor(node, worker, skill, capId) {
  fillDispatchCandidates();
  document.getElementById("tfTo").value = node || "";
  document.getElementById("tfWorker").value = worker || "";
  document.getElementById("tfCap").value = skill || "agent";
  const sel = document.getElementById("tfTargetSelect");
  if (sel) {
    const cards = ((state.data && state.data.agentCards) || []).filter((c) => admissionOf(c) === "admitted" && c.dispatchable === "Yes");
    let matchedId = capId || "";
    if (!matchedId && node) {
      const found = cards.find((c) => c.node === node && (!skill || c.skill_id === skill) && (!worker || c.worker === worker))
        || cards.find((c) => c.node === node);
      if (found) matchedId = found.cap_id;
    }
    if (matchedId && [...sel.options].some((o) => o.value === matchedId)) {
      sel.value = matchedId;
    } else {
      sel.value = "__manual__";
      document.getElementById("tfAdvanced").open = true;
    }
  }
  openModal("taskModal");
}

function addCriteriaRow(textVal = "", evidenceVal = false) {
  const wrap = document.getElementById("criteriaRows");
  if (!wrap) return;
  const row = document.createElement("div");
  row.className = "crit-row";
  row.innerHTML = '<input type="text" class="input crit-text" placeholder="例如：输出完整总结，或所有测试通过" value="' + esc(textVal) + '" />'
    + '<label style="display:flex;align-items:center;gap:5px;font-size:12px;white-space:nowrap;cursor:pointer;">'
    + '<input type="checkbox" class="crit-ev"' + (evidenceVal ? " checked" : "") + ' /> 需要证据</label>'
    + '<button type="button" class="btn sm ghost crit-del">删除</button>';
  wrap.appendChild(row);
}

function fillLoopCandidates() {
  const sel = document.getElementById("lfTargetSelect");
  if (!sel) return;
  const prev = sel.value;
  const groups = buildNodeGroups(state.data).filter((g) => g.admittedCards.some((c) => c.dispatchable === "Yes"));
  let html = "";
  if (!groups.length) {
    html += '<option value="__manual__">暂无已接纳的执行节点（在高级选项手动填写）</option>';
  } else {
    html += '<option value="">请选择负责执行的节点...</option>';
    for (const g of groups) {
      const label = g.displayName !== g.node ? (g.displayName + "（" + g.node + "）") : g.node;
      html += '<option value="' + esc(g.node) + '">' + esc(label) + '</option>';
    }
    html += '<option value="__manual__">手动填写节点（高级）</option>';
  }
  sel.innerHTML = html;
  if (prev && [...sel.options].some((o) => o.value === prev)) {
    sel.value = prev;
  } else if (!groups.length) {
    sel.value = "__manual__";
  }
}

function applyLoopSelect() {
  const val = document.getElementById("lfTargetSelect").value;
  if (val === "__manual__") {
    document.getElementById("lfAdvanced").open = true;
    return;
  }
  if (!val) return;
  document.getElementById("lfTo").value = val;
  const cards = ((state.data && state.data.agentCards) || []).filter((c) => c.node === val && admissionOf(c) === "admitted" && c.dispatchable === "Yes");
  const preferred = cards.find((c) => c.skill_id === "agent") || cards[0];
  if (preferred) {
    document.getElementById("lfCap").value = preferred.skill_id || "agent";
    document.getElementById("lfWorker").value = preferred.worker || "";
  }
}

function renderTemplatePreview() {
  const box = document.getElementById("lfTemplateDesc");
  const sel = document.getElementById("lfTemplate");
  if (!box || !sel) return;
  const tpl = state.templates.find((t) => t.id === sel.value) || state.templates[0];
  if (!tpl) {
    box.innerHTML = '<span class="muted">选择模板后将自动按阶段接力执行。</span>';
    return;
  }
  const stageNames = (tpl.stages || []).map((s) => esc(s.name || s.id)).join(" → ");
  box.innerHTML = '<div>' + esc(tpl.description || "按预设阶段顺序执行并在不达标时自动打回。") + '</div>'
    + (stageNames ? '<div class="muted">流程阶段：' + stageNames + '</div>' : '');
}

async function setCardAdmission(capId, admission) {
  try {
    const res = await api("/api/v1/admin/cards/" + encodeURIComponent(capId) + "/admission", {
      method: "POST",
      body: JSON.stringify({ admission }),
    });
    if (!res || res.ok !== true || !res.card) {
      showToast("更新状态失败: 服务端响应不完整");
      return;
    }
    const labels = { admitted: "已接纳", pending: "已移回待接纳", rejected: "已拒绝" };
    showToast((labels[admission] || "已更新") + "该能力");
    await refreshState();
  } catch (e) {
    showToast("操作失败: " + e.message);
  }
}

async function admitNode(node) {
  try {
    const res = await api("/api/v1/admin/nodes/" + encodeURIComponent(node) + "/admission", {
      method: "POST",
      body: JSON.stringify({ admission: "admitted" }),
    });
    if (!res || res.ok !== true || res.updated == null) {
      showToast("接纳节点失败: 响应不完整");
      return;
    }
    showToast("已接纳节点 " + node + " 的 " + res.updated + " 项能力");
    state.agentFilter = "admitted";
    await refreshState();
  } catch (e) {
    showToast("接纳失败: " + e.message);
  }
}

function openProfileEditor(capId) {
  const c = ((state.data && state.data.agentCards) || []).find((x) => x.cap_id === capId);
  if (!c) return showToast("找不到该能力名片");
  document.getElementById("pfCap").value = c.cap_id || "";
  document.getElementById("pfName").value = c.display_name || "";
  document.getElementById("pfNote").value = c.admin_note || "";
  openModal("profileModal");
}

function setWizardStep(step) {
  state.wizardStep = step;
  document.querySelectorAll("#wizardSteps .wizard-step").forEach((el) => {
    const s = Number(el.dataset.step);
    el.classList.toggle("active", s === step);
    el.classList.toggle("done", s < step);
  });
  document.getElementById("agentStep1").style.display = step === 1 ? "block" : "none";
  document.getElementById("agentStep2").style.display = step === 2 ? "block" : "none";
  document.getElementById("agentStep3").style.display = step === 3 ? "block" : "none";
}

function syncAccessChoiceCards() {
  document.querySelectorAll("#accessChoices .choice-card").forEach((card) => {
    const checked = card.dataset.access === state.wizardAccess;
    card.classList.toggle("selected", checked);
    const radio = card.querySelector("input[type=radio]");
    if (radio) radio.checked = checked;
  });
}

function openAgentModal() {
  document.getElementById("agentStep2").reset();
  document.getElementById("onboardBox").innerHTML = "";
  const errBox = document.getElementById("agentErrBox");
  errBox.style.display = "none";
  errBox.textContent = "";
  state.wizardAccess = "http";
  syncAccessChoiceCards();
  setWizardStep(1);
  openModal("agentModal");
}

function renderOnboardingResult(res) {
  const ob = res.onboarding || {};
  const card = res.card || null;
  const token = res.token || "";
  const steps = Array.isArray(ob.steps) ? ob.steps : [];
  const skills = Array.isArray(ob.skills) ? ob.skills : [];

  let html = "";
  if (token) {
    html += '<div class="token-reveal">'
      + '<div class="token-reveal-title">专属访问密钥已生成（Token 只显示这一次）</div>'
      + '<div class="hint" style="color:var(--text);">出于安全考虑，系统不保存明文密钥，关闭窗口后将无法再次查看，请立即复制保存。</div>'
      + '<div style="display:flex;gap:8px;align-items:center;">'
      + '<input class="input mono" id="newIssuedToken" readonly value="' + esc(token) + '" />'
      + '<button type="button" class="btn sm primary" id="copyIssuedTokenBtn">复制 Token</button>'
      + '</div></div>';
  }

  if (card && card.cap_id) {
    html += '<div class="card" style="padding:12px;margin-bottom:12px;background:var(--green-soft);border-color:rgba(16,185,129,0.3);">'
      + '<strong>已准备就绪</strong>：已为它预建并自动接纳能力，上线后即可直接派单。</div>';
  } else if (ob.access === "http" && ob.role === "leader") {
    html += '<div class="card" style="padding:12px;margin-bottom:12px;">'
      + '<strong>已登记为派单方 (Leader)</strong>：它只负责派单与跟单，连接后将出现在在线概览中。</div>';
  } else {
    html += '<div class="card" style="padding:12px;margin-bottom:12px;">'
      + '<strong>已生成接入命令</strong>：目标电脑或独立 Agent 上线后，请到「Agent → 待接纳」点一次接纳即可派单。</div>';
  }

  if (ob.prompt) {
    html += '<div class="form-row"><div style="display:flex;justify-content:space-between;align-items:center;">'
      + '<label>接入提示词（直接发给您的 Agent 即可完成接入）</label>'
      + '<button type="button" class="btn sm primary" id="copyPromptBtn">一键复制提示词</button>'
      + '</div>'
      + '<textarea class="input mono" id="onboardPrompt" readonly style="min-height:120px;">' + esc(ob.prompt) + '</textarea>'
      + '</div>';
  }

  if (steps.length) {
    html += '<details class="adv-box"><summary>查看详细步骤与协议地址</summary><div class="adv-body"><ol class="steps">';
    for (const s of steps) html += "<li>" + esc(s) + "</li>";
    html += "</ol>";
    if (skills.length) {
      html += '<div class="hint" style="margin-bottom:4px;">协议文档链接：</div><ul class="steps">';
      for (const sk of skills) {
        const name = (sk && sk.name) || "";
        const url = (sk && sk.url) || "";
        html += '<li><a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(name || url) + '</a></li>';
      }
      html += "</ul>";
    }
    html += "</div></details>";
  }
  return html;
}

function openTokenRotateConfirm(node) {
  const hasExisting = state.tokensByNode.has(node);
  document.getElementById("tmTitle").textContent = hasExisting ? ("重新生成密钥 · " + node) : ("生成密钥 · " + node);
  document.getElementById("tmBody").innerHTML = '<div style="margin-bottom:14px;line-height:1.6;">'
    + (hasExisting
      ? '重新生成后，节点 <strong>' + esc(node) + '</strong> 原先的旧密钥将<strong>立即失效</strong>，需要把新密钥更新给该 Agent。'
      : '将为节点 <strong>' + esc(node) + '</strong> 签发一枚专属访问密钥。')
    + '</div>'
    + '<div style="display:flex;justify-content:flex-end;gap:8px;">'
    + '<button type="button" class="btn" data-close-modal="tokenManageModal">取消</button>'
    + '<button type="button" class="btn primary" data-action="do-rotate-token" data-node="' + esc(node) + '">'
    + (hasExisting ? '确认重新生成' : '确认生成') + '</button>'
    + '</div>';
  openModal("tokenManageModal");
}

async function doRotateToken(node) {
  try {
    const res = await api("/api/v1/admin/tokens/" + encodeURIComponent(node) + "/rotate", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const token = res.token || "";
    const prompt = (res.onboarding && res.onboarding.prompt) || "";
    document.getElementById("tmTitle").textContent = "新密钥已生成 · " + node;
    let html = '<div class="token-reveal">'
      + '<div class="token-reveal-title">Token 只显示这一次，请立即复制保存</div>'
      + '<div class="hint" style="color:var(--text);">关闭此弹窗后无法再次查看明文密钥。</div>'
      + '<div style="display:flex;gap:8px;align-items:center;">'
      + '<input class="input mono" id="rotatedTokenBox" readonly value="' + esc(token) + '" />'
      + '<button type="button" class="btn sm primary" data-action="copy-rotated-token">复制 Token</button>'
      + '</div></div>';
    if (prompt) {
      html += '<div class="form-row"><div style="display:flex;justify-content:space-between;align-items:center;">'
        + '<label>更新后的接入提示词</label>'
        + '<button type="button" class="btn sm" data-action="copy-rotated-prompt">复制提示词</button></div>'
        + '<textarea class="input mono" id="rotatedPromptBox" readonly style="min-height:110px;">' + esc(prompt) + '</textarea></div>';
    }
    html += '<div style="display:flex;justify-content:flex-end;"><button type="button" class="btn primary" data-close-modal="tokenManageModal">我已保存，关闭</button></div>';
    document.getElementById("tmBody").innerHTML = html;
    showToast("已为 " + node + " 生成新密钥");
    await refreshTokens();
    render();
  } catch (e) {
    if (e.status === 404) {
      state.tokensApiAvailable = false;
      closeModal("tokenManageModal");
      render();
      return;
    }
    showToast("生成密钥失败: " + e.message);
  }
}

function openTokenRevokeStep1(node) {
  document.getElementById("tmTitle").textContent = "吊销密钥 · " + node;
  document.getElementById("tmBody").innerHTML = '<div style="margin-bottom:14px;line-height:1.6;">'
    + '确定要吊销节点 <strong>' + esc(node) + '</strong> 的访问密钥吗？<br/>'
    + '<span class="muted">吊销后该节点会立刻失去访问中台的权限，直到您为它重新生成密钥。</span></div>'
    + '<div style="display:flex;justify-content:flex-end;gap:8px;">'
    + '<button type="button" class="btn" data-close-modal="tokenManageModal">取消</button>'
    + '<button type="button" class="btn danger" data-action="revoke-token-step2" data-node="' + esc(node) + '">下一步：确认吊销</button>'
    + '</div>';
  openModal("tokenManageModal");
}

function openTokenRevokeStep2(node) {
  document.getElementById("tmTitle").textContent = "再次确认吊销 · " + node;
  document.getElementById("tmBody").innerHTML = '<div class="err-banner">'
    + '请再次确认：即将永久吊销 <strong>' + esc(node) + '</strong> 的当前密钥，正在定时唤醒的云端 Agent 将立即被拒绝访问。</div>'
    + '<div style="display:flex;justify-content:flex-end;gap:8px;">'
    + '<button type="button" class="btn" data-close-modal="tokenManageModal">算了，保留密钥</button>'
    + '<button type="button" class="btn danger" data-action="do-revoke-token" data-node="' + esc(node) + '">确认立即吊销</button>'
    + '</div>';
}

async function doRevokeToken(node) {
  try {
    await api("/api/v1/admin/tokens/" + encodeURIComponent(node), { method: "DELETE" });
    closeModal("tokenManageModal");
    showToast("已吊销节点 " + node + " 的密钥");
    await refreshTokens();
    render();
  } catch (e) {
    if (e.status === 404) {
      state.tokensApiAvailable = false;
      closeModal("tokenManageModal");
      render();
      return;
    }
    showToast("吊销失败: " + e.message);
  }
}

function renderOverview(d) {
  const todos = computeTodos(d);
  const groups = buildNodeGroups(d);
  const tasks = (d.tasks || []).slice(0, 8);
  const runningLoops = (d.loops || []).filter((l) => l.status === "running");

  let html = '<div class="page-wrap">';

  // 1. 待我处理（绝对优先放在首屏最上方）
  html += '<div><div class="section-head">'
    + '<div class="section-title"><span>待我处理</span>'
    + (todos.total > 0 ? '<span class="badge amber">' + todos.total + ' 项需要关注</span>' : '')
    + '</div>'
    + '<span class="section-sub">优先列出需要您审批、回复、确认新 Agent 或排查故障的事项</span>'
    + '</div>';

  if (todos.total === 0) {
    html += '<div class="all-clear">'
      + '<div><div class="all-clear-title">一切正常</div>'
      + '<div class="hint" style="color:var(--text-2);margin-top:2px;">当前没有待审批任务、Agent 提问、异常告警或待接纳的新 Agent。</div></div>'
      + '<button class="btn sm primary" data-action="open-new-task">+ 派发新任务</button>'
      + '</div>';
  } else {
    html += '<div class="action-list">';
    for (const t of todos.authList) {
      html += '<div class="action-item auth">'
        + '<div style="min-width:0;flex:1;">'
        + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
        + '<span class="badge amber">待审批</span>'
        + '<strong>' + esc(t.title || t.task_id) + '</strong>'
        + '</div>'
        + '<div class="hint" style="margin-top:4px;">交给：' + esc(nodeFriendlyName(d, t.target_node)) + ' · 需要您确认后才会执行</div>'
        + '</div>'
        + '<div style="display:flex;gap:6px;flex-wrap:wrap;">'
        + '<button class="btn sm" data-action="jump-task" data-task-id="' + esc(t.task_id) + '">查看详情</button>'
        + '<button class="btn sm success" data-action="decide-approval" data-task-id="' + esc(t.task_id) + '" data-decision="approve">批准执行</button>'
        + '<button class="btn sm danger" data-action="decide-approval" data-task-id="' + esc(t.task_id) + '" data-decision="reject">驳回</button>'
        + '</div></div>';
    }
    for (const t of todos.askList) {
      html += '<div class="action-item ask">'
        + '<div style="min-width:0;flex:1;">'
        + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
        + '<span class="badge purple">Agent 提问</span>'
        + '<strong>' + esc(t.title || t.task_id) + '</strong>'
        + '</div>'
        + '<div class="hint" style="margin-top:4px;">来自：' + esc(nodeFriendlyName(d, t.target_node)) + ' · 正在等您补充说明</div>'
        + '</div>'
        + '<button class="btn sm primary" data-action="jump-task" data-task-id="' + esc(t.task_id) + '">前往答复</button>'
        + '</div>';
    }
    for (const pg of todos.pendingNodes) {
      if (pg.cards.length === 1) {
        const c = pg.cards[0];
        const cname = (c.display_name && String(c.display_name).trim()) || c.skill_name || c.skill_id || c.cap_id;
        html += '<div class="action-item pending">'
          + '<div style="min-width:0;flex:1;">'
          + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
          + '<span class="badge cyan">新 Agent 待接纳</span>'
          + '<strong>' + esc(cname) + '</strong>'
          + '<span class="mono muted">' + esc(pg.node) + '</span>'
          + '</div>'
          + '<div class="hint" style="margin-top:4px;">新接入的能力需要您点「接纳」确认身份后才能派单</div>'
          + '</div>'
          + '<div style="display:flex;gap:6px;flex-wrap:wrap;">'
          + '<button class="btn sm success" data-action="set-admission" data-cap-id="' + esc(c.cap_id) + '" data-admission="admitted">接纳</button>'
          + '<button class="btn sm danger" data-action="set-admission" data-cap-id="' + esc(c.cap_id) + '" data-admission="rejected">拒绝</button>'
          + '</div></div>';
      } else {
        html += '<div class="action-item pending">'
          + '<div style="min-width:0;flex:1;">'
          + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
          + '<span class="badge cyan">新节点待接纳</span>'
          + '<strong>' + esc(nodeFriendlyName(d, pg.node)) + '</strong>'
          + '<span class="badge">' + pg.cards.length + ' 项能力</span>'
          + '</div>'
          + '<div class="hint" style="margin-top:4px;">该节点申报了多项能力，确认可信后可一键接纳，或前往 Agent 页逐项审核</div>'
          + '</div>'
          + '<div style="display:flex;gap:6px;flex-wrap:wrap;">'
          + '<button class="btn sm" data-action="goto-pending-agents">逐项查看</button>'
          + '<button class="btn sm success" data-action="admit-node" data-node="' + esc(pg.node) + '">全部接纳</button>'
          + '</div></div>';
      }
    }
    for (const t of todos.staleList) {
      html += '<div class="action-item alert">'
        + '<div style="min-width:0;flex:1;">'
        + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
        + '<span class="badge amber">进度停滞</span>'
        + '<strong>' + esc(t.title || t.task_id) + '</strong>'
        + '</div>'
        + '<div class="hint" style="margin-top:4px;">执行节点：' + esc(nodeFriendlyName(d, t.target_node)) + ' · 最近心跳：' + esc(formatRelativeTime(t.heartbeat_at)) + '（已超过 20 分钟无汇报）</div>'
        + '</div>'
        + '<div style="display:flex;gap:6px;flex-wrap:wrap;">'
        + '<button class="btn sm" data-action="jump-task" data-task-id="' + esc(t.task_id) + '">查看详情</button>'
        + '<button class="btn sm danger" data-action="cancel-task" data-task-id="' + esc(t.task_id) + '">取消任务</button>'
        + '</div></div>';
    }
    for (const t of todos.failedList) {
      html += '<div class="action-item alert">'
        + '<div style="min-width:0;flex:1;">'
        + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
        + '<span class="badge red">' + esc((TASK_STATUS_META[t.status] && TASK_STATUS_META[t.status].label) || "任务异常") + '</span>'
        + '<strong>' + esc(t.title || t.task_id) + '</strong>'
        + '</div>'
        + '<div class="hint" style="margin-top:4px;">目标：' + esc(nodeFriendlyName(d, t.target_node)) + ' · 请查看执行记录了解失败原因</div>'
        + '</div>'
        + '<div style="display:flex;gap:6px;flex-wrap:wrap;">'
        + '<button class="btn sm" data-action="jump-task" data-task-id="' + esc(t.task_id) + '">查看原因</button>'
        + '<button class="btn sm ghost" data-action="dismiss-alert" data-task-id="' + esc(t.task_id) + '">忽略提醒</button>'
        + '</div></div>';
    }
    html += '</div>';
  }
  html += '</div>';

  // 2. Agent 在线状态概览（每个节点一行：显示名、在线/离线、最近活动「x 分钟前」、类型）
  const visibleGroups = groups.filter((g) => g.admittedCards.length > 0 || g.conn);
  const onlineCnt = visibleGroups.filter((g) => g.online).length;
  html += '<div class="card"><div class="section-head">'
    + '<div class="section-title"><span>Agent 在线状态概览</span>'
    + '<span class="badge ' + (onlineCnt > 0 ? "green" : "") + '">' + onlineCnt + ' / ' + visibleGroups.length + ' 在线</span>'
    + '<span class="section-sub">在线节点与外部 Agent 连接</span></div>'
    + '<div style="display:flex;gap:8px;"><button class="btn sm" data-action="goto-agents">管理 Agent</button>'
    + '<button class="btn sm primary" data-action="open-add-agent">+ 添加 Agent</button></div></div>';

  if (!visibleGroups.length) {
    html += '<div class="muted" style="padding:8px 0;">还没有接入任何 Agent。点击右上角「+ 添加 Agent」，按向导即可把云端 Agent 或其他电脑接进来。</div>';
  } else {
    html += '<div class="table-wrap"><table class="clean-table"><thead><tr>'
      + '<th>显示名</th><th>状态</th><th>最近活动</th><th>类型</th><th style="text-align:right;">操作</th>'
      + '</tr></thead><tbody>';
    for (const g of visibleGroups) {
      const dispatchable = g.admittedCards.find((c) => c.dispatchable === "Yes");
      let opHtml = '<span class="hint">仅派单</span>';
      if (dispatchable) {
        opHtml = '<button class="btn sm" data-action="dispatch-node" data-node="' + esc(g.node) + '" data-worker="' + esc(dispatchable.worker || "") + '" data-skill="' + esc(dispatchable.skill_id || "") + '" data-cap-id="' + esc(dispatchable.cap_id || "") + '">派发任务</button>';
      } else if (g.pendingCards.length > 0 && g.admittedCards.length === 0) {
        opHtml = '<button class="btn sm" data-action="goto-pending-agents">待接纳 (' + g.pendingCards.length + ')</button>';
      } else if (g.role !== "leader" && g.admittedCards.length === 0) {
        opHtml = '<span class="hint">无可用能力</span>';
      }
      html += '<tr>'
        + '<td><div style="font-weight:600;">' + esc(g.displayName) + '</div>'
        + (g.displayName !== g.node ? '<div class="mono muted" style="font-size:11px;">' + esc(g.node) + '</div>' : '')
        + '</td>'
        + '<td><span class="badge ' + (g.online ? "green" : "") + '"><span class="dot ' + (g.online ? "on" : "") + '" style="width:6px;height:6px;"></span>'
        + (g.online ? "在线" : "离线") + '</span></td>'
        + '<td class="muted">' + esc(formatRelativeTime(g.lastSeenAt)) + '</td>'
        + '<td class="muted">' + esc(agentTypeSummary(g.kind, g.role, g.mode)) + '</td>'
        + '<td style="text-align:right;">' + opHtml + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }
  html += '</div>';

  // 3. 最近任务
  html += '<div class="card"><div class="section-head">'
    + '<div class="section-title"><span>最近任务</span></div>'
    + '<button class="btn sm" data-action="goto-tasks">查看全部任务</button></div>';
  if (!tasks.length) {
    html += '<div class="muted" style="padding:8px 0;">还没有派发过任务。点击右上角「+ 派发任务」开始安排工作。</div>';
  } else {
    html += '<div class="table-wrap"><table class="clean-table"><thead><tr>'
      + '<th>任务内容</th><th>状态</th><th>交给谁</th><th>编号</th>'
      + '</tr></thead><tbody>';
    for (const t of tasks) {
      html += '<tr class="clickable" data-action="jump-task" data-task-id="' + esc(t.task_id) + '">'
        + '<td style="font-weight:500;">' + esc(t.title || t.task_id) + '</td>'
        + '<td>' + statusPill(t.status) + '</td>'
        + '<td class="muted">' + esc(nodeFriendlyName(d, t.target_node)) + '</td>'
        + '<td class="mono muted">' + esc(t.task_id) + '</td>'
        + '</tr>';
    }
    html += '</tbody></table></div>';
  }
  html += '</div>';

  if (runningLoops.length) {
    html += '<div><div class="section-head"><div class="section-title"><span>正在运行的 SOP 闭环</span></div>'
      + '<button class="btn sm" data-action="goto-loops">查看全部</button></div>';
    for (const l of runningLoops) html += renderLoopCard(l, d);
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function renderGlossary() {
  return '<details class="glossary">'
    + '<summary>名词一分钟看懂（接纳、Worker/Leader、能力、审批门禁）</summary>'
    + '<div class="glossary-grid">'
    + '<div class="glossary-card"><strong>接纳是什么？</strong>新接入的 Agent 必须经过您点击「接纳」确认身份后才能接活，防止陌生程序冒名连进来。</div>'
    + '<div class="glossary-card"><strong>Worker 与 Leader 的区别</strong><strong>Worker（执行方）</strong>负责实际干活并交回结果；<strong>Leader（派单方）</strong>负责拆任务并派给别人（如云端 Muse），自己不接活。</div>'
    + '<div class="glossary-card"><strong>能力（Skill）是什么？</strong>Agent 具备的具体本领（比如通用对话 <code>agent</code> 或专项脚本）。一个节点可以挂多个能力，展开卡片即可查看。</div>'
    + '<div class="glossary-card"><strong>审批门禁是什么？</strong>高风险任务在动手前会暂停并提醒您签字确认，只有您点「批准执行」才会继续运行。</div>'
    + '</div></details>';
}

function renderCapTechnicalDetails(c) {
  return '<details class="tech-details"><summary>技术详情</summary>'
    + '<div class="tech-kv mono">'
    + '<div>Cap_ID: ' + esc(c.cap_id || "-") + '</div>'
    + '<div>Skill_ID: ' + esc(c.skill_id || "-") + '</div>'
    + '<div>Worker: ' + esc(c.worker || "(无)") + '</div>'
    + '<div>Receive_Mode: ' + esc(c.receive_mode || "-") + '</div>'
    + '<div>Zone: ' + esc(c.zone || "-") + '</div>'
    + '<div>Availability: ' + esc(c.availability || "-") + '</div>'
    + '<div>Side_Effect: ' + esc(c.side_effect || "-") + '</div>'
    + '<div>Approval_Class: ' + esc(c.approval_class || "-") + '</div>'
    + '</div></details>';
}

function renderTokenManageBox(node, kind) {
  if (!state.tokensApiAvailable) return "";
  const info = state.tokensByNode.get(node);
  // 宿主节点（含 Hub 本机）走机主 Token 的 ah daemon，专属密钥对它没有意义，只会误导机主去生成。
  if (!info && kind === "host") return "";
  if (info) {
    const usedText = info.last_used_at ? formatRelativeTime(info.last_used_at) : "尚未使用";
    return '<div class="token-box">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">'
      + '<div><strong>专属密钥</strong> <span class="badge green">已签发</span></div>'
      + '<span class="mono muted">前缀: ' + esc(info.prefix || "-") + '...</span>'
      + '</div>'
      + '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">'
      + '<span class="muted">最近使用：' + esc(usedText) + '</span>'
      + '<div style="display:flex;gap:6px;">'
      + '<button class="btn sm" data-action="rotate-token" data-node="' + esc(node) + '">重新生成</button>'
      + '<button class="btn sm danger" data-action="revoke-token" data-node="' + esc(node) + '">吊销</button>'
      + '</div></div></div>';
  }
  return '<div class="token-box">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">'
    + '<div><strong>专属密钥</strong> <span class="badge">未签发</span></div>'
    + '<button class="btn sm" data-action="rotate-token" data-node="' + esc(node) + '">生成密钥</button>'
    + '</div></div>';
}

function renderCapabilityItem(c, mode) {
  const cname = (c.display_name && String(c.display_name).trim()) || c.skill_name || c.skill_id || "未命名能力";
  const note = c.admin_note && String(c.admin_note).trim();
  const approvalText = c.approval_class === "approve" ? "执行前需审批" : (c.approval_class === "notify" ? "执行时通知" : "自动执行");
  const effectText = c.side_effect === "read" ? "只读查看" : "会改动内容";

  let actions = "";
  if (mode === "admitted") {
    if (c.dispatchable === "Yes") {
      actions += '<button class="btn sm primary" data-action="dispatch-node" data-node="' + esc(c.node) + '" data-worker="' + esc(c.worker || "") + '" data-skill="' + esc(c.skill_id || "") + '" data-cap-id="' + esc(c.cap_id || "") + '">向此能力派单</button>';
    } else {
      actions += '<span class="hint">已暂停派单</span>';
    }
    actions += '<button class="btn sm" data-action="edit-profile" data-cap-id="' + esc(c.cap_id) + '">改名/备注</button>';
    actions += '<button class="btn sm" data-action="set-admission" data-cap-id="' + esc(c.cap_id) + '" data-admission="pending">移回待接纳</button>';
    actions += '<button class="btn sm danger" data-action="set-admission" data-cap-id="' + esc(c.cap_id) + '" data-admission="rejected">拒绝</button>';
  } else if (mode === "pending") {
    actions += '<button class="btn sm success" data-action="set-admission" data-cap-id="' + esc(c.cap_id) + '" data-admission="admitted">接纳</button>';
    actions += '<button class="btn sm danger" data-action="set-admission" data-cap-id="' + esc(c.cap_id) + '" data-admission="rejected">拒绝</button>';
  } else {
    actions += '<button class="btn sm" data-action="set-admission" data-cap-id="' + esc(c.cap_id) + '" data-admission="pending">恢复为待接纳</button>';
    actions += '<button class="btn sm success" data-action="set-admission" data-cap-id="' + esc(c.cap_id) + '" data-admission="admitted">接纳</button>';
  }

  return '<div class="cap-item">'
    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">'
    + '<div><div style="font-weight:600;">' + esc(cname) + '</div>'
    + (c.description ? '<div class="hint" style="margin-top:2px;">' + esc(c.description) + '</div>' : '')
    + (note ? '<div class="hint" style="margin-top:2px;color:var(--text-2);">备注：' + esc(note) + '</div>' : '')
    + '</div>'
    + '<div style="display:flex;gap:5px;flex-wrap:wrap;">'
    + '<span class="badge">' + esc(effectText) + '</span>'
    + '<span class="badge">' + esc(approvalText) + '</span>'
    + '</div></div>'
    + '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">' + actions + '</div>'
    + renderCapTechnicalDetails(c)
    + '</div>';
}

function renderAgents(d) {
  const groups = buildNodeGroups(d);
  const filter = state.agentFilter === "pending" || state.agentFilter === "rejected" ? state.agentFilter : "admitted";
  const pendingCount = groups.reduce((s, g) => s + g.pendingCards.length, 0);
  const rejectedCount = groups.reduce((s, g) => s + g.rejectedCards.length, 0);
  const admittedGroups = groups.filter((g) => g.admittedCards.length > 0 || (g.conn && g.role === "leader"));
  const pendingGroups = groups.filter((g) => g.pendingCards.length > 0);
  const rejectedGroups = groups.filter((g) => g.rejectedCards.length > 0);

  let html = '<div class="page-wrap">';
  html += '<div class="toolbar">'
    + '<div class="seg">'
    + '<button class="chip ' + (filter === "admitted" ? "active" : "") + '" data-action="agent-filter" data-filter="admitted">已接入 (' + admittedGroups.length + ')</button>'
    + '<button class="chip ' + (filter === "pending" ? "active" : "") + '" data-action="agent-filter" data-filter="pending">待接纳 <span class="badge ' + (pendingCount ? "amber" : "") + '">' + pendingCount + '</span></button>'
    + '<button class="chip ' + (filter === "rejected" ? "active" : "") + '" data-action="agent-filter" data-filter="rejected">已拒绝 (' + rejectedCount + ')</button>'
    + '</div>'
    + '<button class="btn sm primary" data-action="open-add-agent">+ 添加 Agent</button>'
    + '</div>';

  html += renderGlossary();

  if (filter === "admitted") {
    if (!admittedGroups.length) {
      html += '<div class="card muted">当前没有已接入的 Agent。点击右上角「+ 添加 Agent」开始接入，或切换到「待接纳」确认新发现的节点。</div>';
    } else {
      html += '<div class="node-grid">';
      for (const g of admittedGroups) {
        const expanded = state.expandedNodes.has(g.node);
        const dispatchable = g.admittedCards.find((c) => c.dispatchable === "Yes");
        html += '<div class="node-card">'
          + '<div class="node-head">'
          + '<div>'
          + '<div class="node-name"><span class="dot ' + (g.online ? "on" : "") + '"></span>' + esc(g.displayName)
          + (g.displayName !== g.node ? ' <span class="mono muted" style="font-size:12px;font-weight:400;">(' + esc(g.node) + ')</span>' : '')
          + '</div>'
          + '<div class="hint" style="margin-top:4px;">' + esc(agentTypeSummary(g.kind, g.role, g.mode)) + ' · 最近活动：' + esc(formatRelativeTime(g.lastSeenAt)) + '</div>'
          + '</div>'
          + '<span class="badge ' + (g.online ? "green" : "") + '">' + (g.online ? "在线" : "离线") + '</span>'
          + '</div>';

        if (g.nodeDesc || g.adminNote) {
          html += '<div class="hint" style="color:var(--text-2);">' + esc(g.adminNote || g.nodeDesc) + '</div>';
        }

        if (!g.admittedCards.length) {
          html += '<div class="hint">' + (g.role === "leader"
            ? '纯协调者 / 外部 HTTP Agent（Leader）：仅负责派单与跟进任务，不接收外部派单。'
            : '已连接（尚未启用可执行能力）。') + '</div>';
        } else {
          html += '<div class="hint">已接纳 <strong>' + g.admittedCards.length + '</strong> 项能力</div>';
        }

        html += renderTokenManageBox(g.node, g.kind);

        html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:auto;">';
        if (dispatchable) {
          html += '<button class="btn sm primary" data-action="dispatch-node" data-node="' + esc(g.node) + '" data-worker="' + esc(dispatchable.worker || "") + '" data-skill="' + esc(dispatchable.skill_id || "") + '" data-cap-id="' + esc(dispatchable.cap_id || "") + '">派发任务</button>';
        }
        if (g.admittedCards.length > 0) {
          html += '<button class="btn sm" data-action="toggle-node" data-node="' + esc(g.node) + '">'
            + (expanded ? '收起能力' : ('展开能力 (' + g.admittedCards.length + ')')) + '</button>';
        }
        html += '</div>';

        if (expanded && g.admittedCards.length > 0) {
          html += '<div class="cap-list">';
          for (const c of g.admittedCards) html += renderCapabilityItem(c, "admitted");
          html += '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
  } else if (filter === "pending") {
    if (!pendingGroups.length) {
      html += '<div class="card muted">目前没有待接纳的新 Agent 能力。</div>';
    } else {
      html += '<div class="node-grid">';
      for (const g of pendingGroups) {
        html += '<div class="node-card">'
          + '<div class="node-head">'
          + '<div><div class="node-name">' + esc(g.displayName) + '</div>'
          + '<div class="hint">节点标识：<span class="mono">' + esc(g.node) + '</span> · ' + g.pendingCards.length + ' 项能力等待确认</div></div>'
          + '<button class="btn sm success" data-action="admit-node" data-node="' + esc(g.node) + '">全部接纳</button>'
          + '</div>'
          + '<div class="cap-list">';
        for (const c of g.pendingCards) html += renderCapabilityItem(c, "pending");
        html += '</div></div>';
      }
      html += '</div>';
    }
  } else {
    if (!rejectedGroups.length) {
      html += '<div class="card muted">没有已拒绝的能力名片。</div>';
    } else {
      html += '<div class="node-grid">';
      for (const g of rejectedGroups) {
        html += '<div class="node-card">'
          + '<div class="node-head"><div><div class="node-name">' + esc(g.displayName) + '</div>'
          + '<div class="hint mono">' + esc(g.node) + '</div></div></div>'
          + '<div class="cap-list">';
        for (const c of g.rejectedCards) html += renderCapabilityItem(c, "rejected");
        html += '</div></div>';
      }
      html += '</div>';
    }
  }

  html += '<details class="glossary">'
    + '<summary>开发者接入说明（协议 Skill 与自发现地址）</summary>'
    + '<div style="margin-top:10px;font-size:12px;color:var(--muted);line-height:1.7;">'
    + '<div>服务自发现名片：<span class="mono">GET /.well-known/agent.json</span> · 协议文档：<span class="mono">GET /api/v1/skills</span> / <span class="mono">GET /api/v1/skills/{name}</span></div>'
    + '<div>纯协调者 / 外部 HTTP Agent：执行方 <span class="mono">a2a-worker</span> · 派单方 <span class="mono">a2a-leader</span> · 本机独立 Agent <span class="mono">ah-inbox</span></div>'
    + '<div class="mono">· ah（控制端 + CLI）：Hub / 工作机主控终端派单与闭环编排，不按接入方式下发。</div>'
    + '</div></details>';

  html += '</div>';
  return html;
}

function renderTasks(d) {
  const tasks = d.tasks || [];
  const filterDefs = [
    { key: "ALL", label: "全部", tip: "查看全部任务" },
    { key: "auth-required", label: "等待审批", tip: "auth-required" },
    { key: "input-required", label: "等待答复", tip: "input-required" },
    { key: "working", label: "执行中", tip: "working" },
    { key: "submitted", label: "待认领", tip: "submitted" },
    { key: "completed", label: "已完成", tip: "completed" },
    { key: "failed", label: "已失败", tip: "failed" },
    { key: "canceled", label: "已取消", tip: "canceled" },
  ];
  const filtered = tasks.filter((t) => {
    if (state.statusFilter !== "ALL" && t.status !== state.statusFilter) return false;
    if (state.search) {
      const q = state.search.toLowerCase();
      const friendly = nodeFriendlyName(d, t.target_node);
      return (t.task_id + " " + t.title + " " + t.target_node + " " + friendly + " " + t.skill_id).toLowerCase().includes(q);
    }
    return true;
  });

  let listHtml = '<div class="task-list-col">'
    + '<div class="task-filters">'
    + '<input class="input" id="taskSearchInput" placeholder="搜索任务内容、编号或 Agent..." value="' + esc(state.search) + '" />'
    + '<div class="chip-row">';
  for (const f of filterDefs) {
    listHtml += '<button class="chip ' + (state.statusFilter === f.key ? "active" : "") + '" title="' + esc(f.tip) + '" data-action="task-filter" data-filter="' + esc(f.key) + '">' + esc(f.label) + '</button>';
  }
  listHtml += '</div></div><div class="task-items">';
  if (!filtered.length) {
    listHtml += '<div class="muted" style="padding:24px;text-align:center;">没有符合条件的任务</div>';
  } else {
    for (const t of filtered) {
      const sel = state.selectedTaskId === t.task_id ? " selected" : "";
      listHtml += '<div class="task-item' + sel + '" data-action="select-task" data-task-id="' + esc(t.task_id) + '">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:5px;">'
        + '<span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(t.title || t.task_id) + '</span>'
        + statusPill(t.status)
        + '</div>'
        + '<div class="hint" style="font-size:12px;">' + esc(nodeFriendlyName(d, t.target_node)) + ' · <span class="mono">' + esc(t.task_id) + '</span></div>'
        + '</div>';
    }
  }
  listHtml += '</div></div>';

  let detailHtml = '<div class="task-detail-col">';
  const det = state.selectedTaskDetail;
  if (!det || !det.task) {
    detailHtml += '<div class="muted" style="margin:auto;text-align:center;">请从左侧选择一条任务<br/><span style="font-size:12px;">可查看执行对话、审批请求与交付产物</span></div>';
  } else {
    const t = det.task;
    const isTerminal = ["completed", "failed", "canceled", "rejected"].includes(t.status);
    detailHtml += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-bottom:1px solid var(--border);padding-bottom:14px;flex-wrap:wrap;">'
      + '<div style="min-width:0;flex:1;">'
      + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">'
      + '<span style="font-size:16px;font-weight:650;">' + esc(t.title || t.task_id) + '</span>'
      + statusPill(t.status)
      + '</div>'
      + '<div class="hint" style="margin-top:6px;">交给：' + esc(nodeFriendlyName(d, t.target_node)) + ' · 能力：' + esc(t.skill_id || "-") + ' · 编号：<span class="mono">' + esc(t.task_id) + '</span></div>'
      + '</div>'
      + (!isTerminal ? '<button class="btn sm danger" data-action="cancel-task" data-task-id="' + esc(t.task_id) + '">取消任务</button>' : '')
      + '</div>';

    if (t.status === "auth-required") {
      detailHtml += '<div class="action-banner">'
        + '<div style="font-weight:650;">需要您批准后才会继续执行</div>'
        + '<div class="hint" style="color:var(--text-2);">点击批准后，Hub 会立即发送带签名的审批凭证唤醒目标 Agent。</div>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
        + '<button class="btn success" data-action="decide-approval" data-task-id="' + esc(t.task_id) + '" data-decision="approve">批准执行</button>'
        + '<button class="btn danger" data-action="decide-approval" data-task-id="' + esc(t.task_id) + '" data-decision="reject">驳回并取消</button>'
        + '</div></div>';
    }

    if (t.status === "input-required") {
      detailHtml += '<div class="action-banner ask">'
        + '<div style="font-weight:650;">Agent 正在等待您的补充答复</div>'
        + '<textarea class="input" id="replyTextBox" placeholder="输入您的回答或补充说明，提交后 Agent 将继续执行..."></textarea>'
        + '<div style="display:flex;justify-content:flex-end;">'
        + '<button class="btn primary" data-action="reply-task" data-task-id="' + esc(t.task_id) + '">发送答复并继续</button>'
        + '</div></div>';
    }

    detailHtml += '<div class="section-title"><span>沟通记录 (' + (det.messages || []).length + ')</span></div><div class="msg-list">';
    for (const m of (det.messages || [])) {
      const cls = String(m.kind || "").startsWith("auth") ? "auth" : (m.role === "user" ? "user" : "agent");
      const kindLabel = MSG_KIND_LABELS[m.kind] || m.kind;
      detailHtml += '<div class="msg-bubble ' + cls + '">'
        + '<div class="msg-head"><span><strong>' + esc(kindLabel) + '</strong> · ' + esc(nodeFriendlyName(d, m.from_node)) + ' → ' + esc(nodeFriendlyName(d, m.to_node)) + '</span>'
        + '<span class="mono">' + esc(m.created_at || "") + '</span></div>';
      for (const p of (m.parts || [])) {
        if (p.kind === "text" && p.text) {
          detailHtml += '<div class="msg-body">' + esc(p.text) + '</div>';
        } else if (p.kind === "file") {
          detailHtml += '<div class="data-box">附件：' + esc(p.file_name || p.file_uri) + ' (' + esc(p.file_uri) + ')</div>';
        } else if (p.kind === "data" && p.data) {
          detailHtml += '<div class="data-box">' + esc(p.data) + '</div>';
        }
      }
      detailHtml += '</div>';
    }
    detailHtml += '</div>';

    if (det.artifacts && det.artifacts.length) {
      detailHtml += '<div class="section-title"><span>交付结果与文件 (' + det.artifacts.length + ')</span></div>';
      for (const a of det.artifacts) {
        detailHtml += '<div class="card" style="padding:12px;">'
          + '<div><strong>' + esc(a.name || "交付产物") + '</strong></div>'
          + (a.description ? '<div class="hint" style="margin-top:3px;">' + esc(a.description) + '</div>' : '')
          + (a.files || []).map((f) => '<div class="mono" style="margin-top:4px;">' + esc(f.file_name || f.file_uri) + ' · ' + esc(f.file_uri) + '</div>').join("")
          + '</div>';
      }
    }

    if (det.runs && det.runs.length) {
      detailHtml += '<details class="tech-details"><summary>执行台账 (' + det.runs.length + ' 次运行)</summary><div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">';
      for (const r of det.runs) {
        detailHtml += '<div class="card mono" style="padding:10px 12px;">'
          + '<div>' + esc(r.run_id) + ' · 节点=' + esc(r.node) + ' · 结果=<strong>' + esc(r.outcome) + '</strong></div>'
          + '<div class="muted">' + esc(r.started_at) + ' → ' + esc(r.finished_at || "-") + '</div>'
          + (r.error_log ? '<div style="color:var(--red-text);margin-top:4px;white-space:pre-wrap;">' + esc(r.error_log) + '</div>' : '')
          + '</div>';
      }
      detailHtml += '</div></details>';
    }

    detailHtml += '<details class="tech-details"><summary>任务技术详情</summary><div class="tech-kv mono">'
      + '<div>Task_ID: ' + esc(t.task_id) + '</div>'
      + '<div>Context_ID: ' + esc(t.context_id || "-") + '</div>'
      + '<div>Worker_Hint: ' + esc(t.worker_hint || "(无)") + '</div>'
      + '<div>Approval_Class: ' + esc(t.approval_class || "auto") + '</div>'
      + '<div>Hop_Count: ' + esc(t.hop_count || 0) + '</div>'
      + '<div>Heartbeat: ' + esc(t.heartbeat_at || "-") + '</div>'
      + '</div></details>';
  }
  detailHtml += '</div>';
  return '<div class="tasks-split">' + listHtml + detailHtml + '</div>';
}

function renderLoopCard(l, d) {
  const stages = l.stages || [];
  let stageHtml = '<div class="loop-stages">';
  stages.forEach((s, idx) => {
    const cls = l.status === "completed" || idx < l.stage_index ? "done" : (idx === l.stage_index && l.status === "running" ? "current" : "");
    const targetName = s.to ? nodeFriendlyName(d, s.to) : (s.cap || "");
    stageHtml += '<div class="stage-node ' + cls + '"><span>' + esc(s.name || s.id) + '</span>'
      + (targetName ? '<span class="muted">(' + esc(targetName) + ')</span>' : '') + '</div>';
    if (idx < stages.length - 1) stageHtml += '<span class="stage-arrow">→</span>';
  });
  stageHtml += '</div>';

  return '<div class="card" style="margin-bottom:12px;">'
    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">'
    + '<div style="min-width:0;flex:1;">'
    + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
    + '<span style="font-size:15px;font-weight:650;">' + esc(l.title || l.loop_id) + '</span>'
    + statusPill(l.status, true)
    + '<span class="badge">第 ' + esc(l.iteration) + ' / ' + esc(l.max_iterations) + ' 轮</span>'
    + '</div>'
    + '<div class="muted" style="margin-top:4px;">' + esc(l.goal) + '</div>'
    + '</div>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
    + (l.active_task_id ? '<button class="btn sm" data-action="jump-task" data-task-id="' + esc(l.active_task_id) + '">查看当前步骤</button>' : '')
    + (l.status === "running" ? '<button class="btn sm danger" data-action="cancel-loop" data-loop-id="' + esc(l.loop_id) + '">终止闭环</button>' : '')
    + '</div></div>'
    + stageHtml
    + (l.last_error ? '<div style="margin-top:10px;color:var(--amber-text);font-size:12px;">上轮打回原因：' + esc(l.last_error.slice(0, 300)) + '</div>' : '')
    + (l.error ? '<div style="margin-top:6px;color:var(--red-text);font-size:12px;">终止原因：' + esc(l.error) + '</div>' : '')
    + '</div>';
}

function renderLoops(d) {
  const loops = d.loops || [];
  let html = '<div class="page-wrap">';
  html += '<div class="toolbar">'
    + '<div><div class="section-title">SOP 多阶段自动闭环</div>'
    + '<div class="section-sub">让多个步骤按顺序自动接力（例如：规划 → 实现 → 验收），检查不通过会自动带意见退回修改。</div></div>'
    + '<button class="btn sm primary" data-action="open-new-loop">+ 新建闭环</button>'
    + '</div>';
  if (!loops.length) {
    html += '<div class="card muted">还没有运行过 SOP 闭环。点击右上角「+ 新建闭环」，选择一个预设工作流模板即可开始。</div>';
  } else {
    html += '<div>';
    for (const l of loops) html += renderLoopCard(l, d);
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function render() {
  const d = state.data;
  const el = document.getElementById("content");
  if (!d) {
    el.innerHTML = '<div class="page-wrap"><div class="card muted">正在连接 Hub 中台...</div></div>';
    return;
  }
  if (state.view === "overview") el.innerHTML = renderOverview(d);
  else if (state.view === "agents") el.innerHTML = renderAgents(d);
  else if (state.view === "tasks") {
    el.innerHTML = renderTasks(d);
    const si = document.getElementById("taskSearchInput");
    if (si) {
      si.addEventListener("input", (e) => {
        const pos = e.target.selectionStart;
        state.search = e.target.value;
        render();
        const next = document.getElementById("taskSearchInput");
        if (next) {
          next.focus();
          try { next.setSelectionRange(pos, pos); } catch {}
        }
      });
    }
  } else if (state.view === "loops") {
    el.innerHTML = renderLoops(d);
  }
}

function syncNav() {
  const titles = {
    overview: "首页 · 待我处理",
    agents: "Agent 管理",
    tasks: "任务与沟通记录",
    loops: "SOP 多阶段闭环",
  };
  document.getElementById("viewTitle").textContent = titles[state.view] || "";
  document.querySelectorAll(".nav-btn[data-view]").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === state.view);
  });
}

async function openLoopModal() {
  fillLoopCandidates();
  try {
    const res = await api("/api/v1/loop-templates");
    state.templates = res.templates || [];
    const sel = document.getElementById("lfTemplate");
    sel.innerHTML = state.templates.map((t) => '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>').join("");
    renderTemplatePreview();
  } catch {}
  openModal("loopModal");
}

function openNewTaskModal() {
  fillDispatchCandidates();
  const critWrap = document.getElementById("criteriaRows");
  if (critWrap && !critWrap.children.length) critWrap.innerHTML = "";
  openModal("taskModal");
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
        txt.textContent = "等待密钥验证";
        await new Promise((res) => setTimeout(res, 3000));
        continue;
      }
      const d = await r.json();
      dot.className = "dot on";
      txt.textContent = "已实时连接";
      if (d.cursor != null) state.cursor = d.cursor;
      document.getElementById("seqText").textContent = "同步序号: " + state.cursor;
      if (d.wake) await refreshState();
    } catch {
      dot.className = "dot err";
      txt.textContent = "重连中...";
      await new Promise((res) => setTimeout(res, 2500));
    }
  }
}

// 统一事件委托：避免在 HTML 属性里拼装动态 JS 字符串，彻底规避引号注入风险。
document.addEventListener("click", (e) => {
  const closeTarget = e.target.closest("[data-close-modal]");
  if (closeTarget) {
    closeModal(closeTarget.dataset.closeModal);
    return;
  }
  const navTarget = e.target.closest(".nav-btn[data-view]");
  if (navTarget) {
    state.view = navTarget.dataset.view;
    syncNav();
    render();
    return;
  }
  const actEl = e.target.closest("[data-action]");
  if (!actEl) return;
  const act = actEl.dataset.action;
  if (act === "open-new-task") openNewTaskModal();
  else if (act === "open-add-agent") openAgentModal();
  else if (act === "open-new-loop") openLoopModal();
  else if (act === "goto-agents") { state.view = "agents"; syncNav(); render(); }
  else if (act === "goto-pending-agents") { state.view = "agents"; state.agentFilter = "pending"; syncNav(); render(); }
  else if (act === "goto-tasks") { state.view = "tasks"; syncNav(); render(); }
  else if (act === "goto-loops") { state.view = "loops"; syncNav(); render(); }
  else if (act === "jump-task") jumpToTask(actEl.dataset.taskId);
  else if (act === "select-task") loadTaskDetail(actEl.dataset.taskId);
  else if (act === "decide-approval") decideApproval(actEl.dataset.taskId, actEl.dataset.decision);
  else if (act === "reply-task") replyTask(actEl.dataset.taskId);
  else if (act === "cancel-task") cancelTaskAction(actEl.dataset.taskId);
  else if (act === "cancel-loop") cancelLoopAction(actEl.dataset.loopId);
  else if (act === "dismiss-alert") dismissFailedAlert(actEl.dataset.taskId);
  else if (act === "set-admission") setCardAdmission(actEl.dataset.capId, actEl.dataset.admission);
  else if (act === "admit-node") admitNode(actEl.dataset.node);
  else if (act === "edit-profile") openProfileEditor(actEl.dataset.capId);
  else if (act === "dispatch-node") openDispatchFor(actEl.dataset.node, actEl.dataset.worker, actEl.dataset.skill, actEl.dataset.capId);
  else if (act === "toggle-node") {
    const n = actEl.dataset.node;
    if (state.expandedNodes.has(n)) state.expandedNodes.delete(n);
    else state.expandedNodes.add(n);
    render();
  }
  else if (act === "agent-filter") {
    const f = actEl.dataset.filter;
    if (f === "admitted" || f === "pending" || f === "rejected") {
      state.agentFilter = f;
      render();
    }
  }
  else if (act === "task-filter") {
    state.statusFilter = actEl.dataset.filter || "ALL";
    render();
  }
  else if (act === "rotate-token") openTokenRotateConfirm(actEl.dataset.node);
  else if (act === "do-rotate-token") doRotateToken(actEl.dataset.node);
  else if (act === "revoke-token") openTokenRevokeStep1(actEl.dataset.node);
  else if (act === "revoke-token-step2") openTokenRevokeStep2(actEl.dataset.node);
  else if (act === "do-revoke-token") doRevokeToken(actEl.dataset.node);
  else if (act === "copy-rotated-token") {
    const box = document.getElementById("rotatedTokenBox");
    copyText(box ? box.value : "", "已复制新 Token");
  }
  else if (act === "copy-rotated-prompt") {
    const box = document.getElementById("rotatedPromptBox");
    copyText(box ? box.value : "", "已复制接入提示词");
  }
});

document.getElementById("btnRefresh").addEventListener("click", refreshState);
document.getElementById("btnNewTask").addEventListener("click", openNewTaskModal);
document.getElementById("btnNewLoop").addEventListener("click", openLoopModal);
document.getElementById("btnTheme").addEventListener("click", toggleTheme);
document.getElementById("mobileThemeBtn").addEventListener("click", toggleTheme);
document.getElementById("btnToken").addEventListener("click", () => {
  document.getElementById("tokenInput").value = state.token;
  openModal("tokenModal");
});
document.getElementById("mobileTokenBtn").addEventListener("click", () => {
  document.getElementById("tokenInput").value = state.token;
  openModal("tokenModal");
});
document.getElementById("saveTokenBtn").addEventListener("click", () => {
  state.token = document.getElementById("tokenInput").value.trim();
  localStorage.setItem("a2a_hub_token", state.token);
  closeModal("tokenModal");
  refreshState();
});

document.getElementById("tfTargetSelect").addEventListener("change", applyDispatchSelect);
document.getElementById("lfTargetSelect").addEventListener("change", applyLoopSelect);
document.getElementById("lfTemplate").addEventListener("change", renderTemplatePreview);
document.getElementById("addCritBtn").addEventListener("click", () => addCriteriaRow("", false));
document.getElementById("criteriaRows").addEventListener("click", (e) => {
  if (e.target && e.target.classList.contains("crit-del")) {
    const row = e.target.closest(".crit-row");
    if (row) row.remove();
  }
});

document.getElementById("accessChoices").addEventListener("click", (e) => {
  const card = e.target.closest(".choice-card[data-access]");
  if (!card) return;
  state.wizardAccess = card.dataset.access;
  syncAccessChoiceCards();
});
document.getElementById("agentNextBtn").addEventListener("click", () => {
  setWizardStep(2);
  const roleVal = document.getElementById("afRole").value;
  document.getElementById("afDescRow").style.display = (state.wizardAccess === "http" && roleVal !== "leader") ? "flex" : "none";
});
document.getElementById("afRole").addEventListener("change", (e) => {
  document.getElementById("afDescRow").style.display = (state.wizardAccess === "http" && e.target.value !== "leader") ? "flex" : "none";
});
document.getElementById("agentPrevBtn").addEventListener("click", () => setWizardStep(1));
document.getElementById("agentAddAnotherBtn").addEventListener("click", openAgentModal);
document.getElementById("agentModal").addEventListener("click", (e) => {
  if (e.target && e.target.id === "copyPromptBtn") {
    const el = document.getElementById("onboardPrompt");
    copyText(el ? el.value : "", "已复制接入提示词");
  } else if (e.target && e.target.id === "copyIssuedTokenBtn") {
    const el = document.getElementById("newIssuedToken");
    copyText(el ? el.value : "", "已复制 Token");
  }
});

document.getElementById("agentStep2").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errBox = document.getElementById("agentErrBox");
  errBox.style.display = "none";
  errBox.textContent = "";

  const node = document.getElementById("afNode").value.trim();
  const access = state.wizardAccess;
  const role = document.getElementById("afRole").value;
  const displayName = document.getElementById("afName").value.trim();
  const adminNote = document.getElementById("afNote").value.trim();
  const description = document.getElementById("afDesc").value.trim();

  if (!node) return showToast("请填写节点标识");
  const body = { node, access, role };
  if (displayName) body.display_name = displayName;
  if (adminNote) body.admin_note = adminNote;
  if (description) body.description = description;

  try {
    const res = await api("/api/v1/admin/agents", { method: "POST", body: JSON.stringify(body) });
    if (!res || res.ok !== true) {
      showToast("添加失败: 服务端响应异常");
      return;
    }
    document.getElementById("onboardBox").innerHTML = renderOnboardingResult(res);
    setWizardStep(3);
    showToast("已添加 " + (res.node || node));
    if (res.card) state.agentFilter = "admitted";
    await refreshState();
  } catch (err) {
    let msg = err.message || "添加失败";
    if (err.status === 409) {
      msg += "（如果该节点已存在并需要更换访问密钥，请到 Agent 页面对应卡片中点击「重新生成」）";
    }
    errBox.textContent = msg;
    errBox.style.display = "block";
    showToast(err.message);
  }
});

document.getElementById("profileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const capId = document.getElementById("pfCap").value;
  const displayName = document.getElementById("pfName").value.trim();
  const adminNote = document.getElementById("pfNote").value.trim();
  if (!capId) return showToast("缺少能力标识");
  try {
    const res = await api("/api/v1/admin/cards/" + encodeURIComponent(capId) + "/profile", {
      method: "PATCH",
      body: JSON.stringify({ display_name: displayName, admin_note: adminNote }),
    });
    if (!res || res.ok !== true || !res.card) return showToast("保存失败: 响应不完整");
    closeModal("profileModal");
    showToast("已更新名称与备注");
    await refreshState();
  } catch (err) {
    showToast("保存失败: " + err.message);
  }
});

document.getElementById("taskForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const to = document.getElementById("tfTo").value.trim();
    const cap = document.getElementById("tfCap").value.trim();
    const worker = document.getElementById("tfWorker").value.trim();
    const text = document.getElementById("tfText").value;
    if (!to && !cap) {
      document.getElementById("tfAdvanced").open = true;
      return showToast("请选择「交给谁」，或在高级选项中填写目标节点");
    }
    const body = {
      to,
      cap,
      worker,
      text,
      approval: document.getElementById("tfRequireApproval").checked ? "approve" : "",
      context: document.getElementById("tfContext").value.trim(),
    };
    const rows = Array.from(document.querySelectorAll("#criteriaRows .crit-row"));
    const criteria = [];
    let idx = 1;
    for (const r of rows) {
      const t = (r.querySelector(".crit-text") && r.querySelector(".crit-text").value || "").trim();
      if (!t) continue;
      const ev = Boolean(r.querySelector(".crit-ev") && r.querySelector(".crit-ev").checked);
      criteria.push({ id: "c" + idx++, text: t, evidence_required: ev });
    }
    if (criteria.length) body.criteria = criteria;

    const res = await api("/api/v1/tasks", { method: "POST", body: JSON.stringify(body) });
    document.getElementById("taskForm").reset();
    document.getElementById("criteriaRows").innerHTML = "";
    closeModal("taskModal");
    showToast("任务已派发");
    await refreshState();
    jumpToTask(res.task_id);
  } catch (err) {
    showToast("派发失败: " + err.message);
  }
});

document.getElementById("loopForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const to = document.getElementById("lfTo").value.trim();
    const cap = document.getElementById("lfCap").value.trim();
    if (!to && !cap) {
      document.getElementById("lfAdvanced").open = true;
      return showToast("请选择执行节点，或在高级选项中填写");
    }
    const body = {
      template: document.getElementById("lfTemplate").value,
      goal: document.getElementById("lfGoal").value,
      to,
      cap,
      worker: document.getElementById("lfWorker").value.trim(),
      maxIterations: Number(document.getElementById("lfMaxIter").value) || 5,
    };
    await api("/api/v1/loops", { method: "POST", body: JSON.stringify(body) });
    document.getElementById("loopForm").reset();
    closeModal("loopModal");
    showToast("SOP 闭环已启动");
    state.view = "loops";
    syncNav();
    await refreshState();
  } catch (err) {
    showToast("创建闭环失败: " + err.message);
  }
});

refreshState();
startLongPoll();
</script>
</body>
</html>`;
}
