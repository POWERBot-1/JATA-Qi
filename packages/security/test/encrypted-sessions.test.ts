// PR7 — security module over encrypted storage: authentication still works and
// sessions/users are ciphertext at rest (nothing plaintext on disk).

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { StorageModule, FsDriver, generateEncryptionKey } from '@jataqi/storage';
import { SecurityModule } from '../src/index.js';

async function rawDump(dir: string): Promise<string> {
  const driver = new FsDriver({ root: dir });
  try {
    const sessions = await driver.openCollection<{ id: string; __e?: string; token?: string }>('security.sessions');
    const users = await driver.openCollection<{ id: string; __e?: string; username?: string }>('security.users');
    const sDocs = await sessions.all();
    const uDocs = await users.all();
    return JSON.stringify({ sessions: sDocs, users: uDocs });
  } finally {
    await driver.close();
  }
}

describe('SecurityModule over encrypted storage', () => {
  let tmpDir: string;

  it('authenticates normally while sessions/users stay encrypted on disk', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jataqi-sec-enc-'));
    const kernel: Kernel = createTestKernel();
    kernel.register(new StorageModule({ driver: 'filesystem', fsRoot: tmpDir, encryptionKey: generateEncryptionKey() }));
    kernel.register(new SecurityModule());
    await kernel.boot();
    const sec = kernel.getModule<SecurityModule>('security');

    await sec.registerUser('alice', 'pw', ['developer']);
    const res = await sec.login('alice', 'pw');
    assert.equal(res.ok, true);
    const token = res.session!.token;

    // Authentication reads through the encrypted layer transparently.
    const principal = await sec.authenticate(token);
    assert.ok(principal);
    assert.equal(principal!.username, 'alice');

    // The raw on-disk store must NOT contain plaintext usernames or tokens.
    const dump = await rawDump(tmpDir);
    assert.ok(!dump.includes('alice'), 'plaintext username leaked to disk');
    assert.ok(!dump.includes(token), 'plaintext session token leaked to disk');
    assert.ok(dump.includes('__e'), 'encrypted docs should carry the __e ciphertext field');

    await kernel.shutdown();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('survives a restart with the SAME key but is unreadable with a different key', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jataqi-sec-enc2-'));
    const key = generateEncryptionKey();

    const k1 = createTestKernel();
    k1.register(new StorageModule({ driver: 'filesystem', fsRoot: tmpDir, encryptionKey: key }));
    k1.register(new SecurityModule());
    await k1.boot();
    const s1 = k1.getModule<SecurityModule>('security');
    await s1.registerUser('bob', 'pw', ['developer']);
    const res = await s1.login('bob', 'pw');
    const token = res.session!.token;
    await k1.shutdown();

    // Same key -> session survives and authenticates.
    const k2 = createTestKernel();
    k2.register(new StorageModule({ driver: 'filesystem', fsRoot: tmpDir, encryptionKey: key }));
    k2.register(new SecurityModule());
    await k2.boot();
    const s2 = k2.getModule<SecurityModule>('security');
    assert.equal((await s2.authenticate(token))?.username, 'bob');
    await k2.shutdown();

    // Wrong key -> decryption fails; the module degrades gracefully (boot does
    // NOT crash) and the session simply fails to authenticate.
    const k3 = createTestKernel();
    k3.register(new StorageModule({ driver: 'filesystem', fsRoot: tmpDir, encryptionKey: generateEncryptionKey() }));
    k3.register(new SecurityModule());
    await k3.boot(); // must not throw despite the key mismatch
    const s3 = k3.getModule<SecurityModule>('security');
    assert.equal(await s3.authenticate(token), undefined, 'wrong key must not authenticate the session');
    await k3.shutdown();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  after(async () => { /* tmpDirs cleaned per-test */ });
});
