// Hub 单进程运行时编排（v2.0）。
// 在单进程内串联 HubStore + FileStore + LongPollBroker + TaskService + HTTP 网关 + 本机 DeviceDaemon。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApprovalLinkService, resolveApprovalSettings } from "./approval-links.mjs";
import { loadOrCreateHubKey } from "./approval-sign.mjs";
import { LongPollBroker } from "./broker.mjs";
import {
  DAEMON_VERSION,
  inferCloudPublicUrl,
  loadAppEnv,
  loadConfigJson,
  loadOwnerToken,
  resolveListenAddr,
  resolveNoDeviceSetting,
  sanitizeSlug,
  writeJsonAtomic,
} from "./config.mjs";
import { FeishuApprovalChannel } from "./feishu-approval.mjs";
import { ExternalNotifier } from "./notifier.mjs";
import { ScheduleService } from "./schedules.mjs";
import { TaskService } from "./task-service.mjs";
import { loadAgentTemplates } from "./templates.mjs";
import { WebhookDispatcher } from "./webhooks.mjs";
import { DeviceDaemon } from "../client/device-daemon.mjs";
import { GatewayClient } from "../client/gateway-client.mjs";
import { startHubHttpServer } from "../server/http-server.mjs";
import { HubStore } from "../store/db.mjs";
import { FileRetentionService, FileStore } from "../store/files.mjs";

export async function startHubRuntime({
  configDir,
  listen = "",
  env = process.env,
  withDeviceDaemon,
  logger = console,
} = {}) {
  fs.mkdirSync(configDir, { recursive: true });
  const cfg = loadConfigJson(configDir);
  const appEnv = { ...loadAppEnv(configDir), ...env };
  const enableDeviceDaemon = withDeviceDaemon !== undefined
    ? Boolean(withDeviceDaemon)
    : !resolveNoDeviceSetting({ env: appEnv, cfg });
  const addr = resolveListenAddr(listen || cfg.listen, appEnv);
  const { privateKey, publicKey } = loadOrCreateHubKey(configDir);

  const dbPath = path.join(configDir, "hub.db");
  const store = new HubStore(dbPath);
  const fileStore = new FileStore(store, configDir);
  const fileRetention = new FileRetentionService(fileStore);
  const broker = new LongPollBroker(store);
  loadAgentTemplates(configDir);

  let localUrl = addr.url;
  const resolvePublicUrl = () => {
    const latestCfg = loadConfigJson(configDir);
    const latestEnv = loadAppEnv(configDir);
    return (
      String(latestEnv.AH_PUBLIC_URL || "").replace(/\/+$/, "") ||
      String(latestCfg.publicUrl || "").replace(/\/+$/, "") ||
      inferCloudPublicUrl(latestEnv) ||
      localUrl
    );
  };

  const taskService = new TaskService(store, { approvalPrivateKey: privateKey });
  const webhooks = new WebhookDispatcher(store, { hubUrlResolver: resolvePublicUrl });
  // 审批相关开关在控制台可改（写 app.env），每次使用时重读，无需重启
  const resolveEnv = () => ({ ...loadAppEnv(configDir), ...env });
  const approvalLinks = new ApprovalLinkService({
    store,
    privateKey,
    hubUrlResolver: resolvePublicUrl,
    envResolver: resolveEnv,
  });
  const notifier = new ExternalNotifier(appEnv, {
    hubUrlResolver: resolvePublicUrl,
    approvalLinkResolver: (event) => (approvalLinks.isEnabled() ? approvalLinks.issueForTask(event.taskId)?.url || "" : ""),
  });
  const feishuApproval = new FeishuApprovalChannel({
    store,
    taskService,
    envResolver: resolveEnv,
    hubUrlResolver: resolvePublicUrl,
    logger,
  });
  const schedules = new ScheduleService(store, taskService, { envResolver: resolveEnv, logger });

  store.setChangeHook((event) => {
    broker.publish(event);
    webhooks.handleEvent(event);
    notifier.handleEvent(event);
    feishuApproval.handleEvent(event);
  });

  const deviceId = sanitizeSlug(cfg.deviceId || os.hostname(), "hub-local");
  if (enableDeviceDaemon) {
    store.upsertDevice({
      id: deviceId,
      name: cfg.deviceName || os.hostname(),
      platform: os.platform(),
      os_info: `${os.type()} ${os.release()} (${os.arch()})`,
      transport: "longpoll",
      max_concurrent: Number(cfg.maxConcurrent || 4) || 4,
      summary: "Hub 本机运行设备",
      issueToken: false,
    });
  } else {
    // 禁用本机 DeviceDaemon 时，顺带清理旧版云端部署遗留的零 Worker 空壳本机设备
    const ghostRow = store.db.prepare("SELECT id, token_hash, summary FROM devices WHERE id = ?").get(deviceId);
    if (ghostRow && !ghostRow.token_hash && ghostRow.summary === "Hub 本机运行设备") {
      const agentCnt = store.db.prepare("SELECT COUNT(*) AS cnt FROM agents WHERE device_id = ?").get(deviceId);
      if (Number(agentCnt?.cnt || 0) === 0) {
        store.deleteDevice(deviceId);
      }
    }
  }

  const getToken = () => loadOwnerToken(configDir, appEnv);
  const { server } = startHubHttpServer({
    configDir,
    hubDeviceId: enableDeviceDaemon ? deviceId : "",
    store,
    taskService,
    broker,
    fileStore,
    webhooks,
    notifier,
    schedules,
    approvalLinks,
    feishuApproval,
    approvalPublicKey: publicKey,
    approvalPrivateKey: privateKey,
    ownerToken: getToken,
    listen: addr.listen,
    hubUrlResolver: resolvePublicUrl,
  });

  await new Promise((resolve, reject) => {
    const onErr = (err) => {
      server.off("listening", onListen);
      reject(err);
    };
    const onListen = () => {
      server.off("error", onErr);
      resolve();
    };
    server.once("error", onErr);
    server.once("listening", onListen);
    server.listen(addr.port, addr.host);
  });

  const bound = server.address();
  const actualPort = typeof bound === "object" && bound ? bound.port : addr.port;
  const connectHost = addr.host === "0.0.0.0" || addr.host === "::" ? "127.0.0.1" : addr.host;
  localUrl = `http://${connectHost}:${actualPort}`;
  const publicUrl = resolvePublicUrl();

  const runtimePath = path.join(configDir, "hub_runtime.json");
  writeJsonAtomic(runtimePath, {
    pid: process.pid,
    version: DAEMON_VERSION,
    listen: `${addr.host}:${actualPort}`,
    url: localUrl,
    public_url: publicUrl,
    public_key: publicKey,
    started_at: Date.now(),
  }, 0o600);

  fileRetention.start();
  feishuApproval.start();
  const scheduleTimer = setInterval(() => {
    try {
      schedules.tick();
    } catch (err) {
      logger?.error?.(`[a2a-hub] schedule tick failed: ${err?.message || err}`);
    }
  }, 15_000);
  if (typeof scheduleTimer.unref === "function") scheduleTimer.unref();

  const staleTimer = setInterval(() => {
    try {
      taskService.reclaimStale();
    } catch {}
    try {
      taskService.expireApprovals(resolveApprovalSettings(resolveEnv()).timeoutMin);
    } catch {}
  }, 60_000);
  if (typeof staleTimer.unref === "function") staleTimer.unref();

  const maintenanceTimer = setInterval(() => {
    try {
      store.pruneIdempotency();
      store.checkpointWal("TRUNCATE");
    } catch {}
  }, 3600 * 1000);
  if (typeof maintenanceTimer.unref === "function") maintenanceTimer.unref();

  let deviceDaemon = null;
  let deviceLoopPromise = null;
  if (enableDeviceDaemon) {
    const localClient = new GatewayClient(localUrl, { token: getToken() });
    deviceDaemon = new DeviceDaemon({
      configDir,
      deviceId,
      hubUrl: localUrl,
      token: getToken(),
      client: localClient,
      maxConcurrent: Number(cfg.maxConcurrent || 4) || 4,
      hubPublicKey: publicKey,
      logger,
    });
    deviceLoopPromise = deviceDaemon.start().catch((err) => {
      logger.error?.(`[hub-runtime] 本机 DeviceDaemon 退出:`, err?.message || err);
    });
  }

  const stop = async () => {
    clearInterval(scheduleTimer);
    clearInterval(staleTimer);
    clearInterval(maintenanceTimer);
    fileRetention.stop();
    await feishuApproval.stop();
    if (deviceDaemon) {
      await deviceDaemon.stop();
    }
    await new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
    });
    // 等待已中止的长轮询请求完成回调清理，再关闭 SQLite 句柄避免竞态报错
    await new Promise((resolve) => setImmediate(resolve));
    try { fs.unlinkSync(runtimePath); } catch {}
    store.close();
  };

  return {
    configDir,
    url: localUrl,
    publicUrl,
    port: actualPort,
    publicKey,
    store,
    taskService,
    broker,
    fileStore,
    webhooks,
    notifier,
    schedules,
    approvalLinks,
    feishuApproval,
    server,
    deviceDaemon,
    deviceLoopPromise,
    stop,
  };
}
