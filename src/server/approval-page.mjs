// 一次性审批链接的落地页：GET 只展示确认页，POST 才真正决定。
// 聊天软件和邮件客户端会预抓取链接（GET），所以绝不能在 GET 上做任何状态变更。

import { extractLastAuthRequest } from "../core/approval-sign.mjs";

const MAX_FORM_BYTES = 16 * 1024;

function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sendPage(res, status, title, inner) {
  if (res.writableEnded || res.destroyed) return;
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)} · a2a-hub</title>
<style>
body{margin:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;background:#f4f5f7;color:#1f2329}
main{max-width:520px;margin:0 auto;padding:24px 16px}
.card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:19px;margin:0 0 14px}
dl{margin:0 0 16px;display:grid;grid-template-columns:auto 1fr;gap:6px 12px}
dt{color:#646a73}dd{margin:0;word-break:break-all}
pre{background:#f4f5f7;border-radius:8px;padding:10px;white-space:pre-wrap;word-break:break-all;font-size:13px;margin:0 0 16px}
textarea{width:100%;box-sizing:border-box;border:1px solid #d0d3d6;border-radius:8px;padding:8px;font:inherit;min-height:64px}
.row{display:flex;gap:10px;margin-top:14px}
button{flex:1;border:0;border-radius:8px;padding:12px;font:inherit;font-weight:600;cursor:pointer}
.ok{background:#1456f0;color:#fff}.no{background:#fbe9eb;color:#d83931}
.muted{color:#8f959e;font-size:13px}
</style></head>
<body><main><div class="card">${inner}</div></main></body></html>`;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    // 令牌在 URL 里：禁止经 Referer 外泄，禁止被嵌入第三方页面诱导点击
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(html);
}

function sendMessagePage(res, status, title, message) {
  sendPage(res, status, title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p class="muted">可以关闭此页面。</p>`);
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > MAX_FORM_BYTES) {
        const err = new Error("表单过大");
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

const VERIFY_STATUS = { invalid_link: 400, link_expired: 410, link_used: 410 };

// 校验令牌并确认任务仍停在同一条审批请求上；返回 { task, authReq, link } 或已渲染错误页的 null。
function loadPending(res, token, { approvalLinks, store }) {
  const link = approvalLinks.verify(token);
  if (!link.ok) {
    sendMessagePage(res, VERIFY_STATUS[link.code] || 400, "审批链接不可用", link.message);
    return null;
  }
  const task = store.getTask(link.taskId);
  if (!task) {
    sendMessagePage(res, 404, "任务不存在", "该任务可能已被删除。");
    return null;
  }
  if (task.state !== "auth-required") {
    sendMessagePage(res, 409, "无需审批", `该任务已处理，当前状态：${task.state}。`);
    return null;
  }
  const authReq = extractLastAuthRequest({ messages: store.listMessages(task.id) });
  if (String(authReq?.data?.request_id || "default") !== link.requestId) {
    sendMessagePage(res, 410, "审批链接已过期", "该任务有更新的审批请求，请使用最新通知里的链接。");
    return null;
  }
  return { task, authReq, link };
}

export async function handleApprovalLinkRequest(req, res, token, { approvalLinks, taskService, store }) {
  const method = req.method || "GET";
  if (!approvalLinks || !approvalLinks.isEnabled()) {
    return sendMessagePage(res, 404, "审批链接未启用", "机主尚未开启一次性审批链接，请到控制台处理。");
  }

  if (method === "GET") {
    const pending = loadPending(res, token, { approvalLinks, store });
    if (!pending) return;
    const { task, authReq, link } = pending;
    const d = authReq?.data || {};
    const preview = String(d.command_preview || "").trim();
    const expires = new Date(link.expiresAt).toLocaleString("zh-CN", { hour12: false });
    return sendPage(res, 200, "待你审批", `
<h1>待你审批</h1>
<dl>
  <dt>任务</dt><dd>${escapeHtml(task.title || task.id)}</dd>
  <dt>执行节点</dt><dd>${escapeHtml(task.to_agent_id)}</dd>
  <dt>发起方</dt><dd>${escapeHtml(task.from_node)}</dd>
  <dt>风险级别</dt><dd>${escapeHtml(d.risk_level || "-")}</dd>
  <dt>原因</dt><dd>${escapeHtml(d.reason || authReq?.body || "-")}</dd>
</dl>
${preview ? `<pre>${escapeHtml(preview)}</pre>` : ""}
<form method="post">
  <textarea name="note" maxlength="500" placeholder="备注（可选）"></textarea>
  <div class="row">
    <button class="no" type="submit" name="decision" value="deny">拒绝</button>
    <button class="ok" type="submit" name="decision" value="approve">签名并放行</button>
  </div>
</form>
<p class="muted">链接仅能使用一次，${escapeHtml(expires)} 前有效。</p>`);
  }

  if (method === "POST") {
    const form = await readForm(req);
    const decision = String(form.get("decision") || "");
    if (decision !== "approve" && decision !== "deny") {
      return sendMessagePage(res, 400, "无效操作", "请在确认页点击「签名并放行」或「拒绝」。");
    }
    const pending = loadPending(res, token, { approvalLinks, store });
    if (!pending) return;
    const { task, link } = pending;
    if (!approvalLinks.consume(link.nonce, { task_id: task.id, decision })) {
      return sendMessagePage(res, 410, "审批链接不可用", "链接已被使用");
    }
    try {
      const updated = taskService.decideApproval(task.id, {
        fromNode: "owner",
        decision,
        note: String(form.get("note") || "").trim().slice(0, 500),
        requestId: link.requestId,
        channel: "link",
      });
      return decision === "approve"
        ? sendMessagePage(res, 200, "已签名放行", `任务「${updated.title || updated.id}」已重新排队执行。`)
        : sendMessagePage(res, 200, "已拒绝", `任务「${updated.title || updated.id}」已被拒绝。`);
    } catch (err) {
      return sendMessagePage(res, Number(err?.statusCode) || 500, "审批失败", err?.message || "服务器内部错误");
    }
  }

  res.writeHead(405, { Allow: "GET, POST", "Cache-Control": "no-store" });
  res.end();
}
