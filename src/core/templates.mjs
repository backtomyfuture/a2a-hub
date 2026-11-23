// 独立 Agent 接入模板目录与零配置提示词生成器。
// 默认以 HTTP 提示词直连优先（适配绝大多数不支持自定义 MCP 的云端 Agent，且内建明确轮询要求），
// 同时为支持自定义 MCP 的本地桌面/IDE 客户端提供 MCP 原生双轨接入：
// 1. HTTP 提示词直连（默认首选：自包含 curl 与定时轮询 / 长连接 / Webhook 兜底巡检指引）
// 2. MCP 原生接入（免确认弹窗 + 凭据在传输层隔离，不暴露于对话上下文）

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
    preferred_connect: "http",
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
    preferred_connect: "http",
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
    summary_hint: "擅长中文资料整理、结构化总结与日常办公内容协作的云端 Agent",
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
      // 保留老环境已自定义的模板（过滤已下线的非独立 Agent 工具模板），并同步内置模板的 preferred_connect 策略
      const defaultMap = new Map(DEFAULT_AGENT_TEMPLATES.map((t) => [t.id, t]));
      const hydrated = raw
        .filter((t) => t && typeof t === "object" && !RETIRED_TEMPLATE_IDS.has(t.id))
        .map((t) => {
          const builtin = defaultMap.get(t.id);
          return {
            ...t,
            preferred_connect: builtin ? builtin.preferred_connect : t.preferred_connect || "http",
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

function shellSingleQuoteEscape(str) {
  return String(str).replace(/'/g, "'\\''");
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
  doubao: {
    taskFocus: "中文写作、资料总结、信息整理与创意策划",
    whitelistHint: "文案撰写、内容润色、资料总结、信息整理与方案起草",
  },
  lingguang: {
    taskFocus: "资料整理、结构化总结与日常办公内容协作",
    whitelistHint: "信息归纳、文档总结、要点提炼与日常办公文案起草",
  },
  "kimi-agent": {
    taskFocus: "长文档精读、深度检索与研究资料汇总",
    whitelistHint: "长文精读、资料检索、观点对比与研究摘要整理",
  },
  manus: {
    taskFocus: "深度调研、网页信息整理与结构化报告交付",
    whitelistHint: "资料调研、公开网页检索、数据整理与结构化报告撰写",
  },
};

function buildWorkspaceAutoWorkerPrompt({ baseUrl, agent, token, tpl, spec }) {
  const pollMin = Number(agent.poll_interval_min || tpl.poll_interval_min || 5) || 5;
  const authHeader = token ? `-H "Authorization: Bearer ${token}"` : "";
  const safeRegisterPayload = shellSingleQuoteEscape(
    JSON.stringify({
      id: agent.id,
      name: agent.name,
      summary: agent.summary || tpl.summary_hint,
      skills: agent.skills?.length ? agent.skills : ["general"],
      tools: agent.tools || [],
    })
  );

  return [
    `帮我接入一下我自己的个人任务看板（a2a-hub），以后我在看板里统一给你派「${spec.taskFocus}」之类的纯内容/办公待办。`,
    "",
    "按下面 3 步直接配好就行（第 3 步的定时轮询是必须步骤，不要只做完注册就结束）：",
    "",
    "1. 把下面这组连接信息保存在你的工作区配置文件或工具配置中（不用写入对话记忆库；后续所有接口请求均携带 `Accept: application/json`" +
      (token ? " 与 `Authorization: Bearer <Token>`" : "") +
      "）：",
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
    `3. 必须建一个每 ${pollMin} 分钟一次的定时轮询任务（核心步骤，不可跳过；看板靠它维持你的在线状态并派发待办；无待办静默结束，不要报空）：`,
    `- 检查接口：\`GET ${baseUrl}/api/v1/agents/${agent.id}/check\`（每次调用同时刷新你的在线心跳；超过 ${pollMin} × 1.5 分钟未检查会被标记离线）`,
    "- 空闲判定：若返回 `paused: true` 或 `work: false`（`tasks` 为空），**直接静默结束本轮，不要向我发“无待办/巡检正常”等空消息**。",
    "- 认领与上下文：当 `work: true` 且 `tasks` 非空时（`tasks` 中每一项都是待认领任务），逐条取 `task.id` 调用接口锁定并读取完整 `input_text`、追问回复 `messages` 与同线程前情 `context_history`：",
    `  \`POST ${baseUrl}/api/v1/tasks/<task_id>/claim\``,
    `- **免确认自动执行范围**：凡属于**${spec.whitelistHint}**这类纯内容/信息处理（不对外发消息、不删改重要文件、不动用外部账号），**直接处理完并提交结果，不要停下来问我确认**：`,
    `  \`POST ${baseUrl}/api/v1/tasks/<task_id>/complete\` \`{"summary":"简短结论","text":"详细内容"}\`（若单次耗时超过 5 分钟，可中途调 \`POST ${baseUrl}/api/v1/tasks/<task_id>/heartbeat\` \`{"lease_sec":300}\` 续租防超时回收）`,
    `- **仅以下情况才挂起或报错**：缺关键信息需要问我，或真涉及对外发消息/删改重要文件时调 \`POST ${baseUrl}/api/v1/tasks/<task_id>/ask\` \`{"prompt":"..."}\`；做不了或出错时调 \`POST ${baseUrl}/api/v1/tasks/<task_id>/fail\` \`{"error":"原因"}\`。`,
    "- **平台能力兜底**：若当前运行环境不支持创建定时任务，请直接明确告诉我，不要假装已配好。",
    "",
    "以上 3 步全部配好后，把实际配置位置、注册结果和定时轮询任务的创建结果（频率与任务名）告诉我即可。",
  ].join("\n");
}

// 生成完全脱敏（不含 Token 明文与 curl 命令）的 MCP 纯净版激活提示词。
export function buildAgentMcpPrompt({ agent, template }) {
  const tpl = template || DEFAULT_AGENT_TEMPLATES[0];
  const isLeader = agent.role === "leader";
  const transport = agent.transport || tpl.transport || "poll";
  const pollMin = Number(agent.poll_interval_min || tpl.poll_interval_min || 5) || 5;
  const summaryText = agent.summary || tpl.summary_hint || "";

  const pollingGuide = isLeader
    ? [
        `- **快速任务等待与耗时回执跟踪**：派发快速任务可在 \`a2a_dispatch_task\` 中设 \`wait_sec: 20\` 原地等待结果；涉及多节点或耗时任务时，循环调用 \`a2a_check_updates\`（可传 \`wait_sec: 25\` 长轮询挂起等待，系统会自动推进水位）。`,
        transport === "longpoll"
          ? `- **维持在线与定时巡检兜底**：建议持续循环调用 \`a2a_check_updates({ wait_sec: 25 })\`；若当前客户端不支持常驻循环，请建立每 ${pollMin} 分钟一次的定时巡检调用 \`a2a_check_updates({ advance: true })\`（无新回执时**静默结束，不要报空**）。`
          : `- **必须建立周期巡检**：请配置每 ${pollMin} 分钟一次的定时巡检调用 \`a2a_check_updates({ advance: true })\` 刷新在线心跳并拉取子任务进度与阻塞追问（无新回执时**静默结束，不要报空**）。`,
        "- **能力限制如实告知**：若当前客户端不支持定时器或后台持续循环，请在回复中明确告知机主。",
      ]
    : [
        transport === "longpoll"
          ? `- **常驻长轮询待命（推荐）**：请持续循环调用 \`a2a_poll_inbox({ wait_sec: 25, auto_claim: true })\` 驻留接单（空闲挂起期间不消耗 Token 且自动刷新在线心跳，有新任务立即唤醒并认领，超时立即开启下一轮）；若当前客户端不支持常驻后台循环，**请改为配置每 ${pollMin} 分钟一次的定时巡检**调用 \`a2a_poll_inbox({ auto_claim: true })\`（无待办时**静默结束，不要报空**）。`
          : transport === "webhook"
            ? `- **Webhook 唤醒 + 兜底轮询**：收到外部通知后调用 \`a2a_claim_task\` 认领处理，同时请配置每 ${pollMin} 分钟一次的定时兜底巡检调用 \`a2a_poll_inbox({ auto_claim: true })\` 刷新在线心跳并防止漏单（无待办时**静默结束，不要报空**）。`
            : `- **必须建立定时轮询（核心步骤）**：请配置每 ${pollMin} 分钟一次的定时巡检调用 \`a2a_poll_inbox({ auto_claim: true })\` 检查待办并刷新在线心跳（无待办时**静默结束，不要报空**）；若客户端支持交互式持续待命，也可循环调用 \`a2a_poll_inbox({ wait_sec: 25, auto_claim: true })\`。`,
        "- **能力限制如实告知**：若当前客户端不支持定时器或后台持续循环，请在回复中明确告知机主。",
      ];

  const lines = [
    `# 接入 a2a-hub 编排中台（${agent.name} · MCP 原生模式）`,
    "",
    tpl.intro || `你是接入个人版 a2a-hub 的 ${isLeader ? "Leader" : "Worker"} Agent。`,
    "当前客户端已为你挂载 `a2a-hub` MCP 服务（连接地址、专属 Token 与你的 Agent 身份已在 MCP 传输层完成安全绑定，全程请直接调用 MCP 工具，无需使用 bash/curl，也无需在参数中传 Token）。",
    "",
    "## 1. 立即上线签到与刷新名片",
    `收到本提示词后，请立即调用一次 MCP 工具 \`a2a_register\` 完成上线签到${summaryText ? `（可将 summary 设为「${summaryText}」）` : ""}。`,
    "",
    "## 2. 必须建立轮询 / 待命机制（核心步骤，不可跳过）",
    ...pollingGuide,
    "",
    isLeader ? "## 3. 日常调度与协同协议（仅使用 MCP 工具）" : "## 3. 日常接单与回执协议（仅使用 MCP 工具）",
    isLeader
      ? [
          "- **发现可用节点**：派单前调用 `a2a_list_agents` 查看全网在线 Agent 的能力定位（`summary`）、技能标签与在线负载。",
          "- **单点或并发扇出派单**：调用 `a2a_dispatch_task`（支持 `to: [\"agent-1\", \"agent-2\"]` 并行派发并自动共享 `context_id` 多轮记忆；快速任务可设 `wait_sec: 20`）。",
          "- **拉取增量进度与回执**：调用 `a2a_check_updates`（可传 `wait_sec: 25` 长轮询挂起等待子任务完成或追问，系统会自动推进水位）。",
          "- **处理阻塞追问或取消**：当子任务处于 `input-required` 时，调用 `a2a_reply_task` 补充信息使其恢复执行，或传 `action: \"cancel\"` 取消任务；遇到 `auth-required` 时仅机主本人可签名审批，须通知机主处理。",
        ].join("\n")
      : [
          "- **检查或长轮询待办**：调用 `a2a_poll_inbox` 检查收件箱（可传 `wait_sec: 25` 与 `auto_claim: true`）。",
          "- **认领任务**：若未开启 `auto_claim`，发现待办后调用 `a2a_claim_task` 锁定任务并读取完整 `input_text` 与同线程 `context_history` 前情。",
          "- **提交执行回执**：常规非破坏性任务认领后直接处理并统一调用 `a2a_submit_receipt`（长耗时任务中途可传 `status: \"heartbeat\"` 续租）：",
          "  1. 完成交付：`status: \"completed\"`，填写 `summary`（简短结论）与 `text`（完整交付内容，原生 JSON 传输无需担心引号或代码块转义）",
          "  2. 需补充信息：`status: \"input-required\"`，填写 `prompt`（向机主或 Leader 追问的具体问题）",
          "  3. 需高危审批：`status: \"auth-required\"`，填写 `reason`（申请机主签名放行的原因）",
          "  4. 执行失败：`status: \"failed\"`，填写 `error`（失败原因）",
        ].join("\n"),
    "",
    "## 4. 接入完成回报",
    "完成 `a2a_register` 签到并落实第 2 步轮询/待命方式后再回复机主，汇报：①签到结果、②实际采用的轮询机制与频率（如客户端不支持定时或后台循环请如实说明）。",
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
    agent.transport === "webhook"
      ? "http"
      : tpl?.preferred_connect || "http";
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

function buildHttpPollingSection({ baseUrl, agent, pollMin, transport, isLeader }) {
  const sigHeader = agent.webhook_header || "X-A2A-Signature";
  if (isLeader) {
    if (transport === "longpoll") {
      return [
        `- **主模式（常驻长连接循环）**：在后台持续循环请求 \`GET ${baseUrl}/api/v1/agents/${agent.id}/poll?since=<seq>&timeout=35\`（单次 Hold 上限 40s；当你派出的子任务状态变化或有直派给你的任务时会立即唤醒；用返回 \`seq\` 更新 \`since\`，超时立即重连，网络异常退避 3~5s 重试）。`,
        `  - 每次唤醒后：调用 \`GET ${baseUrl}/api/v1/agents/${agent.id}/updates?new=1\` 消费子任务完成回执、失败或阻塞提问；若返回 \`tasks\` 非空则按 \`task.id\` 认领处理直派任务。`,
        `- **云端平台降级方案（重要）**：若当前运行环境不支持常驻后台循环，**必须立即改为创建每 ${pollMin} 分钟一次的定时轮询任务**：`,
        `  1. 调用 \`GET ${baseUrl}/api/v1/agents/${agent.id}/check\`（同时刷新在线心跳）。`,
        "  2. 若 `paused: true` 或 `work: false`（`leader_updates_count === 0` 且 `pending_count === 0`），**静默结束本轮，严禁向机主报空**。",
        `  3. 若 \`leader_updates_count > 0\`：立即调用 \`GET ${baseUrl}/api/v1/agents/${agent.id}/updates?new=1\` 拉取子任务最新回执或阻塞通知（自动推进服务端水位），汇总进展或继续编排。`,
        "  4. 若 `pending_count > 0`（有直派给你的任务）：按 `tasks[].id` 认领并处理。",
        "- **能力受限说明**：若当前环境既不支持后台循环也不支持定时任务，请在回复中明确告知机主。",
      ].join("\n");
    }
    if (transport === "webhook") {
      return [
        `- **主模式（Webhook 事件回调）**：接收 Hub 推送的回调 \`POST\`（事件类型 \`task.completed\` / \`task.failed\` / \`task.input_required\` / \`task.auth_required\` / \`task.submitted\`，校验请求头 \`${sigHeader}\` 的 \`sha256=<HMAC-SHA256>\` 签名）后，调用 \`GET ${baseUrl}/api/v1/agents/${agent.id}/updates?new=1\` 拉取子任务回执或按 \`task_id\` 认领直派任务。`,
        `- **必须配置定时兜底巡检**：同时创建每 ${pollMin} 分钟一次的定时轮询调用 \`GET ${baseUrl}/api/v1/agents/${agent.id}/check\`（防止漏收 Webhook 并维持在线心跳；若 \`work: false\` 则**静默结束本轮，严禁报空**；若 \`leader_updates_count > 0\` 则拉 \`/updates?new=1\`，\`pending_count > 0\` 则认领 \`tasks[].id\`）。`,
      ].join("\n");
    }
    return [
      `- **必须立即创建每 ${pollMin} 分钟一次的定时轮询任务（不可跳过）**：`,
      `  1. 调用 \`GET ${baseUrl}/api/v1/agents/${agent.id}/check\`（同时刷新在线心跳，超时未报将自动离线）。`,
      "  2. 若 `paused: true` 或 `work: false`（`leader_updates_count === 0` 且 `pending_count === 0`），**静默结束本轮，严禁向机主报空**。",
      `  3. 若 \`leader_updates_count > 0\`：立即调用 \`GET ${baseUrl}/api/v1/agents/${agent.id}/updates?new=1\` 拉取子任务最新完成回执、失败或 \`input-required\` / \`auth-required\` 阻塞通知（自动推进服务端水位），汇总进展或继续编排。`,
      "  4. 若 `pending_count > 0`（有直派给你的任务）：按 `tasks[].id` 认领并处理。",
      "  5. 若运行环境不支持定时任务，必须在回复中明确告知机主。",
    ].join("\n");
  }

  if (transport === "longpoll") {
    return [
      `- **主模式（常驻长连接循环）**：在后台持续循环请求 \`GET ${baseUrl}/api/v1/agents/${agent.id}/poll?since=<seq>&timeout=35\`（单次 Hold 上限 40s；用返回 \`seq\` 更新 \`since\`，超时立即重连，网络错误退避 3~5s 重试）；当 \`paused: false\` 且 \`tasks\` 非空时逐条认领执行。`,
      `- **云端平台降级方案（重要）**：若当前运行环境不支持常驻后台循环，**必须立即改为创建每 ${pollMin} 分钟一次的定时轮询任务**：`,
      `  1. 调用 \`GET ${baseUrl}/api/v1/agents/${agent.id}/check\`（同时刷新在线心跳）。`,
      "  2. 若 `paused: true` 或 `work: false`（`tasks` 为空），**静默结束本轮，严禁向机主报空**。",
      "  3. 若 `work: true` 且 `tasks` 非空（`tasks` 中每一项均是待认领任务），逐条取 `task.id` 按第 4 步认领执行。",
      "- **能力受限说明**：若当前环境既不支持后台循环也不支持定时任务，请在回复中明确告知机主。",
    ].join("\n");
  }
  if (transport === "webhook") {
    return [
      `- **主模式（Webhook 门铃唤醒）**：接收 Hub 推送的门铃 \`POST\`（事件头 \`X-A2A-Event: task.submitted | task.resumed\`，含 \`task_id\`、\`context_id\`、\`title\`）；若配置了密钥须校验 \`${sigHeader}\` 的 \`sha256=<HMAC-SHA256>\` 签名，随后用 \`task_id\` 调 \`POST ${baseUrl}/api/v1/tasks/<task_id>/claim\` 认领并读取完整指令执行。`,
      `- **必须配置定时兜底巡检**：同时创建每 ${pollMin} 分钟一次的定时轮询调用 \`GET ${baseUrl}/api/v1/agents/${agent.id}/check\`（防止漏收 Webhook 并维持在线状态；若 \`paused: true\` 或 \`work: false\` 则**静默结束本轮，严禁报空**；若 \`tasks\` 非空则逐条认领执行）。`,
    ].join("\n");
  }
  return [
    `- **必须立即创建每 ${pollMin} 分钟一次的定时轮询任务（不可跳过）**：`,
    `  1. 调用 \`GET ${baseUrl}/api/v1/agents/${agent.id}/check\`（同时刷新在线心跳，超过 ${pollMin} × 1.5 分钟未检查会自动离线）。`,
    "  2. 若 `paused: true` 或 `work: false`（`tasks` 为空），**静默结束本轮，严禁向机主报空**。",
    "  3. 若 `work: true` 且 `tasks` 非空（`tasks` 中每一项均是待认领任务），逐条取 `task.id` 按第 4 步认领执行。",
    "  4. 若运行环境不支持定时任务，必须在回复中明确告知机主。",
  ].join("\n");
}

export function buildAgentOnboardingPrompt({ hubUrl, agent, token, template, mode = "http" }) {
  const baseUrl = String(hubUrl || "http://127.0.0.1:8787").replace(/\/+$/, "");
  const tpl = template || findTemplate(".", agent.platform);
  if (mode === "mcp") {
    return buildAgentMcpPrompt({ agent, template: tpl });
  }
  const isLeader = agent.role === "leader";
  const transport = agent.transport || tpl.transport || "poll";
  const pollMin = Number(agent.poll_interval_min || tpl.poll_interval_min || 5) || 5;
  const platformId = tpl?.id || agent.platform;
  if (!isLeader && transport === "poll" && Object.hasOwn(WORKSPACE_AUTO_WORKER_SPECS, platformId)) {
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
  const safeRegisterPayload = shellSingleQuoteEscape(
    JSON.stringify({
      id: agent.id,
      name: agent.name,
      summary: agent.summary || tpl.summary_hint,
      skills: agent.skills?.length ? agent.skills : ["general"],
      tools: agent.tools || [],
    })
  );

  const lines = [
    `# 接入 a2a-hub 编排中台（${agent.name}）`,
    "",
    tpl.intro || `你是接入个人版 a2a-hub 的 ${isLeader ? "Leader" : "Worker"} Agent。`,
    "",
    "## 1. 保存连接凭据（请保存在工作区配置文件、环境变量或工具配置中，勿写入普通对话记忆或泄露给第三方）",
    `- Hub 地址：\`${baseUrl}\``,
    `- 你的 Agent ID：\`${agent.id}\``,
    `- 角色与接入模式：\`${agent.role}\` / \`${transport}\`（轮询/在线窗口 ${pollMin} 分钟）`,
    ...(token
      ? [`- Bearer Token：\`${token}\``]
      : ["- 鉴权模式：当前 Hub 未启用密钥，直接请求即可"]),
    `- 请求头要求：除健康检查外，所有业务接口统一携带 \`Accept: application/json\`` +
      (token ? " 与 `Authorization: Bearer <Token>`" : ""),
    `- 完整协议 Skill 文档（按需拉取）：\`GET ${baseUrl}/api/v1/skills/${skillName}\``,
    "",
    "## 2. 立即上线注册与刷新名片",
    "收到本提示词后，请立即发送一次注册心跳确认上线：",
    "```bash",
    `curl -sS -X POST "${baseUrl}/api/v1/agents/register" \\`,
    ...(authHeader ? [`  ${authHeader} \\`] : []),
    `  -H "Content-Type: application/json" \\`,
    `  -d '${safeRegisterPayload}'`,
    "```",
    "",
    "## 3. 必须建立轮询 / 接收机制（核心步骤，不可跳过）",
    buildHttpPollingSection({ baseUrl, agent, pollMin, transport, isLeader }),
    "",
    isLeader ? "## 4. 日常调度与编排协议" : "## 4. 日常接单与八态回执协议",
    isLeader
      ? [
          `- 派单前发现全网在线能力：\`GET ${baseUrl}/api/v1/agents\`（仅向 \`enabled: true\` 的节点派单）`,
          `- 单点或并发扇出派单（自动共享 \`context_id\` 多轮记忆）：`,
          `  \`POST ${baseUrl}/api/v1/tasks\` \`{"to":["<agent-id>"],"title":"...","input_text":"...","context_id":"<可选续接已有线程>"}\`（严禁在 \`params\` 传入 \`command\`/\`cwd\`/\`env\` 等执行控制字段）`,
          `- 拉取增量回执：\`GET ${baseUrl}/api/v1/agents/${agent.id}/updates?new=1\`；查看整条对话线程：\`GET ${baseUrl}/api/v1/threads/<context_id>\``,
          `- 处理阻塞与审批：子任务处于 \`input-required\` 时补充回复 \`POST ${baseUrl}/api/v1/tasks/<task_id>/reply\` \`{"body":"..."}\` 或取消 \`POST ${baseUrl}/api/v1/tasks/<task_id>/cancel\`；处于 \`auth-required\` 时**仅机主本人可签名审批**，须立即通知机主前往控制台处理，严禁越权放行。`,
          `- 若收到直派给自己的任务，同样按 \`claim\` -> 执行/拆解 -> \`complete\`/\`ask\`/\`fail\` 闭环处理。`,
        ].join("\n")
      : [
          `- 认领锁定：\`POST ${baseUrl}/api/v1/tasks/<task_id>/claim\`（返回完整 \`input_text\`、追问记录 \`messages\` 与同线程前情 \`context_history\`）`,
          `- 长耗时续租（防 20 分钟超时回收）：\`POST ${baseUrl}/api/v1/tasks/<task_id>/heartbeat\` \`{"progress":{"percent":50},"lease_sec":300}\``,
          `- 完成后提交交付：\`POST ${baseUrl}/api/v1/tasks/<task_id>/complete\` \`{"summary":"简短结论","text":"详细交付内容"}\`（常规非破坏性任务认领后直接处理并提交，无需反复停下确认）`,
          `- 缺关键信息需追问：\`POST ${baseUrl}/api/v1/tasks/<task_id>/ask\` \`{"prompt":"具体问题"}\``,
          `- 遇到高危破坏性操作需机主签名放行：\`POST ${baseUrl}/api/v1/tasks/<task_id>/auth\` \`{"reason":"原因","command_preview":"拟执行动作","risk_level":"high"}\``,
          `- 无法完成或执行报错：\`POST ${baseUrl}/api/v1/tasks/<task_id>/fail\` \`{"error":"失败原因","retryable":false}\``,
          `- 如需查看全部历史收件箱：\`GET ${baseUrl}/api/v1/agents/${agent.id}/inbox\``,
        ].join("\n"),
    "",
    "## 5. 接入完成回报",
    "请完成以上第 1~3 步（保存配置、完成注册、建立轮询/长连接/兜底巡检）后再回复我，汇报：①凭据保存位置、②注册结果、③实际建立的轮询/长连接方式与频率（如平台不支持定时或后台循环请如实说明）。",
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
