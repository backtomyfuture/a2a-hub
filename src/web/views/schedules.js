import { api } from "../api.js";
import { setState, store } from "../state.js";
import {
  agentSourceLabel,
  copyText,
  escapeHtml,
  formatDateTime,
  formatDuration,
  formatInterval,
  formatRelativeTime,
  showToast,
  stateLabel,
} from "../utils.js";

const SCHEDULE_FILTERS = [
  { id: "all", label: "全部" },
  { id: "abnormal", label: "异常 / 漏报" },
  { id: "hub", label: "中台派发" },
  { id: "edge", label: "外部自管" },
  { id: "paused", label: "已暂停" },
];

export const HUB_CRON_PRESETS = [
  { id: "0 9 * * *", label: "每天早上 09:00" },
  { id: "0 21 * * *", label: "每天晚上 21:00" },
  { id: "0 * * * *", label: "每小时整点" },
  { id: "*/15 * * * *", label: "每 15 分钟" },
  { id: "0 9 * * 1", label: "每周一 09:00" },
  { id: "custom", label: "自定义 Cron..." },
];

const EDGE_EVERY_PRESETS = [
  { id: "15m", min: 15, label: "每 15 分钟" },
  { id: "1h", min: 60, label: "每小时" },
  { id: "1d", min: 1440, label: "每天一次" },
  { id: "6d", min: 8640, label: "每 6 天一次（如 iPad 续签）" },
  { id: "7d", min: 10080, label: "每周一次" },
];

function resolveHubTimezone() {
  return store.state?.hub_timezone || "Asia/Shanghai";
}

export function slugifyScheduleId(rawName, fallback = "job") {
  const cleaned = String(rawName || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || `${fallback}-${Date.now().toString(36).slice(-4)}`;
}

function shellQuote(arg) {
  const s = String(arg ?? "");
  if (/^[A-Za-z0-9._:/@-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

let panelState = {
  open: false,
  editingKey: null,
  driver: "hub",
  preset: "0 9 * * *",
  edgeEvery: "1d",
  edgeName: "",
  edgeId: "",
};

export function resetSchedulePanelState(patch = {}) {
  panelState = {
    open: false,
    editingKey: null,
    driver: "hub",
    preset: "0 9 * * *",
    edgeEvery: "1d",
    edgeName: "",
    edgeId: "",
    ...patch,
  };
}

export function isSchedulePanelOpen() {
  return Boolean(panelState.open);
}

function healthBadge(sch) {
  const h = sch.health || "idle";
  if (h === "paused") {
    return `<span class="pill">${sch.driver === "edge" ? "已静默" : "已暂停"}</span>`;
  }
  if (h === "running") return `<span class="pill pill-primary">执行中</span>`;
  if (h === "attention") return `<span class="pill pill-warning">待你介入</span>`;
  if (h === "missed") return `<span class="pill pill-danger">超时未报</span>`;
  if (h === "failing") return `<span class="pill pill-danger">上次失败</span>`;
  if (h === "healthy") return `<span class="pill pill-success">正常</span>`;
  return `<span class="pill">${sch.driver === "hub" ? "待触发" : "待首报"}</span>`;
}

function driverBadge(sch) {
  if (sch.driver === "hub") {
    return `<span class="chip chip-hub" title="由中台按时向 Agent 派发任务">中台派发</span>`;
  }
  return `<span class="chip chip-edge" title="Agent 自己管理定时并执行，跑完向中台报备一次状态">外部自管</span>`;
}

function isAbnormal(sch) {
  return sch.health === "missed" || sch.health === "failing" || sch.health === "attention";
}

function runBarClass(state) {
  if (state === "completed") return "is-ok";
  if (state === "failed" || state === "rejected" || state === "canceled") return "is-fail";
  if (state === "input-required" || state === "auth-required") return "is-warn";
  if (state === "working" || state === "submitted") return "is-run";
  if (state === "noop" || state === "skipped_overlap" || state === "skipped_paused") return "is-noop";
  return "is-empty";
}

function runStateLabel(state) {
  if (state === "noop") return "静默打卡（无新动作）";
  if (state === "skipped_overlap") return "上轮未完跳过";
  if (state === "skipped_paused") return "目标暂停跳过";
  return stateLabel(state);
}

function renderSparkline(sch) {
  const runs = Array.isArray(sch.recent_runs) ? sch.recent_runs : [];
  const totalSlots = 10;
  const emptyCount = Math.max(0, totalSlots - runs.length);
  const bars = [];
  for (let i = 0; i < emptyCount; i++) {
    bars.push(`<span class="run-bar is-empty" title="暂无记录"></span>`);
  }
  for (const r of runs.slice(-totalSlots)) {
    const cls = runBarClass(r.state);
    const tip = `${formatDateTime(r.created_at)} · ${runStateLabel(r.state)}${r.duration_ms != null ? ` (${formatDuration(r.duration_ms)})` : ""}${r.summary ? ` — ${r.summary.slice(0, 60)}` : ""}`;
    if (r.context_id) {
      bars.push(
        `<button type="button" class="run-bar ${cls}" data-jump-thread="${escapeHtml(r.context_id)}" title="${escapeHtml(tip)}"></button>`
      );
    } else {
      bars.push(`<span class="run-bar ${cls}" title="${escapeHtml(tip)}"></span>`);
    }
  }
  return `<div class="run-sparkline" title="最近 ${totalSlots} 次状态（绿=成功 / 红=失败 / 灰矮柱=空转打卡）">${bars.join("")}</div>`;
}

function renderNextWindow(sch) {
  if (!sch.enabled) {
    return `<span class="muted">${sch.driver === "edge" ? "已静默告警" : "已暂停"}</span>`;
  }
  if (sch.missed) {
    const overMin = Math.max(1, Math.round((sch.overdue_ms || 0) / 60_000));
    return `<span style="color:var(--danger);font-weight:600">已超时 ${overMin} 分钟未报</span>`;
  }
  if (sch.next_expected_at) {
    const diffMin = Math.round((Number(sch.next_expected_at) - Date.now()) / 60_000);
    if (diffMin <= 0) return `<span class="muted">即将完成</span>`;
    if (diffMin < 60) return `<span class="muted">约 ${diffMin} 分钟后</span>`;
    if (diffMin < 1440) return `<span class="muted">约 ${Math.round((diffMin / 60) * 10) / 10} 小时后</span>`;
    return `<span class="muted">约 ${Math.round((diffMin / 1440) * 10) / 10} 天后</span>`;
  }
  return `<span class="muted">等待首次运行</span>`;
}

function renderScheduleRow(sch) {
  const lastRun = sch.last_run;
  const snippet = lastRun?.error_message || lastRun?.summary || "";
  const rateText = sch.success_rate !== null && sch.success_rate !== undefined ? `${sch.success_rate}% 成功率` : "暂无统计";
  const isEdge = sch.driver !== "hub";
  const canTrigger = sch.driver === "hub" || Boolean(sch.triggerable);
  const tplTargets = Array.isArray(sch.task_template?.to)
    ? sch.task_template.to.filter((id) => id && id !== sch.agent_id)
    : [];

  const lastCheckLabel = sch.last_tick_at
    ? `${formatRelativeTime(sch.last_tick_at)}${sch.last_outcome === "noop" ? " (无新动作)" : ""}`
    : "尚未运行";

  return `
    <div class="schedule-row ${isAbnormal(sch) ? "is-alert" : ""}">
      <div class="schedule-main">
        <div class="row" style="flex-wrap:wrap;gap:8px">
          ${healthBadge(sch)}
          ${driverBadge(sch)}
          <strong style="font-size:14px">${escapeHtml(sch.name)}</strong>
          <span class="chip ${sch.cron_expr ? "mono" : ""}">${escapeHtml(sch.cron_expr || formatInterval(sch.interval_min))}</span>
          ${sch.driver === "hub" && sch.context_mode === "rolling" ? `<span class="chip" title="每次结果追加到同一个对话线程">同一线程追记</span>` : ""}
          ${tplTargets.length ? `<span class="chip">并发 +${tplTargets.length}</span>` : ""}
          <span class="muted mono">${escapeHtml(sch.id)}</span>
        </div>

        ${sch.summary ? `<div class="muted" style="font-size:12px;margin-top:4px">${escapeHtml(sch.summary)}</div>` : ""}

        <div class="schedule-telemetry">
          <span>上次动态：<strong>${escapeHtml(lastCheckLabel)}</strong></span>
          ${lastRun?.duration_ms != null ? `<span>耗时：${formatDuration(lastRun.duration_ms)}</span>` : ""}
          <span>${rateText}</span>
          <span>下次预期：${renderNextWindow(sch)}</span>
        </div>

        ${
          snippet
            ? `<div class="schedule-snippet ${lastRun?.error_message ? "is-err" : ""}">${escapeHtml(snippet)}</div>`
            : ""
        }
      </div>

      <div class="schedule-side">
        ${renderSparkline(sch)}
        <div class="row" style="justify-content:flex-end;flex-wrap:wrap">
          ${
            sch.last_context_id && !isEdge
              ? `<button type="button" class="btn btn-ghost btn-sm" data-jump-thread="${escapeHtml(sch.last_context_id)}">查看记录</button>`
              : isEdge && lastRun?.context_id
                ? `<button type="button" class="btn btn-ghost btn-sm" data-jump-thread="${escapeHtml(lastRun.context_id)}">查看异常/归档</button>`
                : ""
          }
          ${
            canTrigger
              ? `<button type="button" class="btn btn-secondary btn-sm" data-sch-run="${escapeHtml(sch.agent_id)}:::${escapeHtml(sch.id)}">立即运行</button>`
              : ""
          }
          <button type="button" class="btn btn-ghost btn-sm" data-sch-edit="${escapeHtml(sch.agent_id)}:::${escapeHtml(sch.id)}">设置</button>
          <button type="button" class="btn btn-secondary btn-sm" data-sch-toggle="${escapeHtml(sch.agent_id)}:::${escapeHtml(sch.id)}" data-sch-enabled="${sch.enabled ? "1" : "0"}">
            ${sch.enabled ? (isEdge ? "静默告警" : "暂停") : (isEdge ? "恢复告警" : "启用")}
          </button>
          <button type="button" class="btn btn-danger btn-sm" data-sch-del="${escapeHtml(sch.agent_id)}:::${escapeHtml(sch.id)}">移除</button>
        </div>
      </div>
    </div>
  `;
}

export function buildEdgeQuickSnippets({ hubUrl, schId, schName, every }) {
  const base = String(hubUrl || globalThis.location?.origin || "http://127.0.0.1:8787").replace(/\/+$/, "");
  const safeId = /^[A-Za-z0-9._-]+$/.test(String(schId || "").trim())
    ? String(schId).trim()
    : slugifyScheduleId(schId || schName, "my-job");
  const safeName = String(schName || safeId).trim() || safeId;
  const safeEvery = String(every || "1d").trim() || "1d";

  const okJson = JSON.stringify({ name: safeName, every: safeEvery, summary: "简短结果" });
  const errJson = JSON.stringify({ name: safeName, every: safeEvery, error: "失败原因" });

  const botPrompt = `每次执行完「${safeName}」后，顺手用 curl POST 一次 ${base}/api/v1/schedules/${safeId}/runs （带上你原有的 Authorization 头），成功传 ${shellQuote(okJson)}，失败传 ${shellQuote(errJson)}，不用等待或处理返回。`;
  const cliWrap = `ah schedule run ${safeId} --name ${shellQuote(safeName)} --every ${shellQuote(safeEvery)} -- <你的原命令>`;
  return { botPrompt, cliWrap };
}

function renderSchedulePanel(agents, schedules, hubUrl) {
  if (!panelState.open) return "";

  let editing = null;
  if (panelState.editingKey) {
    const [aid, sid] = panelState.editingKey.split(":::");
    editing = schedules.find((x) => x.agent_id === aid && x.id === sid) || null;
  }

  const driver = editing ? editing.driver : panelState.driver;
  const isHub = driver === "hub";
  const defaultTz = editing?.timezone || resolveHubTimezone();

  if (isHub) {
    const existingCron = editing?.cron_expr || "";
    const matchedPreset = existingCron
      ? (HUB_CRON_PRESETS.find((p) => p.id !== "custom" && p.id === existingCron)?.id || "custom")
      : panelState.preset;
    const isCustomCron = matchedPreset === "custom";
    const initialCronInputVal = isCustomCron ? existingCron : matchedPreset;
    const promptText = editing?.task_template?.input_text || editing?.summary || "";
    const fanoutIds = Array.isArray(editing?.task_template?.to)
      ? editing.task_template.to.filter((x) => x !== editing.agent_id)
      : [];
    const hasAdvOpen = Boolean(editing && (fanoutIds.length || editing.context_mode === "rolling"));

    return `
      <section class="card" id="new-schedule-panel" style="margin-bottom:18px">
        <div class="row-between" style="margin-bottom:12px;flex-wrap:wrap;gap:10px">
          <div class="row" style="gap:10px;flex-wrap:wrap">
            <h3 class="section-title" style="font-size:15px;margin:0">${editing ? `修改定时 · ${escapeHtml(editing.name)}` : "添加定时"}</h3>
            ${
              !editing
                ? `<div class="seg-control">
                    <button type="button" class="seg-btn active" data-driver-switch="hub">中台定时派发</button>
                    <button type="button" class="seg-btn" data-driver-switch="edge">接入外部自管定时</button>
                  </div>`
                : driverBadge(editing)
            }
          </div>
          <button type="button" class="btn btn-ghost btn-sm" id="btn-close-new-sch">收起</button>
        </div>

        <form id="form-create-schedule" class="stack-md">
          <input type="hidden" name="driver" value="hub" />
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px">
            <label class="field">
              <span>1. 交给谁做 *</span>
              <select name="agent_id" ${editing ? "disabled" : "required"}>
                ${agents
                  .map(
                    (a) =>
                      `<option value="${escapeHtml(a.id)}" ${editing?.agent_id === a.id ? "selected" : ""}>${escapeHtml(a.name)} (${escapeHtml(a.id)})</option>`
                  )
                  .join("")}
              </select>
              ${editing ? `<input type="hidden" name="agent_id" value="${escapeHtml(editing.agent_id)}" />` : ""}
            </label>
            <label class="field">
              <span>2. 多久跑一次 *</span>
              <select name="cron_preset" id="sch-cron-preset">
                ${HUB_CRON_PRESETS.map(
                  (p) => `<option value="${escapeHtml(p.id)}" ${matchedPreset === p.id ? "selected" : ""}>${escapeHtml(p.label)}</option>`
                ).join("")}
              </select>
            </label>
            <label class="field ${isCustomCron ? "" : "hidden"}" id="sch-custom-cron-wrap">
              <span>Cron 表达式（分 时 日 月 周）*</span>
              <input type="text" name="cron_expr" id="sch-cron-expr-input" value="${escapeHtml(initialCronInputVal)}" placeholder="0 9 * * *" required />
            </label>
          </div>

          <label class="field">
            <span>3. 具体要做什么 *</span>
            <textarea name="prompt_text" rows="2" placeholder="直接写任务内容，例如：检查仓库未合并 PR 与单测状态并汇总..." required>${escapeHtml(promptText)}</textarea>
          </label>

          <details class="adv-details" ${hasAdvOpen ? "open" : ""}>
            <summary>更多选项（自定义名称 / 多节点一起做 / 连续追记在同一线程）</summary>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px">
              <label class="field">
                <span>显示名称（留空自动截取任务内容）</span>
                <input type="text" name="name" value="${escapeHtml(editing?.name || "")}" placeholder="例如：每日代码巡检" />
              </label>
              <label class="field">
                <span>同时派给其他节点（逗号分隔 ID）</span>
                <input type="text" name="extra_to" value="${escapeHtml(fanoutIds.join(", "))}" placeholder="可选，如 doubao" />
              </label>
              <label class="field">
                <span>对话线程归档</span>
                <select name="context_mode">
                  <option value="per_run" ${editing?.context_mode !== "rolling" ? "selected" : ""}>每次单独开一条新记录（默认）</option>
                  <option value="rolling" ${editing?.context_mode === "rolling" ? "selected" : ""}>一直追记在同一个固定专栏里</option>
                </select>
              </label>
              <label class="field">
                <span>时区</span>
                <input type="text" name="timezone" value="${escapeHtml(defaultTz)}" />
              </label>
            </div>
            ${editing ? `<input type="hidden" name="id" value="${escapeHtml(editing.id)}" />` : ""}
          </details>

          <div class="row-between" style="flex-wrap:wrap;gap:10px">
            <label class="row" style="font-size:12px;cursor:pointer">
              <input type="checkbox" name="run" value="1" />
              <span>保存后立刻先跑一次</span>
            </label>
            <button type="submit" class="btn btn-primary btn-sm" ${agents.length ? "" : "disabled"}>
              ${editing ? "保存修改" : "开启定时任务"}
            </button>
          </div>
        </form>
      </section>
    `;
  }

  // 外部自管定时面板：编辑已有条目时排期只读展示（不提交 every，防止意外覆盖 Bot 自报的排期）；新建时提供一键复制接入片段。
  const externalFirstAgents = [...agents].sort((a, b) => (a.kind === "device-worker" ? 1 : 0) - (b.kind === "device-worker" ? 1 : 0));
  const previewName = editing ? editing.name : (panelState.edgeName || "iPad应用续签");
  const previewId = editing ? editing.id : (panelState.edgeId || slugifyScheduleId(previewName, "ipad-sign"));
  const previewEvery = editing
    ? (EDGE_EVERY_PRESETS.find((p) => p.min === editing.interval_min)?.id || `${editing.interval_min}m`)
    : panelState.edgeEvery;
  const readonlyPeriodLabel = editing
    ? (editing.cron_expr
        ? `${editing.cron_expr} (${editing.timezone || "Asia/Shanghai"})`
        : `${formatInterval(editing.interval_min)}（由该 Bot 上报决定）`)
    : "";
  const snippets = buildEdgeQuickSnippets({
    hubUrl,
    schId: previewId,
    schName: previewName,
    every: previewEvery,
  });

  return `
    <section class="card" id="new-schedule-panel" style="margin-bottom:18px">
      <div class="row-between" style="margin-bottom:12px;flex-wrap:wrap;gap:10px">
        <div class="row" style="gap:10px;flex-wrap:wrap">
          <h3 class="section-title" style="font-size:15px;margin:0">${editing ? `设置外部定时 · ${escapeHtml(editing.name)}` : "接入外部自管定时"}</h3>
          ${
            !editing
              ? `<div class="seg-control">
                  <button type="button" class="seg-btn" data-driver-switch="hub">中台定时派发</button>
                  <button type="button" class="seg-btn active" data-driver-switch="edge">接入外部自管定时</button>
                </div>`
              : driverBadge(editing)
          }
        </div>
        <button type="button" class="btn btn-ghost btn-sm" id="btn-close-new-sch">收起</button>
      </div>

      <div class="muted" style="font-size:12px;margin-bottom:12px">
        适合 Grok Bot、Muse、Instinct 等自己管定时的个人机器人：<strong>无需提前建表</strong>，中台不介入执行、平时成功不刷屏对话线程；让它在跑完时顺手发一行状态，首次上报即自动出现在这里，失败或超时未报时自动发告警。
      </div>

      <form id="form-create-schedule" class="stack-md" data-editing-edge="${editing ? "1" : "0"}">
        <input type="hidden" name="driver" value="edge" />
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">
          <label class="field">
            <span>哪个 Bot 自己跑</span>
            <select name="agent_id" ${editing ? "disabled" : "required"}>
              ${externalFirstAgents
                .map(
                  (a) =>
                    `<option value="${escapeHtml(a.id)}" ${editing?.agent_id === a.id ? "selected" : ""}>${escapeHtml(a.name)} (${escapeHtml(a.id)})</option>`
                )
                .join("")}
            </select>
            ${editing ? `<input type="hidden" name="agent_id" value="${escapeHtml(editing.agent_id)}" />` : ""}
          </label>
          <label class="field">
            <span>任务名称</span>
            <input type="text" name="name" id="edge-name-input" value="${escapeHtml(editing ? editing.name : panelState.edgeName)}" placeholder="例如：iPad应用续签" required />
          </label>
          <label class="field">
            <span>简短英文代号</span>
            <input type="text" name="id" id="edge-id-input" value="${escapeHtml(editing ? editing.id : panelState.edgeId)}" placeholder="例如：ipad-sign" ${editing ? "readonly" : ""} />
          </label>
          ${
            editing
              ? `<div class="field">
                  <span>当前排期周期（由 Bot 上报维护）</span>
                  <div class="code-box" style="padding:7px 10px;font-size:12px" id="edge-readonly-period">${escapeHtml(readonlyPeriodLabel)}</div>
                </div>`
              : `<label class="field">
                  <span>预期多久跑一次（超期告警依据）</span>
                  <select name="every" id="edge-every-select">
                    ${EDGE_EVERY_PRESETS.map(
                      (p) => `<option value="${escapeHtml(p.id)}" ${previewEvery === p.id ? "selected" : ""}>${escapeHtml(p.label)}</option>`
                    ).join("")}
                  </select>
                </label>`
          }
        </div>

        <div class="stack-sm" style="background:var(--surface-2);padding:12px;border-radius:8px">
          <div class="row-between">
            <span style="font-size:12px;font-weight:600">方式 A：给云端机器人（如 Grok Bot Routine）末尾加一句提示词</span>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-bot-snippet">复制这句话</button>
          </div>
          <div class="code-box" id="box-bot-snippet" style="max-height:90px">${escapeHtml(snippets.botPrompt)}</div>

          <div class="row-between" style="margin-top:6px">
            <span style="font-size:12px;font-weight:600">方式 B：给 Muse / 本地脚本包裹执行（完全不走大模型，0 Token）</span>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-cli-snippet">复制命令</button>
          </div>
          <div class="code-box" id="box-cli-snippet" style="max-height:70px">${escapeHtml(snippets.cliWrap)}</div>
        </div>

        <details class="adv-details" ${editing ? "open" : ""}>
          <summary>${editing ? "可选设置（备注说明 / 反向触发开关）" : "可选设置（提前手动建档到看板）"}</summary>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">
            <label class="field">
              <span>备注说明（选填）</span>
              <input type="text" name="summary" value="${escapeHtml(editing?.summary || "")}" placeholder="例如：每周续签 SideStore 与自用应用" />
            </label>
          </div>
          <div class="row-between" style="margin-top:10px;flex-wrap:wrap;gap:10px">
            <label class="row" style="font-size:12px;cursor:pointer">
              <input type="checkbox" name="triggerable" value="1" ${editing?.triggerable ? "checked" : ""} />
              <span>显示「立即运行」按钮（仅当该 Bot 同时监听中台待办收件箱时勾选）</span>
            </label>
            <button type="submit" class="btn btn-primary btn-sm" ${agents.length ? "" : "disabled"}>
              ${editing ? "保存设置" : "提前保存到看板"}
            </button>
          </div>
        </details>
      </form>
    </section>
  `;
}

function buildScheduleGroups(schedules, agentMap, filter, rawQuery) {
  const query = String(rawQuery || "").trim().toLowerCase();
  const filtered = schedules.filter((sch) => {
    if (filter === "abnormal" && !isAbnormal(sch)) return false;
    if (filter === "hub" && sch.driver !== "hub") return false;
    if (filter === "edge" && sch.driver === "hub") return false;
    if (filter === "paused" && sch.health !== "paused") return false;
    if (query) {
      const hay = `${sch.name} ${sch.id} ${sch.agent_name} ${sch.agent_id} ${sch.summary || ""}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  const groupMap = new Map();
  for (const sch of filtered) {
    let g = groupMap.get(sch.agent_id);
    if (!g) {
      const ag = agentMap.get(sch.agent_id);
      g = {
        agent_id: sch.agent_id,
        agent: ag,
        agent_name: ag?.name || sch.agent_name || sch.agent_id,
        online: Boolean(ag?.online),
        enabled: ag ? Boolean(ag.enabled) : true,
        source: ag ? agentSourceLabel(ag) : sch.agent_device_name || "独立 Agent",
        items: [],
        abnormal_count: 0,
      };
      groupMap.set(sch.agent_id, g);
    }
    if (isAbnormal(sch)) g.abnormal_count += 1;
    g.items.push(sch);
  }
  return [...groupMap.values()].sort((a, b) => b.abnormal_count - a.abnormal_count || a.agent_name.localeCompare(b.agent_name));
}

function renderScheduleGroupsHtml(groups, totalCount) {
  if (!groups.length) {
    return `<div class="empty-box">
      <div style="font-weight:600;margin-bottom:6px">${totalCount ? "当前筛选下暂无条目" : "还没有定时任务"}</div>
      <div style="font-size:12px;margin-bottom:14px">
        本机 CLI 可直接点下方创建定时派发；Grok Bot / Muse / Instinct 等外部自管定时任务点进去复制一句话即可自动上报状态。
      </div>
      ${!totalCount ? `<button type="button" class="btn btn-primary btn-sm" id="btn-empty-new-sch">+ 添加定时</button>` : ""}
    </div>`;
  }
  return `<div class="stack-md">
    ${groups
      .map(
        (g) => `
      <section class="card schedule-group" style="padding:0;overflow:hidden">
        <header class="schedule-group-head row-between">
          <div class="row" style="min-width:0;flex-wrap:wrap">
            <span class="dot ${!g.enabled ? "dot-paused" : g.online ? "dot-online" : "dot-offline"}"></span>
            <button type="button" class="btn btn-ghost btn-sm" style="padding:2px 6px;font-weight:700;font-size:14px;color:var(--text)" data-open-agent="${escapeHtml(g.agent_id)}">
              ${escapeHtml(g.agent_name)}
            </button>
            <span class="muted mono">${escapeHtml(g.agent_id)}</span>
            <span class="pill">${escapeHtml(g.source)}</span>
          </div>
          <div class="row">
            ${g.abnormal_count ? `<span class="pill pill-danger">${g.abnormal_count} 项异常</span>` : `<span class="pill pill-success">全正常</span>`}
            <span class="muted" style="font-size:12px">${g.items.length} 项</span>
          </div>
        </header>
        <div class="schedule-group-body">
          ${g.items.map(renderScheduleRow).join("")}
        </div>
      </section>
    `
      )
      .join("")}
  </div>`;
}

function bindScheduleListEvents(listRoot, schedules, container, refreshFn, syncListRegion) {
  if (!listRoot || typeof listRoot.querySelectorAll !== "function") return;

  listRoot.querySelector("#btn-empty-new-sch")?.addEventListener("click", () => {
    panelState = { ...panelState, open: true, editingKey: null };
    renderSchedulesView(container, refreshFn);
  });

  listRoot.querySelectorAll("[data-sch-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-sch-edit");
      const [aid, sid] = key.split(":::");
      const curSchedules = store.state?.schedules || schedules;
      const target = curSchedules.find((x) => x.agent_id === aid && x.id === sid);
      panelState = { ...panelState, open: true, editingKey: key, driver: target?.driver || "edge" };
      renderSchedulesView(container, refreshFn);
    });
  });

  listRoot.querySelectorAll("[data-open-agent]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setState({ selectedAgentId: btn.getAttribute("data-open-agent"), showSettingsDrawer: false });
    });
  });

  listRoot.querySelectorAll("[data-jump-thread]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setState({ activeTab: "threads", selectedThreadId: btn.getAttribute("data-jump-thread"), selectedThreadDetail: null });
    });
  });

  listRoot.querySelectorAll("[data-sch-run]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const [agentId, schId] = btn.getAttribute("data-sch-run").split(":::");
      const curSchedules = store.state?.schedules || schedules;
      const target = curSchedules.find((x) => x.agent_id === agentId && x.id === schId);
      if (!target) return;
      try {
        await api.triggerSchedule(agentId, schId);
        showToast(`已触发「${target.name}」`);
        await refreshFn();
        if (isSchedulePanelOpen()) syncListRegion?.();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  listRoot.querySelectorAll("[data-sch-toggle]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const [agentId, schId] = btn.getAttribute("data-sch-toggle").split(":::");
      const cur = btn.getAttribute("data-sch-enabled") === "1";
      const curSchedules = store.state?.schedules || schedules;
      const target = curSchedules.find((x) => x.agent_id === agentId && x.id === schId);
      if (!target) return;
      const isEdge = target.driver !== "hub";
      try {
        await api.upsertSchedule(agentId, schId, { enabled: !cur });
        showToast(cur ? (isEdge ? "已静默告警" : "已暂停") : (isEdge ? "已恢复告警" : "已启用"));
        await refreshFn();
        if (isSchedulePanelOpen()) syncListRegion?.();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  listRoot.querySelectorAll("[data-sch-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const [agentId, schId] = btn.getAttribute("data-sch-del").split(":::");
      if (!confirm(`确认移除「${schId}」吗？`)) return;
      try {
        await api.deleteSchedule(agentId, schId);
        showToast("已移除");
        await refreshFn();
        if (isSchedulePanelOpen()) syncListRegion?.();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}

export function renderSchedulesView(container, refreshFn) {
  const s = store.state;
  if (!s) return;

  const schedules = s.schedules || [];
  const agents = s.agents || [];
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const totalCount = schedules.length;
  const hubCount = schedules.filter((x) => x.driver === "hub").length;
  const edgeCount = totalCount - hubCount;
  const healthyCount = schedules.filter((x) => x.health === "healthy" || x.health === "running").length;
  const abnormalCount = schedules.filter((x) => isAbnormal(x)).length;
  const pausedOrIdleCount = schedules.filter((x) => x.health === "paused" || x.health === "idle").length;

  const filter = store.scheduleFilter || "all";
  const groups = buildScheduleGroups(schedules, agentMap, filter, store.scheduleSearch || "");

  container.innerHTML = `
    <section class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">全部定时</div>
        <div class="kpi-val">${totalCount} <span class="muted" style="font-size:13px">· ${hubCount} 中台派发 / ${edgeCount} 外部自管</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">运行正常</div>
        <div class="kpi-val" style="color:var(--success)">${healthyCount}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">异常 / 漏报</div>
        <div class="kpi-val" style="color:${abnormalCount ? "var(--danger)" : "var(--text)"}">${abnormalCount}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">已暂停 / 待运行</div>
        <div class="kpi-val">${pausedOrIdleCount}</div>
      </div>
    </section>

    <div class="section-header" style="margin-top:0">
      <div class="filter-bar">
        ${SCHEDULE_FILTERS.map(
          (item) => `
          <button class="filter-chip ${filter === item.id ? "active" : ""}" data-sch-filter="${item.id}">${item.label}</button>
        `
        ).join("")}
      </div>
      <div class="row" style="flex-wrap:wrap">
        <input type="text" id="sch-search-input" value="${escapeHtml(store.scheduleSearch || "")}" placeholder="搜索定时任务或 Bot..." style="width:200px" />
        <button type="button" class="btn btn-primary btn-sm" id="btn-toggle-new-sch">+ 添加定时</button>
      </div>
    </div>

    ${renderSchedulePanel(agents, schedules, s.hub_url)}

    <div id="schedules-list-region">
      ${renderScheduleGroupsHtml(groups, totalCount)}
    </div>
  `;

  const syncListRegion = () => {
    const listRegion = container.querySelector("#schedules-list-region");
    if (!listRegion) return;
    const curState = store.state || s;
    const curSchedules = curState.schedules || [];
    const curAgentMap = new Map((curState.agents || []).map((a) => [a.id, a]));
    const nextGroups = buildScheduleGroups(curSchedules, curAgentMap, store.scheduleFilter || "all", store.scheduleSearch || "");
    listRegion.innerHTML = renderScheduleGroupsHtml(nextGroups, curSchedules.length);
    bindScheduleListEvents(listRegion, curSchedules, container, refreshFn, syncListRegion);
  };

  container.querySelectorAll("[data-sch-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextFilter = btn.getAttribute("data-sch-filter");
      if (isSchedulePanelOpen()) {
        store.scheduleFilter = nextFilter;
        container.querySelectorAll("[data-sch-filter]").forEach((b) => {
          b.classList.toggle("active", b.getAttribute("data-sch-filter") === nextFilter);
        });
        syncListRegion();
      } else {
        setState({ scheduleFilter: nextFilter });
      }
    });
  });

  // 搜索仅局部重绘列表区域，确保正在填写的新建/编辑面板草稿绝不被清空
  const searchInput = container.querySelector("#sch-search-input");
  searchInput?.addEventListener("input", (e) => {
    store.scheduleSearch = e.target.value;
    syncListRegion();
  });

  container.querySelectorAll("[data-driver-switch]").forEach((btn) => {
    btn.addEventListener("click", () => {
      panelState = { ...panelState, open: true, editingKey: null, driver: btn.getAttribute("data-driver-switch") };
      renderSchedulesView(container, refreshFn);
    });
  });

  // 切换 Hub Cron 预设时原地更新输入框与显隐，绝不整块重绘导致用户已选 Agent 或已填提示词丢失
  const presetSelect = container.querySelector("#sch-cron-preset");
  const customCronWrap = container.querySelector("#sch-custom-cron-wrap");
  const cronExprInput = container.querySelector("#sch-cron-expr-input");
  presetSelect?.addEventListener("change", (e) => {
    const nextPreset = e.target.value;
    panelState.preset = nextPreset;
    if (nextPreset === "custom") {
      customCronWrap?.classList.remove("hidden");
      if (cronExprInput && HUB_CRON_PRESETS.some((p) => p.id !== "custom" && p.id === cronExprInput.value)) {
        cronExprInput.value = "";
      }
      cronExprInput?.focus?.();
    } else {
      customCronWrap?.classList.add("hidden");
      if (cronExprInput) cronExprInput.value = nextPreset;
    }
  });

  const refreshSnippetsInPlace = () => {
    const nameEl = container.querySelector("#edge-name-input");
    const idEl = container.querySelector("#edge-id-input");
    const everyEl = container.querySelector("#edge-every-select");
    panelState.edgeName = nameEl?.value || "";
    panelState.edgeId = idEl?.value || "";
    if (everyEl) panelState.edgeEvery = everyEl.value || "1d";
    const next = buildEdgeQuickSnippets({
      hubUrl: s.hub_url,
      schId: panelState.edgeId || slugifyScheduleId(panelState.edgeName || "ipad-sign", "ipad-sign"),
      schName: panelState.edgeName || "iPad应用续签",
      every: panelState.edgeEvery,
    });
    const botBox = container.querySelector("#box-bot-snippet");
    const cliBox = container.querySelector("#box-cli-snippet");
    if (botBox) botBox.textContent = next.botPrompt;
    if (cliBox) cliBox.textContent = next.cliWrap;
  };
  container.querySelector("#edge-name-input")?.addEventListener("input", refreshSnippetsInPlace);
  container.querySelector("#edge-id-input")?.addEventListener("input", refreshSnippetsInPlace);
  container.querySelector("#edge-every-select")?.addEventListener("change", refreshSnippetsInPlace);

  container.querySelector("#btn-copy-bot-snippet")?.addEventListener("click", () => {
    const txt = container.querySelector("#box-bot-snippet")?.textContent || "";
    copyText(txt, "已复制提示词，粘贴给你的 Bot 即可");
  });
  container.querySelector("#btn-copy-cli-snippet")?.addEventListener("click", () => {
    const txt = container.querySelector("#box-cli-snippet")?.textContent || "";
    copyText(txt, "已复制包装命令");
  });

  container.querySelector("#btn-toggle-new-sch")?.addEventListener("click", () => {
    panelState = { ...panelState, open: !panelState.open || Boolean(panelState.editingKey), editingKey: null };
    renderSchedulesView(container, refreshFn);
  });
  container.querySelector("#btn-close-new-sch")?.addEventListener("click", () => {
    panelState = { ...panelState, open: false, editingKey: null };
    renderSchedulesView(container, refreshFn);
  });

  container.querySelector("#form-create-schedule")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const formEl = e.currentTarget || e.target;
    const isEditingEdge = formEl.getAttribute?.("data-editing-edge") === "1";
    const fd = new FormData(formEl);
    const driver = String(fd.get("driver") || "hub");
    const agentId = String(fd.get("agent_id") || "").trim();
    const promptText = String(fd.get("prompt_text") || "").trim();
    const rawName = String(fd.get("name") || "").trim();
    const name = rawName || promptText.replace(/\s+/g, " ").slice(0, 22) || "定时任务";
    const rawId = String(fd.get("id") || "").trim();
    const schId = rawId || slugifyScheduleId(name, "job");

    const payload = {
      name,
      driver,
    };

    if (driver === "hub") {
      const cronExpr = String(fd.get("cron_expr") || "").trim();
      const timezone = String(fd.get("timezone") || resolveHubTimezone()).trim();
      const extraRaw = String(fd.get("extra_to") || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      const allTo = [...new Set([agentId, ...extraRaw])];
      payload.context_mode = String(fd.get("context_mode") || "per_run");
      payload.cron_expr = cronExpr;
      payload.timezone = timezone;
      payload.summary = promptText.slice(0, 240);
      payload.task_template = {
        to: allTo,
        title: `[定时] ${name}`,
        input_text: promptText,
      };
      payload.run = Boolean(fd.get("run"));
    } else {
      // 编辑既有外部自管条目时绝不提交 every，避免把 Bot 自报的排期覆盖回默认预设
      if (!isEditingEdge) {
        payload.every = String(fd.get("every") || panelState.edgeEvery || "1d");
      }
      if (fd.get("summary") !== null) {
        payload.summary = String(fd.get("summary") || "").trim();
      }
      payload.triggerable = Boolean(fd.get("triggerable"));
    }

    try {
      await api.upsertSchedule(agentId, schId, payload);
      panelState = { ...panelState, open: false, editingKey: null };
      showToast(driver === "hub" ? "定时任务已开启" : "已保存外部定时设置");
      await refreshFn();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  const initialListRegion = container.querySelector("#schedules-list-region");
  bindScheduleListEvents(
    initialListRegion && typeof initialListRegion.querySelectorAll === "function" ? initialListRegion : container,
    schedules,
    container,
    refreshFn,
    syncListRegion
  );
}
