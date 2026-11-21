// busType=agent 的 inbox / task CLI。文件先上传成 hub://，再走 Agent Gateway，不写总线表。
// 本地收件箱状态在 Hub 接受回执之后才改，避免请求失败时把条目标成已处理。

import { uploadLocalFiles } from "./attachments.mjs";
import { createFileClient } from "./files-client.mjs";
import { parseHubFileUri } from "./hub/files.mjs";
import { markInboxStatus } from "./inbox.mjs";

function asFileRefs(uploaded) {
  return (uploaded ?? []).map((item) => {
    const id = parseHubFileUri(item.uri);
    if (id) return { file_id: id, name: item.name, mime: item.mime };
    return { uri: item.uri, name: item.name, mime: item.mime };
  });
}

async function withFiles(cfg, fn) {
  const client = createFileClient(cfg);
  try {
    return await fn(client);
  } finally {
    client.close?.();
  }
}

export async function agentInboxCommand(cfg, { op, taskId, text = "", files = [], checks } = {}) {
  const gateway = cfg.agentClient;
  if (!gateway) throw new Error("busType=agent 缺少 agentClient");
  return withFiles(cfg, async (fileClient) => {
    if (op === "done") {
      const artifacts = files.length ? asFileRefs(await uploadLocalFiles(files, fileClient)) : undefined;
      const res = await gateway.complete(taskId, { text, artifacts, checks });
      markInboxStatus(cfg.configDir, taskId, "done", res?.msg_id ? { status_msg: res.msg_id } : {});
      return res;
    }
    if (op === "ask") {
      const attachments = files.length ? asFileRefs(await uploadLocalFiles(files, fileClient)) : undefined;
      const res = await gateway.ask(taskId, { text, attachments });
      markInboxStatus(cfg.configDir, taskId, "waiting-answer", res?.msg_id ? { status_msg: res.msg_id } : {});
      return res;
    }
    if (op === "auth") {
      const attachments = files.length ? asFileRefs(await uploadLocalFiles(files, fileClient)) : undefined;
      const res = await gateway.auth(taskId, { text, attachments });
      markInboxStatus(cfg.configDir, taskId, "waiting-auth", res?.msg_id ? { status_msg: res.msg_id } : {});
      return res;
    }
    if (op === "fail") {
      const artifacts = files.length ? asFileRefs(await uploadLocalFiles(files, fileClient)) : undefined;
      const res = await gateway.fail(taskId, { text, artifacts });
      markInboxStatus(cfg.configDir, taskId, "failed", res?.msg_id ? { status_msg: res.msg_id } : {});
      return res;
    }
    throw new Error(`未知的 inbox 操作：${op}`);
  });
}

export async function agentTaskCreate(cfg, args, { params, criteria } = {}) {
  const gateway = cfg.agentClient;
  if (!gateway) throw new Error("busType=agent 缺少 agentClient");
  return withFiles(cfg, async (fileClient) => {
    const attachments = args.files?.length ? asFileRefs(await uploadLocalFiles(args.files, fileClient)) : undefined;
    const res = await gateway.createTask({
      from: args.from || cfg.node,
      source: args.source || args.from || cfg.node,
      to: args.to,
      cap: args.cap,
      worker: args.worker,
      requested_model: args.requested_model,
      text: args.text,
      params,
      criteria,
      context: args.context,
      ref: args.ref,
      approval: args.approval,
      idempotencyKey: args.idempotencyKey,
      attachments,
    });
    return res?.task_id || res?.taskId;
  });
}

export async function agentTaskReply(cfg, { taskId, text, files = [] } = {}) {
  const gateway = cfg.agentClient;
  if (!gateway) throw new Error("busType=agent 缺少 agentClient");
  return withFiles(cfg, async (fileClient) => {
    const attachments = files.length ? asFileRefs(await uploadLocalFiles(files, fileClient)) : undefined;
    return gateway.replyTask(taskId, { from: cfg.node, text, attachments });
  });
}

export async function agentTaskShow(cfg, taskId) {
  const data = await cfg.agentClient.getTask(taskId);
  const task = data?.task ?? {};
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const last = messages.length ? messages[messages.length - 1] : null;
  const lastText = last
    ? (last.parts ?? []).filter((p) => p.kind === "text").map((p) => p.text).filter(Boolean).join("\n")
    : "";
  return {
    task_id: task.task_id || taskId,
    title: task.title,
    status: task.status,
    skill_id: task.skill_id,
    target_node: task.target_node,
    source: task.source,
    status_msg: task.status_msg,
    retry_count: task.retry_count,
    claimed_by: task.claimed_by,
    last_message: last ? {
      msg_id: last.msg_id,
      kind: last.kind,
      from: last.from_node,
      to: last.to_node,
      role: last.role,
      text: lastText,
    } : null,
    artifacts: (data?.artifacts ?? []).map((a) => ({
      artifact_id: a.artifact_id,
      name: a.name,
      description: a.description,
    })),
  };
}

export async function agentTaskCancel(cfg, { taskId, text } = {}) {
  return cfg.agentClient.cancelTask(taskId, { from: cfg.node, text });
}
