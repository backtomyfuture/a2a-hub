# 逻辑表结构

本文件由 `schema/generate_schema.mjs` 从仓库内的 SQLite 逻辑表定义生成。
独立中台把这些字段放进 `records.fields_json`，不按列建物理表。完整规范见
[中台标准](standard.md)。

## tasks

Task：一件工作的信封与状态机，一行一任务

| 字段 | 类型 | 说明 |
|---|---|---|
| Title | text | 主字段。主字段 |
| Task_ID | text | 业务编号，唯一、人可读，发起方生成后不变 |
| Source | text | 任务来源：hub / cron / manual / agent-derived 等 |
| Target_Node | text | 目标节点名，与 agentCards.Node 对应 |
| Worker_Hint | text | 指定目标节点上的 Worker；写了是硬约束，留空由节点取默认并在认领时回填 |
| Skill_ID | text | 要调用的技能 id，与 agentCards.Skill_ID 对应 |
| Status | select | A2A 八态状态机；终态不可变（选项：submitted / working / input-required / auth-required / completed / failed / canceled / rejected） |
| Approval_Class | select | approve 类须走审批流（选项：auto / notify / approve） |
| Hop_Count | number | 派生层数，>8 熔断 |
| Idempotency_Key | text | 建单幂等键：来源+业务键 |
| Latest_Run | text | 最新一条 Run 的 Run_ID |
| Presented | select | 结果是否已呈递给操作者（选项：Yes / No） |
| Claimed_By | text | 认领租约：当前持有节点 |
| Heartbeat_At | text | 认领心跳；20 分钟无心跳视为放弃、可回收 |
| Retry_Count | number | 失败重试计数，上限 2 |
| Context_ID | text | 会话键（A2A contextId）：同一件事的全部任务共享 |
| Status_Msg | text | 指向当前提问/待批消息的 Msg_ID |
| Metadata | text | A2A 原生自由字段（JSON）；非核心本地信息放这里，不新增列 |

## messages

Message：任务内全部对话轮次，只追加，一行一消息（正文在 parts）

| 字段 | 类型 | 说明 |
|---|---|---|
| Msg_ID | text | 主字段。主键，同时是幂等键（重复投递靠它去重） |
| Task_ID | text |  |
| Context_ID | text |  |
| From_Node | text |  |
| To_Node | text |  |
| Role | select | user（发起方→执行方）/ agent（执行方→发起方）（选项：user / agent） |
| Kind | select | 消息种类（选项：instruction / question / answer / auth_request / auth_decision / progress / result / notice） |
| Artifact_Ref | text | 关联的 Artifact_ID（result 消息用） |
| In_Reply_To | text | 所回复消息的 Msg_ID，构成对话链 |
| Created_At | text |  |
| Ref_Task_IDs | text | A2A referenceTaskIds：本消息关联/派生的前任任务 |

## parts

Part：消息与产物的内容块，一行一块，text/file/data 三型

| 字段 | 类型 | 说明 |
|---|---|---|
| Part_ID | text | 主字段。主字段 |
| Parent_ID | text | 所属消息 Msg_ID 或产物 Artifact_ID |
| Parent_Type | select | message / artifact（选项：message / artifact） |
| Seq | number |  |
| Kind | select | text / file / data（A2A TextPart / FilePart / DataPart）（选项：text / file / data） |
| Text | text | text 块正文；长内容只放指针，本体放产物或外部存储 |
| File_URI | text |  |
| File_Name | text |  |
| Mime_Type | text |  |
| Data | text | data 块的 JSON：任务参数、审批决定等走这里 |

## runs

每次执行的起止、结果与报错

| 字段 | 类型 | 说明 |
|---|---|---|
| Run_ID | text | 主字段。形如 <Task_ID>-R<序号> |
| Task_Ref | text |  |
| Node | text |  |
| Worker | text | 本次执行实际使用的 Worker；节点本尊直接执行记 daemon |
| Error_Log | text | 失败信息；沟通内容不写这里，去 messages |
| Started_At | text |  |
| Finished_At | text |  |
| Outcome | select | paused＝等补信息暂停，不计失败（选项：succeeded / failed / paused） |

## artifacts

Artifact：交付物登记，内容为其 FilePart，修订＝同名新 ID

| 字段 | 类型 | 说明 |
|---|---|---|
| Artifact_ID | text | 主字段。建议 <Task_ID>-A<序号> |
| Task_ID | text |  |
| Context_ID | text |  |
| Name | text | 产物名；同名再交付即新版本（修订＝同名新 ID） |
| Is_Final | select | 是否终稿（选项：Yes / No） |
| Created_By | text |  |
| Created_At | text |  |
| Description | text |  |
| Metadata | text |  |

## agentCards

AgentCard 规范化展开：一行一项能力

| 字段 | 类型 | 说明 |
|---|---|---|
| Cap_ID | text | 主字段。行主键：CAP-<节点前缀>-<技能>；Worker 的能力为 CAP-<节点前缀>-<Worker>-<技能> |
| Node | text | 节点名（AgentCard name 的节点部分） |
| Zone | text |  |
| Description | text | 技能说明（skill.description） |
| Skill_ID | text | 技能 id（skill.id） |
| Side_Effect | select | 决定默认审批等级（选项：read / write / external） |
| Availability | text | online / work-hours / offline 等在册状态 |
| Dispatchable | select | Yes 才可派发（选项：Yes / No） |
| Daemon_Version | text |  |
| Node_Desc | text |  |
| Receive_Mode | select | 唤醒方式：守护进程 longpoll/poll；纯 HTTP Agent 为 http-poll（定时检查）、http-longpoll（常驻长轮询）、webhook（中台门铃推送）（选项：longpoll / poll / http-poll / http-longpoll / webhook） |
| Skill_Name | text |  |
| Input_Modes | text |  |
| Output_Modes | text |  |
| Metadata | text | A2A 原生自由字段（JSON）；内核登记写入 {kind, mode}，可为空 |
| Worker | text | 该能力由哪个 Worker 执行，留空＝节点本尊 |
| Admission | select | 机主接纳状态；缺省、空或其他值按 pending。只由 Hub 管理 API 写（选项：admitted / pending / rejected） |
| Display_Name | text | 机主显示名，可空，不超过 64 字符。只由 Hub 管理 API 写 |
| Admin_Note | text | 机主备注，可空，不超过 500 字符。只由 Hub 管理 API 写 |

## rules

路由、审批策略与定时观察镜像

| 字段 | 类型 | 说明 |
|---|---|---|
| Rule_ID | text | 主字段。主字段 |
| Match_Type | text | 按 Skill_ID 或标签匹配 |
| Target_Node | text |  |
| Worker_Hint | text |  |
| Skill_ID | text |  |
| Approval_Class | select | 选项：auto / notify / approve |
| Priority | number | 多规则命中时按优先级取一 |
| Enabled | select | 是否生效（选项：Yes / No） |
| Note | text |  |
| Schedule | text |  |
| Text | text |  |
| Last_Fired | text |  |
