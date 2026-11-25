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

function extractContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          if (typeof part.text === "string") return part.text;
          if (part.content !== undefined) return extractContentText(part.content);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (content.content !== undefined) return extractContentText(content.content);
  }
  return "";
}

function pickSessionId(obj) {
  if (!obj || typeof obj !== "object") return "";
  return String(
    obj.session_id ||
      obj.sessionID ||
      obj.sessionId ||
      obj.thread_id ||
      obj.threadId ||
      obj.conversation_id ||
      obj.conversationId ||
      obj.chat_id ||
      obj.chatId ||
      ""
  );
}

function parseEventList(events, raw) {
  let sessionId = "";
  let finalResultText = "";
  const messageChunks = [];
  let lastUsage = null;
  let isError = false;

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const evSession = pickSessionId(ev);
    if (evSession) {
      sessionId = evSession;
    } else if (ev.type === "session" && ev.id) {
      sessionId = String(ev.id);
    }

    if (ev.is_error === true || ev.subtype === "failure" || ev.subtype === "error" || ev.type === "error") {
      isError = true;
    }

    if (ev.type === "result" && ev.result !== undefined) {
      // 终态 result 字段已汇总最终答复，避免与前序 assistant 分片重复拼接
      finalResultText = extractContentText(ev.result) || (typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result));
    } else if (ev.type === "run_result" && typeof ev.text === "string") {
      finalResultText = ev.text;
    } else if (ev.type === "error" || (ev.type === "result" && ev.is_error === true)) {
      // Amp 欠费等失败的 result 事件不带 result 字段，原因只在 error 里；漏取会回退成整段原始 JSONL
      const errCand = ev.error ?? ev.message ?? ev.text;
      const errTxt = errCand !== undefined ? (extractContentText(errCand) || (typeof errCand === "string" ? errCand : JSON.stringify(errCand))) : "";
      if (errTxt) finalResultText = errTxt;
    } else if (ev.type === "message" && ev.role === "assistant" && ev.content !== undefined) {
      const chunk = extractContentText(ev.content);
      if (chunk) messageChunks.push(chunk);
    } else if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item?.text) {
      messageChunks.push(String(ev.item.text));
    } else if (ev.type === "text" && ev.part?.text) {
      messageChunks.push(String(ev.part.text));
    } else if (ev.type === "assistant" && ev.message?.content !== undefined) {
      const chunk = extractContentText(ev.message.content);
      if (chunk) messageChunks.push(chunk);
    } else if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message?.content !== undefined) {
      const chunk = extractContentText(ev.message.content);
      if (chunk) messageChunks.push(chunk);
    } else if (typeof ev.result === "string") {
      messageChunks.push(ev.result);
    } else if (typeof ev.text === "string" && !["step_start", "system", "thinking"].includes(ev.type)) {
      messageChunks.push(ev.text);
    }

    if (ev.usage || ev.total_cost_usd !== undefined) {
      lastUsage = ev.usage || { total_cost_usd: ev.total_cost_usd };
    }
  }

  return {
    text: finalResultText.trim() || messageChunks.join("\n").trim() || raw,
    sessionId,
    usage: lastUsage,
    structured: events,
    isError,
  };
}

export function formatCliFailure(parsed, stderr = "", code = 1) {
  const errText = String(stderr || "").trim();
  const outText = String(parsed?.text || "").trim();
  if (parsed?.isError && outText) {
    return outText.slice(0, 1000);
  }
  if (parsed?.structured && outText) {
    const nonEmptyErrLines = errText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const onlyHarmlessWarnings =
      nonEmptyErrLines.length === 0 ||
      nonEmptyErrLines.every((l) => /^(warning|ignored)\b/i.test(l));
    if (onlyHarmlessWarnings) {
      return outText.slice(0, 1000);
    }
    return `${outText}\n${errText}`.slice(0, 1000);
  }
  return (errText || outText || `exit_code=${code}`).trim().slice(0, 1000);
}

export function parseCliOutput(stdout, stderr = "") {
  const raw = String(stdout || "").trim();
  if (!raw) {
    return {
      text: String(stderr || "").trim(),
      sessionId: "",
      usage: null,
      structured: null,
      isError: false,
    };
  }

  const parsedJson = tryParseJson(raw);

  // 1) 顶层 JSON 事件数组（如 CodeBuddy -p --output-format json）
  if (Array.isArray(parsedJson) && parsedJson.some((it) => it && typeof it === "object")) {
    return parseEventList(parsedJson, raw);
  }

  // 2) 单对象 JSON（如 Claude Code / Droid / Agy / Cursor / Grok / Qwen -p --output-format json）
  if (parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
    const isError = Boolean(
      parsedJson.is_error ||
        parsedJson.subtype === "failure" ||
        parsedJson.subtype === "error" ||
        parsedJson.error
    );
    const candidate =
      parsedJson.result ??
      parsedJson.response ??
      parsedJson.output ??
      parsedJson.text ??
      parsedJson.message ??
      parsedJson.content ??
      parsedJson.summary ??
      parsedJson.error;
    const extracted = candidate !== undefined ? extractContentText(candidate) : "";
    const text =
      extracted ||
      (typeof candidate === "string" ? candidate : candidate !== undefined ? JSON.stringify(candidate) : raw);
    const sessionId = pickSessionId(parsedJson);
    const usage =
      parsedJson.usage ||
      (parsedJson.total_cost_usd !== undefined ? { total_cost_usd: parsedJson.total_cost_usd } : null);
    return {
      text: typeof text === "string" ? text : JSON.stringify(text),
      sessionId,
      usage,
      structured: parsedJson,
      isError,
    };
  }

  // 3) JSONL 事件流（如 Amp / Claude / Codex / OpenCode / Kimi / Cline / Pi / Kilo）
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const events = lines.map(tryParseJson).filter((ev) => ev && typeof ev === "object");
  if (events.length > 0) {
    return parseEventList(events, raw);
  }

  // 4) 纯文本回退
  return {
    text: raw,
    sessionId: "",
    usage: null,
    structured: null,
    isError: false,
  };
}
