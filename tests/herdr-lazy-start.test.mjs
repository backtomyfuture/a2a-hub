import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import * as herdr from '../src/herdr-socket.mjs';
import * as doctor from '../src/doctor.mjs';
import { HerdrRuntime } from '../src/herdr-runner.mjs';
import { herdrMethods } from '../src/kernel-herdr.mjs';

const delay = ms => new Promise(r => setTimeout(r, ms));
async function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-'));
  const socketPath = path.join(dir, 'api.sock'), requests = [], sockets = new Set(), calls = [];
  let server, unrefs = 0;
  async function listen({ protocol = 22, malformed = false, drop = false, silent = false, at = socketPath } = {}) {
    server = net.createServer(s => {
      sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s));
      let b = ''; s.on('data', chunk => {
        b += chunk; if (!b.includes('\n')) return;
        const r = JSON.parse(b.split('\n')[0]); b = ''; requests.push(r);
        if (drop) { s.destroy(); return; }
        if (silent) return;
        const result = r.method === 'ping' ? { type: 'pong', protocol, version: 'fake' }
          : r.method === 'events.subscribe' ? { type: 'subscription_started' }
          : r.method === 'session.snapshot' ? { type: 'session_snapshot', snapshot: { protocol, workspaces: [], tabs: [], panes: [], agents: [] } } : { type: 'ok' };
        s.write(malformed ? '{}\n' : JSON.stringify({ id: r.id, result }) + '\n');
        if (r.method !== 'events.subscribe') s.end();
      });
    });
    await new Promise((r, j) => { server.once('error', j); server.listen(at, r); });
  }
  function starter(start = () => listen()) {
    return (exe, argv, options) => {
      calls.push({ exe, argv, options });
      const child = new EventEmitter(); child.unref = () => unrefs++;
      queueMicrotask(() => { child.emit('spawn'); Promise.resolve(start(child)).catch(e => child.emit('error', e)); });
      return child;
    };
  }
  const serverOptions = { startTimeoutMs: 250, pollMs: 5, cooldownMs: 1000, spawn: starter() };
  const clients = [];
  const client = (extra = {}) => { const c = herdr.createHerdrSocket({ socketPath, env: {}, serverOptions, ...extra }); clients.push(c); return c; };
  try { await fn({ dir, socketPath, calls, requests, sockets, listen, starter, serverOptions, client, unrefs: () => unrefs, closeServer: async () => { for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)); server = null; } }); }
  finally { clients.forEach(c => c.close()); for (const s of sockets) s.destroy(); if (server) await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('lazy ENOENT: fixed socket argv/env, detached and unref, original request once', () => fixture(async f => {
  const c = f.client({ session: 'worker', env: { PATH: process.env.PATH, HERDR_SOCKET_PATH: '/wrong', HERDR_CLIENT_SOCKET_PATH: '/wrong-client', HERDR_SESSION: 'wrong', HERDR_STARTUP_CWD: '/wrong' } });
  assert.equal((await c.call('task.dispatch', {})).type, 'ok');
  assert.equal(f.calls.length, 1); assert.equal(f.unrefs(), 1);
  const { exe, argv, options } = f.calls[0]; assert.equal(exe, 'herdr'); assert.deepEqual(argv, ['server']);
  assert.equal(options.detached, true); assert.equal(options.stdio, 'ignore'); assert.equal(options.shell, false);
  assert.equal(options.env.HERDR_SOCKET_PATH, f.socketPath); assert.equal(options.env.HERDR_SESSION, 'worker');
  assert.equal(options.env.HERDR_CLIENT_SOCKET_PATH, undefined); assert.equal(options.env.HERDR_STARTUP_CWD, undefined);
  assert.equal(f.requests.filter(r => r.method === 'task.dispatch').length, 1);
}));

test('lazy ECONNREFUSED restores stale socket without client deleting it', () => fixture(async f => {
  const stale = spawnProcess(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(f.socketPath)},()=>process.exit(0))`]);
  await once(stale, 'exit'); assert.ok(fs.existsSync(f.socketPath));
  f.serverOptions.spawn = f.starter(() => { assert.ok(fs.existsSync(f.socketPath)); fs.unlinkSync(f.socketPath); return f.listen(); });
  assert.equal((await f.client().ping()).protocol, 22); assert.equal(f.calls.length, 1);
}));

test('running server incurs zero spawn', () => fixture(async f => {
  await f.listen(); await f.client().ping(); assert.equal(f.calls.length, 0);
}));

test('multiple clients, Control and Event share one startup; no recursive ping spawning', () => fixture(async f => {
  const a = f.client(), b = f.client();
  const [p, r] = await Promise.all([a.ping(), b.call('test'), b.events.start()]);
  assert.equal(p.protocol, 22); assert.equal(r.type, 'ok'); assert.equal(b.events.ready, true); assert.equal(f.calls.length, 1);
}));

for (const [label, starter, code] of [
  ['binary missing', ch => ch.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })), 'server_start_failed'],
  ['executable permission', ch => ch.emit('error', Object.assign(new Error('denied'), { code: 'EACCES' })), 'server_start_failed'],
  ['early exit', ch => ch.emit('exit', 7, null), 'server_start_failed'],
  ['never ready', () => {}, 'server_start_timeout'],
]) test(`lazy ${label}: normalized error, bounded one attempt`, () => fixture(async f => {
  f.serverOptions.spawn = f.starter(starter); f.serverOptions.startTimeoutMs = 55;
  const c = f.client(); await assert.rejects(c.call('task'), e => e.code === code && e.delivery === 'not_sent' && !!e.raw);
  await assert.rejects(c.call('task')); assert.equal(f.calls.length, 1);
}));

for (const [label, config, code] of [
  ['protocol mismatch', { protocol: 21 }, 'protocol_unsupported'],
  ['malformed ping', { malformed: true }, 'protocol_error'],
]) test(`lazy ${label} does not become ready or dispatch`, () => fixture(async f => {
  f.serverOptions.spawn = f.starter(() => f.listen(config));
  await assert.rejects(f.client().call('task'), e => e.code === code);
  assert.equal(f.requests.filter(r => r.method === 'task').length, 0); assert.equal(f.calls.length, 1);
}));

test('abort one waiter leaves shared startup alive for the other', () => fixture(async f => {
  f.serverOptions.spawn = f.starter(async () => { await delay(35); await f.listen(); });
  const a = f.client(), b = f.client(), ac = new AbortController();
  const aborted = a.call('a', {}, { signal: ac.signal });
  const result = b.call('b'); setTimeout(() => ac.abort(), 10);
  await assert.rejects(aborted, e => e.code === 'aborted' && e.delivery === 'not_sent');
  assert.equal((await result).type, 'ok'); assert.equal(f.calls.length, 1); assert.equal(f.requests.some(r => r.method === 'a'), false);
}));

test('original timeout includes recovery but does not cancel shared startup', () => fixture(async f => {
  f.serverOptions.spawn = f.starter(async () => { await delay(45); await f.listen(); });
  const c = f.client(); await assert.rejects(c.call('task', {}, { timeoutMs: 15 }), e => e.code === 'timeout');
  await delay(60); assert.equal(f.requests.some(r => r.method === 'task'), false); assert.equal(f.calls.length, 1);
}));

test('after-write disconnect is unknown: no spawn and no business replay', () => fixture(async f => {
  await f.listen({ drop: true });
  await assert.rejects(f.client().call('task'), e => e.delivery === 'unknown');
  assert.equal(f.calls.length, 0); assert.equal(f.requests.filter(r => r.method === 'task').length, 1);
}));

test('connected protocol error never triggers startup', () => fixture(async f => {
  await f.listen({ malformed: true }); await assert.rejects(f.client().call('task'), e => e.code === 'protocol_error');
  assert.equal(f.calls.length, 0);
}));

test('Event exhausted startup budget stays at one spawn and can passively reconnect', () => fixture(async f => {
  const c = f.client({ backoff: { baseMs: 5, maxMs: 10, jitter: 0.5 }, random: () => 0.5 }); await c.events.start();
  const diagnostics = [], fatal = []; c.events.on('subscribe_error', e => diagnostics.push(e)); c.events.on('fatal', e => fatal.push(e));
  await f.closeServer(); await until(() => diagnostics.length > 0 || fatal.length > 0);
  assert.equal(fatal.length, 0); assert.equal(diagnostics[0].code, 'server_start_limit'); assert.equal(f.calls.length, 1);
  await delay(25); assert.equal(f.calls.length, 1); assert.equal(c.events.ready, false);
  const reconnected = once(c.events, 'reconnected', { signal: AbortSignal.timeout(1000) }); await f.listen(); await reconnected;
  assert.equal(c.events.ready, true); assert.equal(f.calls.length, 1);
}));

test('stop Event waiter does not cancel Control shared startup', () => fixture(async f => {
  f.serverOptions.spawn = f.starter(async () => { await delay(30); await f.listen(); });
  const c = f.client(), b = f.client(); const ready = c.events.start(); const ping = b.ping();
  setTimeout(() => c.events.stop(), 8); await assert.rejects(ready); assert.equal((await ping).protocol, 22); assert.equal(f.calls.length, 1);
}));

test('autoStart false and ensure dry-run never spawn', () => fixture(async f => {
  const c = f.client({ autoStart: false }); await assert.rejects(c.ping(), e => e.raw?.code === 'ENOENT');
  await assert.rejects(c.ensureServerRunning({ autoStart: false })); assert.equal(f.calls.length, 0);
}));

test('doctor Herdr audit stays read-only while normal clients default to recovery', () => fixture(async f => {
  const marker = path.join(f.dir, 'unexpected-launch');
  fs.writeFileSync(path.join(f.dir, 'herdr'), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected');process.exit(1);`, { mode: 0o700 });
  const oldPath = process.env.PATH; process.env.PATH = f.dir;
  const old = console.log, lines = []; console.log = x => lines.push(x);
  try { assert.equal(await doctor.auditHerdrSocket(f.dir, { coder: { context: 'herdr' } }, { herdrSocketPath: f.socketPath }), 0); }
  finally { console.log = old; process.env.PATH = oldPath; }
  assert.equal(fs.existsSync(marker), false); assert.ok(lines.some(s => s.includes('只读'))); assert.equal(fs.existsSync(f.socketPath + '.ah-start.lock'), false);
}));

test('unknown relative socket, Windows offline and unverified named session fail closed', async () => {
  let spawned = 0;
  for (const opts of [{ socketPath: 'relative.sock' }, { socketPath: '/not-present/windows.sock', platform: 'win32' }]) {
    const c = herdr.createHerdrSocket({ ...opts, env: {}, serverOptions: { spawn: () => spawned++ } });
    try { await assert.rejects(c.ping(), e => e.code === 'server_start_unsupported'); } finally { c.close(); }
  }
  assert.throws(() => herdr.createHerdrSocket({ session: 'named', env: {} }), /named-session/); assert.equal(spawned, 0);
});

test('stale owner lock is fail-closed and never unlinked', () => fixture(async f => {
  const lock = f.socketPath + '.ah-start.lock'; fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647 }));
  f.serverOptions.startTimeoutMs = 35;
  await assert.rejects(f.client().ping(), e => e.code === 'server_start_locked');
  assert.equal(f.calls.length, 0); assert.ok(fs.existsSync(lock));
}));

test('real fake executable + two processes: one detached spawn, exact endpoint and cross-process cooldown', () => fixture(async f => {
  const exe = path.join(f.dir, 'fake-herdr'), record = path.join(f.dir, 'launches.jsonl');
  fs.writeFileSync(exe, `#!${process.execPath}\nconst fs=require('fs'),net=require('net');fs.appendFileSync(process.env.RECORD,JSON.stringify({pid:process.pid,argv:process.argv.slice(2),socket:process.env.HERDR_SOCKET_PATH})+'\\n');net.createServer(s=>s.once('data',b=>{let r=JSON.parse(b);s.end(JSON.stringify({id:r.id,result:{type:'pong',protocol:22,version:'fake'}})+'\\n')})).listen(process.env.HERDR_SOCKET_PATH);`, { mode: 0o700 });
  const url = pathToFileURL(path.resolve('src/herdr-socket.mjs')).href;
  const script = `import {ensureServerRunning} from ${JSON.stringify(url)};await ensureServerRunning(${JSON.stringify({ socketPath: f.socketPath, env: { PATH: process.env.PATH, RECORD: record }, executable: exe, startTimeoutMs: 2000, pollMs: 10 })});`;
  async function run() { const p = spawnProcess(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] }); let err='';p.stderr.on('data',b=>err+=b);const [code]=await once(p,'exit');assert.equal(code,0,err); }
  try {
    await Promise.all([run(), run()]); const rows=fs.readFileSync(record,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length,1); assert.deepEqual(rows[0].argv,['server']); assert.equal(rows[0].socket,f.socketPath);
    process.kill(rows[0].pid,'SIGTERM'); await delay(30);
    const c=f.client(); await assert.rejects(c.ping(),e=>e.code==='server_start_cooldown');assert.equal(f.calls.length,0);
  } finally { if(fs.existsSync(record))for(const r of fs.readFileSync(record,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)){try{process.kill(r.pid,'SIGTERM');}catch{}} }
}));


test('connected RPC timeout never triggers startup', () => fixture(async f => {
  await f.listen({ silent: true }); await assert.rejects(f.client().call('task', {}, { timeoutMs: 20 }), e => e.code === 'timeout' && e.delivery === 'unknown');
  assert.equal(f.calls.length, 0);
}));

test('socket permission denied is not a missing-server signal', t => fixture(async f => {
  t.mock.method(net, 'createConnection', () => {
    const socket = new EventEmitter(); socket.destroy = () => {};
    queueMicrotask(() => socket.emit('error', Object.assign(new Error('denied'), { code: 'EACCES' })));
    return socket;
  });
  await assert.rejects(f.client().call('task'), e => e.raw?.code === 'EACCES' && e.delivery === 'not_sent');
  assert.equal(f.calls.length, 0);
}));

test('existing non-Socket file is never deleted or passed to a starter', () => fixture(async f => {
  fs.writeFileSync(f.socketPath, 'owned file');
  await assert.rejects(f.client().ping(), e => e.code === 'server_start_unsupported' || e.raw?.code === 'ENOTSOCK');
  assert.equal(fs.readFileSync(f.socketPath, 'utf8'), 'owned file'); assert.equal(f.calls.length, 0);
}));

test('readiness ping timeout has normalized startup error and no business request', () => fixture(async f => {
  f.serverOptions.spawn = f.starter(() => f.listen({ silent: true })); f.serverOptions.startTimeoutMs = 45;
  await assert.rejects(f.client().call('task'), e => e.code === 'server_start_timeout' && e.delivery === 'not_sent' && !!e.raw);
  assert.equal(f.requests.some(r => r.method === 'task'), false); assert.equal(f.calls.length, 1);
}));

test('absolute override with symlink/.. keeps the exact endpoint, never lexical normalization', () => fixture(async f => {
  fs.mkdirSync(path.join(f.dir, 'inner', 'child'), { recursive: true });
  fs.symlinkSync(path.join(f.dir, 'inner', 'child'), path.join(f.dir, 'alias'));
  const target = f.dir + '/alias/../bound.sock';
  f.serverOptions.spawn = f.starter(() => f.listen({ at: target }));
  assert.equal((await f.client({ socketPath: target }).ping()).protocol, 22);
  assert.equal(f.calls[0].options.env.HERDR_SOCKET_PATH, target);
}));

test('close a waiting client never replays its request or kills shared startup', () => fixture(async f => {
  f.serverOptions.spawn = f.starter(async () => { await delay(30); await f.listen(); });
  const c = f.client(), b = f.client(), request = c.call('closed-task'); const ping = b.ping();
  setTimeout(() => c.close(), 10); await assert.rejects(request); assert.equal((await ping).protocol, 22);
  assert.equal(f.requests.some(r => r.method === 'closed-task'), false); assert.equal(f.calls.length, 1);
}));

test('Event reconnect from an initially running server can use its one recovery', () => fixture(async f => {
  await f.listen(); const c = f.client({ backoff: { baseMs: 1, maxMs: 2, jitter: 0 } });
  await c.events.start(); assert.equal(f.calls.length, 0);
  const reconnected = once(c.events, 'reconnected'); await f.closeServer(); await reconnected;
  assert.equal(c.events.ready, true); assert.equal(f.calls.length, 1);
}));

test('safe original request retry is exactly once even if second connection also fails', t => fixture(async f => {
  const original = net.createConnection; let connections = 0, recovered = 0;
  t.mock.method(net, 'createConnection', (...args) => { connections++; return original(...args); });
  const c = new herdr.HerdrControl({ socketPath: f.socketPath, recover: async () => { recovered++; } });
  try { await assert.rejects(c.call('task'), e => e.raw?.code === 'ENOENT' && e.delivery === 'not_sent'); }
  finally { c.close(); }
  assert.equal(connections, 2); assert.equal(recovered, 1);
}));

test('ECONNREFUSED after write is unknown and never triggers recovery', t => fixture(async f => {
  let writes = 0;
  t.mock.method(net, 'createConnection', () => {
    const socket = new EventEmitter(); socket.destroy = () => {};
    socket.write = () => { writes++; queueMicrotask(() => socket.emit('error', Object.assign(new Error('post-write'), { code: 'ECONNREFUSED' }))); };
    queueMicrotask(() => socket.emit('connect')); return socket;
  });
  await assert.rejects(f.client().call('task'), e => e.raw?.code === 'ECONNREFUSED' && e.delivery === 'unknown');
  assert.equal(writes, 1); assert.equal(f.calls.length, 0);
}));

test('connect timeout without ENOENT/ECONNREFUSED never starts a server', t => fixture(async f => {
  t.mock.method(net, 'createConnection', () => { const s = new EventEmitter(); s.destroy = () => {}; return s; });
  await assert.rejects(f.client({ connectTimeoutMs: 10 }).call('task'), e => e.code === 'server_unavailable' && !e.raw);
  assert.equal(f.calls.length, 0);
}));

test('queued recovery waiters respect maxInflight', () => fixture(async f => {
  f.serverOptions.spawn = f.starter(async () => { await delay(30); await f.listen(); });
  const c = f.client({ maxInflight: 1 }); const first = c.call('first');
  await assert.rejects(c.call('second'), e => e.code === 'client_overloaded'); await first;
  assert.equal(c.control.inflightCount, 0); assert.equal(f.calls.length, 1);
}));

test('dangling socket symlink is left untouched, not handed to Herdr cleanup', () => fixture(async f => {
  fs.symlinkSync(path.join(f.dir, 'missing.sock'), f.socketPath);
  await assert.rejects(f.client().ping(), e => e.code === 'server_start_unsupported');
  assert.ok(fs.lstatSync(f.socketPath).isSymbolicLink()); assert.equal(f.calls.length, 0);
}));

test('recovery retries the originally encoded request, not a caller-mutated object', () => fixture(async f => {
  const params = { value: 'original' };
  f.serverOptions.spawn = f.starter(() => { params.value = 'mutated-during-start'; return f.listen(); });
  await f.client().call('task', params);
  assert.deepEqual(f.requests.find(r => r.method === 'task').params, { value: 'original' });
}));

for (const [name, executableMode, code] of [['missing', null, 'ENOENT'], ['nonexecutable', 0o600, 'EACCES']]) {
  test(`real child_process async ${name} error is normalized without running Herdr`, () => fixture(async f => {
    const executable = path.join(f.dir, 'never-a-real-herdr');
    if (executableMode) fs.writeFileSync(executable, 'fake', { mode: executableMode });
    await assert.rejects(herdr.ensureServerRunning({ socketPath: f.socketPath, executable, env: {}, startTimeoutMs: 100, pollMs: 5 }), e => e.code === 'server_start_failed' && e.raw?.code === code);
    assert.equal(fs.existsSync(f.socketPath + '.ah-start.lock'), false);
  }));
}


for (const session of ['.', '..']) test(`reserved session ${session} fails closed before spawn`, () => fixture(async f => {
  await assert.rejects(f.client({ session }).ping(), e => e.code === 'server_start_unsupported');
  assert.equal(f.calls.length, 0);
}));

async function until(predicate, timeoutMs = 1000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) { if (performance.now() >= deadline) assert.fail('condition did not become true'); await delay(2); }
}
function kernelWithRuntime(client) {
  const runtime = new HerdrRuntime({ socket: client });
  const kernel = { ...herdrMethods, _herdrRuntime: runtime, _herdrRuntimeReady: runtime.start() };
  // Observe early rejection so a failing-before test still cleans up deterministically.
  kernel._herdrRuntimeReady.catch(() => {});
  return { runtime, kernel };
}

test('initial recovery failure stays observable but Kernel initialization completes after external ACK/snapshot', () => fixture(async f => {
  f.serverOptions.spawn = f.starter(ch => ch.emit('error', Object.assign(new Error('fake missing executable'), { code: 'ENOENT' })));
  const c = f.client({ backoff: { baseMs: 2, maxMs: 6, jitter: 0.5 }, random: () => 0.5 });
  const diagnostics = [], fatal = []; c.events.on('subscribe_error', e => diagnostics.push(e)); c.events.on('fatal', e => fatal.push(e));
  const { runtime, kernel } = kernelWithRuntime(c);
  let initialized = false; const ready = kernel.ensureHerdrRuntime().then(rt => { initialized = true; return rt; }); ready.catch(() => {});
  try {
    await until(() => diagnostics.some(e => e.code === 'server_start_failed') || fatal.length > 0);
    assert.equal(fatal.length, 0, 'ordinary unavailable startup must not poison initial readiness');
    await delay(20); assert.equal(initialized, false); assert.equal(f.calls.length, 1); assert.equal(c.events.ready, false);
    await f.listen();
    assert.equal(await Promise.race([ready, delay(1000).then(() => { throw new Error('Kernel never recovered'); })]), runtime);
    assert.equal(c.events.ready, true); assert.equal(runtime.stale, false); assert.equal(f.calls.length, 1);
    assert.ok(f.requests.findIndex(r => r.method === 'events.subscribe') < f.requests.findIndex(r => r.method === 'session.snapshot'));
  } finally { runtime.stop(); }
}));

test('once-ready Runtime passively reconnects and resyncs generation after failed recovery, without more spawn', () => fixture(async f => {
  await f.listen();
  f.serverOptions.spawn = f.starter(ch => ch.emit('exit', 7, null));
  const c = f.client({ backoff: { baseMs: 2, maxMs: 6, jitter: 0.5 }, random: () => 0.5 });
  const diagnostics = [], fatal = []; c.events.on('subscribe_error', e => diagnostics.push(e)); c.events.on('fatal', e => fatal.push(e));
  const { runtime, kernel } = kernelWithRuntime(c);
  try {
    await kernel.ensureHerdrRuntime(); const generation = c.events.generation;
    await f.closeServer();
    await until(() => diagnostics.some(e => e.code === 'server_start_failed') || fatal.length > 0);
    assert.equal(fatal.length, 0); await delay(20); assert.equal(f.calls.length, 1); assert.equal(runtime.stale, true);
    const resynced = once(runtime, 'resynced', { signal: AbortSignal.timeout(1000) }); await f.listen(); await resynced;
    assert.equal(c.events.ready, true); assert.ok(c.events.generation > generation); assert.equal(runtime.stale, false);
    assert.equal(await kernel.ensureHerdrRuntime(), runtime); assert.equal(f.calls.length, 1);
  } finally { runtime.stop(); }
}));

test('close during passive recovery rejects pending Kernel readiness and never revives', () => fixture(async f => {
  f.serverOptions.spawn = f.starter(ch => ch.emit('exit', 9, null));
  const c = f.client({ backoff: { baseMs: 2, maxMs: 6, jitter: 0 } });
  const diagnostics = [], fatal = []; c.events.on('subscribe_error', e => diagnostics.push(e)); c.events.on('fatal', e => fatal.push(e));
  const { runtime, kernel } = kernelWithRuntime(c);
  try {
    await until(() => diagnostics.length > 0 || fatal.length > 0); assert.equal(fatal.length, 0);
    c.close(); await assert.rejects(kernel.ensureHerdrRuntime(), e => e.code === 'connection_closed');
    const count = f.requests.length; await f.listen(); await delay(25);
    assert.equal(c.events.ready, false); assert.equal(f.requests.length, count); assert.equal(f.calls.length, 1);
    await assert.rejects(c.events.start(), e => e.code === 'connection_closed');
  } finally { runtime.stop(); }
}));


for (const [label, start, code] of [
  ['permission denied executable', (f, ch) => ch.emit('error', Object.assign(new Error('denied'), { code: 'EACCES' })), 'server_start_failed'],
  ['invalid startup filesystem', (f, ch) => ch.emit('error', Object.assign(new Error('bad path'), { code: 'ENOTDIR' })), 'server_start_failed'],
  ['unsupported readiness protocol', f => f.listen({ protocol: 21 }), 'protocol_unsupported'],
  ['malformed readiness protocol', f => f.listen({ malformed: true }), 'protocol_error'],
]) test(`Event permanent ${label} fails clearly instead of entering passive retry`, () => fixture(async f => {
  f.serverOptions.spawn = f.starter(ch => start(f, ch));
  const c = f.client({ backoff: { baseMs: 2, maxMs: 5, jitter: 0 } }), fatal = [];
  c.events.on('fatal', e => fatal.push(e));
  await assert.rejects(c.events.start(), e => e.code === code);
  assert.equal(fatal.length, 1); const requests = f.requests.length;
  await delay(15); assert.equal(f.requests.length, requests); assert.equal(f.calls.length, 1);
  await assert.rejects(c.events.start(), e => e.code === 'connection_closed');
}));

test('Event initial Socket permission failure is terminal and never starts a process', t => fixture(async f => {
  t.mock.method(net, 'createConnection', () => {
    const s = new EventEmitter(); s.destroy = () => {}; s.setKeepAlive = () => {};
    queueMicrotask(() => s.emit('error', Object.assign(new Error('denied'), { code: 'EACCES' })));
    return s;
  });
  const c = f.client(); await assert.rejects(c.events.start(), e => e.raw?.code === 'EACCES'); assert.equal(f.calls.length, 0);
}));

test('closing synchronously in recovery diagnostic creates no new backoff timer', t => fixture(async f => {
  f.serverOptions.spawn = f.starter(ch => ch.emit('exit', 1, null));
  const c = f.client({ backoff: { baseMs: 5000, maxMs: 5000, jitter: 0 } });
  const original = globalThis.setTimeout, longTimers = []; let closed = false;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    const timer = original(fn, ms, ...args); if (closed && ms >= 5000) longTimers.push(timer); return timer;
  });
  c.events.on('subscribe_error', () => { closed = true; c.close(); });
  try { await assert.rejects(c.events.start(), e => e.code === 'connection_closed'); assert.equal(longTimers.length, 0); }
  finally { longTimers.forEach(clearTimeout); }
}));

for (const mode of ['timeout', 'locked', 'cooldown']) test(`Event ${mode} startup remains passive and recovers externally without another spawn`, () => fixture(async f => {
  f.serverOptions.startTimeoutMs = 35;
  f.serverOptions.spawn = f.starter(() => {});
  if (mode === 'locked') fs.writeFileSync(f.socketPath + '.ah-start.lock', JSON.stringify({ pid: 2147483647 }));
  if (mode === 'cooldown') fs.writeFileSync(f.socketPath + '.ah-start.attempt.json', JSON.stringify({ at: Date.now() }));
  const c = f.client({ backoff: { baseMs: 2, maxMs: 6, jitter: 0.5 }, random: () => 0.5 }), diagnostics = [], fatal = [];
  c.events.on('subscribe_error', e => diagnostics.push(e)); c.events.on('fatal', e => fatal.push(e));
  const ready = c.events.start(); ready.catch(() => {});
  await until(() => diagnostics.some(e => e.code === `server_start_${mode}`) || fatal.length > 0);
  assert.equal(fatal.length, 0); const spawns = mode === 'timeout' ? 1 : 0;
  assert.equal(f.calls.length, spawns); await delay(15); assert.equal(f.calls.length, spawns);
  await f.listen(); await Promise.race([ready, delay(1000).then(() => { throw new Error('passive reconnect never ACKed'); })]);
  assert.equal(c.events.ready, true); assert.equal(f.calls.length, spawns);
}));

for (const session of ['.', '..']) test(`Event reserved session ${session} rejects initial readiness with zero spawn`, () => fixture(async f => {
  const c = f.client({ session });
  await assert.rejects(c.events.start(), e => e.code === 'server_start_unsupported'); assert.equal(f.calls.length, 0);
}));

test('passive retry preserves bounded exponential jittered frequency, not a busy loop', () => fixture(async f => {
  f.serverOptions.spawn = f.starter(ch => ch.emit('exit', 2, null));
  const attempts = [];
  const c = f.client({ backoff: { baseMs: 40, maxMs: 80, factor: 2, jitter: 0.5 }, random: () => { attempts.push(performance.now()); return 0.5; } });
  const ready = c.events.start(); ready.catch(() => {});
  await until(() => attempts.length >= 3);
  // Expected sleeps are 30ms, then 60ms; generous lower bounds tolerate timer resolution.
  assert.ok(attempts[1] - attempts[0] >= 20); assert.ok(attempts[2] - attempts[1] >= 40);
  assert.equal(f.calls.length, 1); c.close(); await assert.rejects(ready, e => e.code === 'connection_closed');
}));

test('Event synchronous invalid Socket configuration is terminal, not passive retry', t => fixture(async f => {
  t.mock.method(net, 'createConnection', () => { throw Object.assign(new TypeError('invalid socket option'), { code: 'ERR_INVALID_ARG_VALUE' }); });
  const c = f.client(); const limit = setTimeout(() => c.close(), 35);
  try { await assert.rejects(c.events.start(), e => e.raw?.code === 'ERR_INVALID_ARG_VALUE'); assert.equal(f.calls.length, 0); }
  finally { clearTimeout(limit); }
}));
