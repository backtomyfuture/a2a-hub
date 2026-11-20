// macOS LaunchAgent 重启竞态修复测试：
// bootout 是异步卸载，旧守护进程退出清理要数秒，退出前 bootstrap 会报 5: Input/output error。
// 覆盖 awaitLaunchdUnload / bootstrapAndVerify 两个辅助函数，以及普通安装与 --ensure 两条路径。
// 通过 _deps 注入 mock launchctl / 假时钟 / 临时目录，状态只写系统临时目录，不真等待。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  awaitLaunchdUnload,
  bootstrapAndVerify,
  computeProxyFingerprint,
  service,
} from "../src/service.mjs";
import { withTemp } from "./helpers.mjs";

const APP_DIR = "/opt/a2a-hub";
const UID = "501";
const LABEL = "ah-node.macbook";

function captureOutput(fn) {
  const stdout = [];
  const stderr = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  console.log = (...args) => stdout.push(args.join(" "));
  console.warn = (...args) => stderr.push(args.join(" "));
  console.error = (...args) => stderr.push(args.join(" "));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origErr;
    })
    .then((res) => ({ res, stdout: stdout.join("\n"), stderr: stderr.join("\n") }));
}

// 用默认配置目录 home/.a2a-hub：selectAutostartName 不追加路径摘要后缀，label 可预测。
function setupDefaultConfigDir(dir, node = "macbook", role = "node") {
  const homeDir = path.join(dir, "home");
  const cfgDir = path.join(homeDir, ".a2a-hub");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "node.json"), JSON.stringify({ node, role }, null, 2));
  return { cfgDir, homeDir };
}

// 假时钟：sleep 立即 resolve 但推进时钟，测试不真等 30 秒。
function makeFakeClock() {
  const state = { ms: 0 };
  return {
    now: () => state.ms,
    sleep: async (ms) => { state.ms += ms; },
  };
}

function ioError(msg) {
  const err = new Error(msg);
  err.stderr = msg;
  return err;
}

// 模拟 launchctl 行为：
// - bootout 立即成功；
// - print 在旧服务退出前成功、退出后抛错（模拟异步卸载）；bootout 之前按 initiallyActive 决定成败（--ensure 探测）；
// - bootstrap 在旧服务还没退出（时钟 < bootstrapIoErrorUntilMs）时报 5: Input/output error，之后成功；
//   bootstrapFailMsg 非空时 bootstrap 恒失败（模拟非竞态错误）。
// oldExitAtMs = Infinity 表示旧服务在超时窗口内一直不退出（print 缓存不清），
// 此时把 bootstrapIoErrorUntilMs 设为 0：超时后 bootstrap 应当成功（旧进程可能已死）。
function makeLaunchctlMock({
  oldExitAtMs = 3000,
  initiallyActive = false,
  bootstrapFailMsg = "",
  bootstrapIoErrorUntilMs = oldExitAtMs,
} = {}) {
  const calls = [];
  const clock = makeFakeClock();
  let bootoutDone = false;
  let loaded = false;

  const printOk = () => {
    if (loaded) return true;
    if (!bootoutDone) return initiallyActive;
    return clock.now() < oldExitAtMs;
  };

  const exec = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd !== "launchctl") throw ioError(`unexpected call: ${cmd} ${args.join(" ")}`);
    const sub = args[0];
    if (sub === "bootout") {
      bootoutDone = true;
      return "";
    }
    if (sub === "bootstrap") {
      if (bootstrapFailMsg) throw ioError(bootstrapFailMsg);
      if (!loaded && clock.now() < bootstrapIoErrorUntilMs) {
        throw ioError("Bootstrap failed: 5: Input/output error");
      }
      loaded = true;
      return "";
    }
    if (sub === "print") {
      if (printOk()) return `service = gui/${UID}/${LABEL} (pid = 4242)\n`;
      throw ioError(`Could not find service "${LABEL}" in GUI domain`);
    }
    throw ioError(`unexpected launchctl subcommand: ${sub}`);
  };

  return { exec, calls, clock };
}

function serviceDeps(mock, homeDir, env) {
  return {
    platform: "darwin",
    getuid: () => 501,
    homedir: () => homeDir,
    env,
    execFileSync: mock.exec,
    sleep: mock.clock.sleep,
    now: mock.clock.now,
    spawn: () => {
      throw new Error("launchd 路径不应触发 spawn 降级");
    },
  };
}

test("awaitLaunchdUnload：print 抛错后返回 unloaded:true；超时窗口内不退出返回 unloaded:false 且不抛错", async () => {
  // 已卸载（print 恒抛错）：立即返回，elapsedMs = 0
  const gone = await awaitLaunchdUnload(
    () => { throw ioError("Could not find service"); },
    UID,
    "ah-node.m1",
    { sleep: async () => {}, now: () => 0 },
  );
  assert.deepEqual(gone, { unloaded: true, elapsedMs: 0 });

  // 仍在（print 恒成功）：等到 30 秒超时，返回 unloaded:false 而不是抛错，让调用方继续尝试 bootstrap
  const clock = makeFakeClock();
  const sleeps = [];
  const stuck = await awaitLaunchdUnload(
    () => "service = ...",
    UID,
    "ah-node.m2",
    { sleep: async (ms) => { sleeps.push(ms); await clock.sleep(ms); }, now: clock.now },
  );
  assert.equal(stuck.unloaded, false);
  assert.equal(stuck.elapsedMs, 30000);
  assert.equal(sleeps.length, 60);
  assert.ok(sleeps.every((ms) => ms === 500));

  // 3 秒后才卸载：按 500ms 轮询到 print 抛错为止
  const clock2 = makeFakeClock();
  const exec2 = (cmd, args) => {
    assert.equal(cmd, "launchctl");
    assert.deepEqual(args, ["print", `gui/${UID}/ah-node.m3`]);
    if (clock2.now() < 3000) return "service = ...";
    throw ioError("Could not find service");
  };
  const late = await awaitLaunchdUnload(exec2, UID, "ah-node.m3", { sleep: clock2.sleep, now: clock2.now });
  assert.equal(late.unloaded, true);
  assert.equal(late.elapsedMs, 3000);
});

test("bootstrapAndVerify：bootstrap 失败直接抛出不重试；成功后轮询 print 确认装载，超时抛出", async () => {
  // bootstrap 本身失败：不重试，直接抛出
  let bootstraps = 0;
  await assert.rejects(
    bootstrapAndVerify(
      (cmd, args) => {
        if (args[0] === "bootstrap") {
          bootstraps++;
          throw ioError("Bootstrap failed: 125: Domain does not support specified action");
        }
        throw new Error("bootstrap 失败后不应再 print");
      },
      UID,
      "ah-node.b1",
      "/tmp/x.plist",
      { sleep: async () => {} },
    ),
    /125: Domain does not support specified action/,
  );
  assert.equal(bootstraps, 1);

  // bootstrap 成功但 print 延迟可见：轮询到 print 成功为止
  const clock = makeFakeClock();
  const calls = [];
  await bootstrapAndVerify(
    (cmd, args) => {
      calls.push(args[0]);
      if (args[0] === "bootstrap") return "";
      if (clock.now() < 1500) throw ioError("Could not find service");
      return "service = ...";
    },
    UID,
    "ah-node.b2",
    "/tmp/x.plist",
    { sleep: clock.sleep, now: clock.now },
  );
  assert.equal(calls[0], "bootstrap");
  assert.ok(calls.filter((c) => c === "print").length >= 4);

  // bootstrap 成功但 print 10 秒内始终不可见：抛出验证失败，避免谎报安装成功
  const clock2 = makeFakeClock();
  await assert.rejects(
    bootstrapAndVerify(
      (cmd, args) => {
        if (args[0] === "bootstrap") return "";
        throw ioError("Could not find service");
      },
      UID,
      "ah-node.b3",
      "/tmp/x.plist",
      { sleep: clock2.sleep, now: clock2.now },
    ),
    /print 未确认服务 ah-node\.b3 已装载/,
  );
  assert.equal(clock2.now(), 10000);
});

test("macOS 普通安装：旧服务 3 秒后退出，等卸载完成再 bootstrap，print 验证通过后返回 0", async () => {
  await withTemp(async (dir) => {
    const { cfgDir, homeDir } = setupDefaultConfigDir(dir);
    const mock = makeLaunchctlMock({ oldExitAtMs: 3000 });
    const res = await captureOutput(() => service(cfgDir, {}, APP_DIR, serviceDeps(mock, homeDir, { PATH: "/usr/bin" })));

    assert.equal(res.res, 0);
    assert.match(res.stdout, new RegExp(`自启已安装并启动：${LABEL.replace(".", "\\.")}`));

    // 调用顺序：bootout -> print 轮询（旧服务退出前恒成功）-> bootstrap -> print 验证
    const bootoutIdx = mock.calls.indexOf(`launchctl bootout gui/${UID}/${LABEL}`);
    const bootstrapIdx = mock.calls.findIndex((c) => c.startsWith(`launchctl bootstrap gui/${UID} `));
    assert.ok(bootoutIdx >= 0);
    assert.ok(bootstrapIdx > bootoutIdx);
    // bootstrap 之前的 print 次数：t=0,500,...,2500 成功共 6 次，t=3000 抛错 1 次后才放行
    const printsBeforeBootstrap = mock.calls.slice(bootoutIdx + 1, bootstrapIdx).filter((c) => c.startsWith("launchctl print "));
    assert.equal(printsBeforeBootstrap.length, 7);
    // bootstrap 之后必须有一次 print 验证装载
    assert.ok(mock.calls.slice(bootstrapIdx + 1).some((c) => c.startsWith("launchctl print ")));
    // 旧服务退出前不应调用 bootstrap（bootstrapIoErrorUntilMs=3000 兜底），退出时刻恰为 3 秒
    assert.equal(mock.clock.now(), 3000);
  });
});

test("macOS 普通安装：旧服务 30 秒内未退出（超时）仍尝试 bootstrap，成功后返回 0", async () => {
  await withTemp(async (dir) => {
    const { cfgDir, homeDir } = setupDefaultConfigDir(dir);
    // print 恒成功（缓存不清），但超时后 bootstrap 能成功：模拟旧进程已死而 launchd print 未及时清
    const mock = makeLaunchctlMock({ oldExitAtMs: Infinity, bootstrapIoErrorUntilMs: 0 });
    const res = await captureOutput(() => service(cfgDir, {}, APP_DIR, serviceDeps(mock, homeDir, { PATH: "/usr/bin" })));

    assert.equal(res.res, 0);
    assert.match(res.stdout, /自启已安装并启动/);
    // 等满 30 秒超时窗口后仍继续 bootstrap，且 bootstrap 后有 print 验证
    assert.ok(mock.clock.now() >= 30000);
    const bootstrapIdx = mock.calls.findIndex((c) => c.startsWith(`launchctl bootstrap gui/${UID} `));
    assert.ok(bootstrapIdx >= 0);
    assert.ok(mock.calls.slice(bootstrapIdx + 1).some((c) => c.startsWith("launchctl print ")));
  });
});

test("macOS 普通安装：bootstrap 本身失败（非竞态原因）抛出错误，不假装成功", async () => {
  await withTemp(async (dir) => {
    const { cfgDir, homeDir } = setupDefaultConfigDir(dir);
    const mock = makeLaunchctlMock({
      oldExitAtMs: 0,
      bootstrapFailMsg: "Bootstrap failed: 125: Domain does not support specified action",
    });
    await assert.rejects(
      captureOutput(() => service(cfgDir, {}, APP_DIR, serviceDeps(mock, homeDir, { PATH: "/usr/bin" }))),
      /125: Domain does not support specified action/,
    );
    // 只调用了一次 bootstrap，没有 1 秒间隔盲重试
    assert.equal(mock.calls.filter((c) => c.startsWith("launchctl bootstrap ")).length, 1);
  });
});

test("macOS --ensure：服务已活跃且指纹未变时幂等返回 0，不调 bootout", async () => {
  await withTemp(async (dir) => {
    const { cfgDir, homeDir } = setupDefaultConfigDir(dir);
    const env = { PATH: "/usr/bin", HTTPS_PROXY: "http://u:proxy-secret@127.0.0.1:7890" };
    fs.writeFileSync(
      path.join(cfgDir, "service.env"),
      `AH_PROXY_FINGERPRINT=${computeProxyFingerprint(env)}\nAH_SERVICE_MODE=launchd\n`,
      { mode: 0o600 },
    );
    const mock = makeLaunchctlMock({ initiallyActive: true });
    const res = await captureOutput(() => service(cfgDir, { ensure: true }, APP_DIR, serviceDeps(mock, homeDir, env)));

    assert.equal(res.res, 0);
    assert.match(res.stdout, /active \(launchd/);
    assert.equal(mock.calls.some((c) => c.includes("bootout")), false);
    assert.equal(mock.calls.some((c) => c.includes("bootstrap")), false);
    // 输出不泄露代理凭据与指纹字段值
    assert.doesNotMatch(res.stdout + res.stderr, /proxy-secret|AH_PROXY_FINGERPRINT/);
  });
});

test("macOS --ensure：服务不活跃时走完整 bootout -> 等卸载 -> bootstrap -> print 验证流程并返回 0", async () => {
  await withTemp(async (dir) => {
    const { cfgDir, homeDir } = setupDefaultConfigDir(dir);
    const env = { PATH: "/usr/bin" };
    const mock = makeLaunchctlMock({ initiallyActive: false, oldExitAtMs: 3000 });
    const res = await captureOutput(() => service(cfgDir, { ensure: true }, APP_DIR, serviceDeps(mock, homeDir, env)));

    assert.equal(res.res, 0);
    assert.match(res.stdout, new RegExp(`ok: ${LABEL.replace(".", "\\.")}.* active \\(launchd`));
    // ensure 探测 print（抛错）之后：bootout -> 等卸载 -> bootstrap -> print 验证
    const bootoutIdx = mock.calls.indexOf(`launchctl bootout gui/${UID}/${LABEL}`);
    const bootstrapIdx = mock.calls.findIndex((c) => c.startsWith(`launchctl bootstrap gui/${UID} `));
    assert.ok(bootoutIdx >= 1, "bootout 前应有一次 ensure 活跃性探测 print");
    assert.equal(mock.calls[0], `launchctl print gui/${UID}/${LABEL}`);
    assert.ok(bootstrapIdx > bootoutIdx);
    assert.ok(mock.calls.slice(bootstrapIdx + 1).some((c) => c.startsWith("launchctl print ")));
    assert.equal(mock.clock.now(), 3000);
    // 写入了 0600 service.env 与 plist
    const savedEnv = fs.readFileSync(path.join(cfgDir, "service.env"), "utf8");
    assert.match(savedEnv, new RegExp(`AH_PROXY_FINGERPRINT=${computeProxyFingerprint(env)}`));
    assert.match(savedEnv, /AH_SERVICE_MODE=launchd/);
    const plistPath = path.join(homeDir, "Library", "LaunchAgents", `${LABEL}.plist`);
    assert.ok(fs.existsSync(plistPath));
    assert.match(fs.readFileSync(plistPath, "utf8"), /<key>Label<\/key>/);
  });
});
