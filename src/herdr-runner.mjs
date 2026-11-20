// Herdr CLI 驱动与运行账本（runs/<Task_ID>/herdr.json）。
// 将每个任务绑定到独立的 Herdr Tab / Pane / Agent，实现边缘宿主机多槽位并行与热驻留续接。
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { commandEnv, safeTaskId } from "./direct-ledger.mjs";

const execFileAsync = promisify(execFile);

const RESERVED_AH_ENV = new Set([
  "AH_TASK_ID",
  "AH_NODE",
  "AH_WORKER",
  "AH_RUN_DIR",
  "AH_INPUT_PATH",
  "AH_RECEIPT_PATH",
]);

export function herdrRunDir(configDir, taskId) {
  return path.join(configDir, "runs", safeTaskId(taskId));
}

export function herdrLedgerPath(configDir, taskId) {
  return path.join(herdrRunDir(configDir, taskId), "herdr.json");
}

export function herdrReceiptPath(configDir, taskId) {
  return path.join(herdrRunDir(configDir, taskId), "receipt.txt");
}

// Herdr 要求 agent name 匹配 ^[a-z][a-z0-9_-]{0,31}$ 且唯一。
export function herdrAgentName(taskId) {
  const body = String(taskId ?? "")
    .toLowerCase()
    .replace(/^task-/, "")
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+/, "");
  return `ah-${body || "task"}`.slice(0, 32);
}

export function readHerdrLedger(configDir, taskId) {
  let file;
  try {
    file = herdrLedgerPath(configDir, taskId);
  } catch {
    return { broken: true };
  }
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    return { broken: true };
  }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return { broken: true };
    return data;
  } catch {
    return { broken: true };
  }
}

export function saveHerdrLedger(configDir, ledger) {
  const dest = herdrLedgerPath(configDir, ledger.task_id);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(dest), 0o700); } catch { /* 目录权限失败不挡住账本 */ }
  const tmp = dest + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o600);
  return dest;
}

export function deleteHerdrLedger(configDir, taskId) {
  let file;
  try {
    file = herdrLedgerPath(configDir, taskId);
  } catch {
    return;
  }
  for (const p of [file, `${file}.tmp`]) {
    try { fs.unlinkSync(p); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  }
}

export function listHerdrLedgers(configDir) {
  const runsRoot = path.join(configDir, "runs");
  let names;
  try {
    names = fs.readdirSync(runsRoot);
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const taskId of names) {
    if (!/^[\w-]+$/.test(taskId)) continue;
    const ledger = readHerdrLedger(configDir, taskId);
    if (ledger) out.push({ taskId, ledger });
  }
  return out;
}

function normalizeExecResult(res) {
  if (typeof res === "string") return { stdout: res, stderr: "" };
  if (res && typeof res === "object") {
    if ("stdout" in res || "stderr" in res) {
      return { stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
    }
    return { stdout: JSON.stringify(res), stderr: "" };
  }
  return { stdout: "", stderr: "" };
}

// 支持注入 cfg.herdrExec 进行单测，生产环境调用本机 herdr CLI；若配了 herdrSession 则前置 --session。
export function createHerdrExec(cfg = {}) {
  const session = String(cfg?.herdrSession ?? "").trim();
  const custom = typeof cfg?.herdrExec === "function" ? cfg.herdrExec : null;
  return async function execHerdr(args, opts = {}) {
    const fullArgs = session ? ["--session", session, ...args] : [...args];
    if (custom) {
      return normalizeExecResult(await custom(fullArgs, opts));
    }
    const res = await execFileAsync("herdr", fullArgs, {
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 10 * 1024 * 1024,
      env: commandEnv(),
    });
    return normalizeExecResult(res);
  };
}

function parseJsonStdout(stdout, contextLabel) {
  const text = String(stdout ?? "").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${contextLabel} 返回非 JSON 输出：${e.message}`);
  }
}

function extractTextOutput(stdout) {
  const raw = String(stdout ?? "");
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed);
      if (data && typeof data === "object") {
        const text = data?.result?.text ?? data?.result?.output ?? data?.text ?? data?.output;
        if (typeof text === "string") return text;
      }
    } catch { /* 按纯文本处理 */ }
  }
  return raw;
}

export function readNonEmptyReceipt(receiptPath) {
  if (!receiptPath) return "";
  try {
    const text = fs.readFileSync(receiptPath, "utf8");
    return text.trim() ? text : "";
  } catch (e) {
    if (e?.code === "ENOENT") return "";
    throw e;
  }
}

export async function ensureWorkspace(exec, label = "a2a-hub") {
  const wsLabel = String(label ?? "").trim() || "a2a-hub";
  const listed = parseJsonStdout((await exec(["workspace", "list"])).stdout, "herdr workspace list");
  const list = listed?.result?.workspaces ?? listed?.workspaces ?? (Array.isArray(listed) ? listed : []);
  const hit = Array.isArray(list)
    ? list.find((ws) => ws && (ws.label === wsLabel || ws.name === wsLabel))
    : null;
  const hitId = hit?.workspace_id ?? hit?.id ?? "";
  if (hitId) return String(hitId);

  const created = parseJsonStdout(
    (await exec(["workspace", "create", "--label", wsLabel, "--no-focus"])).stdout,
    "herdr workspace create",
  );
  const wsId =
    created?.result?.workspace?.workspace_id
    ?? created?.result?.workspace_id
    ?? created?.workspace?.workspace_id
    ?? created?.workspace_id
    ?? created?.id
    ?? "";
  if (!wsId) throw new Error("herdr workspace create 未返回 workspace_id");
  return String(wsId);
}

export async function launchHerdrAgent({
  exec,
  configDir,
  node,
  taskId,
  worker = "",
  kind,
  args = [],
  env = {},
  cwd = "",
  inputPath = "",
  receiptPath = "",
  workspaceLabel = "a2a-hub",
  workspaceId = "",
}) {
  const wsId = workspaceId || (await ensureWorkspace(exec, workspaceLabel));
  const runDir = herdrRunDir(configDir, taskId);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(runDir, 0o700); } catch { /* 权限失败不挡启动 */ }

  const tabArgs = ["tab", "create", "--workspace", wsId];
  if (cwd) tabArgs.push("--cwd", cwd);
  tabArgs.push("--label", String(taskId), "--no-focus");

  const ahEnv = {
    AH_TASK_ID: String(taskId ?? ""),
    AH_NODE: String(node ?? ""),
    AH_WORKER: String(worker ?? ""),
    AH_RUN_DIR: runDir,
    AH_INPUT_PATH: String(inputPath ?? ""),
    AH_RECEIPT_PATH: String(receiptPath ?? ""),
  };
  for (const [k, v] of Object.entries(ahEnv)) {
    tabArgs.push("--env", `${k}=${v}`);
  }
  if (env && typeof env === "object" && !Array.isArray(env)) {
    for (const [k, v] of Object.entries(env)) {
      const key = String(k ?? "").trim();
      if (!key || RESERVED_AH_ENV.has(key) || v === undefined || v === null) continue;
      tabArgs.push("--env", `${key}=${String(v)}`);
    }
  }

  const created = parseJsonStdout((await exec(tabArgs)).stdout, "herdr tab create");
  const tabId =
    created?.result?.tab?.tab_id
    ?? created?.result?.tab_id
    ?? created?.tab?.tab_id
    ?? created?.tab_id
    ?? "";
  const paneId =
    created?.result?.root_pane?.pane_id
    ?? created?.result?.tab?.root_pane?.pane_id
    ?? created?.result?.pane_id
    ?? created?.root_pane?.pane_id
    ?? created?.tab?.root_pane?.pane_id
    ?? created?.pane_id
    ?? "";
  if (!paneId) throw new Error("herdr tab create 未返回 pane_id");

  const agentName = herdrAgentName(taskId);
  const startArgs = ["agent", "start", agentName, "--kind", kind, "--pane", String(paneId)];
  if (Array.isArray(args) && args.length) {
    startArgs.push("--", ...args.map((a) => String(a)));
  }

  try {
    await exec(startArgs, { timeoutMs: 45_000 });
  } catch (err) {
    // agent start 失败时顺手关闭刚开的 Tab/Pane，避免空壳 Tab 泄漏占窗口。
    if (tabId) await exec(["tab", "close", String(tabId)]).catch(() => {});
    else await exec(["pane", "close", String(paneId)]).catch(() => {});
    throw err;
  }

  return {
    workspaceId: wsId,
    tabId: String(tabId),
    paneId: String(paneId),
    agentName,
  };
}

export async function sendHerdrPrompt({ exec, agentName, promptText, unblock = false }) {
  if (unblock) {
    await exec(["agent", "send-keys", agentName, "esc"]).catch(() => {});
  }
  try {
    await exec(["agent", "prompt", agentName, promptText]);
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (!unblock && /agent_blocked/i.test(msg)) {
      await exec(["agent", "send-keys", agentName, "esc"]).catch(() => {});
      await exec(["agent", "prompt", agentName, promptText]);
      return;
    }
    throw err;
  }
}

export async function getHerdrAgentStatus(exec, agentName) {
  const res = await exec(["agent", "get", agentName]);
  const data = parseJsonStdout(res.stdout, "herdr agent get");
  const agent = data?.result?.agent ?? data?.agent ?? data?.result ?? data;
  if (!agent || typeof agent !== "object") return { exists: false, status: "dead" };
  const raw =
    agent.agent_status
    ?? agent.status
    ?? agent.state
    ?? data?.result?.agent_status
    ?? data?.result?.status
    ?? data?.result?.state
    ?? "";
  const status = String(raw || "unknown").trim().toLowerCase();
  if (status === "dead" || status === "exited") return { exists: false, status };
  return { exists: true, status, agent };
}

export async function inspectHerdrAgent({ exec, agentName, paneId: _paneId = "", receiptPath = "" }) {
  const earlyReceipt = readNonEmptyReceipt(receiptPath);
  if (earlyReceipt) {
    return { status: "settled", output: earlyReceipt, fromReceiptFile: true };
  }

  let info;
  try {
    info = await getHerdrAgentStatus(exec, agentName);
  } catch (err) {
    const lateReceipt = readNonEmptyReceipt(receiptPath);
    if (lateReceipt) {
      return { status: "settled", output: lateReceipt, fromReceiptFile: true };
    }
    return { status: "dead", error: String(err?.message ?? err) };
  }

  if (!info.exists) {
    const lateReceipt = readNonEmptyReceipt(receiptPath);
    if (lateReceipt) {
      return { status: "settled", output: lateReceipt, fromReceiptFile: true };
    }
    return { status: "dead", error: `herdr agent ${agentName} 不可用（${info.status}）` };
  }

  if (info.status === "working") {
    return { status: "working" };
  }

  if (info.status === "blocked") {
    const readRes = await exec(["agent", "read", agentName, "--source", "visible", "--lines", "60"]);
    return { status: "blocked", output: extractTextOutput(readRes.stdout) };
  }

  if (info.status === "idle" || info.status === "done") {
    const receipt = readNonEmptyReceipt(receiptPath);
    if (receipt) {
      return { status: "settled", output: receipt, fromReceiptFile: true };
    }
    const readRes = await exec(["agent", "read", agentName, "--source", "recent-unwrapped", "--lines", "200"]);
    return { status: "settled", output: extractTextOutput(readRes.stdout), fromReceiptFile: false };
  }

  // unknown 可能是刚发 prompt 尚未切换检测状态，先按在途等待处理，由超时兜底。
  return { status: "working", rawStatus: info.status };
}

export async function closeHerdrTask({ exec, configDir, taskId, entry = null }) {
  const ledger = entry || readHerdrLedger(configDir, taskId);
  if (ledger && !ledger.broken) {
    if (ledger.tab_id) {
      await exec(["tab", "close", String(ledger.tab_id)]).catch(() => {});
    } else if (ledger.pane_id) {
      await exec(["pane", "close", String(ledger.pane_id)]).catch(() => {});
    }
  }
  deleteHerdrLedger(configDir, taskId);
}
