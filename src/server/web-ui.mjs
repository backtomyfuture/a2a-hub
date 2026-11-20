// 内置 Web 控制台（零外部构建依赖、无外网 CDN 依赖，局域网/离线可用）。
// 面向非开发者机主视角设计：用大白话表达状态与操作，把技术参数折叠在高级/技术详情中。

import { AGENT_TEMPLATE_PRESETS } from "../hub/admission.mjs";

export function renderWebConsoleHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>A2A-Hub · 多节点编排控制台</title>
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
  .dot.warn { background: var(--amber); box-shadow: 0 0 0 3px var(--amber-soft); }
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
  .agent-group {
    padding: 10px; border-radius: 9px; background: var(--bg); border: 1px solid var(--border);
    display: flex; flex-direction: column; gap: 8px;
  }
  .sub-group-title {
    font-size: 12px; font-weight: 650; color: var(--text-2);
    display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  }
  .cap-item {
    padding: 11px 12px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border);
    display: flex; flex-direction: column; gap: 8px;
  }
  .info-banner {
    padding: 11px 13px; border-radius: 8px; background: var(--accent-soft);
    border: 1px solid rgba(99,102,241,0.28); font-size: 12px; line-height: 1.6; color: var(--text-2);
    margin-bottom: 14px;
  }
  .info-banner strong { color: var(--text); }
  .stage-bind-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
  .stage-bind-row {
    display: grid; grid-template-columns: 150px 1fr 1fr; gap: 8px; align-items: center;
    padding: 8px 10px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border);
  }
  .bulk-bind-bar {
    display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center;
    padding: 8px 10px; border-radius: 8px; background: var(--surface-2); border: 1px dashed var(--border-strong);
    margin-bottom: 8px;
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

  .att-list { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
  .msg-bubble .att-card { margin-top: 8px; }
  .att-card {
    display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
    padding: 9px 11px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border);
  }
  .att-preview { flex-basis: 100%; }
  .att-thumb {
    max-height: 160px; max-width: 100%; border-radius: 7px; border: 1px solid var(--border);
    cursor: zoom-in; object-fit: contain; display: block; background: var(--surface-2);
  }
  .att-loading {
    padding: 12px; border-radius: 7px; border: 1px dashed var(--border-strong);
    background: var(--surface-2); text-align: center;
  }
  .att-meta { min-width: 0; flex: 1; }
  .att-name { font-size: 13px; font-weight: 550; word-break: break-word; }
  .att-sub { font-size: 11px; color: var(--muted); word-break: break-all; margin-top: 2px; }
  .att-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .att-draft-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  .att-draft-item {
    display: flex; flex-direction: column; gap: 5px; padding: 8px 10px;
    border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); font-size: 12px;
  }
  .att-draft-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .att-prog { height: 4px; width: 100%; border-radius: 999px; background: var(--border); overflow: hidden; }
  .att-prog-bar { height: 100%; background: var(--accent); transition: width .12s; }
  .att-prog-bar.done { background: var(--green); }
  .att-prog-bar.err { background: var(--red); }
  .att-lightbox-img {
    max-width: 100%; max-height: 75vh; object-fit: contain; display: block; margin: 0 auto;
    border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2);
  }

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
    .stage-bind-row, .bulk-bind-bar { grid-template-columns: 1fr; }
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
        <span>节点</span>
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
      <button class="nav-btn" data-view="schedules">
        <span>定时任务</span>
        <span class="badge" id="navScheduleCount">0</span>
      </button>
    </nav>
    <div class="sidebar-footer">
      <div class="conn-pill">
        <span class="dot" id="pollDot"></span>
        <div style="min-width:0;">
          <div id="pollText" style="color:var(--text);font-weight:500;">连接中...</div>
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
      <button class="nav-btn" data-view="agents">节点</button>
      <button class="nav-btn" data-view="tasks">任务</button>
      <button class="nav-btn" data-view="loops">SOP 闭环</button>
      <button class="nav-btn" data-view="schedules">定时任务</button>
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
        <div class="hint" id="tfTargetHint">只列出您已接纳且可接收任务的节点与能力。</div>
      </div>
      <div class="form-row">
        <label>要做什么</label>
        <textarea class="input" id="tfText" placeholder="用大白话描述您想让它完成什么事情、有什么背景要求..."></textarea>
      </div>
      <div class="form-row">
        <label>附件（可选，单个不超过 100 MB）</label>
        <input class="input" type="file" id="tfFiles" multiple />
        <div id="tfFileErr" class="err-banner" style="display:none;margin-top:6px;margin-bottom:0;"></div>
        <div id="tfFileList" class="att-draft-list"></div>
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
        <button type="submit" class="btn primary" id="tfSubmitBtn">立即派发</button>
      </div>
    </form>
  </div>
</div>

<!-- 新建 SOP 闭环弹窗 -->
<div class="modal-backdrop" id="loopModal">
  <div class="modal" style="max-width:680px;">
    <div class="modal-head">
      <span>新建 SOP 闭环</span>
      <button class="btn sm" type="button" data-close-modal="loopModal">关闭</button>
    </div>
    <div class="info-banner">
      <div><strong>什么是闭环：</strong>多阶段自动化任务链，每个阶段可派给不同节点上的不同 Agent，验收不过时自动带反馈打回修复。</div>
      <div><strong>与单次任务的区别：</strong>单次任务发给单一目标执行一次即止；闭环会按阶段自动接力并在失败/未达标时自动重跑。</div>
      <div><strong>与能力（Skill）的区别：</strong>能力是单个 Agent 具备的专长技能；闭环则是编排多个节点与能力的跨阶段协作流程。</div>
    </div>
    <form id="loopForm">
      <div class="form-row">
        <label>选择工作流模板</label>
        <select class="input" id="lfTemplate"></select>
        <div class="token-box" id="lfTemplateDesc" style="margin-top:6px;"></div>
      </div>
      <div class="form-row">
        <label>阶段分派（为每个阶段选择节点与已接纳的 Agent / 能力）</label>
        <div class="bulk-bind-bar" id="lfBulkBar">
          <select class="input" id="lfBulkNode"></select>
          <select class="input" id="lfBulkCap"></select>
          <button type="button" class="btn sm" id="lfApplyAllBtn">全部阶段用同一个</button>
        </div>
        <div class="stage-bind-list" id="lfStageBindings"></div>
      </div>
      <div class="form-row">
        <label>闭环总目标</label>
        <textarea class="input" id="lfGoal" placeholder="描述希望多个步骤接力完成的最终目标..." required></textarea>
      </div>
      <details class="adv-box" id="lfAdvanced">
        <summary>高级选项（轮次上限与手动兜底目标）</summary>
        <div class="adv-body">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div class="form-row">
              <label>最多来回几轮（1-8）</label>
              <input class="input" type="number" id="lfMaxIter" value="5" min="1" max="8" />
            </div>
            <div class="form-row">
              <label>手动兜底节点（可选）</label>
              <input class="input" id="lfTo" placeholder="仅在暂无已接纳能力时手动填写" />
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div class="form-row">
              <label>手动默认能力</label>
              <input class="input" id="lfCap" value="agent" />
            </div>
            <div class="form-row">
              <label>手动指定 Agent（Worker，可选）</label>
              <input class="input" id="lfWorker" placeholder="留空由节点默认" />
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
            <div class="hint">适合跑在云端、容器或独立脚本里的 Agent，无需本地守护进程；下一步可选「定时检查」「常驻长连接」或「Webhook 推送」。</div>
          </div>
        </label>
        <label class="choice-card" data-access="host">
          <input type="radio" name="afAccessRadio" value="host" />
          <div>
            <div style="font-weight:650;">另一台电脑（工作机节点）</div>
            <div class="hint">适合您自己的另一台 Mac / Linux / Windows 电脑，通过 ah daemon 保持出站常驻长连接（无需开放入站端口），可执行本地命令或挂载 Claude/Codex 等 Agent。</div>
          </div>
        </label>
        <label class="choice-card" data-access="inbox">
          <input type="radio" name="afAccessRadio" value="inbox" />
          <div>
            <div style="font-weight:650;">本机独立 Agent（收件箱模式）</div>
            <div class="hint">同样通过 ah daemon 保持出站常驻长连接接入中台，本地脚本通过 ah inbox 自主消费并回执任务。</div>
          </div>
        </label>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button type="button" class="btn" data-close-modal="agentModal">取消</button>
        <button type="button" class="btn primary" id="agentNextBtn">下一步</button>
      </div>
    </div>

    <form id="agentStep2" style="display:none;">
      <div class="form-row" id="afTemplateRow">
        <label>节点模板（选好后自动选择接收方式并填入默认参考值）</label>
        <select class="input" id="afTemplatePreset"></select>
        <div class="hint" id="afTemplateHint"></div>
      </div>
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
          <option value="worker">执行任务的 Worker（只接单）</option>
          <option value="leader">派单并接单 (Leader)</option>
        </select>
      </div>
      <div class="form-row" id="afReceiveGroup">
        <label>接收方式（HTTP 接入方式）</label>
        <div class="choice-list" id="receiveChoices" style="margin-bottom:0;">
          <label class="choice-card selected" data-receive="poll">
            <input type="radio" name="afReceiveRadio" value="poll" checked />
            <div>
              <div style="font-weight:600;">定时检查（poll，默认）</div>
              <div class="hint">适合被定时唤醒的云端 Agent（ChatGPT、Claude、Coze、WorkBuddy 等），按固定间隔检查并取单。</div>
            </div>
          </label>
          <label class="choice-card" data-receive="longpoll">
            <input type="radio" name="afReceiveRadio" value="longpoll" />
            <div>
              <div style="font-weight:600;">常驻长连接（longpoll）</div>
              <div class="hint">适合常驻运行的进程或临时云 VM（如 Muse），循环长轮询实时取单，无需定时任务。</div>
            </div>
          </label>
          <label class="choice-card" data-receive="webhook">
            <input type="radio" name="afReceiveRadio" value="webhook" />
            <div>
              <div style="font-weight:600;">Webhook 推送（webhook）</div>
              <div class="hint">有新任务或状态变化时，中台主动向回调 URL 推门铃通知（如 Grok Bot 或自建接收端）。</div>
            </div>
          </label>
        </div>
      </div>
      <div class="form-row" id="afPollIntervalRow">
        <label>轮询间隔（分钟）</label>
        <input class="input" id="afPollInterval" type="number" min="1" max="1440" value="5" />
        <div class="hint">默认 5 分钟（Webhook 兜底默认 30 分钟，也可填 60 表示 1 小时）。中台按此间隔 × 1.5 判定该 Agent 是否在线。</div>
      </div>
      <div class="form-row" id="afWebhookUrlRow" style="display:none;">
        <label>Webhook 回调 URL（必填）</label>
        <input class="input mono" type="url" id="afWebhookUrl" maxlength="2048" placeholder="https://example.com/a2a/webhook" />
        <div class="hint">仅允许 http/https，长度 ≤ 2048，禁止带用户名密码。密钥由接收端提供，中台不会再生成一把只显示一次的 Secret。</div>
      </div>
      <div class="form-row" id="afWebhookKeyRow" style="display:none;">
        <label>接收端提供的密钥（必填）</label>
        <input class="input mono" type="password" id="afWebhookKey" maxlength="512" autocomplete="off" />
        <div class="hint">默认放在 Authorization: Bearer。自定义请求头名时，头的值就是密钥原文。</div>
      </div>
      <div class="form-row" id="afWebhookHeaderRow" style="display:none;">
        <label>请求头名（可选，默认 Authorization）</label>
        <input class="input mono" id="afWebhookHeader" maxlength="64" placeholder="Authorization" />
      </div>
      <div class="form-row" id="afDescRow">
        <label>它擅长做什么（能力说明，可选）</label>
        <input class="input" id="afDesc" placeholder="例如：擅长写文章、查资料、整理日报" />
      </div>
      <div class="form-row">
        <label>备注（只给您自己看，可选）</label>
        <textarea class="input" id="afNote" maxlength="500" style="min-height:60px;" placeholder="例如：每 5 分钟检查一次"></textarea>
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

<!-- 添加能力弹窗（按 HTTP / 宿主节点自动切换为建卡或生成 commands.json 片段） -->
<div class="modal-backdrop" id="addCapModal">
  <div class="modal" style="max-width:580px;">
    <div class="modal-head">
      <span id="acTitle">添加能力</span>
      <button class="btn sm" type="button" data-close-modal="addCapModal">关闭</button>
    </div>
    <div id="acModeBanner" class="info-banner" style="margin-bottom:12px;"></div>
    <div id="acErrBox" class="err-banner" style="display:none;"></div>
    <form id="addCapForm">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div class="form-row">
          <label>能力标识（Skill_ID，必填）</label>
          <input class="input mono" id="acSkillId" placeholder="例如 translate / code-review" required />
          <div class="hint">字母、数字或 . _ -，不能是保留键 workers。</div>
        </div>
        <div class="form-row">
          <label>归属 Agent（Worker，可选）</label>
          <input class="input mono" id="acWorker" list="acWorkerList" placeholder="留空则为节点直属能力" />
          <datalist id="acWorkerList"></datalist>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div class="form-row">
          <label>能力名称（可选）</label>
          <input class="input" id="acSkillName" placeholder="例如：技术翻译 / 代码审查" />
        </div>
        <div class="form-row" id="acDisplayNameRow">
          <label>控制台显示名（可选）</label>
          <input class="input" id="acDisplayName" maxlength="64" placeholder="留空则使用能力名称" />
        </div>
      </div>
      <div class="form-row">
        <label>能力说明（可选）</label>
        <input class="input" id="acDesc" placeholder="简述该能力擅长做什么、输入输出要求..." />
      </div>
      <div id="acCommandRow" style="display:none;">
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;">
          <div class="form-row">
            <label>本地执行命令（未填 Worker 时必填）</label>
            <input class="input mono" id="acCommand" placeholder="例如 python3 /path/to/tool.py" />
          </div>
          <div class="form-row">
            <label>输出模式</label>
            <select class="input" id="acMode">
              <option value="agent">agent</option>
              <option value="json">json</option>
            </select>
          </div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div class="form-row">
          <label>副作用级别</label>
          <select class="input" id="acSideEffect">
            <option value="write">会改动内容 (write)</option>
            <option value="read">只读查看 (read)</option>
          </select>
        </div>
        <div class="form-row">
          <label>审批门禁</label>
          <select class="input" id="acApproval">
            <option value="auto">自动执行 (auto)</option>
            <option value="notify">执行时通知 (notify)</option>
            <option value="approve">执行前需审批 (approve)</option>
          </select>
        </div>
      </div>
      <div class="form-row" id="acNoteRow">
        <label>机主备注（可选）</label>
        <input class="input" id="acNote" maxlength="500" placeholder="仅自己可见的备注" />
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button type="button" class="btn" data-close-modal="addCapModal">取消</button>
        <button type="submit" class="btn primary" id="acSubmitBtn">添加能力</button>
      </div>
    </form>
    <div id="acSnippetBox" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--border);">
      <div class="token-reveal" style="background:var(--accent-soft);border-color:rgba(99,102,241,0.35);">
        <div style="font-weight:650;">请复制到宿主节点的 commands.json</div>
        <div class="hint" id="acSnippetHint" style="color:var(--text-2);">去该节点改 commands.json，守护进程自动热重载。</div>
        <textarea class="input mono" id="acSnippetText" readonly style="min-height:130px;"></textarea>
        <div style="display:flex;justify-content:flex-end;">
          <button type="button" class="btn sm primary" id="copySnippetBtn">复制片段</button>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- 编辑 / 查看节点 Webhook 弹窗 -->
<div class="modal-backdrop" id="webhookModal">
  <div class="modal" style="max-width:540px;">
    <div class="modal-head">
      <span id="whTitle">配置 Webhook 推送</span>
      <button class="btn sm" type="button" data-close-modal="webhookModal">关闭</button>
    </div>
    <div id="whErrBox" class="err-banner" style="display:none;"></div>
    <div id="whStatus" style="margin-bottom:12px;"></div>
    <form id="webhookForm">
      <input type="hidden" id="whNode" />
      <div class="form-row">
        <label>Webhook 回调 URL</label>
        <input class="input mono" type="url" id="whUrl" maxlength="2048" placeholder="https://example.com/a2a/webhook" required />
        <div class="hint">仅允许 http/https，长度 ≤ 2048，禁止带用户名密码。</div>
      </div>
      <div class="form-row">
        <label>接收端提供的密钥</label>
        <input class="input mono" type="password" id="whKey" maxlength="512" autocomplete="off" placeholder="留空表示不改密钥" />
        <div class="hint" id="whKeyHint">留空则沿用已保存的密钥。列表里只显示掩码。</div>
      </div>
      <div class="form-row">
        <label>请求头名（可选，默认 Authorization）</label>
        <input class="input mono" id="whHeader" maxlength="64" placeholder="Authorization" />
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
        <button type="button" class="btn" id="whTestBtn" data-action="test-webhook">测试</button>
        <div style="display:flex;gap:8px;">
          <button type="button" class="btn" data-close-modal="webhookModal">取消</button>
          <button type="submit" class="btn primary">保存</button>
        </div>
      </div>
    </form>
  </div>
</div>

<!-- 图片放大预览弹窗 -->
<div class="modal-backdrop" id="imagePreviewModal">
  <div class="modal" style="max-width:860px;">
    <div class="modal-head">
      <span id="imgPreviewTitle" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">图片预览</span>
      <div style="display:flex;gap:8px;flex-shrink:0;">
        <button type="button" class="btn sm" id="imgPreviewDownloadBtn" data-action="download-hub-file">下载原图</button>
        <button type="button" class="btn sm" data-close-modal="imagePreviewModal">关闭</button>
      </div>
    </div>
    <div>
      <img id="imgPreviewImg" class="att-lightbox-img" alt="图片预览" />
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
// 节点模板注册表（服务端数据驱动，可扩展；新增模板只需改 admission.mjs 的 AGENT_TEMPLATE_PRESETS）
const AGENT_TEMPLATES = ${JSON.stringify(AGENT_TEMPLATE_PRESETS).replace(/</g, "\\u003c")};

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
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MSG = 20;
const HUB_FILE_URI_PREFIX = "hub://files/";
// 仅对浏览器安全内嵌的光栅图白名单启用 inline 预览，刻意排除 image/svg+xml 防止 SVG 脚本执行。
const INLINE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
let draftFileSeq = 0;

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
  webhooksApiAvailable: true,
  webhooksByNode: new Map(),
  schedulesApiAvailable: true,
  schedulesError: "",
  schedules: [],
  dismissedFailed: loadDismissedAlerts(),
  cursor: 0,
  token: localStorage.getItem("a2a_hub_token") || localStorage.getItem("lobe_a2a_token") || "",
  templates: [],
  wizardStep: 1,
  wizardAccess: "http",
  wizardReceive: "poll",
  wizardTemplate: "generic",
  wizardPreset: "",
  wizardPresetDefaults: {},
  addCapTarget: { node: "", isHttp: true },
  filePreviewCache: new Map(),
  filePreviewTaskId: null,
  taskDraftFiles: [],
  taskSubmitting: false,
  replyDraftFiles: [],
  replyDraftTaskId: null,
  replySubmitting: false,
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

function formatNextFireTime(raw) {
  if (!raw) return "暂无排期";
  const ms = parseTs(raw);
  if (ms == null) return String(raw);
  const diffSec = Math.round((ms - Date.now()) / 1000);
  if (diffSec <= 0) {
    return diffSec >= -60 ? "即将触发" : ("已过预期（" + formatRelativeTime(raw) + "）");
  }
  if (diffSec < 60) return diffSec + " 秒后";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return mins + " 分钟后";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + " 小时后";
  return Math.floor(hrs / 24) + " 天后";
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
  if (role === "leader" || role === "hybrid") return "派单并接单 (Leader)";
  if (role === "worker") return "执行方 (Worker)";
  return "";
}

function kindLabelZh(kind, mode) {
  if (mode === "http-poll" || mode === "http-longpoll" || mode === "webhook") return "云端 HTTP 节点";
  if (kind === "agent") return "独立 Agent 节点";
  return "工作机节点";
}

function receiveModeLabelZh(mode) {
  if (mode === "webhook") return "Webhook 推送";
  if (mode === "http-longpoll") return "常驻长连接";
  if (mode === "http-poll") return "定时检查";
  if (mode === "longpoll") return "常驻长连接";
  return mode || "";
}

function isHttpNodeGroup(g) {
  if (!g) return false;
  if (state.tokensByNode.has(g.node)) return true;
  const httpModes = new Set(["http-poll", "http-longpoll", "webhook"]);
  if ((g.cards || []).some((c) => c.daemon_version === "http-agent" || (c.kind === "agent" && httpModes.has(c.receive_mode)))) {
    return true;
  }
  return Boolean(g.conn && g.conn.kind === "agent" && httpModes.has(g.conn.mode));
}

// 以名片上的 Receive_Mode 为准。连接上的 mode 只是当前这条链路，不能当成节点的接收方式。
function httpReceiveModeOf(g) {
  const httpModes = new Set(["http-poll", "http-longpoll", "webhook"]);
  for (const card of (g && g.cards) || []) {
    if (httpModes.has(card.receive_mode)) return card.receive_mode;
  }
  if (g && httpModes.has(g.mode)) return g.mode;
  return "";
}

function agentTypeSummary(kind, role, mode) {
  const k = kindLabelZh(kind, mode);
  const r = roleLabelZh(role);
  return r ? (k + " · " + r) : k;
}

// 卡片副标题要把接收方式写出来。宿主节点没有这档选择，仍用原来的类型加角色。
function nodeCardSubtitle(g) {
  if (!isHttpNodeGroup(g)) return agentTypeSummary(g.kind, g.role, g.mode);
  const mode = httpReceiveModeOf(g) || "http-poll";
  const receive = receiveModeLabelZh(mode) || "定时检查";
  const role = roleLabelZh(g.role);
  const head = "云端 HTTP 节点 · " + receive;
  return role ? (head + " · " + role) : head;
}

function webhookRecord(node) {
  return state.webhooksByNode.get(node) || null;
}

function webhookDeliveryCode(wh) {
  if (!wh || wh.last_status == null || String(wh.last_status) === "") return null;
  const code = Number(wh.last_status);
  return Number.isFinite(code) ? code : null;
}

function webhookRowBadge(wh) {
  if (!wh) return '<span class="badge">待投递</span>';
  if (wh.legacy) return '<span class="badge amber">需补填密钥</span>';
  const raw = wh.last_status != null ? String(wh.last_status) : "";
  if (!raw && !wh.last_error) return '<span class="badge">待投递</span>';
  const code = webhookDeliveryCode(wh);
  if (code != null && code >= 200 && code < 300) return '<span class="badge green">最近投递成功</span>';
  return '<span class="badge red">投递失败</span>';
}

// 最近一次不是 2xx（含网络错误），且这次尝试之后没有检查或成功投递。成功投递会把 lastSeenAt 推到尝试时间之后。
function deliveryUnacked(g) {
  if (!g || httpReceiveModeOf(g) !== "webhook") return false;
  const wh = webhookRecord(g.node);
  if (!wh || wh.legacy) return false;
  const raw = wh.last_status != null ? String(wh.last_status) : "";
  if (!raw && !wh.last_error) return false;
  const code = webhookDeliveryCode(wh);
  if (code != null && code >= 200 && code < 300) return false;
  const attempt = parseTs(wh.last_attempt_at);
  const seen = parseTs(g.lastSeenAt);
  if (attempt == null || seen == null) return true;
  return seen < attempt;
}

function nodeOnlineDotClass(g) {
  if (!g || !g.online) return "";
  // 窗口内仍算在线，但门铃没送到且之后没有活动时用警示色，避免和普通离线混成一种灰点。
  if (deliveryUnacked(g)) return "warn";
  return "on";
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
  if (id === "imagePreviewModal") {
    const imgEl = document.getElementById("imgPreviewImg");
    if (imgEl) imgEl.src = "";
  }
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
    const rawMsg = d && typeof d.error === "string" ? d.error : "";
    const msg = r.status === 404 && (!rawMsg || rawMsg === "Not Found")
      ? "后端接口尚未启用 (HTTP 404)"
      : (rawMsg || ("请求失败 (HTTP " + r.status + ")"));
    const err = new Error(msg);
    err.status = r.status;
    err.data = d;
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

// 并行分支尚未合并时，admin/webhooks 可能返回 404，此时静默降级并在显式操作时提示。
async function refreshWebhooks() {
  try {
    const headers = {};
    if (state.token) headers.Authorization = "Bearer " + state.token;
    const r = await fetch("/api/v1/admin/webhooks", { headers });
    if (r.status === 404) {
      state.webhooksApiAvailable = false;
      state.webhooksByNode = new Map();
      return;
    }
    if (!r.ok) return;
    const d = await r.json().catch(() => null);
    if (d && Array.isArray(d.webhooks)) {
      state.webhooksApiAvailable = true;
      state.webhooksByNode = new Map(d.webhooks.map((w) => [w.node, w]));
    }
  } catch {
    // 网络波动时不推翻已有状态
  }
}

async function refreshSchedules() {
  try {
    const headers = {};
    if (state.token) headers.Authorization = "Bearer " + state.token;
    const r = await fetch("/api/v1/schedules", { headers });
    if (r.status === 404) {
      state.schedulesApiAvailable = false;
      state.schedulesError = "";
      state.schedules = [];
      return;
    }
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      state.schedulesApiAvailable = true;
      state.schedulesError = (d && d.error) || ("获取定时任务失败 (HTTP " + r.status + ")");
      return;
    }
    state.schedulesApiAvailable = true;
    state.schedulesError = "";
    state.schedules = Array.isArray(d && d.schedules) ? d.schedules : [];
  } catch (e) {
    state.schedulesError = "拉取定时任务失败: " + e.message;
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
    const [d] = await Promise.all([api("/api/v1/state"), refreshTokens(), refreshWebhooks(), refreshSchedules()]);
    state.data = d;
    if (d.seq != null && d.seq > state.cursor) state.cursor = d.seq;
    document.getElementById("hubNodeLabel").textContent = "中台节点: " + (d.hubNode || "hub");

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

    const navSched = document.getElementById("navScheduleCount");
    if (navSched) {
      const anomalyCnt = state.schedules.filter((s) => Boolean(s.anomaly)).length;
      navSched.textContent = !state.schedulesApiAvailable
        ? "-"
        : (anomalyCnt > 0 ? (state.schedules.length + " · 异" + anomalyCnt) : String(state.schedules.length));
      navSched.className = "badge" + (anomalyCnt > 0 ? " amber" : "");
    }

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

function parseHubFileId(uri) {
  const s = String(uri || "").trim();
  if (!s.startsWith(HUB_FILE_URI_PREFIX)) return null;
  const id = s.slice(HUB_FILE_URI_PREFIX.length).trim();
  return id || null;
}

function isExternalHttpUrl(uri) {
  return /^https?:\\/\\//i.test(String(uri || "").trim());
}

function isInlineImageMime(mime) {
  const base = String(mime || "").split(";")[0].trim().toLowerCase();
  return INLINE_IMAGE_MIMES.has(base);
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function revokeAttachmentObjectUrls() {
  for (const entry of state.filePreviewCache.values()) {
    if (entry && entry.objectUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      try { URL.revokeObjectURL(entry.objectUrl); } catch {}
    }
  }
  state.filePreviewCache.clear();
  state.filePreviewTaskId = null;
  const modal = document.getElementById("imagePreviewModal");
  if (modal && modal.classList && modal.classList.contains("open")) {
    closeModal("imagePreviewModal");
  }
}

function renderAttachmentItem(file) {
  const uri = String((file && (file.file_uri || file.uri)) || "").trim();
  const name = String((file && (file.file_name || file.name)) || uri || "未命名文件").trim();
  const mime = String((file && (file.mime_type || file.mime)) || "application/octet-stream").trim();
  const rawSize = file && (file.size ?? file.file_size);
  const sizeText = rawSize != null && rawSize !== "" ? (" · " + formatBytes(rawSize)) : "";
  const fileId = parseHubFileId(uri);

  if (fileId) {
    // 详情接口已标出已清理的文件，直接按 410 展示，省掉一次注定失败的缩略图请求。
    if (file && file.deleted === true && !state.filePreviewCache.has(fileId)) {
      state.filePreviewCache.set(fileId, { status: "error", code: 410, errorText: "已过期清理" });
    }
    const cached = state.filePreviewCache.get(fileId);
    const isImg = isInlineImageMime(mime);
    let previewHtml = "";
    let statusHtml = "";
    let actionHtml = '<button type="button" class="btn sm" data-action="download-hub-file" data-file-id="' + esc(fileId) + '" data-file-name="' + esc(name) + '">下载</button>';

    if (cached && cached.status === "error") {
      statusHtml = '<span class="badge red" data-hub-status-id="' + esc(fileId) + '">' + esc(cached.errorText || "无法访问") + '</span>';
      if (cached.code === 410 || cached.code === 404 || cached.code === 403) {
        actionHtml = "";
      }
    } else if (isImg) {
      if (cached && cached.status === "ready" && cached.objectUrl) {
        previewHtml = '<div class="att-preview" data-hub-preview-id="' + esc(fileId) + '" data-file-name="' + esc(name) + '">'
          + '<img class="att-thumb" src="' + esc(cached.objectUrl) + '" alt="' + esc(name) + '" data-action="preview-image" data-file-id="' + esc(fileId) + '" data-file-name="' + esc(name) + '" />'
          + '</div>';
      } else {
        previewHtml = '<div class="att-preview att-loading" data-hub-preview-id="' + esc(fileId) + '" data-file-name="' + esc(name) + '">'
          + '<span class="hint">加载缩略图中...</span>'
          + '</div>';
      }
    }

    return '<div class="att-card" data-hub-file-card="' + esc(fileId) + '">'
      + previewHtml
      + '<div class="att-meta">'
      + '<div class="att-name">' + esc(name) + '</div>'
      + '<div class="att-sub mono">' + esc(mime) + esc(sizeText) + '</div>'
      + '</div>'
      + '<div class="att-actions">'
      + statusHtml
      + actionHtml
      + '</div>'
      + '</div>';
  }

  if (isExternalHttpUrl(uri)) {
    return '<div class="att-card">'
      + '<div class="att-meta">'
      + '<div class="att-name">' + esc(name) + '</div>'
      + '<div class="att-sub mono">' + esc(mime) + esc(sizeText) + ' · ' + esc(uri) + '</div>'
      + '</div>'
      + '<div class="att-actions">'
      + '<a class="btn sm" href="' + esc(uri) + '" target="_blank" rel="noopener noreferrer">打开外链</a>'
      + '</div>'
      + '</div>';
  }

  return '<div class="att-card">'
    + '<div class="att-meta">'
    + '<div class="att-name">' + esc(name) + '</div>'
    + '<div class="att-sub mono">' + esc(mime) + esc(sizeText) + (uri ? ' · ' + esc(uri) : '') + '</div>'
    + '</div>'
    + '</div>';
}

function updateHubFileCardDom(fileId) {
  const cached = state.filePreviewCache.get(fileId);
  if (!cached) return;
  const cards = Array.from(document.querySelectorAll("[data-hub-file-card]") || [])
    .filter((el) => el.dataset && el.dataset.hubFileCard === fileId);
  for (const card of cards) {
    const previewEl = card.querySelector ? card.querySelector("[data-hub-preview-id]") : null;
    const actionsEl = card.querySelector ? card.querySelector(".att-actions") : null;
    if (cached.status === "ready" && cached.objectUrl && previewEl) {
      const name = (previewEl.dataset && previewEl.dataset.fileName) || "image";
      previewEl.classList.remove("att-loading");
      previewEl.innerHTML = '<img class="att-thumb" src="' + esc(cached.objectUrl) + '" alt="' + esc(name) + '" data-action="preview-image" data-file-id="' + esc(fileId) + '" data-file-name="' + esc(name) + '" />';
    } else if (cached.status === "error") {
      if (previewEl && typeof previewEl.remove === "function") previewEl.remove();
      if (actionsEl) {
        const hideDownload = cached.code === 410 || cached.code === 404 || cached.code === 403;
        const dlBtn = actionsEl.querySelector ? actionsEl.querySelector('[data-action="download-hub-file"]') : null;
        if (hideDownload && dlBtn && typeof dlBtn.remove === "function") dlBtn.remove();
        const existingBadge = actionsEl.querySelector ? actionsEl.querySelector("[data-hub-status-id]") : null;
        if (existingBadge) {
          existingBadge.textContent = cached.errorText || "无法访问";
        } else if (typeof actionsEl.insertAdjacentHTML === "function") {
          actionsEl.insertAdjacentHTML("afterbegin", '<span class="badge red" data-hub-status-id="' + esc(fileId) + '">' + esc(cached.errorText || "无法访问") + '</span>');
        }
      }
    }
  }
}

async function fetchHubImagePreview(fileId) {
  const taskIdAtStart = state.filePreviewTaskId;
  if (!fileId || !taskIdAtStart) return;
  const existing = state.filePreviewCache.get(fileId);
  if (existing) return;
  state.filePreviewCache.set(fileId, { status: "loading" });

  try {
    const headers = {};
    if (state.token) headers.Authorization = "Bearer " + state.token;
    // Token 仅通过 Authorization 请求头传递，绝不拼入 URL。
    const r = await fetch("/api/v1/files/" + encodeURIComponent(fileId) + "?inline=1", { headers });
    if (state.view !== "tasks" || state.filePreviewTaskId !== taskIdAtStart) return;

    if (r.status === 410) {
      state.filePreviewCache.set(fileId, { status: "error", code: 410, errorText: "已过期清理" });
      updateHubFileCardDom(fileId);
      return;
    }
    if (r.status === 404 || r.status === 403) {
      state.filePreviewCache.set(fileId, { status: "error", code: r.status, errorText: "无法访问" });
      updateHubFileCardDom(fileId);
      return;
    }
    if (r.status === 401) {
      state.filePreviewCache.set(fileId, { status: "error", code: 401, errorText: "需要密钥" });
      updateHubFileCardDom(fileId);
      return;
    }
    if (!r.ok) {
      state.filePreviewCache.set(fileId, { status: "error", code: r.status, errorText: "加载失败 (HTTP " + r.status + ")" });
      updateHubFileCardDom(fileId);
      return;
    }

    const blob = await r.blob();
    if (state.view !== "tasks" || state.filePreviewTaskId !== taskIdAtStart) return;
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;
    const objectUrl = URL.createObjectURL(blob);
    state.filePreviewCache.set(fileId, { status: "ready", objectUrl });
    updateHubFileCardDom(fileId);
  } catch {
    if (state.view !== "tasks" || state.filePreviewTaskId !== taskIdAtStart) return;
    state.filePreviewCache.set(fileId, { status: "error", errorText: "预览加载失败" });
    updateHubFileCardDom(fileId);
  }
}

function hydrateTaskAttachmentPreviews() {
  if (state.view !== "tasks" || !state.selectedTaskDetail || !state.selectedTaskDetail.task) return;
  const els = Array.from(document.querySelectorAll("[data-hub-preview-id]") || []);
  const seen = new Set();
  for (const el of els) {
    const fileId = el.dataset && el.dataset.hubPreviewId;
    if (!fileId || seen.has(fileId)) continue;
    seen.add(fileId);
    if (!state.filePreviewCache.has(fileId)) {
      fetchHubImagePreview(fileId);
    }
  }
}

function openImagePreviewModal(fileId, fileName) {
  const cached = state.filePreviewCache.get(fileId);
  if (!cached || cached.status !== "ready" || !cached.objectUrl) return;
  const titleEl = document.getElementById("imgPreviewTitle");
  const imgEl = document.getElementById("imgPreviewImg");
  const dlBtn = document.getElementById("imgPreviewDownloadBtn");
  if (titleEl) titleEl.textContent = fileName || "图片预览";
  if (imgEl) {
    imgEl.src = cached.objectUrl;
    imgEl.alt = fileName || "图片预览";
  }
  if (dlBtn) {
    dlBtn.dataset.fileId = fileId;
    dlBtn.dataset.fileName = fileName || "image";
  }
  openModal("imagePreviewModal");
}

async function downloadHubFile(fileId, fileName) {
  if (!fileId) return;
  try {
    const headers = {};
    if (state.token) headers.Authorization = "Bearer " + state.token;
    // 下载走 fetch + Bearer 头取 blob 后触发临时 <a download>，不把 Token 放进 URL。
    const r = await fetch("/api/v1/files/" + encodeURIComponent(fileId), { headers });
    if (r.status === 401) {
      const tokEl = document.getElementById("tokenInput");
      if (tokEl) tokEl.value = state.token;
      openModal("tokenModal");
      return showToast("需要有效的管理密钥 (API Token)");
    }
    if (r.status === 410) {
      state.filePreviewCache.set(fileId, { status: "error", code: 410, errorText: "已过期清理" });
      updateHubFileCardDom(fileId);
      return showToast("文件已过期清理");
    }
    if (r.status === 404 || r.status === 403) {
      state.filePreviewCache.set(fileId, { status: "error", code: r.status, errorText: "无法访问" });
      updateHubFileCardDom(fileId);
      return showToast("文件无法访问");
    }
    if (!r.ok) {
      const d = await r.json().catch(() => null);
      return showToast("下载失败: " + ((d && d.error) || ("HTTP " + r.status)));
    }
    const blob = await r.blob();
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      return showToast("当前环境不支持 Blob 下载");
    }
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = fileName || fileId;
    a.style.display = "none";
    if (document.body && typeof document.body.appendChild === "function") {
      document.body.appendChild(a);
    }
    if (typeof a.click === "function") a.click();
    if (typeof a.remove === "function") a.remove();
    else if (document.body && typeof document.body.removeChild === "function") {
      try { document.body.removeChild(a); } catch {}
    }
    setTimeout(() => {
      if (typeof URL.revokeObjectURL === "function") {
        try { URL.revokeObjectURL(blobUrl); } catch {}
      }
    }, 1000);
  } catch (e) {
    showToast("下载失败: " + e.message);
  }
}

function setFormFileError(errBoxId, msg) {
  const el = document.getElementById(errBoxId);
  if (!el) return;
  if (!msg) {
    el.style.display = "none";
    el.textContent = "";
  } else {
    el.textContent = msg;
    el.style.display = "block";
  }
}

function renderDraftFileList(containerId, items, targetType, isSubmitting = false) {
  const box = document.getElementById(containerId);
  if (!box) return;
  if (!items || !items.length) {
    box.innerHTML = "";
    return;
  }
  let html = "";
  for (const item of items) {
    let statusBadge = '<span class="badge">待上传</span>';
    let barCls = "";
    let pct = Number(item.progress || 0);
    if (item.status === "uploading") {
      statusBadge = '<span class="badge indigo">上传中 ' + esc(pct) + '%</span>';
    } else if (item.status === "uploaded") {
      statusBadge = '<span class="badge green">已上传</span>';
      barCls = " done";
      pct = 100;
    } else if (item.status === "error") {
      statusBadge = '<span class="badge red">' + esc(item.error || "上传失败") + '</span>';
      barCls = " err";
    }
    html += '<div class="att-draft-item">'
      + '<div class="att-draft-row">'
      + '<div style="min-width:0;flex:1;">'
      + '<div class="att-name">' + esc(item.name) + '</div>'
      + '<div class="att-sub mono">' + esc(formatBytes(item.size)) + ' · ' + esc(item.mime || "application/octet-stream") + '</div>'
      + '</div>'
      + '<div class="att-actions">'
      + statusBadge
      + '<button type="button" class="btn sm ghost" data-action="remove-draft-file" data-draft-target="' + esc(targetType) + '" data-draft-id="' + esc(item.id) + '"' + (isSubmitting ? ' disabled' : '') + '>移除</button>'
      + '</div>'
      + '</div>'
      + '<div class="att-prog"><div class="att-prog-bar' + barCls + '" style="width:' + esc(pct) + '%;"></div></div>'
      + '</div>';
  }
  box.innerHTML = html;
}

function addDraftFiles(targetType, fileList) {
  const isTask = targetType === "task";
  const items = isTask ? state.taskDraftFiles : state.replyDraftFiles;
  const errBoxId = isTask ? "tfFileErr" : "replyFileErr";
  const listId = isTask ? "tfFileList" : "replyFileList";
  const isSubmitting = isTask ? state.taskSubmitting : state.replySubmitting;
  if (isSubmitting) return;

  setFormFileError(errBoxId, "");
  const errors = [];
  for (const file of Array.from(fileList || [])) {
    if (!file) continue;
    const size = Number(file.size || 0);
    if (size > MAX_ATTACHMENT_BYTES) {
      errors.push("文件「" + (file.name || "未命名") + "」超过 100 MB 上限（" + formatBytes(size) + "），已拦截");
      continue;
    }
    if (items.length >= MAX_ATTACHMENTS_PER_MSG) {
      errors.push("单条消息最多附加 " + MAX_ATTACHMENTS_PER_MSG + " 个文件");
      break;
    }
    items.push({
      id: "att-" + (++draftFileSeq),
      file,
      name: file.name || "file",
      size,
      mime: file.type || "application/octet-stream",
      progress: 0,
      status: "pending",
      error: "",
      fileId: "",
    });
  }
  if (errors.length) {
    const msg = errors.join("；");
    setFormFileError(errBoxId, msg);
    showToast(errors[0]);
  }
  renderDraftFileList(listId, items, targetType, false);
}

function removeDraftFile(targetType, draftId) {
  const isTask = targetType === "task";
  const isSubmitting = isTask ? state.taskSubmitting : state.replySubmitting;
  if (isSubmitting) return;
  if (isTask) {
    state.taskDraftFiles = state.taskDraftFiles.filter((it) => it.id !== draftId);
    renderDraftFileList("tfFileList", state.taskDraftFiles, "task", false);
    setFormFileError("tfFileErr", "");
  } else {
    state.replyDraftFiles = state.replyDraftFiles.filter((it) => it.id !== draftId);
    renderDraftFileList("replyFileList", state.replyDraftFiles, "reply", false);
    setFormFileError("replyFileErr", "");
  }
}

function uploadHubFile(item, onProgress) {
  return new Promise((resolve, reject) => {
    if (!item || !item.file) return reject(new Error("缺少文件对象"));
    const size = Number(item.size || item.file.size || 0);
    if (size > MAX_ATTACHMENT_BYTES) {
      return reject(new Error("文件超过 100 MB 大小限制"));
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/v1/files", true);
    if (state.token) {
      xhr.setRequestHeader("Authorization", "Bearer " + state.token);
    }
    xhr.setRequestHeader("Content-Type", item.mime || "application/octet-stream");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(item.name || "file"));

    if (xhr.upload && typeof onProgress === "function") {
      xhr.upload.onprogress = (ev) => {
        if (ev && ev.lengthComputable && ev.total > 0) {
          const pct = Math.min(100, Math.max(0, Math.round((ev.loaded / ev.total) * 100)));
          onProgress(pct);
        }
      };
    }

    xhr.onload = () => {
      let parsed = null;
      try { parsed = JSON.parse(xhr.responseText || "{}"); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && parsed && parsed.file_id) {
        if (typeof onProgress === "function") onProgress(100);
        resolve(parsed);
        return;
      }
      if (xhr.status === 401) {
        const tokEl = document.getElementById("tokenInput");
        if (tokEl) tokEl.value = state.token;
        openModal("tokenModal");
        reject(new Error("需要有效的管理密钥 (API Token)"));
        return;
      }
      if (xhr.status === 413) {
        reject(new Error((parsed && parsed.error) || "文件超过服务端大小上限 (HTTP 413)"));
        return;
      }
      reject(new Error((parsed && parsed.error) || ("上传失败 (HTTP " + xhr.status + ")")));
    };

    xhr.onerror = () => reject(new Error("网络错误，文件上传中断"));
    xhr.onabort = () => reject(new Error("文件上传已取消"));
    xhr.send(item.file);
  });
}

async function uploadDraftFilesSequentially(items, renderFn, errBoxId) {
  setFormFileError(errBoxId, "");
  const out = [];
  for (const item of items) {
    if (item.status === "uploaded" && item.fileId) {
      out.push({ file_id: item.fileId });
      continue;
    }
    if (Number(item.size || 0) > MAX_ATTACHMENT_BYTES) {
      item.status = "error";
      item.error = "超过 100 MB 上限";
      renderFn();
      const msg = "文件「" + item.name + "」超过 100 MB 上限，无法上传";
      setFormFileError(errBoxId, msg);
      throw new Error(msg);
    }
    item.status = "uploading";
    item.error = "";
    item.progress = 0;
    renderFn();
    try {
      const meta = await uploadHubFile(item, (pct) => {
        item.progress = pct;
        renderFn();
      });
      item.status = "uploaded";
      item.progress = 100;
      item.fileId = meta.file_id;
      renderFn();
      out.push({ file_id: meta.file_id });
    } catch (err) {
      item.status = "error";
      item.error = err.message || "上传失败";
      renderFn();
      const msg = "文件「" + item.name + "」上传失败: " + item.error;
      setFormFileError(errBoxId, msg);
      throw new Error(msg);
    }
  }
  return out;
}

async function loadTaskDetail(taskId, silent = false) {
  if (state.filePreviewTaskId && state.filePreviewTaskId !== taskId) {
    revokeAttachmentObjectUrls();
  }
  if (state.replyDraftTaskId && state.replyDraftTaskId !== taskId) {
    state.replyDraftFiles = [];
    state.replyDraftTaskId = taskId;
  } else if (!state.replyDraftTaskId) {
    state.replyDraftTaskId = taskId;
  }
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
  if (state.replySubmitting) return;
  const input = document.getElementById("replyTextBox");
  const text = input ? input.value.trim() : "";
  const files = state.replyDraftTaskId === taskId ? state.replyDraftFiles : [];
  if (!text && !files.length) return showToast("请输入要回复的内容，或添加附件");

  const btn = document.getElementById("replySubmitBtn");
  state.replySubmitting = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = files.length ? "上传附件并发送中..." : "发送中...";
  }
  renderDraftFileList("replyFileList", files, "reply", true);

  try {
    let attachments = [];
    if (files.length) {
      attachments = await uploadDraftFilesSequentially(
        files,
        () => renderDraftFileList("replyFileList", state.replyDraftFiles, "reply", state.replySubmitting),
        "replyFileErr",
      );
    }
    const body = { text };
    if (attachments.length) body.attachments = attachments;
    await api("/api/v1/tasks/" + encodeURIComponent(taskId) + "/reply", {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.replyDraftFiles = [];
    if (input) input.value = "";
    setFormFileError("replyFileErr", "");
    showToast("回复已发送，Agent 即将继续执行");
    await refreshState();
  } catch (e) {
    showToast("发送答复失败: " + e.message);
  } finally {
    state.replySubmitting = false;
    const curBtn = document.getElementById("replySubmitBtn");
    if (curBtn) {
      curBtn.disabled = false;
      curBtn.textContent = "发送答复并继续";
    }
    renderDraftFileList("replyFileList", state.replyDraftFiles, "reply", false);
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

function capOptionLabel(c) {
  const dn = c.display_name && String(c.display_name).trim();
  const sname = c.skill_name && String(c.skill_name).trim();
  if (c.skill_id === "agent") {
    if (c.worker) return "Agent: " + c.worker + (dn && dn !== c.worker ? (" · " + dn) : "");
    return "Agent: " + (dn || sname || c.node || "agent");
  }
  const capLabel = dn || sname || c.skill_id || "能力";
  if (c.worker) return "Agent: " + c.worker + " / 能力: " + capLabel + " (" + c.skill_id + ")";
  return "直属能力: " + capLabel + " (" + c.skill_id + ")";
}

function getDispatchableCardsForNode(node) {
  const cards = ((state.data && state.data.agentCards) || [])
    .filter((c) => c.node === node && admissionOf(c) === "admitted" && c.dispatchable === "Yes");
  // 将 skill_id === "agent" 排在前面，便于默认选中
  return cards.sort((a, b) => {
    const aIsAgent = a.skill_id === "agent" ? 0 : 1;
    const bIsAgent = b.skill_id === "agent" ? 0 : 1;
    if (aIsAgent !== bIsAgent) return aIsAgent - bIsAgent;
    return String(a.cap_id || "").localeCompare(String(b.cap_id || ""));
  });
}

function populateCapSelect(selEl, node, preferredCap = "") {
  if (!selEl) return;
  const cards = node ? getDispatchableCardsForNode(node) : [];
  if (!cards.length) {
    selEl.innerHTML = '<option value="">无已接纳的可用 Agent / 能力</option>';
    return;
  }
  selEl.innerHTML = cards.map((c) => '<option value="' + esc(c.cap_id) + '">' + esc(capOptionLabel(c)) + '</option>').join("");
  const matched = (preferredCap && cards.find((c) => c.skill_id === preferredCap))
    || cards.find((c) => c.skill_id === "agent")
    || cards[0];
  if (matched) selEl.value = matched.cap_id;
}

function fillLoopCandidates() {
  const bulkNode = document.getElementById("lfBulkNode");
  const bulkCap = document.getElementById("lfBulkCap");
  if (!bulkNode) return;
  const prevNode = bulkNode.value;
  const groups = buildNodeGroups(state.data).filter((g) => g.admittedCards.some((c) => c.dispatchable === "Yes"));
  let html = "";
  if (!groups.length) {
    html += '<option value="">暂无已接纳的执行节点</option>';
  } else {
    for (const g of groups) {
      const label = g.displayName !== g.node ? (g.displayName + "（" + g.node + "）") : g.node;
      html += '<option value="' + esc(g.node) + '">' + esc(label) + '</option>';
    }
  }
  bulkNode.innerHTML = html;
  if (prevNode && [...bulkNode.options].some((o) => o.value === prevNode)) {
    bulkNode.value = prevNode;
  } else if (groups.length) {
    bulkNode.value = groups[0].node;
  }
  populateCapSelect(bulkCap, bulkNode.value);
  renderLoopStageBindings();
}

function renderLoopStageBindings() {
  const wrap = document.getElementById("lfStageBindings");
  const tplSel = document.getElementById("lfTemplate");
  if (!wrap || !tplSel) return;
  const tpl = state.templates.find((t) => t.id === tplSel.value) || state.templates[0];
  const stages = (tpl && Array.isArray(tpl.stages)) ? tpl.stages : [];
  const groups = buildNodeGroups(state.data).filter((g) => g.admittedCards.some((c) => c.dispatchable === "Yes"));

  if (!stages.length) {
    wrap.innerHTML = '<div class="hint">请先选择一个闭环模板。</div>';
    return;
  }
  if (!groups.length) {
    wrap.innerHTML = '<div class="err-banner" style="margin-bottom:0;">暂无已接纳的可执行节点。请先到「节点 → 待接纳」接纳节点，或在下方高级选项手动填写。</div>';
    return;
  }

  // 保留同一模板下用户已选中的阶段绑定，避免刷新状态时被重置
  const prevByStage = new Map();
  for (const row of wrap.querySelectorAll(".stage-bind-row")) {
    prevByStage.set(row.dataset.stageId, {
      node: row.querySelector(".stage-node-sel")?.value || "",
      capId: row.querySelector(".stage-cap-sel")?.value || "",
    });
  }

  let html = "";
  for (const st of stages) {
    const prev = prevByStage.get(st.id);
    const chosenNode = (prev && prev.node && groups.some((g) => g.node === prev.node))
      ? prev.node
      : groups[0].node;
    const nodeOpts = groups.map((g) => {
      const label = g.displayName !== g.node ? (g.displayName + "（" + g.node + "）") : g.node;
      return '<option value="' + esc(g.node) + '"' + (g.node === chosenNode ? " selected" : "") + '>' + esc(label) + '</option>';
    }).join("");
    const cards = getDispatchableCardsForNode(chosenNode);
    const chosenCard = (prev && prev.capId && cards.find((c) => c.cap_id === prev.capId))
      || (st.cap && cards.find((c) => c.skill_id === st.cap))
      || cards.find((c) => c.skill_id === "agent")
      || cards[0];
    const capOpts = cards.map((c) => (
      '<option value="' + esc(c.cap_id) + '"' + (chosenCard && c.cap_id === chosenCard.cap_id ? " selected" : "") + '>'
      + esc(capOptionLabel(c)) + '</option>'
    )).join("");
    const failHint = st.on_fail && st.on_fail.startsWith("goto:")
      ? ("不通过 → 回 " + st.on_fail.slice(5))
      : (st.on_fail === "abort" ? "不通过 → 中止" : "不通过 → 重试");

    html += '<div class="stage-bind-row" data-stage-id="' + esc(st.id) + '" data-default-cap="' + esc(st.cap || "agent") + '">'
      + '<div><div style="font-weight:600;font-size:13px;">' + esc(st.name || st.id) + '</div>'
      + '<div class="hint mono" style="font-size:11px;">' + esc(st.id) + ' · ' + esc(failHint) + '</div></div>'
      + '<select class="input stage-node-sel" aria-label="选择阶段节点">' + nodeOpts + '</select>'
      + '<select class="input stage-cap-sel" aria-label="选择阶段 Agent 或能力">' + capOpts + '</select>'
      + '</div>';
  }
  wrap.innerHTML = html;
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
  renderLoopStageBindings();
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
    const labels = {
      admitted: "已接纳该能力",
      pending: "已移回待接纳",
      rejected: "已拒绝该能力，可在「已拒绝」筛选中查看或恢复",
    };
    showToast(labels[admission] || "已更新该能力");
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

function syncReceiveChoiceCards() {
  document.querySelectorAll("#receiveChoices .choice-card").forEach((card) => {
    const checked = card.dataset.receive === state.wizardReceive;
    card.classList.toggle("selected", checked);
    const radio = card.querySelector("input[type=radio]");
    if (radio) radio.checked = checked;
  });
  const showWebhook = state.wizardAccess === "http" && state.wizardReceive === "webhook";
  for (const id of ["afWebhookUrlRow", "afWebhookKeyRow", "afWebhookHeaderRow"]) {
    const row = document.getElementById(id);
    if (row) row.style.display = showWebhook ? "flex" : "none";
  }
  const intervalRow = document.getElementById("afPollIntervalRow");
  const showInterval = state.wizardAccess === "http" && (state.wizardReceive === "poll" || state.wizardReceive === "webhook");
  if (intervalRow) intervalRow.style.display = showInterval ? "flex" : "none";
  const intervalInput = document.getElementById("afPollInterval");
  if (showInterval && intervalInput) {
    const cur = String(intervalInput.value ?? "").trim();
    // 仍是空或两种默认值时跟着接收方式切换；用户填过的 15、60 等保留。
    if (cur === "" || cur === "5" || cur === "30") {
      intervalInput.value = state.wizardReceive === "webhook" || state.wizardPreset === "workbuddy" ? "30" : "5";
    }
  }
}

const DEFAULT_WEBHOOK_URL_PLACEHOLDER = "https://example.com/a2a/webhook";
const DEFAULT_WEBHOOK_KEY_PLACEHOLDER = "";

// 仅当字段为空或仍为上一模板自动填入的参考值时覆盖，保留用户手工改动。
function fillIfDefault(elId, key, nextVal) {
  const el = document.getElementById(elId);
  if (!el) return;
  const val = nextVal == null ? "" : String(nextVal);
  const prevAuto = state.wizardPresetDefaults[key];
  if (el.value === "" || (prevAuto !== undefined && el.value === prevAuto)) {
    el.value = val;
  }
  state.wizardPresetDefaults[key] = val;
}

// 按 Step 1 选的接入类型渲染「节点模板」下拉框（数据来自 AGENT_TEMPLATES，可扩展）；没有匹配模板时整行隐藏。
function renderTemplateOptions() {
  const row = document.getElementById("afTemplateRow");
  const sel = document.getElementById("afTemplatePreset");
  const group = document.getElementById("afReceiveGroup");
  const list = AGENT_TEMPLATES.filter((t) => t.access === state.wizardAccess);
  sel.innerHTML = "";
  if (!list.length) {
    row.style.display = "none";
    group.style.display = "none";
    return;
  }
  row.style.display = "flex";
  group.style.display = "flex";
  for (const t of list) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.label;
    sel.appendChild(opt);
  }
  sel.value = list[0].id;
  applyTemplatePreset();
}

// 选中模板后保持 3 种接收方式可见并自动选中对应那一种，同时填入各参数默认参考值。
function applyTemplatePreset() {
  const id = document.getElementById("afTemplatePreset").value;
  const hint = document.getElementById("afTemplateHint");
  const group = document.getElementById("afReceiveGroup");
  group.style.display = state.wizardAccess === "http" ? "flex" : "none";
  const urlEl = document.getElementById("afWebhookUrl");
  const keyEl = document.getElementById("afWebhookKey");
  const t = AGENT_TEMPLATES.find((x) => x.id === id);
  if (!t) {
    state.wizardTemplate = "generic";
    state.wizardPreset = "";
    hint.textContent = "可手动选择下面 3 种接收方式并填写参数。";
    if (urlEl) urlEl.placeholder = DEFAULT_WEBHOOK_URL_PLACEHOLDER;
    if (keyEl) keyEl.placeholder = DEFAULT_WEBHOOK_KEY_PLACEHOLDER;
    syncReceiveChoiceCards();
    return;
  }
  hint.textContent = t.hint || "";
  state.wizardReceive = t.receive || "poll";
  state.wizardTemplate = t.template || "generic";
  state.wizardPreset = t.preset || "";
  if (t.role) document.getElementById("afRole").value = t.role;
  const d = t.defaults || {};
  fillIfDefault("afNode", "node", d.node || "");
  fillIfDefault("afName", "displayName", d.displayName || "");
  fillIfDefault("afDesc", "description", d.description || "");
  fillIfDefault("afNote", "adminNote", d.adminNote || "");
  fillIfDefault("afWebhookHeader", "webhookHeader", d.webhookHeader || "");
  if (urlEl) urlEl.placeholder = d.webhookUrlPlaceholder || DEFAULT_WEBHOOK_URL_PLACEHOLDER;
  if (keyEl) keyEl.placeholder = d.webhookKeyPlaceholder || DEFAULT_WEBHOOK_KEY_PLACEHOLDER;
  syncReceiveChoiceCards();
  if (t.interval != null) document.getElementById("afPollInterval").value = String(t.interval);
}

function openAgentModal() {
  document.getElementById("agentStep2").reset();
  document.getElementById("onboardBox").innerHTML = "";
  const errBox = document.getElementById("agentErrBox");
  errBox.style.display = "none";
  errBox.textContent = "";
  state.wizardAccess = "http";
  state.wizardReceive = "poll";
  state.wizardTemplate = "generic";
  state.wizardPreset = "";
  state.wizardPresetDefaults = {};
  const urlEl = document.getElementById("afWebhookUrl");
  const keyEl = document.getElementById("afWebhookKey");
  if (urlEl) urlEl.placeholder = DEFAULT_WEBHOOK_URL_PLACEHOLDER;
  if (keyEl) keyEl.placeholder = DEFAULT_WEBHOOK_KEY_PLACEHOLDER;
  syncAccessChoiceCards();
  syncReceiveChoiceCards();
  setWizardStep(1);
  openModal("agentModal");
}

function renderOnboardingResult(res) {
  const ob = res.onboarding || {};
  const card = res.card || null;
  const token = res.token || "";
  const webhook = res.webhook || null;
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

  if (webhook && webhook.url) {
    html += '<div class="card" style="padding:12px;margin-bottom:12px;">'
      + '<strong>Webhook 已登记</strong>'
      + '<div class="hint mono" style="color:var(--text-2);margin-top:4px;">' + esc(webhook.url) + '</div>'
      + '<div class="hint">密钥留在接收端。列表只显示掩码'
      + (webhook.secret_mask ? ' ' + esc(webhook.secret_mask) : '')
      + (webhook.header ? '，请求头 ' + esc(webhook.header) : '')
      + '。</div></div>';
  }

  if (card && card.cap_id) {
    html += '<div class="card" style="padding:12px;margin-bottom:12px;background:var(--green-soft);border-color:rgba(16,185,129,0.3);">'
      + '<strong>已准备就绪</strong>：已为它预建并自动接纳能力，上线后即可直接派单。</div>';
  } else {
    html += '<div class="card" style="padding:12px;margin-bottom:12px;">'
      + '<strong>已生成接入命令</strong>：目标电脑或独立 Agent 上线后，请到「节点 → 待接纳」点一次接纳即可派单。</div>';
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

function inferNodeCardRole(node) {
  let inferred = "worker";
  for (const c of (state.cards || [])) {
    if (c.node !== node) continue;
    if (c.role === "leader" || c.role === "hybrid") return "leader";
    if (c.role === "worker") inferred = "worker";
  }
  return inferred;
}

function openTokenRotateConfirm(node) {
  const hasExisting = state.tokensByNode.has(node);
  const defaultRole = inferNodeCardRole(node);
  document.getElementById("tmTitle").textContent = hasExisting ? ("重新生成密钥 · " + node) : ("生成密钥 · " + node);
  document.getElementById("tmBody").innerHTML = '<div style="margin-bottom:14px;line-height:1.6;">'
    + (hasExisting
      ? '重新生成后，节点 <strong>' + esc(node) + '</strong> 原先的旧密钥将<strong>立即失效</strong>，需要把新密钥更新给该 Agent。'
      : '将为节点 <strong>' + esc(node) + '</strong> 签发一枚专属访问密钥。')
    + '</div>'
    + (hasExisting ? '' : (
      '<div class="form-row" style="margin-bottom:14px;">'
      + '<label for="tmRole">密钥角色</label>'
      + '<select class="input" id="tmRole">'
      + '<option value="worker"' + (defaultRole === "worker" ? ' selected' : '') + '>worker（执行端：仅认领与回执自己的任务）</option>'
      + '<option value="leader"' + (defaultRole === "leader" ? ' selected' : '') + '>leader（调度控制端：可派单、跟单、答复及接单）</option>'
      + '</select></div>'
    ))
    + '<div style="display:flex;justify-content:flex-end;gap:8px;">'
    + '<button type="button" class="btn" data-close-modal="tokenManageModal">取消</button>'
    + '<button type="button" class="btn primary" data-action="do-rotate-token" data-node="' + esc(node) + '">'
    + (hasExisting ? '确认重新生成' : '确认生成') + '</button>'
    + '</div>';
  openModal("tokenManageModal");
}

async function doRotateToken(node) {
  try {
    const roleEl = document.getElementById("tmRole");
    const payload = roleEl && roleEl.value ? { role: roleEl.value } : {};
    const res = await api("/api/v1/admin/tokens/" + encodeURIComponent(node) + "/rotate", {
      method: "POST",
      body: JSON.stringify(payload),
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

function deleteNodeButton(g) {
  const hubNode = (state.data && state.data.hubNode) || "";
  if (!g || !g.node || g.node === hubNode || g.node === "unknown") return "";
  return '<button class="btn sm danger" data-action="delete-node" data-node="' + esc(g.node) + '" data-kind="' + esc(g.kind || "") + '">删除</button>';
}

function openDeleteNodeConfirm(node, kind) {
  const g = buildNodeGroups(state.data).find((x) => x.node === node);
  const name = g ? g.displayName : node;
  const openTasks = ((state.data && state.data.tasks) || [])
    .filter((t) => t.target_node === node && ["submitted", "working", "input-required", "auth-required"].includes(t.status)).length;
  document.getElementById("tmTitle").textContent = "删除节点 · " + name;
  let html = '<div style="margin-bottom:14px;line-height:1.7;">'
    + '将从中台移除节点 <strong>' + esc(name) + '</strong>（<span class="mono">' + esc(node) + '</span>）：'
    + '<ul style="margin:6px 0 0 18px;padding:0;">'
    + '<li>删除该节点下的全部 Agent 与能力名片，不再出现在节点列表与派单选项里</li>'
    + '<li>吊销它的专属密钥与 Webhook 配置（如有），之后的请求会被拒绝</li>'
    + '<li>历史任务与消息保留，不受影响</li>'
    + '</ul></div>';
  if (openTasks) {
    html += '<div class="err-banner">还有 <strong>' + openTasks + '</strong> 个未结束的任务指向它，删除后不会自动撤销，请到任务页手动处理。</div>';
  }
  if (kind === "host") {
    html += '<div class="err-banner">这是宿主节点：请先在那台机器上停止 ah 服务（<span class="mono">ah service --remove</span>），否则它下次对账会把名片重新登记回来。</div>';
  }
  html += '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">'
    + '<button type="button" class="btn" data-close-modal="tokenManageModal">取消</button>'
    + '<button type="button" class="btn danger" data-action="do-delete-node" data-node="' + esc(node) + '">确认删除</button>'
    + '</div>';
  document.getElementById("tmBody").innerHTML = html;
  openModal("tokenManageModal");
}

async function doDeleteNode(node) {
  try {
    const res = await api("/api/v1/admin/agents/" + encodeURIComponent(node), { method: "DELETE" });
    closeModal("tokenManageModal");
    state.expandedNodes.delete(node);
    showToast("已删除节点 " + node + (res.openTasks ? "，仍有 " + res.openTasks + " 个未结束任务待处理" : ""));
    await refreshState();
  } catch (e) {
    showToast("删除失败: " + e.message);
  }
}

function syncHostCommandVisibility() {
  const isHttp = state.addCapTarget.isHttp;
  const workerVal = (document.getElementById("acWorker")?.value || "").trim();
  const cmdRow = document.getElementById("acCommandRow");
  if (cmdRow) cmdRow.style.display = (!isHttp && !workerVal) ? "block" : "none";
}

function openAddCapModal(node) {
  const g = buildNodeGroups(state.data).find((x) => x.node === node);
  const isHttp = g ? isHttpNodeGroup(g) : state.tokensByNode.has(node);
  state.addCapTarget = { node, isHttp };

  document.getElementById("addCapForm").reset();
  document.getElementById("acTitle").textContent = "添加能力 · " + (g ? g.displayName : node);
  const errBox = document.getElementById("acErrBox");
  errBox.style.display = "none";
  errBox.textContent = "";
  document.getElementById("acSnippetBox").style.display = "none";
  document.getElementById("acSnippetText").value = "";

  const banner = document.getElementById("acModeBanner");
  if (isHttp) {
    banner.innerHTML = '<strong>云端 / HTTP 节点（' + esc(node) + '）：</strong>将直接在中台登记已接纳的能力名片，立即可在派单与闭环中选用。';
    document.getElementById("acDisplayNameRow").style.display = "flex";
    document.getElementById("acNoteRow").style.display = "flex";
    document.getElementById("acSubmitBtn").textContent = "立即添加能力";
  } else {
    banner.innerHTML = '<strong>工作机 / 宿主节点（' + esc(node) + '）：</strong>宿主节点的本地命令与安全边界由本机守护，这里会生成 <span class="mono">commands.json</span> 配置片段；去该节点改 <span class="mono">commands.json</span>，守护进程自动热重载。';
    document.getElementById("acDisplayNameRow").style.display = "none";
    document.getElementById("acNoteRow").style.display = "none";
    document.getElementById("acSubmitBtn").textContent = "生成 commands.json 片段";
  }

  const workers = [...new Set(((g && g.cards) || []).map((c) => c.worker).filter(Boolean))];
  document.getElementById("acWorkerList").innerHTML = workers.map((w) => '<option value="' + esc(w) + '"></option>').join("");
  syncHostCommandVisibility();
  openModal("addCapModal");
}

function openDeleteCardConfirm(capId) {
  const c = ((state.data && state.data.agentCards) || []).find((x) => x.cap_id === capId);
  const label = c ? ((c.display_name && c.display_name.trim()) || c.skill_name || c.skill_id || capId) : capId;
  document.getElementById("tmTitle").textContent = "删除手动添加的能力";
  document.getElementById("tmBody").innerHTML = '<div style="margin-bottom:14px;line-height:1.6;">'
    + '确定要删除能力 <strong>' + esc(label) + '</strong>（<span class="mono">' + esc(capId) + '</span>）吗？'
    + '<div class="hint" style="margin-top:6px;">仅支持删除手动添加或预设的 HTTP 节点能力；宿主节点能力请在对应机器修改 commands.json。</div>'
    + '</div>'
    + '<div style="display:flex;justify-content:flex-end;gap:8px;">'
    + '<button type="button" class="btn" data-close-modal="tokenManageModal">取消</button>'
    + '<button type="button" class="btn danger" data-action="do-delete-card" data-cap-id="' + esc(capId) + '">确认删除</button>'
    + '</div>';
  openModal("tokenManageModal");
}

async function doDeleteCard(capId) {
  try {
    await api("/api/v1/admin/cards/" + encodeURIComponent(capId), { method: "DELETE" });
    closeModal("tokenManageModal");
    showToast("已删除能力 " + capId);
    await refreshState();
  } catch (e) {
    showToast("删除能力失败: " + e.message);
  }
}

function fillWebhookStatus(node) {
  const existing = webhookRecord(node);
  const status = document.getElementById("whStatus");
  if (!status) return;
  if (!existing) {
    status.innerHTML = '<div class="hint">还没有登记投递记录。</div>'
      + '<div class="hint">Agent 每 30 分钟用检查脚本兜底一次，防止漏推，这不是第二种接收方式。中台不会为了判在线去探测这个地址。</div>';
    return;
  }
  const headerName = existing.legacy ? "（未设置，只签名）" : (existing.header || "Authorization");
  const delivered = existing.last_delivered_at ? formatRelativeTime(existing.last_delivered_at) : "暂无成功投递";
  const attempted = existing.last_attempt_at ? formatRelativeTime(existing.last_attempt_at) : "暂无";
  const code = webhookDeliveryCode(existing);
  status.innerHTML = '<div style="display:flex;flex-direction:column;gap:4px;">'
    + '<div>' + webhookRowBadge(existing) + (code != null ? ' <span class="hint">HTTP ' + esc(code) + '</span>' : '') + '</div>'
    + '<div class="mono" style="word-break:break-all;">' + esc(existing.url || "") + '</div>'
    + '<div class="hint">请求头 ' + esc(headerName)
    + (existing.secret_mask ? ' · 密钥掩码 ' + esc(existing.secret_mask) : '') + '</div>'
    + '<div class="hint">最近投递：' + esc(delivered) + ' · 最近尝试：' + esc(attempted) + '</div>'
    + (existing.last_error ? '<div class="hint" style="color:var(--red-text);">最近错误：' + esc(existing.last_error) + '</div>' : '')
    + (existing.legacy ? '<div class="hint">请填写对方提供的密钥。当前只做签名，不会带 Authorization。</div>' : '')
    + '<div class="hint">Agent 每 30 分钟用检查脚本兜底一次，防止漏推，这不是第二种接收方式。中台不会为了判在线去探测这个地址。</div>'
    + '</div>';
}

function openWebhookModal(node) {
  const existing = webhookRecord(node);
  document.getElementById("whTitle").textContent = "接收方式 · " + node;
  document.getElementById("whNode").value = node;
  document.getElementById("whUrl").value = existing ? (existing.url || "") : "";
  document.getElementById("whKey").value = "";
  document.getElementById("whHeader").value = existing && existing.header ? existing.header : "Authorization";
  const hint = document.getElementById("whKeyHint");
  if (hint) {
    if (existing && existing.legacy) hint.textContent = "请填写对方提供的密钥。旧记录还只有签名密钥，补上之后才会按请求头发送。";
    else if (existing && existing.secret_mask) hint.textContent = "当前掩码 " + existing.secret_mask + "。留空表示不改密钥。";
    else hint.textContent = "填写接收端提供的密钥。留空表示不改已保存的密钥。";
  }
  const testBtn = document.getElementById("whTestBtn");
  if (testBtn) testBtn.dataset.node = node;
  fillWebhookStatus(node);
  const errBox = document.getElementById("whErrBox");
  errBox.style.display = "none";
  errBox.textContent = "";
  openModal("webhookModal");
}

async function testWebhookAction(node) {
  try {
    const res = await api("/api/v1/admin/webhooks/" + encodeURIComponent(node) + "/test", {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (res && res.ok) {
      showToast("Webhook 测试推送成功（HTTP " + (res.status ?? 200) + "）");
    } else {
      showToast("Webhook 测试失败: " + ((res && res.error) || ("HTTP " + (res && res.status ? res.status : "未知"))));
    }
    await refreshWebhooks();
    if (document.getElementById("webhookModal").classList.contains("open")) fillWebhookStatus(node);
    render();
  } catch (e) {
    showToast("测试 Webhook 失败: " + e.message);
  }
}

function openDeleteWebhookConfirm(node) {
  document.getElementById("tmTitle").textContent = "删除 Webhook · " + node;
  document.getElementById("tmBody").innerHTML = '<div style="margin-bottom:14px;line-height:1.6;">'
    + '确定要删除节点 <strong>' + esc(node) + '</strong> 的 Webhook 推送配置吗？<br/>'
    + '<span class="muted">删除后中台不再向该 URL 推门铃，节点仍可通过定时检查或长轮询取单。</span></div>'
    + '<div style="display:flex;justify-content:flex-end;gap:8px;">'
    + '<button type="button" class="btn" data-close-modal="tokenManageModal">取消</button>'
    + '<button type="button" class="btn danger" data-action="do-delete-webhook" data-node="' + esc(node) + '">确认删除</button>'
    + '</div>';
  openModal("tokenManageModal");
}

async function doDeleteWebhook(node) {
  try {
    await api("/api/v1/admin/webhooks/" + encodeURIComponent(node), { method: "DELETE" });
    closeModal("tokenManageModal");
    showToast("已删除节点 " + node + " 的 Webhook");
    await refreshWebhooks();
    render();
  } catch (e) {
    showToast("删除 Webhook 失败: " + e.message);
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
    + '<span class="section-sub">优先列出需要您审批、回复、确认新节点/能力或排查故障的事项</span>'
    + '</div>';

  if (todos.total === 0) {
    html += '<div class="all-clear">'
      + '<div><div class="all-clear-title">一切正常</div>'
      + '<div class="hint" style="color:var(--text-2);margin-top:2px;">当前没有待审批任务、Agent 提问、异常告警或待接纳的新节点。</div></div>'
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
        const badgeText = c.skill_id === "agent" ? "新 Agent 待接纳" : "新能力待接纳";
        html += '<div class="action-item pending">'
          + '<div style="min-width:0;flex:1;">'
          + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
          + '<span class="badge cyan">' + badgeText + '</span>'
          + '<strong>' + esc(cname) + '</strong>'
          + '<span class="mono muted">' + esc(pg.node) + '</span>'
          + '</div>'
          + '<div class="hint" style="margin-top:4px;">新接入的节点能力需要您点「接纳」确认身份后才能派单</div>'
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
          + '<div class="hint" style="margin-top:4px;">该节点申报了多项能力，确认可信后可一键接纳，或前往节点页逐项审核</div>'
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

  // 2. 节点在线状态概览（每个节点一行：显示名、在线/离线、最近活动「x 分钟前」、类型）
  const visibleGroups = groups.filter((g) => g.admittedCards.length > 0 || g.conn);
  const onlineCnt = visibleGroups.filter((g) => g.online).length;
  html += '<div class="card"><div class="section-head">'
    + '<div class="section-title"><span>节点在线状态概览</span>'
    + '<span class="badge ' + (onlineCnt > 0 ? "green" : "") + '">' + onlineCnt + ' / ' + visibleGroups.length + ' 在线</span>'
    + '<span class="section-sub">在线节点与外部 Agent 连接</span></div>'
    + '<div style="display:flex;gap:8px;"><button class="btn sm" data-action="goto-agents">管理节点</button>'
    + '<button class="btn sm primary" data-action="open-add-agent">+ 添加 Agent</button></div></div>';

  if (!visibleGroups.length) {
    html += '<div class="muted" style="padding:8px 0;">还没有接入任何节点或 Agent。点击右上角「+ 添加 Agent」，按向导即可把云端 Agent 或其他电脑接进来。</div>';
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
        + '<td><span class="badge ' + (g.online ? (deliveryUnacked(g) ? "amber" : "green") : "") + '"><span class="dot ' + nodeOnlineDotClass(g) + '" style="width:6px;height:6px;"></span>'
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
    + '<summary>名词一分钟看懂（节点、Agent、能力、接纳与审批门禁）</summary>'
    + '<div class="glossary-grid">'
    + '<div class="glossary-card"><strong>节点（Node）是什么？</strong>一台设备或终端（如您的 Mac、服务器，或一个接入的 HTTP 节点），节点下可挂载多个 Agent 与能力。</div>'
    + '<div class="glossary-card"><strong>Agent 与 能力（Skill）的区别</strong><strong>Agent</strong> 是节点上执行任务的智能体（对应 <code>agent</code> 名片，如 Claude/Codex 或 HTTP Agent）；<strong>能力</strong> 是 Agent 名下的专长技能，节点直属能力归在「节点直属能力」。</div>'
    + '<div class="glossary-card"><strong>接纳与 Worker / Leader</strong>新接入的节点/能力必须经您点击「接纳」才能接活；<strong>Worker</strong> 负责执行，<strong>Leader</strong> 仅负责派单与跟单。</div>'
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

function renderReceiveBox(g) {
  if (!isHttpNodeGroup(g)) {
    return '<div class="token-box"><strong>接收方式：常驻长连接（ah daemon）</strong></div>';
  }
  const mode = httpReceiveModeOf(g) || "http-poll";
  const label = receiveModeLabelZh(mode) || "定时检查";
  if (mode !== "webhook") {
    return '<div class="token-box"><strong>接收方式：' + esc(label) + '</strong></div>';
  }
  // 和定时检查、宿主节点同一行。地址和密钥放进弹窗，卡片上不再单独开一块 Webhook 管理框。
  const wh = webhookRecord(g.node);
  let side = "";
  if (!state.webhooksApiAvailable) {
    side = '<span class="hint">管理接口尚未启用</span>';
  } else {
    side = webhookRowBadge(wh)
      + '<button class="btn sm" data-action="edit-webhook" data-node="' + esc(g.node) + '">管理</button>';
  }
  return '<div class="token-box">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">'
    + '<strong>接收方式：' + esc(label) + '</strong>'
    + '<span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' + side + '</span>'
    + '</div></div>';
}

function canDeleteCard(c, isHttp) {
  if (!isHttp) return false;
  if (c.manual === true || c.preset === true) return true;
  if (c.metadata && (c.metadata.manual || c.metadata.preset)) return true;
  if (c.manual === false && c.preset === false) return false;
  return true;
}

function renderCapabilityItem(c, mode, isHttp = false) {
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
  if (canDeleteCard(c, isHttp)) {
    actions += '<button class="btn sm danger" data-action="delete-card" data-cap-id="' + esc(c.cap_id) + '">删除</button>';
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

function renderNodeHierarchy(cards, allNodeCards, mode, g) {
  const isHttp = isHttpNodeGroup(g);
  const agentCards = cards.filter((c) => c.skill_id === "agent");
  const workerSkillCards = cards.filter((c) => c.worker && c.skill_id !== "agent");
  const directCapCards = cards.filter((c) => !c.worker && c.skill_id !== "agent");

  const buckets = [];
  const bucketByWorker = new Map();
  for (const ac of agentCards) {
    const b = { worker: ac.worker || "", agentCard: ac, externalAgent: false, skills: [] };
    buckets.push(b);
    if (ac.worker) bucketByWorker.set(ac.worker, b);
  }
  for (const sc of workerSkillCards) {
    let b = bucketByWorker.get(sc.worker);
    if (!b) {
      const extAgent = (allNodeCards || []).find((x) => x.worker === sc.worker && x.skill_id === "agent") || null;
      b = { worker: sc.worker, agentCard: extAgent, externalAgent: true, skills: [] };
      buckets.push(b);
      bucketByWorker.set(sc.worker, b);
    }
    b.skills.push(sc);
  }

  let html = '<div class="cap-list">';
  for (const b of buckets) {
    const titleName = b.agentCard
      ? ((b.agentCard.display_name && b.agentCard.display_name.trim()) || b.agentCard.skill_name || b.worker || g.displayName)
      : b.worker;
    html += '<div class="agent-group">'
      + '<div class="sub-group-title">'
      + '<span><span class="badge indigo">Agent</span> ' + esc(titleName)
      + (b.worker ? ' <span class="mono muted">(' + esc(b.worker) + ')</span>' : '') + '</span>'
      + (b.skills.length ? '<span class="hint">' + b.skills.length + ' 项专长能力</span>' : '')
      + '</div>';
    if (b.agentCard && !b.externalAgent) {
      html += renderCapabilityItem(b.agentCard, mode, isHttp);
    }
    if (b.skills.length) {
      html += '<div style="padding-left:10px;border-left:2px solid var(--border-strong);display:flex;flex-direction:column;gap:8px;">';
      for (const sk of b.skills) html += renderCapabilityItem(sk, mode, isHttp);
      html += '</div>';
    }
    html += '</div>';
  }

  if (directCapCards.length) {
    html += '<div class="agent-group">'
      + '<div class="sub-group-title"><span>节点直属能力</span><span class="badge">' + directCapCards.length + '</span></div>';
    for (const dc of directCapCards) html += renderCapabilityItem(dc, mode, isHttp);
    html += '</div>';
  }

  html += '</div>';
  return html;
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
      html += '<div class="card muted">当前没有已接入的节点。点击右上角「+ 添加 Agent」开始接入，或切换到「待接纳」确认新发现的节点。</div>';
    } else {
      html += '<div class="node-grid">';
      for (const g of admittedGroups) {
        const expanded = state.expandedNodes.has(g.node);
        const dispatchable = g.admittedCards.find((c) => c.dispatchable === "Yes");
        const agentCnt = g.admittedCards.filter((c) => c.skill_id === "agent").length;
        const skillCnt = g.admittedCards.filter((c) => c.skill_id !== "agent").length;

        html += '<div class="node-card">'
          + '<div class="node-head">'
          + '<div>'
          + '<div class="node-name"><span class="dot ' + nodeOnlineDotClass(g) + '"></span>' + esc(g.displayName)
          + (g.displayName !== g.node ? ' <span class="mono muted" style="font-size:12px;font-weight:400;">(' + esc(g.node) + ')</span>' : '')
          + '</div>'
          + '<div class="hint" style="margin-top:4px;">' + esc(nodeCardSubtitle(g)) + ' · 最近活动：' + esc(formatRelativeTime(g.lastSeenAt)) + '</div>'
          + '</div>'
          + '<span class="badge ' + (g.online ? (deliveryUnacked(g) ? "amber" : "green") : "") + '">' + (g.online ? "在线" : "离线") + '</span>'
          + '</div>';

        if (g.nodeDesc || g.adminNote) {
          html += '<div class="hint" style="color:var(--text-2);">' + esc(g.adminNote || g.nodeDesc) + '</div>';
        }

        if (!g.admittedCards.length) {
          html += '<div class="hint">已连接（尚未启用可执行能力）。</div>';
        } else {
          html += '<div class="hint">已接纳 <strong>' + agentCnt + '</strong> 个 Agent · <strong>' + skillCnt + '</strong> 项能力</div>';
        }

        html += renderTokenManageBox(g.node, g.kind);
        html += renderReceiveBox(g);

        html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:auto;">';
        if (dispatchable) {
          html += '<button class="btn sm primary" data-action="dispatch-node" data-node="' + esc(g.node) + '" data-worker="' + esc(dispatchable.worker || "") + '" data-skill="' + esc(dispatchable.skill_id || "") + '" data-cap-id="' + esc(dispatchable.cap_id || "") + '">派发任务</button>';
        }
        html += '<button class="btn sm" data-action="open-add-cap" data-node="' + esc(g.node) + '">+ 添加能力</button>';
        if (g.admittedCards.length > 0) {
          html += '<button class="btn sm" data-action="toggle-node" data-node="' + esc(g.node) + '">'
            + (expanded ? '收起能力' : ('展开能力 (' + g.admittedCards.length + ')')) + '</button>';
        }
        html += deleteNodeButton(g);
        html += '</div>';

        if (expanded && g.admittedCards.length > 0) {
          html += renderNodeHierarchy(g.admittedCards, g.cards, "admitted", g);
        }
        html += '</div>';
      }
      html += '</div>';
    }
  } else if (filter === "pending") {
    if (!pendingGroups.length) {
      html += '<div class="card muted">目前没有待接纳的新节点或能力。</div>';
    } else {
      html += '<div class="node-grid">';
      for (const g of pendingGroups) {
        html += '<div class="node-card">'
          + '<div class="node-head">'
          + '<div><div class="node-name">' + esc(g.displayName) + '</div>'
          + '<div class="hint">节点标识：<span class="mono">' + esc(g.node) + '</span> · ' + g.pendingCards.length + ' 项待确认</div></div>'
          + '<div style="display:flex;gap:6px;">'
          + '<button class="btn sm success" data-action="admit-node" data-node="' + esc(g.node) + '">全部接纳</button>'
          + deleteNodeButton(g)
          + '</div></div>'
          + renderNodeHierarchy(g.pendingCards, g.cards, "pending", g)
          + '</div>';
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
          + '<div class="hint mono">' + esc(g.node) + '</div></div>' + deleteNodeButton(g) + '</div>'
          + renderNodeHierarchy(g.rejectedCards, g.cards, "rejected", g)
          + '</div>';
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
    + '<input class="input" id="taskSearchInput" placeholder="搜索任务内容、编号或节点..." value="' + esc(state.search) + '" />'
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
    if (state.filePreviewTaskId) revokeAttachmentObjectUrls();
    detailHtml += '<div class="muted" style="margin:auto;text-align:center;">请从左侧选择一条任务<br/><span style="font-size:12px;">可查看执行对话、审批请求与交付产物</span></div>';
  } else {
    const t = det.task;
    if (state.filePreviewTaskId !== t.task_id) {
      if (state.filePreviewTaskId) revokeAttachmentObjectUrls();
      state.filePreviewTaskId = t.task_id;
    }
    if (state.replyDraftTaskId !== t.task_id) {
      state.replyDraftFiles = [];
      state.replyDraftTaskId = t.task_id;
    }
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
        + '<textarea class="input" id="replyTextBox" data-task-id="' + esc(t.task_id) + '" placeholder="输入您的回答或补充说明（有附件时可留空），提交后 Agent 将继续执行..."></textarea>'
        + '<div>'
        + '<label style="display:block;font-size:12px;color:var(--text-2);margin-bottom:5px;">附加文件（可选，单个不超过 100 MB）</label>'
        + '<input class="input" type="file" id="replyFiles" multiple />'
        + '<div id="replyFileErr" class="err-banner" style="display:none;margin-top:6px;margin-bottom:0;"></div>'
        + '<div id="replyFileList" class="att-draft-list"></div>'
        + '</div>'
        + '<div style="display:flex;justify-content:flex-end;">'
        + '<button class="btn primary" id="replySubmitBtn" data-action="reply-task" data-task-id="' + esc(t.task_id) + '">发送答复并继续</button>'
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
          detailHtml += renderAttachmentItem(p);
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
          + ((a.files && a.files.length)
            ? '<div class="att-list">' + a.files.map((f) => renderAttachmentItem(f)).join("") + '</div>'
            : '')
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
    const nodeLabel = s.to ? nodeFriendlyName(d, s.to) : "";
    const agentCap = s.worker
      ? (s.cap && s.cap !== "agent" ? (s.worker + "/" + s.cap) : s.worker)
      : (s.cap || "");
    const assignee = [nodeLabel, agentCap].filter(Boolean).join(" · ");
    stageHtml += '<div class="stage-node ' + cls + '"><span>' + esc(s.name || s.id) + '</span>'
      + (assignee ? '<span class="muted">→ ' + esc(assignee) + '</span>' : '') + '</div>';
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

function renderScheduleAnomalyBadge(anomaly) {
  if (anomaly === "missed") return '<span class="badge red">漏触发 (missed)</span>';
  if (anomaly === "failed") return '<span class="badge red">最近失败 (failed)</span>';
  if (anomaly === "node-offline") return '<span class="badge amber">节点离线 (node-offline)</span>';
  return '<span class="badge green">正常</span>';
}

function renderSchedules(d) {
  let html = '<div class="page-wrap">';
  html += '<div class="toolbar">'
    + '<div><div class="section-title">定时任务（只读总览）</div>'
    + '<div class="section-sub">计划在各节点本地管理，用 ah schedule 修改；HTTP 节点也可主动上报计划供集中观测。</div></div>'
    + '<button class="btn sm" data-action="refresh-schedules">刷新计划</button>'
    + '</div>';

  if (!state.schedulesApiAvailable) {
    html += '<div class="card muted">后端暂未启用定时任务查询接口（<span class="mono">GET /api/v1/schedules</span> 返回 404）。待服务端升级后即可在此查看各节点的定时计划、下次触发与异常状态。</div>';
    html += '</div>';
    return html;
  }

  if (state.schedulesError) {
    html += '<div class="err-banner">' + esc(state.schedulesError) + '</div>';
  }

  const list = state.schedules || [];
  if (!list.length) {
    html += '<div class="card muted">当前没有已登记的定时任务。计划在各节点本地管理，用 <span class="mono">ah schedule</span> 修改后会自动镜像到中台。</div>';
    html += '</div>';
    return html;
  }

  const nodeGroupMap = new Map(buildNodeGroups(d).map((g) => [g.node, g]));
  const byNode = new Map();
  for (const s of list) {
    const key = s.node || "unknown";
    if (!byNode.has(key)) byNode.set(key, []);
    byNode.get(key).push(s);
  }

  for (const [node, items] of byNode.entries()) {
    const g = nodeGroupMap.get(node);
    const online = g ? g.online : false;
    html += '<div class="card">'
      + '<div class="section-head">'
      + '<div class="section-title">'
      + '<span class="dot ' + (online ? "on" : "") + '"></span>'
      + '<span>' + esc(nodeFriendlyName(d, node)) + '</span>'
      + '<span class="badge">' + items.length + ' 条计划</span>'
      + '</div>'
      + '<span class="badge ' + (online ? "green" : "") + '">' + (online ? "节点在线" : "节点离线") + '</span>'
      + '</div>'
      + '<div class="table-wrap"><table class="clean-table"><thead><tr>'
      + '<th>计划 / 触发内容</th><th>Cron 表达式</th><th>下次触发</th><th>指向能力</th><th>启用状态</th><th>上次任务</th><th>异常标记</th>'
      + '</tr></thead><tbody>';

    for (const s of items) {
      const sourceLabel = s.source === "http-agent"
        ? '<span class="badge indigo">HTTP 自报</span>'
        : '<span class="badge">节点本地</span>';
      const lastTaskHtml = s.last_task && s.last_task.task_id
        ? '<button class="btn sm ghost" data-action="jump-task" data-task-id="' + esc(s.last_task.task_id) + '">'
          + '<span class="mono">' + esc(s.last_task.task_id) + '</span> '
          + statusPill(s.last_task.status)
          + '</button>'
          + (s.last_task.updated_at ? '<div class="hint">' + esc(formatRelativeTime(s.last_task.updated_at)) + '</div>' : '')
        : (s.last_fired
          ? '<span class="hint">上次触发：' + esc(formatRelativeTime(s.last_fired)) + '</span>'
          : '<span class="hint">暂无执行记录</span>');

      html += '<tr>'
        + '<td><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;"><strong>' + esc(s.schedule_id || s.rule_id || "-") + '</strong>' + sourceLabel + '</div>'
        + (s.text ? '<div class="hint" style="margin-top:3px;max-width:260px;">' + esc(s.text) + '</div>' : '')
        + (s.note ? '<div class="hint" style="margin-top:2px;">' + esc(s.note) + '</div>' : '')
        + '</td>'
        + '<td><div class="mono">' + esc(s.cron || "-") + '</div>' + (s.tz ? '<div class="hint">' + esc(s.tz) + '</div>' : '') + '</td>'
        + '<td><div>' + esc(formatNextFireTime(s.next_fire_at)) + '</div>'
        + (s.next_fire_at ? '<div class="hint mono" style="font-size:11px;">' + esc(s.next_fire_at) + '</div>' : '')
        + '</td>'
        + '<td class="mono">' + esc(s.cap || "-") + '</td>'
        + '<td>' + (s.enabled ? '<span class="badge green">已启用</span>' : '<span class="badge">已停用</span>') + '</td>'
        + '<td>' + lastTaskHtml + '</td>'
        + '<td>' + renderScheduleAnomalyBadge(s.anomaly) + '</td>'
        + '</tr>';
    }
    html += '</tbody></table></div></div>';
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
  if (state.view !== "tasks" && state.filePreviewTaskId) {
    revokeAttachmentObjectUrls();
  }
  if (state.view === "overview") el.innerHTML = renderOverview(d);
  else if (state.view === "agents") el.innerHTML = renderAgents(d);
  else if (state.view === "tasks") {
    const prevReplyEl = document.getElementById("replyTextBox");
    const prevReplyTaskId = prevReplyEl && prevReplyEl.dataset ? prevReplyEl.dataset.taskId : "";
    const prevReplyVal = prevReplyEl ? prevReplyEl.value : "";
    el.innerHTML = renderTasks(d);
    const nextReplyEl = document.getElementById("replyTextBox");
    if (nextReplyEl && prevReplyTaskId && nextReplyEl.dataset && nextReplyEl.dataset.taskId === prevReplyTaskId && prevReplyVal) {
      nextReplyEl.value = prevReplyVal;
    }
    if (state.selectedTaskDetail && state.selectedTaskDetail.task && state.replyDraftTaskId === state.selectedTaskDetail.task.task_id) {
      renderDraftFileList("replyFileList", state.replyDraftFiles, "reply", state.replySubmitting);
    }
    hydrateTaskAttachmentPreviews();
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
  } else if (state.view === "schedules") {
    el.innerHTML = renderSchedules(d);
  }
}

function syncNav() {
  const titles = {
    overview: "首页 · 待我处理",
    agents: "节点管理",
    tasks: "任务与沟通记录",
    loops: "SOP 多阶段闭环",
    schedules: "定时任务",
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
  setFormFileError("tfFileErr", "");
  renderDraftFileList("tfFileList", state.taskDraftFiles, "task", state.taskSubmitting);
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
    if (state.view === "schedules") {
      refreshSchedules().then(() => render());
    } else {
      render();
    }
    return;
  }
  const actEl = e.target.closest("[data-action]");
  if (!actEl) return;
  const act = actEl.dataset.action;
  if (act === "open-new-task") openNewTaskModal();
  else if (act === "open-add-agent") openAgentModal();
  else if (act === "open-new-loop") openLoopModal();
  else if (act === "open-add-cap") openAddCapModal(actEl.dataset.node);
  else if (act === "delete-card") openDeleteCardConfirm(actEl.dataset.capId);
  else if (act === "do-delete-card") doDeleteCard(actEl.dataset.capId);
  else if (act === "edit-webhook") openWebhookModal(actEl.dataset.node);
  else if (act === "test-webhook") testWebhookAction(actEl.dataset.node);
  else if (act === "delete-webhook") openDeleteWebhookConfirm(actEl.dataset.node);
  else if (act === "do-delete-webhook") doDeleteWebhook(actEl.dataset.node);
  else if (act === "refresh-schedules") refreshSchedules().then(() => { showToast("已刷新定时任务"); render(); });
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
  else if (act === "delete-node") openDeleteNodeConfirm(actEl.dataset.node, actEl.dataset.kind);
  else if (act === "do-delete-node") doDeleteNode(actEl.dataset.node);
  else if (act === "copy-rotated-token") {
    const box = document.getElementById("rotatedTokenBox");
    copyText(box ? box.value : "", "已复制新 Token");
  }
  else if (act === "copy-rotated-prompt") {
    const box = document.getElementById("rotatedPromptBox");
    copyText(box ? box.value : "", "已复制接入提示词");
  }
  else if (act === "preview-image") openImagePreviewModal(actEl.dataset.fileId, actEl.dataset.fileName);
  else if (act === "download-hub-file") downloadHubFile(actEl.dataset.fileId, actEl.dataset.fileName);
  else if (act === "remove-draft-file") removeDraftFile(actEl.dataset.draftTarget, actEl.dataset.draftId);
});

document.addEventListener("change", (e) => {
  if (!e.target) return;
  if (e.target.id === "tfFiles") {
    addDraftFiles("task", e.target.files);
    e.target.value = "";
  } else if (e.target.id === "replyFiles") {
    addDraftFiles("reply", e.target.files);
    e.target.value = "";
  }
});

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", revokeAttachmentObjectUrls);
}

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
document.getElementById("lfTemplate").addEventListener("change", renderTemplatePreview);
document.getElementById("lfBulkNode").addEventListener("change", (e) => {
  populateCapSelect(document.getElementById("lfBulkCap"), e.target.value);
});
document.getElementById("lfApplyAllBtn").addEventListener("click", () => {
  const nodeVal = document.getElementById("lfBulkNode").value;
  const capId = document.getElementById("lfBulkCap").value;
  if (!nodeVal) return showToast("请先选择一个节点");
  const rows = document.querySelectorAll("#lfStageBindings .stage-bind-row");
  if (!rows.length) return;
  rows.forEach((row) => {
    const nodeSel = row.querySelector(".stage-node-sel");
    const capSel = row.querySelector(".stage-cap-sel");
    if (nodeSel) nodeSel.value = nodeVal;
    populateCapSelect(capSel, nodeVal, "");
    if (capSel && capId && [...capSel.options].some((o) => o.value === capId)) {
      capSel.value = capId;
    }
  });
  showToast("已将全部阶段设为同一执行目标");
});
document.getElementById("lfStageBindings").addEventListener("change", (e) => {
  if (e.target && e.target.classList.contains("stage-node-sel")) {
    const row = e.target.closest(".stage-bind-row");
    if (!row) return;
    const capSel = row.querySelector(".stage-cap-sel");
    populateCapSelect(capSel, e.target.value, row.dataset.defaultCap || "");
  }
});

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
document.getElementById("receiveChoices").addEventListener("click", (e) => {
  const card = e.target.closest(".choice-card[data-receive]");
  if (!card) return;
  const nextReceive = card.dataset.receive;
  state.wizardReceive = nextReceive;
  const presetSel = document.getElementById("afTemplatePreset");
  const curPreset = AGENT_TEMPLATES.find((x) => x.id === presetSel.value);
  if (curPreset && curPreset.receive !== nextReceive) {
    // 手动换了接收方式：下拉框回到「通用」（不重置已填字段），按通用模板生成提示词。
    const generic = AGENT_TEMPLATES.find((x) => x.template === "generic" && !x.preset && x.access === state.wizardAccess);
    if (generic) presetSel.value = generic.id;
    state.wizardTemplate = "generic";
    state.wizardPreset = "";
    document.getElementById("afTemplateHint").textContent = "已手动调整接收方式，使用通用模板。";
  }
  syncReceiveChoiceCards();
});
document.getElementById("agentNextBtn").addEventListener("click", () => {
  setWizardStep(2);
  document.getElementById("afDescRow").style.display = state.wizardAccess === "http" ? "flex" : "none";
  renderTemplateOptions();
  syncReceiveChoiceCards();
});
document.getElementById("afTemplatePreset").addEventListener("change", applyTemplatePreset);
document.getElementById("afRole").addEventListener("change", () => {
  document.getElementById("afDescRow").style.display = state.wizardAccess === "http" ? "flex" : "none";
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

  if (access === "http") {
    const receive = state.wizardReceive || "poll";
    body.receive = receive;
    body.template = state.wizardTemplate || "generic";
    if (receive === "webhook") {
      const webhookUrl = document.getElementById("afWebhookUrl").value.trim();
      const webhookKey = document.getElementById("afWebhookKey").value.trim();
      const webhookHeader = document.getElementById("afWebhookHeader").value.trim();
      if (!webhookUrl || !webhookKey) {
        errBox.textContent = "选择 Webhook 推送时，必须填写回调 URL 和接收端提供的密钥";
        errBox.style.display = "block";
        return showToast("请填写 Webhook 回调 URL 和密钥");
      }
      body.webhook_url = webhookUrl;
      body.webhook_key = webhookKey;
      if (webhookHeader) body.webhook_header = webhookHeader;
    }
    if (receive === "poll" || receive === "webhook") {
      const rawInterval = document.getElementById("afPollInterval").value.trim();
      const intervalMin = Number(rawInterval);
      if (rawInterval !== "" && Number.isInteger(intervalMin) && intervalMin > 0) {
        body.poll_interval_min = intervalMin;
      }
    }
  }

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
      msg += "（如果该节点已存在并需要更换访问密钥，请到「节点」页面对应卡片中点击「重新生成」）";
    }
    errBox.textContent = msg;
    errBox.style.display = "block";
    showToast(err.message);
  }
});

document.getElementById("acWorker").addEventListener("input", syncHostCommandVisibility);
document.getElementById("copySnippetBtn").addEventListener("click", () => {
  const el = document.getElementById("acSnippetText");
  copyText(el ? el.value : "", "已复制 commands.json 片段");
});

document.getElementById("addCapForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errBox = document.getElementById("acErrBox");
  errBox.style.display = "none";
  errBox.textContent = "";

  const { node, isHttp } = state.addCapTarget;
  const skillId = document.getElementById("acSkillId").value.trim();
  const worker = document.getElementById("acWorker").value.trim();
  const skillName = document.getElementById("acSkillName").value.trim();
  const displayName = document.getElementById("acDisplayName").value.trim();
  const description = document.getElementById("acDesc").value.trim();
  const sideEffect = document.getElementById("acSideEffect").value;
  const approvalClass = document.getElementById("acApproval").value;
  const adminNote = document.getElementById("acNote").value.trim();
  const command = document.getElementById("acCommand").value.trim();
  const mode = document.getElementById("acMode").value;

  if (!skillId || !/^[A-Za-z0-9._-]+$/.test(skillId) || skillId === "workers") {
    errBox.textContent = "能力标识不合法（只允许字母、数字或 . _ -，且不能为保留键 workers）";
    errBox.style.display = "block";
    return;
  }

  try {
    if (isHttp) {
      const body = {
        node,
        skill_id: skillId,
        side_effect: sideEffect,
        approval_class: approvalClass,
      };
      if (worker) body.worker = worker;
      if (skillName) body.skill_name = skillName;
      if (displayName) body.display_name = displayName;
      if (description) body.description = description;
      if (adminNote) body.admin_note = adminNote;
      await api("/api/v1/admin/cards", { method: "POST", body: JSON.stringify(body) });
      closeModal("addCapModal");
      state.expandedNodes.add(node);
      showToast("已为节点 " + node + " 添加能力 " + skillId);
      await refreshState();
    } else {
      if (!worker && !command) {
        errBox.textContent = "宿主节点未指定归属 Agent（Worker）时，必须填写本地执行命令 command";
        errBox.style.display = "block";
        return;
      }
      const body = {
        skill_id: skillId,
        side_effect: sideEffect,
        approval_class: approvalClass,
      };
      if (worker) body.worker = worker;
      else {
        body.command = command;
        body.mode = mode;
      }
      if (skillName) body.name = skillName;
      if (description) body.description = description;
      const res = await api("/api/v1/admin/commands-snippet", { method: "POST", body: JSON.stringify(body) });
      const text = (res && res.text) || JSON.stringify((res && res.snippet) || {}, null, 2);
      document.getElementById("acSnippetText").value = text;
      document.getElementById("acSnippetHint").textContent = (res && res.hint) || "去该节点改 commands.json，守护进程自动热重载。";
      document.getElementById("acSnippetBox").style.display = "block";
      showToast("已生成 commands.json 配置片段");
    }
  } catch (err) {
    errBox.textContent = err.message || "操作失败";
    errBox.style.display = "block";
    if (err.data && err.data.snippet) {
      document.getElementById("acSnippetText").value = JSON.stringify(err.data.snippet, null, 2);
      document.getElementById("acSnippetBox").style.display = "block";
    }
    showToast(err.message);
  }
});

document.getElementById("webhookForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errBox = document.getElementById("whErrBox");
  errBox.style.display = "none";
  errBox.textContent = "";
  const node = document.getElementById("whNode").value.trim();
  const url = document.getElementById("whUrl").value.trim();
  const key = document.getElementById("whKey").value.trim();
  const header = document.getElementById("whHeader").value.trim();
  if (!node || !url) return showToast("请填写 Webhook 回调 URL");
  try {
    const body = { url };
    if (key) body.key = key;
    if (header) body.header = header;
    await api("/api/v1/admin/webhooks/" + encodeURIComponent(node), {
      method: "PUT",
      body: JSON.stringify(body),
    });
    closeModal("webhookModal");
    showToast("Webhook 配置已更新");
    await refreshWebhooks();
    render();
  } catch (err) {
    errBox.textContent = err.message || "保存 Webhook 失败";
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
  if (state.taskSubmitting) return;
  const submitBtn = document.getElementById("tfSubmitBtn");
  try {
    const to = document.getElementById("tfTo").value.trim();
    const cap = document.getElementById("tfCap").value.trim();
    const worker = document.getElementById("tfWorker").value.trim();
    const text = document.getElementById("tfText").value;
    if (!to && !cap) {
      document.getElementById("tfAdvanced").open = true;
      return showToast("请选择「交给谁」，或在高级选项中填写目标节点");
    }
    if (!text.trim() && !state.taskDraftFiles.length) {
      return showToast("请填写任务描述，或至少附上一个文件");
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

    state.taskSubmitting = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = state.taskDraftFiles.length ? "上传附件并派发中..." : "派发中...";
    }
    renderDraftFileList("tfFileList", state.taskDraftFiles, "task", true);

    if (state.taskDraftFiles.length) {
      body.attachments = await uploadDraftFilesSequentially(
        state.taskDraftFiles,
        () => renderDraftFileList("tfFileList", state.taskDraftFiles, "task", state.taskSubmitting),
        "tfFileErr",
      );
    }

    const res = await api("/api/v1/tasks", { method: "POST", body: JSON.stringify(body) });
    state.taskDraftFiles = [];
    setFormFileError("tfFileErr", "");
    document.getElementById("taskForm").reset();
    document.getElementById("criteriaRows").innerHTML = "";
    renderDraftFileList("tfFileList", [], "task", false);
    closeModal("taskModal");
    showToast("任务已派发");
    await refreshState();
    jumpToTask(res.task_id);
  } catch (err) {
    showToast("派发失败: " + err.message);
  } finally {
    state.taskSubmitting = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "立即派发";
    }
    renderDraftFileList("tfFileList", state.taskDraftFiles, "task", false);
  }
});

document.getElementById("loopForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const fallbackTo = document.getElementById("lfTo").value.trim();
    const fallbackCap = document.getElementById("lfCap").value.trim() || "agent";
    const fallbackWorker = document.getElementById("lfWorker").value.trim();
    const cards = ((state.data && state.data.agentCards) || [])
      .filter((c) => admissionOf(c) === "admitted" && c.dispatchable === "Yes");

    const stageBindings = {};
    const rows = Array.from(document.querySelectorAll("#lfStageBindings .stage-bind-row"));
    for (const row of rows) {
      const stageId = row.dataset.stageId;
      if (!stageId) continue;
      const nodeVal = (row.querySelector(".stage-node-sel")?.value || "").trim();
      const capId = (row.querySelector(".stage-cap-sel")?.value || "").trim();
      const matched = cards.find((c) => c.cap_id === capId);
      if (matched) {
        stageBindings[stageId] = {
          to: matched.node || nodeVal,
          worker: matched.worker || "",
          cap: matched.skill_id || "agent",
        };
      } else if (nodeVal) {
        stageBindings[stageId] = {
          to: nodeVal,
          worker: fallbackWorker,
          cap: fallbackCap,
        };
      } else if (fallbackTo) {
        stageBindings[stageId] = {
          to: fallbackTo,
          worker: fallbackWorker,
          cap: fallbackCap,
        };
      } else {
        document.getElementById("lfAdvanced").open = true;
        return showToast("请为每个阶段选择节点与 Agent/能力，或在高级选项填写兜底节点");
      }
    }

    const firstBind = Object.values(stageBindings)[0] || null;
    const to = fallbackTo || (firstBind ? firstBind.to : "");
    const cap = firstBind ? firstBind.cap : fallbackCap;
    const worker = firstBind ? firstBind.worker : fallbackWorker;
    if (!Object.keys(stageBindings).length && !to) {
      document.getElementById("lfAdvanced").open = true;
      return showToast("请为阶段选择执行节点，或在高级选项中填写");
    }

    const body = {
      template: document.getElementById("lfTemplate").value,
      goal: document.getElementById("lfGoal").value,
      stageBindings,
      to,
      cap,
      worker,
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
