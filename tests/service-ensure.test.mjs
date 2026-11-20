// ah service --ensure 幂等自愈模式测试：
// 覆盖 (a) 已 active/存活时幂等退出 0；(b) 全部降级路径不可用时退出 1；
// (c) 代理指纹变化触发重建；以及 --ensure 与 --remove/--uninstall 互斥与秘密零泄露。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { computeProxyFingerprint, service } from "../src/service.mjs";
import { withTemp } from "./helpers.mjs";

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AH_BIN = path.join(APP_DIR, "bin", "ah.mjs");

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

function setupConfigDir(dir, node = "muse", role = "node") {
  const cfgDir = path.join(dir, `.a2a-hub-${node}`);
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "node.json"), JSON.stringify({ node, role }, null, 2));
  return cfgDir;
}

function writeEnvWithFingerprint(cfgDir, env, mode = "system") {
  const fp = computeProxyFingerprint(env);
  const lines = [
    `AH_PROXY_FINGERPRINT=${fp}`,
    `AH_SERVICE_MODE=${mode}`,
    "NODE_USE_ENV_PROXY=1",
  ];
  fs.writeFileSync(path.join(cfgDir, "service.env"), `${lines.join("\n")}\n`, { mode: 0o600 });
}

test("(a) system/user unit 或 daemon.lock 已健康且代理指纹未变时，--ensure 幂等退出 0 且不触发重装或重启", async () => {
  await withTemp(async (dir) => {
    const env = {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://u:secret-token-1@127.0.0.1:7890",
      HTTP_PROXY: "http://127.0.0.1:7891",
      AH_API_TOKEN: "hub-secret-abc",
    };

    // a1) system unit 已 active
    const cfgSys = setupConfigDir(dir, "sysnode", "node");
    writeEnvWithFingerprint(cfgSys, env, "system");
    const sysCalls = [];
    let spawned = false;
    const sysRes = await captureOutput(() =>
      service(cfgSys, { ensure: true }, "/opt/a2a-hub", {
        platform: "linux",
        getuid: () => 1000,
        homedir: () => path.join(dir, "home-sys"),
        systemUnitDir: path.join(dir, "etc-systemd"),
        sleep: async () => {},
        env,
        spawn: () => {
          spawned = true;
          return { pid: 101, unref() {} };
        },
        execFileSync: (cmd, args) => {
          sysCalls.push([cmd, ...args]);
          if (cmd === "systemctl" && args[0] === "is-active" && args[1] === "ah-sysnode.service") {
            return "active\n";
          }
          throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
        },
      }),
    );
    assert.equal(sysRes.res, 0);
    assert.equal(spawned, false);
    assert.equal(sysRes.stdout.trim().split("\n").length, 1);
    assert.match(sysRes.stdout, /active \(system/);
    assert.equal(sysRes.stderr, "");
    assert.equal(sysCalls.some((c) => c.includes("restart") || c.includes("daemon-reload") || c.includes("enable")), false);
    assert.doesNotMatch(sysRes.stdout + sysRes.stderr, /secret-token-1|hub-secret-abc|AH_PROXY_FINGERPRINT/);

    // a2) user unit 已 active
    const cfgUser = setupConfigDir(dir, "usernode", "hub");
    writeEnvWithFingerprint(cfgUser, env, "user");
    const userCalls = [];
    const userRes = await captureOutput(() =>
      service(cfgUser, { ensure: true }, "/opt/a2a-hub", {
        platform: "linux",
        getuid: () => 1000,
        homedir: () => path.join(dir, "home-user"),
        systemUnitDir: path.join(dir, "etc-systemd"),
        sleep: async () => {},
        env,
        spawn: () => {
          spawned = true;
          return { pid: 102, unref() {} };
        },
        execFileSync: (cmd, args) => {
          userCalls.push([cmd, ...args]);
          if (cmd === "systemctl" && args[0] === "--user" && args[1] === "is-active" && args[2] === "ah-hub-usernode.service") {
            return "active\n";
          }
          const err = new Error("inactive");
          err.stdout = "inactive\n";
          throw err;
        },
      }),
    );
    assert.equal(userRes.res, 0);
    assert.equal(spawned, false);
    assert.equal(userRes.stdout.trim().split("\n").length, 1);
    assert.match(userRes.stdout, /active \(user/);
    assert.equal(userCalls.some((c) => c.includes("restart") || c.includes("daemon-reload") || c.includes("enable")), false);

    // a3) daemon.lock 指向存活且命令行含 ah.mjs daemon 的进程
    const cfgLock = setupConfigDir(dir, "locknode", "node");
    writeEnvWithFingerprint(cfgLock, env, "spawn");
    fs.writeFileSync(path.join(cfgLock, "daemon.lock"), "42424\n");
    const lockRes = await captureOutput(() =>
      service(cfgLock, { ensure: true }, "/opt/a2a-hub", {
        platform: "linux",
        getuid: () => 1000,
        homedir: () => path.join(dir, "home-lock"),
        systemUnitDir: path.join(dir, "etc-systemd"),
        sleep: async () => {},
        env,
        isPidAlive: (pid) => pid === 42424,
        readProcessCmdline: (pid) => (pid === 42424 ? `/usr/bin/node /opt/a2a-hub/bin/ah.mjs daemon --config ${cfgLock}` : ""),
        spawn: () => {
          spawned = true;
          return { pid: 103, unref() {} };
        },
        execFileSync: () => {
          const err = new Error("no systemd");
          err.code = "ENOENT";
          throw err;
        },
      }),
    );
    assert.equal(lockRes.res, 0);
    assert.equal(spawned, false);
    assert.equal(lockRes.stdout.trim().split("\n").length, 1);
    assert.match(lockRes.stdout, /daemon alive \(pid=42424/);
  });
});

test("按序收敛：system -> user -> 后台 spawn（写入 0600 service.env，验证 spawn 参数与存活确认）", async () => {
  await withTemp(async (dir) => {
    const cfgDir = setupConfigDir(dir, "spawny", "node");
    const homeDir = path.join(dir, "home");
    const sysDir = path.join(dir, "etc-systemd");
    fs.mkdirSync(homeDir, { recursive: true });

    // 放一个无关进程占用的旧 PID，验证不会被误杀
    fs.writeFileSync(path.join(cfgDir, "daemon.lock"), "9999\n");
    const killed = [];
    const spawnCalls = [];
    let unrefCalled = false;
    let alivePid = 0;

    const env = {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://alice:super-secret@127.0.0.1:7890",
      HTTP_PROXY: "http://127.0.0.1:7891",
      AH_API_TOKEN: "tok-do-not-print",
    };

    const { res, stdout, stderr } = await captureOutput(() =>
      service(cfgDir, { ensure: true }, "/opt/a2a-hub", {
        platform: "linux",
        execPath: "/usr/local/bin/node",
        getuid: () => 1000,
        homedir: () => homeDir,
        userInfo: () => ({ username: "alice" }),
        systemUnitDir: sysDir,
        sleep: async () => {},
        env,
        kill: (pid, sig) => killed.push([pid, sig]),
        isPidAlive: (pid) => pid === 9999 || pid === alivePid,
        readProcessCmdline: (pid) => (pid === 9999 ? "/usr/bin/python3 unrelated.py" : ""),
        execFileSync: (cmd, args) => {
          if (cmd === "sudo" && args[0] === "-n" && args[1] === "true") {
            throw new Error("sudo password required");
          }
          const err = new Error("Failed to connect to bus");
          throw err;
        },
        spawn: (bin, args, opts) => {
          // 启动前 service.env 必须已写入且权限 0600
          const envFile = path.join(cfgDir, "service.env");
          assert.equal(fs.existsSync(envFile), true);
          assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
          const envText = fs.readFileSync(envFile, "utf8");
          assert.match(envText, new RegExp(`^AH_PROXY_FINGERPRINT=${computeProxyFingerprint(env)}$`, "m"));
          assert.match(envText, /^AH_SERVICE_MODE=spawn$/m);
          assert.match(envText, /^NODE_USE_ENV_PROXY=1$/m);

          spawnCalls.push({ bin, args, opts });
          alivePid = 55667;
          fs.writeFileSync(path.join(cfgDir, "daemon.lock"), `${alivePid}\n`);
          return {
            pid: alivePid,
            unref() { unrefCalled = true; },
            once() {},
          };
        },
      }),
    );

    assert.equal(res, 0);
    assert.deepEqual(killed, []);
    assert.equal(unrefCalled, true);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].bin, "/usr/local/bin/node");
    assert.deepEqual(spawnCalls[0].args, ["/opt/a2a-hub/bin/ah.mjs", "daemon", "--config", cfgDir]);
    assert.equal(spawnCalls[0].opts.detached, true);
    assert.equal(spawnCalls[0].opts.stdio, "ignore");
    assert.equal(spawnCalls[0].opts.env.NODE_USE_ENV_PROXY, "1");
    assert.equal(spawnCalls[0].opts.env.HTTPS_PROXY, env.HTTPS_PROXY);
    assert.match(stdout, /daemon alive \(pid=55667, mode=spawn/);
    assert.equal(stderr, "");
    assert.doesNotMatch(stdout + stderr, /super-secret|tok-do-not-print|AH_PROXY_FINGERPRINT/);
  });
});

test("(b) 全部降级路径不可用时退出 1，且 --ensure --system 无权限时不降级", async () => {
  await withTemp(async (dir) => {
    const cfgDir = setupConfigDir(dir, "failnode", "node");
    const homeDir = path.join(dir, "home");
    const sysDir = path.join(dir, "etc-systemd");
    fs.mkdirSync(homeDir, { recursive: true });
    const env = {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://u:secret-pw@127.0.0.1:7890",
      AH_API_TOKEN: "secret-tok",
    };

    // 1) auto 下 system/user 不可用且 spawn 进程未能存活 -> 返回 1
    const allFail = await captureOutput(() =>
      service(cfgDir, { ensure: true }, "/opt/a2a-hub", {
        platform: "linux",
        getuid: () => 1000,
        homedir: () => homeDir,
        systemUnitDir: sysDir,
        sleep: async () => {},
        env,
        isPidAlive: () => false,
        execFileSync: () => {
          const err = new Error("System has not been booted with systemd");
          err.code = "ENOENT";
          throw err;
        },
        spawn: () => ({
          pid: 77889,
          unref() {},
          once() {},
        }),
      }),
    );
    assert.equal(allFail.res, 1);
    assert.match(allFail.stderr, /收敛失败/);
    assert.doesNotMatch(allFail.stdout + allFail.stderr, /secret-pw|secret-tok/);

    // 2) --ensure --system 无权限时严格返回 1 且不降级 spawn
    let spawned = false;
    const sysOnlyFail = await captureOutput(() =>
      service(cfgDir, { ensure: true, scope: "system" }, "/opt/a2a-hub", {
        platform: "linux",
        getuid: () => 1000,
        homedir: () => homeDir,
        systemUnitDir: sysDir,
        sleep: async () => {},
        env,
        spawn: () => {
          spawned = true;
          return { pid: 1, unref() {} };
        },
        execFileSync: () => {
          throw new Error("sudo required");
        },
      }),
    );
    assert.equal(sysOnlyFail.res, 1);
    assert.equal(spawned, false);
    assert.match(sysOnlyFail.stderr, /无 root 或免密 sudo 权限/);
  });
});

test("(c) 代理指纹变化时触发重建：systemd 活跃路径与 spawn 路径均正确更新 service.env 与重启", async () => {
  await withTemp(async (dir) => {
    const homeDir = path.join(dir, "home");
    const sysDir = path.join(dir, "etc-systemd");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(sysDir, { recursive: true });

    // c1) user systemd 已 active，但 HTTPS_PROXY 变化 -> 触发重建并更新指纹
    const cfgUser = setupConfigDir(dir, "rebuild-user", "node");
    const envV1 = { PATH: "/usr/bin", HTTPS_PROXY: "http://u:old-pass@127.0.0.1:7890" };
    const envV2 = { PATH: "/usr/bin", HTTPS_PROXY: "http://u:new-pass@127.0.0.1:7890" };
    writeEnvWithFingerprint(cfgUser, envV1, "user");

    const userCalls = [];
    const rebuildUser = await captureOutput(() =>
      service(cfgUser, { ensure: true }, "/opt/a2a-hub", {
        platform: "linux",
        getuid: () => 1000,
        homedir: () => homeDir,
        systemUnitDir: sysDir,
        sleep: async () => {},
        env: envV2,
        execFileSync: (cmd, args) => {
          userCalls.push([cmd, ...args]);
          if (cmd === "sudo" && args[0] === "-n") throw new Error("no sudo");
          if (cmd === "systemctl" && args.includes("is-active")) return "active\n";
          return "";
        },
      }),
    );
    assert.equal(rebuildUser.res, 0);
    assert.equal(userCalls.some((c) => c[0] === "systemctl" && c[1] === "--user" && c[2] === "restart"), true);
    const updatedEnv = fs.readFileSync(path.join(cfgUser, "service.env"), "utf8");
    assert.match(updatedEnv, new RegExp(`^AH_PROXY_FINGERPRINT=${computeProxyFingerprint(envV2)}$`, "m"));
    assert.match(updatedEnv, /new-pass/);
    assert.doesNotMatch(rebuildUser.stdout + rebuildUser.stderr, /old-pass|new-pass/);

    // c2) 直启 spawn 存活中，HTTP_PROXY 变化 -> 终止旧 ah.mjs daemon 并重新 spawn
    const cfgSpawn = setupConfigDir(dir, "rebuild-spawn", "node");
    writeEnvWithFingerprint(cfgSpawn, envV1, "spawn");
    fs.writeFileSync(path.join(cfgSpawn, "daemon.lock"), "30001\n");
    let oldAlive = true;
    let newAlive = false;
    const killed = [];
    const spawnCalls = [];

    const rebuildSpawn = await captureOutput(() =>
      service(cfgSpawn, { ensure: true }, "/opt/a2a-hub", {
        platform: "linux",
        getuid: () => 1000,
        homedir: () => homeDir,
        systemUnitDir: sysDir,
        sleep: async () => {},
        env: envV2,
        kill: (pid, sig) => {
          killed.push([pid, sig]);
          if (pid === 30001) oldAlive = false;
        },
        isPidAlive: (pid) => (pid === 30001 ? oldAlive : pid === 30002 ? newAlive : false),
        readProcessCmdline: (pid) => (pid === 30001 ? `/usr/bin/node /opt/a2a-hub/bin/ah.mjs daemon --config ${cfgSpawn}` : ""),
        execFileSync: () => {
          const err = new Error("no systemd");
          err.code = "ENOENT";
          throw err;
        },
        spawn: (bin, args, opts) => {
          spawnCalls.push({ bin, args, opts });
          newAlive = true;
          fs.writeFileSync(path.join(cfgSpawn, "daemon.lock"), "30002\n");
          return { pid: 30002, unref() {}, once() {} };
        },
      }),
    );
    assert.equal(rebuildSpawn.res, 0);
    assert.deepEqual(killed, [[30001, "SIGTERM"]]);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].opts.env.HTTPS_PROXY, envV2.HTTPS_PROXY);
    assert.match(fs.readFileSync(path.join(cfgSpawn, "service.env"), "utf8"), new RegExp(computeProxyFingerprint(envV2)));
  });
});

test("--ensure 与 --remove / --uninstall 互斥报错（API 与 CLI）", async () => {
  await withTemp(async (dir) => {
    const cfgDir = setupConfigDir(dir, "mutex", "node");

    const apiRemove = await captureOutput(() =>
      service(cfgDir, { ensure: true, remove: true }, APP_DIR, { platform: "linux" }),
    );
    assert.equal(apiRemove.res, 1);
    assert.match(apiRemove.stderr, /互斥/);

    const apiUninstall = await captureOutput(() =>
      service(cfgDir, { ensure: true, uninstall: true }, APP_DIR, { platform: "linux" }),
    );
    assert.equal(apiUninstall.res, 1);
    assert.match(apiUninstall.stderr, /互斥/);

    for (const conflictFlag of ["--remove", "--uninstall"]) {
      let exitCode = 0;
      let errOut = "";
      try {
        execFileSync(process.execPath, [AH_BIN, "service", "--ensure", conflictFlag, "--config", cfgDir], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        exitCode = e.status;
        errOut = `${e.stdout || ""}${e.stderr || ""}`;
      }
      assert.notEqual(exitCode, 0);
      assert.match(errOut, /互斥/);
    }
  });
});
