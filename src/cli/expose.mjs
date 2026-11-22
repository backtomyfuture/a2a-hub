// 公网暴露助手（ah expose）：
// 1. tailscale：检查 Tailscale 状态、开启 443 HTTPS Funnel、自动回填 config.json.publicUrl，并强校验机主 Token；
// 2. cf <url>：绑定 Cloudflare Tunnel 公网域名并运行模拟 Bot 探针，捕获 Bot Fight Mode / WAF 质询拦截；
// 3. status / off：查看当前公网地址与可访问性，或一键关闭 Funnel 并移除 publicUrl。

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BROWSER_USER_AGENT,
  readEnvFile,
  readLiveHubUrl,
  resolveListenAddr,
  writeLockedAppEnvVars,
} from "../core/config.mjs";

const CF_REMEDIATION = [
  "检测到 Cloudflare WAF / Bot Fight Mode 拦截了无 Cookie 的 Agent 请求",
  "请前往 Cloudflare 控制台：",
  "  1) Security → Bots 关闭 Bot Fight Mode；",
  "  2) 或在 Security → WAF → Custom rules 新建规则：当 URI Path 以 /api/v1/ 或 /.well-known/ 开头时 Action 选择 Skip（跳过其余质询规则）。",
].join("\n");

function headerGet(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) ?? "");
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower) return String(v ?? "");
  }
  return "";
}

function looksLikeCloudflareChallenge({ status, contentType, headers, bodyText }) {
  const server = headerGet(headers, "server").toLowerCase();
  const cfMitigated = headerGet(headers, "cf-mitigated").toLowerCase();
  const cfRay = headerGet(headers, "cf-ray").trim();
  const text = String(bodyText ?? "");
  const isHtml = contentType.includes("text/html") || /<!doctype\s+html|<html[\s>]/i.test(text);
  const bodyHints = /Attention Required! \| Cloudflare|Just a moment\.\.\.|cf-browser-verification|error code:\s*1010/i.test(text);
  if (cfMitigated) return true;
  if (!(server.includes("cloudflare") || cfRay || bodyHints)) return false;
  return status === 403 || status === 503 || status === 429 || isHtml || bodyHints;
}

// 模拟无 Cookie 的云端 Agent 请求 /api/v1/health，用于探测公网网关是否可正常吐出 JSON 以及是否被 Cloudflare WAF/Bot 拦截。
export async function probePublicEndpoint(publicUrl, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  const base = String(publicUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) {
    return { ok: false, url: "", status: 0, cfBlocked: false, isHtml: false, error: "未配置 publicUrl", remediation: "" };
  }
  let targetUrl;
  try {
    targetUrl = new URL(`${base}/api/v1/health`).toString();
  } catch (e) {
    return { ok: false, url: base, status: 0, cfBlocked: false, isHtml: false, error: `publicUrl 非法：${e.message}`, remediation: "" };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(targetUrl, {
      method: "GET",
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Accept: "application/json",
      },
      redirect: "follow",
      signal: ac.signal,
    });
    const contentType = headerGet(res.headers, "content-type").toLowerCase();
    const bodyText = await res.text();
    const isHtml = contentType.includes("text/html") || /<!doctype\s+html|<html[\s>]/i.test(bodyText);
    const cfBlocked = looksLikeCloudflareChallenge({ status: res.status, contentType, headers: res.headers, bodyText });
    if (cfBlocked) {
      return {
        ok: false,
        url: base,
        status: res.status,
        cfBlocked: true,
        isHtml,
        hubNode: "",
        authRequired: false,
        error: `Cloudflare 质询拦截（HTTP ${res.status}）`,
        remediation: `${CF_REMEDIATION}（HTTP ${res.status}）`,
      };
    }

    let parsed = null;
    try { parsed = JSON.parse(bodyText); } catch { parsed = null; }
    if (!res.ok || !parsed || parsed.ok !== true) {
      return {
        ok: false,
        url: base,
        status: res.status,
        cfBlocked: false,
        isHtml,
        hubNode: "",
        authRequired: false,
        error: isHtml
          ? `公网地址返回了 HTML 而非 Hub API JSON（HTTP ${res.status}）`
          : `公网探针失败（HTTP ${res.status || "?"}）`,
        remediation: "",
      };
    }

    return {
      ok: true,
      url: base,
      status: res.status,
      cfBlocked: false,
      isHtml: false,
      hubNode: String(parsed.node ?? ""),
      authRequired: Boolean(parsed.authRequired),
      error: "",
      remediation: "",
    };
  } catch (e) {
    return {
      ok: false,
      url: base,
      status: 0,
      cfBlocked: false,
      isHtml: false,
      hubNode: "",
      authRequired: false,
      error: e?.name === "AbortError" ? `请求超时（>${timeoutMs}ms）` : (e?.message || String(e)),
      remediation: "",
    };
  } finally {
    clearTimeout(timer);
  }
}

function readNodeJson(configDir) {
  const cfgPath = path.join(configDir, "config.json");
  const legacyPath = path.join(configDir, "node.json");
  const file = fs.existsSync(cfgPath) ? cfgPath : legacyPath;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`无法读取 ${cfgPath}（请先运行 ah up 或 ah setup --mode hub）：${e.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${file} 根必须是 JSON 对象`);
  }
  return { file, raw };
}

function writeNodeJson(file, raw, configDir = path.dirname(file)) {
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  if (raw?.publicUrl) {
    writeLockedAppEnvVars(configDir, { AH_PUBLIC_URL: String(raw.publicUrl).replace(/\/+$/, "") });
  } else {
    writeLockedAppEnvVars(configDir, { AH_PUBLIC_URL: null });
  }
}

function resolveApiTokenFromConfig(configDir, raw, env = process.env) {
  if (raw?.apiToken && String(raw.apiToken).trim()) return String(raw.apiToken).trim();
  let kv = {};
  const appEnvPath = raw?.appEnv ? String(raw.appEnv).replace(/^~/, os.homedir()) : path.join(configDir, "app.env");
  try { kv = readEnvFile(appEnvPath); } catch {}
  return String(kv.AH_API_TOKEN ?? env.AH_API_TOKEN ?? "").trim();
}

function ensureExposeAuth(configDir, file, raw, { autoToken = false, env = process.env } = {}) {
  const existing = resolveApiTokenFromConfig(configDir, raw, env);
  if (existing) return { token: existing, generated: false };
  if (!autoToken) {
    throw new Error("拒绝无口令公网暴露：未配置机主 AH_API_TOKEN。请先在 app.env/config.json 配置 apiToken，或加上 --auto-token 自动生成强口令");
  }
  const generated = crypto.randomBytes(18).toString("base64url");
  const appEnvPath = writeLockedAppEnvVars(configDir, { AH_API_TOKEN: generated });
  raw.appEnv = appEnvPath;
  writeNodeJson(file, raw);
  return { token: generated, generated: true };
}

function parseTailscaleDnsName(statusJsonText) {
  let parsed;
  try {
    parsed = JSON.parse(String(statusJsonText ?? ""));
  } catch {
    throw new Error("tailscale status --json 输出无法解析");
  }
  const backend = String(parsed?.BackendState ?? "");
  if (backend && backend !== "Running") {
    throw new Error(`Tailscale 当前未登录或未启动（BackendState=${backend}），请先运行 tailscale up`);
  }
  const dnsName = String(parsed?.Self?.DNSName ?? "").trim().replace(/\.+$/, "");
  if (!dnsName) {
    throw new Error("未能从 tailscale status 获取本机 MagicDNS 域名，请在 Tailscale 管理台开启 MagicDNS 与 HTTPS Certificates");
  }
  return dnsName;
}

function normalizeExposeUrl(rawUrl) {
  const text = String(rawUrl ?? "").trim();
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new Error(`公网地址格式不合法：${text || "(空)"}（需为 https://...）`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`公网地址协议必须是 https:// 或 http://，收到：${u.protocol}`);
  }
  return u.toString().replace(/\/+$/, "");
}

function parseExposeArgs(argv) {
  const flags = {
    action: "",
    targetUrl: "",
    port: "",
    autoToken: false,
    help: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--auto-token" || a === "--yes" || a === "-y") flags.autoToken = true;
    else if (a === "--port") flags.port = String(argv[++i] ?? "").trim();
    else if (a.startsWith("--port=")) flags.port = a.slice("--port=".length).trim();
    else if (!a.startsWith("-")) rest.push(a);
  }
  const sub = String(rest[0] ?? "tailscale").trim().toLowerCase();
  flags.action = sub === "cloudflare" ? "cf" : sub;
  flags.targetUrl = rest[1] ?? "";
  return flags;
}

export function exposeHelpText() {
  return `用法：
  ah expose [tailscale] [--port <port>] [--auto-token] [--config <dir>]
      检查本机 Tailscale 状态并开启 443 HTTPS Funnel 映射，自动回填 config.json.publicUrl 并执行公网自检。
  ah expose cf <https://你的域名> [--auto-token] [--config <dir>]
      将 Cloudflare Tunnel 公网域名写入 config.json.publicUrl，并发起模拟 Agent 探针检测 Bot Fight Mode / WAF 拦截。
  ah expose status [--config <dir>]
      查看当前公网地址、Tailscale Funnel 状态与公网探针可达性。
  ah expose off [--config <dir>]
      关闭 Tailscale Funnel 并移除 config.json.publicUrl。`;
}

export async function runExpose(configDir, argv = [], deps = {}) {
  const execFn = deps.execFileSync ?? execFileSync;
  const fetchFn = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const errLog = deps.errLog ?? console.error;

  const flags = parseExposeArgs(argv);
  if (flags.help) {
    log(exposeHelpText());
    return 0;
  }

  let file;
  let raw;
  try {
    ({ file, raw } = readNodeJson(configDir));
  } catch (e) {
    errLog(`✗ ${e.message}`);
    return 1;
  }

  if (flags.action === "off") {
    try {
      execFn("tailscale", ["funnel", "--https=443", "off"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      log("✓ 已关闭 Tailscale 443 Funnel 映射");
    } catch {
      try {
        execFn("tailscale", ["funnel", "reset"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        log("✓ 已重置 Tailscale Funnel 配置");
      } catch {
        log("· 未执行 tailscale funnel 关闭（可能未启用或未安装 tailscale）");
      }
    }
    if (Object.hasOwn(raw, "publicUrl")) {
      delete raw.publicUrl;
      writeNodeJson(file, raw, configDir);
      log("✓ 已清空 config.json / app.env 的 publicUrl");
    } else {
      writeLockedAppEnvVars(configDir, { AH_PUBLIC_URL: null });
      log("· config.json 中原本没有配置 publicUrl");
    }
    return 0;
  }

  if (flags.action === "status") {
    const publicUrl = String(raw.publicUrl ?? env.AH_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
    const token = resolveApiTokenFromConfig(configDir, raw, env);
    log(`publicUrl: ${publicUrl || "(未配置)"}`);
    log(`apiToken: ${token ? "已配置（不显示明文）" : "未配置（公网暴露存在风险！）"}`);
    try {
      const tsOut = execFn("tailscale", ["funnel", "status"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (String(tsOut ?? "").trim()) log(`Tailscale Funnel:\n${String(tsOut).trim()}`);
    } catch { /* 无 tailscale 或未开启时忽略 */ }
    if (!publicUrl) return 0;
    const probe = await probePublicEndpoint(publicUrl, { fetchImpl: fetchFn });
    if (probe.ok) {
      log(`✓ 公网探针通过：${probe.url}/api/v1/health (node=${probe.hubNode || "-"}, authRequired=${probe.authRequired})`);
      return 0;
    }
    errLog(`✗ 公网探针失败：${probe.error}`);
    if (probe.remediation) errLog(probe.remediation);
    return 1;
  }

  if (flags.action === "cf") {
    if (!flags.targetUrl) {
      errLog("用法：ah expose cf <https://你的域名> [--auto-token]");
      return 2;
    }
    let publicUrl;
    try {
      publicUrl = normalizeExposeUrl(flags.targetUrl);
    } catch (e) {
      errLog(`✗ ${e.message}`);
      return 2;
    }
    let auth;
    try {
      auth = ensureExposeAuth(configDir, file, raw, { autoToken: flags.autoToken, env });
    } catch (e) {
      errLog(`✗ ${e.message}`);
      return 1;
    }
    if (auth.generated) log("✓ 已自动生成机主 AH_API_TOKEN 并写入 0600 app.env");
    raw.publicUrl = publicUrl;
    writeNodeJson(file, raw, configDir);
    log(`✓ 已将 config.json.publicUrl 更新为 ${publicUrl}`);
    const probe = await probePublicEndpoint(publicUrl, { fetchImpl: fetchFn });
    if (probe.ok) {
      log(`✓ Cloudflare 公网自检通过：Bot 探针访问 /api/v1/health 返回正常 JSON (authRequired=${probe.authRequired})`);
      log(`✓ 公网 Web 控制台：${publicUrl}/?token=${encodeURIComponent(auth.token)}`);
      return 0;
    }
    errLog(`✗ Cloudflare 公网自检未通过：${probe.error}`);
    if (probe.remediation) errLog(probe.remediation);
    else if (!readLiveHubUrl(configDir)) errLog("· 提示：请确认 Hub 守护进程（ah daemon）与 cloudflared 均已启动");
    return 1;
  }

  if (flags.action !== "tailscale") {
    errLog(`未知子命令：ah expose ${flags.action}\n\n${exposeHelpText()}`);
    return 2;
  }

  // 1) 强制校验机主口令，绝不无口令裸奔上公网
  let auth;
  try {
    auth = ensureExposeAuth(configDir, file, raw, { autoToken: flags.autoToken, env });
  } catch (e) {
    errLog(`✗ ${e.message}`);
    return 1;
  }
  if (auth.generated) log("✓ 已自动生成机主 AH_API_TOKEN 并写入 0600 app.env");

  // 2) 检查 Tailscale 状态并解析 MagicDNS 域名
  let tsStatusOut;
  try {
    tsStatusOut = execFn("tailscale", ["status", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    errLog(`✗ 调用 tailscale 失败（请确认已安装 Tailscale 并运行 tailscale up）：${e.message}`);
    return 1;
  }
  let dnsName;
  try {
    dnsName = parseTailscaleDnsName(tsStatusOut);
  } catch (e) {
    errLog(`✗ ${e.message}`);
    return 1;
  }

  // 3) 开启 Tailscale Funnel 443 -> 本地 Hub 监听端口
  const addr = resolveListenAddr(raw.listen ?? "0.0.0.0:8787");
  const portNum = flags.port ? Number(flags.port) : (addr.port || Number(env.PORT) || 8787);
  if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
    errLog(`✗ 端口非法：${flags.port || addr.port}`);
    return 2;
  }
  try {
    execFn("tailscale", ["funnel", "--bg", String(portNum)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const stderr = String(e?.stderr ?? "").trim();
    errLog(`✗ 开启 tailscale funnel --bg ${portNum} 失败：${stderr || e.message}`);
    errLog("  · 请在 Tailscale 管理台 DNS 页面启用 MagicDNS 与 HTTPS Certificates，并确保 Funnel 权限已在 ACL 放行。");
    return 1;
  }

  const publicUrl = `https://${dnsName}`;
  raw.publicUrl = publicUrl;
  writeNodeJson(file, raw, configDir);
  log(`✓ Tailscale Funnel 已开启：${publicUrl} -> 127.0.0.1:${portNum}`);
  log(`✓ 已自动回填 config.json.publicUrl = ${publicUrl}`);
  log(`✓ 公网 Web 控制台：${publicUrl}/?token=${encodeURIComponent(auth.token)}`);

  // 4) 若本机 Hub 守护进程已在运行，顺便做一次公网端到端探针；未运行时提示如何启动
  const probe = await probePublicEndpoint(publicUrl, { fetchImpl: fetchFn });
  if (probe.ok) {
    log(`✓ 公网端到端探针通过：${publicUrl}/api/v1/health (authRequired=${probe.authRequired})`);
    return 0;
  }
  if (probe.cfBlocked) {
    errLog(`✗ ${probe.error}`);
    errLog(probe.remediation);
    return 1;
  }
  log(`· 公网地址已就绪（当前本地 Hub 可能尚未启动：${probe.error}）。若 Hub 尚未运行，请执行：ah daemon --config ${configDir}`);
  return 0;
}
