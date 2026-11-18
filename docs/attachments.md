# 附件能力接口约定（feature/attachments）

本文件是附件能力各阶段实现的共同约定。实现与本文冲突时以本文为准，需要改约定先找架构负责人。

## 1. 地址与数据形态

- 中台托管文件的地址：`hub://files/<file_id>`。`file_id` 形如 `F-<32 位小写 hex>`（`randomBytes(16)`），不可猜。
- 外部文件直接用 `http://` / `https://` URL，中台不下载、不托管。
- 其它 scheme（`file://`、裸本地路径等）只允许出现在执行节点交付回执的输入端，内核负责自动上传后改写成 `hub://`；上传前文件不存在时保留原字符串（兼容旧行为）并记日志。
- 落表：每个附件一行 `parts`，`Kind=file`，`File_URI` / `File_Name` / `Mime_Type` 必填（MIME 未知用 `application/octet-stream`），`Text` / `Data` 为空。消息附件的 `Seq` 排在 text、data 块之后，按传入顺序递增。
- 单条消息附件上限 20 个；`File_Name` 去掉路径分隔符与控制字符，截到 255 字节。
- 本轮不新增逻辑表、不加列；`schema/` 不变。

## 2. 存储（`src/hub/files.mjs`，阶段 1）

- 内容：`<configDir>/files/blobs/<file_id 前 2 位 hex>/<file_id>`，目录 0700，文件 0600。
- 索引：`<configDir>/files/files.db`（`node:sqlite`，WAL），表 `blobs`：
  `file_id TEXT PK, name TEXT, mime TEXT, size INTEGER, sha256 TEXT, uploaded_by TEXT, created_at TEXT(ISO), deleted_at TEXT NULL, deleted_reason TEXT NULL`。
- 导出 `class FileStore({ configDir, maxBytes = 100 * 1024 * 1024 })`：
  - `async putStream(readable, { name, mime, uploadedBy }) -> meta`：先写 `blobs/.tmp/<rand>`，边写边算 sha256 与大小，超限立即中止、删临时文件并抛 `err.status = 413`；成功后 rename 到正式位置再写索引。
  - `async putFile(localPath, opts) -> meta`（供中台本机内核 / CLI 直接用）。
  - `get(fileId) -> meta | null`（含已删除记录）；`openReadStream(fileId)`；`markDeleted(fileId, reason)`（删内容、保留索引行）。
  - `meta` 对外形状：`{ file_id, uri, name, mime, size, sha256, uploaded_by, created_at, deleted_at }`。
- `parseHubFileUri(uri) -> file_id | null`、`HUB_FILE_URI_PREFIX = "hub://files/"`。
- `async findFileRefs(bus, fileId) -> [{ task_id, parent_type, parent_id }]`：扫 `parts` 中 `File_URI === hub://files/<id>` 的行，message 父经 `messages.Task_ID`、artifact 父经 `artifacts.Task_ID` 找到任务。

## 3. HTTP 接口（`src/server/http-server.mjs`，阶段 1）

- `POST /api/v1/files`：请求体为文件原始字节（不是 JSON）。头：`Content-Type` 作 MIME（缺省 `application/octet-stream`），`X-File-Name` 作文件名（URL 编码，解码后按 §1 规则清洗，缺省 `file`），`Content-Length` 超过上限直接 413。响应 `201 { file_id, uri, name, mime, size, sha256 }`。`uploaded_by`：agent 身份记绑定节点，owner 记 `owner`，open 记 `open`。
- `GET /api/v1/files/:id`：流式返回内容。头：`Content-Type`、`Content-Length`、`X-Content-Type-Options: nosniff`、`Cache-Control: private, max-age=0`、`Content-Disposition: attachment; filename*=UTF-8''<编码名>`。`?inline=1` 且 MIME 属于 `image/png|image/jpeg|image/gif|image/webp` 时改 `inline`；其它类型（含 `image/svg+xml`）忽略 `inline`。
- `GET /api/v1/files/:id/meta`：返回 `meta` 与 `refs`（任务 id 列表）。
- 错误：不存在 404；已清理 `410 { error: "文件已过期清理", deleted_at, reason }`；无权 403（为免枚举，agent 无权时也可统一 404，本约定选 **404**）。
- 可见性：owner / open 全可见；agent 可见当且仅当 `uploaded_by === principal.node`，或 `findFileRefs` 里任一任务满足 `agentCanSeeTask`。
- `src/hub/agent-access.mjs`：任何 agent 角色放行 `POST /api/v1/files`、`GET /api/v1/files/:id`、`GET /api/v1/files/:id/meta`，可见性在路由处理里判。
- 上传不走 `readJsonBody`，现有 2MB JSON 上限不变。

## 4. 清理（阶段 1，`FileRetentionService`）

- Hub 进程每小时跑一次，启动后 1 分钟先跑一次；单轮出错只记日志，不影响守护进程。
- 未被任何 Part 引用、且上传超过 24 小时：删除，reason `unreferenced`。
- 上传超过 30 天，且所有引用任务都已终态（`TERMINAL_STATUSES`）：删除，reason `expired`。仍有非终态任务引用的跳过。
- 删除＝删内容文件、索引行写 `deleted_at`；Parts 不动。

## 5. 文件客户端（`src/files-client.mjs`，阶段 1）

统一接口，供内核、CLI、inbox 使用：

```js
createFileClient(cfg) // busType=sqlite（中台本机）→ LocalFileClient(FileStore)；busType=http → HttpFileClient({ hubUrl, apiToken })
client.upload(localPath, { name?, mime? }) -> meta   // MIME 缺省按扩展名猜（内置小表），猜不到 octet-stream
client.download(uri, destPath) -> { path, size, mime } // 仅 hub://；410 抛 err.code = "EXPIRED"，404 抛 "NOT_FOUND"
```

HTTP 客户端用全局 `fetch`，上传用流（`duplex: "half"`），沿用 HttpBus 的 Bearer 头与 0/1/3/8 秒退避（4xx 除 429 外不重试）。

## 6. 写入路径（阶段 2）

统一入参 `attachments: [{ uri | file_id, name?, mime? }]`，`file_id` 归一为 `hub://files/<id>`；`hub://` 必须在 FileStore 存在且未删除，否则 400；`name` / `mime` 缺省从 meta 补。外部 URL 只允许 http/https，长度 ≤ 2048，禁止带用户名密码。

| 路径 | 改动 |
|---|---|
| `POST /api/v1/tasks`、`createTask()`、`ah task create --file <路径>`（可重复） | instruction 消息追加文件块 |
| `POST /api/v1/tasks/:id/reply`、`ah task reply --file` | answer 消息追加文件块；有附件时 `text` 可为空 |
| 网关 `ask` / `auth`、`ah inbox ask --file`、内核 `agent-ask` 围栏 | question / auth_request 消息追加文件块 |
| 网关 `complete` / `fail` 的 `artifacts: [{uri,name,mime}]`（旧 `artifact` 字符串继续兼容）、`ah inbox done --artifact` 可重复、执行器多行 `ARTIFACT:`、JSON 回执 `artifacts` 数组 | 每个文件一条 Artifact + 一个 file Part，`Mime_Type` 填写；本地路径先经文件客户端上传，上传失败留在 outbox 下轮重试 |

## 7. 读取路径（阶段 2）

- 内核 `collectDialogue`：收 instruction / question / answer 的文件块；`hub://` 下载到 `runs/<Task_ID>/files/<序号>-<文件名>`（0600），`input.json.files[]` 每项 `{ uri, name, mime, from_kind, local_path? , error? }`；过期写 `error: "expired"`，不判任务失败。
- 网关任务视图（poll / inbox / updates / `GET /api/v1/tasks/:id`）：新增 `instruction_attachments`、`question_attachments`、`answer_attachments`（最近一条），`artifacts[].files[]` 与上述各项统一为 `{ file_uri, file_name, mime_type, download_url }`；`hub://` 的 `download_url` = `<hubUrl>/api/v1/files/<id>`（hubUrl 取 `publicUrl` 或请求 Host），外部 URL 原样。

## 8. 控制台（阶段 3，`src/server/web-ui.mjs`）

- 任务详情：消息与产物里的文件块，图片（§3 白名单）用 `fetch` 带 Bearer 取 blob 后 `URL.createObjectURL` 显示缩略图，点击看大图；其它类型显示文件名、大小、下载按钮（同样 fetch + blob 下载，不把 Token 放进 URL）。410 显示「已过期清理」。
- 建单与答复表单：多选文件，逐个 `POST /api/v1/files` 带进度，完成后把 `file_id` 放进 `attachments` 提交；单个超过 100MB 前端先拦。

## 9. 约束

- 零第三方依赖，Node >= 24 ESM；注释用中文写「为什么」。
- 测试只用 `node:test`，状态写临时目录；每个阶段新增测试并保证 `npm test` 全绿、`node --check` 全过。
- Messages / Parts 只追加；终态任务不重开。
