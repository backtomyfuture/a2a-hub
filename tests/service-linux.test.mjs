// Linux systemd 加固、2B 统一短命名、service.env 凭据隔离、旧 unit 迁移与 tokenFile 支持测试。
// 通过 _deps 注入 mock systemctl / 平台环境，状态只写系统临时目录。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadConfig, readTokenFile } from "../src/config.mjs";
import {
  checkSystemdActive,
  collectServiceEnv,
  findLegacySystemdUnits,
  renderPlist,
  renderSystemdUnit,
  selectAutostartName,
  service,
  systemdUnitName,
  unitTextTargetsConfig,
} from "../src/service.mjs";
import { withTemp } from "./helpers.mjs";

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

test("2B 短命名：node -> ah-<node>.service，hub -> ah-hub-<node>.service，自定义 --name 清洗与补后缀", () => {
  assert.equal(systemdUnitName("node", "muse"), "ah-muse.service");
  assert.equal(systemdUnitName("agent", "muse"), "ah-muse.service");
  assert.equal(systemdUnitName("hub", "mac"), "ah-hub-mac.service");

  assert.equal(
    selectAutostartName({ role: "node", node: "muse", configDir: "/home/muse/.a2a-hub-muse", kind: "systemd" }),
    "ah-muse.service",
  );
  assert.equal(
    selectAutostartName({ role: "hub", node: "mac", configDir: "/tmp/custom", kind: "systemd" }),
    "ah-hub-mac.service",
  );
  assert.equal(
    selectAutostartName({ role: "node", node: "muse", configDir: "/tmp/c", kind: "systemd", name: "custom worker/1" }),
    "custom-worker-1.service",
  );
  assert.equal(
    selectAutostartName({ role: "node", node: "muse", configDir: "/tmp/c", kind: "systemd", name: "ah-custom.service" }),
    "ah-custom.service",
  );
  assert.equal(
    selectAutostartName({ role: "node", node: "muse", configDir: "/tmp/c", kind: "launchd", name: "my label!" }),
    "my-label-",
  );

  // unitTextTargetsConfig 不应被前缀目录误匹配
  const unit = renderSystemdUnit({
    role: "node",
    node: "muse",
    appBin: "/app/bin/ah.mjs",
    configDir: "/home/muse/.a2a-hub-muse",
  });
  assert.equal(unitTextTargetsConfig(unit, "/home/muse/.a2a-hub-muse"), true);
  assert.equal(unitTextTargetsConfig(unit, "/home/muse/.a2a-hub"), false);
});

test("代理变量写进 0600 service.env 且自动注入 NODE_USE_ENV_PROXY=1，unit 正文零凭据", async () => {
  const noProxyEnv = collectServiceEnv({ PATH: "/usr/bin", NODE_EXTRA_CA_CERTS: "/ca.pem" }, { includePath: true });
  assert.equal(noProxyEnv.NODE_USE_ENV_PROXY, undefined);
  assert.equal(noProxyEnv.NODE_EXTRA_CA_CERTS, "/ca.pem");
  assert.equal(noProxyEnv.PATH, "/usr/bin");

  const withProxyEnv = collectServiceEnv(
    {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://user:s3cr3t@127.0.0.1:7890",
      NO_PROXY: "localhost,127.0.0.1",
    },
    { includePath: true, home: "/home/muse" },
  );
  assert.equal(withProxyEnv.NODE_USE_ENV_PROXY, "1");
  assert.equal(withProxyEnv.HOME, "/home/muse");
  assert.equal(withProxyEnv.HTTPS_PROXY, "http://user:s3cr3t@127.0.0.1:7890");

  // renderPlist 检测到代理时也自动注入 NODE_USE_ENV_PROXY=1
  const prevProxy = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = "http://plist-user:plist-pass@127.0.0.1:7890";
  try {
    const plist = renderPlist({
      label: "ah-node.muse",
      appBin: "/app/bin/ah.mjs",
      configDir: "/tmp/cfg",
      role: "node",
      logPath: "/tmp/cfg/daemon.log",
    });
    assert.match(plist, /<key>NODE_USE_ENV_PROXY<\/key><string>1<\/string>/);
  } finally {
    if (prevProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = prevProxy;
  }

  await withTemp(async (dir) => {
    const cfgDir = setupConfigDir(dir, "muse", "node");
    const sysDir = path.join(dir, "etc-systemd");
    const homeDir = path.join(dir, "home");
    fs.mkdirSync(homeDir, { recursive: true });

    const { res } = await captureOutput(() =>
      service(cfgDir, { scope: "system" }, "/opt/a2a-hub", {
        platform: "linux",
        getuid: () => 0,
        homedir: () => homeDir,
        userInfo: () => ({ username: "muse" }),
        systemUnitDir: sysDir,
        sleep: async () => {},
        env: {
          PATH: "/usr/local/bin:/usr/bin",
          HTTPS_PROXY: "http://proxyuser:proxypass@10.0.0.1:8080\nEVIL_KEY=injected",
          NO_PROXY: "127.0.0.1",
        },
        execFileSync: (cmd, args) => {
          if (cmd === "systemctl" && args[0] === "is-active") return "active\n";
          return "";
        },
      }),
    );
    assert.equal(res, 0);

    const envFile = path.join(cfgDir, "service.env");
    const envStat = fs.statSync(envFile);
    assert.equal(envStat.mode & 0o777, 0o600);
    const envText = fs.readFileSync(envFile, "utf8");
    assert.match(envText, /^NODE_USE_ENV_PROXY=1$/m);
    assert.match(envText, /^HTTPS_PROXY=http:\/\/proxyuser:proxypass@10\.0\.0\.1:8080EVIL_KEY=injected$/m);
    assert.doesNotMatch(envText, /^EVIL_KEY=/m);

    const unitText = fs.readFileSync(path.join(sysDir, "ah-muse.service"), "utf8");
    assert.match(unitText, /Restart=always/);
    assert.match(unitText, /WantedBy=multi-user\.target/);
    assert.match(unitText, /User=muse/);
    assert.match(unitText, new RegExp(`^EnvironmentFile=-${envFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    assert.doesNotMatch(unitText, /^EnvironmentFile=-"/m);
    assert.doesNotMatch(unitText, /proxypass/);
    assert.doesNotMatch(unitText, /proxyuser/);
    assert.doesNotMatch(unitText, /10\.0\.0\.1:8080/);
  });
});

test("重复执行 --system：调用顺序 daemon-reload -> enable -> restart -> is-active，凭据轮换生效且 stdout 零泄露", async () => {
  await withTemp(async (dir) => {
    const cfgDir = setupConfigDir(dir, "muse", "node");
    const sysDir = path.join(dir, "etc-systemd");
    const homeDir = path.join(dir, "home");
    fs.mkdirSync(sysDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });

    const runPass = async (proxyPass) => {
      const calls = [];
      let tmpCopied = "";
      const { res, stdout, stderr } = await captureOutput(() =>
        service(cfgDir, { scope: "system" }, "/opt/a2a-hub", {
          platform: "linux",
          getuid: () => 1000,
          homedir: () => homeDir,
          userInfo: () => ({ username: "muse" }),
          systemUnitDir: sysDir,
          sleep: async () => {},
          env: {
            PATH: "/usr/bin",
            HTTPS_PROXY: `http://muse:${proxyPass}@127.0.0.1:7890`,
            AH_API_TOKEN: "secret-api-token-999",
          },
          execFileSync: (cmd, args) => {
            calls.push([cmd, ...args]);
            if (cmd === "sudo" && args[0] === "-n" && args[1] === "true") return "";
            if (cmd === "sudo" && args[0] === "cp") {
              // 验证 sudo 临时文件不在 /tmp 下且已设 0600
              assert.equal(args[1].startsWith(cfgDir), true);
              assert.equal(fs.statSync(args[1]).mode & 0o777, 0o600);
              tmpCopied = args[1];
              fs.copyFileSync(args[1], args[2]);
              return "";
            }
            if (cmd === "systemctl" && args[0] === "is-active") return "active\n";
            return "";
          },
        }),
      );
      return { res, stdout, stderr, calls, tmpCopied };
    };

    const first = await runPass("pass-v1");
    assert.equal(first.res, 0);
    assert.equal(fs.existsSync(first.tmpCopied), false);

    const second = await runPass("pass-v2");
    assert.equal(second.res, 0);
    assert.equal(fs.existsSync(second.tmpCopied), false);

    const systemctlSeq = second.calls
      .map((c) => (c[0] === "sudo" && c[1] === "systemctl" ? c[2] : c[0] === "systemctl" ? c[1] : null))
      .filter(Boolean);
    assert.deepEqual(systemctlSeq, ["daemon-reload", "enable", "restart", "is-active"]);

    const envText = fs.readFileSync(path.join(cfgDir, "service.env"), "utf8");
    assert.match(envText, /pass-v2/);
    assert.doesNotMatch(envText, /pass-v1/);

    const lines = second.stdout.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], `ok: ah-muse.service active (system, config=${cfgDir})`);
    assert.equal(second.stderr, "");
    assert.doesNotMatch(second.stdout + second.stderr, /pass-v2|secret-api-token-999/);
  });
});

test("is-active 状态校验与严格失败退出码：failed/无权限不降级 spawn，activating 重试转 active 成功", async () => {
  // 1) activating -> active 轮询通过
  let activeAttempts = 0;
  const polled = await checkSystemdActive("ah-muse.service", false, {
    sleep: async () => {},
    execFileSync: (cmd, args) => {
      if (cmd === "systemctl" && args[0] === "is-active") {
        activeAttempts += 1;
        if (activeAttempts < 3) {
          const err = new Error("activating");
          err.stdout = "activating\n";
          throw err;
        }
        return "active\n";
      }
      return "";
    },
  });
  assert.equal(polled.ok, true);
  assert.equal(polled.status, "active");
  assert.equal(activeAttempts, 3);

  // 2) 持续 activating 超时仍失败
  const stuck = await checkSystemdActive("ah-muse.service", false, {
    sleep: async () => {},
    execFileSync: () => {
      const err = new Error("activating");
      err.stdout = "activating\n";
      throw err;
    },
  });
  assert.equal(stuck.ok, false);
  assert.equal(stuck.status, "activating");

  // 3) --system 下 is-active 返回 failed 或无权限严格返回 1 且绝不调用 spawn
  await withTemp(async (dir) => {
    const cfgDir = setupConfigDir(dir, "muse", "node");
    const sysDir = path.join(dir, "etc-systemd");
    const homeDir = path.join(dir, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    let spawned = false;

    const failedRes = await captureOutput(() =>
      service(cfgDir, { scope: "system" }, "/opt/a2a-hub", {
        platform: "linux",
        getuid: () => 0,
        homedir: () => homeDir,
        userInfo: () => ({ username: "muse" }),
        systemUnitDir: sysDir,
        sleep: async () => {},
        spawn: () => {
          spawned = true;
          return { pid: 1, unref() {} };
        },
        env: { PATH: "/usr/bin", HTTPS_PROXY: "http://u:secret-pw@127.0.0.1:7890" },
        execFileSync: (cmd, args) => {
          if (cmd === "systemctl" && args[0] === "is-active") {
            const err = new Error("failed");
            err.stdout = "failed\n";
            throw err;
          }
          if (cmd === "systemctl" && args[0] === "status") return "● ah-muse.service failed";
          return "";
        },
      }),
    );
    assert.equal(failedRes.res, 1);
    assert.equal(spawned, false);
    assert.doesNotMatch(failedRes.stdout + failedRes.stderr, /secret-pw/);

    // 无 root 且无免密 sudo
    const noPermRes = await captureOutput(() =>
      service(cfgDir, { scope: "system" }, "/opt/a2a-hub", {
        platform: "linux",
        getuid: () => 1000,
        homedir: () => homeDir,
        systemUnitDir: sysDir,
        spawn: () => {
          spawned = true;
          return { pid: 1, unref() {} };
        },
        execFileSync: () => {
          throw new Error("sudo required");
        },
      }),
    );
    assert.equal(noPermRes.res, 1);
    assert.equal(spawned, false);

    // --user 失败也不降级 system 或 spawn
    const userFailRes = await captureOutput(() =>
      service(cfgDir, { scope: "user" }, "/opt/a2a-hub", {
        platform: "linux",
        getuid: () => 1000,
        homedir: () => homeDir,
        systemUnitDir: sysDir,
        sleep: async () => {},
        spawn: () => {
          spawned = true;
          return { pid: 1, unref() {} };
        },
        execFileSync: (cmd, args) => {
          if (cmd === "systemctl" && args.includes("is-active")) {
            const err = new Error("inactive");
            err.stdout = "inactive\n";
            throw err;
          }
          return "";
        },
      }),
    );
    assert.equal(userFailRes.res, 1);
    assert.equal(spawned, false);

    // 非法 scope 返回 1
    const badScope = await captureOutput(() =>
      service(cfgDir, { scope: "invalid" }, "/opt/a2a-hub", { platform: "linux" }),
    );
    assert.equal(badScope.res, 1);
  });
});

test("旧版 ah-node-muse-<hash>.service 自动迁移停用并删除，不误删其他配置目录的 unit", async () => {
  await withTemp(async (dir) => {
    const cfgDir = setupConfigDir(dir, "muse", "node");
    const otherCfgDir = setupConfigDir(dir, "muse-other", "node");
    const sysDir = path.join(dir, "etc-systemd");
    const homeDir = path.join(dir, "home");
    fs.mkdirSync(sysDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });

    const legacyHashUnit = "ah-node-muse-1a2b3c4d.service";
    const legacyPlainUnit = "ah-node-muse.service";
    const otherUnit = "ah-node-muse-deadbeef.service";
    fs.writeFileSync(path.join(sysDir, legacyHashUnit), `[Service]\nExecStart=node /app/bin/ah.mjs daemon --config "${cfgDir}" --role "node"\n`);
    fs.writeFileSync(path.join(sysDir, legacyPlainUnit), `[Service]\nWorkingDirectory=${cfgDir}\n`);
    fs.writeFileSync(path.join(sysDir, otherUnit), `[Service]\nWorkingDirectory=${otherCfgDir}\n`);

    const found = findLegacySystemdUnits({
      dir: sysDir,
      role: "node",
      node: "muse",
      configDir: cfgDir,
      currentUnit: "ah-muse.service",
    });
    assert.deepEqual(found, [legacyHashUnit, legacyPlainUnit]);

    const disabledUnits = [];
    const { res } = await captureOutput(() =>
      service(cfgDir, { scope: "system" }, "/opt/a2a-hub", {
        platform: "linux",
        getuid: () => 0,
        homedir: () => homeDir,
        userInfo: () => ({ username: "muse" }),
        systemUnitDir: sysDir,
        sleep: async () => {},
        env: { PATH: "/usr/bin" },
        execFileSync: (cmd, args) => {
          if (cmd === "systemctl" && args[0] === "disable" && args[1] === "--now") {
            disabledUnits.push(args[2]);
            return "";
          }
          if (cmd === "systemctl" && args[0] === "is-active") return "active\n";
          return "";
        },
      }),
    );
    assert.equal(res, 0);
    assert.deepEqual(disabledUnits.sort(), [legacyHashUnit, legacyPlainUnit].sort());
    assert.equal(fs.existsSync(path.join(sysDir, legacyHashUnit)), false);
    assert.equal(fs.existsSync(path.join(sysDir, legacyPlainUnit)), false);
    assert.equal(fs.existsSync(path.join(sysDir, otherUnit)), true);
    assert.equal(fs.existsSync(path.join(sysDir, "ah-muse.service")), true);
  });
});

test("--remove 停用删除当前 unit、旧 unit 与 service.env", async () => {
  await withTemp(async (dir) => {
    const cfgDir = setupConfigDir(dir, "muse", "node");
    const sysDir = path.join(dir, "etc-systemd");
    const homeDir = path.join(dir, "home");
    const userDir = path.join(homeDir, ".config", "systemd", "user");
    fs.mkdirSync(sysDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });

    const sysUnit = path.join(sysDir, "ah-muse.service");
    const sysLegacy = path.join(sysDir, "ah-node-muse-abcdef12.service");
    const userUnit = path.join(userDir, "ah-muse.service");
    const envFile = path.join(cfgDir, "service.env");
    fs.writeFileSync(sysUnit, `[Service]\nWorkingDirectory=${cfgDir}\n`);
    fs.writeFileSync(sysLegacy, `[Service]\nWorkingDirectory=${cfgDir}\n`);
    fs.writeFileSync(userUnit, `[Service]\nWorkingDirectory=${cfgDir}\n`);
    fs.writeFileSync(envFile, "NODE_USE_ENV_PROXY=1\n", { mode: 0o600 });

    const calls = [];
    const { res } = await captureOutput(() =>
      service(cfgDir, { remove: true, scope: "system" }, "/opt/a2a-hub", {
        platform: "linux",
        getuid: () => 0,
        homedir: () => homeDir,
        systemUnitDir: sysDir,
        execFileSync: (cmd, args) => {
          calls.push([cmd, ...args]);
          return "";
        },
      }),
    );
    assert.equal(res, 0);
    assert.equal(fs.existsSync(sysUnit), false);
    assert.equal(fs.existsSync(sysLegacy), false);
    assert.equal(fs.existsSync(envFile), false);
    // --remove --system 不动用户级 unit
    assert.equal(fs.existsSync(userUnit), true);
    assert.equal(calls.some((c) => c.includes("disable") && c.includes("ah-muse.service")), true);
    assert.equal(calls.some((c) => c.includes("disable") && c.includes("ah-node-muse-abcdef12.service")), true);
  });
});

test("loadConfig 读取 tokenFile / token_file（相对路径、优先级、缺失/空文件报错不泄露内容）", async () => {
  await withTemp(async (dir) => {
    const cfgDir = path.join(dir, "cfg");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, "hub.token"), "\n  tok_from_file_123 \nignored_second_line\n", { mode: 0o600 });

    assert.equal(readTokenFile("hub.token", cfgDir), "tok_from_file_123");

    // 1) tokenFile 相对路径
    fs.writeFileSync(
      path.join(cfgDir, "node.json"),
      JSON.stringify({ node: "muse", role: "node", hubUrl: "http://127.0.0.1:8787", tokenFile: "hub.token" }),
    );
    const cfg1 = loadConfig(cfgDir);
    assert.equal(cfg1.apiToken, "tok_from_file_123");

    // 2) token_file 别名且 env 作为较低优先级被覆盖
    fs.writeFileSync(
      path.join(cfgDir, "node.json"),
      JSON.stringify({ node: "muse", role: "node", hubUrl: "http://127.0.0.1:8787", token_file: "./hub.token" }),
    );
    const prevEnv = process.env.A2A_HUB_TOKEN;
    process.env.A2A_HUB_TOKEN = "tok_from_env";
    try {
      const cfg2 = loadConfig(cfgDir);
      assert.equal(cfg2.apiToken, "tok_from_file_123");
    } finally {
      if (prevEnv === undefined) delete process.env.A2A_HUB_TOKEN;
      else process.env.A2A_HUB_TOKEN = prevEnv;
    }

    // 3) cfg.apiToken 优先于 tokenFile
    fs.writeFileSync(
      path.join(cfgDir, "node.json"),
      JSON.stringify({
        node: "muse",
        role: "node",
        hubUrl: "http://127.0.0.1:8787",
        apiToken: "tok_inline",
        tokenFile: "missing.token",
      }),
    );
    assert.equal(loadConfig(cfgDir).apiToken, "tok_inline");

    // 4) 缺失或空文件抛出含路径但不含内容的错误
    fs.writeFileSync(
      path.join(cfgDir, "node.json"),
      JSON.stringify({ node: "muse", role: "node", hubUrl: "http://127.0.0.1:8787", tokenFile: "missing.token" }),
    );
    assert.throws(() => loadConfig(cfgDir), (err) => {
      assert.match(err.message, /missing\.token/);
      return true;
    });

    const emptyFile = path.join(cfgDir, "empty.token");
    fs.writeFileSync(emptyFile, "   \n  \n");
    fs.writeFileSync(
      path.join(cfgDir, "node.json"),
      JSON.stringify({ node: "muse", role: "node", hubUrl: "http://127.0.0.1:8787", tokenFile: "empty.token" }),
    );
    assert.throws(() => loadConfig(cfgDir), (err) => {
      assert.match(err.message, /empty\.token/);
      return true;
    });
  });
});
