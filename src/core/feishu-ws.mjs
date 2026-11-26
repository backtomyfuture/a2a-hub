// 飞书开放平台长连接（WebSocket）最小客户端，零依赖实现官方 SDK 的 pbbp2 帧协议。
// 长连接由应用凭证鉴权，不需要公网回调地址，Hub 在内网 / NAT 后也能收到事件与卡片回调。
// 协议要点（对照 larksuite/node-sdk ws-client 与 oapi-sdk-go ws/pbbp2.pb.go）：
// - POST {domain}/callback/ws/endpoint {AppID, AppSecret} 换取带票据的 wss URL 与心跳参数；
// - 帧为 protobuf Frame{1 SeqID u64, 2 LogID u64, 3 service i32, 4 method i32, 5 headers[], 6..9 可选}；
// - method=0 控制帧（ping/pong），method=1 数据帧；数据帧需按原帧回写 {code, data(base64)} 作为响应，
//   卡片回调的响应体就是 data 里的 JSON（toast + 更新后的卡片）。

const FRAME_CONTROL = 0;
const FRAME_DATA = 1;
const DEFAULT_PING_MS = 120_000;
const FRAGMENT_TTL_MS = 30_000;
export const FEISHU_RECONNECT_DELAYS_MS = [2000, 5000, 15_000, 30_000, 60_000];

// ---- protobuf 最小编解码（只覆盖 Frame / Header 用到的 varint 与 length-delimited） ----

function writeVarint(out, value) {
  let v = BigInt.asUintN(64, BigInt(value));
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
}

function writeTag(out, field, wireType) {
  writeVarint(out, (field << 3) | wireType);
}

function writeBytes(out, field, bytes) {
  writeTag(out, field, 2);
  writeVarint(out, bytes.length);
  for (const b of bytes) out.push(b);
}

const utf8 = new TextEncoder();
const utf8d = new TextDecoder("utf-8");

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error("protobuf varint 越界");
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new Error("protobuf varint 过长");
  }
  return [result, pos];
}

function* iterFields(buf) {
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (wt === 0) {
      let v;
      [v, pos] = readVarint(buf, pos);
      yield { field, wt, value: v };
    } else if (wt === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      const end = pos + Number(len);
      if (end > buf.length) throw new Error("protobuf 长度越界");
      yield { field, wt, value: buf.subarray(pos, end) };
      pos = end;
    } else if (wt === 1) {
      pos += 8;
    } else if (wt === 5) {
      pos += 4;
    } else {
      throw new Error(`不支持的 protobuf wire type ${wt}`);
    }
  }
}

// SeqID / LogID 是 uint64，服务端值可能超出 2^53，保留为 BigInt 原样回写。
export function decodeFrame(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const frame = { SeqID: 0n, LogID: 0n, service: 0, method: 0, headers: [], payload_encoding: "", payload_type: "", payload: null, LogIDNew: "" };
  for (const { field, wt, value } of iterFields(buf)) {
    if (field === 1 && wt === 0) frame.SeqID = value;
    else if (field === 2 && wt === 0) frame.LogID = value;
    else if (field === 3 && wt === 0) frame.service = Number(BigInt.asIntN(32, value));
    else if (field === 4 && wt === 0) frame.method = Number(BigInt.asIntN(32, value));
    else if (field === 5 && wt === 2) {
      const h = { key: "", value: "" };
      for (const sub of iterFields(value)) {
        if (sub.field === 1 && sub.wt === 2) h.key = utf8d.decode(sub.value);
        else if (sub.field === 2 && sub.wt === 2) h.value = utf8d.decode(sub.value);
      }
      frame.headers.push(h);
    } else if (field === 6 && wt === 2) frame.payload_encoding = utf8d.decode(value);
    else if (field === 7 && wt === 2) frame.payload_type = utf8d.decode(value);
    else if (field === 8 && wt === 2) frame.payload = new Uint8Array(value);
    else if (field === 9 && wt === 2) frame.LogIDNew = utf8d.decode(value);
  }
  return frame;
}

export function encodeFrame(frame) {
  const out = [];
  writeTag(out, 1, 0); writeVarint(out, frame.SeqID ?? 0);
  writeTag(out, 2, 0); writeVarint(out, frame.LogID ?? 0);
  writeTag(out, 3, 0); writeVarint(out, frame.service ?? 0);
  writeTag(out, 4, 0); writeVarint(out, frame.method ?? 0);
  for (const h of frame.headers || []) {
    const inner = [];
    writeBytes(inner, 1, utf8.encode(String(h.key ?? "")));
    writeBytes(inner, 2, utf8.encode(String(h.value ?? "")));
    writeBytes(out, 5, inner);
  }
  if (frame.payload_encoding) writeBytes(out, 6, utf8.encode(frame.payload_encoding));
  if (frame.payload_type) writeBytes(out, 7, utf8.encode(frame.payload_type));
  if (frame.payload) writeBytes(out, 8, frame.payload instanceof Uint8Array ? frame.payload : utf8.encode(String(frame.payload)));
  if (frame.LogIDNew) writeBytes(out, 9, utf8.encode(frame.LogIDNew));
  return Uint8Array.from(out);
}

function headerMap(frame) {
  const m = {};
  for (const h of frame.headers || []) m[h.key] = h.value;
  return m;
}

function sleep(ms, signalHolder) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
    if (signalHolder) signalHolder.wake = () => { clearTimeout(t); resolve(); };
  });
}

export class FeishuLongConnection {
  constructor({
    appId,
    appSecret,
    domain = "https://open.feishu.cn",
    onEvent,
    fetchFn = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    reconnectDelaysMs = FEISHU_RECONNECT_DELAYS_MS,
    logger = console,
  } = {}) {
    this.appId = String(appId || "");
    this.appSecret = String(appSecret || "");
    this.domain = String(domain || "https://open.feishu.cn").replace(/\/+$/, "");
    this.onEvent = onEvent;
    this.fetchFn = fetchFn;
    this.WebSocketImpl = WebSocketImpl;
    this.reconnectDelaysMs = reconnectDelaysMs;
    this.logger = logger;
    this.state = "idle";
    this.lastError = "";
    this.connectedAt = 0;
    this._running = false;
    this._ws = null;
    this._pingTimer = null;
    this._pingMs = DEFAULT_PING_MS;
    this._serviceId = 0;
    this._fragments = new Map();
    this._sleeper = {};
    this._loop = null;
  }

  status() {
    return { state: this.state, last_error: this.lastError, connected_at: this.connectedAt || null };
  }

  start() {
    if (this._running) return this._loop;
    if (typeof this.WebSocketImpl !== "function") {
      this.state = "error";
      this.lastError = "当前 Node 运行时没有内置 WebSocket";
      return null;
    }
    this._running = true;
    this._loop = this._runLoop();
    return this._loop;
  }

  async stop() {
    this._running = false;
    this._clearPing();
    this._sleeper.wake?.();
    try { this._ws?.close(); } catch {}
    this._ws = null;
    this.state = "idle";
    // 不等待正在进行的 endpoint 请求结束：循环在每个 await 之后都会检查 _running 并退出
    this._loop?.catch(() => {});
  }

  async _pullEndpoint() {
    const res = await this.fetchFn(`${this.domain}/callback/ws/endpoint`, {
      method: "POST",
      headers: { "Content-Type": "application/json", locale: "zh" },
      body: JSON.stringify({ AppID: this.appId, AppSecret: this.appSecret }),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    if (json?.code !== 0 || !json?.data?.URL) {
      throw new Error(`获取长连接地址失败: code=${json?.code ?? res.status} ${json?.msg || ""}`.trim());
    }
    const url = String(json.data.URL);
    const cfg = json.data.ClientConfig || {};
    const serviceId = Number(new URL(url).searchParams.get("service_id") || 0);
    const pingMs = Number(cfg.PingInterval) > 0 ? Number(cfg.PingInterval) * 1000 : DEFAULT_PING_MS;
    return { url, serviceId, pingMs };
  }

  async _runLoop() {
    let attempt = 0;
    while (this._running) {
      try {
        this.state = "connecting";
        const ep = await this._pullEndpoint();
        if (!this._running) break;
        this._serviceId = ep.serviceId;
        this._pingMs = ep.pingMs;
        await this._connectAndServe(ep.url, () => { attempt = 0; });
      } catch (err) {
        this.lastError = err?.message || String(err);
        this.logger.warn?.(`[feishu-ws] ${this.lastError}`);
      }
      if (!this._running) break;
      this.state = "reconnecting";
      const delays = this.reconnectDelaysMs;
      const wait = delays[Math.min(attempt, delays.length - 1)] ?? 5000;
      attempt += 1;
      await sleep(wait, this._sleeper);
    }
    this.state = "idle";
  }

  _connectAndServe(url, onOpen) {
    return new Promise((resolve, reject) => {
      let opened = false;
      let ws;
      try {
        ws = new this.WebSocketImpl(url);
      } catch (err) {
        reject(err);
        return;
      }
      ws.binaryType = "arraybuffer";
      this._ws = ws;
      ws.addEventListener("open", () => {
        opened = true;
        this.state = "connected";
        this.lastError = "";
        this.connectedAt = Date.now();
        onOpen?.();
        this._schedulePing();
      });
      ws.addEventListener("message", (ev) => {
        void this._onMessage(ev.data).catch((err) => {
          this.logger.warn?.(`[feishu-ws] 处理帧失败: ${err?.message || err}`);
        });
      });
      ws.addEventListener("error", (ev) => {
        if (!opened) this.lastError = ev?.message || ev?.error?.message || "长连接握手失败";
      });
      ws.addEventListener("close", (ev) => {
        this._clearPing();
        if (this._ws === ws) this._ws = null;
        if (opened) {
          if (this._running) this.lastError = `长连接断开 (code=${ev?.code ?? "-"})`;
          resolve();
        } else {
          reject(new Error(this.lastError || "长连接握手失败"));
        }
      });
    });
  }

  _clearPing() {
    if (this._pingTimer) clearTimeout(this._pingTimer);
    this._pingTimer = null;
  }

  _schedulePing() {
    this._clearPing();
    this._sendPing();
    this._pingTimer = setTimeout(() => this._schedulePing(), this._pingMs);
    if (typeof this._pingTimer.unref === "function") this._pingTimer.unref();
  }

  _sendPing() {
    this._send({ SeqID: 0, LogID: 0, service: this._serviceId, method: FRAME_CONTROL, headers: [{ key: "type", value: "ping" }] });
  }

  _send(frame) {
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(encodeFrame(frame));
    return true;
  }

  async _toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && typeof data.arrayBuffer === "function") return new Uint8Array(await data.arrayBuffer());
    throw new Error("未知的 WebSocket 消息类型");
  }

  async _onMessage(data) {
    const frame = decodeFrame(await this._toBytes(data));
    const headers = headerMap(frame);
    if (frame.method === FRAME_CONTROL) {
      if (headers.type === "pong" && frame.payload) {
        try {
          const cfg = JSON.parse(utf8d.decode(frame.payload));
          if (Number(cfg.PingInterval) > 0) this._pingMs = Number(cfg.PingInterval) * 1000;
        } catch {}
      }
      return;
    }
    if (frame.method !== FRAME_DATA || headers.type !== "event") return;

    const merged = this._mergeFragments(headers, frame.payload || new Uint8Array());
    if (!merged) return;

    const started = Date.now();
    const resp = { code: 200 };
    try {
      const payload = JSON.parse(utf8d.decode(merged));
      const result = await this.onEvent?.(payload);
      if (result) resp.data = Buffer.from(JSON.stringify(result), "utf8").toString("base64");
    } catch (err) {
      resp.code = 500;
      this.logger.warn?.(`[feishu-ws] 事件处理异常: ${err?.message || err}`);
    }
    this._send({
      ...frame,
      headers: [...frame.headers, { key: "biz_rt", value: String(Date.now() - started) }],
      payload: utf8.encode(JSON.stringify(resp)),
    });
  }

  // 大事件会被拆成 sum 片按 seq 下发，凑齐再处理。
  _mergeFragments(headers, payload) {
    const sum = Number(headers.sum || 1);
    if (!(sum > 1)) return payload;
    const now = Date.now();
    for (const [k, v] of this._fragments) {
      if (now - v.ts > FRAGMENT_TTL_MS) this._fragments.delete(k);
    }
    const id = String(headers.message_id || "");
    const entry = this._fragments.get(id) || { ts: now, parts: new Array(sum).fill(null) };
    const seq = Number(headers.seq || 0);
    if (seq >= 0 && seq < sum) entry.parts[seq] = payload;
    this._fragments.set(id, entry);
    if (entry.parts.some((p) => p === null)) return null;
    this._fragments.delete(id);
    const total = entry.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of entry.parts) { out.set(p, off); off += p.length; }
    return out;
  }
}
