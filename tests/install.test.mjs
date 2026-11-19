// 安装脚本与自启命名：只建 ah / a2a-hub / ahub，外来 origin 中性拒绝，
// 默认目录 ~/.a2a-hub，AH_HOME 生效，服务名在默认目录不带摘要。
// git pull / clone 由 PATH 上的假 git 拦住，避免测试访问网络。状态只写临时目录。

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  launchdLabel,
  selectAutostartName,
  systemdUnitName,
  unitTextTargetsConfig,
  windowsTaskName,
} from "../src/service.mjs";
import { withTemp } from "./helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installSh = path.join(root, "install.sh");
const ah = path.join(root, "bin", "ah.mjs");
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const LINK_NAMES = ["a2a-hub", "ah", "ahub"];

function writeGitStub(binDir, traceFile) {
  const stub = path.join(binDir, "git");
  fs.writeFileSync(stub, `#!/bin/sh
printf '%s\\n' "$*" >> "$GIT_TRACE"
if [ "$1" = "-C" ] && [ "$3" = "remote" ] && [ "$4" = "get-url" ]; then
  exec ${JSON.stringify(realGit)} "$@"
fi
echo "blocked git: $*" >&2
exit 97
`);
  fs.chmodSync(stub, 0o755);
  fs.writeFileSync(traceFile, "");
}

function gitEnv(home, hub, binDir, traceFile, extra = {}) {
  const env = {
    ...process.env,
    HOME: home,
    AH_HOME: hub,
    PATH: `${binDir}:${process.env.PATH}`,
    GIT_TRACE: traceFile,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "0",
    ...extra,
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

function initRepo(app, origin) {
  execFileSync(realGit, ["init", "-q"], { cwd: app });
  execFileSync(realGit, ["config", "user.email", "t@example.com"], { cwd: app });
  execFileSync(realGit, ["config", "user.name", "t"], { cwd: app });
  fs.writeFileSync(path.join(app, "KEEP"), "untouched\n");
  execFileSync(realGit, ["add", "KEEP"], { cwd: app });
  execFileSync(realGit, ["commit", "-q", "-m", "init"], { cwd: app });
  execFileSync(realGit, ["remote", "add", "origin", origin], { cwd: app });
}

function runInstall(home, args, env) {
  return spawnSync("/bin/sh", [installSh, ...args], {
    env,
    encoding: "utf8",
    cwd: home,
  });
}

function linkDir(home) {
  return path.join(home, ".local", "bin");
}

test("默认配置目录的自启名不带摘要，其它目录带路径摘要", () => {
  const home = "/Users/someone";
  const standard = path.join(home, ".a2a-hub");
  const custom = path.join(home, "custom-hub");
  assert.equal(launchdLabel("hub", "mac-mini"), "ah-hub.mac-mini");
  assert.equal(
    selectAutostartName({ role: "hub", node: "mac-mini", configDir: standard, homeDir: home, kind: "launchd" }),
    "ah-hub.mac-mini",
  );
  assert.equal(systemdUnitName("node", "mac-mini"), "ah-mac-mini.service");
  assert.equal(systemdUnitName("hub", "mac-mini"), "ah-hub-mac-mini.service");
  assert.equal(
    selectAutostartName({ role: "node", node: "mac-mini", configDir: standard, homeDir: home, kind: "systemd" }),
    "ah-mac-mini.service",
  );
  assert.equal(
    selectAutostartName({ role: "hub", node: "mac-mini", configDir: standard, homeDir: home, kind: "systemd" }),
    "ah-hub-mac-mini.service",
  );
  assert.equal(windowsTaskName("hub", "mac-mini", standard, home), "ah-hub-mac-mini");
  assert.equal(windowsTaskName("hub", "desk"), "ah-hub-desk");

  const hubLabel = selectAutostartName({ role: "hub", node: "mac-mini", configDir: custom, homeDir: home, kind: "launchd" });
  assert.match(hubLabel, /^ah-hub\.mac-mini\.[0-9a-f]{8}$/);
  assert.notEqual(hubLabel, launchdLabel("hub", "mac-mini"));
  const unit = selectAutostartName({ role: "node", node: "mac-mini", configDir: custom, homeDir: home, kind: "systemd" });
  assert.equal(unit, "ah-mac-mini.service");
  const hubUnit = selectAutostartName({ role: "hub", node: "mac-mini", configDir: custom, homeDir: home, kind: "systemd" });
  assert.equal(hubUnit, "ah-hub-mac-mini.service");
  assert.match(windowsTaskName("hub", "mac-mini", custom, home), /^ah-hub-mac-mini-[0-9a-f]{8}$/);

  const plist = `<?xml version="1.0"?><string>${custom}</string>`;
  assert.equal(unitTextTargetsConfig(plist, custom), true);
  assert.equal(unitTextTargetsConfig(plist, standard), false);
});

test("install.sh 拒绝外来 origin，且不改目录和软链", async () => {
  await withTemp(async (home) => {
    const hub = path.join(home, ".a2a-hub");
    const app = path.join(hub, "app");
    const binDir = path.join(home, "bin");
    const trace = path.join(home, "git-trace");
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(linkDir(home), { recursive: true });
    initRepo(app, "https://github.com/example/other.git");
    writeGitStub(binDir, trace);
    const before = fs.readFileSync(path.join(app, "KEEP"), "utf8");
    const result = runInstall(home, ["--hub"], gitEnv(home, hub, binDir, trace));
    const out = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(out, /origin 不是 backtomyfuture\/a2a-hub/);
    assert.match(out, /AH_HOME/);
    assert.equal(fs.readFileSync(path.join(app, "KEEP"), "utf8"), before);
    assert.deepEqual(fs.readdirSync(linkDir(home)), []);
    const traceText = fs.readFileSync(trace, "utf8");
    assert.match(traceText, /remote get-url origin/);
    assert.doesNotMatch(traceText, /pull/);
    assert.doesNotMatch(traceText, /clone/);
    assert.doesNotMatch(out, /blocked git/);
  });
});

test("本仓库 origin 缺少 ah.mjs 时退出且不拉代码", async () => {
  await withTemp(async (home) => {
    const hub = path.join(home, ".a2a-hub");
    const app = path.join(hub, "app");
    const binDir = path.join(home, "bin");
    const trace = path.join(home, "git-trace");
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    initRepo(app, "git@github.com:BackToMyFuture/a2a-hub.git");
    writeGitStub(binDir, trace);
    const result = runInstall(home, ["--skip-skill"], gitEnv(home, hub, binDir, trace, { AH_INSTALL_SKIP_FETCH: "1" }));
    const out = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(out, /bin\/ah\.mjs/);
    assert.doesNotMatch(fs.readFileSync(trace, "utf8"), /pull/);
    assert.equal(fs.existsSync(path.join(linkDir(home), "ah")), false);
  });
});

test("未设置 AH_HOME 时安装默认使用 ~/.a2a-hub", async () => {
  await withTemp(async (home) => {
    const binDir = path.join(home, "bin");
    const trace = path.join(home, "git-trace");
    fs.mkdirSync(binDir, { recursive: true });
    writeGitStub(binDir, trace);
    const env = gitEnv(home, path.join(home, "unused"), binDir, trace, { AH_INSTALL_SKIP_FETCH: "1" });
    delete env.AH_HOME;
    const result = runInstall(home, ["--skip-skill"], env);
    const out = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, out);
    assert.match(out, /\.a2a-hub/);
    assert.equal(fs.existsSync(path.join(home, "unused")), false);
  });
});

test("AH_HOME 指向的目录会被安装，且只建立三条命令软链", async () => {
  await withTemp(async (home) => {
    const hub = path.join(home, "custom-home");
    const appBin = path.join(hub, "app", "bin");
    const binDir = path.join(home, "bin");
    const trace = path.join(home, "git-trace");
    fs.mkdirSync(appBin, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    const ahTarget = path.join(appBin, "ah.mjs");
    fs.writeFileSync(ahTarget, "#!/usr/bin/env node\nprocess.exit(0)\n");
    writeGitStub(binDir, trace);
    const result = runInstall(home, ["--skip-skill"], gitEnv(home, hub, binDir, trace, { AH_INSTALL_SKIP_FETCH: "1" }));
    const out = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, out);
    assert.match(out, /custom-home/);
    assert.deepEqual(fs.readdirSync(linkDir(home)).sort(), LINK_NAMES);
    for (const name of LINK_NAMES) {
      assert.equal(fs.readlinkSync(path.join(linkDir(home), name)), ahTarget);
    }
    assert.match(out, /zsh/);
    assert.match(out, /\.zshrc/);
    assert.match(out, /\.bashrc/);
  });
});

test("ah setup --yes 在未加 --force 时保留已完成的 node.json", async () => {
  await withTemp(async (home) => {
    const configDir = path.join(home, "cfg");
    fs.mkdirSync(configDir, { recursive: true });
    const nodeJson = path.join(configDir, "node.json");
    const marker = "keep-this-marker";
    const body = JSON.stringify({
      node: "mac-mini",
      role: "hub",
      kind: "host",
      busType: "sqlite",
      listen: "127.0.0.1:8787",
      apiToken: marker,
    }, null, 2) + "\n";
    fs.writeFileSync(nodeJson, body);
    const env = { ...process.env, HOME: home, AH_HOME: configDir };
    const setup = spawnSync(process.execPath, [
      ah, "setup", "--role", "hub", "--bus", "sqlite", "--yes", "--auto-token", "--skip-skill", "--config", configDir,
    ], { env, encoding: "utf8" });
    const setupOut = `${setup.stdout}\n${setup.stderr}`;
    assert.equal(setup.status, 4, setupOut);
    assert.match(setupOut, /已保留现有 node\.json/);
    assert.doesNotMatch(setupOut, new RegExp(marker));
    assert.equal(fs.readFileSync(nodeJson, "utf8"), body);
  });
});
