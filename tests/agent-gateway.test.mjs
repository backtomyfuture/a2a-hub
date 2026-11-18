// 外部 HTTP Agent 统一网关集成测试（Muse / Grok Bot 等云端与无守护进程 Agent）。
// 覆盖：
// 1. /.well-known/agent.json 免鉴权探索发现与 Bearer Auth 保护；
// 2. Muse (Leader, role="leader") 与 Grok Bot (Worker, http-poll) 注册及 Web 状态/节点面板可见性；
// 3. Leader 派单 -> Worker 短轮询取单 -> claim -> heartbeat -> ask (input-required)
//    -> Leader /updates 感知并 /reply -> Worker 恢复执行 -> complete（附带 acceptance checks 与 artifact）；
// 4. 长轮询 (?timeout=5) 阻塞挂起与建单毫秒级唤醒 + 发起方取消越权拦截与正常取消；
// 5. 认领前前置审批 (approval="approve") 与执行中动态 /auth 挂起 + ed25519 签名审批放行。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadOrCreateHubKey } from "../src/approval-sign.mjs";
import { SqliteBus } from "../src/bus/sqlite-bus.mjs";
import { DEFAULT_TABLES } from "../src/bus/tables.mjs";
import { ApprovalService } from "../src/hub/approval.mjs";
import { startHubHttpServer } from "../src/server/http-server.mjs";
import { LongPollBroker } from "../src/server/longpoll-broker.mjs";
import { withTemp } from "./helpers.mjs";

async function apiJson(baseUrl, pathname, { method = "GET", token = "", body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

test("HTTP Agent 网关：发现 / 注册 / 问答闭环 / 长轮询 / ed25519 审批", async () => {
  await withTemp(async (rootDir) => {
    const hubDir = path.join(rootDir, "hub");
    fs.mkdirSync(hubDir, { recursive: true });

    const apiToken = "gw-secret-token";
    const key = loadOrCreateHubKey(hubDir);
    const broker = new LongPollBroker({ initialSeq: 0 });
    const bus = new SqliteBus({
      dbPath: path.join(hubDir, "hub.db"),
      tables: DEFAULT_TABLES,
      broker,
    });
    const approval = new ApprovalService({
      bus,
      ownerId: "",
      allowLocalOwner: true,
      statePath: path.join(hubDir, "approval_state.json"),
      signKey: key.privateKey,
      log: () => {},
    });

    const httpHandle = await startHubHttpServer({
      cfg: {
        node: "mac-mini-hub",
        nodeDesc: "Mac Mini 中台",
        configDir: hubDir,
        listen: "127.0.0.1:0",
        apiToken,
        hubPublicKey: key.publicKey,
      },
      bus,
      broker,
      approval,
      log: () => {},
      onWake: () => {},
    });

    const baseUrl = httpHandle.localUrl;

    try {
      // 1. /.well-known/agent.json 免鉴权探索；/api/v1/agents 与 /api/v1/skills 无 token 被拒
      const disc = await apiJson(baseUrl, "/.well-known/agent.json");
      assert.equal(disc.status, 200);
      assert.equal(disc.data.protocol, "a2a-hub-http/v1");
      assert.equal(disc.data.authentication.type, "bearer");
      assert.equal(disc.data.endpoints.poll, "/api/v1/agents/{node}/poll");
      assert.equal(disc.data.endpoints.skills, "/api/v1/skills/{name}");

      const unauth = await apiJson(baseUrl, "/api/v1/agents");
      assert.equal(unauth.status, 401);
      const unauthSkills = await apiJson(baseUrl, "/api/v1/skills");
      assert.equal(unauthSkills.status, 401);

      // 1.5 四类 Skill 目录查询与按白名单拉取（拦截未知与路径穿越）
      const skillsList = await apiJson(baseUrl, "/api/v1/skills", { token: apiToken });
      assert.equal(skillsList.status, 200);
      assert.deepEqual(
        skillsList.data.skills.map((s) => s.name),
        ["ah", "ah-inbox", "a2a-leader", "a2a-worker"],
      );
      for (const name of ["a2a-leader", "a2a-worker"]) {
        const res = await apiJson(baseUrl, `/api/v1/skills/${name}`, { token: apiToken });
        assert.equal(res.status, 200);
        assert.equal(res.data.name, name);
        assert.equal(res.data.mode, "http");
        assert.equal(
          res.data.content,
          fs.readFileSync(path.resolve("skills", name, "SKILL.md"), "utf8"),
        );
      }
      const badSkill = await apiJson(baseUrl, "/api/v1/skills/unknown-skill", { token: apiToken });
      assert.equal(badSkill.status, 404);
      const traversalSkill = await apiJson(baseUrl, "/api/v1/skills/..%2Fpackage.json", { token: apiToken });
      assert.equal(traversalSkill.status, 404);

      // 2. 注册 Muse (Leader) 与 Grok Bot (Worker)
      const regMuse = await apiJson(baseUrl, "/api/v1/agents/register", {
        method: "POST",
        token: apiToken,
        body: {
          node: "muse",
          role: "leader",
          kind: "agent",
          receive_mode: "http-poll",
          node_desc: "Muse 调度 Agent",
        },
      });
      assert.equal(regMuse.status, 200);
      assert.equal(regMuse.data.role, "leader");
      assert.equal(regMuse.data.cards.length, 0);

      const regGrok = await apiJson(baseUrl, "/api/v1/agents/register", {
        method: "POST",
        token: apiToken,
        body: {
          node: "grok-bot",
          role: "worker",
          kind: "agent",
          receive_mode: "http-poll",
          node_desc: "云端 Grok 搜索执行器",
          caps: [
            {
              skill_id: "research",
              skill_name: "Grok Deep Search",
              description: "实时网页检索与报告整理",
              side_effect: "read",
            },
          ],
        },
      });
      assert.equal(regGrok.status, 200);
      assert.equal(regGrok.data.cards.length, 1);
      assert.equal(regGrok.data.pending, true);
      assert.equal(regGrok.data.admission["CAP-grok-bot-research"], "pending");

      const admitGrok = await apiJson(baseUrl, "/api/v1/admin/nodes/grok-bot/admission", {
        method: "POST",
        token: apiToken,
        body: { admission: "admitted" },
      });
      assert.equal(admitGrok.status, 200);
      assert.equal(admitGrok.data.updated, 1);

      const agentsRes = await apiJson(baseUrl, "/api/v1/agents", { token: apiToken });
      assert.equal(agentsRes.status, 200);
      const byNode = new Map(agentsRes.data.agents.map((a) => [a.node, a]));
      assert.equal(byNode.get("muse")?.role, "leader");
      assert.equal(byNode.get("muse")?.kind, "agent");
      assert.equal(byNode.get("grok-bot")?.caps.length, 1);
      assert.equal(byNode.get("grok-bot")?.caps[0].skill_id, "research");
      assert.equal(byNode.get("grok-bot")?.caps[0].admission, "admitted");

      // Web 控制台主页可正常返回更新后的提示文案
      const htmlRes = await fetch(`${baseUrl}/`);
      assert.equal(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.match(html, /在线节点与外部 Agent 连接/);
      assert.match(html, /纯协调者 \/ 外部 HTTP Agent/);
      assert.match(html, /GET \/api\/v1\/skills/);
      assert.match(html, /· ah（/);
      assert.match(html, /ah-inbox/);
      assert.match(html, /a2a-leader/);
      assert.match(html, /a2a-worker/);

      // 3. Muse 派单 -> Grok Bot 短轮询 -> claim -> heartbeat -> ask -> Muse /reply -> complete
      const createRes = await apiJson(baseUrl, "/api/v1/tasks", {
        method: "POST",
        token: apiToken,
        body: {
          from: "muse",
          to: "grok-bot",
          cap: "research",
          text: "总结 A2A 与 MCP 协同定位",
          criteria: [
            { id: "c1", text: "给出协议边界对比", verify: "agent" },
            { id: "c2", text: "提供交付文档链接", verify: "agent" },
          ],
        },
      });
      assert.equal(createRes.status, 201);
      const taskId = createRes.data.task_id;
      assert.ok(taskId);

      const grokPoll1 = await apiJson(baseUrl, "/api/v1/agents/grok-bot/poll", { token: apiToken });
      assert.equal(grokPoll1.status, 200);
      assert.equal(grokPoll1.data.count, 1);
      assert.equal(grokPoll1.data.tasks[0].task_id, taskId);
      assert.equal(grokPoll1.data.tasks[0].action, "execute");
      assert.equal(grokPoll1.data.tasks[0].from_node, "muse");

      const claim1 = await apiJson(baseUrl, `/api/v1/tasks/${taskId}/claim`, {
        method: "POST",
        token: apiToken,
        body: { node: "grok-bot", worker: "grok-4" },
      });
      assert.equal(claim1.status, 200);
      assert.equal(claim1.data.status, "working");
      assert.equal(claim1.data.criteria.length, 2);

      // 其它节点越权 claim 返回 403
      const hijack = await apiJson(baseUrl, `/api/v1/tasks/${taskId}/claim`, {
        method: "POST",
        token: apiToken,
        body: { node: "evil-bot" },
      });
      assert.equal(hijack.status, 403);

      const hb = await apiJson(baseUrl, `/api/v1/tasks/${taskId}/heartbeat`, {
        method: "POST",
        token: apiToken,
        body: { node: "grok-bot", text: "已完成资料采集，准备聚焦范围" },
      });
      assert.equal(hb.status, 200);
      assert.equal(hb.data.ok, true);

      const ask = await apiJson(baseUrl, `/api/v1/tasks/${taskId}/ask`, {
        method: "POST",
        token: apiToken,
        body: { node: "grok-bot", text: "报告需要面向架构师还是普通用户？" },
      });
      assert.equal(ask.status, 200);
      assert.equal(ask.data.status, "input-required");

      // Muse 通过 /updates 看到 input-required 问题，并从 API 回复
      const museUpd1 = await apiJson(baseUrl, "/api/v1/agents/muse/updates", { token: apiToken });
      assert.equal(museUpd1.status, 200);
      assert.equal(museUpd1.data.updates.length, 1);
      assert.equal(museUpd1.data.updates[0].status, "input-required");
      assert.match(museUpd1.data.updates[0].question_text, /架构师/);

      const replyRes = await apiJson(baseUrl, `/api/v1/tasks/${taskId}/reply`, {
        method: "POST",
        token: apiToken,
        body: { from: "muse", text: "面向架构师，重点讲网关与长轮询" },
      });
      assert.equal(replyRes.status, 200);

      // Grok Bot 再次 poll 拿到 resume 语义及 Muse 的答复
      const grokPoll2 = await apiJson(baseUrl, "/api/v1/agents/grok-bot/poll", { token: apiToken });
      assert.equal(grokPoll2.status, 200);
      assert.equal(grokPoll2.data.count, 1);
      assert.equal(grokPoll2.data.tasks[0].action, "resume");
      assert.equal(grokPoll2.data.tasks[0].resume_reason, "answer");
      assert.equal(grokPoll2.data.tasks[0].answers[0].from_node, "muse");

      const claim2 = await apiJson(baseUrl, `/api/v1/tasks/${taskId}/claim`, {
        method: "POST",
        token: apiToken,
        body: { node: "grok-bot" },
      });
      assert.equal(claim2.status, 200);
      assert.equal(claim2.data.action, "resume");

      const completeRes = await apiJson(baseUrl, `/api/v1/tasks/${taskId}/complete`, {
        method: "POST",
        token: apiToken,
        body: {
          node: "grok-bot",
          text: "已完成 A2A 与 MCP 架构协同报告",
          artifact: "https://example.com/a2a-mcp-report.md",
          checks: {
            c1: { verdict: "pass", evidence: "梳理了消息与工具平面边界" },
            c2: { verdict: "pass", evidence: "已附在线报告链接" },
          },
        },
      });
      assert.equal(completeRes.status, 200);
      assert.equal(completeRes.data.status, "completed");

      const museUpd2 = await apiJson(baseUrl, "/api/v1/agents/muse/updates?status=completed", { token: apiToken });
      assert.equal(museUpd2.status, 200);
      const doneTask = museUpd2.data.updates.find((t) => t.task_id === taskId);
      assert.ok(doneTask);
      assert.equal(doneTask.acceptance.overall, "pass");
      assert.equal(doneTask.artifacts.length, 1);

      // 4. 外部 HTTP Agent 长轮询唤醒 + 发起方取消
      const idlePoll = await apiJson(baseUrl, "/api/v1/agents/grok-bot/poll", { token: apiToken });
      assert.equal(idlePoll.data.count, 0);
      const cursor = idlePoll.data.seq;
      const hangPollPromise = apiJson(
        baseUrl,
        `/api/v1/agents/grok-bot/poll?timeout=5&cursor=${cursor}`,
        { token: apiToken },
      );
      await new Promise((r) => setTimeout(r, 60));

      const t2Create = await apiJson(baseUrl, "/api/v1/tasks", {
        method: "POST",
        token: apiToken,
        body: { from: "muse", to: "grok-bot", cap: "research", text: "测试长轮询即时唤醒" },
      });
      assert.equal(t2Create.status, 201);
      const t2 = t2Create.data.task_id;

      const hangRes = await hangPollPromise;
      assert.equal(hangRes.status, 200);
      assert.equal(hangRes.data.wake, true);
      assert.equal(hangRes.data.tasks.some((t) => t.task_id === t2), true);

      // 非发起方 (grok-bot) 不可伪装取消 Muse 发起的任务；Muse 本人可以取消
      const badCancel = await apiJson(baseUrl, `/api/v1/tasks/${t2}/cancel`, {
        method: "POST",
        token: apiToken,
        body: { from: "grok-bot", text: "越权取消" },
      });
      assert.equal(badCancel.status, 400);

      const goodCancel = await apiJson(baseUrl, `/api/v1/tasks/${t2}/cancel`, {
        method: "POST",
        token: apiToken,
        body: { from: "muse", text: "需求取消" },
      });
      assert.equal(goodCancel.status, 200);

      // 5. 认领前审批 (approval="approve") + 执行中动态 /auth + ed25519 签名放行
      const preCreate = await apiJson(baseUrl, "/api/v1/tasks", {
        method: "POST",
        token: apiToken,
        body: {
          from: "muse",
          to: "grok-bot",
          cap: "research",
          approval: "approve",
          text: "高风险外部发布任务",
        },
      });
      assert.equal(preCreate.status, 201);
      const preTaskId = preCreate.data.task_id;

      // poll 触发认领前 auth_request，任务置为 auth-required 且不下发给 Worker
      const prePoll = await apiJson(baseUrl, "/api/v1/agents/grok-bot/poll", { token: apiToken });
      assert.equal(prePoll.status, 200);
      assert.equal(prePoll.data.tasks.some((t) => t.task_id === preTaskId), false);

      const directClaimBlocked = await apiJson(baseUrl, `/api/v1/tasks/${preTaskId}/claim`, {
        method: "POST",
        token: apiToken,
        body: { node: "grok-bot" },
      });
      assert.equal(directClaimBlocked.status, 409);

      // 机主通过 Web 端接口做 ed25519 签名批准
      const decide1 = await apiJson(baseUrl, `/api/v1/approvals/${preTaskId}/decide`, {
        method: "POST",
        token: apiToken,
        body: { decision: "approve", comment: "同意认领" },
      });
      assert.equal(decide1.status, 200);

      const postApprovePoll = await apiJson(baseUrl, "/api/v1/agents/grok-bot/poll", { token: apiToken });
      assert.equal(postApprovePoll.status, 200);
      assert.equal(postApprovePoll.data.tasks.some((t) => t.task_id === preTaskId && t.action === "execute"), true);

      const claimPre = await apiJson(baseUrl, `/api/v1/tasks/${preTaskId}/claim`, {
        method: "POST",
        token: apiToken,
        body: { node: "grok-bot" },
      });
      assert.equal(claimPre.status, 200);
      assert.equal(claimPre.data.status, "working");

      // 执行过程中动态申请高危二次确认
      const dynAuth = await apiJson(baseUrl, `/api/v1/tasks/${preTaskId}/auth`, {
        method: "POST",
        token: apiToken,
        body: { node: "grok-bot", text: "准备清理线上缓存，请再次批准" },
      });
      assert.equal(dynAuth.status, 200);
      assert.equal(dynAuth.data.status, "auth-required");

      const decide2 = await apiJson(baseUrl, `/api/v1/approvals/${preTaskId}/decide`, {
        method: "POST",
        token: apiToken,
        body: { decision: "approve", comment: "准许清理" },
      });
      assert.equal(decide2.status, 200);

      const dynPoll = await apiJson(baseUrl, "/api/v1/agents/grok-bot/poll", { token: apiToken });
      assert.equal(dynPoll.status, 200);
      const resumedItem = dynPoll.data.tasks.find((t) => t.task_id === preTaskId);
      assert.ok(resumedItem);
      assert.equal(resumedItem.action, "resume");
      assert.equal(resumedItem.resume_reason, "auth_decision");
      assert.equal(resumedItem.decision, "approve");

      const claimDyn = await apiJson(baseUrl, `/api/v1/tasks/${preTaskId}/claim`, {
        method: "POST",
        token: apiToken,
        body: { node: "grok-bot" },
      });
      assert.equal(claimDyn.status, 200);

      const doneDyn = await apiJson(baseUrl, `/api/v1/tasks/${preTaskId}/complete`, {
        method: "POST",
        token: apiToken,
        body: { node: "grok-bot", text: "二次确认后已完成清理" },
      });
      assert.equal(doneDyn.status, 200);
      assert.equal(doneDyn.data.status, "completed");

      // 查询筛选列表确认两个完成和一个取消任务
      const listRes = await apiJson(baseUrl, "/api/v1/tasks?from=muse", { token: apiToken });
      assert.equal(listRes.status, 200);
      assert.equal(listRes.data.count, 3);
    } finally {
      await httpHandle.close();
      bus.close();
    }
  });
});
