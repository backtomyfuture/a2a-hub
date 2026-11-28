#!/usr/bin/env node
// a2a-hub 统一 CLI 入口（ah / a2a-hub / ahub）。
// 支持代理环境变量自动重拉起（Node >= 24 的 fetch 仅在进程启动时读取 NODE_USE_ENV_PROXY=1）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DAEMON_VERSION,
  defaultConfigDir,
  discoverLocalWorkers,
  loadAppEnv,
  loadConfigJson,
  loadOwnerToken,
  loadWorkersJson,
  mergeDiscoveredWorkers,
  readLiveHubUrl,
  resolveNoDeviceSetting,
  sanitizeSlug,
  saveWorkersJson,
} from "../src/core/config.mjs";
import { startHubRuntime } from "../src/core/hub-runtime.mjs";
import { DeviceDaemon } from "../src/client/device-daemon.mjs";
import { AgentDaemon } from "../src/client/agent-daemon.mjs";
import { GatewayClient } from "../src/client/gateway-client.mjs";
import { parseSimpleFlags, runInboxCommand, runPresentCommand, runScheduleCommand, uploadLocalAttachments } from "../src/client/inbox.mjs";
import { FILE_ID_RE, extractHubFileId, guessMimeByFilename } from "../src/store/files.mjs";
import { runMcpStdioCommand } from "../src/core/mcp-server.mjs";
import { runAgentSetup, runDeviceJoin, runHubSetup, runInteractiveSetup } from "../src/cli/setup.mjs";
import { runDoctor } from "../src/cli/doctor.mjs";
import { runExpose } from "../src/cli/expose.mjs";
import { service } from "../src/cli/service.mjs";
import { update } from "../src/cli/update.mjs";

// 若环境配置了 HTTP(S)_PROXY 且尚未启用 NODE_USE_ENV_PROXY=1，自动原地重启使内置 fetch 生效。
function maybeReexecWithProxy() {
  if (process.env.NODE_USE_ENV_PROXY === "1" || process.env.__AH_PROXY_REEXEC === "1") return;
  const hasProxy = Boolean(
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  );
  if (!hasProxy) return;
  const res = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, NODE_USE_ENV_PROXY: "1", __AH_PROXY_REEXEC: "1" },
  });
  process.exit(res.status ?? 1);
}

maybeReexecWithProxy();

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function readDaemonLockState(configDir) {
  const lockPath = path.join(configDir, "daemon.lock");
  let raw = "";
  let mtimeMs = 0;
  try {
    const st = fs.statSync(lockPath);
    mtimeMs = st.mtimeMs;
    raw = fs.readFileSync(lockPath, "utf8").trim();
  } catch {
    return { lockPath, exists: false, pid: null, mtimeMs: 0, staleByBoot: false };
  }
  const pid = Number(raw);
  const bootTimeMs = Date.now() - os.uptime() * 1000;
  // 锁文件早于本次系统开机时间：说明是上次开机/断电遗留的陈旧锁，即使 PID 被复用也不能拦截启动。
  const staleByBoot = mtimeMs > 0 && mtimeMs < bootTimeMs - 5000;
  return {
    lockPath,
    exists: true,
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    mtimeMs,
    staleByBoot,
  };
}

function acquireDaemonLock(configDir) {
  fs.mkdirSync(configDir, { recursive: true });
  const lockPath = path.join(configDir, "daemon.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { mode: 0o600, flag: "wx" });
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const state = readDaemonLockState(configDir);
      if (state.exists && state.pid && state.pid !== process.pid && !state.staleByBoot && isPidAlive(state.pid)) {
        throw new Error(`守护进程已在运行中 (pid=${state.pid}, lock=${lockPath})`);
      }
      try { fs.unlinkSync(lockPath); } catch {}
      if (attempt === 1) {
        fs.writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
      }
    }
  }
  // 每 60s 轻触刷新 daemon.lock mtime，供 Windows 周期保活巡检 0 子进程确认守护进程健康存活。
  const heartbeatTimer = setInterval(() => {
    try {
      if (Number(fs.readFileSync(lockPath, "utf8").trim()) === process.pid) {
        const now = new Date();
        fs.utimesSync(lockPath, now, now);
      }
    } catch {}
  }, 60_000);
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();

  return () => {
    clearInterval(heartbeatTimer);
    try {
      if (Number(fs.readFileSync(lockPath, "utf8").trim()) === process.pid) {
        fs.unlinkSync(lockPath);
      }
    } catch {}
  };
}

function helpText() {
  return `a2a-hub v${DAEMON_VERSION} — 个人多 Agent 编排中台 CLI

用法:
  ah up [--listen 0.0.0.0:8787] [--no-device] [--service] [--skip-skill] [--config <dir>]
      一键初始化并在本机启动独立中台 Hub（含 Web 控制台 + SQLite + 可选本机 CLI 并发执行池）
  ah join <http://[token@]host:port> [--device <name>] [--service] [--config <dir>]
      将当前电脑作为设备节点接入已有 Hub，自动发现本地 Claude/Codex/OpenCode 等 CLI
  ah join <http://host:port> --agent [--agent-role worker|leader] --node <id> --token-file <path> [--no-daemon] [--config <dir>]
      将当前环境作为独立 Agent 接入已有 Hub（支持仅保存凭据文件、搭配 ah service --ensure 保活）
  ah setup [--mode hub|device|agent] [--config <dir>]
      运行配置向导
  ah daemon [--config <dir>]
      按 config.json 启动守护进程（Hub / Device / Agent）
  ah expose [tailscale | cf <url> | status | off] [--auto-token] [--config <dir>]
      公网 HTTPS 一键暴露与 Cloudflare Bot 拦截探针
  ah service [--remove | --ensure | --system | --user] [--config <dir>]
      安装、检查或卸载开机自启后台服务
  ah doctor [--config <dir>]
      只读自检配置、权限、本地 CLI 与 Hub 连通性
  ah agents [list | pause <id> | resume <id>]
  ah workers <list | scan | add | remove> [...]
      管理本机 workers.json 可执行 Worker 列表（查看、增量扫描新 CLI、新增、移除）
  ah task <create | list | show | reply | cancel | retry | resolve | delete> [...]
  ah schedule <run <id> [--every 6d] -- <cmd...> | ok <id> [摘要] | fail <id> [原因] | noop <id> | list>
  ah file <upload <filepath> | download <file_id|uri> [--out <filepath>]>
  ah present [list | approve <id> | deny <id> | reply <id> <text>]
  ah inbox <check | list | pop | show | claim | complete | done | fail | ask | auth | updates> [...]
  ah mcp [--hub <url>] [--token <tok>] [--agent <id>] [--role leader|worker]
      启动本机 Stdio MCP 服务（供 Gemini CLI / Claude Desktop / Cursor 等客户端免弹窗挂载）
  ah update [--check] [--skip-skill]
`;
}

async function runDaemon({ configDir, flags = {} }) {
  const cfg = loadConfigJson(configDir);
  const mode = cfg.mode || (flags.role === "hub" ? "hub" : "hub");
  const releaseLock = acquireDaemonLock(configDir);

  let cleanupFn = null;
  let shuttingDown = false;
  const onSignal = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // 强兜底超时（小于 Windows 5s 关机强杀阈值），防止在途请求拖慢关机或遗留 daemon.lock。
    const forceExitTimer = setTimeout(() => {
      releaseLock();
      process.exit(0);
    }, 4000);
    if (typeof forceExitTimer.unref === "function") forceExitTimer.unref();
    try {
      if (cleanupFn) await cleanupFn();
    } catch {
      /* 退出清理异常不影响立即收口 */
    } finally {
      clearTimeout(forceExitTimer);
      releaseLock();
      process.exit(0);
    }
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  // Windows 控制台关闭/中断事件分别映射为 SIGHUP / SIGBREAK
  process.once("SIGHUP", onSignal);
  process.once("SIGBREAK", onSignal);

  try {
    if (mode === "hub") {
      const appEnv = { ...loadAppEnv(configDir), ...process.env };
      const noDevice = resolveNoDeviceSetting({ flags, env: appEnv, cfg });
      const rt = await startHubRuntime({
        configDir,
        listen: flags.listen || "",
        withDeviceDaemon: !noDevice,
      });
      cleanupFn = rt.stop;
      console.log(`✓ a2a-hub v${DAEMON_VERSION} 已启动`);
      console.log(`  本地地址: ${rt.url}`);
      const tok = loadOwnerToken(configDir);
      console.log(`  Web 控制台: ${rt.publicUrl || rt.url}/${tok ? `?token=${encodeURIComponent(tok)}` : ""}`);
      await new Promise(() => {}); // 阻塞保活直到收到退出信号
    } else if (mode === "device") {
      const daemon = new DeviceDaemon({
        configDir,
        deviceId: cfg.deviceId || sanitizeSlug(os.hostname()),
        hubUrl: cfg.hubUrl,
        token: loadOwnerToken(configDir),
        hubPublicKey: cfg.hubPublicKey || "",
        maxConcurrent: cfg.maxConcurrent || 4,
      });
      cleanupFn = () => daemon.stop();
      console.log(`✓ 设备节点 ${daemon.deviceId} 已连接 -> ${daemon.hubUrl}`);
      await daemon.start();
    } else if (mode === "agent") {
      const daemon = new AgentDaemon({
        configDir,
        agentId: cfg.agentId,
        hubUrl: cfg.hubUrl,
        token: loadOwnerToken(configDir),
        command: cfg.command,
        cwd: cfg.cwd,
      });
      cleanupFn = () => daemon.stop();
      console.log(`✓ Agent 节点 ${daemon.agentId} 已连接 -> ${daemon.hubUrl}`);
      await daemon.start();
    } else {
      throw new Error(`未知运行模式 mode=${mode}`);
    }
  } catch (err) {
    releaseLock();
    throw err;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseSimpleFlags(argv);
  const cmd = String(flags._[0] || "").trim();
  const restArgs = argv.slice(argv.indexOf(cmd) + 1);
  const configDir = flags.config ? path.resolve(String(flags.config)) : defaultConfigDir();
  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  if (flags.version || cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(DAEMON_VERSION);
    return 0;
  }
  if (!cmd || flags.help || flags.h || cmd === "help") {
    console.log(helpText());
    return 0;
  }

  if (cmd === "up") {
    const explicitNoDevice = flags["no-device"] !== undefined
      ? resolveNoDeviceSetting({ flags })
      : (flags.device || flags.node)
        ? false
        : undefined;
    await runHubSetup({
      configDir,
      listen: flags.listen || (flags.port ? `0.0.0.0:${flags.port}` : "0.0.0.0:8787"),
      deviceId: flags.device || flags.node || "",
      apiToken: flags.token || "",
      autoToken: flags["no-token"] ? false : true,
      force: Boolean(flags.force),
      skipSkill: Boolean(flags["skip-skill"]),
      noDevice: explicitNoDevice,
    });
    if (flags.service) {
      return await service(
        configDir,
        { scope: flags.system ? "system" : flags.user ? "user" : "auto" },
        appDir
      );
    }
    if (flags["init-only"]) return 0;
    return await runDaemon({ configDir, flags: { ...flags, role: "hub" } });
  }

  if (cmd === "join") {
    const agentArgUrl = typeof flags.agent === "string" && /^https?:\/\//i.test(flags.agent) ? flags.agent : "";
    const joinUrl = flags._[1] || flags.hub || agentArgUrl;
    if (!joinUrl) throw new Error("用法: ah join http://[token@]<hub-host>:8787 [--device <name>] [--service]");
    if (Boolean(flags.agent) || flags.kind === "agent") {
      const explicitAgentId =
        typeof flags.agent === "string" && !/^https?:\/\//i.test(flags.agent) ? flags.agent : "";
      await runAgentSetup({
        configDir,
        joinUrl,
        agentId: explicitAgentId || flags.node || flags.device || "",
        token: flags.token || "",
        tokenFile: flags["token-file"] || "",
        agentRole: flags["agent-role"] || "worker",
        command: flags.command || "",
        skipSkill: Boolean(flags["skip-skill"]),
      });
    } else {
      await runDeviceJoin({
        configDir,
        joinUrl,
        deviceId: flags.device || flags.node || "",
        token: flags.token || "",
        force: Boolean(flags.force),
        skipSkill: Boolean(flags["skip-skill"]),
      });
    }
    if (flags.service) {
      return await service(
        configDir,
        { scope: flags.system ? "system" : flags.user ? "user" : "auto" },
        appDir
      );
    }
    if (flags["no-daemon"] || flags["setup-only"]) return 0;
    return await runDaemon({ configDir, flags });
  }

  if (cmd === "setup") {
    await runInteractiveSetup({ configDir, flags });
    if (flags.service) {
      return await service(
        configDir,
        { scope: flags.system ? "system" : flags.user ? "user" : "auto" },
        appDir
      );
    }
    return 0;
  }

  if (cmd === "daemon") {
    return await runDaemon({ configDir, flags });
  }

  if (cmd === "service") {
    return await service(
      configDir,
      {
        scope: flags.system ? "system" : flags.user ? "user" : "auto",
        name: flags.name || "",
        ensure: Boolean(flags.ensure),
        remove: Boolean(flags.remove),
        uninstall: Boolean(flags.uninstall),
      },
      appDir
    );
  }

  if (cmd === "expose") {
    return await runExpose(configDir, restArgs);
  }

  if (cmd === "doctor") {
    return await runDoctor({ configDir });
  }

  if (cmd === "update") {
    return await update(appDir, {
      check: Boolean(flags.check),
      skipSkill: Boolean(flags["skip-skill"]),
      configDir,
    });
  }

  if (cmd === "present") {
    return await runPresentCommand(restArgs, { configDir });
  }

  if (cmd === "inbox") {
    return await runInboxCommand(restArgs, { configDir });
  }

  if (cmd === "schedule") {
    return await runScheduleCommand(restArgs, { configDir });
  }

  if (cmd === "mcp") {
    return await runMcpStdioCommand(restArgs, { configDir });
  }

  if (cmd === "agents") {
    const sub = flags._[1] || "list";
    const client = new GatewayClient(flags.hub || readLiveHubUrl(configDir), {
      token: flags.token || loadOwnerToken(configDir),
    });
    if (sub === "list") {
      const r = await client.listAgents();
      for (const a of r.agents || []) {
        const status = !a.enabled ? "PAUSED" : a.online ? "ONLINE" : "OFFLINE";
        console.log(`${a.id.padEnd(28)} ${status.padEnd(8)} ${a.role.padEnd(7)} ${a.name} — ${a.summary}`);
      }
      return 0;
    }
    if (sub === "pause" || sub === "resume") {
      const id = flags._[2];
      if (!id) throw new Error(`用法: ah agents ${sub} <agent_id>`);
      const enabled = sub === "resume";
      await client.patch(`/api/v1/agents/${encodeURIComponent(id)}`, { enabled });
      console.log(`✓ 已${enabled ? "恢复" : "暂停"} Agent: ${id}`);
      return 0;
    }
    throw new Error(`未知 agents 子命令: ${sub}`);
  }

  if (cmd === "workers") {
    const sub = flags._[1] || "list";
    const workers = loadWorkersJson(configDir);
    if (sub === "list") {
      if (!workers.length) {
        console.log("workers.json 暂无已配置的本机 Worker。");
        return 0;
      }
      for (const w of workers) {
        console.log(`${String(w.key || "").padEnd(18)} ${(w.name || "").padEnd(18)} ${w.command || ""}`);
      }
      return 0;
    }
    if (sub === "scan") {
      const discovered = discoverLocalWorkers();
      const force = Boolean(flags.force);
      const merged = mergeDiscoveredWorkers(workers, discovered, { force });
      if (merged.added.length || merged.updated.length || !fs.existsSync(path.join(configDir, "workers.json"))) {
        saveWorkersJson(configDir, merged.workers);
      }
      if (!discovered.length) {
        console.log("未在本机 PATH 或常见安装目录中检测到已受支持的 CLI Agent。");
        return 0;
      }
      const addedKeys = merged.added.map((w) => w.key).join(", ");
      const updatedKeys = merged.updated.map((w) => w.key).join(", ");
      console.log(`✓ 本机共探测到 ${discovered.length} 个 CLI Agent: ${discovered.map((w) => w.key).join(", ")}`);
      if (merged.added.length) console.log(`  新增写入 (${merged.added.length}): ${addedKeys}`);
      if (merged.updated.length) console.log(`  强制覆盖 (${merged.updated.length}): ${updatedKeys}`);
      if (!merged.added.length && !merged.updated.length) {
        console.log("  全部均已在 workers.json 中配置，未重复写入。");
      } else {
        console.log("  守护进程将在下次轮询自动同步到 Hub。");
      }
      return 0;
    }
    if (sub === "add") {
      const name = String(flags.name || flags.key || "").trim();
      const command = String(flags.command || "").trim();
      const key = sanitizeSlug(flags.key || name, "");
      if (!key || !name || !command) {
        throw new Error("用法: ah workers add --key <id> --name <名称> --command <执行命令> [--cwd <dir>] [--summary <定位>]");
      }
      const next = {
        key,
        name,
        role: flags.role === "leader" ? "leader" : "worker",
        platform: String(flags.platform || "cli"),
        summary: String(flags.summary || ""),
        skills: String(flags.skills || "").split(",").map((s) => s.trim()).filter(Boolean),
        tools: [],
        models: flags.model ? [String(flags.model)] : [],
        default_model: String(flags.model || ""),
        model_flag: String(flags["model-flag"] || ""),
        command,
        resume_command: String(flags.resume || ""),
        cwd: String(flags.cwd || process.cwd()),
        timeout_sec: Number(flags.timeout || 600) || 600,
        approval_policy: ["never", "always", "risk"].includes(flags.approval) ? flags.approval : "never",
        enabled: true,
      };
      const idx = workers.findIndex((w) => w && w.key === key);
      if (idx >= 0) workers[idx] = { ...workers[idx], ...next };
      else workers.push(next);
      saveWorkersJson(configDir, workers);
      console.log(`✓ 已写入本机 Worker: ${key}（守护进程将在下次轮询自动同步）`);
      return 0;
    }
    if (sub === "remove" || sub === "rm" || sub === "delete") {
      const key = String(flags.key || flags._[2] || "").trim();
      if (!key) throw new Error("用法: ah workers remove <key>");
      const filtered = workers.filter((w) => w && w.key !== key);
      saveWorkersJson(configDir, filtered);
      console.log(`✓ 已从 workers.json 移除: ${key}`);
      return 0;
    }
    throw new Error(`未知 workers 子命令: ${sub}`);
  }

  if (cmd === "task") {
    const sub = flags._[1] || "list";
    const client = new GatewayClient(flags.hub || readLiveHubUrl(configDir), {
      token: flags.token || loadOwnerToken(configDir),
    });
    if (sub === "list") {
      const r = await client.listTasks({ state: flags.state || "", agent: flags.agent || "", summary: 1 });
      if (flags.json) {
        console.log(JSON.stringify(r.tasks || [], null, 2));
        return 0;
      }
      for (const t of r.tasks || []) {
        console.log(`${t.id}  [${t.state.padEnd(14)}]  ${t.context_id || "-"}  -> ${t.to_agent_id}  | ${t.title}`);
      }
      return 0;
    }
    if (sub === "show") {
      const id = flags._[2];
      if (!id) throw new Error("用法: ah task show <task_id>");
      const r = await client.getTask(id);
      console.log(JSON.stringify(r.task, null, 2));
      return 0;
    }
    if (sub === "create") {
      const toRaw = String(flags.to || flags._[2] || "");
      const targets = toRaw.split(",").map((s) => s.trim()).filter(Boolean);
      const inputText = String(flags.text || flags.prompt || flags.input || flags._.slice(3).join(" ") || "");
      if (!targets.length || !inputText) {
        throw new Error("用法: ah task create --to <agent1,agent2> --text <任务描述> [--title ...] [--context <ctx>] [--model <m>] [--attach <file>]");
      }
      const attachments = await uploadLocalAttachments(client, flags.attach);
      const r = await client.dispatchTask({
        to: targets,
        title: flags.title || "",
        input_text: inputText,
        context_id: flags.context || "",
        model: flags.model || "",
        priority: flags.priority ? Number(flags.priority) : 5,
        ...(attachments.length ? { attachments } : {}),
      });
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    if (sub === "reply") {
      const id = flags._[2];
      const body = flags.text || flags.body || flags._.slice(3).join(" ");
      const attachments = await uploadLocalAttachments(client, flags.attach, { taskId: id });
      if (!id || (!body && !attachments.length)) {
        throw new Error("用法: ah task reply <task_id> <回复文本> [--attach <file>]");
      }
      const r = await client.replyTask(id, { body: body || "", attachments });
      console.log(`✓ 已回复任务 ${id} -> ${r.task.state}`);
      return 0;
    }
    if (sub === "cancel") {
      const id = flags._[2];
      if (!id) throw new Error("用法: ah task cancel <task_id>");
      const r = await client.cancelTask(id, flags.reason || "cli cancel");
      console.log(`✓ 已取消任务 ${id} -> ${r.task.state}`);
      return 0;
    }
    if (sub === "resolve") {
      const id = flags._[2];
      if (id === "--all" || flags.all) {
        const r = await client.resolveAllFailed(flags.context || "");
        console.log(`✓ 已将 ${r.resolved_count} 条失败任务标为已处理`);
        return 0;
      }
      if (!id) throw new Error("用法: ah task resolve <task_id> 或 ah task resolve --all");
      await client.resolveTask(id);
      console.log(`✓ 已将任务 ${id} 标为已处理`);
      return 0;
    }
    if (sub === "retry") {
      const id = flags._[2];
      if (!id) throw new Error("用法: ah task retry <task_id>");
      const r = await client.retryTask(id);
      console.log(`✓ 已重试任务 ${id} -> 新任务 ${r.task?.id || "-"}`);
      return 0;
    }
    if (sub === "delete" || sub === "rm") {
      const id = flags._[2];
      if (!id) throw new Error("用法: ah task delete <task_id>");
      await client.deleteTask(id);
      console.log(`✓ 已删除任务 ${id}`);
      return 0;
    }
    throw new Error(`未知 task 子命令: ${sub}`);
  }

  if (cmd === "file") {
    const sub = flags._[1] || "";
    const client = new GatewayClient(flags.hub || readLiveHubUrl(configDir), {
      token: flags.token || loadOwnerToken(configDir),
    });
    if (sub === "upload") {
      const filePath = flags._[2] || flags.file;
      if (!filePath) throw new Error("用法: ah file upload <filepath> [--task <task_id>]");
      const absPath = path.resolve(String(filePath));
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
        throw new Error(`文件不存在或不可读取: ${filePath}`);
      }
      const name = path.basename(absPath);
      const r = await client.uploadFile({
        buffer: fs.readFileSync(absPath),
        name,
        mime: guessMimeByFilename(name),
        taskId: flags.task || null,
      });
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    if (sub === "download") {
      const target = String(flags._[2] || flags.id || flags.uri || "").trim();
      const fileId = FILE_ID_RE.test(target) ? target : extractHubFileId(target);
      if (!fileId) throw new Error("用法: ah file download <file_id|hub://files/...> [--out <filepath>]");
      const metaRes = await client.get(`/api/v1/files/${encodeURIComponent(fileId)}/meta`);
      const buf = await client.downloadFile(fileId);
      const outPath = flags.out
        ? path.resolve(String(flags.out))
        : path.resolve(path.basename(metaRes?.file?.name || `${fileId}.bin`) || `${fileId}.bin`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, buf);
      console.log(`✓ 已下载文件至: ${outPath} (${buf.byteLength} bytes)`);
      return 0;
    }
    throw new Error("用法: ah file <upload <filepath> | download <file_id|uri> [--out <filepath>]>");
  }

  console.error(`未知命令: ${cmd}\n`);
  console.log(helpText());
  return 2;
}

main()
  .then((code) => process.exit(Number(code) || 0))
  .catch((err) => {
    console.error(`✗ ${err?.message || err}`);
    process.exit(1);
  });
