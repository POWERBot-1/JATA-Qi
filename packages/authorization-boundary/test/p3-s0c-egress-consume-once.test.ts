// P3-B0 S0c (OD-5) — truthful external-side-effect authorization.
//
// Adversarial evidence for the two coordinated S0c parts:
//
//   (i)  the egress-binding representation: capability manifests may declare
//        `egressBound: true` (registration fact; only the literal `true` is
//        registrable), and the PDP seals that binding into the decision
//        envelope — never derivable from the request, caller metadata, model
//        output, or tool input (no such input path exists).
//   (ii) consume-once enforcement at ALL THREE required sites
//        (gate.ts in-memory replay check + pre-await consumption, and the
//        durable S-4 claim in consumption-stores.ts), driven by the single
//        shared predicate `requiresEnvelopeConsumption`: consume when the
//        decision is non-READ OR egress-bound — an egress-bound envelope
//        labeled READ (the exact F-3/T-10 shape) still consumes exactly
//        once, while READ stays replayable ONLY for genuinely read-only
//        decisions.
//
// The durable end-to-end section runs against real embedded PostgreSQL
// (fail-hard harness — no silent skip), the same posture as the other R2
// suites.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ICollection, CasWriteResult } from '@jataqi/storage';
import {
  AuthorizationDeniedError,
  CapabilityManifestRegistry,
  ManifestRejectedError,
  assertAllowedAuditShape,
  consumeEnvelope,
  isNarrowing,
  requiresEnvelopeConsumption,
  type A01CapabilityManifest,
  type ConsumedEnvelopeDoc,
} from '../src/index.js';
import { baseRequest, makeGate, manifest, T0 } from './helpers.js';
import { bootR2Postgres, type R2Postgres } from './r2-pg.js';
import {
  buildR2World,
  durableManifest,
  durableRequest,
  mintSession,
  registrar,
  uniqueCapability,
  type R2World,
} from './r2-fixtures.js';

const EXPECTED = { tool: 'test-tool', operation: 'do', targetResource: 'res-1' } as const;

/** The OD-5 capability id named by the P3-B0 design record §4.5(i). */
const EGRESS_CAPABILITY = 'internal-knowledge.vector-search-egress';
/** The pre-S0c false capability (F-3 declared vector.search under it as READ). */
const FALSE_CAPABILITY = 'internal-knowledge.read';

function egressManifest(overrides: Record<string, unknown> = {}): A01CapabilityManifest {
  return manifest({
    capabilityId: EGRESS_CAPABILITY,
    maxImpact: 'EXTERNAL_SIDE_EFFECT',
    egressBound: true,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// A. Registration discipline — the egress binding is a governance fact
// ---------------------------------------------------------------------------

describe('S0c OD-5(i): egress-binding registration discipline', () => {
  it('registers a manifest declaring egressBound: true', () => {
    const registry = new CapabilityManifestRegistry();
    registry.register(egressManifest());
    const registered = registry.latest(EGRESS_CAPABILITY);
    assert.equal(registered?.egressBound, true, 'the registered manifest carries the egress binding');
    assert.equal(registered?.maxImpact, 'EXTERNAL_SIDE_EFFECT');
  });

  it('refuses an explicit egressBound: false (ambiguous declaration, fail-closed)', () => {
    const registry = new CapabilityManifestRegistry();
    assert.throws(
      () => registry.register(manifest({ capabilityId: 'cap.ambiguous', egressBound: false })),
      (error: unknown) => error instanceof ManifestRejectedError && /egressBound/.test(error.message),
    );
  });

  it('refuses a non-boolean egressBound value (runtime shape validation)', () => {
    const registry = new CapabilityManifestRegistry();
    assert.throws(
      () => registry.register(manifest({ capabilityId: 'cap.nonbool', egressBound: 'true' }) as unknown as A01CapabilityManifest),
      ManifestRejectedError,
    );
  });

  it('the new capabilityId is distinct from the false capability and does not resurrect it', () => {
    assert.notEqual(EGRESS_CAPABILITY, FALSE_CAPABILITY);
    // The false capability name must not be silently broadened into the
    // egress one: a registration under the OLD id keeps its own identity.
    const registry = new CapabilityManifestRegistry();
    registry.register(manifest({ capabilityId: FALSE_CAPABILITY, maxImpact: 'READ' }));
    registry.register(egressManifest());
    assert.equal(registry.latest(FALSE_CAPABILITY)?.maxImpact, 'READ');
    assert.equal(registry.latest(EGRESS_CAPABILITY)?.maxImpact, 'EXTERNAL_SIDE_EFFECT');
  });

  it('B-1 preserved: raising the impact ceiling of an existing capability is still rejected (isNarrowing untouched)', () => {
    const previous = manifest({ capabilityId: 'cap.narrow', version: '1', maxImpact: 'READ' });
    const raised = manifest({ capabilityId: 'cap.narrow', version: '2', maxImpact: 'EXTERNAL_SIDE_EFFECT' });
    const check = isNarrowing(previous, raised);
    assert.equal(check.ok, false, 'a ceiling raise must still be refused — this is exactly why S0c uses a NEW capabilityId');
    assert.match(check.violation ?? '', /impact ceiling/);
    // And the registry enforces it end-to-end.
    const registry = new CapabilityManifestRegistry();
    registry.register(previous);
    assert.throws(() => registry.register(raised), ManifestRejectedError);
  });
});

// ---------------------------------------------------------------------------
// B. Shared consumption predicate — one implementation, no drift
// ---------------------------------------------------------------------------

describe('S0c OD-5(ii): the single consumption predicate', () => {
  it('consumes every non-READ envelope (prior semantics preserved)', () => {
    assert.equal(requiresEnvelopeConsumption({ impact: 'REVERSIBLE_WRITE' }), true);
    assert.equal(requiresEnvelopeConsumption({ impact: 'CONSEQUENTIAL_WRITE' }), true);
    assert.equal(requiresEnvelopeConsumption({ impact: 'EXTERNAL_SIDE_EFFECT' }), true);
  });

  it('consumes a READ-labeled envelope when it is egress-bound (the F-3 shape)', () => {
    assert.equal(requiresEnvelopeConsumption({ impact: 'READ', egressBound: true }), true);
    assert.equal(requiresEnvelopeConsumption({ impact: 'EXTERNAL_SIDE_EFFECT', egressBound: true }), true);
  });

  it('does NOT consume a genuinely read-only READ envelope (true-read parity preserved)', () => {
    assert.equal(requiresEnvelopeConsumption({ impact: 'READ' }), false);
    assert.equal(requiresEnvelopeConsumption({ impact: 'READ', egressBound: undefined }), false);
  });
});

// ---------------------------------------------------------------------------
// C. R1 in-memory gate — sites 1+2 (replay check + pre-await consumption)
// ---------------------------------------------------------------------------

describe('S0c OD-5(ii): R1 gate consume-once at both in-memory sites', () => {
  it('valid S0c authorization succeeds and the envelope seals the egress binding', () => {
    const g = makeGate();
    g.manifests.register(egressManifest());
    const envelope = g.gate.decide(baseRequest({ capability: { capabilityId: EGRESS_CAPABILITY, capabilityVersion: '1' } }));
    assert.equal(envelope.decision.decision, 'ALLOW');
    assert.equal(envelope.egressBound, true, 'the PDP seals the manifest egress binding into the envelope');
    assert.equal(envelope.impact, 'EXTERNAL_SIDE_EFFECT');
    let calls = 0;
    const result = g.gate.executeAuthorized(envelope, async () => { calls += 1; return 'sent'; }, { ...EXPECTED });
    return result.then((value) => {
      assert.equal(value, 'sent');
      assert.equal(calls, 1, 'the side effect ran exactly once');
    });
  });

  it('a non-egress decision seals NO egress binding (no widening of unrelated decisions)', () => {
    const g = makeGate();
    g.registerTestManifest({ maxImpact: 'READ' });
    const envelope = g.gate.decide(baseRequest({ impact: 'READ' }));
    assert.equal(envelope.decision.decision, 'ALLOW');
    assert.equal(envelope.egressBound, undefined, 'absence of a binding is not the same as false; nothing is sealed');
  });

  it('second use of the same egress envelope fails (REPLAYED_AUTHORIZATION)', async () => {
    const g = makeGate();
    g.manifests.register(egressManifest());
    const envelope = g.gate.decide(baseRequest({ capability: { capabilityId: EGRESS_CAPABILITY, capabilityVersion: '1' } }));
    let calls = 0;
    await g.gate.executeAuthorized(envelope, async () => { calls += 1; }, { ...EXPECTED });
    await assert.rejects(
      () => g.gate.executeAuthorized(envelope, async () => { calls += 1; }, { ...EXPECTED }),
      (error: unknown) => {
        assert.ok(error instanceof AuthorizationDeniedError);
        assert.ok(error.reasons.includes('REPLAYED_AUTHORIZATION'));
        return true;
      },
    );
    assert.equal(calls, 1, 'the governed side effect never ran twice');
    const consumed = g.audit.consumed();
    assert.ok(consumed.some((r) => r.sideEffectInvoked === true), 'first use audited as executed');
    assert.ok(consumed.some((r) => r.sideEffectInvoked === false), 'the replay audited as denied');
  });

  it('replay after successful consumption fails even after time advances', async () => {
    const g = makeGate();
    g.manifests.register(egressManifest());
    const envelope = g.gate.decide(baseRequest({ capability: { capabilityId: EGRESS_CAPABILITY, capabilityVersion: '1' } }));
    await g.gate.executeAuthorized(envelope, async () => 'ok', { ...EXPECTED });
    g.advance(5_000); // still inside the decision lifetime — the replay fails on CONSUMPTION, not expiry
    await assert.rejects(
      () => g.gate.executeAuthorized(envelope, async () => 'again', { ...EXPECTED }),
      (error: unknown) => error instanceof AuthorizationDeniedError && error.reasons.includes('REPLAYED_AUTHORIZATION'),
    );
  });

  it('F-3 shape: an egress-bound envelope labeled READ still consumes exactly once', async () => {
    const g = makeGate();
    // A manifest whose ceiling ALLOWS a READ declaration yet whose binding
    // says the capability transmits — the misdeclaration F-3 proved possible.
    g.manifests.register(egressManifest({ maxImpact: 'READ' }));
    const envelope = g.gate.decide(
      baseRequest({ capability: { capabilityId: EGRESS_CAPABILITY, capabilityVersion: '1' }, impact: 'READ' }),
    );
    assert.equal(envelope.decision.decision, 'ALLOW');
    assert.equal(envelope.impact, 'READ', 'the envelope carries the declared (misleading) label…');
    assert.equal(envelope.egressBound, true, '…and the sealed binding that overrides it for consumption');
    let calls = 0;
    await g.gate.executeAuthorized(envelope, async () => { calls += 1; }, { ...EXPECTED });
    await assert.rejects(
      () => g.gate.executeAuthorized(envelope, async () => { calls += 1; }, { ...EXPECTED }),
      (error: unknown) => error instanceof AuthorizationDeniedError && error.reasons.includes('REPLAYED_AUTHORIZATION'),
    );
    assert.equal(calls, 1, 'one authorization ⇒ exactly one transmission, despite the READ label');
  });

  it('genuinely read-only READ decisions keep the pre-S0c replay parity', async () => {
    const g = makeGate();
    g.registerTestManifest({ maxImpact: 'READ' });
    const envelope = g.gate.decide(baseRequest({ impact: 'READ' }));
    let calls = 0;
    await g.gate.executeAuthorized(envelope, async () => { calls += 1; }, { ...EXPECTED });
    await g.gate.executeAuthorized(envelope, async () => { calls += 1; }, { ...EXPECTED });
    assert.equal(calls, 2, 'a true read stays replayable — S0c changes nothing for it');
  });

  it('missing/invalid authorization fails closed (DENY envelope cannot execute)', async () => {
    const g = makeGate();
    // Nothing registered ⇒ UNKNOWN_CAPABILITY deny.
    const denied = g.gate.decide(baseRequest({ capability: { capabilityId: EGRESS_CAPABILITY, capabilityVersion: '1' } }));
    assert.equal(denied.decision.decision, 'DENY');
    assert.ok(denied.decision.reasonCodes.includes('UNKNOWN_CAPABILITY'));
    await assert.rejects(
      () => g.gate.executeAuthorized(denied, async () => 'never', { ...EXPECTED }),
      (error: unknown) => error instanceof AuthorizationDeniedError && error.reasons.includes('ENVELOPE_NOT_ALLOWED'),
    );
  });

  it('a structurally broken envelope fails closed (ENVELOPE_MALFORMED)', async () => {
    const g = makeGate();
    g.manifests.register(egressManifest());
    await assert.rejects(
      () => g.gate.executeAuthorized({ not: 'an envelope' }, async () => 'never', { ...EXPECTED }),
      (error: unknown) =>
        error instanceof AuthorizationDeniedError &&
        (error.reasons.includes('ENVELOPE_MALFORMED') || error.reasons.includes('ENVELOPE_TAMPERED')),
    );
  });

  it('an expired egress envelope fails closed (AUTHORIZATION_EXPIRED)', async () => {
    const g = makeGate();
    g.manifests.register(egressManifest());
    const envelope = g.gate.decide(baseRequest({ capability: { capabilityId: EGRESS_CAPABILITY, capabilityVersion: '1' } }));
    g.advance(61_000); // manifest lifetime is 60_000
    await assert.rejects(
      () => g.gate.executeAuthorized(envelope, async () => 'never', { ...EXPECTED }),
      (error: unknown) => error instanceof AuthorizationDeniedError && error.reasons.includes('AUTHORIZATION_EXPIRED'),
    );
  });

  it('tampering with the sealed egress binding fails closed (downgrade evasion impossible)', async () => {
    const g = makeGate();
    g.manifests.register(egressManifest({ maxImpact: 'READ' }));
    const envelope = g.gate.decide(
      baseRequest({ capability: { capabilityId: EGRESS_CAPABILITY, capabilityVersion: '1' }, impact: 'READ' }),
    );
    assert.equal(envelope.egressBound, true);
    // Attempt: strip the binding so the envelope looks like a replayable READ.
    const stripped = { ...(envelope as unknown as Record<string, unknown>) };
    delete stripped.egressBound;
    await assert.rejects(
      () => g.gate.executeAuthorized(stripped, async () => 'never', { ...EXPECTED }),
      (error: unknown) => error instanceof AuthorizationDeniedError && error.reasons.includes('ENVELOPE_TAMPERED'),
    );
    // Attempt: forge a binding onto a genuine true-read envelope.
    const g2 = makeGate();
    g2.registerTestManifest({ maxImpact: 'READ' });
    const readEnvelope = g2.gate.decide(baseRequest({ impact: 'READ' }));
    const forged = { ...(readEnvelope as unknown as Record<string, unknown>), egressBound: true };
    await assert.rejects(
      () => g2.gate.executeAuthorized(forged, async () => 'never', { ...EXPECTED }),
      (error: unknown) => error instanceof AuthorizationDeniedError && error.reasons.includes('ENVELOPE_TAMPERED'),
    );
  });

  it('cross-tenant reuse fails: the sealed tenant cannot be re-pointed without breaking integrity', async () => {
    const g = makeGate();
    g.manifests.register(egressManifest({ tenantScopes: ['acme', 'globex'] }));
    const envelope = g.gate.decide(baseRequest({ capability: { capabilityId: EGRESS_CAPABILITY, capabilityVersion: '1' } }));
    assert.equal(envelope.tenantId, 'acme');
    const rePointed = { ...(envelope as unknown as Record<string, unknown>), tenantId: 'globex' };
    await assert.rejects(
      () => g.gate.executeAuthorized(rePointed, async () => 'never', { ...EXPECTED }),
      (error: unknown) => error instanceof AuthorizationDeniedError && error.reasons.includes('ENVELOPE_TAMPERED'),
    );
  });

  it('cross-principal reuse fails: the sealed principal cannot be substituted', async () => {
    const g = makeGate();
    g.manifests.register(egressManifest());
    const envelope = g.gate.decide(baseRequest({ capability: { capabilityId: EGRESS_CAPABILITY, capabilityVersion: '1' } }));
    assert.equal(envelope.principal.id, 'user:alice');
    const substituted = {
      ...(envelope as unknown as Record<string, unknown>),
      principal: { ...envelope.principal, id: 'user:mallory' },
    };
    await assert.rejects(
      () => g.gate.executeAuthorized(substituted, async () => 'never', { ...EXPECTED }),
      (error: unknown) => error instanceof AuthorizationDeniedError && error.reasons.includes('ENVELOPE_TAMPERED'),
    );
  });

  it('wrong capabilityId fails: the retired READ capability cannot serve an EXTERNAL_SIDE_EFFECT request', async () => {
    const g = makeGate();
    // Register the old-shape capability (internal read ceiling, no binding).
    g.manifests.register(manifest({ capabilityId: FALSE_CAPABILITY, maxImpact: 'READ' }));
    const envelope = g.gate.decide(
      baseRequest({ capability: { capabilityId: FALSE_CAPABILITY, capabilityVersion: '1' }, impact: 'EXTERNAL_SIDE_EFFECT' }),
    );
    assert.equal(envelope.decision.decision, 'DENY', 'the READ ceiling refuses the egress impact class');
    assert.ok(envelope.decision.reasonCodes.includes('IMPACT_EXCEEDED'));
    await assert.rejects(
      () => g.gate.executeAuthorized(envelope, async () => 'never', { ...EXPECTED }),
      (error: unknown) => error instanceof AuthorizationDeniedError && error.reasons.includes('ENVELOPE_NOT_ALLOWED'),
    );
  });

  it('capability confusion fails: an egress envelope cannot execute a different tool/operation', async () => {
    const g = makeGate();
    g.manifests.register(egressManifest());
    const envelope = g.gate.decide(baseRequest({ capability: { capabilityId: EGRESS_CAPABILITY, capabilityVersion: '1' } }));
    await assert.rejects(
      () => g.gate.executeAuthorized(envelope, async () => 'never', { tool: 'other-tool', operation: 'do', targetResource: 'res-1' }),
      (error: unknown) => error instanceof AuthorizationDeniedError && error.reasons.includes('OPERATION_SUBSTITUTION'),
    );
    await assert.rejects(
      () => g.gate.executeAuthorized(envelope, async () => 'never', { tool: 'test-tool', operation: 'other-op', targetResource: 'res-1' }),
      (error: unknown) => error instanceof AuthorizationDeniedError && error.reasons.includes('OPERATION_SUBSTITUTION'),
    );
    await assert.rejects(
      () => g.gate.executeAuthorized(envelope, async () => 'never', { tool: 'test-tool', operation: 'do', targetResource: 'res-OTHER' }),
      (error: unknown) => error instanceof AuthorizationDeniedError && error.reasons.includes('TARGET_SUBSTITUTION'),
    );
  });

  it('P2 audit invariant intact: the closed audit field set still rejects unknown fields', () => {
    assert.throws(() => assertAllowedAuditShape({ id: 'row-1', smuggled: true }, 's0c-invariant-check'));
    assert.doesNotThrow(() => assertAllowedAuditShape({ id: 'row-1', kind: 'CONSUMED' }, 's0c-invariant-check'));
  });
});

// ---------------------------------------------------------------------------
// D. Durable S-4 claim — site 3 (consumeEnvelope) unit evidence
// ---------------------------------------------------------------------------

/** Minimal in-memory ICollection for site-3 unit tests (only cas/get are exercised). */
function memoryCollection(): ICollection<ConsumedEnvelopeDoc> & { readonly rows: Map<string, ConsumedEnvelopeDoc> } {
  const rows = new Map<string, ConsumedEnvelopeDoc>();
  return {
    rows,
    name: 's0c-memory-consumed',
    async put(doc) { rows.set(doc.id, doc); return doc; },
    async get(id) { return rows.get(id); },
    async delete(id) { return rows.delete(id); },
    async has(id) { return rows.has(id); },
    async query() { return [...rows.values()]; },
    async all() { return [...rows.values()]; },
    async count() { return rows.size; },
    async replaceAll(docs) { rows.clear(); for (const d of docs) rows.set(d.id, d); },
    async clear() { rows.clear(); },
    async cas(id, guard, makeNext): Promise<CasWriteResult<ConsumedEnvelopeDoc>> {
      const cur = rows.get(id);
      if (!guard(cur)) return { ok: false, doc: cur };
      const next = makeNext(cur as ConsumedEnvelopeDoc);
      rows.set(id, next);
      return { ok: true, doc: next };
    },
  } as ICollection<ConsumedEnvelopeDoc> & { readonly rows: Map<string, ConsumedEnvelopeDoc> };
}

const S4_INPUT = {
  decisionId: 'dec-s0c-1',
  tenantId: 'acme',
  principalId: 'user:alice',
  runId: 'run-s0c',
  now: T0,
} as const;

describe('S0c OD-5(ii): durable S-4 consume-once (site 3)', () => {
  it('a genuinely read-only READ decision is still NOT consumed (parity preserved)', async () => {
    const consumed = memoryCollection();
    const result = await consumeEnvelope(consumed, { ...S4_INPUT, envelopeId: 'env-read', impact: 'READ' });
    assert.deepEqual(result, { consumed: false });
    assert.equal(consumed.rows.size, 0, 'no S-4 row for a true read');
  });

  it('a READ-labeled but egress-bound decision IS consumed exactly once (F-3 shape, durable)', async () => {
    const consumed = memoryCollection();
    const first = await consumeEnvelope(consumed, { ...S4_INPUT, envelopeId: 'env-egress-read', impact: 'READ', egressBound: true });
    assert.deepEqual(first, { consumed: true });
    assert.equal(consumed.rows.size, 1);
    const row = consumed.rows.get('env-egress-read');
    assert.ok(row, 'the consumption row exists');
    assert.equal(row!.tenantId, 'acme');
    assert.equal(row!.decisionId, 'dec-s0c-1');
    await assert.rejects(
      () => consumeEnvelope(consumed, { ...S4_INPUT, envelopeId: 'env-egress-read', impact: 'READ', egressBound: true }),
      (error: unknown) => error instanceof AuthorizationDeniedError && error.reasons.includes('REPLAYED_AUTHORIZATION'),
    );
    assert.equal(consumed.rows.size, 1, 'the replay inserted nothing');
  });

  it('an EXTERNAL_SIDE_EFFECT decision consumes (prior semantics preserved)', async () => {
    const consumed = memoryCollection();
    const first = await consumeEnvelope(consumed, { ...S4_INPUT, envelopeId: 'env-ext', impact: 'EXTERNAL_SIDE_EFFECT' });
    assert.deepEqual(first, { consumed: true });
    await assert.rejects(
      () => consumeEnvelope(consumed, { ...S4_INPUT, envelopeId: 'env-ext', impact: 'EXTERNAL_SIDE_EFFECT' }),
      (error: unknown) => error instanceof AuthorizationDeniedError && error.reasons.includes('REPLAYED_AUTHORIZATION'),
    );
  });

  it('cross-tenant reuse of a consumed envelope fails closed', async () => {
    const consumed = memoryCollection();
    await consumeEnvelope(consumed, { ...S4_INPUT, envelopeId: 'env-xtenant', impact: 'READ', egressBound: true });
    // A different tenant claims the SAME envelope id: the insert-if-absent
    // claim refuses it — there is no cross-tenant reuse window.
    await assert.rejects(
      () => consumeEnvelope(consumed, { ...S4_INPUT, tenantId: 'globex', envelopeId: 'env-xtenant', impact: 'READ', egressBound: true }),
      (error: unknown) => error instanceof AuthorizationDeniedError && error.reasons.includes('REPLAYED_AUTHORIZATION'),
    );
    const row = consumed.rows.get('env-xtenant');
    assert.equal(row!.tenantId, 'acme', 'the original tenant row is untouched');
  });

  it('cross-principal reuse of a consumed envelope fails closed', async () => {
    const consumed = memoryCollection();
    await consumeEnvelope(consumed, { ...S4_INPUT, envelopeId: 'env-xprincipal', impact: 'EXTERNAL_SIDE_EFFECT' });
    await assert.rejects(
      () => consumeEnvelope(consumed, { ...S4_INPUT, principalId: 'user:mallory', runId: 'run-other', envelopeId: 'env-xprincipal', impact: 'EXTERNAL_SIDE_EFFECT' }),
      (error: unknown) => error instanceof AuthorizationDeniedError && error.reasons.includes('REPLAYED_AUTHORIZATION'),
    );
    const row = consumed.rows.get('env-xprincipal');
    assert.equal(row!.consumedBy.principalId, 'user:alice', 'the original principal binding is untouched');
  });

  it('malformed inputs fail closed (missing envelopeId / malformed tenant)', async () => {
    const consumed = memoryCollection();
    await assert.rejects(
      () => consumeEnvelope(consumed, { ...S4_INPUT, envelopeId: '', impact: 'READ', egressBound: true }),
      /envelopeId/,
    );
    await assert.rejects(
      () => consumeEnvelope(consumed, { ...S4_INPUT, envelopeId: 'env-malformed-tenant', tenantId: 'bad tenant!', impact: 'READ', egressBound: true }),
      (error: unknown) => error instanceof Error && /tenant/i.test(error.message),
    );
    assert.equal(consumed.rows.size, 0, 'no row written on malformed input');
  });
});

// ---------------------------------------------------------------------------
// E. Durable end-to-end — sites 1–3 integrated over real PostgreSQL
// ---------------------------------------------------------------------------

let pg: R2Postgres;
let world: R2World;

before(async () => {
  pg = await bootR2Postgres('p3s0c', 59100);
  world = await buildR2World(pg.connectionString, Date.now());
});

after(async () => {
  await pg.stop();
});

describe('S0c OD-5(ii): durable end-to-end consume-once over real PostgreSQL', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'S0c durable evidence requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('seals the egress binding on the durable decision path and consumes exactly once', async () => {
    const capabilityId = uniqueCapability('s0c.egress');
    await world.store.registerManifestVersion(durableManifest(capabilityId, { egressBound: true }), registrar());
    const session = await mintSession(world);
    const envelope = await world.gate.decideAsync(
      durableRequest(capabilityId, session, { run: { runId: `run-${process.pid}-1`, correlationId: 'corr-1' } }),
    );
    assert.equal(envelope.decision.decision, 'ALLOW');
    assert.equal(envelope.egressBound, true, 'the durable path seals the manifest binding');
    let calls = 0;
    await world.gate.executeAuthorized(envelope, async () => { calls += 1; return 'sent'; }, { tool: 'test-tool', operation: 'do' });
    assert.equal(calls, 1);
    await assert.rejects(
      () => world.gate.executeAuthorized(envelope, async () => { calls += 1; }, { tool: 'test-tool', operation: 'do' }),
      (error: unknown) => error instanceof AuthorizationDeniedError && error.reasons.includes('REPLAYED_AUTHORIZATION'),
    );
    assert.equal(calls, 1, 'the durable S-4 claim refused the replay');
  });

  it('F-3 shape durable: READ-labeled egress-bound envelope consumes exactly once on real PG', async () => {
    const capabilityId = uniqueCapability('s0c.f3shape');
    await world.store.registerManifestVersion(
      durableManifest(capabilityId, { maxImpact: 'READ', egressBound: true }),
      registrar(),
    );
    const session = await mintSession(world);
    const envelope = await world.gate.decideAsync(
      durableRequest(capabilityId, session, {
        impact: 'READ',
        run: { runId: `run-${process.pid}-2`, correlationId: 'corr-2' },
      }),
    );
    assert.equal(envelope.decision.decision, 'ALLOW');
    assert.equal(envelope.impact, 'READ');
    assert.equal(envelope.egressBound, true);
    let calls = 0;
    await world.gate.executeAuthorized(envelope, async () => { calls += 1; }, { tool: 'test-tool', operation: 'do' });
    await assert.rejects(
      () => world.gate.executeAuthorized(envelope, async () => { calls += 1; }, { tool: 'test-tool', operation: 'do' }),
      (error: unknown) => error instanceof AuthorizationDeniedError && error.reasons.includes('REPLAYED_AUTHORIZATION'),
    );
    assert.equal(calls, 1, 'one authorization ⇒ one transmission even when the label says READ (site 3 enforced it)');
  });

  it('durable true-read parity: a genuinely read-only READ decision still executes repeatedly', async () => {
    const capabilityId = uniqueCapability('s0c.trueread');
    await world.store.registerManifestVersion(durableManifest(capabilityId, { maxImpact: 'READ' }), registrar());
    const session = await mintSession(world);
    const envelope = await world.gate.decideAsync(
      durableRequest(capabilityId, session, {
        impact: 'READ',
        run: { runId: `run-${process.pid}-3`, correlationId: 'corr-3' },
      }),
    );
    assert.equal(envelope.decision.decision, 'ALLOW');
    assert.equal(envelope.egressBound, undefined);
    let calls = 0;
    await world.gate.executeAuthorized(envelope, async () => { calls += 1; }, { tool: 'test-tool', operation: 'do' });
    await world.gate.executeAuthorized(envelope, async () => { calls += 1; }, { tool: 'test-tool', operation: 'do' });
    assert.equal(calls, 2, 'S0c changed nothing for true reads on the durable path');
  });

  it('durable wrong-capability: an unregistered egress capabilityId denies UNKNOWN_CAPABILITY', async () => {
    const session = await mintSession(world);
    const envelope = await world.gate.decideAsync(
      durableRequest(`s0c.missing.${process.pid}`, session, { run: { runId: `run-${process.pid}-4`, correlationId: 'corr-4' } }),
    );
    assert.equal(envelope.decision.decision, 'DENY');
    assert.ok(envelope.decision.reasonCodes.includes('UNKNOWN_CAPABILITY'));
    await assert.rejects(
      () => world.gate.executeAuthorized(envelope, async () => 'never', { tool: 'test-tool', operation: 'do' }),
      (error: unknown) => error instanceof AuthorizationDeniedError && error.reasons.includes('ENVELOPE_NOT_ALLOWED'),
    );
  });
});
