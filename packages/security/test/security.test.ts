import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import {
  SecurityModule,
  RolePolicy,
  hashSecret,
  verifySecret,
  generateToken,
  extractBearer,
} from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

function bootKernel(bootstrap?: { username: string; password: string }) {
  const k = createTestKernel();
  k.register(new StorageModule());
  k.register(new SecurityModule({ bootstrapAdmin: bootstrap }));
  return k;
}

describe('crypto', () => {
  it('hashes and verifies secrets', () => {
    const h = hashSecret('hunter2');
    assert.equal(verifySecret('hunter2', h), true);
    assert.equal(verifySecret('wrong', h), false);
  });

  it('generates random tokens of the expected length', () => {
    const t = generateToken(16);
    assert.equal(t.length, 32); // 16 bytes -> 32 hex chars
    assert.notEqual(t, generateToken(16));
  });

  it('extracts bearer tokens from headers', () => {
    assert.equal(extractBearer('Bearer abc123'), 'abc123');
    assert.equal(extractBearer('bearer  abc123'), 'abc123');
    assert.equal(extractBearer('abc123'), 'abc123');
    assert.equal(extractBearer(undefined), undefined);
    assert.equal(extractBearer(''), undefined);
  });
});

describe('rbac', () => {
  const policy = new RolePolicy({
    admin: ['*'],
    analyst: ['knowledge:read', 'audit:read'],
  });

  it('grants wildcard to admin', () => {
    assert.equal(policy.authorize({ userId: 'a', username: 'a', roles: ['admin'] }, 'anything:at_all'), true);
  });

  it('matches exact and segment wildcards', () => {
    const p = { userId: 'a', username: 'a', roles: ['analyst'] };
    assert.equal(policy.authorize(p, 'knowledge:read'), true);
    assert.equal(policy.authorize(p, 'knowledge:write'), false);
    assert.equal(policy.authorize(p, 'audit:read'), true);
  });
});

describe('SecurityModule (kernel integration)', () => {
  let kernel: Kernel;
  let sec: SecurityModule;
  beforeEach(async () => {
    kernel = bootKernel();
    await kernel.boot();
    sec = kernel.getModule<SecurityModule>('security');
  });

  it('registers and looks up a user', async () => {
    const u = await sec.registerUser('alice', 'pw123', ['developer']);
    assert.equal(u.username, 'alice');
    assert.equal(u.active, true);
    const found = await sec.getUser('alice');
    assert.ok(found);
    assert.equal(found!.passwordHash === 'pw123', false);
  });

  it('prevents duplicate usernames', async () => {
    await sec.registerUser('bob', 'pw', ['developer']);
    await assert.rejects(() => sec.registerUser('bob', 'pw', ['developer']), /already exists/);
  });

  it('logs in with correct credentials and authenticates the token', async () => {
    await sec.registerUser('carol', 'secret', ['analyst']);
    const res = await sec.login('carol', 'secret');
    assert.equal(res.ok, true);
    assert.ok(res.session?.token);
    assert.ok(res.principal);
    const principal = await sec.authenticate(res.session!.token);
    assert.ok(principal);
    assert.equal(principal!.username, 'carol');
  });

  it('rejects bad credentials and audits the failure', async () => {
    await sec.registerUser('dave', 'right', ['developer']);
    const res = await sec.login('dave', 'wrong');
    assert.equal(res.ok, false);
    const failed = await sec.getAuditLog().query({ action: 'auth.login', result: 'failure' });
    assert.ok(failed.length >= 1);
  });

  it('enforces RBAC permission checks', async () => {
    await sec.registerUser('eve', 'pw', ['analyst']);
    const res = await sec.login('eve', 'pw');
    const p = res.principal!;
    assert.equal(sec.authorize(p, 'audit:read'), true);
    assert.equal(sec.authorize(p, 'qil:run'), true); // analyst has qil:run
    assert.equal(sec.authorize(p, 'knowledge:write'), false);
  });

  it('requirePermission throws and audits on denial', async () => {
    await sec.registerUser('frank', 'pw', ['guest']);
    const res = await sec.login('frank', 'pw');
    const p = res.principal!;
    await assert.rejects(() => sec.requirePermission(p, 'qil:run'));
    const denied = await sec.getAuditLog().query({ action: 'auth.denied' });
    assert.ok(denied.length >= 1);
  });

  it('issues and authenticates an API key', async () => {
    await sec.registerUser('grace', 'pw', ['developer']);
    const { secret } = await sec.createApiKey('grace', 'ci-key');
    assert.ok(secret.startsWith('jqk_'));
    const principal = await sec.authenticateApiKey(secret);
    assert.ok(principal);
    assert.equal(principal!.username, 'grace');
    // Wrong key fails.
    assert.equal(await sec.authenticateApiKey('jqk_nope'), undefined);
  });

  it('creates a bootstrap admin at init time', async () => {
    const k = createTestKernel();
    k.register(new StorageModule());
    k.register(new SecurityModule({ bootstrapAdmin: { username: 'root', password: 'toor' } }));
    await k.boot();
    const s = k.getModule<SecurityModule>('security');
    const res = await s.login('root', 'toor');
    assert.equal(res.ok, true);
    assert.ok(res.principal!.roles.includes('admin'));
    await k.shutdown();
  });

  it('audits logins and queries the ledger newest-first', async () => {
    await sec.registerUser('heidi', 'pw', ['developer']);
    await sec.login('heidi', 'pw');
    await sec.login('heidi', 'bad');
    const records = await sec.getAuditLog().query({ action: 'auth.login' });
    assert.ok(records.length >= 2);
    assert.ok(records[0]!.ts >= records[1]!.ts);
  });

  it('sessionInfo introspects live sessions and hides revoked/expired ones', async () => {
    await sec.registerUser('session-probe', 'pw', ['developer']);
    const res = await sec.login('session-probe', 'pw');
    const token = res.session!.token;

    const info = await sec.sessionInfo(token);
    assert.ok(info, 'live session introspected');
    assert.equal(info!.username, 'session-probe');
    assert.equal(info!.userId, res.principal!.userId);
    assert.ok(info!.expiresAt > Date.now());
    assert.ok(info!.createdAt > 0);
    assert.deepEqual(info!.roles, ['developer']);

    // Bearer-header form works too.
    const viaHeader = await sec.sessionInfo(`Bearer ${token}`);
    assert.ok(viaHeader);

    // Revoked session → undefined.
    await sec.logout(token);
    assert.equal(await sec.sessionInfo(token), undefined);

    // Unknown / empty tokens → undefined.
    assert.equal(await sec.sessionInfo('nope'), undefined);
    assert.equal(await sec.sessionInfo(undefined), undefined);
  });
});
