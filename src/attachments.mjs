// 附件共用纯逻辑（docs/attachments.md §1、§6、§7）：
// 入参归一与校验、file Part 落表、网关 / 详情的附件视图，以及本地产物的待上传条目处理。
// 校验失败一律抛 status=400 的错误，由 HTTP 层原样回给调用方。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { f1 } from "./bus/tables.mjs";
import { guessMime } from "./files-client.mjs";
import { HUB_FILE_URI_PREFIX, normalizeMime, parseHubFileUri, sanitizeFileName } from "./hub/files.mjs";

export const MAX_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_URI_LENGTH = 2048;
const FILE_ID_RE = /^F-[0-9a-f]{32}$/;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// 外部 URL 取路径末段当文件名；解码失败或为空由 sanitizeFileName 退回默认值。
function nameFromUrl(url) {
  try {
    const seg = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
    return seg;
  } catch {
    return "";
  }
}

// 把 [{ uri | file_id, name?, mime? }] 归一成 [{ uri, name, mime }]。
// fileStore 在中台本机可用：hub:// 必须存在且未删除。远端场景（拿不到 fileStore）只校验格式。
export function normalizeAttachments(input, { fileStore = null } = {}) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw badRequest("attachments 必须是数组");
  if (input.length > MAX_ATTACHMENTS) {
    throw badRequest(`单条消息最多 ${MAX_ATTACHMENTS} 个附件，收到 ${input.length} 个`);
  }
  const out = [];
  input.forEach((raw, idx) => {
    const tag = `attachments[${idx}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest(`${tag} 必须是对象`);
    for (const key of ["uri", "file_id", "name", "mime"]) {
      if (raw[key] !== undefined && raw[key] !== null && typeof raw[key] !== "string") {
        throw badRequest(`${tag}.${key} 必须是字符串`);
      }
    }
    let uri = String(raw.uri ?? "").trim();
    const fileId = String(raw.file_id ?? "").trim();
    if (fileId) {
      if (!FILE_ID_RE.test(fileId)) throw badRequest(`${tag}.file_id 格式不合法`);
      const fromId = `${HUB_FILE_URI_PREFIX}${fileId}`;
      if (uri && uri !== fromId) throw badRequest(`${tag} 的 uri 与 file_id 不一致`);
      uri = fromId;
    }
    if (!uri) throw badRequest(`${tag} 需要 uri 或 file_id`);
    if (uri.length > MAX_ATTACHMENT_URI_LENGTH) {
      throw badRequest(`${tag}.uri 超过 ${MAX_ATTACHMENT_URI_LENGTH} 字符`);
    }

    let meta = null;
    let defaultName = "";
    if (uri.startsWith(HUB_FILE_URI_PREFIX)) {
      const id = parseHubFileUri(uri);
      if (!id) throw badRequest(`${tag}.uri 不是合法的 hub 文件地址`);
      if (fileStore) {
        meta = fileStore.get(id);
        if (!meta) throw badRequest(`${tag} 引用的文件不存在：${uri}`);
        if (meta.deleted_at) throw badRequest(`${tag} 引用的文件已过期清理：${uri}`);
      }
      defaultName = meta?.name ?? "";
    } else {
      let url;
      try { url = new URL(uri); } catch { throw badRequest(`${tag}.uri 不是合法的 URL`); }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw badRequest(`${tag}.uri 只允许 hub://、http:// 或 https://`);
      }
      if (url.username || url.password) throw badRequest(`${tag}.uri 不能带用户名或密码`);
      defaultName = nameFromUrl(url);
    }
    const name = sanitizeFileName(raw.name || defaultName, "file");
    const mime = normalizeMime(raw.mime || meta?.mime);
    out.push({ uri, name, mime });
  });
  return out;
}

// 按传入顺序从 startSeq 起追加 file Part。返回下一个可用 Seq。
// skipExisting 给可重试的提交计划用：已按 Part_ID 落地的块跳过，避免补齐时重复插入。
export async function appendFileParts(bus, parentId, startSeq, attachments, clientTokens = [], {
  parentType = "message", skipExisting = false,
} = {}) {
  let seq = Number(startSeq) || 1;
  if (!attachments?.length) return seq;
  let have = null;
  if (skipExisting) {
    have = new Set((await bus.listRecords(bus.tables.parts)).map((p) => String(f1(p, "Part_ID") ?? "")));
  }
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const partId = `${parentId}-P${seq}`;
    if (!have?.has(partId)) {
      await bus.createRecord(bus.tables.parts, {
        Part_ID: partId,
        Parent_ID: parentId,
        Parent_Type: parentType,
        Seq: seq,
        Kind: "file",
        File_URI: att.uri,
        File_Name: att.name,
        Mime_Type: att.mime || "application/octet-stream",
      }, clientTokens?.[i] || undefined);
    }
    seq += 1;
  }
  return seq;
}

// 一条附件在网关 / 详情里的统一形状。hub:// 的下载地址指向中台文件接口，外部 URL 原样，
// 其余（历史遗留的本地路径等）没有可下载地址，给 null。
export function downloadUrlOf(uri, hubUrl = "") {
  const id = parseHubFileUri(uri);
  if (id) return `${String(hubUrl ?? "").replace(/\/+$/, "")}/api/v1/files/${id}`;
  if (/^https?:\/\//i.test(String(uri ?? ""))) return String(uri);
  return null;
}

// parts 是总线行（任意 Parent）。只取 Kind=file，按 Seq 排序。
export function attachmentsView(parts, hubUrl = "", fileStore = null) {
  const files = (parts ?? [])
    .filter((p) => f1(p, "Kind") === "file")
    .slice()
    .sort((a, b) => (Number(f1(a, "Seq")) || 0) - (Number(f1(b, "Seq")) || 0));
  return files.map((p) => {
    const uri = String(f1(p, "File_URI") ?? "");
    const id = parseHubFileUri(uri);
    let meta = null;
    if (id && fileStore) {
      try { meta = fileStore.get(id); } catch { meta = null; }
    }
    return {
      file_uri: uri,
      file_name: f1(p, "File_Name"),
      mime_type: f1(p, "Mime_Type"),
      download_url: downloadUrlOf(uri, hubUrl),
      size: meta ? Number(meta.size) : null,
      deleted: Boolean(meta?.deleted_at),
    };
  });
}

// ---- 本地产物：待上传条目 ----

const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

// 返回本地存在的普通文件绝对路径，否则 null。
// 相对路径依次按执行 cwd、runs 目录找，与执行方「在自己的工作目录里写下相对路径」的习惯一致。
export function resolveLocalFile(src, baseDirs = []) {
  let raw = String(src ?? "").trim();
  if (!raw) return null;
  if (/^file:\/\//i.test(raw)) {
    try { raw = fileURLToPath(raw); } catch { return null; }
  } else if (URI_SCHEME_RE.test(raw)) {
    return null; // hub:// 与 http(s):// 不是本地文件
  }
  const candidates = path.isAbsolute(raw)
    ? [raw]
    : baseDirs.filter(Boolean).map((dir) => path.resolve(dir, raw));
  for (const cand of candidates) {
    try {
      if (fs.statSync(cand).isFile()) return cand;
    } catch { /* 找下一个候选 */ }
  }
  return null;
}

// 把一个交付项（字符串或 {uri,name,mime}）变成计划里的条目。
// 本地存在的文件记 upload_pending，由提交阶段上传；其余原样保留（兼容旧行为）。
export function planArtifactItem(entry, baseDirs = [], detectLocal = true) {
  const obj = typeof entry === "string" ? { uri: entry } : { ...(entry ?? {}) };
  const src = String(obj.uri ?? "").trim();
  const item = { src, uri: src, name: String(obj.name ?? ""), mime: String(obj.mime ?? "") };
  // 中台网关替远端 Agent 提交时，Agent 报的路径在中台机器上没有意义，不探测本地文件。
  const local = detectLocal ? resolveLocalFile(src, baseDirs) : null;
  if (local) {
    item.local_path = local;
    item.uri = "";
    item.upload_pending = true;
  }
  return item;
}

// 逐项上传缺 uri 的条目，每成功一项就 save()（把结果写回 outbox 文件），下一轮只补缺。
// tooLarge: "keep" 保留原字符串并记 note（交付产物，不能让任务卡死）；"throw" 直接抛（用户显式 --file）。
// 其它错误一律抛出，条目保持 upload_pending。
export async function uploadPendingItems(items, { getClient, save = () => {}, log = () => {}, tooLarge = "keep" } = {}) {
  for (const item of items) {
    if (!item?.upload_pending) continue;
    const client = typeof getClient === "function" ? getClient() : getClient;
    if (!client) {
      // 用户显式 --file 的文件没有客户端就无法交付；交付产物退回旧行为，保留原字符串。
      if (tooLarge === "throw") throw new Error(`没有可用的文件客户端，无法上传 ${item.src}`);
      item.uri = item.src;
      item.upload_pending = false;
      save();
      continue;
    }
    try {
      const meta = await client.upload(item.local_path, {
        ...(item.name ? { name: item.name } : {}),
        // 自定义显示名可能没有扩展名，MIME 以本地文件本身的扩展名为准。
        mime: item.mime || guessMime(item.local_path),
      });
      item.uri = meta.uri;
      item.name = item.name || meta.name;
      item.mime = item.mime || meta.mime;
      item.upload_pending = false;
      save();
    } catch (err) {
      if (Number(err?.status) === 413 && tooLarge === "keep") {
        log(`产物超过大小上限，保留原路径 ${item.src}`);
        item.uri = item.src;
        item.upload_pending = false;
        item.note = `产物 ${path.basename(item.src)} 超过大小上限，未上传，仍保留原路径 ${item.src}`;
        save();
        continue;
      }
      throw err;
    }
  }
}

// 按本地路径上传一批 --file，返回 [{ uri, name, mime }]。文件不存在直接抛错。
export async function uploadLocalFiles(paths, fileClient) {
  const out = [];
  for (const p of paths ?? []) {
    const abs = path.resolve(String(p));
    let st;
    try { st = fs.statSync(abs); } catch { throw new Error(`文件不存在：${p}`); }
    if (!st.isFile()) throw new Error(`不是普通文件：${p}`);
    const meta = await fileClient.upload(abs, {});
    out.push({ uri: meta.uri, name: meta.name, mime: meta.mime });
  }
  return out;
}
