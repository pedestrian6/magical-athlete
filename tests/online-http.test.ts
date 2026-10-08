import { afterEach, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { io, type Socket } from 'socket.io-client';
import { createOnlineServer } from '../server/http';
import type { ActionInput } from '../src/game/types';
import type { CommandAck, RoomCommand, RoomCommandInput, RoomView, SeatAccess } from '../src/session/protocol';

const ORIGIN = 'http://localhost.test';
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

interface Browser { cookie: string }
interface Peer {
  socket: Socket;
  view: RoomView;
  received: RoomView[];
  wait(predicate: (view: RoomView) => boolean): Promise<RoomView>;
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'athlete-http-'));
  const staticDir = join(dir, 'static');
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>test application</title>');
  const app = createOnlineServer({ database: join(dir, 'rooms.sqlite'), origin: ORIGIN, staticDir, tickMs: 100 });
  const sockets: Socket[] = [];
  disposals.push(async () => {
    for (const socket of sockets) { socket.removeAllListeners(); socket.disconnect(); socket.io.engine?.close(); }
    await app.close();
    app.server.closeAllConnections();
    expect(app.server.listening).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', () => { app.server.off('error', reject); resolve(); });
  });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server port');
  const base = `http://127.0.0.1:${address.port}`;

  async function request(browser: Browser, path: string, input?: unknown, origin: string | null = ORIGIN) {
    const response = await fetch(`${base}${path}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { ...(origin ? { Origin: origin } : {}), ...(browser.cookie ? { Cookie: browser.cookie } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: AbortSignal.timeout(5000),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) browser.cookie = setCookie.split(';')[0];
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  async function browser() {
    const browser: Browser = { cookie: '' };
    const response = await request(browser, '/api/session');
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict; Path=\//);
    expect(response.body).toEqual({ rooms: [] });
    return browser;
  }
  function socketFor(browser: Browser, code: string, transport: 'websocket' | 'polling' = 'websocket', origin = ORIGIN) {
    const socket = io(base, {
      autoConnect: false, reconnection: false, forceNew: true, transports: [transport],
      auth: { roomCode: code, pageId: randomUUID(), claim: true }, extraHeaders: { Cookie: browser.cookie, Origin: origin }, timeout: 3000,
    });
    sockets.push(socket);
    return socket;
  }
  async function connect(browser: Browser, code: string, transport: 'websocket' | 'polling' = 'websocket'): Promise<Peer> {
    const socket = socketFor(browser, code, transport);
    const received: RoomView[] = [];
    let latest: RoomView | undefined;
    socket.on('room', (view: RoomView) => { latest = view; received.push(view); });
    const peer: Peer = {
      socket, received,
      get view() { if (!latest) throw new Error('no room snapshot'); return latest; },
      wait(predicate) {
        if (latest && predicate(latest)) return Promise.resolve(latest);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { cleanup(); reject(new Error(`room snapshot deadline exceeded: transport=${transport} connected=${socket.connected} snapshots=${received.length} revision=${latest?.revision} online=${latest?.seats.map(s => s.online).join(',')}`)); }, 5000);
          const cleanup = () => { clearTimeout(timer); socket.off('room', check); socket.off('revoked', revoked); socket.off('connect_error', failed); };
          function check(view: RoomView) { if (predicate(view)) { cleanup(); resolve(view); } }
          function revoked(value: { reason: string }) { cleanup(); reject(new Error(value.reason)); }
          function failed(error: Error) { cleanup(); reject(error); }
          socket.on('room', check); socket.once('revoked', revoked); socket.once('connect_error', failed);
        });
      },
    };
    const initial = peer.wait(() => true);
    const connecting = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('socket connection deadline exceeded')); }, 5000);
      const cleanup = () => { clearTimeout(timer); socket.off('connect', connected); socket.off('connect_error', failed); };
      const connected = () => { cleanup(); resolve(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      socket.once('connect', connected); socket.once('connect_error', failed);
    });
    socket.connect();
    await Promise.all([initial, connecting]);
    return peer;
  }
  async function rejectedSocket(browser: Browser, code: string, origin = ORIGIN) {
    const socket = socketFor(browser, code, 'websocket', origin);
    const error = event<Error>(socket, 'connect_error');
    socket.connect();
    await error;
    expect(socket.connected).toBe(false);
    socket.disconnect();
  }
  async function room(transport: 'websocket' | 'polling' = 'websocket') {
    const browsers = await Promise.all([browser(), browser()]);
    const created = await request(browsers[0], '/api/rooms', { name: '房主', capacity: 2, duo: true });
    expect(created.status).toBe(201);
    const code = created.body.code as string;
    const joined = await request(browsers[1], `/api/rooms/${code}/join`, { name: '朋友' });
    expect(joined.status).toBe(200);
    const peers = await Promise.all(browsers.map(b => connect(b, code, transport)));
    await Promise.all(peers.map(p => p.wait(v => v.seats.every(s => s.online))));
    return { code, browsers, peers, accesses: [created.body, joined.body] as SeatAccess[] };
  }
  return { app, base, browser, request, connect, rejectedSocket, room };
}

function event<T>(socket: Socket, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, receive); reject(new Error(`event ${name} deadline exceeded`)); }, 5000);
    function receive(value: T) { clearTimeout(timer); socket.off(name, receive); resolve(value); }
    socket.once(name, receive);
  });
}
function command(peer: Peer, input: RoomCommandInput): RoomCommand {
  return { ...input, protocolVersion: 1, id: randomUUID(), roomCode: peer.view.code };
}
async function send(peer: Peer, cmd: RoomCommand): Promise<CommandAck> {
  return await peer.socket.timeout(5000).emitWithAck('command', cmd) as CommandAck;
}
function gameCommand(peer: Peer, action: ActionInput): RoomCommand {
  const g = peer.view.game!;
  return command(peer, { type: 'game', gameId: g.id, revision: g.revision, race: g.race, action });
}
async function success(peers: Peer[], actor: number, cmd: RoomCommand, timings?: number[]) {
  const start = performance.now();
  const ack = await send(peers[actor], cmd);
  timings?.push(performance.now() - start);
  expect(ack.ok).toBe(true);
  if (!ack.ok) throw new Error(ack.error);
  await Promise.all(peers.filter(p => p.socket.connected).map(p => p.wait(v => v.revision >= ack.revision)));
  return ack;
}
async function begin(peers: Peer[]) {
  for (let i = 0; i < peers.length; i++) await success(peers, i, command(peers[i], { type: 'ready', ready: true }));
  await success(peers, 0, command(peers[0], { type: 'start' }));
}
function next(peers: Peer[]): { actor: number; action: ActionInput } {
  const g = peers[0].view.game!;
  if (g.phase === 'draft') return { actor: g.draftOrder[g.draftIndex], action: { type: 'draft', racerId: g.market[0] } };
  if (g.phase === 'selection') {
    const player = g.players.find(p => !g.lockedPlayerIds.includes(p.id))!;
    return { actor: player.id, action: { type: 'select', playerId: player.id, racerIds: player.team.filter(id => !player.used.includes(id)).slice(0, g.duo ? 2 : 1) } };
  }
  if (g.phase === 'reveal') return { actor: 0, action: { type: 'reveal' } };
  if (g.phase === 'raceEnd') return { actor: 0, action: { type: 'nextRace' } };
  if (g.pending) {
    const actor = g.pending.playerId, decision = peers[actor].view.game!.pending!;
    const option = decision.options.find(o => o.id === 'skip' || o.id === 'keep') ?? decision.options[0];
    return { actor, action: { type: 'choose', decisionId: decision.id, optionId: option.id } };
  }
  return { actor: g.racers.find(r => r.id === g.turn?.actor)!.playerId, action: { type: g.paused ? 'continue' : 'roll' } };
}

describe('real HTTP and Socket.IO transports', () => {
  test('enforces origin, authenticated seat, host and cross-room permissions', async () => {
    const f = await fixture(), r = await f.room(), outsider = await f.browser();
    const deniedOrigin = await f.request(outsider, '/api/rooms', { name: '陌生人', capacity: 2, duo: true }, 'https://other.example');
    expect(deniedOrigin.status).toBe(403); expect(deniedOrigin.body.code).toBe('ORIGIN');
    expect((await f.request(outsider, '/api/rooms', { name: '陌生人', capacity: 2, duo: true }, null)).status).toBe(403);
    await f.rejectedSocket(outsider, r.code);
    await f.rejectedSocket(r.browsers[0], r.code, 'https://other.example');
    expect(await send(r.peers[1], command(r.peers[1], { type: 'configure', capacity: 3, duo: false }))).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    const other = await f.request(outsider, '/api/rooms', { name: '其他房主', capacity: 2, duo: true });
    const cross = { ...command(r.peers[0], { type: 'ready', ready: true }), roomCode: other.body.code };
    expect(await send(r.peers[0], cross)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    const health = await fetch(`${f.base}/healthz`); expect(health.ok).toBe(true); await health.arrayBuffer();
    const page = await fetch(`${f.base}/`); expect(await page.text()).toContain('test application');
    await begin(r.peers);
    const g = r.peers[0].view.game!, owner = g.draftOrder[g.draftIndex], wrong = 1 - owner;
    expect(await send(r.peers[wrong], gameCommand(r.peers[wrong], { type: 'draft', racerId: g.market[0] }))).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  test('wire snapshots conceal secrets and accept simultaneous locks without duplicate execution', async () => {
    const f = await fixture(), r = await f.room();
    await begin(r.peers);
    while (r.peers[0].view.game!.phase === 'draft') {
      const a = next(r.peers); await success(r.peers, a.actor, gameCommand(r.peers[a.actor], a.action));
    }
    const g = r.peers[0].view.game!, order = g.players.map(p => [...p.team].reverse().slice(0, 2));
    const locks = r.peers.map((p, i) => gameCommand(p, { type: 'select', playerId: i, racerIds: order[i] }));
    const wrong = gameCommand(r.peers[0], { type: 'select', playerId: 1, racerIds: order[1] });
    expect(await send(r.peers[0], wrong)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    const ack = await success(r.peers, 0, locks[0]);
    expect(r.peers[0].view.game!.selections[0]).toEqual(order[0]);
    expect(r.peers[1].view.game!.selections).toEqual({});
    expect(r.peers[1].view.game!.lockedPlayerIds).toEqual([0]);
    expect(r.peers[1].view.game!.players[0].used).not.toEqual(expect.arrayContaining(order[0]));
    expect(await send(r.peers[0], locks[0])).toEqual(ack);
    expect(await send(r.peers[0], { ...locks[0], id: randomUUID() })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    await success(r.peers, 1, locks[1]); // deliberately uses the pre-lock revision
    expect(r.peers[0].view.game!.phase).toBe('reveal');
    expect(r.peers[1].view.game!.selections).toEqual({ 0: order[0], 1: order[1] });
    for (const peer of r.peers) for (const view of peer.received) {
      const wire = JSON.stringify(view);
      expect(wire).not.toMatch(/"(?:rng|deck|queue|task|chainSeen|processedActions|recoveryHash|sessionHash|draws)":/);
      expect(wire).not.toContain(r.accesses[0].recoveryCode);
      expect(wire).not.toContain(r.accesses[1].recoveryCode);
      if (view.game) expect(view.game.id).not.toMatch(/^game-\d+$/);
    }
  });

  test('polling refresh keeps the seat; recovery rotates credentials and revokes all old control', async () => {
    const f = await fixture(), r = await f.room('polling');
    await success(r.peers, 1, command(r.peers[1], { type: 'ready', ready: true }));
    const seat = r.peers[1].view.viewerSeatId;
    r.peers[1].socket.disconnect();
    const refreshed = await f.connect(r.browsers[1], r.code, 'polling');
    expect(refreshed.view.viewerSeatId).toBe(seat);
    expect(refreshed.view.seats.find(s => s.id === seat)?.ready).toBe(true);
    expect((await f.request(r.browsers[1], '/api/session')).body.rooms).toEqual(expect.arrayContaining([expect.objectContaining({ code: r.code })]));
    const duplicateRevoked = event<{ reason: string }>(refreshed.socket, 'revoked');
    const duplicateDisconnected = event<string>(refreshed.socket, 'disconnect');
    const newest = await f.connect(r.browsers[1], r.code);
    expect((await duplicateRevoked).reason).toContain('另一个页面');
    await duplicateDisconnected;
    expect(refreshed.socket.connected).toBe(false);
    refreshed.socket.auth = { ...refreshed.socket.auth, claim: false };
    const staleRevoked = event<{ reason: string }>(refreshed.socket, 'revoked');
    const staleDisconnected = event<string>(refreshed.socket, 'disconnect');
    refreshed.socket.connect();
    expect((await staleRevoked).reason).toContain('另一个页面');
    await staleDisconnected;
    expect(newest.socket.connected).toBe(true);
    const browser2 = await f.browser(), recoveryRevoked = event<{ reason: string }>(newest.socket, 'revoked');
    const recovered = await f.request(browser2, `/api/rooms/${r.code}/recover`, { recoveryCode: r.accesses[1].recoveryCode });
    expect(recovered.status).toBe(200); expect(recovered.body.recoveryCode).not.toBe(r.accesses[1].recoveryCode);
    expect((await recoveryRevoked).reason).toContain('另一台设备');
    await f.rejectedSocket(r.browsers[1], r.code);
    expect((await f.request(r.browsers[1], `/api/rooms/${r.code}/recover`, { recoveryCode: r.accesses[1].recoveryCode })).status).toBe(403);
    const restored = await f.connect(browser2, r.code);
    expect(restored.view.viewerSeatId).toBe(seat);
    await success([r.peers[0], restored], 1, command(restored, { type: 'ready', ready: false }));
    expect(restored.view.seats.find(s => s.id === seat)?.ready).toBe(false);
  }, 15_000);

  test('five concurrent two-seat rooms report real command ack latency and sampled process memory', async () => {
    const f = await fixture();
    const rooms = await Promise.all(Array.from({ length: 5 }, () => f.room()));
    const timings: number[] = [];
    let peakRss = process.memoryUsage().rss, peakHeap = process.memoryUsage().heapUsed;
    const sample = () => { const memory = process.memoryUsage(); peakRss = Math.max(peakRss, memory.rss); peakHeap = Math.max(peakHeap, memory.heapUsed); };
    const timer = setInterval(sample, 20);
    const started = performance.now();
    try {
      await Promise.all(rooms.map(async ({ peers }) => {
        await begin(peers);
        for (let i = 0; i < 60 && peers[0].view.game!.phase !== 'gameEnd'; i++) {
          const a = next(peers);
          await success(peers, a.actor, gameCommand(peers[a.actor], a.action), timings);
          sample();
        }
        expect(peers[0].view.game!.revision).toBeGreaterThan(30);
        expect(peers[0].view.game!.revision).toBe(peers[1].view.game!.revision);
      }));
    } finally { clearInterval(timer); sample(); }
    expect(timings.length).toBeGreaterThanOrEqual(200);
    const sorted = [...timings].sort((a, b) => a - b);
    console.log(JSON.stringify({ benchmark: 'five-room-socket-io', rooms: 5, clients: 10, acceptedCommands: timings.length, meanAckMs: Number((timings.reduce((a, b) => a + b, 0) / timings.length).toFixed(2)), p95AckMs: Number(sorted[Math.ceil(sorted.length * .95) - 1].toFixed(2)), elapsedMs: Math.round(performance.now() - started), sampledPeakRssMiB: Number((peakRss / 1024 / 1024).toFixed(2)), sampledPeakHeapMiB: Number((peakHeap / 1024 / 1024).toFixed(2)), measurement: 'same-process test server and ten clients; not production capacity' }));
  }, 30_000);
});
