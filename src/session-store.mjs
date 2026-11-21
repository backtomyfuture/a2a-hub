// 本机 session.json。只给同一任务的问答续跑用，不进总线。
import fs from "node:fs";
import path from "node:path";
import { SESSION_ID } from "./receipt.mjs";

function sessionPath(configDir, taskId) {
  const id = String(taskId ?? "");
  if (!/^[\w-]+$/.test(id)) return "";
  return path.join(configDir, "runs", id, "session.json");
}

function readSessionFile(file) {
  if (!file) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch { /* 没有会话或文件坏了就当没有 */ }
  return {};
}

function writeSessionFile(dest, data) {
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(dest), 0o700); } catch { /* 目录权限失败不挡住会话文件 */ }
  const tmp = dest + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o600);
}

export function readSessionId(configDir, taskId) {
  const data = readSessionFile(sessionPath(configDir, taskId));
  const id = data?.session;
  if (typeof id === "string" && SESSION_ID.test(id)) return id;
  return "";
}

export function writeSessionId(configDir, taskId, sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return;
  const dest = sessionPath(configDir, taskId);
  if (!dest) return;
  const prev = readSessionFile(dest);
  writeSessionFile(dest, { ...prev, session: sessionId });
}

// Herdr 会话的双键：稳定语义名 agent_name，加上会随 pane.moved 变化的物理位置。
// 与 Claude session id 写在同一个文件里，两边更新都保留对方的字段。
export function readHerdrBinding(configDir, taskId) {
  const herdr = readSessionFile(sessionPath(configDir, taskId)).herdr;
  if (!herdr || typeof herdr !== "object" || Array.isArray(herdr)) return null;
  const agentName = String(herdr.agent_name ?? "").trim();
  if (!agentName) return null;
  return {
    agent_name: agentName,
    workspace_id: String(herdr.workspace_id ?? ""),
    pane_id: String(herdr.pane_id ?? ""),
    worktree_path: String(herdr.worktree_path ?? ""),
  };
}

export function writeHerdrBinding(configDir, taskId, binding) {
  const dest = sessionPath(configDir, taskId);
  if (!dest) return;
  const agentName = String(binding?.agent_name ?? "").trim();
  if (!agentName) return;
  const prev = readSessionFile(dest);
  writeSessionFile(dest, {
    ...prev,
    herdr: {
      agent_name: agentName,
      workspace_id: String(binding?.workspace_id ?? ""),
      pane_id: String(binding?.pane_id ?? ""),
      worktree_path: String(binding?.worktree_path ?? ""),
    },
  });
}

export function clearSessionId(configDir, taskId) {
  const dest = sessionPath(configDir, taskId);
  if (!dest) return;
  for (const file of [dest, dest + ".tmp"]) {
    try { fs.unlinkSync(file); } catch { /* 已经没了 */ }
  }
}
