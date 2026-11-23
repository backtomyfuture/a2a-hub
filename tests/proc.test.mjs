import assert from "node:assert/strict";
import test from "node:test";
import { buildProcEnv, splitCommandLine } from "../src/core/proc.mjs";

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
