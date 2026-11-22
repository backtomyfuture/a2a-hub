// 本地 CLI 执行命令构造与输出回执解析（支持 Claude JSON、Codex JSONL、OpenCode JSON 与纯文本）。

export function shellQuote(s) {
  const str = String(s ?? "");
  if (process.platform === "win32") {
    return `"${str.replace(/"/g, '\\"')}"`;
  }
  return `'${str.replace(/'/g, "'\\''")}'`;
}

export function buildModelArgs(modelFlag, model) {
  const m = String(model || "").trim();
  const flag = String(modelFlag || "").trim();
  if (!m || !flag) return "";
  return `${flag} ${shellQuote(m)}`;
}

// 用纯正则替换已知占位符，绝不使用任意代码求值。
export function renderWorkerCommand({
  worker,
  prompt,
  promptFile,
  sessionId = "",
  model = "",
}) {
  const useResume = Boolean(sessionId && worker.resume_command);
  const tpl = useResume ? worker.resume_command : worker.command;
  if (!tpl) {
    throw new Error(`Worker ${worker.key} 未配置可执行 command`);
  }
  const effectiveModel = String(model || worker.default_model || "").trim();
  const modelArgs = buildModelArgs(worker.model_flag, effectiveModel);
  const replacements = new Map([
    ["{prompt}", shellQuote(prompt)],
    ["{prompt_file}", shellQuote(promptFile)],
    ["{session}", shellQuote(sessionId)],
    ["{model_args}", modelArgs],
    ["{model}", shellQuote(effectiveModel)],
    ["{cwd}", shellQuote(worker.cwd || process.cwd())],
  ]);

  let out = String(tpl);
  for (const [token, value] of replacements.entries()) {
    out = out.split(token).join(value);
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

function tryParseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function parseCliOutput(stdout, stderr = "") {
  const raw = String(stdout || "").trim();
  if (!raw) {
    return {
      text: String(stderr || "").trim(),
      sessionId: "",
      usage: null,
      structured: null,
    };
  }

  // 1) 单对象 JSON（如 Claude Code -p --output-format json）
  const single = tryParseJson(raw);
  if (single && typeof single === "object" && !Array.isArray(single)) {
    const text =
      single.result ??
      single.text ??
      single.message ??
      single.content ??
      single.summary ??
      raw;
    const sessionId = single.session_id || single.sessionId || single.thread_id || "";
    const usage = single.usage || (single.total_cost_usd !== undefined ? { total_cost_usd: single.total_cost_usd } : null);
    return {
      text: typeof text === "string" ? text : JSON.stringify(text),
      sessionId: String(sessionId || ""),
      usage,
      structured: single,
    };
  }

  // 2) JSONL 事件流（如 Codex exec --json / OpenCode --format json）
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let sessionId = "";
  const messageChunks = [];
  let lastUsage = null;
  let parsedJsonl = false;

  for (const line of lines) {
    const ev = tryParseJson(line);
    if (!ev || typeof ev !== "object") continue;
    parsedJsonl = true;
    if (ev.session_id || ev.sessionID || ev.thread_id || ev.sessionId) {
      sessionId = String(ev.session_id || ev.sessionID || ev.thread_id || ev.sessionId);
    }
    if (ev.type === "thread.started" && ev.thread_id) {
      sessionId = String(ev.thread_id);
    }
    if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item?.text) {
      messageChunks.push(String(ev.item.text));
    } else if (ev.type === "text" && ev.part?.text) {
      messageChunks.push(String(ev.part.text));
    } else if (typeof ev.result === "string") {
      messageChunks.push(ev.result);
    } else if (typeof ev.text === "string" && ev.type !== "step_start") {
      messageChunks.push(ev.text);
    }
    if (ev.usage) lastUsage = ev.usage;
  }

  if (parsedJsonl) {
    const finalText = messageChunks.join("\n").trim() || raw;
    return {
      text: finalText,
      sessionId,
      usage: lastUsage,
      structured: null,
    };
  }

  // 3) 纯文本回退
  return {
    text: raw,
    sessionId: "",
    usage: null,
    structured: null,
  };
}
