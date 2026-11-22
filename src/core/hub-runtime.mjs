// Hub 单进程运行时编排（v2.0）。
// 在单进程内串联 HubStore + FileStore + LongPollBroker + TaskService + HTTP 网关 + 本机 DeviceDaemon。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadOrCreateHubKey } from "./approval-sign.mjs";
import { LongPollBroker } from "./broker.mjs";
import {
  DAEMON_VERSION,
  inferCloudPublicUrl,
  loadAppEnv,
  loadConfigJson,
  loadOwnerToken,
  resolveListenAddr,
  sanitizeSlug,
  writeJsonAtomic,
} from "./config.mjs";
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
  withDeviceDaemon = true,
  logger = console,
} = {}) {
  fs.mkdirSync(configDir, { recursive: true });
  const cfg = loadConfigJson(configDir);
  const appEnv = { ...loadAppEnv(configDir), ...env };
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
  const notifier = new ExternalNotifier(appEnv, { hubUrlResolver: resolvePublicUrl });
  const schedules = new ScheduleService(store, taskService);

  store.setChangeHook((event) => {
    broker.publish(event);
    webhooks.handleEvent(event);
    notifier.handleEvent(event);
  });

  const deviceId = sanitizeSlug(cfg.deviceId || os.hostname(), "hub-local");
  if (withDeviceDaemon) {
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
  }

  const getToken = () => loadOwnerToken(configDir, appEnv);
  const { server } = startHubHttpServer({
    configDir,
    store,
    taskService,
    broker,
    fileStore,
    webhooks,
    notifier,
    schedules,
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
  const staleTimer = setInterval(() => {
    try {
      taskService.reclaimStale();
    } catch {}
  }, 60_000);
  if (typeof staleTimer.unref === "function") staleTimer.unref();

  let deviceDaemon = null;
  let deviceLoopPromise = null;
  if (withDeviceDaemon) {
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
    clearInterval(staleTimer);
    fileRetention.stop();
    if (deviceDaemon) {
      await deviceDaemon.stop();
    }
    await new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
    });
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
    server,
    deviceDaemon,
    deviceLoopPromise,
    stop,
  };
}
