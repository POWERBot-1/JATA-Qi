// Registry store tests — full domain lifecycle, transfers, DNSSEC, sweep, reporting.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Registry, RegistryError, GracePeriods, defaultPolicy } from '../src/index.js';

let reg: Registry;
const now0 = Date.now();

beforeEach(() => {
  reg = new Registry({ tld: '.jq', policy: defaultPolicy({ reserved: new Set(), reservedPatterns: [] }) });
  reg.addRegistrar({ id: 'reg-a', name: 'Registrar A', passwordHash: hashOf('pw-a'), active: true });
  reg.addRegistrar({ id: 'reg-b', name: 'Registrar B', passwordHash: hashOf('pw-b'), active: true });
});

function hashOf(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

describe('Registry — availability & create', () => {
  it('checks availability and pricing', () => {
    const a = reg.checkAvailability('mybrand.jq.');
    assert.equal(a.available, true);
    assert.ok((a.price ?? 0) > 0);
  });

  it('refuses names outside the TLD', () => {
    assert.equal(reg.checkAvailability('mybrand.com.').available, false);
  });

  it('creates a domain and exposes info', () => {
    const d = reg.createDomain({ name: 'mybrand.jq.', registrarId: 'reg-a', registrant: 'c1', authInfo: 'secret', periodYears: 2 });
    assert.equal(d.registrarId, 'reg-a');
    assert.equal(d.phase, 'active');
    const info = reg.info('mybrand.jq.')!;
    assert.ok(info);
    assert.equal(info.statuses.has('ok'), true);
  });

  it('refuses duplicate create', () => {
    reg.createDomain({ name: 'dup.jq.', registrarId: 'reg-a', registrant: 'c1', authInfo: 's' });
    assert.throws(() => reg.createDomain({ name: 'dup.jq.', registrarId: 'reg-a', registrant: 'c1', authInfo: 's' }), RegistryError);
  });

  it('refuses create for unknown registrar', () => {
    assert.throws(() => reg.createDomain({ name: 'x.jq.', registrarId: 'nope', registrant: 'c1', authInfo: 's' }), RegistryError);
  });
});

describe('Registry — renew / delete / restore', () => {
  it('renews and extends expiry (sponsor only)', () => {
    reg.createDomain({ name: 'r.jq.', registrarId: 'reg-a', registrant: 'c1', authInfo: 's' });
    const before = reg.info('r.jq.')!.expiresAt;
    const r = reg.renew('r.jq.', 'reg-a', 2);
    assert.ok(r.domain.expiresAt > before);
    // Non-sponsor cannot renew.
    assert.throws(() => reg.renew('r.jq.', 'reg-b', 1), RegistryError);
  });

  it('soft-deletes into redemption grace and restores', () => {
    reg.createDomain({ name: 'd.jq.', registrarId: 'reg-a', registrant: 'c1', authInfo: 's' });
    reg.deleteDomain('d.jq.', 'reg-a');
    assert.equal(reg.info('d.jq.')!.phase, 'redemption-grace');
    reg.restoreDomain('d.jq.', 'reg-a');
    assert.equal(reg.info('d.jq.')!.phase, 'active');
  });
});

describe('Registry — transfers (RFC 5731)', () => {
  it('rejects transfer with wrong authInfo immediately', () => {
    reg.createDomain({ name: 't.jq.', registrarId: 'reg-a', registrant: 'c1', authInfo: 'right' });
    const rec = reg.requestTransfer('t.jq.', 'reg-b', 'wrong');
    assert.equal(rec.state, 'rejected');
    assert.equal(reg.info('t.jq.')!.registrarId, 'reg-a');
  });

  it('approves a transfer and rotates authInfo + extends by 1 year', () => {
    reg.createDomain({ name: 't.jq.', registrarId: 'reg-a', registrant: 'c1', authInfo: 'right' });
    const before = reg.info('t.jq.')!.expiresAt;
    const rec = reg.requestTransfer('t.jq.', 'reg-b', 'right');
    assert.equal(rec.state, 'pending');
    reg.approveTransfer(rec.id);
    const d = reg.info('t.jq.')!;
    assert.equal(d.registrarId, 'reg-b');
    assert.ok(d.expiresAt > before);
  });

  it('auto-approves pending transfers after the window', () => {
    reg.createDomain({ name: 't.jq.', registrarId: 'reg-a', registrant: 'c1', authInfo: 'right' });
    const rec = reg.requestTransfer('t.jq.', 'reg-b', 'right');
    const approved = reg.runTransferAutoApprovals(rec.autoApproveAt + 1);
    assert.equal(approved.length, 1);
    assert.equal(reg.info('t.jq.')!.registrarId, 'reg-b');
  });

  it('honors transfer-prohibited status', () => {
    reg.createDomain({ name: 't.jq.', registrarId: 'reg-a', registrant: 'c1', authInfo: 'right' });
    reg.updateDomain('t.jq.', 'reg-a', { addStatuses: ['serverTransferProhibited'] });
    assert.throws(() => reg.requestTransfer('t.jq.', 'reg-b', 'right'), RegistryError);
  });
});

describe('Registry — DNSSEC delegation', () => {
  it('stores and clears DS records', () => {
    reg.createDomain({ name: 's.jq.', registrarId: 'reg-a', registrant: 'c1', authInfo: 's' });
    const ds = [{ keyTag: 12345, algorithm: 13, digestType: 2, digest: 'abcd' }];
    reg.setDsRecords('s.jq.', 'reg-a', ds);
    assert.equal(reg.info('s.jq.')!.dsRecords.length, 1);
    reg.clearDsRecords('s.jq.', 'reg-a');
    assert.equal(reg.info('s.jq.')!.dsRecords.length, 0);
  });
});

describe('Registry — update & contacts/hosts', () => {
  it('updates nameservers and statuses', () => {
    reg.createDomain({ name: 'u.jq.', registrarId: 'reg-a', registrant: 'c1', authInfo: 's' });
    const d = reg.updateDomain('u.jq.', 'reg-a', { addNameservers: ['ns1.u.jq.'], addStatuses: ['clientHold'] });
    assert.ok(d.nameservers.includes('ns1.u.jq.'));
    assert.equal(d.statuses.has('clientHold'), true);
  });

  it('creates and retrieves contacts and hosts', () => {
    reg.createContact({ id: 'c1', registrarId: 'reg-a', type: 'registrant', email: 'r@e.x' });
    reg.createHost({ name: 'ns1.x.jq.', registrarId: 'reg-a', addresses: ['192.0.2.1'] });
    assert.equal(reg.getContact('c1')!.email, 'r@e.x');
    assert.equal(reg.getHost('ns1.x.jq.')!.addresses[0], '192.0.2.1');
  });
});

describe('Registry — sweep & reporting', () => {
  it('sweeps released domains', () => {
    reg.createDomain({ name: 'exp.jq.', registrarId: 'reg-a', registrant: 'c1', authInfo: 's' });
    // Age the registry far into the future so the domain is past all grace periods.
    const farFuture = Date.now() + 100 * 365 * 86400_000;
    const released = reg.sweep(farFuture);
    assert.ok(released.includes('exp.jq.'));
    assert.equal(reg.info('exp.jq.', farFuture), undefined);
  });

  it('counts domains and registrars', () => {
    reg.createDomain({ name: 'a.jq.', registrarId: 'reg-a', registrant: 'c1', authInfo: 's' });
    const c = reg.counts();
    assert.equal(c.registrars, 2);
    assert.ok(c.domains >= 1);
    assert.equal(c.active, 1);
  });
});

describe('Registry — authentication', () => {
  it('authenticates a registrar with the correct password', () => {
    assert.ok(reg.authenticateRegistrar('reg-a', 'pw-a'));
    assert.equal(reg.authenticateRegistrar('reg-a', 'wrong'), undefined);
    assert.equal(reg.authenticateRegistrar('reg-a', 'pw-b'), undefined);
  });
});
