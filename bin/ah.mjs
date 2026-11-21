#!/usr/bin/env node
// ah —— a2a-hub 命令行入口（别名 a2a-hub / ahub，都进本文件）。
// 子命令：
//   up       一键初始化并启动独立中台 Hub（SQLite + HTTP 网关 + Web 控制台）
//   join     一行接入远端 Hub 并启动 HTTP 长轮询节点
//   setup    一键配置向导：独立 Hub（SQLite + HTTP 网关 + Web 控制台）或远端长轮询 Node
//   daemon   常驻守护进程。--role node 认领执行；--role hub 既认领执行，又做全网审批、呈递、陈旧告警。
//            省略 --role 时读 node.json 的 role，再缺省 node。
//   task     task create：hub/控制端建单。先写 instruction 与 Parts，最后写 Tasks 行。
//            task cancel：发起方撤自己的单，或 hub 角色撤任意单。先写 notice，最后改 Tasks。
//   doctor   本机自检：配置、凭据、总线连通、能力登记、自启状态
//   inventory 只读盘点本节点名片与任务，不写入
//   reconcile 单次回表认领/对账后退出
//   service  注册/卸载开机自启：macOS launchd / Linux systemd / Windows 任务计划程序（均用户级，无需管理员）
//   update   自更新程序本体：git pull + 依赖重装 + 软链/Skill 补齐；--check 只看有没有新版本
// 配置目录：--config <dir>，或环境变量 AH_HOME，默认 ~/.a2a-hub。
// 配置目录内含 node.json（节点身份与总线参数）与 commands.json（能力 -> 命令模板）。

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Node 24 的全局 fetch 只在进程启动前读到 NODE_USE_ENV_PROXY=1 才走环境代理，运行中改 process.env 无效；
// Muse 等 VM 出站必须走代理，所以在加载任何子命令之前带着该变量原地自重启一次（靠它防止循环）。
const PROXY_ENV_KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];
if (process.env.NODE_USE_ENV_PROXY !== "1" && PROXY_ENV_KEYS.some((k) => process.env[k])) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
  });
  if (child.error) {
    console.error(`ah: 带代理环境自重启失败：${child.error.message}`);
    process.exit(1);
  }
  process.exit(child.signal ? 128 + (os.constants.signals[child.signal] || 0) : (child.status ?? 1));
}

const { Kernel, loadConfig, DAEMON_VERSION } = await import("../src/kernel.mjs");

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function configDirFrom(argv) {
  const i = argv.indexOf("--config");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (process.env.AH_HOME) return process.env.AH_HOME;
  return path.join(os.homedir(), ".a2a-hub");
}

// 命令行写了 --role 就取出；没写返回 undefined。非法值抛错，不静默当成 node。
function specifiedRole(argv) {
  let value;
  let seen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--role") {
      seen = true;
      value = argv[i + 1] ?? "";
      i++;
    } else if (arg.startsWith("--role=")) {
      seen = true;
      value = arg.slice("--role=".length);
    }
  }
  if (!seen) return undefined;
  if (value !== "node" && value !== "hub") {
    throw new Error(`--role 只能是 node 或 hub，收到：${value || "(空)"}`);
  }
  return value;
}

// daemon / doctor / service 共用：命令行 --role 优先。
// 省略时读 node.json 的 role，没有该字段或读不到配置再缺省 node。
function roleForTool(argv) {
  const specified = specifiedRole(argv);
  if (specified) return specified;
  try {
    const file = path.join(configDirFrom(argv), "node.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw.role === "hub" || raw.role === "node") return raw.role;
  } catch { /* 读不到配置就按 node，doctor 会再报配置失败 */ }
  return "node";
}

// launchd KeepAlive 会在进程一退出就拉起。配置错误若立刻退出，会毫秒级刷屏。
function configErrorBackoffMs() {
  const raw = process.env.HUB_CONFIG_ERROR_BACKOFF_MS;
  if (raw == null || String(raw).trim() === "") return 5000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 5000;
  return Math.floor(n);
}

function readableConfigError(e, configDir) {
  const file = path.join(configDir, "node.json");
  if (e instanceof SyntaxError || e?.name === "SyntaxError") {
    const at = String(e.message).match(/position \d+ \(line \d+ column \d+\)/);
    return `${file} JSON 语法损坏${at ? "，" + at[0] : ""}`;
  }
  if (e?.code === "ENOENT") return `配置文件不可读：${e.message}`;
  return e?.message ? String(e.message) : String(e);
}

function acquireDaemonLock(configDir) {
  const lockPath = path.join(configDir, "daemon.lock");
  const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
  for (let attempt = 0; attempt < 5; attempt++) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let stat, pid;
      try {
        stat = fs.statSync(lockPath);
        pid = Number(fs.readFileSync(lockPath, "utf8").trim());
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      // 空文件可能是另一进程刚抢到锁、尚未写完；宁可拒绝启动，不误删活锁。
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error(`daemon 锁无有效 pid，请确认无守护进程后清理：${lockPath}`);
      }
      try {
        process.kill(pid, 0);
      } catch (e) {
        if (e.code !== "ESRCH") throw new Error(`daemon 锁 pid ${pid} 无法确认已退出：${e.code}`);
        try {
          if (sameFile(stat, fs.statSync(lockPath))) fs.unlinkSync(lockPath);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        continue;
      }
      throw new Error(`daemon 已在运行（pid ${pid}，锁：${lockPath}）`);
    }
    try {
      fs.writeFileSync(fd, String(process.pid) + "\n");
      const stat = fs.fstatSync(fd);
      return () => {
        try {
          if (sameFile(stat, fs.statSync(lockPath))) fs.unlinkSync(lockPath);
        } catch (e) {
          if (e.code !== "ENOENT") console.error("daemon 锁清理失败：" + e.message);
        }
      };
    } catch (e) {
      fs.unlinkSync(lockPath);
      throw e;
    } finally {
      fs.closeSync(fd);
    }
  }
  throw new Error(`daemon 锁竞争未完成，请稍后重试：${lockPath}`);
}

process.on("unhandledRejection", (e) => {
  console.error(new Date().toISOString().slice(0, 19), "unhandledRejection:", e?.message ?? e);
});

async function runDaemonLoop(configDir, role) {
  let release;
  let kernel = null;
  let hubRuntime = null;
  let agentDaemon = null;
  let signalCode;
  const onSignal = (signal) => {
    const code = signal === "SIGINT" ? 130 : 143;
    const ts = new Date().toISOString().slice(0, 19);
    if (signalCode != null) {
      console.error(`${ts} 再次收到 ${signal}，直接退出`);
      process.exit(code);
    }
    signalCode = code;
    if (agentDaemon) {
      console.error(`${ts} 收到 ${signal}，正在停止 Agent Gateway 守护进程`);
      agentDaemon.requestStop();
      return;
    }
    if (kernel) {
      console.error(`${ts} 收到 ${signal}，正在停止并标记 offline`);
      kernel.requestStop();
      return;
    }
    if (hubRuntime) {
      console.error(`${ts} 收到 ${signal}，hub 关闭长连接并退出`);
      try { hubRuntime.stop(); }
      catch (e) { console.error(`${ts} hub 停止失败：` + (e?.message ?? e)); }
      return;
    }
    // hub 路径在 ah 里不持有 Kernel；运行时还没建好时也要能退出。
    console.error(`${ts} 收到 ${signal}，守护进程退出`);
    process.exit(code);
  };
  try {
    release = acquireDaemonLock(configDir);
    process.once("exit", release);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    let cfg = null;
    try {
      cfg = loadConfig(configDir);
    } catch (e) {
      const backoffMs = configErrorBackoffMs();
      const ts = new Date().toISOString().slice(0, 19);
      console.error(`${ts} 配置加载失败：${readableConfigError(e, configDir)}`);
      console.error(`守护进程将退避 ${backoffMs}ms 后以非零状态退出，避免 launchd KeepAlive 毫秒级重启刷屏。请修正配置后再启动。`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      process.exitCode = 1;
      return;
    }
    if (cfg?.busType === "agent") {
      const { AgentDaemon } = await import("../src/agent-daemon.mjs");
      agentDaemon = new AgentDaemon(cfg);
      await agentDaemon.run();
      if (signalCode != null) process.exitCode = signalCode;
    } else if (cfg && role === "hub") {
      const { runHub } = await import("../src/hub/index.mjs");
      await runHub(cfg, undefined, { onRuntime(rt) { hubRuntime = rt; } });
      if (signalCode != null) process.exitCode = signalCode;
    } else if (cfg) {
      kernel = new Kernel(cfg);
      await kernel.run();
      if (signalCode != null) process.exitCode = signalCode;
    }
  } catch (e) {
    console.error("daemon 启动失败：" + e.message);
    process.exitCode = 1;
  } finally {
    if (release) {
      release();
      process.removeListener("exit", release);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  }
}

function parseJoinCliArgs(rest) {
  const valueFlags = new Set([
    "--config", "--node", "--zone", "--prefix", "--desc", "--kind",
    "--api-token", "--hub-key", "--hub-url", "--join",
    "--agent-role", "--token-file",
  ]);
  let joinTarget = "";
  const forwarded = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--no-daemon") continue;
    if (a === "--hub-url" || a === "--join") {
      joinTarget = rest[++i] ?? "";
      continue;
    }
    if (a.startsWith("--hub-url=")) {
      joinTarget = a.slice("--hub-url=".length);
      continue;
    }
    if (a.startsWith("--join=")) {
      joinTarget = a.slice("--join=".length);
      continue;
    }
    if (valueFlags.has(a)) {
      forwarded.push(a);
      if (rest[i + 1] != null) forwarded.push(rest[++i]);
      continue;
    }
    if (!a.startsWith("-") && !joinTarget) {
      joinTarget = a;
      continue;
    }
    forwarded.push(a);
  }
  return { joinTarget: String(joinTarget).trim(), forwarded };
}

function serviceOptions(rest, role) {
  let hasSystem = false;
  let hasUser = false;
  const hasEnsure = rest.includes("--ensure");
  const hasRemove = rest.includes("--remove");
  const hasUninstall = rest.includes("--uninstall");
  let name;
  let seenName = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--system") hasSystem = true;
    else if (a === "--user") hasUser = true;
    else if (a === "--name") {
      seenName = true;
      const next = rest[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error("--name 需要指定单元名称");
      }
      name = rest[++i];
    } else if (a.startsWith("--name=")) {
      seenName = true;
      name = a.slice("--name=".length);
      if (!name.trim()) {
        throw new Error("--name 不能为空");
      }
    }
  }
  if (hasSystem && hasUser) {
    throw new Error("不能同时指定 --system 与 --user");
  }
  if (hasEnsure && (hasRemove || hasUninstall)) {
    const conflict = hasRemove && hasUninstall ? "--remove/--uninstall" : hasRemove ? "--remove" : "--uninstall";
    throw new Error(`--ensure 与破坏性参数 ${conflict} 互斥，不能同时指定`);
  }
  const opts = { remove: hasRemove, ensure: hasEnsure, uninstall: hasUninstall, role };
  if (hasSystem) opts.scope = "system";
  else if (hasUser) opts.scope = "user";
  if (seenName) opts.name = name ?? "";
  return opts;
}

// 总用法表。printUsage 按子命令筛行，所以每行都以「  ah <子命令> 」开头。
const USAGE_LINES = [
  "  ah up      [--listen 0.0.0.0:8787] [--node mac-mini] [--service]  一行初始化并启动独立中台 Hub",
  "  ah join    http://[<token>@]<hub-ip>:8787 [--node worker-1] [--agent] [--agent-role worker|leader] [--token-file <path>] [--service]  一行接入远端 Hub；--agent 走 Agent Gateway",
  "  ah setup   [--config <dir>] [--role node|hub] [--bus sqlite|http|agent] [--kind host|agent] [--agent] [--agent-role worker|leader] [--token-file <path>] [--hub] [--join <url>] [--skip-skill]  一键配置向导",
  "  ah daemon  [--config <dir>] [--role node|hub]  常驻守护进程（省略 --role 时读 node.json，缺省 node）",
  "  ah reconcile [--config <dir>]  单次回表认领/对账后退出（不长驻；不停派、不改写命令表外的手工名片）",
  "  ah inventory [--config <dir>]  只读盘点本节点名片与任务，不写入",
  "  ah doctor  [--config <dir>] [--role node|hub]  本机自检",
  "  ah service [--config <dir>] [--role node|hub] [--system|--user] [--name <unit>] [--ensure]  注册开机自启（--ensure 幂等自愈；--remove 卸载）",
  "  ah update  [--check] [--skip-skill] [--config <dir>]  自更新程序本体（git pull + 依赖重装 + 软链/Skill 补齐）",
  "  ah inbox   [--pop] [--limit <n>] [--json]    读取专属 Agent 收件箱（--pop 提取并标为 acked；--limit 只取前 n 条 pending）",
  "  ah inbox done --task <Task_ID> --text <处理结果> [--artifact <路径或URL>]... [--check <id>=<pass|fail|blocked>[:<证据>]]",
  "  ah inbox ask  --task <Task_ID> --text <补充提问> [--file <路径>]...",
  "  ah inbox fail --task <Task_ID> --text <失败原因>",
  "  ah inbox auth --task <Task_ID> --text <具体动作、对象与风险> [--file <路径>]...",
  "  ah task create --to <node> [--worker <worker>] [--model <opaque-id>] [--cap/--skill <cap_id>] [--text <指令>] [--from <node>] [--params <json 或 @文件>] [--criteria <json 数组或 @文件>] [--idempotency-key <键>] [--file <路径>]...",
  "  ah task reply  --task <Task_ID> [--text <答复内容>] [--file <路径>]...",
  "  ah task show   <Task_ID>",
  "  ah task why    <Task_ID> [--config <dir>] [--json]",
  "  ah task cancel --task <Task_ID> [--text <说明>] [--config <dir>]",
  "  ah task begin  --schedule <id> [--period <期次键>] [--cap <cap_id>] [--text <指令>]  Agent 定时触发",
  "  ah loop templates  列出内置 SOP 闭环模板",
  "  ah loop create --goal <目标> --to <node> [--template plan-code-verify] [--cap <cap_id>] [--stages @sop.json]  创建 LoopForge SOP 闭环",
  "  ah loop ls [--json]  列出 SOP 闭环",
  "  ah loop show <Loop_ID>  查看 SOP 闭环详情",
  "  ah loop cancel <Loop_ID> [--text <说明>]  取消 SOP 闭环",
  "  ah schedule ls [--config <dir>] [--json]  列出本机定时调度计划",
  "  ah schedule add --id <id> --cron \"<五段>\" --cap <cap_id> --text <指令> [--approval auto|notify|approve] [--disabled]  添加本机定时计划",
  "  ah schedule rm <id> [--config <dir>]  删除本机计划",
  "  ah schedule enable|disable <id> [--config <dir>]  启用/停用本机计划",
  "  ah schedule register --id <id> --cron \"<五段>\" --cap <cap_id> [--text <指令>]  登记 Agent 观察镜像（不写本机计划）",
  "  ah present [--pop] [--task <Task_ID>] [--wait <秒>]  读取本机结果呈递队列"
];

const [cmd, ...rest] = process.argv.slice(2);

// 带副作用的子命令（service、update、setup 等）以前不认 --help，会直接执行。
// 只要出现 --help / -h 就只打印用法，绝不往下分发。
const wantsHelp = cmd === "help" || cmd === "--help" || cmd === "-h" || rest.includes("--help") || rest.includes("-h");

if (wantsHelp) {
  printUsage(cmd === "help" ? rest[0] : cmd);
} else if (cmd === "up") {
  const configDir = path.resolve(configDirFrom(rest));
  const hasNodeJson = fs.existsSync(path.join(configDir, "node.json"));
  const needSetup = !hasNodeJson || rest.includes("--force") || rest.includes("--setup");
  let setupCode = 0;
  if (needSetup) {
    const { runSetup } = await import("../src/setup.mjs");
    const setupArgs = [
      "--role", "hub",
      "--bus", "sqlite",
      "--yes",
      "--auto-token",
      ...rest.filter((a) => a !== "--no-daemon" && a !== "--setup"),
    ];
    setupCode = await runSetup(configDir, setupArgs, APP_DIR);
  } else if (rest.includes("--service")) {
    const { service } = await import("../src/service.mjs");
    setupCode = await service(configDir, { role: "hub" }, APP_DIR);
  }
  if (setupCode !== 0) {
    process.exitCode = setupCode;
  } else if (!rest.includes("--service") && !rest.includes("--no-daemon")) {
    await runDaemonLoop(configDir, "hub");
  }
} else if (cmd === "join") {
  const { joinTarget, forwarded } = parseJoinCliArgs(rest);
  if (!joinTarget) {
    console.error("用法：ah join http://[<token>@]<hub-ip>:8787 [--node <名>] [--service]");
    process.exitCode = 1;
  } else {
    const configDir = path.resolve(configDirFrom(rest));
    const { runSetup } = await import("../src/setup.mjs");
    // join 的语义就是「接入或重新接入这个 Hub」，重复执行要能刷新地址、Token 与公钥，所以总是覆盖 node.json。
    const agentJoin = rest.includes("--agent");
    const setupArgs = [
      "--role", "node",
      "--join", joinTarget,
      "--yes",
      "--force",
      ...forwarded,
      "--bus", agentJoin ? "agent" : "http",
    ];
    if (agentJoin) setupArgs.push("--agent");
    const setupCode = await runSetup(configDir, setupArgs, APP_DIR);
    if (setupCode !== 0) {
      process.exitCode = setupCode;
    } else if (!rest.includes("--service") && !rest.includes("--no-daemon")) {
      await runDaemonLoop(configDir, "node");
    }
  }
} else if (cmd === "setup") {
  const { runSetup } = await import("../src/setup.mjs");
  process.exitCode = await runSetup(configDirFrom(rest), rest, APP_DIR);
} else if (cmd === "reconcile") {
  let role;
  try {
    role = roleForTool(rest);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
  if (role === "hub") {
    console.error("ah reconcile 只支持节点一次对账；hub 请继续用 ah daemon --role hub");
    process.exitCode = 2;
  } else if (role) try {
    const cfg = loadConfig(path.resolve(configDirFrom(rest)));
    if (cfg.busType === "agent") {
      const { AgentDaemon } = await import("../src/agent-daemon.mjs");
      await new AgentDaemon(cfg).run({ once: true });
    } else {
      await new Kernel(cfg).run({ once: true });
    }
  } catch (e) {
    console.error("reconcile 失败：" + e.message);
    process.exitCode = 1;
  }
} else if (cmd === "inventory") {
  try {
    const { inventory } = await import("../src/inventory.mjs");
    process.exitCode = await inventory(configDirFrom(rest));
  } catch (e) {
    console.error("inventory 失败：" + e.message);
    process.exitCode = 1;
  }
} else if (cmd === "daemon") {
  let role;
  try {
    role = roleForTool(rest);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
  if (role) {
    await runDaemonLoop(path.resolve(configDirFrom(rest)), role);
  }
} else if (cmd === "doctor") {
  let role;
  try {
    role = roleForTool(rest);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
  if (role) {
    const { doctor } = await import("../src/doctor.mjs");
    let code = await doctor(configDirFrom(rest), APP_DIR, { role });
    if (role === "hub") {
      const { hubDoctor } = await import("../src/hub/index.mjs");
      const extra = await hubDoctor(configDirFrom(rest));
      if (extra) code = 1;
    }
    process.exitCode = code;
  }
} else if (cmd === "host") {
  // 不落成「未知命令」：老用户可能还在终端里跑它，要明确告知是被移除而不是拼错。
  console.error("ah host 已移除：carrier 执行语境不再支持。请把 commands.json 里 context=\"carrier\" 的能力改为 direct 或删除。");
  process.exitCode = 1;
} else if (cmd === "service") {
  let role;
  let opts;
  try {
    role = roleForTool(rest);
    opts = serviceOptions(rest, role);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
  if (role && opts) {
    const { service } = await import("../src/service.mjs");
    process.exitCode = await service(configDirFrom(rest), opts, APP_DIR);
  }
} else if (cmd === "task") {
  const sub = rest[0];
  if (sub === "create") {
    try {
      const { parseCreateArgv, parseParams, parseCriteriaInput, createTask } = await import("../src/hub/create.mjs");
      const args = parseCreateArgv(rest.slice(1));
      const parsedParams = parseParams(args.paramsRaw);
      const parsedCriteria = parseCriteriaInput(args.criteriaRaw);
      if (parsedParams && Object.prototype.hasOwnProperty.call(parsedParams, "acceptance")) {
        const { parseCriteria } = await import("../src/acceptance.mjs");
        const check = parseCriteria(parsedParams);
        if (!check.ok) throw new Error("拒绝建单：" + check.error);
      }
      const cfg = loadConfig(args.configDir || configDirFrom(rest), { forCli: true });
      if (cfg.busType === "agent") {
        const { agentTaskCreate } = await import("../src/agent-cli.mjs");
        const taskId = await agentTaskCreate(cfg, args, { params: parsedParams, criteria: parsedCriteria });
        console.log(taskId);
      } else {
      // --file 先经文件客户端上传，再把 hub:// 放进 attachments；上传失败在建单前就停。
      let attachments;
      if (args.files.length) {
        const { createFileClient } = await import("../src/files-client.mjs");
        const { uploadLocalFiles } = await import("../src/attachments.mjs");
        const client = createFileClient(cfg);
        try { attachments = await uploadLocalFiles(args.files, client); } finally { client.close?.(); }
      }
      const taskId = await createTask({
        bus: cfg.bus,
        from: args.from || cfg.node,
        source: args.source || args.from || cfg.node,
        to: args.to,
        cap: args.cap,
        worker: args.worker,
        requested_model: args.requested_model,
        text: args.text,
        params: args.paramsRaw,
        criteria: args.criteriaRaw,
        context: args.context,
        ref: args.ref,
        approval: args.approval,
        idempotencyKey: args.idempotencyKey,
        validateTarget: true,
        attachments,
      });
      console.log(taskId);
      }
    } catch (e) {
      console.error(e?.message ?? e);
      process.exitCode = 1;
    }
  } else if (sub === "reply") {
    const argv = rest.slice(1);
    let taskId = "";
    let text = "";
    let configDir = "";
    const replyFiles = [];
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--task") taskId = argv[++i] ?? "";
      else if (flag === "--text") text = argv[++i] ?? "";
      else if (flag === "--file") replyFiles.push(argv[++i] ?? "");
      else if (flag === "--config") configDir = argv[++i] ?? "";
      else if (!flag.startsWith("--") && !taskId) taskId = flag;
    }
    if (!taskId) {
      console.error("用法：ah task reply --task <Task_ID> [--text <答复内容>] [--file <路径>]...");
      process.exitCode = 1;
    } else if (!text && !replyFiles.length) {
      console.error("ah task reply 需要 --text <答复内容> 或 --file <路径>");
      process.exitCode = 1;
    } else {
      try {
        const cfg = loadConfig(configDir || configDirFrom(rest), { forCli: true });
        if (cfg.busType === "agent") {
          const { agentTaskReply } = await import("../src/agent-cli.mjs");
          const res = await agentTaskReply(cfg, { taskId, text, files: replyFiles.filter(Boolean) });
          console.log(`已答复：${res?.msg_id || ""}`);
        } else {
        const { f1 } = await import("../src/bus/tables.mjs");
        const tasks = await cfg.bus.listRecords(cfg.bus.tables.tasks);
        const task = tasks.find((t) => f1(t, "Task_ID") === taskId);
        if (!task) throw new Error(`任务不存在：${taskId}`);
        const status = f1(task, "Status");
        if (status !== "input-required") {
          throw new Error(`任务当前状态为 ${status}，不是 input-required，无法答复。`);
        }
        const statusMsg = String(f1(task, "Status_Msg") ?? "").trim();
        const messages = (await cfg.bus.listRecords(cfg.bus.tables.messages))
          .filter((m) => f1(m, "Task_ID") === taskId);
        let max = 0;
        for (const m of messages) {
          const id = String(f1(m, "Msg_ID") ?? "");
          const matched = id.match(/-(\d+)$/);
          if (matched) {
            const n = Number(matched[1]);
            if (n > max) max = n;
          }
        }
        const seq = max + 1;
        const msgId = `MSG-${taskId.replace("TASK-", "")}-${String(seq).padStart(2, "0")}`;
        const d = new Date();
        const p = (n) => String(n).padStart(2, "0");
        const nowMinute = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;

        // 先上传、校验，任何失败都发生在第一笔写之前。
        let attachments = [];
        if (replyFiles.length) {
          const { createFileClient } = await import("../src/files-client.mjs");
          const { uploadLocalFiles, normalizeAttachments } = await import("../src/attachments.mjs");
          const client = createFileClient(cfg);
          try { attachments = normalizeAttachments(await uploadLocalFiles(replyFiles, client)); } finally { client.close?.(); }
        }
        let nextSeq = 1;
        if (text) {
          await cfg.bus.createRecord(cfg.bus.tables.parts, {
            Part_ID: `${msgId}-P1`,
            Parent_ID: msgId,
            Parent_Type: "message",
            Seq: 1,
            Kind: "text",
            Text: text.slice(0, 4000),
          });
          nextSeq = 2;
        }
        const { appendFileParts } = await import("../src/attachments.mjs");
        await appendFileParts(cfg.bus, msgId, nextSeq, attachments);
        await cfg.bus.createRecord(cfg.bus.tables.messages, {
          Msg_ID: msgId,
          Task_ID: taskId,
          Context_ID: f1(task, "Context_ID"),
          From_Node: cfg.node,
          To_Node: f1(task, "Target_Node"),
          Role: "user",
          Kind: "answer",
          In_Reply_To: statusMsg,
          Created_At: nowMinute,
        });
        console.log(`已答复：${msgId}`);
        }
      } catch (e) {
        console.error(e?.message ?? e);
        process.exitCode = 1;
      }
    }
  } else if (sub === "show") {
    const argv = rest.slice(1);
    let taskId = "";
    let configDir = "";
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--task") taskId = argv[++i] ?? "";
      else if (flag === "--config") configDir = argv[++i] ?? "";
      else if (!flag.startsWith("--") && !taskId) taskId = flag;
    }
    if (!taskId) {
      console.error("用法：ah task show <Task_ID> [--config <dir>]");
      process.exitCode = 1;
    } else {
      try {
        const cfg = loadConfig(configDir || configDirFrom(rest), { forCli: true });
        if (cfg.busType === "agent") {
          const { agentTaskShow } = await import("../src/agent-cli.mjs");
          console.log(JSON.stringify(await agentTaskShow(cfg, taskId), null, 2));
        } else {
        const { f1 } = await import("../src/bus/tables.mjs");
        const { messageText } = await import("../src/hub/cards.mjs");
        const tasks = await cfg.bus.listRecords(cfg.bus.tables.tasks);
        const task = tasks.find((t) => f1(t, "Task_ID") === taskId);
        if (!task) throw new Error(`任务不存在：${taskId}`);
        const messages = (await cfg.bus.listRecords(cfg.bus.tables.messages))
          .filter((m) => f1(m, "Task_ID") === taskId);
        const parts = await cfg.bus.listRecords(cfg.bus.tables.parts);
        const artifacts = cfg.bus.tables.artifacts
          ? (await cfg.bus.listRecords(cfg.bus.tables.artifacts)).filter((a) => f1(a, "Task_ID") === taskId)
          : [];

        const lastMsg = messages.length ? messages[messages.length - 1] : null;
        const lastMsgText = lastMsg ? messageText(parts, f1(lastMsg, "Msg_ID")) : "";

        const out = {
          task_id: taskId,
          title: f1(task, "Title"),
          status: f1(task, "Status"),
          skill_id: f1(task, "Skill_ID"),
          target_node: f1(task, "Target_Node"),
          source: f1(task, "Source"),
          status_msg: f1(task, "Status_Msg"),
          retry_count: f1(task, "Retry_Count"),
          claimed_by: f1(task, "Claimed_By"),
          last_message: lastMsg ? {
            msg_id: f1(lastMsg, "Msg_ID"),
            kind: f1(lastMsg, "Kind"),
            from: f1(lastMsg, "From_Node"),
            to: f1(lastMsg, "To_Node"),
            role: f1(lastMsg, "Role"),
            text: lastMsgText,
          } : null,
          artifacts: artifacts.map((a) => ({
            artifact_id: f1(a, "Artifact_ID"),
            name: f1(a, "Name"),
            description: f1(a, "Description"),
          })),
        };
        console.log(JSON.stringify(out, null, 2));
        }
      } catch (e) {
        console.error(e?.message ?? e);
        process.exitCode = 1;
      }
    }
  } else if (sub === "why") {
    const argv = rest.slice(1);
    let taskId = "";
    let configDir = "";
    let isJson = false;
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--task") taskId = argv[++i] ?? "";
      else if (flag === "--config") configDir = argv[++i] ?? "";
      else if (flag === "--json") isJson = true;
      else if (!flag.startsWith("--") && !taskId) taskId = flag;
    }
    if (!taskId) {
      console.error("用法：ah task why <Task_ID> [--config <dir>] [--json]");
      process.exitCode = 1;
    } else {
      try {
        const { getTaskWhy, formatWhyText } = await import("../src/why.mjs");
        const effectiveConfigDir = configDir || configDirFrom(rest);
        const cfg = loadConfig(effectiveConfigDir, { forCli: true });
        const data = await getTaskWhy({ bus: cfg.bus, configDir: effectiveConfigDir, taskId });
        if (isJson) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(formatWhyText(data));
        }
      } catch (e) {
        console.error(e?.message ?? e);
        process.exitCode = 1;
      }
    }
  } else if (sub === "cancel") {
    const argv = rest.slice(1);
    let taskId = "";
    let text = "";
    let configDir = "";
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--task") taskId = argv[++i] ?? "";
      else if (flag === "--text") text = argv[++i] ?? "";
      else if (flag === "--config") configDir = argv[++i] ?? "";
      else if (!flag.startsWith("--") && !taskId) taskId = flag;
    }
    if (!taskId) {
      console.error("用法：ah task cancel --task <Task_ID> [--text <说明>] [--config <dir>]");
      process.exitCode = 1;
    } else {
      try {
        const cfg = loadConfig(configDir || configDirFrom(rest), { forCli: true });
        if (cfg.busType === "agent") {
          const { agentTaskCancel } = await import("../src/agent-cli.mjs");
          const result = await agentTaskCancel(cfg, { taskId, text });
          console.log(`已取消：${result.taskId}`);
          if (result.workingHint) console.log(result.workingHint);
        } else {
        const { cancelTask } = await import("../src/hub/cancel.mjs");
        // 角色只认 node.json。命令行 --role 不能把 node 提升成可撤任意单的 hub。
        const result = await cancelTask({
          bus: cfg.bus,
          node: cfg.node,
          role: cfg.role === "hub" ? "hub" : "node",
          taskId,
          text,
        });
        console.log(`已取消：${result.taskId}`);
        if (result.workingHint) console.log(result.workingHint);
        }
      } catch (e) {
        console.error(e?.message ?? e);
        process.exitCode = 1;
      }
    }
  } else if (sub === "begin") {
    const { handleTaskBegin } = await import("../src/schedule-cli.mjs");
    process.exitCode = await handleTaskBegin(rest.slice(1), { configDir: configDirFrom(rest) });
  } else {
    console.error("用法：ah task create | reply | show | why | cancel | begin");
    process.exitCode = 1;
  }
} else if (cmd === "inbox") {
  const sub = rest[0];
  const configDir = configDirFrom(rest);
  if (sub === "done") {
    const argv = rest.slice(1);
    let taskId = "";
    let text = "";
    const artifacts = [];
    let cfgDir = "";
    const rawChecks = [];
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--task") taskId = argv[++i] ?? "";
      else if (flag === "--text") text = argv[++i] ?? "";
      else if (flag === "--artifact") artifacts.push(argv[++i] ?? "");
      else if (flag === "--config") cfgDir = argv[++i] ?? "";
      else if (flag === "--check") rawChecks.push(argv[++i] ?? "");
      else if (!flag.startsWith("--") && !taskId) taskId = flag;
    }
    if (!taskId) {
      console.error("用法：ah inbox done --task <Task_ID> --text <处理结果> [--artifact <路径>] [--check <id>=<pass|fail|blocked>[:<证据>]]");
      process.exitCode = 1;
    } else {
      try {
        const { parseCheckFlag } = await import("../src/acceptance.mjs");
        const checks = rawChecks.map((raw) => parseCheckFlag(raw));
        const cfg = loadConfig(cfgDir || configDir, { forCli: true });
        if (cfg.busType === "agent") {
          const { agentInboxCommand } = await import("../src/agent-cli.mjs");
          await agentInboxCommand(cfg, { op: "done", taskId, text, files: artifacts.filter(Boolean), checks });
        } else {
          const { handleInboxDone } = await import("../src/inbox.mjs");
          const { createFileClient } = await import("../src/files-client.mjs");
          // 本地存在的产物在提交阶段上传成 hub://；文件客户端懒创建，没有本地文件时不碰 FileStore。
          let client = null;
          try {
            await handleInboxDone({
              configDir: cfgDir || configDir, bus: cfg.bus, node: cfg.node, taskId, text,
              artifacts: artifacts.filter(Boolean), checks,
              getFileClient: () => (client ??= createFileClient(cfg)),
            });
          } finally { client?.close?.(); }
        }
        console.log(`✓ 任务 ${taskId} 已完成并上报总线`);
      } catch (e) {
        console.error(e?.message ?? e);
        process.exitCode = 1;
      }
    }
  } else if (sub === "ask") {
    const argv = rest.slice(1);
    let taskId = "";
    let text = "";
    let cfgDir = "";
    const askFiles = [];
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--task") taskId = argv[++i] ?? "";
      else if (flag === "--text") text = argv[++i] ?? "";
      else if (flag === "--file") askFiles.push(argv[++i] ?? "");
      else if (flag === "--config") cfgDir = argv[++i] ?? "";
      else if (!flag.startsWith("--") && !taskId) taskId = flag;
    }
    if (!taskId || !text) {
      console.error("用法：ah inbox ask --task <Task_ID> --text <需要用户/发起方补充的信息> [--file <路径>]...");
      process.exitCode = 1;
    } else {
      try {
        const cfg = loadConfig(cfgDir || configDir, { forCli: true });
        if (cfg.busType === "agent") {
          const { agentInboxCommand } = await import("../src/agent-cli.mjs");
          await agentInboxCommand(cfg, { op: "ask", taskId, text, files: askFiles.filter(Boolean) });
        } else {
          const { handleInboxAsk } = await import("../src/inbox.mjs");
          const { createFileClient } = await import("../src/files-client.mjs");
          let client = null;
          try {
            await handleInboxAsk({
              configDir: cfgDir || configDir, bus: cfg.bus, node: cfg.node, taskId, text,
              files: askFiles.filter(Boolean), getFileClient: () => (client ??= createFileClient(cfg)),
            });
          } finally { client?.close?.(); }
        }
        console.log(`✓ 任务 ${taskId} 已转入 input-required 并向发起方提问`);
      } catch (e) {
        console.error(e?.message ?? e);
        process.exitCode = 1;
      }
    }
  } else if (sub === "auth") {
    const argv = rest.slice(1);
    let taskId = "";
    let text = "";
    let cfgDir = "";
    const authFiles = [];
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--task") taskId = argv[++i] ?? "";
      else if (flag === "--text") text = argv[++i] ?? "";
      else if (flag === "--file") authFiles.push(argv[++i] ?? "");
      else if (flag === "--config") cfgDir = argv[++i] ?? "";
      else if (!flag.startsWith("--") && !taskId) taskId = flag;
    }
    if (!taskId || !text.trim()) {
      console.error("用法：ah inbox auth --task <Task_ID> --text <具体动作、对象与风险> [--file <路径>]...");
      process.exitCode = 1;
    } else {
      try {
        const cfg = loadConfig(cfgDir || configDir, { forCli: true });
        if (cfg.busType === "agent") {
          const { agentInboxCommand } = await import("../src/agent-cli.mjs");
          await agentInboxCommand(cfg, { op: "auth", taskId, text, files: authFiles.filter(Boolean) });
        } else {
          const { handleInboxAuth } = await import("../src/inbox.mjs");
          const { createFileClient } = await import("../src/files-client.mjs");
          let client = null;
          try {
            await handleInboxAuth({
              configDir: cfgDir || configDir, bus: cfg.bus, node: cfg.node, taskId, text,
              files: authFiles.filter(Boolean), getFileClient: () => (client ??= createFileClient(cfg)),
            });
          } finally { client?.close?.(); }
        }
        console.log(`✓ 任务 ${taskId} 已请求机主批准`);
      } catch (e) {
        console.error(e?.message ?? e);
        process.exitCode = 1;
      }
    }
  } else if (sub === "fail") {
    const argv = rest.slice(1);
    let taskId = "";
    let text = "";
    let cfgDir = "";
    const failFiles = [];
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--task") taskId = argv[++i] ?? "";
      else if (flag === "--text") text = argv[++i] ?? "";
      else if (flag === "--file" || flag === "--artifact") failFiles.push(argv[++i] ?? "");
      else if (flag === "--config") cfgDir = argv[++i] ?? "";
      else if (!flag.startsWith("--") && !taskId) taskId = flag;
    }
    if (!taskId) {
      console.error("用法：ah inbox fail --task <Task_ID> --text <失败原因>");
      process.exitCode = 1;
    } else {
      try {
        const cfg = loadConfig(cfgDir || configDir, { forCli: true });
        if (cfg.busType === "agent") {
          const { agentInboxCommand } = await import("../src/agent-cli.mjs");
          await agentInboxCommand(cfg, { op: "fail", taskId, text: text || "执行失败", files: failFiles.filter(Boolean) });
        } else {
          const { handleInboxFail } = await import("../src/inbox.mjs");
          await handleInboxFail({ configDir: cfgDir || configDir, bus: cfg.bus, node: cfg.node, taskId, text: text || "执行失败" });
        }
        console.log(`✓ 任务 ${taskId} 已置 failed 并上报原因`);
      } catch (e) {
        console.error(e?.message ?? e);
        process.exitCode = 1;
      }
    }
  } else {
    // ah inbox [--pop] [--limit <n>] [--json]
    const isPop = rest.includes("--pop");
    const isJson = rest.includes("--json");
    let limit = 0;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--limit") {
        const n = Number(rest[i + 1]);
        limit = Number.isFinite(n) ? n : 0;
      }
    }
    try {
      const { popPendingInbox, readInbox } = await import("../src/inbox.mjs");
      const items = (isPop || limit > 0)
        ? popPendingInbox(configDir, { pop: isPop, limit })
        : readInbox(configDir);
      if (isJson) {
        console.log(JSON.stringify(items, null, 2));
      } else {
        for (const item of items) {
          console.log(JSON.stringify(item));
        }
      }
    } catch (e) {
      console.error("读取 agent_inbox.jsonl 失败：" + (e?.message ?? e));
      process.exitCode = 1;
    }
  }
} else if (cmd === "present") {
  const { handlePresentCli } = await import("../src/present-queue.mjs");
  process.exitCode = await handlePresentCli(rest, { configDir: configDirFrom(rest) });
} else if (cmd === "loop") {
  try {
    const { runLoopCli } = await import("../src/loop-cli.mjs");
    process.exitCode = await runLoopCli(rest, configDirFrom(rest));
  } catch (e) {
    console.error(e?.message ?? e);
    process.exitCode = 1;
  }
} else if (cmd === "schedule") {
  const { handleScheduleCli } = await import("../src/schedule-cli.mjs");
  process.exitCode = await handleScheduleCli(rest, { configDir: configDirFrom(rest) });
} else if (cmd === "update") {
  const { update } = await import("../src/update.mjs");
  process.exitCode = await update(APP_DIR, {
    check: rest.includes("--check"),
    skipSkill: rest.includes("--skip-skill"),
    configDir: path.resolve(configDirFrom(rest)),
  });
} else if (cmd === "--version" || cmd === "-v") {
  console.log(DAEMON_VERSION);
} else {
  printUsage();
}

function printUsage(only) {
  const lines = USAGE_LINES;
  const picked = only && !only.startsWith("-") ? lines.filter((l) => l.startsWith(`  ah ${only} `) || l.startsWith(`  ah ${only}\t`)) : [];
  console.log(`ah ${DAEMON_VERSION}\n用法：\n${(picked.length ? picked : lines).join("\n")}`);
}
