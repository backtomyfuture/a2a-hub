import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExternalNotifier } from "../src/core/notifier.mjs";
import { signWebhookPayload, validateWebhookUrl, WebhookDispatcher } from "../src/core/webhooks.mjs";
import { HubStore } from "../src/store/db.mjs";

test("Webhooks: URL SSRF 拦截、HMAC-SHA256 签名与禁止跟随重定向", async () => {
  assert.equal(validateWebhookUrl("http://169.254.169.254/latest").ok, false);
  assert.equal(validateWebhookUrl("ftp://example.com").ok, false);
  assert.equal(validateWebhookUrl("https://bot.example.com/hook").ok, true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-wh-"));
  try {
    const store = new HubStore(path.join(dir, "hub.db"));
    store.createAgent({
      id: "wh-bot",
      name: "WH Bot",
      transport: "webhook",
      webhook_url: "https://bot.example.com/doorbell",
      webhook_secret: "wh_sec_123",
      webhook_header: "X-Hub-Sig",
    });

    const calls = [];
    const mockFetch = async (url, opts) => {
      calls.push({ url, opts });
      assert.equal(opts.redirect, "manual");
      return { ok: true, status: 200 };
    };

    const dispatcher = new WebhookDispatcher(store, {
      fetchFn: mockFetch,
      hubUrlResolver: () => "https://hub.example.com",
    });

    dispatcher.handleEvent({
      type: "task.created",
      seq: 1,
      taskId: "tsk_1",
      contextId: "ctx_1",
      fromNode: "owner",
      agentId: "wh-bot",
      state: "submitted",
      title: "新任务",
    });
    // 重复投递同一事件应去重
    dispatcher.handleEvent({
      type: "task.created",
      seq: 1,
      taskId: "tsk_1",
      contextId: "ctx_1",
      fromNode: "owner",
      agentId: "wh-bot",
      state: "submitted",
      title: "新任务",
    });

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls.length, 1);
    const sig = calls[0].opts.headers["X-Hub-Sig"];
    assert.equal(sig, signWebhookPayload("wh_sec_123", calls[0].opts.body));

    // 重定向拦截验证
    const redirectDispatcher = new WebhookDispatcher(store, {
      fetchFn: async () => ({ ok: false, status: 302 }),
    });
    const redirRes = await redirectDispatcher.testAgentWebhook("wh-bot");
    assert.equal(redirRes.ok, false);
    assert.match(redirRes.error, /重定向/);

    // Grok Bot 模式：webhook_header=Authorization 时发送 Bearer <secret> 并保留 X-A2A-Signature
    store.createAgent({
      id: "grok-wh",
      name: "Grok WH",
      transport: "webhook",
      webhook_url: "https://grok.example.com/routine",
      webhook_secret: "grok_routine_key",
      webhook_header: "Authorization",
    });
    const grokCalls = [];
    const grokDispatcher = new WebhookDispatcher(store, {
      fetchFn: async (url, opts) => {
        grokCalls.push({ url, opts });
        return { ok: true, status: 200 };
      },
      hubUrlResolver: () => "https://hub.example.com",
    });
    const grokRes = await grokDispatcher.testAgentWebhook("grok-wh");
    assert.equal(grokRes.ok, true);
    assert.equal(grokCalls.length, 1);
    assert.equal(grokCalls[0].opts.headers.Authorization, "Bearer grok_routine_key");
    assert.equal(
      grokCalls[0].opts.headers["X-A2A-Signature"],
      signWebhookPayload("grok_routine_key", grokCalls[0].opts.body)
    );

    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ExternalNotifier: 飞书/Bark/Telegram/Webhook 多渠道投递与 action 过滤", async () => {
  const sent = [];
  const notifier = new ExternalNotifier(
    {
      AH_FEISHU_WEBHOOK: "https://open.feishu.cn/hook/abc",
      AH_BARK_URL: "https://api.day.app/mykey",
      AH_NOTIFY_ON: "action",
    },
    {
      fetchFn: async (url, opts) => {
        sent.push({ url, body: JSON.parse(opts.body) });
        return { ok: true, status: 200 };
      },
      hubUrlResolver: () => "https://hub.example.com",
    }
  );

  // action 模式下 completed 不触发打扰
  notifier.handleEvent({ type: "task.completed", seq: 1, taskId: "tsk_ok", agentId: "a1", title: "完成" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 0);

  // auth_required 立即推送到飞书 + Bark，并带控制台深链
  notifier.handleEvent({
    type: "task.auth_required",
    seq: 2,
    taskId: "tsk_auth",
    contextId: "ctx_9",
    agentId: "claude",
    title: "高危操作",
    reason: "需要审批",
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 2);
  assert.ok(sent[0].body.content.text.includes("thread=ctx_9"));
  assert.ok(sent[1].body.url.includes("task=tsk_auth"));
});
