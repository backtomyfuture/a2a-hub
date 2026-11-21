// herdr 多 Agent 并发与热驻留编排。方法挂到 Kernel.prototype，this 仍是内核实例。
import fs from "node:fs";
import path from "node:path";
import {
  buildAcceptance,
  clampVerifyTimeout,
  judgeChecks,
  parseCriteria,
  verifyEvidenceTail,
  verifyVerdict,
} from "./acceptance.mjs";
import { f1 } from "./bus/tables.mjs";
import { clampTimeoutSec, inferHerdrKind } from "./config.mjs";
import {
  atomicWriteFile,
  buildPointerPrompt,
  checkResultGate,
  deleteHerdrLedger,
  createHerdrRuntime,
  herdrLedgerPath,
  herdrReceiptPath,
  listHerdrLedgers,
  newAttemptId,
  readHerdrLedger,
  saveHerdrLedger,
  writeAttemptEnvelope,
} from "./herdr-runner.mjs";
import { TERMINAL_STATUSES, clipText, heartbeatFields, log, nowStr } from "./kernel-util.mjs";
import { appendQueueItem, popQueue } from "./present-queue.mjs";
import { InvalidReceipt, NeedAuth, NeedInput } from "./receipt.mjs";
import { writeHerdrBinding } from "./session-store.mjs";

const MAX_RETRIES = 2;
const MAX_GATE_REPAIRS = 2;
const ACTIVE_TASK_STATUSES = new Set(["working", "input-required", "auth-required"]);

function unlinkQuiet(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch { /* 不存在时忽略 */ }
}

export const herdrMethods = {

  usesHerdr(entry) {
    return (entry?.context ?? "direct") === "herdr";
  },

  herdrMaxConcurrent() {
    const n = Number(this.cfg?.maxConcurrent);
    return Number.isInteger(n) && n >= 1 ? n : 4;
  },

  herdrRuntime() {
    if (!this._herdrRuntime) {
      this._herdrRuntime = createHerdrRuntime(this.cfg, { log: (line) => log(line) });
      this._herdrRuntime.on("binding_changed", (binding) => this.onHerdrBindingChanged(binding));
      this._herdrRuntimeReady = this._herdrRuntime.start();
    }
    return this._herdrRuntime;
  },

  async ensureHerdrRuntime() {
    const rt = this.herdrRuntime();
    await this._herdrRuntimeReady;
    return rt;
  },

  _herdrHolds(taskId) {
    if (this._herdrFlights?.has(taskId)) return true;
    const ledger = readHerdrLedger(this.cfg.configDir, taskId);
    return Boolean(ledger && ledger.state !== "exited");
  },

  // 统计当前占槽数量：working 任务 + input-required/auth-required 且 Pane 仍驻留的任务。
  activeHerdrCount(tasksSnapshot = null) {
    const statusMap = new Map();
    if (Array.isArray(tasksSnapshot)) {
      for (const t of tasksSnapshot) {
        const tid = String(f1(t, "Task_ID") ?? "");
        if (tid) statusMap.set(tid, String(f1(t, "Status") ?? ""));
      }
    }
    const held = new Set();
    if (this._herdrFlights) {
      for (const [taskId, flight] of this._herdrFlights.entries()) {
        if (flight.state !== "working" && flight.state !== "parked") continue;
        if (statusMap.size > 0 && statusMap.has(taskId) && !ACTIVE_TASK_STATUSES.has(statusMap.get(taskId))) {
          continue;
        }
        held.add(taskId);
      }
    }
    for (const { taskId, ledger } of listHerdrLedgers(this.cfg.configDir)) {
      if (held.has(taskId)) continue;
      if (ledger.broken || ledger.state === "exited") continue;
      if (statusMap.size > 0 && statusMap.has(taskId) && !ACTIVE_TASK_STATUSES.has(statusMap.get(taskId))) {
        continue;
      }
      held.add(taskId);
    }
    return held.size;
  },

  // 已占着槽位的驻留任务（热续接）不被 maxConcurrent 挡住。
  herdrSlotAvailable(taskId = "", tasksSnapshot = null) {
    if (taskId && this._herdrFlights?.has(taskId)) return true;
    if (taskId) {
      const ledger = readHerdrLedger(this.cfg.configDir, taskId);
      if (ledger && !ledger.broken && ledger.state !== "exited") return true;
    }
    return this.activeHerdrCount(tasksSnapshot) < this.herdrMaxConcurrent();
  },

  hasWorkingHerdrFlight() {
    if (!this._herdrFlights) return false;
    for (const flight of this._herdrFlights.values()) {
      if (flight.state === "working") return true;
    }
    return false;
  },

  waitHerdrInFlight() {
    if (!this.hasWorkingHerdrFlight() || this._wakeFlag || this._stopping) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 50);
      timer.unref?.();
      for (const flight of this._herdrFlights.values()) {
        if (flight.state !== "working") continue;
        const prev = flight.waiter;
        flight.waiter = () => {
          prev?.();
          finish();
        };
      }
    });
  },

  stopHerdrTimers() {
    if (this._herdrFlights) {
      for (const flight of this._herdrFlights.values()) {
        flight.finishing = true;
        if (flight.hbTimer) clearInterval(flight.hbTimer);
        if (flight.timeoutTimer) clearTimeout(flight.timeoutTimer);
        flight.hbTimer = null;
        flight.timeoutTimer = null;
        const waiter = flight.waiter;
        if (waiter) {
          flight.waiter = null;
          waiter();
        }
      }
    }
    try { this._herdrRuntime?.stop(); } catch { /* 运行时可能还没连上 */ }
    this._herdrRuntime = null;
    this._herdrRuntimeReady = null;
  },

  herdrFlightFrom(task, ledger, mode = "agent") {
    return {
      taskId: f1(task, "Task_ID") || ledger.task_id,
      recordId: task.record_id,
      agentName: ledger.agent_name,
      kind: ledger.kind,
      workspaceId: ledger.workspace_id || "",
      tabId: ledger.tab_id || "",
      paneId: ledger.pane_id || "",
      runId: ledger.run_id || "",
      mode,
      started: ledger.started_at || nowStr(),
      startedMs: Number(ledger.started_ms) || Date.now(),
      timeoutSec: Number(ledger.timeout_sec) || 600,
      receiptPath: ledger.receipt_path || herdrReceiptPath(this.cfg.configDir, f1(task, "Task_ID") || ledger.task_id),
      inputPath: ledger.input_path || "",
      state: ledger.state === "parked" ? "parked" : "working",
      blocked: Boolean(ledger.blocked),
      turnCount: Number(ledger.turn_count) || 1,
      seenWorking: Boolean(ledger.seen_working),
      promptSeq: Number.isFinite(Number(ledger.prompt_seq)) ? Number(ledger.prompt_seq) : -1,
      promptSentMs: Number(ledger.prompt_sent_ms) || Number(ledger.started_ms) || Date.now(),
      attemptId: ledger.attempt_id || "",
      attemptNo: Number(ledger.attempt_no) || 1,
      resultPath: ledger.result_path || "",
      envelopePath: ledger.envelope_path || "",
      worktreePath: ledger.worktree_path || "",
      repairs: Number(ledger.repairs) || 0,
      repairing: false,
      pendingPrompt: false,
      idleStrikes: 0,
      nudgedEnter: false,
      hbTimer: null,
      timeoutTimer: null,
      heartbeat: null,
      finishing: false,
      watching: false,
      waiter: null,
    };
  },

  startHerdrHeartbeat(flight) {
    if (flight.hbTimer) clearInterval(flight.hbTimer);
    flight.finishing = false;
    flight.hbTimer = setInterval(() => {
      if (flight.finishing || flight.state !== "working" || flight.heartbeat || this._sweepBusy) return;
      flight.heartbeat = (async () => {
        if (flight.finishing || flight.state !== "working" || this._sweepBusy) return;
        const row = await this.bus.getRecord(this.T.tasks, flight.recordId);
        if (!row || f1(row, "Status") !== "working" || f1(row, "Claimed_By") !== this.cfg.node) {
          flight.finishing = true;
          if (flight.hbTimer) clearInterval(flight.hbTimer);
          flight.hbTimer = null;
          return;
        }
        if (flight.finishing || this._sweepBusy) return;
        await this.bus.updateRecord(this.T.tasks, flight.recordId, heartbeatFields(f1(row, "Metadata")));
      })().catch((e) => log("herdr heartbeat failed: " + (e?.message ?? e)))
        .finally(() => { flight.heartbeat = null; });
    }, 60_000);
    flight.hbTimer.unref?.();
  },

  async stopHerdrHeartbeat(flight) {
    if (!flight) return;
    flight.finishing = true;
    if (flight.hbTimer) clearInterval(flight.hbTimer);
    flight.hbTimer = null;
    await flight.heartbeat;
  },

  armHerdrTimer(flight) {
    if (flight.timeoutTimer) clearTimeout(flight.timeoutTimer);
    const timeoutMs = (Number(flight.timeoutSec) || 0) * 1000;
    if (!timeoutMs) return;
    const target = (Number(flight.startedMs) || Date.now()) + timeoutMs;
    const wait = Math.max(0, Math.min(target - Date.now(), 2_147_483_647));
    flight.timeoutTimer = setTimeout(() => this.pulseWake(), wait);
    flight.timeoutTimer.unref?.();
  },

  timeoutDueHerdr(flight) {
    const timeoutMs = (Number(flight.timeoutSec) || 0) * 1000;
    if (!timeoutMs) return false;
    return Date.now() >= (Number(flight.startedMs) || 0) + timeoutMs;
  },

  herdrStartupGraceMs() {
    const n = Number(this.cfg?.herdrStartupGraceMs);
    return Number.isFinite(n) && n >= 0 ? n : 15_000;
  },

  // 后台异步 wait，不堵主循环；若 mock 立刻返回（<20ms）或刚发完 prompt 尚未进入 working，
  // 则不自激唤醒，防止刚启动的 Claude Code TUI 在初始 idle 态被秒杀误判完成。
  startHerdrWatcher(flight) {
    this.startHerdrSocketWatcher(flight);
  },

  clearHerdrFlight(flight) {
    if (!flight) return;
    flight.finishing = true;
    if (flight.hbTimer) clearInterval(flight.hbTimer);
    if (flight.timeoutTimer) clearTimeout(flight.timeoutTimer);
    flight.hbTimer = null;
    flight.timeoutTimer = null;
    const waiter = flight.waiter;
    flight.waiter = null;
    if (this._herdrFlights?.get(flight.taskId) === flight) {
      this._herdrFlights.delete(flight.taskId);
    }
    waiter?.();
  },

  async closeHerdrTaskFor(taskId, entry = null) {
    return this.closeHerdrTaskViaSocket(taskId, entry);
  },

  async cleanupHerdrTerminal(taskId) {
    if (!taskId) return;
    const hasFlight = this._herdrFlights?.has(taskId);
    const hasLedger = fs.existsSync(herdrLedgerPath(this.cfg.configDir, taskId));
    if (hasFlight || hasLedger) {
      await this.closeHerdrTaskFor(taskId);
    }
  },

  async parkHerdrFlight(current, flight, kind, message, { usage = null, session = null, blocked = false } = {}) {
    const taskId = flight.taskId;
    if (session) this.persistSession(taskId, session);
    let ok = false;
    if (kind === "auth") {
      if (!String(flight.runId ?? "").trim()) {
        await this.failHerdrExecution(current, flight, new Error("动态审批缺少稳定 runId"));
        return;
      }
      const rid = await this.writeRun(current, "paused", flight.started, "auth-required: " + String(message).slice(0, 400));
      const mid = await this.writeDynamicAuthRequest(current, String(message), flight.runId);
      ok = await this.updateTaskState(current, {
        Status: "auth-required", Latest_Run: rid, Status_Msg: mid, Heartbeat_At: "",
      }, ["working"], true);
    } else {
      const rid = await this.writeRun(current, "paused", flight.started, "input-required: " + String(message).slice(0, 400));
      const mid = await this.writeMessage(current, "question", String(message));
      ok = await this.updateTaskState(current, {
        Status: "input-required", Latest_Run: rid, Status_Msg: mid, Heartbeat_At: "",
      }, ["working"], true);
    }
    if (!ok) return;

    await this.applyUsage(current, usage ?? null);
    this.clearRetry(taskId);
    // 挂起不关 Tab/Pane！清掉旧 receipt.txt，把账本与飞行记录置为 parked 继续占槽。
    unlinkQuiet(flight.receiptPath);
    const ledger = readHerdrLedger(this.cfg.configDir, taskId);
    if (ledger && !ledger.broken) {
      ledger.state = "parked";
      ledger.blocked = Boolean(blocked);
      saveHerdrLedger(this.cfg.configDir, ledger);
    }
    flight.state = "parked";
    flight.blocked = Boolean(blocked);
    flight.finishing = false;
    flight.watching = false;
    if (flight.timeoutTimer) {
      clearTimeout(flight.timeoutTimer);
      flight.timeoutTimer = null;
    }
    const waiter = flight.waiter;
    flight.waiter = null;
    waiter?.();
    log(`herdr ${kind === "auth" ? "auth-required" : "input-required"} (parked) ${taskId}: ${String(message).slice(0, 120)}`);
  },

  async runHerdrVerify(current, res, capEntry) {
    const verifyCmd = typeof capEntry?.verify === "string" && capEntry.verify.trim() ? capEntry.verify : "";
    if (!verifyCmd) return null;
    const taskId = f1(current, "Task_ID");
    const stdinLine = JSON.stringify({
      task_id: taskId,
      summary: String(res?.summary ?? ""),
      artifact: String(res?.artifact ?? ""),
      artifact_name: String(res?.artifact_name ?? ""),
      checks: res?.checks ?? {},
    }) + "\n";
    const t0 = Date.now();
    try {
      const p = await this.runShell(verifyCmd, stdinLine, clampVerifyTimeout(capEntry.verify_timeout_sec), capEntry.cwd || this.cfg.configDir);
      const verdict = verifyVerdict({ code: p.code, timedOut: false, error: p.code == null });
      return {
        verdict,
        exit_code: p.code ?? null,
        duration_ms: Math.max(0, Date.now() - t0),
        stdout: p.stdout || "",
        stderr: p.stderr || "",
      };
    } catch (e) {
      const msg = String(e?.message ?? e);
      const timedOut = /timed out|timeout/i.test(msg);
      return {
        verdict: timedOut ? "timeout" : "error",
        exit_code: null,
        duration_ms: Math.max(0, Date.now() - t0),
        stdout: "",
        stderr: msg,
      };
    }
  },

  async settleHerdrOutput(task, flight, output) {
    await this.stopHerdrHeartbeat(flight);
    if (flight.timeoutTimer) {
      clearTimeout(flight.timeoutTimer);
      flight.timeoutTimer = null;
    }
    const taskId = flight.taskId;
    if (this.readOutbox(taskId)) {
      await this.closeHerdrTaskFor(taskId);
      return;
    }
    const current = await this.taskForWrite(task, ["working"], true);
    if (!current) {
      await this.closeHerdrTaskFor(taskId);
      return;
    }
    const cleaned = String(output ?? "");
    try {
      const res = flight.mode === "json"
        ? this.interpretCommandResult("json", { code: 0, stdout: cleaned.trim(), stderr: "" })
        : this.parseAgentOutput(cleaned.trim());
      this.persistSession(taskId, res.session);
      const skill = this.capKeyOf(current);
      const capEntry = this.commands[skill] ?? {};
      const verifyRes = await this.runHerdrVerify(current, res, capEntry);
      const { criteria, criteriaRef } = await this.getAcceptanceCriteria(current);
      const checks = judgeChecks(criteria, res.checks);
      const acceptance = buildAcceptance({
        verify: verifyRes ? {
          verdict: verifyRes.verdict,
          exit_code: verifyRes.exit_code,
          duration_ms: verifyRes.duration_ms,
          evidence: "captured",
        } : null,
        criteriaRef,
        checks,
      });
      const outcome = !verifyRes || verifyRes.verdict === "pass" ? "succeeded" : "verify_failed";
      const verifyEvidence = outcome === "verify_failed"
        ? verifyEvidenceTail(verifyRes.stdout, verifyRes.stderr)
        : "";
      const box = this.beginOutbox(current, {
        outcome,
        res,
        started: flight.started,
        runId: flight.runId,
        usage: res.usage ?? null,
        acceptance,
        verifyEvidence,
      });
      // 先关 Tab 释槽位，再提交 outbox；即使总线暂时失败也由 outbox 补齐。
      await this.closeHerdrTaskFor(taskId);
      try { await this.submitOutbox(current, box); }
      catch (err) { log(`herdr submit failed, will reconcile ${taskId}: ${err.message}`); }
    } catch (e) {
      if (e instanceof InvalidReceipt) {
        this.persistSession(taskId, e.session);
        const box = this.beginOutbox(current, {
          outcome: "invalid",
          started: flight.started,
          runId: flight.runId,
          error: String(e.message).slice(0, 300),
          raw: String(e.raw ?? "").slice(0, 500),
          usage: e.usage ?? null,
        });
        await this.closeHerdrTaskFor(taskId);
        try { await this.submitOutbox(current, box); }
        catch (err) { log(`herdr invalid receipt submit failed, will reconcile ${taskId}: ${err.message}`); }
        return;
      }
      if (e instanceof NeedInput) {
        await this.parkHerdrFlight(current, flight, "input", String(e.message), {
          usage: e.usage ?? null,
          session: e.session ?? null,
          blocked: false,
        });
        return;
      }
      if (e instanceof NeedAuth) {
        await this.parkHerdrFlight(current, flight, "auth", String(e.message), {
          usage: e.usage ?? null,
          session: e.session ?? null,
          blocked: false,
        });
        return;
      }
      await this.failHerdrExecution(current, flight, e);
    }
  },

  async failHerdrExecution(task, flight, err) {
    await this.stopHerdrHeartbeat(flight);
    const taskId = flight.taskId || f1(task, "Task_ID");
    await this.closeHerdrTaskFor(taskId);
    if (this.readOutbox(taskId)) return;
    const current = await this.taskForWrite(task, ["working"], true);
    if (!current) return;
    const retries = Number(f1(current, "Retry_Count")) || 0;
    const rid = await this.writeRun(current, "failed", flight.started || nowStr(), String(err?.message ?? err).slice(0, 800));
    let ok = false;
    if (retries < MAX_RETRIES) {
      const next = retries + 1;
      const until = this.armRetry(taskId, next);
      ok = await this.updateTaskState(current, {
        Status: "submitted", Latest_Run: rid, Claimed_By: "", Heartbeat_At: "",
        Retry_Count: next,
      }, ["working"], true);
      if (ok) log(`herdr failed, will retry ${taskId} after ${new Date(until).toISOString()}: ${String(err?.message ?? err).slice(0, 200)}`);
    } else {
      await this.writeMessage(current, "notice", "执行失败且已达重试上限：" + String(err?.message ?? err).slice(0, 500));
      ok = await this.updateTaskState(current, {
        Status: "failed", Latest_Run: rid, Heartbeat_At: "",
      }, ["working"], true);
      if (ok) {
        this.clearRetry(taskId);
        this.dropSession(taskId);
        log(`herdr failed permanently ${taskId}: ${String(err?.message ?? err).slice(0, 200)}`);
      }
    }
    if (ok) await this.applyUsage(current, null);
  },

  async pokeHerdrFlight(flight, snapshotTask = null) {
    return this.pokeHerdrFlightViaSocket(flight, snapshotTask);
  },

  async serviceHerdrFlights() {
    const diskLedgers = listHerdrLedgers(this.cfg.configDir);
    if (this._herdrFlights.size === 0 && diskLedgers.length === 0) return;
    let tasks;
    try {
      tasks = await this.bus.listRecords(this.T.tasks);
    } catch (e) {
      log("herdr ledger scan failed: " + (e?.message ?? e));
      return;
    }
    const byId = new Map();
    for (const t of tasks) {
      const tid = String(f1(t, "Task_ID") ?? "");
      if (tid) byId.set(tid, t);
    }

    // 1. 守护重启或冷接管时，把磁盘上的 herdr.json 认领回 _herdrFlights（或清理已终结的孤儿 Tab）。
    for (const { taskId, ledger } of diskLedgers) {
      if (this._herdrFlights.has(taskId)) continue;
      const task = byId.get(taskId);
      const status = task ? String(f1(task, "Status") ?? "") : "";
      const claimedBy = task ? String(f1(task, "Claimed_By") ?? "") : "";
      if (!task || TERMINAL_STATUSES.has(status) || ledger.broken || ledger.state === "exited") {
        await this.closeHerdrTaskFor(taskId, ledger);
        continue;
      }
      if (this.readOutbox(taskId)) {
        await this.closeHerdrTaskFor(taskId, ledger);
        continue;
      }
      if (claimedBy !== this.cfg.node || !ACTIVE_TASK_STATUSES.has(status)) {
        await this.closeHerdrTaskFor(taskId, ledger);
        continue;
      }
      const entry = this.commands[this.capKeyOf(task)] ?? {};
      const flight = this.herdrFlightFrom(task, ledger, entry.mode || "agent");
      if (status === "input-required" || status === "auth-required") {
        flight.state = "parked";
        if (ledger.state !== "parked") {
          ledger.state = "parked";
          saveHerdrLedger(this.cfg.configDir, ledger);
        }
      }
      this._herdrFlights.set(taskId, flight);
      if (flight.state === "working") {
        this.startHerdrHeartbeat(flight);
        this.armHerdrTimer(flight);
      }
      log(`adopted herdr ${flight.state} ledger ${taskId} agent=${flight.agentName}`);
    }

    // 2. 巡检所有在途 / 驻留飞行记录。
    for (const flight of [...this._herdrFlights.values()]) {
      const task = byId.get(flight.taskId) || null;
      if (flight.state === "parked") {
        const status = task ? String(f1(task, "Status") ?? "") : "";
        const claimedBy = task ? String(f1(task, "Claimed_By") ?? "") : "";
        if (!task || claimedBy !== this.cfg.node || (status !== "input-required" && status !== "auth-required")) {
          await this.closeHerdrTaskFor(flight.taskId);
        }
        continue;
      }
      await this.pokeHerdrFlight(flight, task);
    }
  },

  async pokeSettledHerdrReceipts() {
    if (!this._herdrFlights?.size) return;
    for (const flight of [...this._herdrFlights.values()]) {
      if (flight.state !== "working") continue;
      if (flight.resultPath && fs.existsSync(flight.resultPath)) await this.pokeHerdrFlight(flight);
    }
  },

  async executeHerdr(task, extraAnswers = null, resume = false) {
    return this.executeHerdrViaSocket(task, extraAnswers, resume);
  },

  // ---------- Socket 路径：指针投递 + 文件门禁。屏幕不作为业务回执。 ----------

  herdrBusyQueuePath() {
    return path.join(this.cfg.configDir, "herdr_dispatch_queue.jsonl");
  },

  onHerdrBindingChanged(binding) {
    if (!binding?.agentName || !this._herdrFlights) return;
    for (const flight of this._herdrFlights.values()) {
      if (flight.agentName !== binding.agentName) continue;
      flight.paneId = binding.paneId || flight.paneId;
      flight.workspaceId = binding.workspaceId || flight.workspaceId;
      flight.tabId = binding.tabId || flight.tabId;
      flight.worktreePath = binding.worktreePath || flight.worktreePath || "";
      this.persistHerdrPlace(flight);
    }
  },

  persistHerdrPlace(flight) {
    const ledger = readHerdrLedger(this.cfg.configDir, flight.taskId);
    if (ledger && !ledger.broken) {
      ledger.agent_name = flight.agentName;
      ledger.workspace_id = flight.workspaceId || "";
      ledger.tab_id = flight.tabId || "";
      ledger.pane_id = flight.paneId || "";
      ledger.worktree_path = flight.worktreePath || "";
      ledger.attempt_id = flight.attemptId || "";
      ledger.attempt_no = flight.attemptNo || 1;
      ledger.result_path = flight.resultPath || "";
      ledger.envelope_path = flight.envelopePath || "";
      ledger.repairs = flight.repairs || 0;
      ledger.seen_working = Boolean(flight.seenWorking);
      ledger.prompt_sent_ms = Number(flight.promptSentMs) || ledger.prompt_sent_ms || Date.now();
      if (Number.isFinite(Number(flight.promptSeq))) ledger.prompt_seq = Number(flight.promptSeq);
      saveHerdrLedger(this.cfg.configDir, ledger);
    }
    try {
      writeHerdrBinding(this.cfg.configDir, flight.taskId, {
        agent_name: flight.agentName,
        workspace_id: flight.workspaceId || "",
        pane_id: flight.paneId || "",
        worktree_path: flight.worktreePath || "",
      });
    } catch (e) {
      log("herdr binding save failed: " + (e?.message ?? e));
    }
  },

  async noteHerdrBusy(flight, reason) {
    flight.pendingPrompt = true;
    try {
      await appendQueueItem(this.herdrBusyQueuePath(), {
        task_id: flight.taskId,
        agent_name: flight.agentName,
        reason: String(reason || "busy"),
        at: new Date().toISOString(),
      });
    } catch (e) {
      log("herdr busy queue failed: " + (e?.message ?? e));
    }
  },

  async drainHerdrBusy(taskId) {
    try { await popQueue(this.herdrBusyQueuePath(), { taskId }); }
    catch { /* 队列不存在就当没有积压 */ }
  },

  herdrAttemptFiles(flight, { runId, instructions, inputPath, receiptPath, repair = false, fresh = false, violations = [] }) {
    const next = repair || fresh;
    const attemptNo = next ? (Number(flight.attemptNo) || 1) + 1 : (Number(flight.attemptNo) || 1);
    const attemptId = flight.attemptId && !next ? flight.attemptId : newAttemptId(attemptNo);
    const written = writeAttemptEnvelope({
      configDir: this.cfg.configDir,
      taskId: flight.taskId,
      runId,
      attemptNo,
      attemptId,
      envelope: {
        input_path: inputPath,
        receipt_path: receiptPath,
        instructions,
        repair: Boolean(repair),
        violations,
      },
    });
    if (repair) {
      atomicWriteFile(written.repair, JSON.stringify({
        previous_attempt_id: flight.attemptId || "",
        violations,
      }, null, 2));
    }
    flight.attemptNo = attemptNo;
    flight.attemptId = attemptId;
    flight.resultPath = written.result;
    flight.envelopePath = written.envelope;
    flight.runId = runId;
    flight.inputPath = inputPath;
    flight.receiptPath = receiptPath;
    flight.repairing = Boolean(repair);
    return written;
  },

  // 只有这轮真的进入过 working 才算开工。Herdr 在收下 prompt 时就会把
  // state_change_seq 加一，但状态可能仍是发之前的 idle，那不是交卷。
  herdrTurnObserved(flight) {
    return Boolean(flight.seenWorking);
  },

  async submitHerdrPointer(rt, flight) {
    flight.seenWorking = false;
    flight.stallNoted = false;
    const prompt = buildPointerPrompt({
      envelopePath: flight.envelopePath,
      attemptId: flight.attemptId,
      repair: Boolean(flight.repairing),
    });
    const outcome = await rt.dispatchPrompt(flight.agentName, prompt, { wait: false });
    flight.promptSentMs = Date.now();
    const after = await rt.getAgent(flight.agentName).catch(() => null);
    flight.promptSeq = Number(after?.state_change_seq ?? -1);
    const afterStatus = String(after?.agent_status ?? "").toLowerCase();
    if (afterStatus === "working") this.rememberHerdrSeenWorking(flight);
    this.persistHerdrPlace(flight);
    if (outcome.status === "busy" || outcome.status === "stalled") {
      await this.noteHerdrBusy(flight, outcome.status);
      return outcome;
    }
    flight.pendingPrompt = false;
    await this.drainHerdrBusy(flight.taskId);
    return outcome;
  },

  async parkHerdrBlocked(task, flight, popup) {
    await this.stopHerdrHeartbeat(flight);
    const current = await this.taskForWrite(task, ["working"], true);
    if (!current) {
      await this.closeHerdrTaskFor(flight.taskId);
      return;
    }
    const prompt = clipText(String(popup ?? ""), 1500) || "Herdr Agent 终端等待交互输入或权限确认，请回复继续指示。";
    await this.parkHerdrFlight(current, flight, "input", prompt, { blocked: true });
  },

  rememberHerdrSeenWorking(flight) {
    if (flight.seenWorking) return;
    flight.seenWorking = true;
    const ledger = readHerdrLedger(this.cfg.configDir, flight.taskId);
    if (ledger && !ledger.broken && !ledger.seen_working) {
      ledger.seen_working = true;
      saveHerdrLedger(this.cfg.configDir, ledger);
    }
  },

  startHerdrSocketWatcher(flight) {
    if (!flight || flight.watching || flight.pendingPrompt || flight.state !== "working" || this._stopping) return;
    flight.watching = true;
    const t0 = Date.now();
    const waitMs = Math.max(5_000, Math.min((Number(flight.timeoutSec) || 600) * 1000, 300_000));
    let rt;
    try { rt = this.herdrRuntime(); }
    catch { flight.watching = false; return; }
    this.herdrWatchTurn(rt, flight, t0, waitMs)
      .then((outcome) => {
        if (flight.finishing || flight.state !== "working") return;
        if (!outcome || outcome.status === "pending") return;
        // 十几毫秒内回到「发 prompt 之前的 idle」是旧状态，不能当成这轮结束。
        if (Date.now() - t0 < 20 && outcome.status === "settled" && !this.herdrTurnObserved(flight)) return;
        this.pulseWake();
      })
      .catch(() => { /* 断线或停止由下一次扫表接手 */ })
      .finally(() => { flight.watching = false; });
  },

  // 先等到这轮真的动过（working，或 state_change_seq 超过发 prompt 时的基线），再等交卷。
  // 直接 agent.wait(idle) 会立刻被发 prompt 之前的 idle 满足，扫表就会把缺结果当成修复。
  async herdrWatchTurn(rt, flight, t0, waitMs) {
    const deadline = t0 + waitMs;
    while (Date.now() < deadline) {
      if (flight.finishing || flight.state !== "working" || this._stopping) return { status: "pending" };
      let agent = null;
      try { agent = await rt.getAgent(flight.agentName); }
      catch { return { status: "pending" }; }
      if (!agent) return { status: "dead" };
      const st = String(agent.agent_status ?? "").toLowerCase();
      if (st === "blocked") return { status: "blocked", agent };
      if (st === "working") {
        this.rememberHerdrSeenWorking(flight);
        const left = Math.max(1000, deadline - Date.now());
        return rt.waitForTurn(flight.agentName, { timeoutMs: left });
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 250);
        timer.unref?.();
      });
    }
    return { status: "deadline" };
  },

  async closeHerdrTaskViaSocket(taskId, entry = null) {
    const flight = this._herdrFlights?.get(taskId);
    if (flight) {
      await this.stopHerdrHeartbeat(flight);
      this.clearHerdrFlight(flight);
    }
    const ledger = entry || readHerdrLedger(this.cfg.configDir, taskId);
    if (ledger && !ledger.broken && (ledger.agent_name || ledger.tab_id || ledger.pane_id)) {
      try {
        const rt = await this.ensureHerdrRuntime();
        await rt.closeAgent({
          agentName: ledger.agent_name,
          workspaceId: ledger.workspace_id || "",
          tabId: ledger.tab_id || "",
          paneId: ledger.pane_id || "",
          worktreePath: ledger.worktree_path || "",
        });
      } catch (e) {
        log(`herdr close failed ${taskId}: ${e?.message ?? e}`);
      }
    }
    deleteHerdrLedger(this.cfg.configDir, taskId);
    await this.drainHerdrBusy(taskId);
  },

  async applyHerdrPromptOutcome(task, flight, outcome) {
    if (!outcome || outcome.status === "accepted" || outcome.status === "busy" || outcome.status === "stalled") return false;
    if (outcome.status === "blocked") {
      await this.parkHerdrBlocked(task, flight, outcome.popup);
      return true;
    }
    if (outcome.status === "dead") {
      await this.failHerdrExecution(task, flight, new Error(outcome.reason || "herdr agent 不可用"));
      return true;
    }
    return false;
  },

  async pokeHerdrFlightViaSocket(flight, snapshotTask = null) {
    if (flight.state !== "working") return;
    const task = snapshotTask || (await this.bus.getRecord(this.T.tasks, flight.recordId));
    if (!task || f1(task, "Status") !== "working" || f1(task, "Claimed_By") !== this.cfg.node) {
      await this.closeHerdrTaskFor(flight.taskId);
      return;
    }
    if (this.timeoutDueHerdr(flight)) {
      await this.failHerdrExecution(task, flight, new Error(`herdr 任务执行超时（>${flight.timeoutSec}s）`));
      return;
    }
    const rt = await this.ensureHerdrRuntime();
    if (flight.pendingPrompt) {
      const outcome = await this.submitHerdrPointer(rt, flight);
      if (await this.applyHerdrPromptOutcome(task, flight, outcome)) return;
      await this.touchHeartbeat(task);
      this.startHerdrWatcher(flight);
      return;
    }
    const agent = await rt.getAgent(flight.agentName);
    if (!agent) {
      await this.failHerdrExecution(task, flight, new Error("herdr agent 意外退出"));
      return;
    }
    if (agent.pane_id && agent.pane_id !== flight.paneId) {
      flight.paneId = agent.pane_id;
      flight.workspaceId = agent.workspace_id || flight.workspaceId;
      flight.tabId = agent.tab_id || flight.tabId;
      this.persistHerdrPlace(flight);
    }
    const st = String(agent.agent_status ?? "").toLowerCase();
    if (st === "working") {
      this.rememberHerdrSeenWorking(flight);
      await this.touchHeartbeat(task);
      this.startHerdrWatcher(flight);
      return;
    }
    if (st === "blocked") {
      const popup = await rt.readDiagnostics(flight.agentName, { lines: 80 });
      await this.parkHerdrBlocked(task, flight, popup);
      return;
    }
    if (st === "idle" || st === "done") {
      if (!this.herdrTurnObserved(flight)) {
        const since = Date.now() - Number(flight.promptSentMs || 0);
        if (!flight.stallNoted && since >= this.herdrStartupGraceMs()) {
          flight.stallNoted = true;
          log(`herdr prompt not started ${flight.taskId} after ${since}ms`);
        }
        await this.touchHeartbeat(task);
        this.startHerdrWatcher(flight);
        return;
      }
      const gate = checkResultGate({
        resultPath: flight.resultPath,
        attemptId: flight.attemptId,
        runId: flight.runId,
        taskId: flight.taskId,
      });
      if (gate.ok) {
        await this.settleHerdrOutput(task, flight, gate.result.receipt_text);
        return;
      }
      if ((Number(flight.repairs) || 0) >= MAX_GATE_REPAIRS) {
        const why = gate.violations.map((v) => v.code).join(",") || "gate";
        await this.failHerdrExecution(task, flight, new Error(`herdr 门禁未通过（${why}）`));
        return;
      }
      flight.repairs = (Number(flight.repairs) || 0) + 1;
      const entry = this.commands[this.capKeyOf(task)] ?? {};
      const instructions = this.buildPrompt(flight.inputPath, entry, null, flight.receiptPath);
      this.herdrAttemptFiles(flight, {
        runId: flight.runId,
        instructions,
        inputPath: flight.inputPath,
        receiptPath: flight.receiptPath,
        repair: true,
        violations: gate.violations,
      });
      this.persistHerdrPlace(flight);
      const outcome = await this.submitHerdrPointer(rt, flight);
      if (await this.applyHerdrPromptOutcome(task, flight, outcome)) return;
      log(`herdr repair ${flight.taskId} attempt=${flight.attemptNo} repairs=${flight.repairs}`);
      this.startHerdrWatcher(flight);
      return;
    }
    await this.touchHeartbeat(task);
    this.startHerdrWatcher(flight);
  },

  async executeHerdrViaSocket(task, extraAnswers = null, resume = false) {
    const taskId = f1(task, "Task_ID");
    const skill = this.capKeyOf(task);
    const entry = this.commands[skill] ?? {};
    const started = nowStr();
    const startedMs = Date.now();
    let runId = "";
    try {
      const rt = await this.ensureHerdrRuntime();
      runId = await this.openRun(task, started);
      const params = await this.getParams(task);
      if (extraAnswers) params._answers = extraAnswers;
      const inputPath = await this.writeAgentInput(task, params, extraAnswers);
      const receiptPath = herdrReceiptPath(this.cfg.configDir, taskId);
      unlinkQuiet(receiptPath);
      const timeout = clampTimeoutSec(params?.timeout_sec, entry);
      const mode = entry.mode ?? "agent";
      const kind = inferHerdrKind(entry);
      if (!kind) throw new Error(`herdr 能力 ${skill} 缺少 herdr_kind`);
      const hasCriteria = parseCriteria(params).criteria.length > 0;
      const instructions = this.buildPrompt(inputPath, entry, hasCriteria, receiptPath);
      const userEnv = (entry.herdr_env && typeof entry.herdr_env === "object" && !Array.isArray(entry.herdr_env))
        ? entry.herdr_env
        : ((entry.env && typeof entry.env === "object" && !Array.isArray(entry.env)) ? entry.env : {});
      const args = Array.isArray(entry.herdr_args) ? entry.herdr_args : [];

      if (resume) {
        const existing = readHerdrLedger(this.cfg.configDir, taskId);
        if (existing && !existing.broken && existing.agent_name) {
          const live = await rt.getAgent(existing.agent_name);
          if (live) {
            const wasBlocked = Boolean(existing.blocked) || String(live.agent_status ?? "").toLowerCase() === "blocked";
            if (wasBlocked) await rt.sendKeys(existing.agent_name, ["esc"]).catch(() => {});
            existing.state = "working";
            existing.blocked = false;
            existing.run_id = runId;
            existing.started_at = started;
            existing.started_ms = startedMs;
            existing.timeout_sec = timeout;
            existing.receipt_path = receiptPath;
            existing.input_path = inputPath;
            existing.turn_count = (Number(existing.turn_count) || 1) + 1;
            existing.seen_working = false;
            existing.prompt_sent_ms = startedMs;
            if (live.pane_id) existing.pane_id = live.pane_id;
            if (live.workspace_id) existing.workspace_id = live.workspace_id;
            if (live.tab_id) existing.tab_id = live.tab_id;
            saveHerdrLedger(this.cfg.configDir, existing);
            const flight = this._herdrFlights.get(taskId) || this.herdrFlightFrom(task, existing, mode);
            flight.recordId = task.record_id;
            flight.agentName = existing.agent_name;
            flight.runId = runId;
            flight.mode = mode;
            flight.started = started;
            flight.startedMs = startedMs;
            flight.timeoutSec = timeout;
            flight.receiptPath = receiptPath;
            flight.inputPath = inputPath;
            flight.state = "working";
            flight.blocked = false;
            flight.turnCount = existing.turn_count;
            flight.seenWorking = false;
            flight.paneId = existing.pane_id || flight.paneId;
            flight.workspaceId = existing.workspace_id || flight.workspaceId;
            flight.tabId = existing.tab_id || flight.tabId;
            flight.worktreePath = existing.worktree_path || flight.worktreePath || "";
            this.herdrAttemptFiles(flight, {
              runId, instructions, inputPath, receiptPath, fresh: true, violations: [],
            });
            this._herdrFlights.set(taskId, flight);
            this.persistHerdrPlace(flight);
            const outcome = await this.submitHerdrPointer(rt, flight);
            if (!(await this.applyHerdrPromptOutcome(task, flight, outcome))) {
              this.startHerdrHeartbeat(flight);
              this.armHerdrTimer(flight);
              this.startHerdrWatcher(flight);
            }
            log(`herdr hot resumed ${taskId} agent=${existing.agent_name} turn=${existing.turn_count}`);
            return;
          }
          log(`herdr hot resume missed (${taskId}), cold relaunching`);
          await this.closeHerdrTaskViaSocket(taskId, existing);
        }
      }

      const attemptId = newAttemptId(1);
      const written = writeAttemptEnvelope({
        configDir: this.cfg.configDir,
        taskId,
        runId,
        attemptNo: 1,
        attemptId,
        envelope: {
          input_path: inputPath,
          receipt_path: receiptPath,
          instructions,
          repair: false,
          violations: [],
        },
      });
      const cwd = entry.cwd || this.cfg.configDir;
      const binding = await rt.launchAgent({
        configDir: this.cfg.configDir,
        taskId,
        runId,
        attemptId,
        node: this.cfg.node,
        worker: entry.worker || "",
        kind,
        args,
        env: userEnv,
        cwd,
        inputPath,
        receiptPath,
        envelopePath: written.envelope,
        workspaceLabel: this.cfg.herdrWorkspace || "a2a-hub",
      });
      const ledger = {
        task_id: taskId,
        agent_name: binding.agentName,
        kind,
        workspace_id: binding.workspaceId,
        tab_id: binding.tabId,
        pane_id: binding.paneId,
        worktree_path: binding.worktreePath || "",
        run_id: runId,
        state: "working",
        started_at: started,
        started_ms: startedMs,
        timeout_sec: timeout,
        receipt_path: receiptPath,
        input_path: inputPath,
        turn_count: 1,
        blocked: false,
        seen_working: false,
        prompt_sent_ms: startedMs,
        attempt_id: attemptId,
        attempt_no: 1,
        result_path: written.result,
        envelope_path: written.envelope,
        repairs: 0,
      };
      saveHerdrLedger(this.cfg.configDir, ledger);
      const flight = this.herdrFlightFrom(task, ledger, mode);
      this._herdrFlights.set(taskId, flight);
      this.persistHerdrPlace(flight);
      const outcome = await this.submitHerdrPointer(rt, flight);
      if (await this.applyHerdrPromptOutcome(task, flight, outcome)) return;
      this.startHerdrHeartbeat(flight);
      this.armHerdrTimer(flight);
      this.startHerdrWatcher(flight);
      log(`herdr started ${taskId} agent=${binding.agentName} kind=${kind} pane=${binding.paneId}`);
    } catch (e) {
      log(`herdr launch failed ${taskId}: ${e?.message ?? e}`);
      try {
        await this.failHerdrExecution(task, {
          taskId,
          recordId: task.record_id,
          started,
          startedMs,
          timeoutSec: 0,
          runId,
        }, e);
      } catch (err) {
        log("herdr failure record failed: " + (err?.message ?? err));
      }
    }
  },
};
