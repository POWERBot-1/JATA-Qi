// PR8 — PostgreSQL authentication unit tests: MD5 + SCRAM-SHA-256 (RFC 5802/7677).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  md5Password, scramClientFirst, scramClientFinal, parseServerFirst,
  parseServerFinal, scramServerSignature,
} from '../src/drivers/pg/auth.js';
import { createHmac, pbkdf2Sync, createHash } from 'node:crypto';

describe('pg auth — MD5', () => {
  it('produces the canonical "md5" + md5(md5(pw+user)+salt) form', () => {
    const salt = Buffer.from([1, 2, 3, 4]);
    const got = md5Password('alice', 'hunter2', salt);
    // Recompute independently.
    const inner = createHash('md5').update('hunter2alice').digest('hex');
    const expected = 'md5' + createHash('md5').update(Buffer.concat([Buffer.from(inner, 'utf8'), salt])).digest('hex');
    assert.equal(got, expected);
    assert.ok(got.startsWith('md5'));
    assert.equal(got.length, 35); // 'md5' + 32 hex
    // Different salt -> different hash.
    assert.notEqual(got, md5Password('alice', 'hunter2', Buffer.from([9, 9, 9, 9])));
  });
});

describe('pg auth — SCRAM-SHA-256', () => {
  // A self-consistent handshake with fixed inputs, verified against an
  // independent server-side recomputation (the exact math real Postgres uses).
  const user = 'user';
  const password = 'pencil';
  const salt = Buffer.from('QSXCR+Q6sek8bf92', 'base64'); // RFC 5802 example salt
  const iterations = 4096;

  it('client-first has the expected shape and a base64 nonce', () => {
    const first = scramClientFirst(user);
    const s = first.full.toString('utf8');
    assert.ok(s.startsWith('n,,n=user,r='));
    assert.ok(first.state.clientNonce.length >= 16);
  });

  it('client-final proof verifies against an independent server recomputation', () => {
    const first = scramClientFirst(user, 18);
    const bare = first.state.clientFirstBare;

    // Build a server-first with a combined nonce (client + server part).
    const serverNoncePart = '3rfcNHYJY1ZVvWVs7j';
    const fullNonce = first.state.clientNonce + serverNoncePart;
    const serverFirst = `r=${fullNonce},s=${salt.toString('base64')},i=${iterations}`;
    const parsed = parseServerFirst(serverFirst);
    assert.equal(parsed.nonce, fullNonce);
    assert.deepEqual(Buffer.from(parsed.salt), salt);

    const final = scramClientFinal(password, bare, serverFirst);
    const finalStr = final.message.toString('utf8');
    assert.ok(finalStr.startsWith(`c=biws,r=${fullNonce},p=`));

    // Independent server-side verification (what Postgres does):
    const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
    assert.deepEqual(Buffer.from(final.saltedPassword), saltedPassword);
    const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
    const storedKey = createHash('sha256').update(clientKey).digest();
    const authMessage = `${bare},${serverFirst},${finalStr.split(',p=')[0]}`;
    const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest();
    const proofBytes = Buffer.from(finalStr.split(',p=')[1], 'base64');
    // Un-XOR the proof to recover the client key; its SHA-256 must equal storedKey.
    const recoveredKey = Buffer.alloc(clientSignature.length);
    for (let i = 0; i < clientSignature.length; i++) recoveredKey[i] = proofBytes[i]! ^ clientSignature[i]!;
    assert.deepEqual(createHash('sha256').update(recoveredKey).digest(), storedKey);
  });

  it('the server signature round-trips through parseServerFinal', () => {
    const first = scramClientFirst(user, 18);
    const serverFirst = `r=${first.state.clientNonce}x,s=${salt.toString('base64')},i=${iterations}`;
    const final = scramClientFinal(password, first.state.clientFirstBare, serverFirst);
    const expected = scramServerSignature(final.saltedPassword, final.authMessage);
    // The server would send "v=" + base64(expected); the client can verify it.
    const serverFinal = `v=${expected.toString('base64')}`;
    assert.deepEqual(parseServerFinal(serverFinal), expected);
  });

  it('rejects a malformed server-first message', () => {
    assert.throws(() => parseServerFirst('garbage'));
  });
});
