// 独立 Agent 接入模板目录与零配置提示词生成器。
// 新增 Agent 时只需要选平台模板 -> 填写名称与定位 -> 拿到带真凭据的自包含提示词发给对方。

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
    badge: "Leader · 长连接",
    summary_hint: "云端主调度 Agent，负责拆解目标并编排本机与云端 Worker 协同完成",
    intro: "你是连接在个人版 a2a-hub 编排中台上的主协调 Agent（Muse / Leader）。",
  },
  {
    id: "grok-bot",
    name: "Grok Bot",
    default_name: "Grok Bot",
    default_id: "grok-bot",
    role: "worker",
    transport: "webhook",
    poll_interval_min: 30,
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
    badge: "Worker · 定时轮询",
    summary_hint: "擅长中文长文写作、资料总结与创意策划的云端 Agent",
    intro: "你是一个连接在 a2a-hub 上的云端 Worker Agent（豆包）。",
  },
  {
    id: "qwen",
    name: "千问（阿里 Agent）",
    default_name: "千问",
    default_id: "qwen",
    role: "worker",
    transport: "poll",
    poll_interval_min: 5,
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
    badge: "Worker · 定时轮询",
    summary_hint: "擅长超长文档精读、深度检索与研究资料汇总",
    intro: "你是一个连接在 a2a-hub 上的云端研究 Worker Agent（Kimi）。",
  },
  {
    id: "coze",
    name: "Coze / 扣子 Bot",
    default_name: "Coze Bot",
    default_id: "coze",
    role: "worker",
    transport: "webhook",
    poll_interval_min: 30,
    badge: "Worker · Webhook",
    summary_hint: "通过扣子工作流与插件生态完成垂直业务自动化任务",
    intro: "你是一个连接在 a2a-hub 上的 Coze Bot Worker Agent。",
  },
  {
    id: "dify",
    name: "Dify Workflow Agent",
    default_name: "Dify",
    default_id: "dify",
    role: "worker",
    transport: "webhook",
    poll_interval_min: 30,
    badge: "Worker · Webhook",
    summary_hint: "基于 Dify 编排流程与知识库检索（RAG）的业务 Agent",
    intro: "你是一个连接在 a2a-hub 上的 Dify 工作流 Worker Agent。",
  },
  {
    id: "n8n",
    name: "n8n 自动化工作流",
    default_name: "n8n Flow",
    default_id: "n8n",
    role: "worker",
    transport: "webhook",
    poll_interval_min: 30,
    badge: "Worker · Webhook",
    summary_hint: "通过 n8n Webhook 触发多系统集成、数据同步与自动化通知",
    intro: "你是一个连接在 a2a-hub 上的 n8n 自动化工作流 Worker。",
  },
  {
    id: "feishu-bot",
    name: "飞书机器人 / 多维表格 Agent",
    default_name: "飞书助手",
    default_id: "feishu-bot",
    role: "worker",
    transport: "webhook",
    poll_interval_min: 30,
    badge: "Worker · Webhook",
    summary_hint: "对接飞书群消息、文档、审批与多维表格协作的办公 Agent",
    intro: "你是一个连接在 a2a-hub 上的飞书协作 Worker Agent。",
  },
];

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
      // 保留老环境已自定义的模板，同时增量补充版本升级带来的新内置模板
      const seen = new Set(raw.map((t) => t?.id).filter(Boolean));
      const extras = DEFAULT_AGENT_TEMPLATES.filter((t) => !seen.has(t.id));
      return extras.length ? [...raw, ...extras] : raw;
    }
  } catch {}
  return DEFAULT_AGENT_TEMPLATES;
}

export function findTemplate(configDir, platformId) {
  const list = loadAgentTemplates(configDir);
  return list.find((t) => t.id === platformId) || list.find((t) => t.id === "generic") || DEFAULT_AGENT_TEMPLATES[0];
}

export function buildAgentOnboardingPrompt({ hubUrl, agent, token, template }) {
  const baseUrl = String(hubUrl || "http://127.0.0.1:8787").replace(/\/+$/, "");
  const tpl = template || findTemplate(".", agent.platform);
  const isLeader = agent.role === "leader";
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
