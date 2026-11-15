// 默认中台表名映射。独立中台（SQLite / HTTP）使用统一逻辑表名，
// 飞书多维表格模式则使用用户配置的具体 table_id。

export const DEFAULT_TABLES = Object.freeze({
  tasks: "tasks",
  messages: "messages",
  parts: "parts",
  runs: "runs",
  artifacts: "artifacts",
  agentCards: "agentCards",
  rules: "rules",
  loops: "loops",
});

export const KNOWN_TABLE_KEYS = Object.freeze(Object.keys(DEFAULT_TABLES));

export function normalizeTables(tables) {
  const src = tables && typeof tables === "object" ? tables : {};
  const out = {};
  for (const key of KNOWN_TABLE_KEYS) {
    const val = typeof src[key] === "string" && src[key].trim() ? src[key].trim() : DEFAULT_TABLES[key];
    out[key] = val;
  }
  return out;
}

// 允许 API 调用方传标准逻辑表名（如 "tasks"）或自定义映射名。
export function resolveTableName(tables, name) {
  const raw = String(name ?? "").trim();
  if (!raw) return "";
  const map = normalizeTables(tables);
  if (Object.hasOwn(map, raw)) return map[raw];
  for (const v of Object.values(map)) {
    if (v === raw) return v;
  }
  return "";
}
