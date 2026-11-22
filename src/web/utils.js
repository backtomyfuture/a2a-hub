export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatRelativeTime(ms) {
  if (!ms) return "从未活跃";
  const diff = Math.max(0, Date.now() - Number(ms));
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "刚刚";
  if (sec < 60) return `${sec}秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  return `${Math.floor(hr / 24)}天前`;
}

export function formatDateTime(ms) {
  if (!ms) return "-";
  try {
    return new Date(Number(ms)).toLocaleString("zh-CN", {
      hour12: false,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return String(ms);
  }
}

export function formatInterval(min) {
  const m = Number(min || 0);
  if (!Number.isFinite(m) || m <= 0) return "未设间隔";
  if (m < 60) return `每 ${m} 分钟`;
  if (m % 1440 === 0) return m === 1440 ? "每天" : `每 ${m / 1440} 天`;
  if (m % 60 === 0) return `每 ${m / 60} 小时`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return `每 ${h} 小时 ${rem} 分`;
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined) return "-";
  const num = Number(ms);
  if (!Number.isFinite(num) || num < 0) return "-";
  if (num < 1000) return `${Math.round(num)}ms`;
  const sec = Math.round(num / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return remSec ? `${min}m ${remSec}s` : `${min}m`;
}

export function stateLabel(state) {
  const map = {
    submitted: "排队中",
    working: "执行中",
    "input-required": "等你回复",
    "auth-required": "待你审批",
    completed: "已完成",
    failed: "失败",
    canceled: "已取消",
    rejected: "已拒绝",
  };
  return map[state] || state || "-";
}

export function stateTone(state) {
  if (state === "completed") return "pill-success";
  if (state === "working" || state === "submitted") return "pill-primary";
  if (state === "input-required") return "pill-warning";
  if (state === "auth-required" || state === "failed" || state === "rejected") return "pill-danger";
  return "";
}

export function agentSourceLabel(agent) {
  if (agent.kind === "device-worker") {
    return `${agent.device_name || agent.device_id || "设备"} · 本机 CLI`;
  }
  if (agent.transport === "webhook") return "Webhook 推送 · 独立 Agent";
  if (agent.transport === "longpoll") return "长连接 · 独立 Agent";
  return `定时轮询 ${agent.poll_interval_min || 5}m · 云端/独立`;
}

export function showToast(msg, isError = false) {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const el = document.createElement("div");
  el.className = `toast${isError ? " is-error" : ""}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

export async function copyText(text, label = "已复制") {
  try {
    await navigator.clipboard.writeText(String(text || ""));
    showToast(label);
  } catch {
    showToast("复制失败，请手动选中复制", true);
  }
}
