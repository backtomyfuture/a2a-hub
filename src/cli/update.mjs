// ah update —— 自更新程序本体。
// 等价于重跑 install.sh / install.ps1 的「更新已有安装」分支：git pull + 依赖重装 +
// 入口补齐 + Skill 重拷，但不碰配置目录里的任何文件。
// 只支持 git 检出（安装脚本装出来的就是）：tarball 装的没有 .git，
// 让用户重跑安装脚本，而不是在这里再实现一遍下载解包。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { resolveSkillsForHost } from "./setup.mjs";

// git / npm 输出直接透传：npm ci 可能要几分钟，静默会像卡死。
function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function capture(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
}

function readAppVersion(appDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")).version ?? "?";
  } catch {
    return "?";
  }
}

// 软链只在缺失时补建、指向别处时警告：install.sh 的软链指向 $APP/bin/，
// git pull 后路径不变，本来就不用刷新；指向别处说明用户自管入口，不抢。
// Windows 入口是 install.ps1 写的 ah.cmd（相对路径指向 app\bin\ah.mjs），
// 不在这里建 Unix 软链：未开开发者模式时会抛错，把已经完成的更新报成失败。
function ensureSymlink(target, link) {
  const name = path.basename(link);
  try {
    const cur = fs.readlinkSync(link);
    if (path.resolve(path.dirname(link), cur) === target) return "ok";
    return "other";
  } catch (e) {
    if (e.code === "ENOENT") return "missing";
    if (e.code === "EINVAL") return "other"; // 已存在但不是软链
    throw e;
  }
}

function ensureEntrySymlinks(appDir) {
  if (process.platform === "win32") {
    console.log("  · Windows 命令入口由 install.ps1 维护，本次不重建");
    return;
  }
  const binDir = path.join(os.homedir(), ".local", "bin");
  const entry = path.join(appDir, "bin", "ah.mjs");
  for (const name of ["ah", "a2a-hub", "ahub"]) {
    const link = path.join(binDir, name);
    const state = ensureSymlink(entry, link);
    if (state === "missing") {
      fs.mkdirSync(binDir, { recursive: true });
      fs.symlinkSync(entry, link);
      console.log(`  ✓ 已补建软链 ${link}`);
    } else if (state === "other") {
      console.log(`  · ${link} 未指向本次安装，保持不动`);
    }
  }
}

export function refreshSkill(
  appDir,
  skip,
  configDir = "",
  skillsRoot = path.join(os.homedir(), ".agents", "skills"),
) {
  if (skip) {
    console.log("  · 跳过 ah Skill 更新（--skip-skill）");
    return [];
  }
  try {
    const wanted = new Set();
    const cfgFile = configDir && fs.existsSync(path.join(configDir, "config.json"))
      ? path.join(configDir, "config.json")
      : configDir
        ? path.join(configDir, "node.json")
        : "";
    if (cfgFile && fs.existsSync(cfgFile)) {
      const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
      for (const name of resolveSkillsForHost({
        mode: cfg.mode || (cfg.role === "hub" ? "hub" : "device"),
        agentRole: cfg.agentRole ?? cfg.agent_role,
      })) {
        wanted.add(name);
      }
    }
    // 未传 configDir 时，同步刷新本机已装过的 CLI Skill；若均未安装则默认补全主控 ah
    for (const [installedName, targetName] of [
      ["ah", "ah"],
      ["ah-inbox", "ah-inbox"],
    ]) {
      if (fs.existsSync(path.join(skillsRoot, installedName, "SKILL.md"))) {
        wanted.add(targetName);
      }
    }
    if (wanted.size === 0) {
      for (const name of resolveSkillsForHost({ mode: "hub" })) {
        wanted.add(name);
      }
    }
    const updated = [];
    for (const name of wanted) {
      const src = path.join(appDir, "skills", name, "SKILL.md");
      if (!fs.existsSync(src)) continue;
      const destDir = path.join(skillsRoot, name);
      fs.mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, "SKILL.md");
      fs.copyFileSync(src, dest);
      updated.push(name);
      console.log(`  ✓ 已更新 ${name} Skill 至 ${dest}`);
    }
    return updated;
  } catch (e) {
    console.log(`  · ah Skill 更新跳过：${e.message}`);
    return [];
  }
}

// 守护进程还在跑时只提示、不强杀：进程退出是用户的决定，杀掉可能打断在途任务。
function daemonHint(configDir) {
  try {
    const pid = Number(fs.readFileSync(path.join(configDir, "daemon.lock"), "utf8").trim());
    if (Number.isSafeInteger(pid) && pid > 0) {
      process.kill(pid, 0);
      console.log(`  · 守护进程仍在运行（pid ${pid}），新版本要等重启后才生效`);
    }
  } catch {
    /* 没在跑或读不到锁，都不用提示 */
  }
}

// 通过独立子进程执行磁盘上最新的 bin/ah.mjs service，避免更新前已加载进内存的旧模块逻辑生效。
export function runFreshService(
  appDir,
  configDir = "",
  { execPath = process.execPath, spawnSyncFn = spawnSync, env = process.env } = {}
) {
  const appBin = path.join(appDir, "bin", "ah.mjs");
  const args = [appBin, "service", ...(configDir ? ["--config", configDir] : [])];
  const childEnv = { ...env };
  delete childEnv.__AH_UPDATE_POST_PULL;
  delete childEnv.__AH_UPDATE_FROM;
  const res = spawnSyncFn(execPath, args, {
    stdio: "inherit",
    windowsHide: true,
    env: childEnv,
  });
  if (res?.error) {
    console.error(`拉起新版 ah service 失败：${res.error.message}`);
    return 1;
  }
  return typeof res?.status === "number" ? res.status : 1;
}

async function finishUpdate({
  appDir,
  before,
  skipSkill = false,
  configDir = "",
  runFn = run,
  fsImpl = fs,
  isDaemonRunningFn = isDaemonRunning,
  hasInstalledServiceFn = hasInstalledService,
  runServiceFn = (dir, cfg) => runFreshService(dir, cfg),
}) {
  const after = readAppVersion(appDir);
  let hasDeps = false;
  try {
    const pkg = JSON.parse(fsImpl.readFileSync(path.join(appDir, "package.json"), "utf8"));
    hasDeps = Object.keys(pkg.dependencies || {}).length > 0;
  } catch {}
  if (hasDeps) {
    try {
      if (fsImpl.existsSync(path.join(appDir, "package-lock.json"))) {
        runFn("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], appDir);
      } else {
        runFn("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], appDir);
      }
    } catch (e) {
      console.error("依赖安装失败：" + e.message);
      return 1;
    }
  }

  try {
    fsImpl.chmodSync(path.join(appDir, "bin", "ah.mjs"), 0o755);
  } catch (e) {
    console.log("  · bin 可执行位跳过：" + e.message);
  }

  ensureEntrySymlinks(appDir);
  refreshSkill(appDir, skipSkill, configDir);

  // 更新成功后自动刷新并重启守护进程：
  // 1) 守护进程仍在运行；或 2) 本机此前已注册过该 configDir 的自启服务（即使因关机取消或异常退出暂时停着，也应同步刷新启动器并拉起）。
  // 从未注册自启且进程未运行时仅打提示，不擅自安装开机服务。
  const running = Boolean(configDir && isDaemonRunningFn(configDir));
  const installed = Boolean(configDir && !running && hasInstalledServiceFn(configDir));
  if (configDir && (running || installed)) {
    console.log(
      running
        ? `更新完成：v${before} → v${after}。正在重启守护进程…`
        : `更新完成：v${before} → v${after}。检测到已配置自启服务但当前未运行，正在刷新并拉起守护进程…`
    );
    const rc = await runServiceFn(appDir, configDir);
    if (rc === 0) {
      console.log("守护进程已重启，新版本生效。");
    } else {
      console.error(`守护进程重启失败（exit ${rc}），请手动运行 ah service --config ${configDir}`);
      return rc;
    }
  } else {
    if (configDir) daemonHint(configDir);
    console.log(`更新完成：v${before} → v${after}。重启 ah daemon 后生效。`);
  }
  return 0;
}

export async function update(
  appDir,
  { check = false, skipSkill = false, configDir = "", postPull = false, fromVersion = "" } = {},
  _deps = {}
) {
  const runFn = _deps.runFn ?? run;
  const captureFn = _deps.captureFn ?? capture;
  const spawnSyncFn = _deps.spawnSyncFn ?? spawnSync;
  const execPath = _deps.execPath ?? process.execPath;
  const env = _deps.env ?? process.env;
  const fsImpl = _deps.fsImpl ?? fs;
  const isDaemonRunningFn = _deps.isDaemonRunningFn ?? isDaemonRunning;
  const hasInstalledServiceFn = _deps.hasInstalledServiceFn ?? hasInstalledService;
  const runServiceFn =
    _deps.runServiceFn ??
    ((dir, cfg) => runFreshService(dir, cfg, { execPath, spawnSyncFn, env }));

  // 由 git merge 后拉起的第二阶段子进程：跳过 fetch/merge，直接从磁盘全新加载的模块执行收尾与 ah service。
  if (postPull || env.__AH_UPDATE_POST_PULL === "1") {
    const before = String(fromVersion || env.__AH_UPDATE_FROM || readAppVersion(appDir));
    return await finishUpdate({
      appDir,
      before,
      skipSkill,
      configDir,
      runFn,
      fsImpl,
      isDaemonRunningFn,
      hasInstalledServiceFn,
      runServiceFn,
    });
  }

  if (!fsImpl.existsSync(path.join(appDir, ".git"))) {
    const installer = process.platform === "win32" ? "install.ps1" : "install.sh";
    console.error(`当前程序不是 git 检出（${appDir}），无法自动更新；请重跑 ${installer}。`);
    return 1;
  }

  const before = readAppVersion(appDir);

  // 跟当前分支走：install.sh 装的是 main，仓库检出可能停在别的分支，不写死。
  let branch;
  try {
    branch = captureFn("git", ["rev-parse", "--abbrev-ref", "HEAD"], appDir);
  } catch (e) {
    console.error("git 不可用或目录损坏：" + e.message);
    return 1;
  }
  if (!branch || branch === "HEAD") {
    console.error(`程序目录处于 detached HEAD，请先 git checkout 回分支再更新：${appDir}`);
    return 1;
  }

  try {
    runFn("git", ["fetch", "origin", branch], appDir);
  } catch (e) {
    console.error("git fetch 失败：" + e.message);
    return 1;
  }

  let behind = 0;
  try {
    behind = Number(captureFn("git", ["rev-list", "--count", "HEAD..FETCH_HEAD"], appDir)) || 0;
  } catch { /* 数不出来就按有更新处理，交给 pull 兜底 */ behind = 1; }

  if (check) {
    console.log(behind > 0
      ? `当前 v${before}，远端 ${branch} 有 ${behind} 个新提交。运行 ah update 升级。`
      : `已是最新（v${before}，分支 ${branch}）。`);
    return 0;
  }

  if (behind === 0) {
    const running = Boolean(configDir && isDaemonRunningFn(configDir));
    const installed = Boolean(configDir && !running && hasInstalledServiceFn(configDir));
    if (installed) {
      console.log(`已是最新（v${before}，分支 ${branch}）。检测到已配置自启服务但当前未运行，正在刷新并拉起守护进程…`);
      const rc = await runServiceFn(appDir, configDir);
      if (rc === 0) {
        console.log("守护进程已拉起，当前版本生效。");
      } else {
        console.error(`守护进程拉起失败（exit ${rc}），请手动运行 ah service --config ${configDir}`);
      }
      return rc;
    }
    console.log(`已是最新（v${before}，分支 ${branch}）。`);
    return 0;
  }

  console.log(`更新 ${branch}：${behind} 个新提交（v${before} → …）`);
  try {
    runFn("git", ["merge", "--ff-only", "FETCH_HEAD"], appDir);
  } catch (e) {
    console.error("git 合并失败（本地有改动时会拒绝快进）：" + e.message);
    return 1;
  }

  // merge 后硬盘已更新，拉起磁盘上最新 bin/ah.mjs update 执行收尾，确保新版本 update/service 逻辑立即生效。
  const appBin = path.join(appDir, "bin", "ah.mjs");
  if (_deps.reexecPostPullFn || fsImpl.existsSync(appBin)) {
    const args = [
      appBin,
      "update",
      ...(skipSkill ? ["--skip-skill"] : []),
      ...(configDir ? ["--config", configDir] : []),
    ];
    const childEnv = {
      ...env,
      __AH_UPDATE_POST_PULL: "1",
      __AH_UPDATE_FROM: String(before),
    };
    if (_deps.reexecPostPullFn) {
      return await _deps.reexecPostPullFn({ appDir, appBin, args, env: childEnv, skipSkill, configDir, fromVersion: before });
    }
    const res = spawnSyncFn(execPath, args, {
      stdio: "inherit",
      windowsHide: true,
      env: childEnv,
    });
    if (res?.error) {
      console.error(`拉起新版更新收尾进程失败，回退当前进程继续：${res.error.message}`);
    } else {
      return typeof res?.status === "number" ? res.status : 1;
    }
  }

  return await finishUpdate({
    appDir,
    before,
    skipSkill,
    configDir,
    runFn,
    fsImpl,
    isDaemonRunningFn,
    hasInstalledServiceFn,
    runServiceFn,
  });
}

// 读 daemon.lock 判断守护进程是否存活（PID 存在且 process.kill(pid,0) 不抛错，且锁文件不早于开机时间）。
function isDaemonRunning(configDir) {
  try {
    const lockPath = path.join(configDir, "daemon.lock");
    const st = fs.statSync(lockPath);
    const bootTimeMs = Date.now() - os.uptime() * 1000;
    if (st.mtimeMs > 0 && st.mtimeMs < bootTimeMs - 5000) return false;
    const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 判断本配置目录是否已经安装过后台自启服务（只读探测，不修改任何系统状态）。
export function hasInstalledService(
  configDir,
  { platform = process.platform, homeDir = os.homedir(), fsImpl = fs } = {}
) {
  if (!configDir) return false;
  if (platform === "win32") {
    try {
      const svcDir = path.join(configDir, "service");
      const files = fsImpl.readdirSync(svcDir);
      return files.some((f) => /^ah-(?:node|hub)\..+\.(?:mjs|vbs)$/i.test(String(f)));
    } catch {
      return false;
    }
  }
  if (platform === "darwin") {
    try {
      const agentsDir = path.join(homeDir, "Library", "LaunchAgents");
      const resolved = path.resolve(configDir);
      for (const f of fsImpl.readdirSync(agentsDir)) {
        if (!/^ah-(?:node|hub)\..+\.plist$/.test(String(f))) continue;
        try {
          const text = fsImpl.readFileSync(path.join(agentsDir, f), "utf8");
          if (text.includes(`<string>${resolved}</string>`) || text.includes(`<string>${configDir}</string>`)) {
            return true;
          }
        } catch {}
      }
    } catch {}
    return false;
  }
  if (platform === "linux") {
    if (fsImpl.existsSync(path.join(configDir, "service.env"))) return true;
    const userUnitDir = path.join(homeDir, ".config", "systemd", "user");
    const resolved = path.resolve(configDir);
    for (const dir of [userUnitDir, "/etc/systemd/system"]) {
      try {
        for (const f of fsImpl.readdirSync(dir)) {
          if (!/^ah-.*\.service$/.test(String(f))) continue;
          try {
            const text = fsImpl.readFileSync(path.join(dir, f), "utf8");
            if (text.includes(resolved) || text.includes(configDir)) return true;
          } catch {}
        }
      } catch {}
    }
    return false;
  }
  return false;
}
