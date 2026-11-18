// Web 控制台输出与内嵌脚本语法、安全转义及结构完整性测试。

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES } from "../src/bus/tables.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { LongPollBroker } from "../src/server/longpoll-broker.mjs";
import { renderWebConsoleHtml } from "../src/server/web-ui.mjs";
import { withTemp } from "./helpers.mjs";

test("renderWebConsoleHtml 输出完整单页、零外链且内嵌 JS 语法无误", () => {
  const html = renderWebConsoleHtml();
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<\/html>\s*$/);
  // 零外网 CDN / 字体 / 脚本依赖
  assert.equal(/https?:\/\/(cdn|unpkg|jsdelivr|fonts\.googleapis)/i.test(html), false);

  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "页面应包含内嵌 <script> 标签");
  // 使用 vm.Script 编译校验内嵌 JS 语法，防止模板字符串转义失误导致浏览器报 SyntaxError
  assert.doesNotThrow(() => new vm.Script(scriptMatch[1], { filename: "web-ui-inline.js" }));
});

test("控制台包含大白话信息架构、三步向导、可视化验收清单与深浅色适配，且无命令行参数残留", () => {
  const html = renderWebConsoleHtml();

  // 首页「待我处理」与「一切正常」及状态中文映射
  assert.match(html, /待我处理/);
  assert.match(html, /一切正常/);
  assert.match(html, /Agent 在线状态概览/);
  assert.match(html, /等待审批/);
  assert.match(html, /等待答复/);
  assert.match(html, /执行中/);
  assert.match(html, /待认领/);

  // 派单表单只露 3 项，高级选项收起，验收清单改为行编辑器且去掉命令行参数名
  assert.match(html, /交给谁/);
  assert.match(html, /要做什么/);
  assert.match(html, /执行前需要我批准/);
  assert.match(html, /高级选项/);
  assert.match(html, /添加一条要求/);
  assert.match(html, /需要证据/);
  const withoutStyleAndVars = html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/var\(--[a-z0-9-]+\)/g, "");
  assert.equal(/--to\b|--cap\b|--text\b|--criteria\b/.test(withoutStyleAndVars), false);

  // Agent 页：名词解释、节点卡片展开与技术详情折叠
  assert.match(html, /名词一分钟看懂/);
  assert.match(html, /技术详情/);
  assert.match(html, /展开能力/);

  // 三步添加 Agent 向导与 Token 一次性提示、密钥管理对接约定 A
  assert.match(html, /选择接入类型/);
  assert.match(html, /填写名字与角色/);
  assert.match(html, /Token 只显示这一次/);
  assert.match(html, /\/api\/v1\/admin\/tokens/);
  assert.match(html, /重新生成/);
  assert.match(html, /吊销/);

  // 深浅色与窄屏导航适配
  assert.match(html, /prefers-color-scheme:\s*light/);
  assert.match(html, /mobile-nav/);
});

test("startHubHttpServer GET / 返回可用控制台 HTML", async () => {
  await withTemp(async (dir) => {
    const broker = new LongPollBroker({ initialSeq: 0 });
    const bus = new SqliteBus({ dbPath: path.join(dir, "hub.db"), tables: DEFAULT_TABLES, broker });
    const handle = await startHubHttpServer({
      cfg: { node: "test-hub", configDir: dir, listen: "127.0.0.1:0", apiToken: "" },
      bus,
      broker,
      log: () => {},
      onWake: () => {},
    });
    try {
      const res = await fetch(handle.localUrl + "/");
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") || "", /text\/html/);
      const body = await res.text();
      assert.match(body, /A2A-Hub/);
      assert.match(body, /待我处理/);
    } finally {
      await handle.close();
      bus.close();
    }
  });
});
