// 独立 Agent 接入模板目录与零配置提示词生成器。
// 支持双轨生成：
// 1. MCP 原生接入（免确认弹窗 + 凭据在传输层隔离，不暴露于对话上下文）
// 2. HTTP 提示词直连（自包含 curl 提示词，适合自带定时器的云端/办公 Agent 与 Webhook 工作流）

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_AGENT_TEMPLATES = [
  {
    id: "generic",
    name: "通用（自定义参数）",
    default_name: "",
    default_id: "",
    role: "worker",
    transport: "poll",
    poll_interval_min: 5,
    preferred_connect: "mcp",
    badge: "自由配置",
    summary_hint: "",
    intro: "你是一个连接在个人版 a2a-hub 编排中台上的独立 Agent。",
  },
  {
    id: "muse",
    name: "Muse（云端主协调）",
    default_name: "Muse",
    default_id: "muse",
    role: "leader",
    transport: "longpoll",
    poll_interval_min: 2,
    preferred_connect: "mcp",
    badge: "Leader · 长连接",
    summary_hint: "云端主调度 Agent，负责拆解目标并编排本机与云端 Worker 协同完成",
    intro: "你是连接在个人版 a2a-hub 编排中台上的主协调 Agent（Muse / Leader）。",
  },
  {
    id: "gemini",
    name: "Gemini（Google 终端 / CLI）",
    default_name: "Gemini",
    default_id: "gemini",
    role: "worker",
    transport: "longpoll",
    poll_interval_min: 5,
    preferred_connect: "mcp",
    badge: "MCP · 免弹窗",
    summary_hint: "Google Gemini 终端 Agent，擅长多模态分析、超大上下文检索与代码协作",
    intro: "你是连接在个人版 a2a-hub 编排中台上的 Gemini Agent。",
  },
  {
    id: "claude-client",
    name: "Claude Desktop / Claude Code",
    default_name: "Claude",
    default_id: "claude",
    role: "worker",
    transport: "longpoll",
    poll_interval_min: 5,
    preferred_connect: "mcp",
    badge: "MCP · 免弹窗",
    summary_hint: "Anthropic Claude 客户端 Agent，擅长复杂工程架构、深度推理与代码重构",
    intro: "你是连接在个人版 a2a-hub 编排中台上的 Claude 客户端 Agent。",
  },
  {
    id: "cursor-agent",
    name: "Cursor / Windsurf IDE",
    default_name: "Cursor",
    default_id: "cursor",
    role: "worker",
    transport: "longpoll",
    poll_interval_min: 5,
    preferred_connect: "mcp",
    badge: "MCP · IDE",
    summary_hint: "IDE 编程 Agent，通过 MCP 直接协同读写本地项目代码与排查 Bug",
    intro: "你是连接在个人版 a2a-hub 编排中台上的 IDE 编程 Agent。",
  },
  {
    id: "lobechat",
    name: "LobeChat / Cherry Studio",
    default_name: "LobeChat",
    default_id: "lobechat",
    role: "leader",
    transport: "longpoll",
    poll_interval_min: 5,
    preferred_connect: "mcp",
    badge: "Leader · MCP",
    summary_hint: "支持挂载 MCP 的个人 AI 助手工作台，可作为主控入口统一调度各端 Agent",
    intro: "你是连接在个人版 a2a-hub 编排中台上的主控工作台 Agent（LobeChat / Cherry Studio）。",
  },
  {
    id: "grok-bot",
    name: "Grok Bot",
    default_name: "Grok Bot",
    default_id: "grok-bot",
    role: "worker",
    transport: "webhook",
    poll_interval_min: 30,
    preferred_connect: "http",
    badge: "Worker · Webhook",
    summary_hint: "具备实时联网搜索与 X/Web 舆情分析能力的云端 Bot",
    intro: "你是一个连接在 a2a-hub 上的云端 Worker Agent（Grok Bot）。",
  },
  {
    id: "workbuddy",
    name: "WorkBuddy（企业微信助手）",
    default_name: "WorkBuddy",
    default_id: "workbuddy",
    role: "worker",
    transport: "poll",
    poll_interval_min: 5,
    preferred_connect: "http",
    badge: "Worker · 定时轮询",
    summary_hint: "负责办公日程、会议纪要整理与团队消息触达的助手",
    intro: "你是一个连接在 a2a-hub 上的办公协作 Worker Agent（WorkBuddy）。",
  },
  {
    id: "doubao",
    name: "豆包（字节 Agent）",
    default_name: "豆包",
    default_id: "doubao",
    role: "worker",
    transport: "poll",
    poll_interval_min: 5,
    preferred_connect: "http",
    badge: "Worker · 定时轮询",
    summary_hint: "擅长中文长文写作、资料总结与创意策划的云端 Agent",
    intro: "你是一个连接在 a2a-hub 上的云端 Worker Agent（豆包）。",
  },
  {
    id: "lingguang",
    name: "灵光（蚂蚁 Agent）",
    default_name: "灵光",
    default_id: "lingguang",
    role: "worker",
    transport: "poll",
    poll_interval_min: 5,
    preferred_connect: "http",
    badge: "Worker · 定时轮询",
    summary_hint: "擅长中文长文写作、资料总结与创意策划的云端 Agent",
    intro: "你是一个连接在 a2a-hub 上的云端 Worker Agent（灵光）。",
  },
  {
    id: "qwen",
    name: "千问（阿里 Agent）",
    default_name: "千问",
    default_id: "qwen",
    role: "worker",
    transport: "poll",
    poll_interval_min: 5,
    preferred_connect: "http",
    badge: "Worker · 定时轮询",
    summary_hint: "擅长结构化数据分析、文档翻译与代码辅助的云端 Agent",
    intro: "你是一个连接在 a2a-hub 上的云端 Worker Agent（千问）。",
  },
  {
    id: "openclaw",
    name: "OpenClaw（个人常驻 Agent）",
    default_name: "OpenClaw",
    default_id: "openclaw",
    role: "leader",
    transport: "longpoll",
    poll_interval_min: 2,
    preferred_connect: "http",
    badge: "Leader · 长连接",
    summary_hint: "24/7 常驻个人多通道 Agent，负责统一调度任务与对接即时通讯入口",
    intro: "你是连接在 a2a-hub 上的常驻主调度 Agent（OpenClaw / Leader）。",
  },
  {
    id: "hermes",
    name: "Hermes Agent（常驻执行助手）",
    default_name: "Hermes",
    default_id: "hermes",
    role: "worker",
    transport: "poll",
    poll_interval_min: 5,
    preferred_connect: "http",
    badge: "Worker · 定时轮询",
    summary_hint: "具备持久化记忆与技能学习的自主执行 Agent",
    intro: "你是一个连接在 a2a-hub 上的常驻执行 Worker Agent（Hermes）。",
  },
  {
    id: "manus",
    name: "Manus（通用自主 Agent）",
    default_name: "Manus",
    default_id: "manus",
    role: "worker",
    transport: "poll",
    poll_interval_min: 5,
    preferred_connect: "http",
    badge: "Worker · 定时轮询",
    summary_hint: "擅长深度调研、网页操作、报告交付与复杂多步任务",
    intro: "你是一个连接在 a2a-hub 上的云端自主 Worker Agent（Manus）。",
  },
  {
    id: "kimi-agent",
    name: "Kimi（月之暗面 Agent）",
    default_name: "Kimi",
    default_id: "kimi-agent",
    role: "worker",
    transport: "poll",
    poll_interval_min: 5,
    preferred_connect: "http",
    badge: "Worker · 定时轮询",
    summary_hint: "擅长超长文档精读、深度检索与研究资料汇总",
    intro: "你是一个连接在 a2a-hub 上的云端研究 Worker Agent（Kimi）。",
  },
];

const RETIRED_TEMPLATE_IDS = new Set(["coze", "dify", "n8n", "feishu-bot"]);

export function loadAgentTemplates(configDir) {
  const filePath = path.join(configDir, "agent_templates.json");
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(configDir, { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(DEFAULT_AGENT_TEMPLATES, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
    return DEFAULT_AGENT_TEMPLATES;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Array.isArray(raw) && raw.length) {
      // 保留老环境已自定义的模板（过滤已下线的非独立 Agent 工具模板），同时补齐 preferred_connect 与新增内置模板
      const defaultMap = new Map(DEFAULT_AGENT_TEMPLATES.map((t) => [t.id, t]));
      const hydrated = raw
        .filter((t) => t && typeof t === "object" && !RETIRED_TEMPLATE_IDS.has(t.id))
        .map((t) => {
          const builtin = defaultMap.get(t.id);
          return {
            ...(builtin ? { preferred_connect: builtin.preferred_connect } : {}),
            ...t,
          };
        });
      const seen = new Set(hydrated.map((t) => t?.id).filter(Boolean));
      const extras = DEFAULT_AGENT_TEMPLATES.filter((t) => !seen.has(t.id));
      return extras.length ? [...hydrated, ...extras] : hydrated;
    }
  } catch {}
  return DEFAULT_AGENT_TEMPLATES;
}

export function findTemplate(configDir, platformId) {
  const list = loadAgentTemplates(configDir);
  return list.find((t) => t.id === platformId) || list.find((t) => t.id === "generic") || DEFAULT_AGENT_TEMPLATES[0];
}

const WORKSPACE_AUTO_WORKER_SPECS = {
  workbuddy: {
    taskFocus: "办公日程、会议纪要整理与团队消息草稿",
    whitelistHint: "办公日程梳理、会议纪要整理、信息归纳、文案或消息草稿起草",
  },
  qwen: {
    taskFocus: "数据分析、文档翻译、资料总结与代码辅助",
    whitelistHint: "文本翻译、总结归纳、文案撰写、结构化数据分析、代码解释或片段生成",
  },
};

function buildWorkspaceAutoWorkerPrompt({ baseUrl, agent, token, tpl, spec }) {
  const pollMin = Number(agent.poll_interval_min || tpl.poll_interval_min || 5) || 5;
  const authHeader = token ? `-H "Authorization: Bearer ${token}"` : "";
  const safeRegisterPayload = JSON.stringify({
    id: agent.id,
    name: agent.name,
    summary: agent.summary || tpl.summary_hint,
    skills: agent.skills?.length ? agent.skills : ["general"],
    tools: agent.tools || [],
  }).replace(/'/g, "'\\''");

  return [
    `帮我接入一下我自己的个人任务看板（a2a-hub），以后我在看板里统一给你派「${spec.taskFocus}」之类的纯内容/办公待办。`,
    "",
    "按下面 3 步直接配好就行：",
    "",
    "1. 把下面这组连接信息保存在你的工作区配置文件或工具配置中（不用写入对话记忆库）：",
    `- 看板地址：\`${baseUrl}\``,
    `- 你的 Agent ID：\`${agent.id}\``,
    ...(token
      ? [`- Bearer Token：\`${token}\``]
      : ["- 鉴权模式：当前 Hub 未启用密钥，直接请求即可"]),
    "",
    "2. 先调用一次注册接口上线并刷新名片：",
    "```bash",
    `curl -sS -X POST "${baseUrl}/api/v1/agents/register" \\`,
    ...(authHeader ? [`  ${authHeader} \\`] : []),
    `  -H "Content-Type: application/json" \\`,
    `  -d '${safeRegisterPayload}'`,
    "```",
    "",
    `3. 帮我建一个每 ${pollMin} 分钟一次的定时执行任务（无待办静默结束，不要报空）：`,
    `- 检查接口：\`GET ${baseUrl}/api/v1/agents/${agent.id}/check\``,
    `- 看到 \`state = "submitted"\` 的待办时，先认领并读取完整任务与上下文（返回含 \`input_text\`、追问回复 \`messages\` 与前情 \`context_history\`）：`,
    `  \`POST ${baseUrl}/api/v1/tasks/<task_id>/claim\``,
    `- **免确认自动执行范围**：凡属于**${spec.whitelistHint}**这类纯内容处理（不对外发消息、不删改重要文件、不动用外部账号），**直接处理完并提交结果，不要停下来问我确认**：`,
    `  \`POST ${baseUrl}/api/v1/tasks/<task_id>/complete\` \`{"summary":"简短结论","text":"详细内容"}\``,
    `- **仅以下情况才挂起**：缺关键信息需要问我，或真涉及对外发消息/删改重要文件时调 \`POST ${baseUrl}/api/v1/tasks/<task_id>/ask\` \`{"prompt":"..."}\`；做不了或出错时调 \`POST ${baseUrl}/api/v1/tasks/<task_id>/fail\` \`{"error":"原因"}\`。`,
    "",
    "配好后把实际配置位置、注册结果和定时任务结果告诉我即可。",
  ].join("\n");
}

// 生成完全脱敏（不含 Token 明文与 curl 命令）的 MCP 纯净版激活提示词。
export function buildAgentMcpPrompt({ agent, template }) {
  const tpl = template || DEFAULT_AGENT_TEMPLATES[0];
  const isLeader = agent.role === "leader";
  const summaryText = agent.summary || tpl.summary_hint || "";

  const lines = [
    `# 接入 a2a-hub 编排中台（${agent.name} · MCP 原生模式）`,
    "",
    tpl.intro || `你是接入个人版 a2a-hub 的 ${isLeader ? "Leader" : "Worker"} Agent。`,
    "当前客户端已为你挂载 `a2a-hub` MCP 服务（连接地址、专属 Token 与你的 Agent 身份已在 MCP 传输层完成安全绑定，全程请直接调用 MCP 工具，无需使用 bash/curl，也无需在参数中传 Token）。",
    "",
    "## 1. 上线签到与刷新名片",
    `收到本提示词后，请立即调用一次 MCP 工具 \`a2a_register\` 完成上线签到${summaryText ? `（可将 summary 设为「${summaryText}」）` : ""}，成功后回复机主「已通过 MCP 接入 a2a-hub，当前在线」。`,
    "",
    isLeader ? "## 2. 日常调度与协同协议（仅使用 MCP 工具）" : "## 2. 日常接单与回执协议（仅使用 MCP 工具）",
    isLeader
      ? [
          "- **发现可用节点**：派单前调用 `a2a_list_agents` 查看全网在线 Agent 的能力定位（`summary`）、技能标签与在线负载。",
          "- **单点或并发扇出派单**：调用 `a2a_dispatch_task`（支持 `to: [\"agent-1\", \"agent-2\"]` 并行派发并自动共享 `context_id` 多轮记忆；若预计任务较快，可设 `wait_sec: 20` 原地等待结果）。",
          "- **拉取增量进度与回执**：调用 `a2a_check_updates`（可传 `wait_sec: 20` 长轮询挂起等待子任务完成或追问，系统会自动推进水位）。",
          "- **处理阻塞追问或取消**：当子任务处于 `input-required` 时，调用 `a2a_reply_task` 补充信息使其恢复执行，或传 `action: \"cancel\"` 取消任务。",
        ].join("\n")
      : [
          "- **检查或长轮询待办**：调用 `a2a_poll_inbox` 检查收件箱（如需持续驻留接单，可传 `wait_sec: 25` 与 `auto_claim: true`，空闲挂起期间不消耗 Token，有新任务派入时立即唤醒并自动认领）。",
          "- **认领任务**：若未开启 `auto_claim`，发现 `submitted` 待办后调用 `a2a_claim_task` 锁定任务并读取完整 `input_text` 与同线程 `context_history` 前情。",
          "- **提交执行回执**：处理后统一调用 `a2a_submit_receipt`：",
          "  1. 完成交付：`status: \"completed\"`，填写 `summary`（简短结论）与 `text`（完整交付内容，原生 JSON 传输无需担心引号或代码块转义）",
          "  2. 需补充信息：`status: \"input-required\"`，填写 `prompt`（向机主或 Leader 追问的具体问题）",
          "  3. 需高危审批：`status: \"auth-required\"`，填写 `reason`（申请机主签名放行的原因）",
          "  4. 执行失败：`status: \"failed\"`，填写 `error`（失败原因）",
        ].join("\n"),
  ];

  return lines.join("\n");
}

// 生成 MCP 挂载配置包（默认 Streamable HTTP 直连，同时提供 npx 免安装 / 本机 ah mcp / CLI 一行命令 + 脱敏提示词）。
export function buildAgentMcpOnboarding({ hubUrl, agent, token, template }) {
  const baseUrl = String(hubUrl || "http://127.0.0.1:8787").replace(/\/+$/, "");
  const tpl = template || findTemplate(".", agent.platform);
  const mcpUrl = `${baseUrl}/api/v1/mcp`;
  const hasRealOrPlaceholderToken = Boolean(token);
  const isPlaceholder = String(token || "").startsWith("<");
  const mcpUrlWithToken = hasRealOrPlaceholderToken
    ? `${mcpUrl}?token=${isPlaceholder ? token : encodeURIComponent(token)}`
    : mcpUrl;
  const preferredConnect =
    tpl?.preferred_connect || (agent.transport === "webhook" ? "http" : "mcp");
  const isGemini = (tpl?.id || agent.platform) === "gemini";

  // Streamable HTTP 直连：同时携带 ?token= 与 Authorization（Gemini 桌面端采用简洁 serverUrl，免去本机 Node/PATH 依赖）
  const httpServerEntry = isGemini
    ? {
        serverUrl: mcpUrlWithToken,
      }
    : {
        url: mcpUrlWithToken,
        ...(hasRealOrPlaceholderToken
          ? {
              headers: {
                Authorization: `Bearer ${token}`,
              },
            }
          : {}),
      };

  const stdioEnv = {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    AH_URL: baseUrl,
    ...(hasRealOrPlaceholderToken ? { AH_TOKEN: token } : { AH_AGENT: agent.id }),
  };

  const npxServerEntry = {
    command: "npx",
    args: ["-y", "github:backtomyfuture/a2a-hub", "mcp"],
    env: stdioEnv,
  };

  const stdioServerEntry = {
    command: "ah",
    args: ["mcp"],
    env: stdioEnv,
  };

  const envFlags = [`-e AH_URL="${baseUrl}"`];
  if (hasRealOrPlaceholderToken) envFlags.push(`-e AH_TOKEN="${token}"`);
  else if (agent.id) envFlags.push(`-e AH_AGENT="${agent.id}"`);

  return {
    preferred_connect: preferredConnect,
    mcp_url: mcpUrl,
    mcp_url_with_token: mcpUrlWithToken,
    mcp_prompt: buildAgentMcpPrompt({ agent, template: tpl }),
    http_json: JSON.stringify({ mcpServers: { "a2a-hub": httpServerEntry } }, null, 2),
    npx_json: JSON.stringify({ mcpServers: { "a2a-hub": npxServerEntry } }, null, 2),
    stdio_json: JSON.stringify({ mcpServers: { "a2a-hub": stdioServerEntry } }, null, 2),
    cli_commands: {
      gemini: `gemini mcp add --transport http a2a-hub "${mcpUrlWithToken}"`,
      claude: `claude mcp add --transport http a2a-hub "${mcpUrlWithToken}"`,
      stdio_gemini: `gemini mcp add a2a-hub ah mcp ${envFlags.join(" ")}`,
    },
  };
}

export function buildAgentOnboardingPrompt({ hubUrl, agent, token, template, mode = "http" }) {
  const baseUrl = String(hubUrl || "http://127.0.0.1:8787").replace(/\/+$/, "");
  const tpl = template || findTemplate(".", agent.platform);
  if (mode === "mcp") {
    return buildAgentMcpPrompt({ agent, template: tpl });
  }
  const isLeader = agent.role === "leader";
  const platformId = tpl?.id || agent.platform;
  if (!isLeader && Object.hasOwn(WORKSPACE_AUTO_WORKER_SPECS, platformId)) {
    return buildWorkspaceAutoWorkerPrompt({
      baseUrl,
      agent,
      token,
      tpl,
      spec: WORKSPACE_AUTO_WORKER_SPECS[platformId],
    });
  }

  const skillName = isLeader ? "a2a-leader" : "a2a-worker";
  const authHeader = token ? `-H "Authorization: Bearer ${token}"` : "";

  const lines = [
    `# 接入 a2a-hub 编排中台（${agent.name}）`,
    "",
    tpl.intro || `你是接入个人版 a2a-hub 的 ${agent.role === "leader" ? "Leader" : "Worker"} Agent。`,
    "",
    "## 1. 连接凭据（请妥善保存在本地安全环境变量或记忆中）",
    `- Hub 地址：\`${baseUrl}\``,
    `- 你的 Agent ID：\`${agent.id}\``,
    `- 角色：\`${agent.role}\`（接入模式：\`${agent.transport}\`，建议检查间隔 ${agent.poll_interval_min} 分钟）`,
    ...(token ? [`- Bearer Token：\`${token}\``] : ["- 鉴权模式：当前 Hub 未启用密钥，直接请求即可"]),
    `- 完整协议 Skill 文档（随时按需拉取）：\`GET ${baseUrl}/api/v1/skills/${skillName}\``,
    "",
    "## 2. 上线自检与刷新名片",
    "收到本提示词后，请立即发送一次注册心跳确认在线：",
    "```bash",
    `curl -sS -X POST "${baseUrl}/api/v1/agents/register" \\`,
    ...(authHeader ? [`  ${authHeader} \\`] : []),
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify({
      id: agent.id,
      name: agent.name,
      summary: agent.summary || tpl.summary_hint,
      skills: agent.skills?.length ? agent.skills : ["general"],
      tools: agent.tools || [],
    })}'`,
    "```",
    "",
    "## 3. 日常循环接单协议",
    isLeader
      ? [
          `- 查看全网在线 Agent 能力目录：\`GET ${baseUrl}/api/v1/agents\``,
          `- 向单个或多个 Agent 派发协作任务（自动共享 \`context_id\` 多轮记忆）：`,
          `  \`POST ${baseUrl}/api/v1/tasks\` body: \`{"to":["<agent-id>"],"title":"...","input_text":"..."}\``,
          `- 增量拉取你发出任务的最新回执与阻塞提问：\`GET ${baseUrl}/api/v1/agents/${agent.id}/updates?new=1\``,
          `- 若你自己也接收直派任务，可轮询 \`GET ${baseUrl}/api/v1/agents/${agent.id}/check\``,
        ].join("\n")
      : [
          `- 轻量检查待办（推荐配置为定时任务每 ${agent.poll_interval_min} 分钟一次；长连接可用 \`/poll?timeout=30\`）：`,
          `  \`GET ${baseUrl}/api/v1/agents/${agent.id}/check\``,
          `- 如需查看自己的完整收件箱：\`GET ${baseUrl}/api/v1/agents/${agent.id}/inbox\``,
          `- 当看到 \`state = "submitted"\` 且指向 \`${agent.id}\` 的任务时：`,
          `  1. 认领锁定：\`POST ${baseUrl}/api/v1/tasks/<task_id>/claim\``,
          `  2. 需要机主追问补充信息时：\`POST ${baseUrl}/api/v1/tasks/<task_id>/ask\` \`{"prompt":"..."}\``,
          `  3. 遇到高危操作需要机主在线签名放行时：\`POST ${baseUrl}/api/v1/tasks/<task_id>/auth\` \`{"reason":"...","risk_level":"high"}\``,
          `  4. 完成后提交结果：\`POST ${baseUrl}/api/v1/tasks/<task_id>/complete\` \`{"summary":"简短结论","text":"详细内容"}\``,
        ].join("\n"),
    "",
    "## 4. 回执规则",
    "完成第 2 步首次注册心跳后，回复机主「已成功接入 a2a-hub，当前在线」。",
  ];

  return lines.join("\n");
}

export function buildDeviceJoinCommands({ hubUrl, deviceToken, deviceId }) {
  const parsed = new URL(String(hubUrl || "http://127.0.0.1:8787"));
  const authUrl = deviceToken
    ? `${parsed.protocol}//${encodeURIComponent(deviceToken)}@${parsed.host}${parsed.pathname.replace(/\/$/, "")}`
    : String(hubUrl).replace(/\/$/, "");
  const nameFlag = deviceId ? ` --device ${deviceId}` : "";
  const winDevicePrefix = deviceId ? `$env:AH_DEVICE="${deviceId}"; ` : "";
  return {
    unix: `curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh -s -- --join "${authUrl}"${nameFlag}`,
    windows: `${winDevicePrefix}$env:AH_JOIN="${authUrl}"; irm https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.ps1 | iex`,
    cli: `ah join "${authUrl}"${nameFlag} --service`,
  };
}

export function buildDeviceJoinCommand(opts) {
  return buildDeviceJoinCommands(opts).unix;
}
