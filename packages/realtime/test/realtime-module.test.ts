// RealtimeModule kernel tests — attach, authenticate, broadcast, subscribe.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { RealtimeModule, encodeMaskedFrame, decodeFrames, Opcode, acceptKey } from '../src/index.js';
import type { PrincipalLike } from '../src/index.js';

function wsClient(port: number, path: string, token?: string): Promise<{ send: (d: string) => void; recv: () => Promise<string>; sock: net.Socket; close: () => void }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    sock.once('connect', () => {
      const key = Buffer.from(Math.random().toString(36).slice(2)).toString('base64').slice(0, 16);
      const qs = token ? `?token=${token}` : '';
      sock.write(`GET ${path}${qs} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.once('error', reject);
    let buf: Buffer = Buffer.alloc(0);
    let upgraded = false;
    const pending: string[] = [];
    const waiters: Array<() => void> = [];
    const drain = (): void => { while (pending.length > 0 && waiters.length > 0) waiters.shift()!(); };
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) { const idx = buf.indexOf('\r\n\r\n'); if (idx >= 0) { upgraded = true; buf = buf.subarray(idx + 4); } else return; }
      const { frames, rest } = decodeFrames(buf); buf = rest;
      for (const f of frames) {
        if (f.opcode === Opcode.TEXT) pending.push(f.payload.toString());
        // Keepalive: auto-respond to server pings (RFC 6455 §5.5.2).
        if (f.opcode === Opcode.PING) sock.write(encodeMaskedFrame(Opcode.PONG, f.payload));
      }
      drain();
    });
    resolve({
      send: (d: string) => sock.write(encodeMaskedFrame(Opcode.TEXT, Buffer.from(d))),
      recv: () => new Promise<string>((res) => { if (pending.length > 0) res(pending.shift()!); else waiters.push(() => res(pending.shift()!)); }),
      sock, close: () => sock.destroy(),
    });
  });
}

describe('RealtimeModule', () => {
  let kernel: Kernel;
  let server: http.Server;
  let port: number;
  let mod: RealtimeModule;

  before(async () => {
    kernel = createTestKernel();
    mod = new RealtimeModule();
    kernel.register(mod);
    await kernel.boot();
    server = http.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    mod.attach(server, {
      authenticate: async (token) => (token === 'valid' ? { userId: 'u1', username: 'alice', roles: ['developer'] } as PrincipalLike : undefined),
      eventTypes: ['test.event'],
    });
  });

  after(async () => { await kernel.shutdown(); server.closeAllConnections?.(); await new Promise<void>((r) => server.close(() => r())); });

  it('rejects an unauthenticated upgrade (HTTP 401)', async () => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    await new Promise<void>((r) => sock.once('connect', r));
    const key = Buffer.from(Math.random().toString(36).slice(2)).toString('base64').slice(0, 16);
    sock.write(`GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    const resp = await new Promise<string>((r) => sock.once('data', (d) => r(d.toString())));
    assert.ok(resp.startsWith('HTTP/1.1 401'));
    sock.destroy();
  });

  it('accepts an authenticated upgrade and sends a connected event', async () => {
    const c = await wsClient(port, '/ws', 'valid');
    const msg = await c.recv();
    const parsed = JSON.parse(msg) as { type: string; data: { clientCount: number } };
    assert.equal(parsed.type, 'realtime.connected');
    assert.ok(parsed.data.clientCount >= 1);
    c.close();
  });

  it('broadcasts events to connected clients', async () => {
    const c = await wsClient(port, '/ws', 'valid');
    await c.recv(); // consume the connected event
    mod.broadcast('test.event', { hello: 'world' });
    const msg = await c.recv();
    const parsed = JSON.parse(msg) as { type: string; data: { hello: string } };
    assert.equal(parsed.type, 'test.event');
    assert.equal(parsed.data.hello, 'world');
    c.close();
  });

  it('respects client topic subscriptions', async () => {
    const c = await wsClient(port, '/ws', 'valid');
    await c.recv(); // consume connected
    c.send(JSON.stringify({ op: 'subscribe', topics: ['test.event'] }));
    await new Promise((r) => setTimeout(r, 100)); // let the server process the subscribe
    // Broadcast an event the client IS subscribed to.
    mod.broadcast('test.event', { n: 1 });
    const msg = await c.recv();
    assert.equal((JSON.parse(msg) as { type: string }).type, 'test.event');
    // Broadcast an event the client is NOT subscribed to — it should not receive it.
    mod.broadcast('other.event', { n: 2 });
    // Verify the client only receives the subscribed type: give it a moment, then
    // broadcast a subscribed event and ensure that's the next message.
    await new Promise((r) => setTimeout(r, 50));
    mod.broadcast('test.event', { n: 3 });
    const msg2 = await c.recv();
    assert.equal((JSON.parse(msg2) as { data: { n: number } }).data.n, 3); // got n=3, not n=2
    c.close();
  });

  it('tracks connected client count', async () => {
    const before = mod.clientCount;
    const c = await wsClient(port, '/ws', 'valid');
    await c.recv();
    assert.equal(mod.clientCount, before + 1);
    c.close();
    await new Promise((r) => setTimeout(r, 50)); // close propagates
    assert.ok(mod.clientCount <= before + 1);
  });

  it('default event set covers the platform bus (memory, tools, tanya)', async () => {
    // Boot a second module WITHOUT an eventTypes override → DEFAULT_EVENTS.
    const k2 = createTestKernel();
    const mod2 = new RealtimeModule();
    k2.register(mod2);
    await k2.boot();
    const server2 = http.createServer();
    await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
    const port2 = (server2.address() as AddressInfo).port;
    mod2.attach(server2, { authenticate: async (t) => (t === 'valid' ? { userId: 'u1', username: 'alice', roles: ['developer'] } as PrincipalLike : undefined) });

    const c = await wsClient(port2, '/ws', 'valid');
    await c.recv(); // connected
    c.send(JSON.stringify({ op: 'subscribe', topics: ['memory', 'tool', 'tanya'] }));
    await new Promise((r) => setTimeout(r, 100));

    // Emit platform bus events → they should broadcast automatically.
    await k2.bus.emit('memory.recorded', { id: 'm1', category: 'feature_usage' });
    await k2.bus.emit('tool.invoked', { toolId: 't1', status: 'success' });
    await k2.bus.emit('tanya.chat.completed', { conversationId: 'c1', persona: 'main' });

    const got: string[] = [];
    for (let i = 0; i < 3; i++) {
      const msg = JSON.parse(await c.recv()) as { type: string };
      got.push(msg.type);
    }
    assert.ok(got.includes('memory.recorded'), 'memory.recorded broadcast');
    assert.ok(got.includes('tool.invoked'), 'tool.invoked broadcast');
    assert.ok(got.includes('tanya.chat.completed'), 'tanya.chat.completed broadcast');
    c.close();
    await k2.shutdown();
    server2.closeAllConnections?.();
    await new Promise<void>((r) => server2.close(() => r()));
  });
});

describe('Realtime keepalive + observability', () => {
  it('pings clients and prunes silent ones; emits connect/disconnect events', async () => {
    const kernel = createTestKernel();
    const mod = new RealtimeModule();
    kernel.register(mod);
    await kernel.boot();
    const server = http.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const events: string[] = [];
    const unsub = kernel.bus.on('realtime.client.connected', () => { events.push('connected'); });
    const unsub2 = kernel.bus.on('realtime.client.disconnected', () => { events.push('disconnected'); });

    // Aggressive keepalive: ping every 40ms, prune after 120ms.
    mod.attach(server, {
      authenticate: async (t) => (t === 'valid' ? { userId: 'u1', username: 'alice', roles: ['developer'] } as PrincipalLike : undefined),
      pingIntervalMs: 40,
      pingTimeoutMs: 120,
    });

    // A live client (auto-pongs inbound pings via the ws-codec) stays connected.
    const alive = await wsClient(port, '/ws', 'valid');
    await alive.recv(); // connected
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(mod.clientCount, 1, 'live client survives keepalive (auto-pong)');

    // A dead client (destroyed socket) is pruned.
    const dying = await wsClient(port, '/ws', 'valid');
    await dying.recv();
    dying.close();
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(mod.clientCount, 1, 'dead client pruned');

    // Stats reflect the session.
    const stats = mod.stats();
    assert.ok(stats.clients >= 1);
    assert.equal(stats.path, '/ws');
    assert.equal(stats.pingIntervalMs, 40);
    assert.ok(stats.uptimeMs > 0);
    assert.ok(stats.totalConnections >= 2);

    assert.ok(events.includes('connected'), 'connected event emitted');
    assert.ok(events.includes('disconnected'), 'disconnected event emitted');
    unsub(); unsub2();
    alive.close();
    await kernel.shutdown();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });
});
