// 机主标识：审批只发给这个人，回调也只认这个人。
// 值来自本配置目录 node.json 的 ownerId，或环境变量 AH_OWNER_ID。
// 调用方不得把解析结果写进日志。

import fs from "node:fs";
import path from "node:path";

function usable(value) {
  const text = String(value ?? "").trim();
  if (!text || text.startsWith("<")) return "";
  return text;
}

export function resolveOwnerId(source, env = process.env) {
  const fromCfg = usable(source?.ownerId);
  if (fromCfg) return fromCfg;
  return usable(env?.AH_OWNER_ID);
}

export function readOwnerFromConfigDir(configDir, env = process.env) {
  const raw = JSON.parse(fs.readFileSync(path.join(configDir, "node.json"), "utf8"));
  return resolveOwnerId(raw, env);
}
