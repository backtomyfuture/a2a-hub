// 只读健康自检（ah doctor）。
// 检查配置完整性、密钥文件权限、SQLite 数据库与 Hub 连通性，绝不修改任何状态。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BROWSER_USER_AGENT,
  loadConfigJson,
  loadOwnerToken,
  loadWorkersJson,
  readJsonIfExists,
  readLiveHubUrl,
} from "../core/config.mjs";
import { isHubPublicKey, readHubPublicKey } from "../core/approval-sign.mjs";

function isMode0600(filePath) {
  try {
    if (process.platform === "win32") return true;
    const mode = fs.statSync(filePath).mode & 0o777;
    return (mode & 0o077) === 0;
  } catch {
    return true;
  }
}

function inspectDaemonLock(configDir) {
  const lockPath = path.join(configDir, "daemon.lock");
  if (!fs.existsSync(lockPath)) {
    return { status: "missing", pid: null, lockPath };
  }
  let mtimeMs = 0;
  let pid = null;
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
    const n = Number(fs.readFileSync(lockPath, "utf8").trim());
    if (Number.isSafeInteger(n) && n > 0) pid = n;
  } catch {
    return { status: "stale", pid: null, lockPath };
  }
  if (!pid) return { status: "stale", pid: null, lockPath };
  const bootTimeMs = Date.now() - os.uptime() * 1000;
  if (mtimeMs > 0 && mtimeMs < bootTimeMs - 5000) {
    return { status: "stale", pid, lockPath };
  }
  try {
    process.kill(pid, 0);
    return { status: "running", pid, lockPath };
  } catch (err) {
    if (err?.code === "EPERM") return { status: "running", pid, lockPath };
    return { status: "stale", pid, lockPath };
  }
}

export async function runDoctor({ configDir, fetchFn = globalThis.fetch, io = console } = {}) {
  const checks = [];
  const push = (level, msg) => checks.push({ level, msg });

  const cfgPath = path.join(configDir, "config.json");
  if (!fs.existsSync(cfgPath)) {
    push("FAIL", `缺少 ${cfgPath}，请先运行 ah up 或 ah join <url>`);
  } else {
    push("OK", `已加载配置 ${cfgPath}`);
  }
  const cfg = loadConfigJson(configDir);
  const mode = cfg.mode || "hub";
  push("INFO", `运行模式: ${mode}  设备/节点 ID: ${cfg.deviceId || cfg.agentId || "-"}`);

  const envPath = path.join(configDir, "app.env");
  if (fs.existsSync(envPath)) {
    if (isMode0600(envPath)) push("OK", "app.env 权限符合 0600 安全要求");
    else push("WARN", `app.env 权限过宽，建议执行 chmod 600 ${envPath}`);
  }

  const token = loadOwnerToken(configDir);
  if (!token) {
    push("WARN", "未配置 AH_API_TOKEN（本地免密模式，公网暴露前务必设置）");
  } else {
    push("OK", "已配置访问令牌（app.env / 环境变量）");
  }

  if (mode === "hub") {
    const pubKey = readHubPublicKey(configDir);
    if (isHubPublicKey(pubKey)) push("OK", "Hub 审批签名私钥/公钥对正常");
    else push("WARN", "Hub approval_key.pem 尚未生成（首次启动时会自动创建）");

    const dbPath = path.join(configDir, "hub.db");
    if (fs.existsSync(dbPath)) {
      if (isMode0600(dbPath)) push("OK", "hub.db 存在且权限安全");
      else push("WARN", `建议限制 hub.db 权限为 0600 (${dbPath})`);
    } else {
      push("INFO", "hub.db 尚未创建（将在首次启动 Hub 后初始化）");
    }
  } else {
    if (isHubPublicKey(cfg.hubPublicKey)) {
      push("OK", "已信任 Hub 审批验签公钥 (hubPublicKey)");
    } else {
      push("WARN", "未配置 hubPublicKey（若需执行含签名审批的任务请运行 ah join 重新拉取）");
    }
  }

  if (mode === "hub" || mode === "device") {
    const workers = loadWorkersJson(configDir);
    const enabledCount = workers.filter((w) => w.enabled !== false).length;
    push("OK", `workers.json 共配置 ${workers.length} 个本地 Agent（启用 ${enabledCount} 个）`);
  }

  const lockState = inspectDaemonLock(configDir);
  if (lockState.status === "running") {
    push("OK", `本地守护进程运行中 (pid=${lockState.pid})`);
  } else if (lockState.status === "stale") {
    push("WARN", `检测到陈旧锁文件 daemon.lock (pid=${lockState.pid ?? "?"})，本机守护进程未运行；请运行 ah service --ensure 恢复`);
  } else {
    push("INFO", "本地守护进程当前未运行（如需后台常驻，请运行 ah service 或 ah daemon）");
  }

  const rt = readJsonIfExists(path.join(configDir, "hub_runtime.json"), null);
  const checkUrl = mode === "hub" ? (rt?.url || readLiveHubUrl(configDir)) : cfg.hubUrl;
  if (checkUrl) {
    try {
      const resp = await fetchFn(`${checkUrl.replace(/\/+$/, "")}/api/v1/health`, {
        headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "application/json" },
      });
      if (resp.ok) {
        const data = await resp.json();
        push("OK", `Hub 健康探针可达: ${checkUrl} (v${data.version || "?"}, seq=${data.seq ?? "?"})`);
      } else {
        push("WARN", `Hub 探针返回 HTTP ${resp.status}: ${checkUrl}`);
      }
    } catch (err) {
      push("WARN", `Hub 暂不可达 (${checkUrl}): ${err?.message || err}`);
    }
  }

  let hasFail = false;
  for (const c of checks) {
    if (c.level === "FAIL") hasFail = true;
    io.log(`[${c.level}] ${c.msg}`);
  }
  return hasFail ? 1 : 0;
}
