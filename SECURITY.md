# 安全说明

a2a-hub 会在你的机器上按任务拉起命令和 Agent，并在 Hub 节点提供 HTTP API 与 Web 控制台。这份文档说明它防什么、不防什么，以及怎么报告漏洞。

## 报告漏洞

请不要在公开 issue 里贴可利用的细节。用 GitHub 的私密漏洞报告：仓库页 **Security → Report a vulnerability**。报告里请写清受影响的版本（`ah --version`）、复现步骤和你认为的影响。

目前只维护最新版本，修复不回补旧版本。

## 信任模型

- **总线通过 Hub HTTP 网关访问（Bearer Token 鉴权）。** Token 分两类：机主 `AH_API_TOKEN`（宿主节点与 Web 控制台使用，可读写总线表与调用全部接口，`From_Node`、`Role`、`Approval_Class` 等字段由写入方申报）；分 Agent Token（机主在控制台为外部 HTTP Agent 签发，绑定节点与角色，只能走网关的取单/派单/回执路由，`node` / `from` 由 Hub 按 Token 强制校验，不能访问 `/api/v1/tables/*`、`/api/v1/state`、`/api/v1/poll`、审批与 Token 管理接口）。
- **本机配置是可信的，总线内容是不可信的。** 执行什么命令、在哪个目录、用哪个 Agent、给什么权限，只来自本机 `commands.json`。任务行上的 Worker 与技能名只是在这份白名单里按名字选一项。
- **Agent 与守护进程是同一个系统用户。** 被拉起的 Agent 读得到守护进程读得到的一切，包括本机配置目录中的 `app.env` 与（在 Hub 主机上的）`approval_key.pem`。

## 防什么

| 威胁 | 做法 |
|---|---|
| 任务正文里的提示注入改写执行方式 | 指令、参数、问答只写进本次执行的 `input.json`（600），不拼进 prompt；参数里带 `command` / `cwd` / `agent` / `worker` / `verify` 等控制键的任务直接拒收 |
| 冒写审批决定 | hub 用本机 ed25519 私钥（`approval_key.pem`）给 `auth_decision` 签名，节点按 `node.json` 里固定的 `hubPublicKey` 验签。签名绑定任务号、审批请求与决定值，冒写的、抄自别的任务的都当作不存在 |
| 未授权调用 Hub API / 控制台操作 | 除 `/api/v1/health`、静态首页 `/` 与 `/.well-known/agent.json` 外，所有 `/api/*` 路由均校验机主 `AH_API_TOKEN` 或分 Agent Token（常量时间比较，Agent Token 只存 sha256 哈希）并按角色限定可用路由；审批通过 `ApprovalService` 串行校验与签名 |
| 从外部连入执行节点 | 边缘执行节点与纯 HTTP Agent 只发起出站请求，不开监听端口，不做反向隧道 |
| 派生任务无限套娃 | 跳数超过 8（`HOP_LIMIT=8`）熔断，累加不清零 |
| 副作用被重复执行 | 在途账本、outbox 与幂等键（含 SQLite `client_token` 去重）：回执无效或提交中断只补齐提交，不重跑命令 |
| 静默降级成假成功 | 能力不存在、点名的 Worker 不存在、配置取值非法，一律拒收并说明原因 |
| 凭据外泄 | `AH_API_TOKEN` 与 `approval_key.pem` 只在本机 600 文件里，不进总线、不进日志、不进仓库 |

## 不防什么

- **节点没配 `hubPublicKey` 时，审批决定只按自报字段校验。** 这时任何能写总线的身份都能冒写批准。`ah doctor` 会提示。配置方法：在 hub 上跑 `ah doctor` 拿到公钥，在节点上 `ah setup --hub-key <公钥>`（或通过 `ah join` 自动同步）。公钥应带外核对，不从普通任务行读取。
- **任务行的 `Approval_Class` 能被改松。** 它在总线上，是发起方的请求，不是安全边界。改不动的边界是执行节点本机 `commands.json` 里的 `approval_class` 下限（Worker 与 Skill 取严）。高风险的 Worker 和技能要在本机声明 `approve`。
- **hub 那台机器上的 Agent 读得到签名私钥。** hub 也是执行节点，它拉起的 Agent 与它同一个系统用户。要隔离，就让 hub 不登记有工具权限的 Worker，或者把 hub 放在专用机器或专用系统用户下。
- **持有机主 `AH_API_TOKEN` 或 Leader 类 Agent Token 的接入方都能派单。** 拿到机主 Token 的节点，或角色为 leader / hybrid 的外部 HTTP Agent，可以给任意已接纳节点建任务（Agent Token 只能以自己的节点名发起）。任务能做的事仍受目标节点本机 `commands.json` 和审批下限约束，但 `approval_class` 为 `auto` 的能力会直接执行。
- **明文 HTTP 链路窃听。** Hub 内置 HTTP 服务默认监听明文 HTTP；若暴露到公网或不可信网络，必须在前端配置 TLS/HTTPS 反向代理或置于内网加密通道（如 WireGuard / Tailscale）内。
- **Agent 自身的权限。** 多数无头 Agent CLI 的模板带「跳过权限确认」一类的开关（见 [能力模板库](docs/agent-templates.md)），否则无人值守跑不起来。被拉起的 Agent 能做该系统用户能做的任何事。本项目不提供沙箱。
- **在途账本的进程号复用。** 取不到进程启动时间戳时无法区分复用的进程号，超时信号存在误伤可能（标准 §4 的局限一节）。

## 部署建议

1. 始终启用强随机 `AH_API_TOKEN`（`ah up` 默认自动生成），跨公网访问务必配合 HTTPS 反向代理或加密隧道。
2. 每个节点都配 `hubPublicKey` 并核对公钥指纹。
3. 有写权限的 Worker 在本机声明 `approval_class: approve`。
4. 安装后跑 `ah doctor`，处理它报出的每一条告警。
5. 安装脚本从仓库拉取代码并在本机执行，运行前先看一眼脚本内容。
