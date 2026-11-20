// service —— 把守护进程注册为开机自启（M3）。
//   macOS：写 LaunchAgent 并 launchctl bootstrap（用户级，无需 sudo）
//   Linux：写 systemd 单元（支持 --user / --system / auto）并 restart + active 校验
//   Windows：写当前用户的任务计划程序任务（登录触发，无需管理员）
// --remove 反向卸载。

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn as defaultSpawn } from "node:child_process";

const defaultSleep = (ms) => new Promise((res) => setTimeout(res, ms));

function nodeNameOf(configDir, fsImpl = fs) {
  try {
    const raw = JSON.parse(fsImpl.readFileSync(path.join(configDir, "node.json"), "utf8"));
    return String(raw.node || "default").replace(/[^A-Za-z0-9_.-]/g, "-");
  } catch {
    return "default";
  }
}

// 自启名字带角色和节点名。两份配置如果节点名相同，后装的会覆盖先装的。
// 默认目录 ~/.a2a-hub 用稳定名字；macOS/Windows 其它目录在名字后加配置路径 sha256 前 8 位，避免互相覆盖。
export function isDefaultHubConfigDir(configDir, homeDir = os.homedir()) {
  return path.resolve(configDir) === path.resolve(homeDir, ".a2a-hub");
}

export function configDirTag(configDir) {
  return crypto.createHash("sha256").update(path.resolve(configDir)).digest("hex").slice(0, 8);
}

export function launchdLabel(role, node) {
  return `ah-${role}.${node}`;
}

// 2B 统一 Linux systemd 短命名：hub 用 ah-hub-<node>.service，其余角色统一为 ah-<node>.service。
export function systemdUnitName(role, node) {
  return role === "hub" ? `ah-hub-${node}.service` : `ah-${node}.service`;
}

function escapeRegExp(s) {
  return String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textContainsConfigPath(raw, target) {
  if (!target) return false;
  let idx = raw.indexOf(target);
  while (idx !== -1) {
    const next = raw[idx + target.length];
    // 边界检查防止 ~/.a2a-hub 误匹配 ~/.a2a-hub-muse
    if (!next || /[\s"'<>\\/]/.test(next)) return true;
    idx = raw.indexOf(target, idx + 1);
  }
  return false;
}

// plist / unit 正文里带有 --config 的目录时，说明这个历史名字已经属于本次安装。
export function unitTextTargetsConfig(text, configDir) {
  const raw = String(text ?? "");
  if (!raw || !configDir) return false;
  const resolved = path.resolve(configDir);
  return textContainsConfigPath(raw, resolved) || textContainsConfigPath(raw, configDir);
}

export function selectAutostartName({
  role,
  node,
  configDir,
  homeDir = os.homedir(),
  kind = "launchd",
  name = "",
}) {
  const rawName = String(name ?? "").trim();
  if (rawName) {
    const sanitized = rawName.replace(/[^A-Za-z0-9_.@-]/g, "-");
    if (kind === "systemd") {
      return sanitized.endsWith(".service") ? sanitized : `${sanitized}.service`;
    }
    return sanitized;
  }
  if (kind === "systemd") {
    return systemdUnitName(role, node);
  }
  const tag = configDir && !isDefaultHubConfigDir(configDir, homeDir) ? configDirTag(configDir) : "";
  if (kind === "task") {
    return tag ? `ah-${role}-${node}-${tag}` : `ah-${role}-${node}`;
  }
  return tag ? `ah-${role}.${node}.${tag}` : launchdLabel(role, node);
}

// 扫描旧命名单元（ah-node-<node>.service 或带 8 位 hash 的历史单元），只选指向同一 configDir 的文件以便升级清理。
export function findLegacySystemdUnits({
  dir,
  role = "node",
  node,
  configDir,
  currentUnit = "",
  fsImpl = fs,
}) {
  if (!dir || !node || !configDir) return [];
  let entries;
  try {
    entries = fsImpl.readdirSync(dir);
  } catch {
    return [];
  }
  const escNode = escapeRegExp(node);
  const legacyRe = role === "hub"
    ? new RegExp(`^ah-hub-${escNode}-[0-9a-f]{8}\\.service$`)
    : new RegExp(`^ah-node-${escNode}(?:-[0-9a-f]{8})?\\.service$`);
  const found = [];
  for (const entry of entries) {
    const file = typeof entry === "string" ? entry : entry?.name;
    if (!file || file === currentUnit) continue;
    if (!legacyRe.test(file)) continue;
    try {
      const text = fsImpl.readFileSync(path.join(dir, file), "utf8");
      if (unitTextTargetsConfig(text, configDir)) {
        found.push(file);
      }
    } catch {
      // 跳过不可读条目或目录
    }
  }
  return found.sort();
}

function roleOf(configDir, opts = {}, fsImpl = fs) {
  if (opts?.role === "node" || opts?.role === "hub") return opts.role;
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--role") {
      const v = process.argv[i + 1];
      if (v === "node" || v === "hub") return v;
    } else if (a.startsWith("--role=")) {
      const v = a.slice("--role=".length);
      if (v === "node" || v === "hub") return v;
    }
  }
  try {
    const raw = JSON.parse(fsImpl.readFileSync(path.join(configDir, "node.json"), "utf8"));
    if (raw.role === "hub" || raw.role === "node") return raw.role;
  } catch {}
  return "node";
}

function parseServiceCliOverrides(opts = {}) {
  let scope = opts.scope;
  let name = opts.name;
  let ensure = opts.ensure;
  let remove = opts.remove;
  let uninstall = opts.uninstall;
  // 仅当由 ah service CLI 直接调用且未显式传入时，从 argv 补读 --system/--user/--name/--ensure，避免影响测试框架参数。
  const isAhServiceCli = path.basename(process.argv[1] || "") === "ah.mjs" && process.argv[2] === "service";
  if (isAhServiceCli) {
    const argv = process.argv.slice(3);
    if (scope === undefined) {
      const hasSystem = argv.includes("--system");
      const hasUser = argv.includes("--user");
      if (hasSystem && hasUser) {
        return { error: "不能同时指定 --system 与 --user" };
      }
      if (hasSystem) scope = "system";
      else if (hasUser) scope = "user";
    }
    if (name === undefined) {
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--name") name = argv[i + 1] ?? "";
        else if (argv[i].startsWith("--name=")) name = argv[i].slice("--name=".length);
      }
    }
    if (ensure === undefined) ensure = argv.includes("--ensure");
    if (remove === undefined) remove = argv.includes("--remove");
    if (uninstall === undefined) uninstall = argv.includes("--uninstall");
  }
  return {
    scope: scope ?? "auto",
    name: name ?? "",
    ensure: Boolean(ensure),
    remove: Boolean(remove),
    uninstall: Boolean(uninstall),
  };
}

const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

const PROXY_TRIGGER_KEYS = new Set([
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
]);

// 收集需要继承给后台服务的环境（PATH/HOME/代理）；存在 *_PROXY 时自动补 NODE_USE_ENV_PROXY=1，否则 Node 24 fetch 不走代理。
export function collectServiceEnv(env = process.env, { includePath = false, pathValue = "", home = "" } = {}) {
  const out = {};
  if (home) {
    out.HOME = String(home);
  }
  if (includePath) {
    const p = pathValue || env?.PATH || "";
    if (p) out.PATH = String(p);
  }
  let hasProxy = false;
  for (const k of PROXY_ENV_KEYS) {
    const raw = env?.[k];
    if (raw == null) continue;
    const v = String(raw);
    if (!v) continue;
    out[k] = v;
    if (PROXY_TRIGGER_KEYS.has(k)) hasProxy = true;
  }
  if (hasProxy) {
    out.NODE_USE_ENV_PROXY = "1";
  }
  return out;
}

function formatEnvValue(val) {
  // 剔除换行防止代理变量向 systemd EnvironmentFile 注入额外指令行。
  const clean = String(val ?? "").replace(/[\r\n]+/g, "");
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(clean)) {
    return clean;
  }
  return '"' + clean.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}

function renderServiceEnv(envObj) {
  const lines = [];
  for (const [k, v] of Object.entries(envObj || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    if (v == null || v === "") continue;
    lines.push(`${k}=${formatEnvValue(v)}`);
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

// 仅对 HTTPS_PROXY|HTTP_PROXY 做 sha256 指纹，供 --ensure 判定代理配置是否变化（不落明文到日志）。
export function computeProxyFingerprint(env = process.env) {
  const cleanHttps = String(env?.HTTPS_PROXY || env?.https_proxy || "").replace(/[\r\n]+/g, "");
  const cleanHttp = String(env?.HTTP_PROXY || env?.http_proxy || "").replace(/[\r\n]+/g, "");
  return crypto.createHash("sha256").update(`${cleanHttps}|${cleanHttp}`).digest("hex");
}

function parseServiceEnvFile(configDir, fsImpl = fs) {
  const envPath = path.join(configDir, "service.env");
  try {
    const raw = fsImpl.readFileSync(envPath, "utf8");
    const map = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const k = trimmed.slice(0, eq).trim();
      let v = trimmed.slice(eq + 1);
      if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
        v = v.slice(1, -1).replace(/\\(.)/g, "$1");
      }
      map[k] = v;
    }
    return map;
  } catch {
    return null;
  }
}

function defaultIsPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

function defaultReadProcessCmdline(pid, { platform = process.platform, fsImpl = fs, exec = execFileSync } = {}) {
  if (platform === "linux") {
    try {
      const raw = fsImpl.readFileSync(`/proc/${pid}/cmdline`);
      const text = String(raw).replace(/\0+/g, " ").trim();
      if (text) return text;
    } catch {
      // 无 /proc 时回退 ps
    }
  }
  if (platform === "win32") {
    const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    try {
      return String(exec(ps, [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) ?? "").trim();
    } catch {
      return "";
    }
  }
  try {
    return String(exec("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }) ?? "").trim();
  } catch {
    return "";
  }
}

function readDaemonLockPid(configDir, fsImpl = fs) {
  try {
    const pid = Number(fsImpl.readFileSync(path.join(configDir, "daemon.lock"), "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isSystemdUnitActiveNow(unit, isUser, exec) {
  const args = isUser ? ["--user", "is-active", unit] : ["is-active", unit];
  try {
    const out = String(exec("systemctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) ?? "").trim();
    return out === "active";
  } catch {
    return false;
  }
}

// 重建或收敛切换模式前，先安全终止残留的直启 daemon（仅限 cmdline 确认为 ah.mjs daemon 的进程），避免抢占 daemon.lock。
async function stopStandaloneDaemonIfAlive({ configDir, fsImpl, isPidAlive, readProcessCmdline, killFn, sleep }) {
  const pid = readDaemonLockPid(configDir, fsImpl);
  if (!pid || !isPidAlive(pid)) return;
  const cmdline = readProcessCmdline(pid);
  if (!isAhDaemonCommandLine(cmdline)) return;
  try { killFn(pid, "SIGTERM"); } catch { return; }
  for (let elapsed = 0; elapsed < 3000; elapsed += 200) {
    await sleep(200);
    if (!isPidAlive(pid)) break;
  }
  if (isPidAlive(pid)) {
    try { killFn(pid, "SIGKILL"); } catch {}
    await sleep(200);
  }
  if (!isPidAlive(pid)) {
    try {
      if (readDaemonLockPid(configDir, fsImpl) === pid) {
        fsImpl.unlinkSync(path.join(configDir, "daemon.lock"));
      }
    } catch {}
  }
}

async function spawnEnsureDaemon({
  configDir,
  appBin,
  env,
  homeDir,
  currentFingerprint,
  execPath,
  fsImpl,
  spawnFn,
  isPidAlive,
  sleep,
}) {
  // 启动前把当前代理指纹与已选模式写入 0600 service.env，供后续 --ensure 比对。
  const envObj = {
    ...collectServiceEnv(env, { includePath: true, home: homeDir }),
    NODE_USE_ENV_PROXY: "1",
    AH_PROXY_FINGERPRINT: currentFingerprint,
    AH_SERVICE_MODE: "spawn",
  };
  writeServiceEnvFile(configDir, envObj, fsImpl);

  let child;
  try {
    child = spawnFn(execPath, [appBin, "daemon", "--config", configDir], {
      detached: true,
      stdio: "ignore",
      env: { ...env, NODE_USE_ENV_PROXY: "1" },
    });
    if (typeof child?.unref === "function") child.unref();
  } catch (e) {
    return { ok: false, error: `spawn 启动失败：${e?.message || e}` };
  }

  const pid = child?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { ok: false, error: "spawn 未返回有效进程 PID" };
  }

  let exited = false;
  let exitErr = "";
  if (typeof child.once === "function") {
    child.once("exit", (code, sig) => {
      exited = true;
      exitErr = `进程提前退出（code=${code ?? "null"}, signal=${sig ?? "null"}）`;
    });
    child.once("error", (err) => {
      exited = true;
      exitErr = err?.message || String(err);
    });
  }

  const maxWaitMs = 10000;
  const intervalMs = 500;
  let elapsed = 0;
  await sleep(intervalMs);
  elapsed += intervalMs;

  while (true) {
    if (exited) {
      return { ok: false, error: exitErr || "守护进程启动后即退出" };
    }
    if (!isPidAlive(pid)) {
      return { ok: false, error: `守护进程（pid=${pid}）未能保持存活` };
    }
    if (readDaemonLockPid(configDir, fsImpl) === pid) {
      return { ok: true, pid };
    }
    if (elapsed >= maxWaitMs) {
      return { ok: true, pid };
    }
    await sleep(intervalMs);
    elapsed += intervalMs;
  }
}

function writeServiceEnvFile(configDir, envObj, fsImpl = fs) {
  const envPath = path.join(configDir, "service.env");
  const tmpPath = path.join(configDir, `.service.env.${process.pid}.${Date.now()}.tmp`);
  const content = renderServiceEnv(envObj);
  fsImpl.mkdirSync(configDir, { recursive: true });
  try {
    fsImpl.writeFileSync(tmpPath, content, { mode: 0o600 });
    fsImpl.chmodSync(tmpPath, 0o600);
    fsImpl.renameSync(tmpPath, envPath);
  } catch (e) {
    try { fsImpl.unlinkSync(tmpPath); } catch {}
    throw e;
  }
  return envPath;
}

function xmlEscape(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// systemd 按空白切 ExecStart。配置目录含空格时若不引用，--role 会被吃进路径，
// 守护进程看不到角色参数，退回默认 node，等于把 hub 覆盖成 node。
function systemdArg(value) {
  return '"' + String(value ?? "").replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}

function runWith(execFn, cmd, args, { ignore = false } = {}) {
  try {
    return execFn(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (ignore) return "";
    throw new Error(`${cmd} ${args.join(" ")} 失败：${(e.stderr || e.message || "").toString().slice(0, 300)}`);
  }
}

function launchctlPrintOk(execFn, uid, label) {
  try {
    execFn("launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

// bootout 是异步卸载：旧守护进程收到 SIGTERM 后还要逐个把节点能力标记为离线（涉及网络请求），
// 实测要数秒才完全退出；退出前 bootstrap 会报 5: Input/output error，服务就停在已卸载状态。
// 这里轮询 launchctl print 直到它抛错（服务已完全卸载）才放行；超时不抛错、只报告未确认，
// 因为旧进程可能已死但 launchd 的 print 缓存未清，继续尝试 bootstrap 才是正确动作。
export async function awaitLaunchdUnload(
  execFn,
  uid,
  label,
  { timeoutMs = 30000, intervalMs = 500, sleep = defaultSleep, now = () => Date.now() } = {},
) {
  const startedAt = now();
  for (;;) {
    if (!launchctlPrintOk(execFn, uid, label)) {
      return { unloaded: true, elapsedMs: now() - startedAt };
    }
    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) return { unloaded: false, elapsedMs };
    await sleep(intervalMs);
  }
}

// bootstrap 成功后 launchd 的装载也是异步的，立刻 print 可能还看不到服务。
// 这里轮询 print 确认服务真的可见（最多 10 秒）再算安装成功；
// bootstrap 本身抛错则不重试——前面已经等过卸载，此时失败不是竞态，直接上抛让调用方处置。
export async function bootstrapAndVerify(
  execFn,
  uid,
  label,
  plistPath,
  { timeoutMs = 10000, intervalMs = 500, sleep = defaultSleep, now = () => Date.now() } = {},
) {
  runWith(execFn, "launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
  const startedAt = now();
  for (;;) {
    if (launchctlPrintOk(execFn, uid, label)) return;
    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new Error(`launchctl bootstrap 已提交，但 ${timeoutMs}ms 内 print 未确认服务 ${label} 已装载`);
    }
    await sleep(intervalMs);
  }
}

export async function checkSystemdActive(
  unit,
  isUser = true,
  { execFileSync: exec = execFileSync, sleep = defaultSleep } = {},
) {
  const args = isUser ? ["--user", "is-active", unit] : ["is-active", unit];
  const maxWaitMs = 3000;
  const intervalMs = 500;
  let elapsed = 0;
  let lastStatus = "";

  // Type=simple 在 restart 后会瞬间报 active；先短暂沉降，防止启动即崩（配置/tokenFile 错）误判成功。
  await sleep(800);

  while (true) {
    let out = "";
    try {
      out = String(exec("systemctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) ?? "").trim();
    } catch (e) {
      const stdout = e?.stdout && String(e.stdout).trim() ? e.stdout : "";
      out = String(stdout || e?.stderr || "").trim();
    }
    lastStatus = out;
    if (out === "active") {
      return { ok: true, status: "active" };
    }
    // systemd 刚 restart 时可能短暂处于 activating，短等重试到明确 active 才放行。
    if (out === "activating" && elapsed < maxWaitMs) {
      await sleep(intervalMs);
      elapsed += intervalMs;
      continue;
    }
    break;
  }

  let detail = "";
  try {
    const statusArgs = isUser ? ["--user", "status", unit, "-n", "10", "--no-pager"] : ["status", unit, "-n", "10", "--no-pager"];
    detail = String(exec("systemctl", statusArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) ?? "").trim();
  } catch (err) {
    detail = String(err?.stdout || err?.stderr || err?.message || "").trim();
  }
  return { ok: false, status: lastStatus || "failed", detail };
}

export function renderPlist({ label, appBin, configDir, role, logPath }) {
  const envEntries = [];
  const defaultPath = `${path.dirname(process.execPath)}:${path.join(os.homedir(), ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  const pathVal = process.env.PATH ? `${process.env.PATH}:${defaultPath}` : defaultPath;
  const uniquePath = [...new Set(pathVal.split(":").filter(Boolean))].join(":");
  envEntries.push(`<key>PATH</key><string>${xmlEscape(uniquePath)}</string>`);

  const collected = collectServiceEnv(process.env);
  for (const [k, v] of Object.entries(collected)) {
    envEntries.push(`<key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xmlEscape(label)}</string>
<key>ProgramArguments</key><array>
<string>${xmlEscape(process.execPath)}</string>
<string>${xmlEscape(appBin)}</string>
<string>daemon</string>
<string>--config</string>
<string>${xmlEscape(configDir)}</string>
<string>--role</string>
<string>${xmlEscape(role)}</string>
</array>
<key>WorkingDirectory</key><string>${xmlEscape(configDir)}</string>
<key>EnvironmentVariables</key><dict>
${envEntries.join("\n")}
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
<key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict></plist>
`;
}

// 凭据和代理通过 EnvironmentFile 引用 0600 service.env，unit 正文绝不落任何敏感明文。
export function renderSystemdUnit({
  role,
  node,
  appBin,
  configDir,
  isSystem = false,
  user = "",
  home = "",
  nodeExec = process.execPath,
  envFile = path.join(configDir, "service.env"),
}) {
  void home;
  const serviceLines = [];
  if (isSystem && user) {
    serviceLines.push(`User=${user}`);
  }
  if (envFile) {
    // systemd EnvironmentFile= 按原路径读取且不剥离 - 后的引号；带引号会被当成相对路径而静默跳过。
    const cleanEnvFile = String(envFile).replace(/[\r\n]+/g, "");
    serviceLines.push(`EnvironmentFile=-${cleanEnvFile}`);
  }
  serviceLines.push(
    `ExecStart=${systemdArg(nodeExec)} ${systemdArg(appBin)} daemon --config ${systemdArg(configDir)} --role ${systemdArg(role)}`,
    `WorkingDirectory=${configDir}`,
    `Restart=always`,
    `RestartSec=5`,
  );

  return `[Unit]
Description=a2a-hub daemon (${role}: ${node})
After=network-online.target

[Service]
${serviceLines.join("\n")}

[Install]
WantedBy=${isSystem ? "multi-user.target" : "default.target"}
`;
}

// 任务名按角色分开：同一配置目录可以各挂一个 node 与 hub。
export function windowsTaskName(role, node, configDir, homeDir = os.homedir()) {
  return selectAutostartName({ role, node, configDir, homeDir, kind: "task" });
}

// 登记当时的 PATH 写进启动器。登录后的计划任务拿不到「当时这个终端」的 PATH，
// 不写进去，node 和 ah 这类用户目录里的命令会找不到。
export function windowsServicePath(configDir, currentPath, execPath) {
  // 用 win32 规则切路径：这个函数的入参是 Windows 路径，测试和 CI 跑在 macOS / Linux 上。
  const extra = [path.win32.dirname(execPath), path.win32.join(configDir, "bin")];
  const cur = String(currentPath || "").split(";").filter(Boolean);
  return [...new Set([...extra, ...cur])].join(";");
}

export function windowsLauncherPath(configDir, role, node) {
  return path.join(configDir, "service", `ah-${role}.${node}.mjs`);
}

export function windowsStarterPath(configDir, role, node) {
  return path.join(configDir, "service", `ah-${role}.${node}.vbs`);
}

// 计划任务直接跑 node.exe 会弹出控制台。wscript 是窗口程序，用窗口样式 0 把 node 藏起来，
// 并等它退出，好把退出码交回任务计划程序（非 0 才按 RestartOnFailure 拉起）。
export function renderWindowsStarter({ nodeExe, launcher }) {
  const command = `"${nodeExe}" "${launcher}"`.replaceAll('"', '""');
  return `Set sh = CreateObject("Wscript.Shell")\r\nWScript.Quit sh.Run("${command}", 0, True)\r\n`;
}

// 启动器停在前台：自己负责环境变量和 daemon.log。计划任务结束时，作业对象会连带结束子进程。
export function renderWindowsLauncher(spec) {
  const payload = JSON.stringify(spec);
  return `// 由 ah service 生成。任务计划程序经 vbs 拉起本文件，本文件再拉起守护进程。
import { spawn } from "node:child_process";
import fs from "node:fs";
const spec = ${payload};
const outFd = fs.openSync(spec.logPath, "a");
const errFd = fs.openSync(spec.logPath, "a");
const child = spawn(spec.node, [spec.appBin, "daemon", "--config", spec.configDir, "--role", spec.role], {
  cwd: spec.configDir,
  env: { ...process.env, ...spec.env },
  stdio: ["ignore", outFd, errFd],
  windowsHide: true,
});
const stop = () => { try { child.kill(); } catch { /* 子进程已退出 */ } };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("error", (err) => {
  try { fs.writeSync(errFd, String(err && err.message || err) + "\\n"); } catch { /* 日志写不了也要退出，好让计划任务重拉 */ }
  process.exit(1);
});
child.on("exit", (code) => { process.exit(code == null ? 1 : code); });
`;
}

export function renderWindowsTaskXml({ starter, configDir, role, node, userId, wscript }) {
  const userLine = userId ? `\n      <UserId>${xmlEscape(userId)}</UserId>` : "";
  const args = `//B //Nologo "${starter}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(`a2a-hub daemon (${role}: ${node})`)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>${userLine}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT5S</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(wscript)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(configDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

// schtasks /XML 认 UTF-16 LE。带 BOM，避免它把声明当成别的编码。
export function windowsTaskXmlBuffer(xml) {
  return Buffer.from(`\ufeff${xml}`, "utf16le");
}

function windowsUserId() {
  try {
    return execFileSync("whoami", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

function nodeBinary() {
  try { return fs.realpathSync(process.execPath); }
  catch { return process.execPath; }
}

// 只认本仓库守护进程的命令行，避免锁文件里的 pid 被系统复用后误杀别的进程。
export function isAhDaemonCommandLine(text) {
  // 子命令必须紧跟 ah.mjs。路径里碰巧有 daemon 字样不能算。
  return /(?:^|[\\/"'\s])ah\.mjs["']?\s+daemon\b/.test(String(text ?? ""));
}

// 计划任务结束时，子进程有时不会跟着退出。锁里若仍是本次 ah daemon，就结束它，
// 否则重新注册会因为「daemon 已在运行」起不来。
function stopLockedDaemon(configDir) {
  let pid;
  try {
    pid = Number(fs.readFileSync(path.join(configDir, "daemon.lock"), "utf8").trim());
  } catch {
    return;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let commandLine = "";
  try {
    commandLine = execFileSync(ps, [
      "-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return;
  }
  if (!isAhDaemonCommandLine(commandLine)) return;
  runWith(execFileSync, "taskkill", ["/PID", String(pid), "/F"], { ignore: true });
}

// 先停用再结束再删除：进程自己退出（非 0）会触发重启，卸载时不能让它马上被拉起来。
async function stopWindowsTask(taskName) {
  runWith(execFileSync, "schtasks", ["/Change", "/TN", taskName, "/DISABLE"], { ignore: true });
  const ended = runWith(execFileSync, "schtasks", ["/End", "/TN", taskName], { ignore: true });
  runWith(execFileSync, "schtasks", ["/Delete", "/F", "/TN", taskName], { ignore: true });
  if (ended.trim()) await new Promise((resolve) => setTimeout(resolve, 400));
}

function removeFile(file, fsImpl = fs) {
  if (fsImpl.existsSync(file)) fsImpl.unlinkSync(file);
}

async function registerWindowsService({ configDir, role, node, appBin, logPath, remove, name = "" }) {
  const taskName = selectAutostartName({ role, node, configDir, kind: "task", name });
  const launcher = windowsLauncherPath(configDir, role, node);
  const starter = windowsStarterPath(configDir, role, node);

  if (remove) {
    await stopWindowsTask(taskName);
    stopLockedDaemon(configDir);
    for (const file of [launcher, starter]) removeFile(file);
    console.log(`已卸载自启：${taskName}`);
    return 0;
  }

  await stopWindowsTask(taskName);
  stopLockedDaemon(configDir);

  const nodeExe = nodeBinary();
  const env = {
    PATH: windowsServicePath(configDir, process.env.PATH, nodeExe),
    ...collectServiceEnv(process.env),
  };
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, renderWindowsLauncher({
    node: nodeExe,
    appBin,
    configDir,
    role,
    logPath,
    env,
  }));
  fs.writeFileSync(starter, Buffer.from(`\ufeff${renderWindowsStarter({ nodeExe, launcher })}`, "utf16le"));

  const wscript = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
  const xml = renderWindowsTaskXml({
    starter,
    configDir,
    role,
    node,
    userId: windowsUserId(),
    wscript,
  });
  const xmlPath = path.join(os.tmpdir(), `ah-task-${process.pid}-${role}-${node}.xml`);
  try {
    fs.writeFileSync(xmlPath, windowsTaskXmlBuffer(xml));
    runWith(execFileSync, "schtasks", ["/Create", "/F", "/TN", taskName, "/XML", xmlPath]);
  } finally {
    try { fs.unlinkSync(xmlPath); } catch { /* 临时 XML 删不掉不影响任务 */ }
  }
  runWith(execFileSync, "schtasks", ["/Run", "/TN", taskName]);
  console.log(`自启已安装并启动：${taskName}（role: ${role}）`);
  console.log(`  任务：任务计划程序库 ${taskName}`);
  console.log(`  启动器：${launcher}`);
  console.log(`  日志：${logPath}`);
  console.log(`  卸载：ah service --remove --role ${role} --config ${configDir}`);
  return 0;
}

function isNoSystemdError(err) {
  if (!err) return false;
  if (err.code === "ENOENT") return true;
  const msg = `${err.stderr ?? ""} ${err.message ?? ""}`;
  return /System has not been booted with systemd|not been booted with systemd|Failed to connect to bus|No such file or directory/i.test(msg);
}

function cleanupLegacyUnitsInDir({ dir, role, node, configDir, currentUnit, isUser, isRoot, exec, fsImpl }) {
  const legacyUnits = findLegacySystemdUnits({ dir, role, node, configDir, currentUnit, fsImpl });
  for (const oldUnit of legacyUnits) {
    const oldPath = path.join(dir, oldUnit);
    if (isUser) {
      runWith(exec, "systemctl", ["--user", "disable", "--now", oldUnit], { ignore: true });
      try { removeFile(oldPath, fsImpl); } catch {}
    } else if (isRoot) {
      runWith(exec, "systemctl", ["disable", "--now", oldUnit], { ignore: true });
      try { removeFile(oldPath, fsImpl); } catch {}
    } else {
      try { exec("sudo", ["systemctl", "disable", "--now", oldUnit], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch {}
      try { exec("sudo", ["rm", "-f", oldPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch {}
    }
  }
}

export async function service(
  configDir,
  { remove = false, ensure = false, uninstall = false, role: explicitRole, scope: explicitScope, name: explicitName } = {},
  appDir,
  _deps = {},
) {
  const exec = _deps.execFileSync ?? execFileSync;
  const spawnFn = _deps.spawn ?? defaultSpawn;
  const platform = _deps.platform ?? process.platform;
  const getuid = _deps.getuid ?? (() => (typeof process.getuid === "function" ? process.getuid() : -1));
  const homedirFn = _deps.homedir ?? (() => os.homedir());
  const userInfoFn = _deps.userInfo ?? (() => os.userInfo());
  const sleep = _deps.sleep ?? defaultSleep;
  const now = _deps.now ?? (() => Date.now());
  const env = _deps.env ?? process.env;
  const fsImpl = _deps.fsImpl ?? fs;
  const systemUnitDir = _deps.systemUnitDir ?? "/etc/systemd/system";
  const execPath = _deps.execPath ?? process.execPath;
  const isPidAlive = _deps.isPidAlive ?? defaultIsPidAlive;
  const readProcessCmdline = _deps.readProcessCmdline ?? ((pid) => defaultReadProcessCmdline(pid, { platform, fsImpl, exec }));
  const killFn = _deps.kill ?? ((pid, sig) => process.kill(pid, sig));

  const parsedOverrides = parseServiceCliOverrides({
    scope: explicitScope,
    name: explicitName,
    ensure,
    remove,
    uninstall,
  });
  if (parsedOverrides.error) {
    console.error(`✗ ${parsedOverrides.error}`);
    return 1;
  }
  const scope = String(parsedOverrides.scope || "auto").trim();
  const name = parsedOverrides.name ?? "";
  const isEnsure = parsedOverrides.ensure;
  const isRemove = parsedOverrides.remove;
  const isUninstall = parsedOverrides.uninstall;
  if (isEnsure && (isRemove || isUninstall)) {
    console.error("✗ --ensure 与破坏性参数 --remove/--uninstall 互斥，不能同时指定");
    return 1;
  }
  if (scope !== "auto" && scope !== "system" && scope !== "user") {
    console.error(`✗ 非法 scope：${scope}（仅支持 auto | system | user）`);
    return 1;
  }

  const role = roleOf(configDir, { role: explicitRole }, fsImpl);
  const node = nodeNameOf(configDir, fsImpl);
  const appBin = path.join(appDir, "bin", "ah.mjs");
  const logPath = path.join(configDir, "daemon.log");
  const homeDir = homedirFn();
  const currentFingerprint = computeProxyFingerprint(env);
  const checkDaemonLockHealth = () => {
    const pid = readDaemonLockPid(configDir, fsImpl);
    if (!pid || !isPidAlive(pid)) return { alive: false, pid: null };
    const cmdline = readProcessCmdline(pid);
    if (!isAhDaemonCommandLine(cmdline)) return { alive: false, pid: null };
    return { alive: true, pid };
  };

  if (platform === "darwin") {
    const agentsDir = path.join(homeDir, "Library", "LaunchAgents");
    const label = selectAutostartName({ role, node, configDir, homeDir, kind: "launchd", name });
    const plistPath = path.join(agentsDir, `${label}.plist`);
    const uid = String(getuid());
    if (isRemove) {
      runWith(exec, "launchctl", ["bootout", `gui/${uid}/${label}`], { ignore: true });
      removeFile(plistPath, fsImpl);
      console.log(`已卸载自启：${label}`);
      return 0;
    }
    if (isEnsure) {
      const savedEnv = parseServiceEnvFile(configDir, fsImpl);
      const fingerprintUnchanged = Boolean(savedEnv && savedEnv.AH_PROXY_FINGERPRINT === currentFingerprint);
      let launchdActive = false;
      try {
        exec("launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        launchdActive = true;
      } catch {
        launchdActive = false;
      }
      const lockHealth = checkDaemonLockHealth();
      if (fingerprintUnchanged && launchdActive) {
        console.log(`ok: ${label} active (launchd, config=${configDir})`);
        return 0;
      }
      if (fingerprintUnchanged && lockHealth.alive) {
        console.log(`ok: daemon alive (pid=${lockHealth.pid}, mode=spawn, config=${configDir})`);
        return 0;
      }
      await stopStandaloneDaemonIfAlive({ configDir, fsImpl, isPidAlive, readProcessCmdline, killFn, sleep });
      try {
        writeServiceEnvFile(configDir, {
          ...collectServiceEnv(env, { includePath: true, home: homeDir }),
          AH_PROXY_FINGERPRINT: currentFingerprint,
          AH_SERVICE_MODE: "launchd",
        }, fsImpl);
        const plist = renderPlist({ label, appBin, configDir, role, logPath });
        fsImpl.mkdirSync(path.dirname(plistPath), { recursive: true });
        fsImpl.writeFileSync(plistPath, plist, { mode: 0o600 });
        try { fsImpl.chmodSync(plistPath, 0o600); } catch {}
        runWith(exec, "launchctl", ["bootout", `gui/${uid}/${label}`], { ignore: true });
        // bootout 是异步卸载，旧守护进程退出清理要数秒；先等 print 报错确认完全卸载，
        // 再 bootstrap 并用 print 验证装载，避免竞态下服务停在已卸载状态。
        await awaitLaunchdUnload(exec, uid, label, { sleep, now });
        await bootstrapAndVerify(exec, uid, label, plistPath, { sleep, now });
        console.log(`ok: ${label} active (launchd, config=${configDir})`);
        return 0;
      } catch (launchdErr) {
        const spawnRes = await spawnEnsureDaemon({
          configDir,
          appBin,
          env,
          homeDir,
          currentFingerprint,
          execPath,
          fsImpl,
          spawnFn,
          isPidAlive,
          sleep,
        });
        if (spawnRes.ok) {
          console.log(`ok: daemon alive (pid=${spawnRes.pid}, mode=spawn, config=${configDir})`);
          return 0;
        }
        console.error(`✗ service --ensure 收敛失败：launchd: ${launchdErr?.message || launchdErr}；${spawnRes.error}`);
        return 1;
      }
    }
    const plist = renderPlist({ label, appBin, configDir, role, logPath });
    fsImpl.mkdirSync(path.dirname(plistPath), { recursive: true });
    fsImpl.writeFileSync(plistPath, plist, { mode: 0o600 });
    try { fsImpl.chmodSync(plistPath, 0o600); } catch {}
    runWith(exec, "launchctl", ["bootout", `gui/${uid}/${label}`], { ignore: true });
    // bootout 是异步卸载：旧进程收到 SIGTERM 后还要做退出清理（标记能力离线，涉及网络请求），
    // 实测约 5 秒才完全退出；退出前 bootstrap 会报 5: Input/output error，服务就停在已卸载状态。
    // 先等 print 报错确认完全卸载（默认 30 秒上限），再 bootstrap 并用 print 验证装载。
    await awaitLaunchdUnload(exec, uid, label, { sleep, now });
    await bootstrapAndVerify(exec, uid, label, plistPath, { sleep, now });
    console.log(`自启已安装并启动：${label}（role: ${role}）`);
    console.log(`  plist：${plistPath}`);
    console.log(`  日志：${logPath}`);
    console.log(`  卸载：ah service --remove --role ${role} --config ${configDir}`);
    return 0;
  }

  if (platform === "linux") {
    const userUnitDir = path.join(homeDir, ".config", "systemd", "user");
    const unit = selectAutostartName({ role, node, configDir, homeDir, kind: "systemd", name });
    const unitPath = path.join(userUnitDir, unit);
    const sysUnitPath = path.join(systemUnitDir, unit);
    const serviceEnvPath = path.join(configDir, "service.env");
    const isRoot = getuid() === 0;

    let sudoChecked = false;
    let sudoAvailable = false;
    const checkHasSudo = () => {
      if (isRoot) return false;
      if (sudoChecked) return sudoAvailable;
      sudoChecked = true;
      try {
        exec("sudo", ["-n", "true"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        sudoAvailable = true;
      } catch {
        sudoAvailable = false;
      }
      return sudoAvailable;
    };

    if (isRemove) {
      if (scope === "system" && !isRoot && !checkHasSudo()) {
        console.error("✗ 卸载系统级 systemd 服务需要 root 或免密 sudo 权限");
        return 1;
      }
      if (scope === "auto" || scope === "user") {
        runWith(exec, "systemctl", ["--user", "disable", "--now", unit], { ignore: true });
        try { removeFile(unitPath, fsImpl); } catch {}
        cleanupLegacyUnitsInDir({
          dir: userUnitDir, role, node, configDir, currentUnit: unit, isUser: true, isRoot, exec, fsImpl,
        });
        runWith(exec, "systemctl", ["--user", "daemon-reload"], { ignore: true });
      }
      if (scope === "auto" || scope === "system") {
        if (isRoot) {
          runWith(exec, "systemctl", ["disable", "--now", unit], { ignore: true });
          try { removeFile(sysUnitPath, fsImpl); } catch {}
          cleanupLegacyUnitsInDir({
            dir: systemUnitDir, role, node, configDir, currentUnit: unit, isUser: false, isRoot: true, exec, fsImpl,
          });
          runWith(exec, "systemctl", ["daemon-reload"], { ignore: true });
        } else if (checkHasSudo()) {
          try { exec("sudo", ["systemctl", "disable", "--now", unit], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch {}
          try { exec("sudo", ["rm", "-f", sysUnitPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch {}
          cleanupLegacyUnitsInDir({
            dir: systemUnitDir, role, node, configDir, currentUnit: unit, isUser: false, isRoot: false, exec, fsImpl,
          });
          try { exec("sudo", ["systemctl", "daemon-reload"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch {}
        }
      }
      // 仅当 user 与 system 目录中都不再有 unit 引用这份 service.env 时才删除，避免误伤同目录其它 unit。
      const stillReferenced = [userUnitDir, systemUnitDir].some((dir) => {
        try {
          return fsImpl.readdirSync(dir).some((entry) => {
            const file = typeof entry === "string" ? entry : entry?.name;
            if (!file || !file.endsWith(".service")) return false;
            try {
              const text = fsImpl.readFileSync(path.join(dir, file), "utf8");
              return text.includes(serviceEnvPath);
            } catch {
              return false;
            }
          });
        } catch {
          return false;
        }
      });
      if (!stillReferenced) {
        try { removeFile(serviceEnvPath, fsImpl); } catch {}
      }
      console.log(`已卸载自启：${unit}`);
      return 0;
    }

    const installUserUnit = async ({ quietError = false } = {}) => {
      try {
        const envObj = {
          ...collectServiceEnv(env, { includePath: true }),
          AH_PROXY_FINGERPRINT: currentFingerprint,
          AH_SERVICE_MODE: "user",
        };
        writeServiceEnvFile(configDir, envObj, fsImpl);
        const text = renderSystemdUnit({
          role,
          node,
          appBin,
          configDir,
          isSystem: false,
          nodeExec: execPath,
          envFile: serviceEnvPath,
        });
        fsImpl.mkdirSync(userUnitDir, { recursive: true });
        fsImpl.writeFileSync(unitPath, text);
        cleanupLegacyUnitsInDir({
          dir: userUnitDir, role, node, configDir, currentUnit: unit, isUser: true, isRoot, exec, fsImpl,
        });
        runWith(exec, "systemctl", ["--user", "daemon-reload"]);
        runWith(exec, "systemctl", ["--user", "enable", unit]);
        // 必须 restart 而非 enable --now：服务已运行且 service.env 轮换了代理凭据时，restart 才会重载环境。
        runWith(exec, "systemctl", ["--user", "restart", unit]);

        const activeCheck = await checkSystemdActive(unit, true, { execFileSync: exec, sleep });
        if (!activeCheck.ok) {
          const msg = `systemd 用户服务 ${unit} 启动后未能处于 active 状态（状态：${activeCheck.status}）`;
          if (!quietError) console.error(`✗ ${msg}`);
          return { code: 1, error: msg };
        }
        console.log(`ok: ${unit} active (user, config=${configDir})`);
        return { code: 0, error: "" };
      } catch (e) {
        const msg = `安装 systemd 用户服务 ${unit} 失败：${e?.message || e}`;
        if (!quietError) console.error(`✗ ${msg}`);
        return { code: 1, error: msg };
      }
    };

    const installSystemUnit = async ({ quietError = false } = {}) => {
      if (!isRoot && !checkHasSudo()) {
        const msg = "安装系统级 systemd 服务需要 root 或免密 sudo 权限";
        if (!quietError) console.error(`✗ ${msg}`);
        return { code: 1, error: msg };
      }
      const info = userInfoFn();
      const curUser = info?.username || "";
      const envObj = {
        ...collectServiceEnv(env, { includePath: true, home: homeDir }),
        AH_PROXY_FINGERPRINT: currentFingerprint,
        AH_SERVICE_MODE: "system",
      };
      try {
        writeServiceEnvFile(configDir, envObj, fsImpl);
        const text = renderSystemdUnit({
          role,
          node,
          appBin,
          configDir,
          isSystem: true,
          user: curUser,
          home: homeDir,
          nodeExec: execPath,
          envFile: serviceEnvPath,
        });
        if (isRoot) {
          fsImpl.mkdirSync(systemUnitDir, { recursive: true });
          fsImpl.writeFileSync(sysUnitPath, text);
          cleanupLegacyUnitsInDir({
            dir: systemUnitDir, role, node, configDir, currentUnit: unit, isUser: false, isRoot: true, exec, fsImpl,
          });
          runWith(exec, "systemctl", ["daemon-reload"]);
          runWith(exec, "systemctl", ["enable", unit]);
          runWith(exec, "systemctl", ["restart", unit]);
        } else {
          // 临时文件放在 configDir 下并设 0600，绝不向 /tmp 写文件。
          const tmpUnit = path.join(configDir, `.${unit}.${process.pid}.${Date.now()}.tmp`);
          fsImpl.mkdirSync(configDir, { recursive: true });
          fsImpl.writeFileSync(tmpUnit, text, { mode: 0o600 });
          fsImpl.chmodSync(tmpUnit, 0o600);
          try {
            runWith(exec, "sudo", ["cp", tmpUnit, sysUnitPath]);
            // unit 正文不含凭据（凭据隔离在 0600 service.env），设 0644 避免 systemd 告警及非 root 巡检不可读。
            runWith(exec, "sudo", ["chmod", "0644", sysUnitPath], { ignore: true });
          } finally {
            try { fsImpl.unlinkSync(tmpUnit); } catch {}
          }
          cleanupLegacyUnitsInDir({
            dir: systemUnitDir, role, node, configDir, currentUnit: unit, isUser: false, isRoot: false, exec, fsImpl,
          });
          runWith(exec, "sudo", ["systemctl", "daemon-reload"]);
          runWith(exec, "sudo", ["systemctl", "enable", unit]);
          runWith(exec, "sudo", ["systemctl", "restart", unit]);
        }

        const activeCheck = await checkSystemdActive(unit, false, { execFileSync: exec, sleep });
        if (!activeCheck.ok) {
          const msg = `systemd 系统服务 ${unit} 启动后未能处于 active 状态（状态：${activeCheck.status}）`;
          if (!quietError) console.error(`✗ ${msg}`);
          return { code: 1, error: msg };
        }
        console.log(`ok: ${unit} active (system, config=${configDir})`);
        return { code: 0, error: "" };
      } catch (e) {
        const msg = `安装 systemd 系统服务 ${unit} 失败：${e?.message || e}`;
        if (!quietError) console.error(`✗ ${msg}`);
        return { code: 1, error: msg };
      }
    };

    // --ensure 独立分支：先做健康与代理指纹校验，不健康或指纹变化时按 system -> user -> spawn 顺序收敛。
    if (isEnsure) {
      const savedEnv = parseServiceEnvFile(configDir, fsImpl);
      const fingerprintUnchanged = Boolean(savedEnv && savedEnv.AH_PROXY_FINGERPRINT === currentFingerprint);
      const sysActive = scope !== "user" ? isSystemdUnitActiveNow(unit, false, exec) : false;
      const userActive = scope !== "system" ? isSystemdUnitActiveNow(unit, true, exec) : false;
      const lockHealth = scope === "auto" ? checkDaemonLockHealth() : { alive: false, pid: null };

      if (fingerprintUnchanged) {
        if (sysActive) {
          console.log(`ok: ${unit} active (system, config=${configDir})`);
          return 0;
        }
        if (userActive) {
          console.log(`ok: ${unit} active (user, config=${configDir})`);
          return 0;
        }
        if (lockHealth.alive) {
          console.log(`ok: daemon alive (pid=${lockHealth.pid}, mode=spawn, config=${configDir})`);
          return 0;
        }
      }

      const failures = [];
      if (scope === "auto" || scope === "system") {
        if (isRoot || checkHasSudo()) {
          // 若当前由 user unit 持有 daemon.lock，切向 system unit 前先停掉 user unit 防止锁冲突。
          if (userActive) {
            runWith(exec, "systemctl", ["--user", "stop", unit], { ignore: true });
          } else if (!sysActive) {
            await stopStandaloneDaemonIfAlive({ configDir, fsImpl, isPidAlive, readProcessCmdline, killFn, sleep });
          }
          const sysRes = await installSystemUnit({ quietError: true });
          if (sysRes.code === 0) return 0;
          failures.push(`system: ${sysRes.error}`);
        } else {
          failures.push("system: 无 root 或免密 sudo 权限");
        }
      }

      if (scope === "auto" || scope === "user") {
        if (!userActive) {
          await stopStandaloneDaemonIfAlive({ configDir, fsImpl, isPidAlive, readProcessCmdline, killFn, sleep });
        }
        const userRes = await installUserUnit({ quietError: true });
        if (userRes.code === 0) return 0;
        failures.push(`user: ${userRes.error}`);
      }

      if (scope === "auto") {
        // 若此前是 systemd 管理但本次收敛退到 spawn（极少见），或此前是直启 daemon 且代理指纹变化，先释放旧进程锁。
        await stopStandaloneDaemonIfAlive({ configDir, fsImpl, isPidAlive, readProcessCmdline, killFn, sleep });
        const spawnRes = await spawnEnsureDaemon({
          configDir,
          appBin,
          env,
          homeDir,
          currentFingerprint,
          execPath,
          fsImpl,
          spawnFn,
          isPidAlive,
          sleep,
        });
        if (spawnRes.ok) {
          console.log(`ok: daemon alive (pid=${spawnRes.pid}, mode=spawn, config=${configDir})`);
          return 0;
        }
        failures.push(`spawn: ${spawnRes.error}`);
      }

      console.error(`✗ service --ensure 收敛失败：${failures.join("；")}`);
      return 1;
    }

    if (scope === "user") {
      return (await installUserUnit()).code;
    }
    if (scope === "system") {
      return (await installSystemUnit()).code;
    }

    // scope === "auto"：非 root 先探测 user session；否则探测 system；仅完全无 systemd 环境时才退回后台 spawn。
    let hasUserSession = false;
    if (!isRoot) {
      try {
        exec("systemctl", ["--user", "daemon-reload"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        hasUserSession = true;
      } catch {
        hasUserSession = false;
      }
    }
    if (hasUserSession) {
      return (await installUserUnit()).code;
    }

    if (isRoot || checkHasSudo()) {
      let hasSystemd = true;
      try {
        if (isRoot) {
          exec("systemctl", ["daemon-reload"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        } else {
          exec("sudo", ["systemctl", "daemon-reload"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        }
      } catch (e) {
        if (isNoSystemdError(e)) hasSystemd = false;
      }
      if (hasSystemd) {
        return (await installSystemUnit()).code;
      }
    }

    // 兜底：无可用 systemd 运行环境时后台拉起守护进程（绝不向 stdout 打印任何 unit 内容或环境变量）。
    try {
      fsImpl.mkdirSync(configDir, { recursive: true });
      const outFd = fsImpl.openSync(logPath, "a");
      const extraEnv = collectServiceEnv(env);
      const child = spawnFn(execPath, [appBin, "daemon", "--config", configDir, "--role", role], {
        detached: true,
        stdio: ["ignore", outFd, outFd],
        cwd: configDir,
        env: { ...env, ...extraEnv },
      });
      child.unref();
      console.log(`· 当前环境未提供可用 systemd，已后台拉起守护进程（PID: ${child.pid}，日志：${logPath}）`);
      return 0;
    } catch (e) {
      console.error(`✗ 后台拉起守护进程失败：${e.message}`);
      return 1;
    }
  }

  if (platform === "win32") {
    if (isEnsure) {
      const savedEnv = parseServiceEnvFile(configDir, fsImpl);
      const fingerprintUnchanged = Boolean(savedEnv && savedEnv.AH_PROXY_FINGERPRINT === currentFingerprint);
      const lockHealth = checkDaemonLockHealth();
      if (fingerprintUnchanged && lockHealth.alive) {
        console.log(`ok: daemon alive (pid=${lockHealth.pid}, mode=${savedEnv?.AH_SERVICE_MODE || "win32"}, config=${configDir})`);
        return 0;
      }
      await stopStandaloneDaemonIfAlive({ configDir, fsImpl, isPidAlive, readProcessCmdline, killFn, sleep });
      try {
        writeServiceEnvFile(configDir, {
          ...collectServiceEnv(env, { includePath: true, home: homeDir }),
          AH_PROXY_FINGERPRINT: currentFingerprint,
          AH_SERVICE_MODE: "win32",
        }, fsImpl);
        const code = await registerWindowsService({ configDir, role, node, appBin, logPath, remove: false, name });
        if (code === 0) return 0;
      } catch (winErr) {
        const spawnRes = await spawnEnsureDaemon({
          configDir,
          appBin,
          env,
          homeDir,
          currentFingerprint,
          execPath,
          fsImpl,
          spawnFn,
          isPidAlive,
          sleep,
        });
        if (spawnRes.ok) {
          console.log(`ok: daemon alive (pid=${spawnRes.pid}, mode=spawn, config=${configDir})`);
          return 0;
        }
        console.error(`✗ service --ensure 收敛失败：win32: ${winErr?.message || winErr}；${spawnRes.error}`);
        return 1;
      }
    }
    return registerWindowsService({ configDir, role, node, appBin, logPath, remove: isRemove, name });
  }

  console.log(`暂不支持在 ${platform} 上自动注册自启；请用任务计划程序手动安排：`);
  console.log(`  ${execPath} ${appBin} daemon --config ${configDir} --role ${role}`);
  return 1;
}
