// 节点模板目录：配置文件是完整清单。初始四条只在文件不存在时写入。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildOnboarding } from "../src/hub/admission.mjs";
import {
  AGENT_TEMPLATES_FILE,
  loadAgentTemplates,
  seedAgentTemplates,
} from "../src/hub/agent-templates.mjs";
import { reportAgentTemplates } from "../src/doctor.mjs";
import { withTemp } from "./helpers.mjs";

function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    fn();
    return lines.join("\n");
  } finally {
    console.log = orig;
  }
}

test("没有配置目录时用内存里的初始四条，不写文件", () => {
  const loaded = loadAgentTemplates("");
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.presets.map((item) => item.id), ["generic-poll", "workbuddy", "muse", "grok-bot"]);
});

test("种子文件的开场白填上占位符后，和程序默认提示词一致", () => {
  const presets = seedAgentTemplates();
  for (const preset of presets) {
    const args = {
      hubUrl: "https://hub.example",
      node: preset.defaults.node,
      access: "http",
      role: preset.role,
      templateId: preset.id,
      pollIntervalMin: preset.interval,
    };
    assert.equal(buildOnboarding({ ...args, presets }).prompt, buildOnboarding(args).prompt);
  }
});

test("文件不存在时写入初始四条；之后改过的内容不会被盖掉", async () => {
  await withTemp(async (dir) => {
    const first = loadAgentTemplates(dir, { writeIfMissing: true });
    assert.deepEqual(first.errors, []);
    const file = path.join(dir, AGENT_TEMPLATES_FILE);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    const buddy = stored.find((item) => item.id === "workbuddy");
    buddy.label = "我的 WorkBuddy";
    buddy.intro = "请在腾讯 WorkBuddy 里，以节点 {{node}} 的身份，每 {{interval}} 分钟看一次。";
    stored.push({
      id: "coze",
      label: "扣子",
      receive: "poll",
      interval: 15,
      defaults: { node: "coze-1", displayName: "扣子助手" },
      intro: "请在扣子里以节点 {{node}} 的身份，每 {{interval}} 分钟检查。令牌 {{token}}。",
    });
    fs.writeFileSync(file, JSON.stringify(stored, null, 2));
    const again = loadAgentTemplates(dir, { writeIfMissing: true });
    assert.equal(again.presets.find((item) => item.id === "workbuddy").label, "我的 WorkBuddy");
    assert.equal(again.presets.find((item) => item.id === "coze").label, "扣子");
    const ob = buildOnboarding({
      hubUrl: "https://hub.example",
      node: "coze-1",
      access: "http",
      role: "worker",
      templateId: "coze",
      presets: again.presets,
      authRequired: true,
      token: "aht_test",
    });
    assert.match(ob.prompt, /请在扣子里以节点 coze-1/);
    assert.match(ob.prompt, /每 15 分钟/);
    assert.match(ob.prompt, /令牌 aht_test/);
    assert.match(ob.prompt, /\/api\/v1\/agents\/coze-1\/check/);
    const full = again.presets.map((item) => (
      item.id === "coze" ? { ...item, prompt: "只做这一句：节点 {{node}} 令牌 {{token}}。", intro: "不会用到" } : item
    ));
    const replaced = buildOnboarding({
      hubUrl: "https://hub.example",
      node: "coze-1",
      access: "http",
      role: "worker",
      templateId: "coze",
      presets: full,
      token: "aht_test",
    });
    assert.equal(replaced.prompt, "只做这一句：节点 coze-1 令牌 aht_test。");
  });
});

test("坏文件不覆盖，告警后仍能用初始四条；空数组保持为空", async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, AGENT_TEMPLATES_FILE);
    fs.writeFileSync(file, "{", { mode: 0o600 });
    const broken = loadAgentTemplates(dir, { writeIfMissing: true });
    assert.match(broken.errors.join("\n"), /不是合法 JSON/);
    assert.equal(fs.readFileSync(file, "utf8"), "{");
    assert.equal(broken.presets.length, 4);
    fs.writeFileSync(file, "[]");
    const empty = loadAgentTemplates(dir);
    assert.deepEqual(empty.presets, []);
    assert.deepEqual(empty.errors, []);
  });
});

test("doctor 在没有模板文件时不创建、不打印", async () => {
  await withTemp(async (dir) => {
    const text = capture(() => reportAgentTemplates(dir));
    assert.equal(text, "");
    assert.equal(fs.existsSync(path.join(dir, AGENT_TEMPLATES_FILE)), false);
  });
});
