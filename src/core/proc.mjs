// 通用进程工具：独立进程组执行、输出头尾截断捕获。kernel 的直跑路径与 direct 在途账本共用。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { whichBinary } from "./config.mjs";

// direct 在途账本的超时收口用同一个宽限，避免两处各写一个数。
export const KILL_GRACE_MS = 2500;
// 回执在输出尾部，启动报错在头部。中间的模型日志不留，避免无上限拼接撑满内存。
const OUTPUT_HEAD_BYTES = 64 * 1024;
const OUTPUT_TAIL_BYTES = 1024 * 1024;

export function createBoundedCapture(headLimit = OUTPUT_HEAD_BYTES, tailLimit = OUTPUT_TAIL_BYTES) {
  const head = [];
  let headLen = 0;
  const tail = [];
  let tailLen = 0;
  let omitted = 0;

  // 拷贝而不是 subarray：单块很大时，视图会把整块缓冲留在内存里。
  function pushTail(buf) {
    if (buf.length === 0) return;
    if (buf.length >= tailLimit) {
      omitted += tailLen + (buf.length - tailLimit);
      tail.length = 0;
      tail.push(Buffer.from(buf.subarray(buf.length - tailLimit)));
      tailLen = tailLimit;
      return;
    }
    tail.push(Buffer.from(buf));
    tailLen += buf.length;
    while (tailLen > tailLimit && tail.length) {
      const extra = tailLen - tailLimit;
      const first = tail[0];
      if (first.length <= extra) {
        tail.shift();
        tailLen -= first.length;
        omitted += first.length;
      } else {
        tail[0] = Buffer.from(first.subarray(extra));
        tailLen -= extra;
        omitted += extra;
      }
    }
  }

  return {
    push(chunk) {
      if (chunk == null) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      if (headLen < headLimit) {
        const take = Math.min(buf.length, headLimit - headLen);
        head.push(Buffer.from(buf.subarray(0, take)));
        headLen += take;
        offset = take;
      }
      if (offset < buf.length) pushTail(buf.subarray(offset));
    },
    text() {
      // 没丢字节时按整段解码，避免在 64KiB 边界把一个多字节字符拆成两段。
      if (omitted <= 0) return Buffer.concat([...head, ...tail]).toString("utf8");
      const h = Buffer.concat(head, headLen).toString("utf8");
      const t = Buffer.concat(tail, tailLen).toString("utf8");
      // 省略标记不含反引号。内核只把该行之后当作回执，头里的半截围栏不能吞掉尾部。
      return `${h}\n…[中间省略 ${omitted} 字节]…\n${t}`;
    },
  };
}

function killProcessGroup(child, sig) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      // 直接调用 taskkill 并隐藏窗口，避免 execSync 额外拉起 cmd.exe 闪黑框
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      try { child.kill(sig); } catch { /* 已退出 */ }
    }
    return;
  }
  try { process.kill(-child.pid, sig); }
  catch {
    try { child.kill(sig); } catch { /* 已退出 */ }
  }
}

// 命令参数解析（支持双引号、单引号与转义符），供 Windows 无 cmd.exe 模式直跑以保留多行文本
export function splitCommandLine(cmd) {
  const args = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";
  let escape = false;
  let hasToken = false;

  const s = String(cmd || "").trim();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < s.length && (s[i + 1] === quoteChar || s[i + 1] === "\\" || s[i + 1] === "\"")) {
        escape = true;
        continue;
      }
      current += ch;
      continue;
    }
    if (!inQuotes && (ch === "\"" || ch === "'")) {
      inQuotes = true;
      quoteChar = ch;
      hasToken = true;
      continue;
    }
    if (inQuotes && ch === quoteChar) {
      inQuotes = false;
      quoteChar = "";
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (hasToken || current.length > 0) {
        args.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken || current.length > 0) {
    args.push(current);
  }
  return args;
}

// 统一跨平台 PATH 构造与环境变量准备
export function buildProcEnv(baseEnv = process.env, platform = process.platform) {
  const isWin = platform === "win32";
  const env = { ...baseEnv };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || (isWin ? "Path" : "PATH");
  const curPath = String(
    env[pathKey] ||
      (isWin ? `${baseEnv.SystemRoot || "C:\\Windows"}\\System32;${baseEnv.SystemRoot || "C:\\Windows"}` : "/usr/bin:/bin")
  );
  const homeDir = os.homedir();
  const extra = isWin
    ? [
        path.dirname(process.execPath),
        path.join(homeDir, "AppData", "Roaming", "npm"),
        path.join(homeDir, ".local", "bin"),
        path.join(homeDir, ".cargo", "bin"),
      ]
    : [
        "/opt/homebrew/bin",
        path.join(homeDir, ".local/bin"),
        "/usr/local/bin",
      ];
  const existingDirs = curPath.split(isWin ? ";" : ":").map((d) => d.trim()).filter(Boolean);
  const combinedPath = [...new Set([...extra, ...existingDirs])].join(isWin ? ";" : ":");
  env[pathKey] = combinedPath;
  if (isWin && pathKey !== "PATH") {
    delete env.PATH;
  }
  return env;
}

// 识别 npm / pnpm / yarn 生成的标准 Node .cmd shim（不含自定义环境脚本），
// 绕过 cmd.exe 直接用 node 执行目标入口，既根除黑框闪窗又避免 cmd.exe 截断多行参数。
export function resolveNpmCmdShim(
  binPath,
  { fsImpl = fs, execPath = process.execPath } = {}
) {
  const rawBin = String(binPath || "").trim();
  if (!/\.cmd$/i.test(rawBin)) return null;
  let stat;
  try {
    stat = fsImpl.statSync(rawBin);
  } catch {
    return null;
  }
  if (!stat?.isFile?.() || stat.size <= 0 || stat.size > 4096) return null;

  let text = "";
  try {
    text = String(fsImpl.readFileSync(rawBin, "utf8") || "");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^SET\s+/i.test(line)) {
      const isStandardSet =
        /^SET\s+dp0=%~dp0$/i.test(line) ||
        /^SET\s+"?_prog=/i.test(line) ||
        /^SET\s+PATHEXT=/i.test(line);
      if (!isStandardSet) return null;
    }
  }

  const m = text.match(
    /"%_prog%"\s+((?:--[A-Za-z0-9._=-]+\s+)*)"%dp0%\\([^"\r\n]+\.(?:[cm]?js))"\s+%\*/i
  );
  if (!m) return null;

  const isWinStyle = /^[A-Za-z]:[\\/]/.test(rawBin) || rawBin.includes("\\");
  const pApi = isWinStyle ? path.win32 : path.posix;
  const dir = pApi.dirname(rawBin);
  const relScript = isWinStyle ? m[2] : m[2].replaceAll("\\", "/");
  const scriptPath = pApi.resolve(dir, relScript);
  const relBack = pApi.relative(dir, scriptPath);
  if (!relBack || relBack.startsWith("..") || pApi.isAbsolute(relBack)) {
    return null;
  }
  try {
    if (!fsImpl.existsSync(scriptPath)) return null;
  } catch {
    return null;
  }

  const nodeFlags = m[1] ? m[1].trim().split(/\s+/).filter(Boolean) : [];
  const bundledNode = pApi.join(dir, "node.exe");
  let nodeBin = execPath;
  try {
    if (fsImpl.existsSync(bundledNode)) nodeBin = bundledNode;
  } catch {}
  return {
    node: nodeBin,
    args: [...nodeFlags, scriptPath],
  };
}

// 构造跨平台 spawn 参数：
// - Windows 严禁与 windowsHide 混用 detached:true（libuv 会叠加 DETACHED_PROCESS 导致脱离隐藏控制台或弹黑框），
//   统一 detached:false + windowsHide:true + pipe stdio，让 libuv 精确传递 CREATE_NO_WINDOW | SW_HIDE 并加入全局 Job Object。
// - POSIX 保持 detached:true 以便按负 PID 一次性清理整组子进程。
export function buildSpawnSpec(
  command,
  {
    cwd = os.homedir(),
    env = process.env,
    platform = process.platform,
    fsImpl = fs,
    execPath = process.execPath,
    whichFn = null,
  } = {}
) {
  const effectiveCwd = cwd || os.homedir();
  if (platform === "win32") {
    const parts = splitCommandLine(command);
    let bin = parts[0] || "";
    const args = parts.slice(1);
    const hasDirSep = bin.includes("\\") || bin.includes("/");
    const hasExt = /\.[A-Za-z0-9]+$/.test(bin);
    const resolver = whichFn || (process.platform === "win32" ? whichBinary : null);
    if (bin && !hasDirSep && !hasExt && typeof resolver === "function") {
      try {
        const hit = resolver(bin, { env });
        if (hit) bin = hit;
      } catch {}
    }

    const isBatch = /\.(?:bat|cmd)$/i.test(bin);
    if (isBatch) {
      const shim = resolveNpmCmdShim(bin, { fsImpl, execPath });
      if (shim) {
        return {
          file: shim.node,
          args: [...shim.args, ...args],
          options: {
            shell: false,
            cwd: effectiveCwd,
            env,
            detached: false,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          },
        };
      }
      return {
        file: bin,
        args,
        options: {
          shell: true,
          cwd: effectiveCwd,
          env,
          detached: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      };
    }

    return {
      file: bin,
      args,
      options: {
        shell: false,
        cwd: effectiveCwd,
        env,
        detached: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    };
  }

  return {
    file: command,
    args: null,
    options: {
      shell: true,
      cwd: effectiveCwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  };
}

// 独立进程组执行。超时或外部中止先向整组发 SIGTERM，宽限后再 SIGKILL，并拆掉 stdio，
// 避免 shell 死后孙进程继续占着管道，使 close 永远不来。
export function runDetachedCommand(command, stdinText, timeoutSec, cwd, extraEnv = null, opts = null) {
  return new Promise((resolve, reject) => {
    const env = buildProcEnv(
      extraEnv && typeof extraEnv === "object" ? { ...process.env, ...extraEnv } : process.env,
      process.platform
    );
    const sec = Number(timeoutSec);
    const ms = Math.min(2_147_483_647, Math.max(0, Number.isFinite(sec) ? sec : 0) * 1000);
    const signal = opts?.signal || null;
    if (signal?.aborted) {
      resolve({ code: null, signal: "SIGTERM", stdout: "", stderr: "" });
      return;
    }
    let p;
    try {
      const spec = buildSpawnSpec(command, { cwd: cwd || os.homedir(), env, platform: process.platform });
      p = spec.args === null ? spawn(spec.file, spec.options) : spawn(spec.file, spec.args, spec.options);
    } catch (e) {
      reject(e);
      return;
    }
    const outCap = createBoundedCapture();
    const errCap = createBoundedCapture();
    let settled = false;
    let terminating = false;
    let timer = null;
    let killTimer = null;
    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      timer = null;
      killTimer = null;
    };
    const dropStdio = () => {
      for (const s of [p.stdin, p.stdout, p.stderr]) {
        try { s?.destroy(); } catch { /* 已关 */ }
      }
    };
    const terminateProcess = () => {
      if (settled || terminating) return;
      terminating = true;
      killProcessGroup(p, "SIGTERM");
      if (settled) return;
      killTimer = setTimeout(() => {
        if (settled) return;
        killProcessGroup(p, "SIGKILL");
        dropStdio();
        if (settled) return;
        killTimer = setTimeout(() => {
          finish(resolve, { code: null, signal: "SIGKILL", stdout: outCap.text(), stderr: errCap.text() });
        }, 500);
      }, KILL_GRACE_MS);
    };
    const onAbort = () => terminateProcess();
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (signal) signal.removeEventListener("abort", onAbort);
      fn(value);
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    p.stdout?.on("data", (d) => { outCap.push(d); });
    p.stderr?.on("data", (d) => { errCap.push(d); });
    p.on("error", (e) => finish(reject, e));
    // EPIPE 表示对端已经退出，交给 close 收口，不能把守护进程打崩。
    p.stdin?.on("error", (e) => {
      if (e?.code === "EPIPE" || e?.code === "ERR_STREAM_DESTROYED") return;
      finish(reject, e);
    });
    p.on("close", (code, sig) => finish(resolve, { code, signal: sig, stdout: outCap.text(), stderr: errCap.text() }));
    timer = setTimeout(terminateProcess, ms);
    try {
      if (stdinText != null) p.stdin.write(stdinText);
      p.stdin.end();
    } catch (e) {
      if (e?.code !== "EPIPE") finish(reject, e);
    }
  });
}
