// 2×2 四类 Skill 矩阵、按角色隔离安装、已装 Skill 刷新与 CLI 入口测试。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DAEMON_VERSION } from "../src/kernel.mjs";
import { installLocalSkills, resolveSkillsForHost } from "../src/setup.mjs";
import { refreshSkill } from "../src/update.mjs";
import { withTemp } from "./helpers.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

test("resolveSkillsForHost：按 role × kind 精确决定本地 CLI Skill 集合", () => {
  assert.deepEqual(resolveSkillsForHost({ role: "hub", kind: "host" }), ["ah"]);
  assert.deepEqual(resolveSkillsForHost({ role: "node", kind: "host" }), ["ah"]);
  assert.deepEqual(resolveSkillsForHost({ role: "node", kind: "agent" }), ["ah-inbox"]);
  assert.deepEqual(resolveSkillsForHost({ role: "hub", kind: "agent" }), ["ah", "ah-inbox"]);
  assert.deepEqual(resolveSkillsForHost({}), ["ah"]);
});

test("installLocalSkills：host 机器不误装 ah-inbox，kind=agent 按节点角色隔离", async () => {
  await withTemp(async (tmpDir) => {
    const hostRoot = path.join(tmpDir, "host-skills");
    const hostInstalled = installLocalSkills(REPO_ROOT, {
      role: "node",
      kind: "host",
      skillsRoot: hostRoot,
      log: () => {},
    });
    assert.deepEqual(hostInstalled.map((x) => x.name), ["ah"]);
    assert.equal(fs.existsSync(path.join(hostRoot, "ah", "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(hostRoot, "ah-inbox", "SKILL.md")), false);
    assert.equal(fs.existsSync(path.join(hostRoot, "a2a-worker", "SKILL.md")), false);

    const agentNodeRoot = path.join(tmpDir, "agent-node-skills");
    const agentNodeInstalled = installLocalSkills(REPO_ROOT, {
      role: "node",
      kind: "agent",
      skillsRoot: agentNodeRoot,
      log: () => {},
    });
    assert.deepEqual(agentNodeInstalled.map((x) => x.name), ["ah-inbox"]);
    assert.equal(fs.existsSync(path.join(agentNodeRoot, "ah-inbox", "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(agentNodeRoot, "ah", "SKILL.md")), false);

    const agentHubRoot = path.join(tmpDir, "agent-hub-skills");
    const agentHubInstalled = installLocalSkills(REPO_ROOT, {
      role: "hub",
      kind: "agent",
      skillsRoot: agentHubRoot,
      log: () => {},
    });
    assert.deepEqual(agentHubInstalled.map((x) => x.name), ["ah", "ah-inbox"]);
    assert.equal(fs.existsSync(path.join(agentHubRoot, "ah", "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(agentHubRoot, "ah-inbox", "SKILL.md")), true);

    const skippedRoot = path.join(tmpDir, "skipped-skills");
    assert.deepEqual(
      installLocalSkills(REPO_ROOT, {
        role: "hub",
        kind: "agent",
        skipSkill: true,
        skillsRoot: skippedRoot,
        log: () => {},
      }),
      [],
    );
    assert.equal(fs.existsSync(skippedRoot), false);
  });
});

test("refreshSkill：升级时结合 node.json 与已装 Skill 精准刷新", async () => {
  await withTemp(async (tmpDir) => {
    const cfgDir = path.join(tmpDir, "agent-cfg");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, "node.json"), JSON.stringify({ role: "node", kind: "agent" }));

    const skillsRoot = path.join(tmpDir, "skills-root");
    assert.deepEqual(refreshSkill(REPO_ROOT, true, cfgDir, skillsRoot), []);

    // kind=agent, role=node 仅刷新 ah-inbox
    assert.deepEqual(refreshSkill(REPO_ROOT, false, cfgDir, skillsRoot), ["ah-inbox"]);
    assert.equal(fs.existsSync(path.join(skillsRoot, "ah-inbox", "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(skillsRoot, "ah", "SKILL.md")), false);

    // 即使不传 configDir，若之前装过 ah，也会一并保留刷新
    fs.mkdirSync(path.join(skillsRoot, "ah"), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, "ah", "SKILL.md"), "stale");
    const synced = refreshSkill(REPO_ROOT, false, "", skillsRoot);
    assert.deepEqual(synced.sort(), ["ah", "ah-inbox"]);
    assert.equal(
      fs.readFileSync(path.join(skillsRoot, "ah", "SKILL.md"), "utf8"),
      fs.readFileSync(path.join(REPO_ROOT, "skills", "ah", "SKILL.md"), "utf8"),
    );

    // 目录里只有无关文件时，不把它当成已装 Skill；无 configDir 则默认补齐主控 ah
    const unrelatedRoot = path.join(tmpDir, "unrelated-skills");
    fs.mkdirSync(path.join(unrelatedRoot, "notes"), { recursive: true });
    fs.writeFileSync(path.join(unrelatedRoot, "notes", "SKILL.md"), "keep");
    const unrelated = refreshSkill(REPO_ROOT, false, "", unrelatedRoot);
    assert.deepEqual(unrelated, ["ah"]);
    assert.equal(fs.readFileSync(path.join(unrelatedRoot, "notes", "SKILL.md"), "utf8"), "keep");

    // 全空目录且无 configDir 时默认补齐主控 ah
    const freshRoot = path.join(tmpDir, "fresh-skills");
    assert.deepEqual(refreshSkill(REPO_ROOT, false, "", freshRoot), ["ah"]);
  });
});

test("4 套 Skill 文件格式完整且角色边界隔离清晰", () => {
  const names = ["ah", "ah-inbox", "a2a-leader", "a2a-worker"];
  for (const name of names) {
    const raw = fs.readFileSync(path.join(REPO_ROOT, "skills", name, "SKILL.md"), "utf8");
    assert.match(raw, new RegExp(`^---\\nname: ${name}\\n`, "m"));
  }
  const leaderHttp = fs.readFileSync(path.join(REPO_ROOT, "skills", "a2a-leader", "SKILL.md"), "utf8");
  const workerHttp = fs.readFileSync(path.join(REPO_ROOT, "skills", "a2a-worker", "SKILL.md"), "utf8");
  assert.doesNotMatch(leaderHttp, /\bah\s+(task|inbox|setup|inventory|loop)\b/);
  assert.doesNotMatch(workerHttp, /\bah\s+(task|inbox|setup|inventory|loop)\b/);
  assert.match(leaderHttp, /POST \/api\/v1\/tasks/);
  assert.match(workerHttp, /GET \/api\/v1\/agents\/\{node\}\/poll|\/poll\?timeout=/);
});

test("CLI 入口 ah 响应 --version，package.json 只登记 ah / a2a-hub / ahub", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg.bin).sort(), ["a2a-hub", "ah", "ahub"]);
  for (const target of Object.values(pkg.bin)) assert.equal(target, "bin/ah.mjs");
  const res = spawnSync(process.execPath, [path.join(REPO_ROOT, "bin", "ah.mjs"), "--version"], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), DAEMON_VERSION);
});
