// 安装脚本与 setup 在遇到旧版 lark-a2a-hub 时必须拒绝，并且全程只碰临时目录。
// git pull / clone 由 PATH 上的假 git 拦住，避免测试访问网络。

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isLegacyFeishuNodeConfig } from "../src/setup.mjs";
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

const SECRET = "feishu-secret-do-not-print";

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
    HUB_NODE_HOME: hub,
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

test("旧飞书 node.json 的判定不把 sqlite/http 或提醒地址当成飞书总线", () => {
  assert.equal(isLegacyFeishuNodeConfig({ node: "mac-mini", baseToken: SECRET, tables: { tasks: "tbl" }, events: true }), true);
  assert.equal(isLegacyFeishuNodeConfig({ node: "mac-mini", busType: "feishu" }), true);
  assert.equal(isLegacyFeishuNodeConfig({ node: "mac-mini", busType: "sqlite", appId: "cli_x" }), true);
  assert.equal(isLegacyFeishuNodeConfig({ node: "mac-mini", busType: "sqlite", events: true }), false);
  assert.equal(isLegacyFeishuNodeConfig({
    node: "mac-mini",
    busType: "http",
    notifications: { feishuWebhookUrl: "https://example.invalid/hook" },
  }), false);
  assert.equal(isLegacyFeishuNodeConfig(null), false);
  // 缺 busType 但能被 config.mjs 推断为 http / sqlite 的新配置不算旧版。
  assert.equal(isLegacyFeishuNodeConfig({ node: "edge", hubUrl: "http://127.0.0.1:8787" }), false);
  assert.equal(isLegacyFeishuNodeConfig({ node: "hub", role: "hub", dbPath: "hub.db" }), false);
  assert.equal(isLegacyFeishuNodeConfig({ node: "mac-mini", role: "node", tables: { tasks: "tbl" } }), true);
});

test("自定义配置目录的自启名不占用 hub-node-node / hub-node-hub", () => {
  const home = "/Users/someone";
  const custom = path.join(home, ".a2a-hub");
  const hubLabel = selectAutostartName({ role: "hub", node: "mac-mini", configDir: custom, homeDir: home, kind: "launchd" });
  const nodeLabel = selectAutostartName({ role: "node", node: "mac-mini", configDir: custom, homeDir: home, kind: "launchd" });
  assert.notEqual(hubLabel, launchdLabel("hub", "mac-mini"));
  assert.notEqual(hubLabel, launchdLabel("node", "mac-mini"));
  assert.notEqual(nodeLabel, launchdLabel("node", "mac-mini"));
  assert.match(hubLabel, /^ah-hub\.mac-mini\.[0-9a-f]{8}$/);
  const unit = selectAutostartName({ role: "node", node: "mac-mini", configDir: custom, homeDir: home, kind: "systemd" });
  assert.notEqual(unit, systemdUnitName("node", "mac-mini"));
  assert.match(unit, /^ah-node-mac-mini-[0-9a-f]{8}\.service$/);
  assert.equal(
    selectAutostartName({ role: "hub", node: "mac-mini", configDir: path.join(home, ".hub-node"), homeDir: home, kind: "launchd" }),
    "hub-node-hub.mac-mini",
  );
  const plist = `<?xml version="1.0"?><string>${custom}</string>`;
  assert.equal(unitTextTargetsConfig(plist, custom), true);
  assert.equal(unitTextTargetsConfig(plist, path.join(home, ".hub-node")), false);
  assert.equal(
    selectAutostartName({
      role: "hub", node: "mac-mini", configDir: custom, homeDir: home, kind: "launchd", legacyOwnedByThisConfig: true,
    }),
    "hub-node-hub.mac-mini",
  );
  assert.equal(windowsTaskName("hub", "desk"), "\\lah\\hub-node-hub.desk");
  assert.match(windowsTaskName("hub", "mac-mini", custom, home), /^\\lah\\ah-hub\.mac-mini\.[0-9a-f]{8}$/);
});

test("install.sh 拒绝拉取 lark-a2a-hub，且不改目录和软链", async () => {
  await withTemp(async (home) => {
    const hub = path.join(home, ".hub-node");
    const app = path.join(hub, "app");
    const binDir = path.join(home, "bin");
    const trace = path.join(home, "git-trace");
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    const outside = path.join(home, "old-lah-target");
    fs.writeFileSync(outside, "old\n");
    fs.symlinkSync(outside, path.join(home, ".local", "bin", "lah"));
    fs.symlinkSync(outside, path.join(home, ".local", "bin", "hub-node"));
    initRepo(app, "https://github.com/backtomyfuture/lark-a2a-hub.git");
    writeGitStub(binDir, trace);
    const before = fs.readFileSync(path.join(app, "KEEP"), "utf8");
    const result = runInstall(home, ["--hub"], gitEnv(home, hub, binDir, trace));
    const out = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(out, /旧版或其他项目/);
    assert.match(out, /HUB_NODE_HOME/);
    assert.match(out, /\.a2a-hub/);
    assert.equal(fs.readFileSync(path.join(app, "KEEP"), "utf8"), before);
    assert.equal(fs.readlinkSync(path.join(home, ".local", "bin", "lah")), outside);
    assert.equal(fs.readlinkSync(path.join(home, ".local", "bin", "hub-node")), outside);
    assert.equal(fs.existsSync(path.join(home, ".local", "bin", "ah")), false);
    const traceText = fs.readFileSync(trace, "utf8");
    assert.match(traceText, /remote get-url origin/);
    assert.doesNotMatch(traceText, /pull/);
    assert.doesNotMatch(traceText, /clone/);
    assert.doesNotMatch(out, /blocked git/);
  });
});

test("a2a-hub 的 origin 不会被当成旧仓库，但缺少 ah.mjs 时仍退出且不拉代码", async () => {
  await withTemp(async (home) => {
    const hub = path.join(home, ".hub-node");
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
    assert.equal(fs.existsSync(path.join(home, ".local", "bin", "ah")), false);
  });
});

test("install.sh 拒绝覆盖旧飞书 node.json，并保留指向外部的 lah / hub-node", async () => {
  await withTemp(async (home) => {
    const hub = path.join(home, ".hub-node");
    const app = path.join(hub, "app", "bin");
    const binDir = path.join(home, "bin");
    const trace = path.join(home, "git-trace");
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    fs.writeFileSync(path.join(app, "ah.mjs"), "#!/usr/bin/env node\nprocess.exit(0)\n");
    const nodeJson = path.join(hub, "node.json");
    const body = JSON.stringify({ node: "mac-mini", baseToken: SECRET, tables: { tasks: "tbl" }, events: true }, null, 2) + "\n";
    fs.writeFileSync(nodeJson, body);
    const outside = path.join(home, "old-lah-target");
    fs.writeFileSync(outside, "old\n");
    fs.symlinkSync(outside, path.join(home, ".local", "bin", "lah"));
    fs.symlinkSync(outside, path.join(home, ".local", "bin", "hub-node"));
    writeGitStub(binDir, trace);
    const result = runInstall(home, ["--hub"], gitEnv(home, hub, binDir, trace, { AH_INSTALL_SKIP_FETCH: "1" }));
    const out = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(out, /旧版飞书/);
    assert.match(out, /\.a2a-hub/);
    assert.equal(fs.readFileSync(nodeJson, "utf8"), body);
    assert.doesNotMatch(out, new RegExp(SECRET));
    assert.equal(fs.readlinkSync(path.join(home, ".local", "bin", "lah")), outside);
    assert.equal(fs.readlinkSync(path.join(home, ".local", "bin", "hub-node")), outside);
    assert.doesNotMatch(fs.readFileSync(trace, "utf8"), /pull|clone/);
  });
});

test("纯安装会建立 ah，但不会覆盖指向外部的 lah，并提示 PATH", async () => {
  await withTemp(async (home) => {
    const hub = path.join(home, "cfg");
    const appBin = path.join(hub, "app", "bin");
    const binDir = path.join(home, "bin");
    const trace = path.join(home, "git-trace");
    fs.mkdirSync(appBin, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    const ahTarget = path.join(hub, "app", "bin", "ah.mjs");
    fs.writeFileSync(ahTarget, "#!/usr/bin/env node\nprocess.exit(0)\n");
    const outside = path.join(home, "old-lah-target");
    fs.writeFileSync(outside, "old\n");
    fs.symlinkSync(outside, path.join(home, ".local", "bin", "lah"));
    writeGitStub(binDir, trace);
    const result = runInstall(home, ["--skip-skill"], gitEnv(home, hub, binDir, trace, { AH_INSTALL_SKIP_FETCH: "1" }));
    const out = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, out);
    assert.equal(fs.readlinkSync(path.join(home, ".local", "bin", "ah")), ahTarget);
    assert.equal(fs.readlinkSync(path.join(home, ".local", "bin", "a2a-hub")), ahTarget);
    assert.equal(fs.readlinkSync(path.join(home, ".local", "bin", "ahub")), ahTarget);
    assert.equal(fs.readlinkSync(path.join(home, ".local", "bin", "lah")), outside);
    assert.match(out, /保留已有命令/);
    assert.match(out, /zsh/);
    assert.match(out, /\.zshrc/);
    assert.match(out, /\.bashrc/);
  });
});

test("ah setup --yes 与 ah join 拒绝覆盖旧飞书 node.json", async () => {
  await withTemp(async (home) => {
    const configDir = path.join(home, "cfg");
    fs.mkdirSync(configDir, { recursive: true });
    const nodeJson = path.join(configDir, "node.json");
    const body = JSON.stringify({ node: "mac-mini", busType: "feishu", events: true }, null, 2) + "\n";
    fs.writeFileSync(nodeJson, body);
    const env = { ...process.env, HOME: home, HUB_NODE_HOME: configDir };
    const setup = spawnSync(process.execPath, [
      ah, "setup", "--role", "hub", "--bus", "sqlite", "--yes", "--auto-token", "--skip-skill", "--config", configDir,
    ], { env, encoding: "utf8" });
    const setupOut = `${setup.stdout}\n${setup.stderr}`;
    assert.equal(setup.status, 4, setupOut);
    assert.match(setupOut, /旧版飞书/);
    assert.doesNotMatch(setupOut, /feishu-secret/);
    assert.equal(fs.readFileSync(nodeJson, "utf8"), body);

    fs.writeFileSync(nodeJson, JSON.stringify({ node: "mac-mini", baseToken: SECRET, tables: { tasks: "tbl" } }, null, 2) + "\n");
    const beforeJoin = fs.readFileSync(nodeJson, "utf8");
    const join = spawnSync(process.execPath, [
      ah, "join", "http://127.0.0.1:9", "--skip-skill", "--no-daemon", "--config", configDir,
    ], { env, encoding: "utf8" });
    const joinOut = `${join.stdout}\n${join.stderr}`;
    assert.notEqual(join.status, 0, joinOut);
    assert.match(joinOut, /旧版飞书/);
    assert.doesNotMatch(joinOut, new RegExp(SECRET));
    assert.equal(fs.readFileSync(nodeJson, "utf8"), beforeJoin);
  });
});
