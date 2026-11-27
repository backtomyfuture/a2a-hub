// 零外部依赖的 5 段式 Cron + IANA 时区计算引擎（基于 Node >= 24 内置 Intl.DateTimeFormat）。
// 用于驱动中台定时任务（driver='hub'）与计算外部自管任务（driver='edge'）的预期打卡窗口。

export const DEFAULT_TIMEZONE = "Asia/Shanghai";

const MACRO_MAP = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_ALIASES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_ALIASES = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const WEEKDAY_PART_TO_DOW = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

const dtfCache = new Map();

function makeCronError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.code = "invalid_cron";
  return err;
}

// 默认时区固定单一来源（Asia/Shanghai，仅允许通过中台 AH_TIMEZONE 显式配置覆盖），
// 绝不读取宿主机系统时区，防止云端容器（默认 UTC）导致 0 8 * * * 偏移到北京时间 16:00。
export function defaultHubTimezone(env = process.env) {
  const configured = String(env?.AH_TIMEZONE || "").trim();
  if (configured) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: configured });
      return configured;
    } catch {}
  }
  return DEFAULT_TIMEZONE;
}

export function normalizeTimezone(tz, fallback = DEFAULT_TIMEZONE) {
  const raw = String(tz ?? "").trim();
  const target = raw || fallback || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: target });
    return target;
  } catch {
    if (!raw) return DEFAULT_TIMEZONE;
    const err = new Error(`无效的 IANA 时区名称: ${raw}（示例：Asia/Shanghai、UTC）`);
    err.statusCode = 400;
    err.code = "invalid_timezone";
    throw err;
  }
}

function getFormatter(timeZone) {
  let fmt = dtfCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hourCycle: "h23",
    });
    if (dtfCache.size > 128) {
      const oldest = dtfCache.keys().next().value;
      if (oldest) dtfCache.delete(oldest);
    }
    dtfCache.set(timeZone, fmt);
  }
  return fmt;
}

export function getZonedParts(ms, timeZone = DEFAULT_TIMEZONE) {
  const parts = getFormatter(timeZone).formatToParts(new Date(ms));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let dow = 0;
  for (const p of parts) {
    if (p.type === "year") year = Number(p.value);
    else if (p.type === "month") month = Number(p.value);
    else if (p.type === "day") day = Number(p.value);
    else if (p.type === "hour") hour = Number(p.value) % 24;
    else if (p.type === "minute") minute = Number(p.value);
    else if (p.type === "weekday") dow = WEEKDAY_PART_TO_DOW[p.value] ?? 0;
  }
  return { year, month, day, hour, minute, dow };
}

function replaceAliases(token, aliasMap) {
  if (!aliasMap) return token;
  return token.replace(/[a-z]{3}/gi, (m) => {
    const mapped = aliasMap[m.toLowerCase()];
    return mapped !== undefined ? String(mapped) : m;
  });
}

function parseField(rawField, min, max, { aliasMap = null, mapSevenToZero = false, label = "field" } = {}) {
  const cleaned = replaceAliases(String(rawField || "").trim(), aliasMap);
  if (!cleaned) throw makeCronError(`Cron 字段为空 (${label})`);
  if (cleaned === "*") {
    const all = new Set();
    for (let v = min; v <= max; v++) all.add(mapSevenToZero && v === 7 ? 0 : v);
    return { values: all, wildcard: true };
  }

  const values = new Set();
  const segments = cleaned.split(",");
  for (const seg of segments) {
    const part = seg.trim();
    if (!part) throw makeCronError(`Cron 表达式片段无效: "${rawField}"`);
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined) throw makeCronError(`Cron 步长语法无效: "${part}"`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) throw makeCronError(`Cron 步长必须为正整数: "${part}"`);
      step = Number(stepPart);
      if (step <= 0) throw makeCronError(`Cron 步长必须大于 0: "${part}"`);
    }

    let start = min;
    let end = max;
    if (rangePart !== "*") {
      if (rangePart.includes("-")) {
        const [aStr, bStr, rest] = rangePart.split("-");
        if (rest !== undefined || !/^\d+$/.test(aStr) || !/^\d+$/.test(bStr)) {
          throw makeCronError(`Cron 范围语法无效: "${part}"`);
        }
        start = Number(aStr);
        end = Number(bStr);
      } else {
        if (!/^\d+$/.test(rangePart)) throw makeCronError(`Cron 数值无效: "${part}"`);
        start = Number(rangePart);
        end = stepPart !== undefined ? max : start;
      }
    }

    if (start < min || end > max || start > end) {
      throw makeCronError(`Cron 字段 "${part}" 超出允许范围 (${min}-${max})`);
    }
    for (let v = start; v <= end; v += step) {
      values.add(mapSevenToZero && v === 7 ? 0 : v);
    }
  }

  if (!values.size) throw makeCronError(`Cron 字段未匹配任何有效值: "${rawField}"`);
  return { values, wildcard: false };
}

export function parseCronExpr(expr) {
  const raw = String(expr || "").trim();
  if (!raw) throw makeCronError("Cron 表达式不能为空");
  const expanded = MACRO_MAP[raw.toLowerCase()] || raw;
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) {
    throw makeCronError(`Cron 表达式须为标准 5 段格式（分 时 日 月 周），当前收到: "${raw}"`);
  }

  const minutes = parseField(fields[0], 0, 59, { label: "minute" });
  const hours = parseField(fields[1], 0, 23, { label: "hour" });
  const dom = parseField(fields[2], 1, 31, { label: "day-of-month" });
  const months = parseField(fields[3], 1, 12, { aliasMap: MONTH_ALIASES, label: "month" });
  const dow = parseField(fields[4], 0, 7, { aliasMap: DOW_ALIASES, mapSevenToZero: true, label: "day-of-week" });

  return {
    raw,
    normalized: expanded,
    minutes: minutes.values,
    hours: hours.values,
    dom: dom.values,
    domWildcard: dom.wildcard,
    months: months.values,
    dow: dow.values,
    dowWildcard: dow.wildcard,
    sortedMinutes: [...minutes.values].sort((a, b) => a - b),
  };
}

export function isValidCronExpr(expr) {
  try {
    parseCronExpr(expr);
    return true;
  } catch {
    return false;
  }
}

function matchesDay(parsed, day, dow) {
  const domOk = parsed.dom.has(day);
  const dowOk = parsed.dow.has(dow);
  // POSIX 标准：当「日」与「周」同时受限时取并集（OR），任一为 * 时取交集（AND）。
  if (!parsed.domWildcard && !parsed.dowWildcard) {
    return domOk || dowOk;
  }
  return domOk && dowOk;
}

// 计算严格大于 afterMs 的下一个触发毫秒时间戳（最多向前搜索 5 年以覆盖闰年 2 月 29 日）。
export function nextCronRunMs(exprOrParsed, afterMs = Date.now(), timeZone = DEFAULT_TIMEZONE) {
  const parsed = typeof exprOrParsed === "string" ? parseCronExpr(exprOrParsed) : exprOrParsed;
  const tz = normalizeTimezone(timeZone);
  const startMs = Math.floor(Number(afterMs) / 60_000) * 60_000 + 60_000;
  const maxMs = startMs + 5 * 366 * 24 * 3600_000;

  let t = startMs;
  while (t <= maxMs) {
    const p = getZonedParts(t, tz);

    if (!parsed.months.has(p.month) || !matchesDay(parsed, p.day, p.dow)) {
      // 推进至当日 23:00（预留 1 小时夏令时拨快缓冲），已在 23 点时推进至整点，确保 23 小时夏令时日绝不跨过次日 00:00。
      const safeSkipMin = p.hour < 23
        ? Math.max(1, (23 - p.hour) * 60 - p.minute)
        : Math.max(1, 60 - p.minute);
      t += safeSkipMin * 60_000;
      continue;
    }

    if (!parsed.hours.has(p.hour)) {
      const skipMin = Math.max(1, 60 - p.minute);
      t += skipMin * 60_000;
      continue;
    }

    if (parsed.minutes.has(p.minute)) {
      return t;
    }

    const nextMin = parsed.sortedMinutes.find((m) => m > p.minute);
    if (nextMin !== undefined) {
      t += (nextMin - p.minute) * 60_000;
    } else {
      t += Math.max(1, 60 - p.minute) * 60_000;
    }
  }

  throw makeCronError(`Cron 表达式 "${parsed.raw}" 在未来 5 年内无匹配触发时间`);
}

export function estimateCronIntervalMin(exprOrParsed, refMs = Date.now(), timeZone = DEFAULT_TIMEZONE) {
  const parsed = typeof exprOrParsed === "string" ? parseCronExpr(exprOrParsed) : exprOrParsed;
  const tz = normalizeTimezone(timeZone);
  const first = nextCronRunMs(parsed, refMs, tz);
  const second = nextCronRunMs(parsed, first, tz);
  return Math.max(1, Math.round((second - first) / 60_000));
}

// 生成窗口确定性标识（精确到分钟，如 2026-11-26T08:00@Asia/Shanghai），供幂等防重使用。
export function formatScheduleWindowKey(ms, timeZone = DEFAULT_TIMEZONE) {
  const tz = normalizeTimezone(timeZone);
  const p = getZonedParts(ms, tz);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}@${tz}`;
}

// 解析人类直觉周期简写（如 "15m"、"2h"、"6d"、"1w" 或纯数字分钟），让用户无需手算 5 段 Cron。
export function parseEveryToMinutes(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.max(1, Math.round(raw));
  }
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Math.max(1, Number(s));
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks|分|分钟|小时|天|日|周)$/.exec(s);
  if (!m) {
    const err = new Error(`无法识别周期简写 "${raw}"（示例：15m、2h、1d、6d、1w）`);
    err.statusCode = 400;
    err.code = "invalid_every";
    throw err;
  }
  const val = Number(m[1]);
  const unit = m[2];
  if (unit.startsWith("m") || unit.startsWith("分")) return Math.max(1, Math.round(val));
  if (unit.startsWith("h") || unit === "小时") return Math.max(1, Math.round(val * 60));
  if (unit.startsWith("d") || unit === "天" || unit === "日") return Math.max(1, Math.round(val * 1440));
  if (unit.startsWith("w") || unit === "周") return Math.max(1, Math.round(val * 10080));
  return null;
}
