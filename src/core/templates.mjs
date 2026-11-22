// 独立 Agent 接入模板目录与零配置提示词生成器。
// 新增 Agent 时只需要选平台模板 -> 填写名称与定位 -> 拿到带真凭据的自包含提示词发给对方。

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_AGENT_TEMPLATES = [
  {
    id: "muse",
    name: "Muse / 云端协调 Agent",
    icon: "brain",
    role: "leader",
    transport: "poll",
    poll_interval_min: 1,
    badge: "协调者 Leader",
    summary_hint: "云端主调度 Agent，负责拆分目标并编排本机与云端 Worker 协同完成",
    intro: "你是连接在个人版 a2a-hub 编排中台上的主协调 Agent（Muse / Leader）。",
  },
  {
    id: "grok-bot",
    name: "Grok Bot / Telegram Bot",
    icon: "bot",
    role: "worker",
    transport: "poll",
    poll_interval_min: 5,
    badge: "实时问答 / 搜索",
    summary_hint: "具备实时联网搜索与 X/Web 舆情分析能力的云端 Bot",
    intro: "你是一个连接在 a2a-hub 上的云端 Worker Agent（Grok Bot）。",
  },
  {
    id: "workbuddy",
    name: "WorkBuddy / 企业微信助手",
    icon: "briefcase",
    role: "worker",
    transport: "poll",
    poll_interval_min: 5,
    badge: "办公消息触达",
    summary_hint: "负责办公日程、会议纪要整理与企业微信团队触达的助手",
    intro: "你是一个连接在 a2a-hub 上的办公协作 Worker Agent（WorkBuddy）。",
  },
  {
    id: "doubao",
    name: "豆包 / 字节 Agent",
    icon: "sparkles",
    role: "worker",
    transport: "poll",
    poll_interval_min: 5,
    badge: "中文内容 / 多模态",
    summary_hint: "擅长中文长文写作、资料总结与创意策划的云端 Agent",
    intro: "你是一个连接在 a2a-hub 上的云端 Worker Agent（豆包）。",
  },
  {
    id: "qwen",
    name: "千问 / 阿里 Agent",
    icon: "cpu",
    role: "worker",
    transport: "poll",
    poll_interval_min: 5,
    badge: "长文本 / 分析",
    summary_hint: "擅长结构化数据分析、文档翻译与代码辅助的云端 Agent",
    intro: "你是一个连接在 a2a-hub 上的云端 Worker Agent（千问）。",
  },
  {
    id: "generic-poll",
    name: "通用定时轮询 (Poll)",
    icon: "clock",
    role: "worker",
    transport: "poll",
    poll_interval_min: 5,
    badge: "Cron / 轻量脚本",
    summary_hint: "通过定时轮询或 cron 检查队列并完成任务的独立 Agent",
    intro: "你是一个通过 HTTP 定时轮询接入 a2a-hub 的独立 Agent。",
  },
  {
    id: "generic-longpoll",
    name: "通用长连接 (Longpoll)",
    icon: "radio",
    role: "worker",
    transport: "longpoll",
    poll_interval_min: 2,
    badge: "常驻进程 / 毫秒响应",
    summary_hint: "常驻进程 Agent，通过 40s HTTP 长轮询实现秒级实时接单",
    intro: "你是一个通过 HTTP 长轮询接入 a2a-hub 的实时 Agent。",
  },
  {
    id: "generic-webhook",
    name: "Webhook 主动推送",
    icon: "webhook",
    role: "worker",
    transport: "webhook",
    poll_interval_min: 30,
    badge: "HTTP 回调 / Serverless",
    summary_hint: "接收中台签名 Webhook 门铃唤醒并回拉完整任务的 Agent",
    intro: "你是一个通过 Webhook 门铃唤醒接入 a2a-hub 的独立 Agent。",
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
    if (Array.isArray(raw) && raw.length) return raw;
  } catch {}
  return DEFAULT_AGENT_TEMPLATES;
}

export function findTemplate(configDir, platformId) {
  const list = loadAgentTemplates(configDir);
  return list.find((t) => t.id === platformId) || list.find((t) => t.id === "generic-poll") || DEFAULT_AGENT_TEMPLATES[5];
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

export function buildDeviceJoinCommand({ hubUrl, deviceToken, deviceId }) {
  const parsed = new URL(String(hubUrl || "http://127.0.0.1:8787"));
  const authUrl = deviceToken
    ? `${parsed.protocol}//${encodeURIComponent(deviceToken)}@${parsed.host}${parsed.pathname.replace(/\/$/, "")}`
    : String(hubUrl).replace(/\/$/, "");
  const nameFlag = deviceId ? ` --device ${deviceId}` : "";
  return `ah join "${authUrl}"${nameFlag} --service`;
}
