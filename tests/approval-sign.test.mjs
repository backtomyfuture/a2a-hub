import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isHubPublicKey,
  loadOrCreateHubKey,
  pickSignedDecision,
  signDecision,
  verifyDecision,
} from "../src/core/approval-sign.mjs";

test("approval-sign: Ed25519 密钥持久化、签名与防篡改校验", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-sign-"));
  try {
    const pair1 = loadOrCreateHubKey(dir);
    assert.equal(isHubPublicKey(pair1.publicKey), true);
    const pair2 = loadOrCreateHubKey(dir);
    assert.equal(pair1.publicKey, pair2.publicKey);

    const sig = signDecision(pair1.privateKey, {
      taskId: "tsk_001",
      requestId: "req_abc",
      decision: "approved",
    });

    assert.equal(
      verifyDecision(pair1.publicKey, { taskId: "tsk_001", requestId: "req_abc", decision: "approved" }, sig),
      true
    );
    assert.equal(
      verifyDecision(pair1.publicKey, { taskId: "tsk_002", requestId: "req_abc", decision: "approved" }, sig),
      false,
      "跨任务重放签名必须失败"
    );
    assert.equal(
      verifyDecision(pair1.publicKey, { taskId: "tsk_001", requestId: "req_abc", decision: "rejected" }, sig),
      false,
      "篡改决定内容必须失败"
    );

    const picked = pickSignedDecision(pair1.publicKey, "tsk_001", "req_abc", [
      { decision: "approved", sig: "bad-sig" },
      { decision: "approved", sig },
    ]);
    assert.equal(picked, "approved");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
