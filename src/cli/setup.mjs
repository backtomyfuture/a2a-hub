// 一键初始化向导与安装辅助（v2.0）：支持独立 Hub（up）、接入已有 Hub（join）与交互 setup。

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { loadOrCreateHubKey } from "../core/approval-sign.mjs";
import {
  BROWSER_USER_AGENT,
  DAEMON_VERSION,
  discoverLocalWorkers,
  loadConfigJson,
  loadOwnerToken,
  resolveListenAddr,
  sanitizeSlug,
  saveConfigJson,
  saveWorkersJson,
  writeLockedAppEnvVars,
} from "../core/config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(__dirname, "..", "..");

export function resolveSkillsForHost({ mode = "hub", role = "", kind = "", agentRole = "worker" } = {}) {
  const effectiveMode = mode || (role === "hub" ? "hub" : kind === "inbox" ? "agent" : "device");
  if (effectiveMode === "agent") {
    return agentRole === "leader" ? ["ah-inbox", "ah"] : ["ah-inbox"];
  }
  return ["ah"];
}

export function installLocalSkills(
  skillsList,
  { appDir = APP_ROOT, skillsRoot = path.join(os.homedir(), ".agents", "skills"), skip = false } = {}
) {
  if (skip) return [];
  const installed = [];
  for (const name of skillsList) {
    const src = path.join(appDir, "skills", name, "SKILL.md");
    if (!fs.existsSync(src)) continue;
    const destDir = path.join(skillsRoot, name);
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, "SKILL.md");
    fs.copyFileSync(src, dest);
    installed.push(dest);
  }
  return installed;
}

export function parseJoinHubUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s) throw new Error("Hub 地址不能为空");
  let u;
  try {
    u = new URL(s.includes("://") ? s : `http://${s}`);
  } catch (err) {
    throw new Error(`Hub URL 格式不合法: ${err.message}`);
  }
  const token = u.username ? decodeURIComponent(u.username) : "";
  u.username = "";
  u.password = "";
  const baseUrl = u.toString().replace(/\/+$/, "");
  return { baseUrl, token };
}

async function fetchHubPublicKey(baseUrl, fetchFn = globalThis.fetch) {
  try {
    const resp = await fetchFn(`${baseUrl}/.well-known/agent.json`, {
      headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "application/json" },
    });
    if (!resp.ok) return "";
    const data = await resp.json();
    return String(data?.approval_public_key || "");
  } catch {
    return "";
  }
}

export async function runHubSetup({
  configDir,
  listen = "0.0.0.0:8787",
  deviceId = "",
  apiToken = "",
  autoToken = true,
  force = false,
  skipSkill = false,
  maxConcurrent = 4,
  io = console,
} = {}) {
  fs.mkdirSync(configDir, { recursive: true });
  const prevCfg = loadConfigJson(configDir);
  const existingToken = loadOwnerToken(configDir);
  let finalToken = String(apiToken || "").trim() || existingToken;
  if (!finalToken && autoToken) {
    finalToken = `ah_owner_${crypto.randomBytes(18).toString("base64url")}`;
  }
  if (finalToken) {
    writeLockedAppEnvVars(configDir, { AH_API_TOKEN: finalToken });
  }

  const addr = resolveListenAddr(listen || prevCfg.listen || "0.0.0.0:8787");
  const { publicKey } = loadOrCreateHubKey(configDir);
  const resolvedDeviceId = sanitizeSlug(deviceId || prevCfg.deviceId || os.hostname(), "hub-local");

  const nextCfg = {
    ...prevCfg,
    mode: "hub",
    version: DAEMON_VERSION,
    deviceId: resolvedDeviceId,
    deviceName: prevCfg.deviceName || os.hostname(),
    listen: addr.listen,
    maxConcurrent: Number(maxConcurrent || prevCfg.maxConcurrent || 4) || 4,
    hubPublicKey: publicKey,
  };
  saveConfigJson(configDir, nextCfg);

  const workersPath = path.join(configDir, "workers.json");
  let workers = [];
  if (!fs.existsSync(workersPath) || force) {
    workers = discoverLocalWorkers();
    saveWorkersJson(configDir, workers);
  }

  const skills = installLocalSkills(resolveSkillsForHost({ mode: "hub" }), { skip: skipSkill });

  io.log(`✓ Hub 初始化完成（配置目录: ${configDir}）`);
  io.log(`  监听地址: ${addr.listen}  （控制台: ${addr.url}/?token=${encodeURIComponent(finalToken || "")}）`);
  const discoveredSummary = workers.length ? `: ${workers.map((w) => w.key).join(", ")}` : "";
  io.log(`  本机设备 ID: ${resolvedDeviceId}（已发现 ${workers.length} 个本地 CLI Agent${discoveredSummary}）`);
  if (finalToken) io.log(`  机主 Token（已写入 0600 app.env）: ${finalToken}`);
  if (skills.length) io.log(`  已安装控制端 Skill: ${skills.join(", ")}`);

  return { configDir, config: nextCfg, token: finalToken, workers };
}

export async function runDeviceJoin({
  configDir,
  joinUrl,
  deviceId = "",
  token = "",
  force = false,
  skipSkill = false,
  maxConcurrent = 4,
  fetchFn = globalThis.fetch,
  io = console,
} = {}) {
  fs.mkdirSync(configDir, { recursive: true });
  const parsed = parseJoinHubUrl(joinUrl);
  const finalToken = String(token || parsed.token || "").trim();
  const prevCfg = loadConfigJson(configDir);
  const resolvedDeviceId = sanitizeSlug(deviceId || prevCfg.deviceId || os.hostname(), "device");

  const hubPublicKey = await fetchHubPublicKey(parsed.baseUrl, fetchFn);
  const nextCfg = {
    ...prevCfg,
    mode: "device",
    version: DAEMON_VERSION,
    deviceId: resolvedDeviceId,
    deviceName: prevCfg.deviceName || os.hostname(),
    hubUrl: parsed.baseUrl,
    maxConcurrent: Number(maxConcurrent || prevCfg.maxConcurrent || 4) || 4,
    hubPublicKey: hubPublicKey || prevCfg.hubPublicKey || "",
  };
  saveConfigJson(configDir, nextCfg);
  if (finalToken) {
    writeLockedAppEnvVars(configDir, { AH_API_TOKEN: finalToken });
  }

  const workersPath = path.join(configDir, "workers.json");
  let workers = [];
  if (!fs.existsSync(workersPath) || force) {
    workers = discoverLocalWorkers();
    saveWorkersJson(configDir, workers);
  }

  const skills = installLocalSkills(resolveSkillsForHost({ mode: "device" }), { skip: skipSkill });

  io.log(`✓ 已配置接入 Hub: ${parsed.baseUrl}`);
  const discoveredSummary = workers.length ? `: ${workers.map((w) => w.key).join(", ")}` : "";
  io.log(`  本机设备 ID: ${resolvedDeviceId}（已发现 ${workers.length} 个本地 CLI Agent${discoveredSummary}）`);
  if (hubPublicKey) io.log(`  ✓ 已自动拉取 Hub 审批验签公钥`);
  if (skills.length) io.log(`  已安装控制端 Skill: ${skills.join(", ")}`);

  return { configDir, config: nextCfg, token: finalToken, workers };
}

export async function runAgentSetup({
  configDir,
  joinUrl,
  agentId,
  token = "",
  tokenFile = "",
  agentRole = "worker",
  command = "",
  cwd = os.homedir(),
  skipSkill = false,
  fetchFn = globalThis.fetch,
  io = console,
} = {}) {
  fs.mkdirSync(configDir, { recursive: true });
  const parsed = parseJoinHubUrl(joinUrl);
  const finalToken = String(token || parsed.token || "").trim();
  const resolvedTokenFile = tokenFile ? path.resolve(String(tokenFile)) : "";
  if (!agentId) throw new Error("agent 模式必须指定 --agent <id> 或 --node <id>");

  const nextCfg = {
    mode: "agent",
    version: DAEMON_VERSION,
    agentId: sanitizeSlug(agentId),
    agentRole: agentRole === "leader" ? "leader" : "worker",
    hubUrl: parsed.baseUrl,
    ...(resolvedTokenFile ? { tokenFile: resolvedTokenFile } : {}),
    command,
    cwd,
  };
  saveConfigJson(configDir, nextCfg);

  let effectiveToken = finalToken;
  if (resolvedTokenFile) {
    if (!effectiveToken && fs.existsSync(resolvedTokenFile)) {
      try {
        effectiveToken = fs.readFileSync(resolvedTokenFile, "utf8").trim();
      } catch {}
    }
  } else if (finalToken) {
    writeLockedAppEnvVars(configDir, { AH_API_TOKEN: finalToken });
  }

  if (effectiveToken && parsed.baseUrl && typeof fetchFn === "function") {
    try {
      await fetchFn(`${parsed.baseUrl}/api/v1/agents/register`, {
        method: "POST",
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${effectiveToken}`,
        },
        body: JSON.stringify({ id: nextCfg.agentId }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {}
  }

  const skills = installLocalSkills(resolveSkillsForHost({ mode: "agent", agentRole: nextCfg.agentRole }), {
    skip: skipSkill,
  });
  io.log(`✓ 已配置独立 Agent (${nextCfg.agentId}) -> ${parsed.baseUrl}`);
  if (skills.length) io.log(`  已安装 Skill: ${skills.join(", ")}`);
  return { configDir, config: nextCfg };
}

async function askPrompt(rl, text, defaultVal = "") {
  return new Promise((resolve) => {
    const suffix = defaultVal ? ` [${defaultVal}]` : "";
    rl.question(`${text}${suffix}: `, (ans) => {
      const v = String(ans || "").trim();
      resolve(v || defaultVal);
    });
  });
}

export async function runInteractiveSetup({ configDir, flags = {}, io = console } = {}) {
  const modeFlag = flags.mode || (flags.role === "hub" ? "hub" : flags.role === "node" ? "device" : "");
  if (flags.yes || modeFlag) {
    const mode = modeFlag || (flags.join ? "device" : "hub");
    if (mode === "hub") {
      return runHubSetup({
        configDir,
        listen: flags.listen || "0.0.0.0:8787",
        deviceId: flags.device || flags.node || "",
        apiToken: flags.token || "",
        autoToken: flags["auto-token"] !== false,
        force: Boolean(flags.force),
        skipSkill: Boolean(flags["skip-skill"]),
        io,
      });
    }
    if (mode === "device") {
      return runDeviceJoin({
        configDir,
        joinUrl: flags.join || flags.hub,
        deviceId: flags.device || flags.node || "",
        token: flags.token || "",
        force: Boolean(flags.force),
        skipSkill: Boolean(flags["skip-skill"]),
        io,
      });
    }
    if (mode === "agent") {
      return runAgentSetup({
        configDir,
        joinUrl: flags.join || flags.hub,
        agentId: (typeof flags.agent === "string" ? flags.agent : "") || flags.node || "",
        token: flags.token || "",
        tokenFile: flags["token-file"] || "",
        agentRole: flags["agent-role"] || "worker",
        command: flags.command || "",
        skipSkill: Boolean(flags["skip-skill"]),
        io,
      });
    }
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    io.log("欢迎使用 a2a-hub v2.0 配置向导：");
    io.log("  1) 在本机运行 Hub 编排中台（含 Web 控制台 + SQLite 存储 + 本机 CLI 执行器）");
    io.log("  2) 把当前电脑作为执行节点挂载到已有 Hub");
    io.log("  3) 仅配置独立 Agent CLI / HTTP 接入");
    const choice = await askPrompt(rl, "请选择部署模式 (1/2/3)", "1");
    if (choice === "2") {
      const url = await askPrompt(rl, "请输入 Hub 挂载地址（可包含 token，如 http://<token>@<ip>:8787）", "");
      const devId = await askPrompt(rl, "本机设备名称/ID", sanitizeSlug(os.hostname()));
      return runDeviceJoin({ configDir, joinUrl: url, deviceId: devId, io });
    }
    if (choice === "3") {
      const url = await askPrompt(rl, "请输入 Hub 地址", "http://127.0.0.1:8787");
      const agentId = await askPrompt(rl, "请输入 Agent ID", "");
      const token = await askPrompt(rl, "请输入 Agent Token", "");
      return runAgentSetup({ configDir, joinUrl: url, agentId, token, io });
    }
    const listen = await askPrompt(rl, "Hub HTTP 监听地址", "0.0.0.0:8787");
    const devId = await askPrompt(rl, "本机设备 ID", sanitizeSlug(os.hostname()));
    return runHubSetup({ configDir, listen, deviceId: devId, autoToken: true, io });
  } finally {
    rl.close();
  }
}
