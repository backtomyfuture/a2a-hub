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

// 按 A2A Context_ID 持久化会话号，让同一会话下跨任务的后续指令也能通过 resume_command 自动续接记忆。
function contextSessionPath(configDir, contextId) {
  const id = String(contextId ?? "").trim();
  if (!/^[\w.:-]+$/.test(id) || id === "." || id === "..") return "";
  return path.join(configDir, "sessions", `${id}.json`);
}

export function readContextSessionId(configDir, contextId) {
  const data = readSessionFile(contextSessionPath(configDir, contextId));
  const id = data?.session;
  if (typeof id === "string" && SESSION_ID.test(id)) return id;
  return "";
}

export function writeContextSessionId(configDir, contextId, sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return;
  const dest = contextSessionPath(configDir, contextId);
  if (!dest) return;
  const prev = readSessionFile(dest);
  writeSessionFile(dest, { ...prev, session: sessionId, updated_at: new Date().toISOString() });
}

export function clearSessionId(configDir, taskId) {
  const dest = sessionPath(configDir, taskId);
  if (!dest) return;
  for (const file of [dest, dest + ".tmp"]) {
    try { fs.unlinkSync(file); } catch { /* 已经没了 */ }
  }
}
