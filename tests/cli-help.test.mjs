// ah <子命令> --help 只打印用法，不执行（service 曾因此真的重装了自启服务）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "bin", "ah.mjs");

test("带副作用的子命令遇到 --help / -h 只打印用法", () => {
  // HOME 与配置目录都指向临时目录：万一回归，写下的 plist / 配置也只落在这里。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ah-help-"));
  try {
    const env = { ...process.env, HOME: tmp, AH_HOME: path.join(tmp, "cfg") };
    for (const [sub, flag] of [["service", "--help"], ["update", "-h"], ["setup", "--help"], ["daemon", "--help"]]) {
      const out = execFileSync(process.execPath, [BIN, sub, flag], { env, encoding: "utf8", timeout: 10_000 });
      assert.match(out, /用法：/);
      assert.match(out, new RegExp(`ah ${sub} `));
    }
    assert.equal(fs.existsSync(path.join(tmp, "Library")), false);
    assert.equal(fs.existsSync(path.join(tmp, "cfg")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
