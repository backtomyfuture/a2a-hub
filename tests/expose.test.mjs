// 公网暴露助手、Cloudflare Bot 探针、40 秒长轮询上限、反向代理头识别与公网安全门禁测试。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES } from "../src/bus/tables.mjs";
import { inferCloudPublicUrl, loadConfig } from "../src/config.mjs";
import { probePublicEndpoint, runExpose } from "../src/expose.mjs";
import { hubDoctor } from "../src/hub/index.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { LongPollBroker, MAX_LONGPOLL_MS, MAX_LONGPOLL_SEC } from "../src/server/longpoll-broker.mjs";
import { withTemp } from "./helpers.mjs";

test("长轮询 hold 窗口上限严格收紧为 40 秒，防止反向代理 60~100 秒超时断流", async () => {
  assert.equal(MAX_LONGPOLL_SEC, 40);
  assert.equal(MAX_LONGPOLL_MS, 40_000);

  const broker = new LongPollBroker({ initialSeq: 1 });
  // 验证超出 40 秒的 timeoutMs 不会被放行（用 spy setTimeout 检查实际调度时长）。
  const origSetTimeout = globalThis.setTimeout;
  const scheduled = [];
  globalThis.setTimeout = (fn, ms, ...args) => {
    scheduled.push(ms);
    return origSetTimeout(fn, ms, ...args);
  };
  const ac = new AbortController();
  const waitP = broker.wait({ node: "n1", cursor: 1, timeoutMs: 120_000, signal: ac.signal });
  try {
    assert.equal(scheduled[0], MAX_LONGPOLL_MS);
    ac.abort();
    const res = await waitP;
    assert.equal(res.wake, false);
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

test("inferCloudPublicUrl 与 loadConfig 支持云平台环境变量、PORT 与 webConsole 开关", async () => {
  assert.equal(inferCloudPublicUrl({ AH_PUBLIC_URL: "https://my.hub.example/" }), "https://my.hub.example");
  assert.equal(inferCloudPublicUrl({ RENDER_EXTERNAL_URL: "https://ah.onrender.com/" }), "https://ah.onrender.com");
  assert.equal(inferCloudPublicUrl({ ZEABUR_WEB_URL: "https://ah.zeabur.app" }), "https://ah.zeabur.app");
  assert.equal(inferCloudPublicUrl({ RAILWAY_PUBLIC_DOMAIN: "ah-prod.up.railway.app" }), "https://ah-prod.up.railway.app");
  assert.equal(inferCloudPublicUrl({ FLY_APP_NAME: "my-a2a-hub" }), "https://my-a2a-hub.fly.dev");
  assert.equal(inferCloudPublicUrl({}), "");

  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({
      node: "cloud-hub",
      role: "hub",
      busType: "sqlite",
      listen: "0.0.0.0:8787",
    }));
    const prevPort = process.env.PORT;
    const prevPub = process.env.RAILWAY_PUBLIC_DOMAIN;
    const prevUi = process.env.AH_DISABLE_WEB_UI;
    process.env.PORT = "9090";
    process.env.RAILWAY_PUBLIC_DOMAIN = "hub.up.railway.app";
    process.env.AH_DISABLE_WEB_UI = "1";
    try {
      const cfg = loadConfig(dir);
      assert.equal(cfg.listen, "0.0.0.0:9090");
      assert.equal(cfg.publicUrl, "https://hub.up.railway.app");
      assert.equal(cfg.webConsole, false);
      cfg.bus?.close?.();
    } finally {
      if (prevPort === undefined) delete process.env.PORT; else process.env.PORT = prevPort;
      if (prevPub === undefined) delete process.env.RAILWAY_PUBLIC_DOMAIN; else process.env.RAILWAY_PUBLIC_DOMAIN = prevPub;
      if (prevUi === undefined) delete process.env.AH_DISABLE_WEB_UI; else process.env.AH_DISABLE_WEB_UI = prevUi;
    }
  });
});

test("HTTP 服务端识别 X-Forwarded-Proto 生成 https 接入指引，并支持 webConsole=false 关闭控制台", async () => {
  await withTemp(async (dir) => {
    const broker = new LongPollBroker({ initialSeq: 0 });
    const bus = new SqliteBus({ dbPath: path.join(dir, "hub.db"), tables: DEFAULT_TABLES, broker });
    const handle = await startHubHttpServer({
      cfg: { node: "proxy-hub", configDir: dir, listen: "127.0.0.1:0", apiToken: "owner-sec", webConsole: false },
      bus,
      broker,
      log: () => {},
    });
    try {
      const uiRes = await fetch(`${handle.localUrl}/`);
      assert.equal(uiRes.status, 404);

      const obRes = await fetch(`${handle.localUrl}/api/v1/admin/onboarding?node=bot1&access=http&role=worker`, {
        headers: {
          authorization: "Bearer owner-sec",
          "x-forwarded-host": "hub.ts.net",
          "x-forwarded-proto": "https",
        },
      });
      assert.equal(obRes.status, 200);
      const obJson = await obRes.json();
      assert.equal(obJson.onboarding.skills[0].url, "https://hub.ts.net/api/v1/skills/a2a-worker");

      // 无 x-forwarded-host 时只升级协议为 https://，保留本地 Host 头。
      const obLocalRes = await fetch(`${handle.localUrl}/api/v1/admin/onboarding?node=bot2&access=http&role=worker`, {
        headers: {
          authorization: "Bearer owner-sec",
          "x-forwarded-proto": "https",
        },
      });
      assert.equal(obLocalRes.status, 200);
      const obLocalJson = await obLocalRes.json();
      assert.ok(obLocalJson.onboarding.skills[0].url.startsWith("https://127.0.0.1:"));
    } finally {
      await handle.close();
      bus.close();
    }
  });
});

test("probePublicEndpoint 识别正常 Hub JSON 与 Cloudflare WAF/Bot Fight Mode 拦截", async () => {
  const okProbe = await probePublicEndpoint("https://hub.example/", {
    fetchImpl: async (url) => {
      assert.equal(url, "https://hub.example/api/v1/health");
      return new Response(JSON.stringify({ ok: true, node: "mini", authRequired: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(okProbe.ok, true);
  assert.equal(okProbe.cfBlocked, false);
  assert.equal(okProbe.hubNode, "mini");
  assert.equal(okProbe.authRequired, true);

  const cfChal = await probePublicEndpoint("https://hub.example", {
    fetchImpl: async () => new Response("<html><title>Just a moment...</title></html>", {
      status: 403,
      headers: { "content-type": "text/html", server: "cloudflare", "cf-mitigated": "challenge" },
    }),
  });
  assert.equal(cfChal.ok, false);
  assert.equal(cfChal.cfBlocked, true);
  assert.match(cfChal.remediation, /Bot Fight Mode/);
  assert.match(cfChal.remediation, /\/api\/v1\//);

  const cf1010 = await probePublicEndpoint("https://hub.example", {
    fetchImpl: async () => new Response("error code: 1010", {
      status: 403,
      headers: { "content-type": "text/plain", "cf-ray": "99abc-LAX" },
    }),
  });
  assert.equal(cf1010.ok, false);
  assert.equal(cf1010.cfBlocked, true);
  assert.match(cf1010.remediation, /Skip/);
});

test("runExpose：未配 apiToken 拒绝暴露；Tailscale Funnel 开启/状态/CF 拦截检测/关闭全链路", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({
      node: "mini-hub",
      role: "hub",
      busType: "sqlite",
      listen: "0.0.0.0:8787",
    }, null, 2));

    const logs = [];
    const errs = [];
    // 1) 无 apiToken 直接拒绝暴露
    const deniedCode = await runExpose(dir, ["tailscale"], {
      env: {},
      log: (m) => logs.push(m),
      errLog: (m) => errs.push(m),
      execFileSync: () => { throw new Error("should not call tailscale without token"); },
    });
    assert.equal(deniedCode, 1);
    assert.match(errs.join("\n"), /拒绝无口令公网暴露/);

    // 2) --auto-token 自动生成 0600 app.env、执行 tailscale funnel 并回填 publicUrl
    const tsCalls = [];
    const okCode = await runExpose(dir, ["tailscale", "--auto-token"], {
      env: {},
      log: (m) => logs.push(m),
      errLog: (m) => errs.push(m),
      execFileSync: (bin, args) => {
        tsCalls.push([bin, ...args]);
        if (args[0] === "status") {
          return JSON.stringify({ BackendState: "Running", Self: { DNSName: "mini-hub.tail99.ts.net." } });
        }
        return "";
      },
      fetchImpl: async () => new Response(JSON.stringify({ ok: true, node: "mini-hub", authRequired: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    assert.equal(okCode, 0);
    assert.deepEqual(tsCalls, [
      ["tailscale", "status", "--json"],
      ["tailscale", "funnel", "--bg", "8787"],
    ]);
    const savedNode = JSON.parse(fs.readFileSync(path.join(dir, "node.json"), "utf8"));
    assert.equal(savedNode.publicUrl, "https://mini-hub.tail99.ts.net");
    assert.equal(fs.statSync(path.join(dir, "app.env")).mode & 0o777, 0o600);

    // 3) hubDoctor 在无 apiToken 但有 publicUrl 时报错
    const noAuthDir = path.join(dir, "no-auth");
    fs.mkdirSync(noAuthDir, { recursive: true });
    fs.writeFileSync(path.join(noAuthDir, "node.json"), JSON.stringify({
      node: "unsafe-hub",
      role: "hub",
      busType: "sqlite",
      listen: "0.0.0.0:8787",
      publicUrl: "https://unsafe.example.com",
    }));
    const badProblems = await hubDoctor(noAuthDir, { probePublic: false });
    assert.ok(badProblems >= 1);

    // 4) ah expose cf 检测到 Cloudflare 质询拦截返回 1 并提示准确排障建议
    errs.length = 0;
    const cfErrCode = await runExpose(dir, ["cf", "https://cf-hub.example.com"], {
      env: {},
      log: (m) => logs.push(m),
      errLog: (m) => errs.push(m),
      fetchImpl: async () => new Response("<html>Just a moment...</html>", {
        status: 403,
        headers: { "content-type": "text/html", server: "cloudflare", "cf-mitigated": "challenge" },
      }),
    });
    assert.equal(cfErrCode, 1);
    assert.match(errs.join("\n"), /Bot Fight Mode/);

    // 5) ah expose off 关闭 Funnel 并删除 publicUrl
    const offCalls = [];
    const offCode = await runExpose(dir, ["off"], {
      env: {},
      log: (m) => logs.push(m),
      errLog: (m) => errs.push(m),
      execFileSync: (bin, args) => {
        offCalls.push([bin, ...args]);
        return "";
      },
    });
    assert.equal(offCode, 0);
    assert.deepEqual(offCalls, [["tailscale", "funnel", "--https=443", "off"]]);
    const clearedNode = JSON.parse(fs.readFileSync(path.join(dir, "node.json"), "utf8"));
    assert.equal(Object.hasOwn(clearedNode, "publicUrl"), false);
  });
});
