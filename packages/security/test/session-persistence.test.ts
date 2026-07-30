// Restart-safe session persistence tests (PR4 — Security Hardening).
// Proves authentication sessions survive a kernel restart when backed by a
// persistent storage driver (filesystem + SQLite), and remain valid/invalid as
// expected. Also covers revocation, listing, and expiry pruning.

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { StorageModule, FsDriver } from '@jataqi/storage';
import { SecurityModule } from '../src/index.js';

function bootSecuredKernel(driver: 'memory' | 'filesystem', fsRoot?: string): Kernel {
  const k = createTestKernel();
  if (driver === 'filesystem') {
    k.register(new StorageModule({ driver: 'filesystem', fsRoot }));
  } else {
    k.register(new StorageModule());
  }
  k.register(new SecurityModule({ sessionTtlMs: 60_000 }));
  return k;
}

describe('session persistence (filesystem driver)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jataqi-session-'));
  });
  after(async () => {
    // tmpDirs are cleaned per-test inside the test bodies; nothing global here.
  });

  it('survives a kernel restart (token issued before restart still authenticates)', async () => {
    // --- first boot ---
    let kernel = bootSecuredKernel('filesystem', tmpDir);
    await kernel.boot();
    let sec = kernel.getModule<SecurityModule>('security');
    await sec.registerUser('alice', 'pw', ['developer']);
    const res = await sec.login('alice', 'pw');
    assert.equal(res.ok, true);
    const token = res.session!.token;
    assert.equal((await sec.authenticate(token))?.username, 'alice');
    await kernel.shutdown();

    // --- restart: new kernel, same on-disk storage ---
    kernel = bootSecuredKernel('filesystem', tmpDir);
    await kernel.boot();
    sec = kernel.getModule<SecurityModule>('security');
    // The token issued before the restart must still resolve.
    const principal = await sec.authenticate(token);
    assert.ok(principal, 'session must survive a restart');
    assert.equal(principal!.username, 'alice');
    assert.deepEqual(principal!.roles, ['developer']);
    await kernel.shutdown();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('logout before restart invalidates the token after restart', async () => {
    let kernel = bootSecuredKernel('filesystem', tmpDir);
    await kernel.boot();
    const sec = kernel.getModule<SecurityModule>('security');
    await sec.registerUser('bob', 'pw', ['developer']);
    const live = await sec.login('bob', 'pw');
    const dead = await sec.login('bob', 'pw');
    await sec.logout(dead.session!.token);
    await kernel.shutdown();

    kernel = bootSecuredKernel('filesystem', tmpDir);
    await kernel.boot();
    const sec2 = kernel.getModule<SecurityModule>('security');
    assert.ok(await sec2.authenticate(live.session!.token));
    assert.equal(await sec2.authenticate(dead.session!.token), undefined);
    await kernel.shutdown();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('expired sessions are pruned on restart', async () => {
    // Use a very short TTL so the session is already expired by the restart.
    const k1 = createTestKernel();
    k1.register(new StorageModule({ driver: 'filesystem', fsRoot: tmpDir }));
    k1.register(new SecurityModule({ sessionTtlMs: 1 }));
    await k1.boot();
    const s1 = k1.getModule<SecurityModule>('security');
    await s1.registerUser('carol', 'pw', ['developer']);
    const res = await s1.login('carol', 'pw');
    const token = res.session!.token;
    await k1.shutdown();

    // Wait long enough for the TTL to lapse.
    await new Promise((r) => setTimeout(r, 20));

    const k2 = createTestKernel();
    k2.register(new StorageModule({ driver: 'filesystem', fsRoot: tmpDir }));
    k2.register(new SecurityModule({ sessionTtlMs: 60_000 }));
    await k2.boot();
    const s2 = k2.getModule<SecurityModule>('security');
    // init() prunes expired sessions automatically; the expired token must NOT
    // authenticate and must not appear in the active session list.
    assert.equal(await s2.authenticate(token), undefined);
    assert.equal((await s2.listSessions()).length, 0);
    // A redundant prune is a no-op now.
    assert.equal(await s2.pruneExpiredSessions(), 0);
    await k2.shutdown();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

describe('session management API', () => {
  let kernel: Kernel;
  let sec: SecurityModule;

  beforeEach(async () => {
    kernel = bootSecuredKernel('memory');
    await kernel.boot();
    sec = kernel.getModule<SecurityModule>('security');
    await sec.registerUser('dave', 'pw', ['developer']);
  });

  it('lists active sessions for a user', async () => {
    await sec.login('dave', 'pw');
    await sec.login('dave', 'pw');
    const sessions = await sec.listSessions();
    assert.ok(sessions.length >= 2);
    const mine = await sec.listSessions((await sec.getUser('dave'))!.id);
    assert.equal(mine.length, sessions.length);
  });

  it('revokes a single session by token', async () => {
    const res = await sec.login('dave', 'pw');
    const token = res.session!.token;
    assert.equal(await sec.revokeSession(token), true);
    assert.equal(await sec.authenticate(token), undefined);
    // Revoking an already-revoked token returns false.
    assert.equal(await sec.revokeSession(token), false);
  });

  it('revokes all sessions for a user except the current one', async () => {
    const a = await sec.login('dave', 'pw');
    await sec.login('dave', 'pw');
    await sec.login('dave', 'pw');
    const userId = (await sec.getUser('dave'))!.id;
    const n = await sec.revokeAllUserSessions(userId, a.session!.token);
    assert.equal(n, 2);
    assert.ok(await sec.authenticate(a.session!.token));
    const remaining = await sec.listSessions(userId);
    assert.equal(remaining.length, 1);
  });

  it('records remote address on login', async () => {
    const res = await sec.login('dave', 'pw', { remoteAddress: '203.0.113.7' });
    const sessions = await sec.listSessions();
    const mine = sessions.find((s) => s.token === res.session!.token);
    assert.equal(mine!.remoteAddress, '203.0.113.7');
  });

  it('emits session lifecycle events', async () => {
    const events: string[] = [];
    kernel.bus.on('security.session.revoked', () => { events.push('revoked'); });
    kernel.bus.on('security.session.expired', () => { events.push('expired'); });
    kernel.bus.on('security.user.login', () => { events.push('login'); });
    await sec.login('dave', 'pw');
    const res = await sec.login('dave', 'pw');
    await sec.revokeSession(res.session!.token);
    assert.ok(events.includes('login'));
    assert.ok(events.includes('revoked'));
    await kernel.shutdown();
  });
});

describe('persistSessions disabled (ephemeral)', () => {
  it('does not persist sessions when persistence is off', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'jataqi-nopersist-'));
    const k1 = createTestKernel();
    k1.register(new StorageModule({ driver: 'filesystem', fsRoot: tmp }));
    k1.register(new SecurityModule({ persistSessions: false }));
    await k1.boot();
    const s1 = k1.getModule<SecurityModule>('security');
    await s1.registerUser('eve', 'pw', ['developer']);
    const res = await s1.login('eve', 'pw');
    const token = res.session!.token;
    assert.ok(await s1.authenticate(token));
    await k1.shutdown();

    const k2 = createTestKernel();
    k2.register(new StorageModule({ driver: 'filesystem', fsRoot: tmp }));
    k2.register(new SecurityModule({ persistSessions: false }));
    await k2.boot();
    const s2 = k2.getModule<SecurityModule>('security');
    assert.equal(await s2.authenticate(token), undefined, 'ephemeral sessions must NOT survive restart');
    assert.equal((await s2.listSessions()).length, 0);
    await k2.shutdown();
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
