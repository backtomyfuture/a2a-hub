import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildProcEnv,
  buildSpawnSpec,
  resolveNpmCmdShim,
  runDetachedCommand,
  splitCommandLine,
} from "../src/core/proc.mjs";

test("splitCommandLine: 正确切分命令与参数，完整保留引号内多行换行与 Windows 反斜杠", () => {
  // 1. 普通空格切分
  assert.deepEqual(splitCommandLine("claude --output-format json -p hello"), [
    "claude",
    "--output-format",
    "json",
    "-p",
    "hello",
  ]);

  // 2. Windows 路径包含空格与反斜杠，参数内包含真实换行符
  const winCmd = `"C:\\Program Files\\Google\\Antigravity\\bin\\agy.exe" --model "gemini-2.5-pro" -p "### 当前任务目标\n标题：排查任务\n请帮我分析日志"`;
  const winParts = splitCommandLine(winCmd);
  assert.equal(winParts[0], "C:\\Program Files\\Google\\Antigravity\\bin\\agy.exe");
  assert.equal(winParts[1], "--model");
  assert.equal(winParts[2], "gemini-2.5-pro");
  assert.equal(winParts[3], "-p");
  assert.equal(winParts[4], "### 当前任务目标\n标题：排查任务\n请帮我分析日志");

  // 3. 空引号参数与单引号
  assert.deepEqual(splitCommandLine("bin -p ''"), ["bin", "-p", ""]);
  assert.deepEqual(splitCommandLine('bin -p ""'), ["bin", "-p", ""]);
  assert.deepEqual(splitCommandLine("cmd 'hello world' \"another argument\""), [
    "cmd",
    "hello world",
    "another argument",
  ]);

  // 4. 引号内转义引号
  assert.deepEqual(splitCommandLine('echo "hello \\"world\\""'), ["echo", 'hello "world"']);
});

test("buildProcEnv: 跨平台 PATH 拼接与分隔符", () => {
  // POSIX 环境
  const posixEnv = buildProcEnv({ PATH: "/usr/bin:/bin" }, "darwin");
  assert.ok(posixEnv.PATH.includes("/opt/homebrew/bin"));
  assert.ok(posixEnv.PATH.includes("/usr/bin"));
  assert.equal(posixEnv.PATH.includes(";"), false, "POSIX 下 PATH 绝不应包含分号");

  // Windows 环境：必须使用分号且合并 npm/node 目录
  const winBase = { Path: "C:\\Windows\\System32;C:\\Windows", SystemRoot: "C:\\Windows" };
  const winEnv = buildProcEnv(winBase, "win32");
  assert.ok(winEnv.Path.includes(";"), "Windows 下 PATH 必须以分号分隔");
  assert.equal(winEnv.Path.includes(":C:\\Windows"), false, "Windows 下 PATH 绝不可使用冒号分隔目录");
  assert.equal(winEnv.PATH, undefined, "不得留下大小写冲突的重复 PATH 键");
});

test("buildSpawnSpec: Windows 下统一 windowsHide:true 且禁用 detached:true 防止闪黑框，POSIX 维持进程组", () => {
  const exeSpec = buildSpawnSpec(
    `"C:\\Program Files\\Google\\Antigravity\\bin\\agy.exe" --output-format json -p "第一行\n第二行"`,
    { platform: "win32", cwd: "C:\\Work", env: { Path: "C:\\Windows\\System32" } }
  );
  assert.equal(exeSpec.file, "C:\\Program Files\\Google\\Antigravity\\bin\\agy.exe");
  assert.deepEqual(exeSpec.args, ["--output-format", "json", "-p", "第一行\n第二行"]);
  assert.equal(exeSpec.options.shell, false);
  assert.equal(exeSpec.options.detached, false, "Windows 严禁设 detached:true 以免叠加 DETACHED_PROCESS 弹黑框");
  assert.equal(exeSpec.options.windowsHide, true, "Windows 必须启用 windowsHide:true 以传递 CREATE_NO_WINDOW");
  assert.deepEqual(exeSpec.options.stdio, ["pipe", "pipe", "pipe"]);

  // 普通 .bat 脚本回退 shell:true，同样必须 windowsHide:true + detached:false
  const batSpec = buildSpawnSpec(`"C:\\tools\\custom.bat" --flag ok`, {
    platform: "win32",
    cwd: "C:\\Work",
    env: { Path: "C:\\Windows\\System32" },
  });
  assert.equal(batSpec.file, "C:\\tools\\custom.bat");
  assert.deepEqual(batSpec.args, ["--flag", "ok"]);
  assert.equal(batSpec.options.shell, true);
  assert.equal(batSpec.options.detached, false);
  assert.equal(batSpec.options.windowsHide, true);

  // POSIX 下继续使用 shell:true + detached:true 以支持负 PID 杀整组
  const posixSpec = buildSpawnSpec("claude -p 'hello'", { platform: "darwin", cwd: "/tmp", env: { PATH: "/usr/bin" } });
  assert.equal(posixSpec.file, "claude -p 'hello'");
  assert.equal(posixSpec.args, null);
  assert.equal(posixSpec.options.shell, true);
  assert.equal(posixSpec.options.detached, true);
});

test("resolveNpmCmdShim: 标准 npm .cmd shim 直跑 node 绕过 cmd.exe，自定义环境变量或路径穿越安全回退", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-shim-"));
  try {
    const cliDir = path.join(tmpDir, "node_modules", "@demo", "cli");
    fs.mkdirSync(cliDir, { recursive: true });
    const entryJs = path.join(cliDir, "index.js");
    fs.writeFileSync(entryJs, "console.log('ok');\n");

    const stdShim = path.join(tmpDir, "demo.cmd");
    fs.writeFileSync(
      stdShim,
      [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ") ELSE (",
        '  SET "_prog=node"',
        "  SET PATHEXT=%PATHEXT:;.JS;=;%",
        ")",
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@demo\\cli\\index.js" %*',
      ].join("\r\n")
    );

    const parsed = resolveNpmCmdShim(stdShim, { execPath: "/usr/local/bin/node" });
    assert.ok(parsed, "标准 npm .cmd shim 应被识别直跑");
    assert.equal(parsed.node, "/usr/local/bin/node");
    assert.deepEqual(parsed.args, [entryJs]);

    const winSpec = buildSpawnSpec(`"${stdShim}" -p "line1\nline2"`, {
      platform: "win32",
      cwd: tmpDir,
      env: { Path: tmpDir },
      execPath: "/usr/local/bin/node",
    });
    assert.equal(winSpec.file, "/usr/local/bin/node");
    assert.deepEqual(winSpec.args, [entryJs, "-p", "line1\nline2"]);
    assert.equal(winSpec.options.shell, false, "直跑 npm shim 不再经由 cmd.exe");
    assert.equal(winSpec.options.detached, false);
    assert.equal(winSpec.options.windowsHide, true);

    // 含自定义环境变量的 .cmd 必须拒绝跳过，回退 shell:true
    const customEnvShim = path.join(tmpDir, "custom.cmd");
    fs.writeFileSync(
      customEnvShim,
      '@ECHO off\r\nSET MY_SECRET_FLAG=1\r\n"%_prog%" "%dp0%\\node_modules\\@demo\\cli\\index.js" %*\r\n'
    );
    assert.equal(resolveNpmCmdShim(customEnvShim), null);

    // 含路径穿越的 .cmd 必须拒绝跳过
    const escapeShim = path.join(tmpDir, "escape.cmd");
    fs.writeFileSync(escapeShim, '@ECHO off\r\n"%_prog%" "%dp0%\\..\\outside.js" %*\r\n');
    assert.equal(resolveNpmCmdShim(escapeShim), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("runDetachedCommand: 支持外部 AbortSignal 及时中止长耗时子进程", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 120);
  const t0 = Date.now();
  const res = await runDetachedCommand(
    `"${process.execPath}" -e "setTimeout(() => {}, 10000)"`,
    null,
    30,
    os.tmpdir(),
    null,
    { signal: ac.signal }
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3000, `AbortSignal 应快速中止子进程，实测 ${elapsed}ms`);
  assert.notEqual(res.code, 0);
});
