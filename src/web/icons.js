// 控制台图标：品牌图标走 /icons/brands/*.svg 外链（<img> 隔离各自的渐变 id，可被浏览器缓存），
// 界面线性图标内联为 currentColor，跟随主题色。
import { escapeHtml } from "./utils.js";

// 单色品牌图标在 <img> 内 currentColor 恒为黑色，打标记便于样式单独处理
// 自带底板的应用图标需铺满头像，否则会在白底里缩成一个小方块
const FULL_BLEED_BRANDS = new Set(["codex", "doubao", "autoclaw", "todayai", "instinct", "factory", "aider"]);
// 无矢量源的品牌用 128px 位图，其余默认 .svg
const PNG_BRANDS = new Set(["autoclaw", "doubao", "awsquick", "todayai", "instinct", "factory", "aider"]);
const MONO_BRANDS = new Set(["opencode", "goose", "grok", "cursor", "githubcopilot", "cline", "kilocode", "apple", "linux"]);

// 本机 CLI Worker：按 platform 与 worker_key 识别（同名 key 指向 CLI 版本的图标）
const CLI_BRANDS = {
  "claude-code": "claudecode",
  claude: "claudecode",
  codex: "codex",
  opencode: "opencode",
  "gemini-cli": "geminicli",
  gemini: "geminicli",
  goose: "goose",
  amp: "amp",
  antigravity: "antigravity",
  agy: "antigravity",
  grok: "grok",
  cursor: "cursor",
  codebuddy: "codebuddy",
  copilot: "githubcopilot",
  "qwen-code": "qwen",
  qwen: "qwen",
  kimi: "kimi",
  kiro: "kiro",
  cline: "cline",
  kilo: "kilocode",
  vibe: "mistral",
  devin: "devin",
  openhands: "openhands",
  qoder: "qoder",
  aider: "aider",
  droid: "factory",
};

// 独立 / 云端 Agent：按平台模板 id 识别
const CLOUD_BRANDS = {
  gemini: "gemini",
  "grok-bot": "grok",
  doubao: "doubao",
  qwen: "qwen",
  workbuddy: "workbuddy",
  "amazon-quick": "awsquick",
  "aws-quick": "awsquick",
  awsquick: "awsquick",
  quick: "awsquick",
  today: "todayai",
  lingguang: "antgroup",
  muse: "muse",
  autoclaw: "autoclaw",
  todayai: "todayai",
  "today-ai": "todayai",
  instinct: "instinct",
};

// 暂无官方矢量图标的平台，用品牌色字母徽标兜底，保证视觉节奏一致
const MONOGRAMS = {
  auggie: { text: "A", bg: "#16A34A" },
  crush: { text: "C", bg: "#E0559B" },
  pi: { text: "π", bg: "#334155" },
  iflow: { text: "iF", bg: "#2563EB" },
};

const NAME_HINTS = [
  [/claude/i, "claudecode"],
  [/codex|openai|chatgpt/i, "codex"],
  [/gemini/i, "gemini"],
  [/copilot/i, "githubcopilot"],
  [/cursor/i, "cursor"],
  [/grok/i, "grok"],
  [/qwen|千问|通义/i, "qwen"],
  [/kimi/i, "kimi"],
  [/豆包|doubao/i, "doubao"],
  [/devin/i, "devin"],
  [/mistral/i, "mistral"],
  [/factory|droid/i, "factory"],
  [/aider/i, "aider"],
  [/autoclaw/i, "autoclaw"],
  [/amazon\s*quick|aws\s*quick|^quick$/i, "awsquick"],
  [/today[\s-]*ai/i, "todayai"],
  [/instinct/i, "instinct"],
];

const UI_ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M20.5 14.1A8.5 8.5 0 1 1 9.9 3.5a6.8 6.8 0 0 0 10.6 10.6Z"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "arrow-right": '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  bot: '<rect x="3" y="8" width="18" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3.5" r="1"/><path d="M9 13v2M15 13v2"/>',
  sparkles: '<path d="M12 3 13.9 8.1 19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M19 17v4M17 19h4"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  play: '<path d="M6 4l14 8-14 8Z"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  retry: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
};

export function listMappedBrands() {
  return new Set([
    ...Object.values(CLI_BRANDS),
    ...Object.values(CLOUD_BRANDS),
    ...NAME_HINTS.map(([, brand]) => brand),
    "apple",
    "windows",
    "linux",
  ]);
}

export function brandFile(brand) {
  return `${brand}.${PNG_BRANDS.has(brand) ? "png" : "svg"}`;
}

export function uiIcon(name, size = 14, extraClass = "") {
  const body = UI_ICONS[name];
  if (!body) return "";
  return `<svg class="ui-icon ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

function normKey(v) {
  return String(v || "").trim().toLowerCase();
}

export function resolveAgentBrand(agent = {}) {
  const platform = normKey(agent.platform);
  const workerKey = normKey(agent.worker_key);
  const isWorker = agent.kind === "device-worker";

  const brandTable = isWorker ? CLI_BRANDS : CLOUD_BRANDS;
  // 先看 id：灵光、Quick 等节点的 platform 是借用的 gemini / doubao，只有 id 才能区分
  const idKey = isWorker ? "" : normKey(agent.id);
  for (const key of [idKey, platform, workerKey]) {
    if (!key) continue;
    if (brandTable[key]) return { brand: brandTable[key] };
    if (MONOGRAMS[key]) return { mono: MONOGRAMS[key] };
  }
  for (const key of [platform, workerKey]) {
    if (key && CLI_BRANDS[key]) return { brand: CLI_BRANDS[key] };
  }
  const name = String(agent.name || "");
  for (const [re, brand] of NAME_HINTS) {
    if (re.test(name) || re.test(workerKey)) return { brand };
  }
  if (isWorker) return { glyph: "terminal" };
  return { glyph: agent.role === "leader" ? "sparkles" : "bot" };
}

export function resolveDeviceBrand(device = {}) {
  const p = `${normKey(device.platform)} ${normKey(device.os_info)}`;
  if (/darwin|mac/.test(p)) return { brand: "apple" };
  if (/win32|windows/.test(p)) return { brand: "windows" };
  if (/linux|ubuntu|debian|centos|fedora/.test(p)) return { brand: "linux" };
  return { glyph: "monitor" };
}

function statusDot(status) {
  if (!status) return "";
  const cls = status === "paused" ? "dot-paused" : status === "online" ? "dot-online" : "dot-offline";
  return `<span class="avatar-status ${cls}"></span>`;
}

function renderAvatar(resolved, { size = "md", status = "", title = "" } = {}) {
  const t = title ? ` title="${escapeHtml(title)}"` : "";
  if (resolved.brand) {
    const monoCls = (MONO_BRANDS.has(resolved.brand) ? " is-mono" : "") + (FULL_BLEED_BRANDS.has(resolved.brand) ? " is-full" : "");
    return `<span class="avatar avatar-${size}"${t}><img class="avatar-img${monoCls}" src="/icons/brands/${brandFile(resolved.brand)}" alt="" loading="lazy" decoding="async" draggable="false" />${statusDot(status)}</span>`;
  }
  if (resolved.mono) {
    return `<span class="avatar avatar-${size} avatar-monogram" style="--mono-bg:${resolved.mono.bg}"${t}><span class="avatar-letter">${escapeHtml(resolved.mono.text)}</span>${statusDot(status)}</span>`;
  }
  return `<span class="avatar avatar-${size} avatar-glyph"${t}>${uiIcon(resolved.glyph, size === "sm" ? 12 : size === "lg" ? 20 : 16)}${statusDot(status)}</span>`;
}

export function agentStatusOf(agent = {}) {
  if (!agent.enabled) return "paused";
  return agent.online ? "online" : "offline";
}

export function deviceStatusOf(device = {}) {
  if (!device.enabled) return "paused";
  return device.online ? "online" : "offline";
}

export function agentAvatar(agent, options = {}) {
  return renderAvatar(resolveAgentBrand(agent || {}), options);
}

export function deviceAvatar(device, options = {}) {
  return renderAvatar(resolveDeviceBrand(device || {}), options);
}
