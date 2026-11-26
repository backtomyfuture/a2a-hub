import { api } from "./api.js";

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

/**
 * 安全绑定弹窗/抽屉遮罩层点击关闭
 * 核心：只有当 mousedown 和 mouseup 均发生在 backdrop 本身（空白处）时，才触发关闭。
 * 杜绝：在卡片内部选中文本拖拽出界、滚动条拖拽、或内部点击因重绘丢失元素后误触关闭。
 */
export function bindBackdropClose(backdropEl, onClose) {
  if (!backdropEl || typeof onClose !== "function") return;
  let downOnBackdrop = false;
  let upOnBackdrop = false;

  backdropEl.addEventListener("mousedown", (e) => {
    downOnBackdrop = e.target === backdropEl;
    upOnBackdrop = false;
  });

  // 内部按下、遮罩松开（或反之）时 click 的 target 会冒泡成共同祖先即遮罩，必须靠 mouseup 位置排除
  backdropEl.addEventListener("mouseup", (e) => {
    upOnBackdrop = e.target === backdropEl;
  });

  backdropEl.addEventListener("click", (e) => {
    const ok = downOnBackdrop && upOnBackdrop && e.target === backdropEl;
    downOnBackdrop = false;
    upOnBackdrop = false;
    if (ok) onClose(e);
  });
}

const HUB_FILE_HEX_RE = /^[a-f0-9]{16,64}$/;
const TEXT_PREVIEW_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "text/javascript",
  "application/typescript",
  "application/x-sh",
]);
const TEXT_PREVIEW_EXTS = new Set([
  ".txt", ".log", ".md", ".markdown", ".json", ".csv", ".yaml", ".yml", ".xml",
  ".js", ".mjs", ".cjs", ".ts", ".mts", ".py", ".sh", ".css", ".toml", ".ini", ".env",
]);
const IMAGE_PREVIEW_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_PREVIEW_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function fileExtOf(name) {
  const s = String(name || "").trim().toLowerCase();
  const idx = s.lastIndexOf(".");
  return idx >= 0 ? s.slice(idx) : "";
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function extractAttachmentFileId(att) {
  if (!att) return "";
  if (typeof att === "string") {
    const raw = att.trim();
    const m = /^(?:hub:\/\/files\/|(?:https?:\/\/[^/]+)?\/api\/v1\/files\/)([a-f0-9]{16,64})(?:[/?#]|$)/.exec(raw);
    return m ? m[1] : "";
  }
  if (typeof att === "object") {
    for (const c of [att.uri, att.url, att.download_path]) {
      const hit = extractAttachmentFileId(c);
      if (hit) return hit;
    }
    for (const rawId of [att.id, att.file_id]) {
      const s = String(rawId || "").trim();
      if (HUB_FILE_HEX_RE.test(s)) return s;
    }
  }
  return "";
}

export function isTextPreviewMime(mime, name = "") {
  const base = String(mime || "").split(";")[0].trim().toLowerCase();
  if (base === "text/html" || base === "image/svg+xml") return false;
  if (base.startsWith("text/") || TEXT_PREVIEW_MIMES.has(base)) return true;
  return TEXT_PREVIEW_EXTS.has(fileExtOf(name));
}

export function isImagePreviewMime(mime, name = "") {
  const base = String(mime || "").split(";")[0].trim().toLowerCase();
  if (IMAGE_PREVIEW_MIMES.has(base)) return true;
  return IMAGE_PREVIEW_EXTS.has(fileExtOf(name));
}

export function isPdfPreviewMime(mime, name = "") {
  const base = String(mime || "").split(";")[0].trim().toLowerCase();
  return base === "application/pdf" || fileExtOf(name) === ".pdf";
}

export function attachmentUniqueKey(att) {
  const fid = extractAttachmentFileId(att);
  if (fid) return `hub:${fid}`;
  if (typeof att === "string") return `str:${att.trim()}`;
  return String(att?.uri || att?.url || att?.name || JSON.stringify(att || {}));
}

export function renderAttachmentsBar(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return "";
  const chips = attachments
    .filter(Boolean)
    .map((att) => {
      const id = extractAttachmentFileId(att);
      const name =
        typeof att === "string"
          ? att.split("/").pop() || "attachment"
          : String(att.name || att.uri || att.url || "attachment");
      const mime = typeof att === "object" ? String(att.mime || "") : "";
      const sizeStr = typeof att === "object" && Number.isFinite(Number(att.size)) ? formatBytes(Number(att.size)) : "";

      if (id) {
        const canPreview = isTextPreviewMime(mime, name) || isImagePreviewMime(mime, name) || isPdfPreviewMime(mime, name);
        const dlPath = `/api/v1/files/${encodeURIComponent(id)}`;
        return `
          <div class="attachment-chip" data-attachment-chip>
            <span class="attachment-icon">📎</span>
            <span class="attachment-name truncate" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            ${sizeStr ? `<span class="attachment-size">${escapeHtml(sizeStr)}</span>` : ""}
            ${
              canPreview
                ? `<button type="button" class="btn btn-ghost btn-sm attachment-action-btn" data-preview-file="${escapeHtml(id)}" data-preview-name="${escapeHtml(name)}" data-preview-mime="${escapeHtml(mime)}">预览</button>`
                : ""
            }
            <a class="btn btn-ghost btn-sm attachment-action-btn" href="${dlPath}" download="${escapeHtml(name)}">下载</a>
          </div>
        `;
      }

      const rawUrl = typeof att === "string" ? att.trim() : String(att.url || att.uri || "").trim();
      const safeExternal = /^https?:\/\//i.test(rawUrl);
      return `
        <div class="attachment-chip" data-attachment-chip>
          <span class="attachment-icon">📎</span>
          <span class="attachment-name truncate" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          ${sizeStr ? `<span class="attachment-size">${escapeHtml(sizeStr)}</span>` : ""}
          ${
            safeExternal
              ? `<a class="btn btn-ghost btn-sm attachment-action-btn" href="${escapeHtml(rawUrl)}" target="_blank" rel="noopener noreferrer">打开</a>`
              : ""
          }
        </div>
      `;
    })
    .join("");
  return chips ? `<div class="attachment-bar">${chips}</div>` : "";
}

function openAttachmentPreviewModal({ id, name, mime }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  const dlUrl = `/api/v1/files/${encodeURIComponent(id)}`;
  const inlineUrl = `${dlUrl}?inline=1`;

  overlay.innerHTML = `
    <div class="modal-card" style="max-width:780px">
      <div class="row-between" style="margin-bottom:12px">
        <div style="min-width:0">
          <h3 style="margin:0;font-size:16px" class="truncate">${escapeHtml(name)}</h3>
          ${mime ? `<div class="muted mono" style="font-size:11px">${escapeHtml(mime)}</div>` : ""}
        </div>
        <div class="row">
          <a class="btn btn-secondary btn-sm" href="${dlUrl}" download="${escapeHtml(name)}">下载原文件</a>
          <button type="button" class="btn btn-ghost btn-sm" data-preview-close>关闭</button>
        </div>
      </div>
      <div id="preview-modal-body"></div>
    </div>
  `;

  const close = () => {
    window.removeEventListener("keydown", onEsc);
    overlay.remove();
  };
  const onEsc = (e) => {
    if (e.key === "Escape") close();
  };

  bindBackdropClose(overlay, close);
  overlay.querySelector("[data-preview-close]")?.addEventListener("click", close);
  window.addEventListener("keydown", onEsc);
  document.body.appendChild(overlay);

  const bodyEl = overlay.querySelector("#preview-modal-body");
  if (!bodyEl) return;

  if (isImagePreviewMime(mime, name)) {
    bodyEl.innerHTML = `<div class="preview-media-wrap"><img src="${inlineUrl}" alt="${escapeHtml(name)}" class="preview-image" /></div>`;
    return;
  }

  if (isPdfPreviewMime(mime, name)) {
    bodyEl.innerHTML = `
      <div class="stack-sm">
        <p class="muted" style="margin:0">PDF 文档支持在新标签页内联预览或下载查看。</p>
        <div class="row">
          <a class="btn btn-primary btn-sm" href="${inlineUrl}" target="_blank" rel="noopener noreferrer">在新标签页预览 PDF</a>
          <a class="btn btn-secondary btn-sm" href="${dlUrl}" download="${escapeHtml(name)}">下载 PDF</a>
        </div>
      </div>
    `;
    return;
  }

  const pre = document.createElement("pre");
  pre.className = "code-box preview-pre";
  pre.textContent = "正在加载文件内容...";
  bodyEl.appendChild(pre);

  api.fetchFileText(id).then((text) => {
    const LIMIT = 200_000;
    if (text.length > LIMIT) {
      pre.textContent = `${text.slice(0, LIMIT)}\n\n...（内容超过 200KB，已截断预览，请点击右上角「下载原文件」查看完整内容）`;
    } else {
      pre.textContent = text;
    }
  }).catch((err) => {
    pre.textContent = `预览失败：${err?.message || err}`;
  });
}

export function bindAttachmentPreview(container) {
  if (!container) return;
  container.querySelectorAll(".attachment-bar a").forEach((link) => {
    link.addEventListener("click", (e) => e.stopPropagation());
  });
  container.querySelectorAll("[data-preview-file]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.getAttribute("data-preview-file") || "";
      const name = btn.getAttribute("data-preview-name") || "attachment";
      const mime = btn.getAttribute("data-preview-mime") || "";
      if (id) openAttachmentPreviewModal({ id, name, mime });
    });
  });
}

// 展示排序：Leader 置顶；其余在线 → 连不上 → 已暂停，同组按名称，保证各视图顺序一致
function presenceRank(item) {
  if (!item.enabled) return 2;
  return item.online ? 0 : 1;
}

function byName(a, b) {
  return String(a.name || a.id).localeCompare(String(b.name || b.id), "zh-CN");
}

export function sortAgentsForDisplay(agents = []) {
  return [...agents].sort((a, b) => {
    const la = a.role === "leader" ? 0 : 1;
    const lb = b.role === "leader" ? 0 : 1;
    if (la !== lb) return la - lb;
    const pr = presenceRank(a) - presenceRank(b);
    if (pr) return pr;
    return byName(a, b);
  });
}

export function sortDevicesForDisplay(devices = []) {
  return [...devices].sort((a, b) => {
    const pr = presenceRank(a) - presenceRank(b);
    if (pr) return pr;
    if (Boolean(a.is_local) !== Boolean(b.is_local)) return a.is_local ? -1 : 1;
    return byName(a, b);
  });
}
