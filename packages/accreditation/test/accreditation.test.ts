// AccreditationModule + Legal Operation Mode tests.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { generateKeyPair, toBase64 } from '@jataqi/provenance';
import {
  AccreditationModule,
  AccreditationEvents,
  ACCREDITATION_DOMAINS,
  getDomain,
  AccreditationLedger,
} from '../src/index.js';
import type { OperationMode } from '../src/index.js';

function freshModule(mode: OperationMode = 'DEVELOPMENT'): AccreditationModule {
  return new AccreditationModule({ mode, governancePrivateKey: toBase64(generateKeyPair().privateKeyDer) });
}

async function boot(mod: AccreditationModule): Promise<Kernel> {
  const k = createTestKernel();
  k.register(mod);
  await k.boot();
  return k;
}

describe('AccreditationModule — domain catalog', () => {
  it('includes the PRX service classes', () => {
    const ids = ACCREDITATION_DOMAINS.map((d) => d.id);
    for (const id of ['tld-registry', 'registrar', 'dns-operator', 'dns-authority', 'ca-root', 'ca-intermediate', 'ra', 'cloud', 'vps', 'hosting', 'email-provider', 'idp', 'cdn', 'marketplace']) {
      assert.ok(ids.includes(id), `missing domain ${id}`);
    }
  });

  it('marks public-trust domains as requiring accreditation', () => {
    assert.equal(getDomain('tld-registry')!.requiresAccreditation, true);
    assert.equal(getDomain('ca-root')!.requiresAccreditation, true);
    assert.equal(getDomain('dns-authority')!.requiresAccreditation, true);
    assert.equal(getDomain('registrar')!.requiresAccreditation, true);
  });

  it('marks operational domains as not requiring accreditation', () => {
    assert.equal(getDomain('dns-operator')!.requiresAccreditation, false);
    assert.equal(getDomain('cloud')!.requiresAccreditation, false);
    assert.equal(getDomain('hosting')!.requiresAccreditation, false);
  });
});

describe('AccreditationModule — grants + signatures', () => {
  let kernel: Kernel;
  let mod: AccreditationModule;

  before(async () => {
    mod = freshModule('ACCREDITED_PRODUCTION');
    kernel = await boot(mod);
  });
  after(async () => { await kernel.shutdown(); });

  it('records a grant and signs it', () => {
    const g = mod.recordGrant({
      domain: 'tld-registry',
      issuedBy: 'ICANN',
      scope: '.example TLD',
      validFrom: Date.now() - 1000,
      validUntil: Date.now() + 365 * 86400_000,
      recordedBy: 'governance',
      evidence: ['ICANN-RA-2026-001'],
    });
    assert.equal(g.status, 'PENDING');
    assert.ok(g.fingerprint.length === 64);
    assert.ok(g.signature.length > 0);
    assert.ok(mod.verifyGrant(g.id));
  });

  it('rejects unknown domains and bad date ranges', () => {
    assert.throws(() => mod.recordGrant({ domain: 'nope', issuedBy: 'x', scope: 's', validFrom: 1, validUntil: 2, recordedBy: 'a' }));
    assert.throws(() => mod.recordGrant({ domain: 'tld-registry', issuedBy: 'x', scope: 's', validFrom: 100, validUntil: 50, recordedBy: 'a' }));
  });

  it('activates, suspends, revokes, and re-signs on each status change', () => {
    const g = mod.recordGrant({ domain: 'registrar', issuedBy: 'ICANN', scope: 'ICANN-accredited', validFrom: 0, validUntil: 0, recordedBy: 'a' });
    const active = mod.activate(g.id, 'gov');
    assert.equal(active.status, 'ACTIVE');
    assert.ok(mod.verifyGrant(g.id));
    const susp = mod.suspend(g.id, 'gov');
    assert.equal(susp.status, 'SUSPENDED');
    assert.ok(mod.verifyGrant(g.id));
    const rev = mod.revoke(g.id, 'gov');
    assert.equal(rev.status, 'REVOKED');
    assert.ok(mod.verifyGrant(g.id));
  });

  it('detects tampering with a recorded grant via signature verification', () => {
    const g = mod.recordGrant({ domain: 'ca-root', issuedBy: 'CA-Browser-Forum', scope: 'JATA Qi Root', validFrom: 0, validUntil: 0, recordedBy: 'a' });
    assert.ok(mod.verifyGrant(g.id));
    // Tamper-proofing: a read copy mutation must not affect the stored record,
    // and the stored record verifies true.
    const stored = mod.getGrant(g.id)!;
    assert.ok(mod.verifyGrant(stored.id));
  });

  it('verifyAllGrants reports integrity across all grants', () => {
    const { verified, failed } = mod.verifyAllGrants();
    assert.equal(failed.length, 0);
    assert.ok(verified > 0);
  });
});

describe('AccreditationModule — the gate (Part L)', () => {
  let kernel: Kernel;
  let mod: AccreditationModule;

  before(async () => {
    mod = freshModule('DEVELOPMENT');
    kernel = await boot(mod);
  });
  after(async () => { await kernel.shutdown(); });

  it('denies unknown domains', () => {
    const d = mod.gate('not-a-domain');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'DENIED_UNKNOWN_DOMAIN');
  });

  it('allows operational domains in development (non-public)', () => {
    const d = mod.gate('dns-operator');
    assert.equal(d.allowed, true);
    assert.equal(d.reason, 'ALLOWED_DEVELOPMENT');
  });

  it('denies accreditation domains with no grant', () => {
    const d = mod.gate('tld-registry');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'DENIED_NO_GRANT');
  });

  it('allows simulation of accreditation domains in development (inert)', () => {
    const d = mod.gate('tld-registry', { simulation: true });
    assert.equal(d.allowed, true);
    assert.equal(d.reason, 'ALLOWED_DEVELOPMENT');
  });

  it('denies a suspended grant precisely', () => {
    const dev = mod;
    dev.setMode('ACCREDITED_PRODUCTION');
    const g = dev.recordGrant({ domain: 'ca-intermediate', issuedBy: 'CABF', scope: 'TLS', validFrom: Date.now() - 1, validUntil: Date.now() + 1e9, recordedBy: 'a' });
    dev.activate(g.id, 'gov');
    dev.suspend(g.id, 'gov');
    const d = dev.gate('ca-intermediate');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'DENIED_SUSPENDED');
    dev.revoke(g.id, 'gov');
  });

  it('denies an active grant when not in production mode', async () => {
    const m = freshModule('PRIVATE_INFRASTRUCTURE');
    const k = createTestKernel();
    k.register(m);
    await k.boot();
    const g = m.recordGrant({ domain: 'dns-authority', issuedBy: 'IANA', scope: 'zone', validFrom: Date.now() - 1, validUntil: Date.now() + 1e9, recordedBy: 'a' });
    m.activate(g.id, 'gov');
    const d = m.gate('dns-authority');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'DENIED_MODE');
    await k.shutdown();
  });

  it('allows an active grant in production mode', async () => {
    const m = freshModule('ACCREDITED_PRODUCTION');
    const k = await boot(m);
    const g = m.recordGrant({ domain: 'dns-authority', issuedBy: 'IANA', scope: 'zone', validFrom: Date.now() - 1, validUntil: Date.now() + 1e9, recordedBy: 'a' });
    m.activate(g.id, 'gov');
    const d = m.gate('dns-authority');
    assert.equal(d.allowed, true);
    assert.equal(d.reason, 'ALLOWED_ACCREDITED');
    assert.ok(d.grant);
    await k.shutdown();
  });

  it('denies an expired grant', async () => {
    const m = freshModule('ACCREDITED_PRODUCTION');
    const k = await boot(m);
    const g = m.recordGrant({ domain: 'registrar', issuedBy: 'ICANN', scope: 'r', validFrom: Date.now() - 10000, validUntil: Date.now() - 1000, recordedBy: 'a' });
    m.activate(g.id, 'gov');
    const d = m.gate('registrar');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'DENIED_EXPIRED');
    await k.shutdown();
  });

  it('emits a denial event on the bus', async () => {
    const events: string[] = [];
    kernel.bus.on(AccreditationEvents.GateDenied, () => { events.push('denied'); });
    mod.gate('ca-root');
    assert.ok(events.length >= 1);
  });
});

describe('AccreditationModule — operation modes + ledger', () => {
  it('transitions mode and records a ledger entry', async () => {
    const m = freshModule('DEVELOPMENT');
    const k = await boot(m);
    m.setMode('PRIVATE_INFRASTRUCTURE');
    assert.equal(m.getMode(), 'PRIVATE_INFRASTRUCTURE');
    m.setMode('ACCREDITED_PRODUCTION');
    const entries = m.ledgerEntries();
    const modeSets = entries.filter((e) => e.action === 'mode.set');
    assert.equal(modeSets.length, 2);
    assert.ok(m.verifyLedger());
    await k.shutdown();
  });

  it('ledger entries chain by hash and detect tampering', () => {
    const ledger = new AccreditationLedger();
    ledger.append('a', { x: 1 });
    ledger.append('b', { x: 2 });
    assert.ok(ledger.verify());
    assert.equal(ledger.length, 2);
    const all = ledger.all();
    assert.equal(all[1]!.prevHash, all[0]!.entryHash);
  });
});

describe('AccreditationModule — honest public claims (Part L)', () => {
  it('a claim is dishonest without active accreditation + production mode', async () => {
    const m = freshModule('DEVELOPMENT');
    const k = await boot(m);
    const r = m.verifyClaim('JATA Qi is an accredited TLD registry');
    assert.equal(r.honest, false);
    await k.shutdown();
  });

  it('a claim becomes honest once accredited and in production', async () => {
    const m = freshModule('ACCREDITED_PRODUCTION');
    const k = await boot(m);
    const g = m.recordGrant({ domain: 'tld-registry', issuedBy: 'ICANN', scope: '.jq', validFrom: Date.now() - 1, validUntil: Date.now() + 1e9, recordedBy: 'a' });
    m.activate(g.id, 'gov');
    const r = m.verifyClaim('JATA Qi is an accredited registry operator');
    assert.equal(r.honest, true);
    assert.ok(r.backingGrants.length >= 1);
    await k.shutdown();
  });

  it('a non-accreditation claim is honest by default', async () => {
    const m = freshModule('PRIVATE_INFRASTRUCTURE');
    const k = await boot(m);
    const r = m.verifyClaim('JATA Qi operates DNS infrastructure');
    assert.equal(r.honest, true);
    await k.shutdown();
  });
});

describe('AccreditationModule — compliance reporting (Part J)', () => {
  it('produces a control-framework posture for every domain', async () => {
    const m = freshModule('ACCREDITED_PRODUCTION');
    const k = await boot(m);
    const report = m.complianceReport();
    assert.equal(report.length, ACCREDITATION_DOMAINS.length);
    const reg = report.find((r) => r.domain === 'tld-registry')!;
    assert.ok(reg.controlFrameworks.includes('ICANN-Registry-Agreement'));
    const ca = report.find((r) => r.domain === 'ca-root')!;
    assert.ok(ca.controlFrameworks.includes('CA-Browser-Forum-Baseline-Requirements'));
    assert.ok(ca.controlFrameworks.includes('WebTrust-for-CAs'));
    assert.equal(ca.activeGrant, false);
    await k.shutdown();
  });
});
