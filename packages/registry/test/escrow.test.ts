// Escrow deposit tests — build + verify signed deposits.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, toBase64 } from '@jataqi/provenance';
import { Registry, defaultPolicy, buildDeposit, verifyDeposit } from '../src/index.js';
import type { EscrowSigner } from '../src/index.js';

let reg: Registry;
let signer: EscrowSigner;

beforeEach(() => {
  reg = new Registry({ tld: '.jq', policy: defaultPolicy({ reserved: new Set(), reservedPatterns: [] }) });
  reg.addRegistrar({ id: 'reg-a', name: 'A', passwordHash: 'x', active: true });
  const kp = generateKeyPair();
  signer = { privateKeyDerB64: toBase64(kp.privateKeyDer), publicKeyDerB64: toBase64(kp.publicKeyDer) };
});

describe('escrow', () => {
  it('builds a signed deposit with a contents hash', () => {
    reg.createDomain({ name: 'a.jq.', registrarId: 'reg-a', registrant: 'c1', authInfo: 's' });
    const deposit = buildDeposit(reg, 1, signer);
    assert.equal(deposit.tld, '.jq');
    assert.equal(deposit.domainCount, 1);
    assert.equal(deposit.contentsHash.length, 64);
    assert.ok(deposit.signature.length > 0);
  });

  it('verifies a well-formed deposit', () => {
    const deposit = buildDeposit(reg, 1, signer);
    assert.equal(verifyDeposit(deposit), true);
  });

  it('rejects a tampered deposit', () => {
    const deposit = buildDeposit(reg, 1, signer);
    const tampered = { ...deposit, contents: deposit.contents + ' ' };
    assert.equal(verifyDeposit(tampered), false);
  });

  it('rejects a deposit with a wrong signature', () => {
    const deposit = buildDeposit(reg, 1, signer);
    const other = generateKeyPair();
    const tampered = { ...deposit, signedBy: toBase64(other.publicKeyDer) };
    assert.equal(verifyDeposit(tampered), false);
  });
});
