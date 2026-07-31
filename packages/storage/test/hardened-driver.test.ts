// PR7 — hardened storage driver tests: EncryptedDriver + QuotaDriver decorators,
// composition, and persistence of ciphertext on disk.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MemoryDriver, FsDriver, SqliteDriver,
  EncryptedDriver, QuotaDriver, QuotaExceededError,
  Cipher, generateEncryptionKey,
} from '../src/index.js';

const KEY = generateEncryptionKey();

// --- EncryptedDriver --------------------------------------------------------

describe('EncryptedDriver (namespace/collection/blob)', () => {
  it('encrypts namespace values transparently', async () => {
    const base = new MemoryDriver();
    const enc = new EncryptedDriver(base, { key: KEY });
    const ns = await enc.openNamespace('secrets');
    await ns.set('api-key', { token: 'super-secret' });
    // The underlying driver only sees ciphertext.
    const raw = await base.openNamespace('secrets');
    const stored = await raw.get<string>('api-key');
    assert.ok(stored!.startsWith('v1:'));
    assert.ok(!stored!.includes('super-secret'));
    // Transparent read-back decrypts.
    assert.deepEqual(await ns.get('api-key'), { token: 'super-secret' });
    await base.close();
  });

  it('encrypts collection docs and still supports query/has/count', async () => {
    const base = new MemoryDriver();
    const enc = new EncryptedDriver(base, { key: KEY });
    const users = await enc.openCollection<{ id: string; name: string; role: string }>('users');
    await users.put({ id: '1', name: 'Alice', role: 'admin' });
    await users.put({ id: '2', name: 'Bob', role: 'dev' });
    // Ciphertext on disk: the raw collection never sees plaintext names.
    const raw = await base.openCollection<{ id: string; __e: string }>('users');
    const rawAll = await raw.all();
    assert.ok(rawAll.every((d) => typeof d.__e === 'string' && d.__e.startsWith('v1:')));
    assert.ok(JSON.stringify(rawAll).includes('Alice') === false);
    // Transparent operations.
    assert.equal((await users.get('1'))!.name, 'Alice');
    assert.equal(await users.count(), 2);
    assert.equal(await users.has('2'), true);
    const admins = await users.query({ where: (u) => u.role === 'admin' });
    assert.deepEqual(admins.map((u) => u.id), ['1']);
    await base.close();
  });

  it('encrypts blobs (text + binary) transparently', async () => {
    const base = new MemoryDriver();
    const enc = new EncryptedDriver(base, { key: KEY });
    const blobs = await enc.openBlobStore('files');
    await blobs.put('a.txt', 'hello', 'text/plain');
    await blobs.put('bin', new Uint8Array([10, 20, 30, 40]));
    assert.equal(await blobs.getAsText('a.txt'), 'hello');
    assert.deepEqual([...(await blobs.get('bin'))!], [10, 20, 30, 40]);
    const raw = await base.openBlobStore('files');
    const rawBlob = await raw.get('a.txt');
    assert.ok(rawBlob!.byteLength > 5); // nonce+tag overhead, not plaintext length
    await base.close();
  });

  it('persists ciphertext across driver instances (filesystem)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'jataqi-enc-'));
    const key = KEY;
    const enc1 = new EncryptedDriver(new FsDriver({ root: tmp }), { key });
    const ns1 = await enc1.openNamespace('kv');
    await ns1.set('secret', 'on-disk-secret');
    await enc1.close();

    // Re-open: same key reads it back; a different key cannot.
    const enc2 = new EncryptedDriver(new FsDriver({ root: tmp }), { key });
    const ns2 = await enc2.openNamespace('kv');
    assert.equal(await ns2.get('secret'), 'on-disk-secret');
    const enc3 = new EncryptedDriver(new FsDriver({ root: tmp }), { key: generateEncryptionKey() });
    const ns3 = await enc3.openNamespace('kv');
    await assert.rejects(() => ns3.get('secret'));
    await enc2.close(); await enc3.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

// --- QuotaDriver ------------------------------------------------------------

describe('QuotaDriver (enforcement + accounting)', () => {
  it('allows writes under the quota and blocks over-quota writes', async () => {
    const base = new MemoryDriver();
    const q = new QuotaDriver(base, { quotas: { kv: 20 } });
    const ns = await q.openNamespace('kv');
    await ns.set('a', '12345'); // 5 bytes
    await ns.set('b', '12345'); // 10 total
    // 11 more bytes would exceed 20.
    await assert.rejects(() => ns.set('c', 'x'.repeat(11)), (e: unknown) => (e as QuotaExceededError).code === 'QUOTA_EXCEEDED');
    // A small write still fits.
    await ns.set('c', 'xy'); // 12 total
    assert.equal(await ns.get('a'), '12345');
    await base.close();
  });

  it('updating an existing key frees its old size (no double-counting)', async () => {
    const base = new MemoryDriver();
    const q = new QuotaDriver(base, { quotas: { kv: 10 } });
    const ns = await q.openNamespace('kv');
    await ns.set('k', '12345678'); // 8 bytes
    // Replace with a smaller value (fits), then a larger one (still within 10).
    await ns.set('k', 'ab');        // 2 bytes
    await ns.set('k', '1234567');   // 7 bytes (<= 10)
    await assert.rejects(() => ns.set('k', 'x'.repeat(11)));
    await base.close();
  });

  it('delete frees space for subsequent writes', async () => {
    const base = new MemoryDriver();
    const q = new QuotaDriver(base, { quotas: { kv: 10 } });
    const ns = await q.openNamespace('kv');
    await ns.set('a', 'x'.repeat(6));
    await ns.set('b', 'x'.repeat(4)); // 10 total, full
    await assert.rejects(() => ns.set('c', 'y'));
    await ns.delete('a');             // free 6
    await ns.set('c', 'z'.repeat(5)); // now fits
    await base.close();
  });

  it('enforces collection + blob quotas', async () => {
    const base = new MemoryDriver();
    const q = new QuotaDriver(base, { quotas: { docs: 30, blobs: 8 } });
    const docs = await q.openCollection<{ id: string; v: string }>('docs');
    await docs.put({ id: '1', v: 'small' });
    await assert.rejects(() => docs.put({ id: '2', v: 'x'.repeat(30) }));
    const blobs = await q.openBlobStore('blobs');
    await blobs.put('a', '1234');
    await assert.rejects(() => blobs.put('b', '56789'));
    await base.close();
  });

  it('accounts sizes correctly across a restart', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'jataqi-quota-'));
    const q1 = new QuotaDriver(new FsDriver({ root: tmp }), { quotas: { kv: 12 } });
    const ns1 = await q1.openNamespace('kv');
    await ns1.set('a', 'x'.repeat(12)); // full
    await q1.close();
    // Re-open: the ledger must recompute from disk and still enforce.
    const q2 = new QuotaDriver(new FsDriver({ root: tmp }), { quotas: { kv: 12 } });
    const ns2 = await q2.openNamespace('kv');
    await assert.rejects(() => ns2.set('b', 'y'));
    await q2.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

// --- Composition: Quota(Encrypted(base)) -----------------------------------

describe('hardened composition: QuotaDriver(EncryptedDriver(base))', () => {
  it('counts logical size and encrypts below, persisting ciphertext', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'jataqi-harden-'));
    const base = new FsDriver({ root: tmp });
    const enc = new EncryptedDriver(base, { key: KEY });
    const hardened = new QuotaDriver(enc, { quotas: { kv: 30 } });
    const ns = await hardened.openNamespace('kv');
    await ns.set('k', 'x'.repeat(20));       // logical 20 <= 30
    await assert.rejects(() => ns.set('k2', 'y'.repeat(20))); // 40 > 30
    assert.equal(await ns.get('k'), 'x'.repeat(20));
    await hardened.close();

    // On disk: ciphertext only.
    const rawNs = await base.openNamespace('kv');
    const raw = await rawNs.get<string>('k');
    assert.ok(raw!.startsWith('v1:'));
    await base.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('works over SQLite too (encrypted + quota)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'jataqi-sqlite-enc-'));
    const dbPath = path.join(tmp, 'test.db');
    const base = new SqliteDriver({ path: dbPath });
    const hardened = new QuotaDriver(new EncryptedDriver(base, { key: KEY }), { defaultQuotaBytes: 1000 });
    const ns = await hardened.openNamespace('kv');
    await ns.set('secret', { value: 'encrypted-at-rest' });
    assert.deepEqual(await ns.get('secret'), { value: 'encrypted-at-rest' });
    await hardened.close();
    // Raw SQLite row is ciphertext.
    const base2 = new SqliteDriver({ path: dbPath });
    const raw = await base2.openNamespace('kv');
    const stored = await raw.get<string>('secret');
    assert.ok(stored!.startsWith('v1:'));
    await base2.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
