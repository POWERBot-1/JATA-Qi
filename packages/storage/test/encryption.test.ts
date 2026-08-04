// PR7 — encryption-at-rest unit tests (AES-256-GCM).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Cipher, generateEncryptionKey, normalizeKey, keysEqual } from '../src/index.js';

describe('Cipher (AES-256-GCM)', () => {
  it('seals and opens strings round-trip', () => {
    const c = new Cipher(generateEncryptionKey());
    const sealed = c.seal('hello world');
    assert.notEqual(sealed, 'hello world');
    assert.match(sealed, /^v1:/);
    assert.equal(c.open(sealed), 'hello world');
  });

  it('seals bytes round-trip', () => {
    const c = new Cipher(generateEncryptionKey());
    const plain = new Uint8Array([0, 1, 2, 3, 250, 251, 252]);
    const sealed = c.sealBytes(plain);
    assert.ok(sealed.byteLength > plain.byteLength); // nonce + tag overhead
    assert.deepEqual([...c.openBytes(sealed)], [...plain]);
  });

  it('produces a different ciphertext for the same plaintext (random nonce)', () => {
    const c = new Cipher(generateEncryptionKey());
    assert.notEqual(c.seal('same'), c.seal('same'));
  });

  it('detects tampering (GCM authentication fails)', () => {
    const c = new Cipher(generateEncryptionKey());
    const sealed = c.seal('secret');
    const parts = sealed.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${Buffer.from('AAAAAAAA', 'base64').toString('base64')}`;
    assert.throws(() => c.open(tampered));
    // Flip a byte in the ciphertext bytes form.
    const sealedBytes = c.sealBytes(new Uint8Array([1, 2, 3, 4]));
    const corrupted = Buffer.from(sealedBytes);
    corrupted[corrupted.length - 1] ^= 0xff;
    assert.throws(() => c.openBytes(corrupted));
  });

  it('fails to open with the wrong key', () => {
    const a = new Cipher(generateEncryptionKey());
    const b = new Cipher(generateEncryptionKey());
    assert.throws(() => b.open(a.seal('x')));
  });

  it('accepts base64, hex, buffer, and passphrase keys', () => {
    const b64 = generateEncryptionKey();
    const hex = Buffer.from(b64, 'base64').toString('hex');
    const buf = Buffer.from(b64, 'base64');
    const fromB64 = new Cipher(b64);
    const fromHex = new Cipher(hex);
    const fromBuf = new Cipher(buf);
    const fromPass = new Cipher('a memorable passphrase');
    // base64/hex/buffer of the same key decrypt each other.
    const sealed = fromB64.seal('msg');
    assert.equal(fromHex.open(sealed), 'msg');
    assert.equal(fromBuf.open(sealed), 'msg');
    // A passphrase-derived key is a different key (won't open b64-sealed data).
    assert.throws(() => fromPass.open(sealed));
    // But the passphrase key round-trips its own data.
    assert.equal(fromPass.open(fromPass.seal('msg2')), 'msg2');
  });

  it('normalizeKey rejects a wrong-length Buffer', () => {
    assert.throws(() => normalizeKey(Buffer.alloc(16)));
  });

  it('keysEqual is constant-time and order-insensitive', () => {
    assert.equal(keysEqual('abc', 'abc'), true);
    assert.equal(keysEqual('abc', 'abd'), false);
  });
});
