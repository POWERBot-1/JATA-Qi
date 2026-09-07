// A-01 core: sealed envelope integrity/immutability, capability manifest
// registry rules (registration rejection + monotonic narrowing), credential
// broker semantics, and privacy-safe audit records.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AuthorizationDeniedError,
  EnvelopeIntegrityError,
  InMemoryCredentialBroker,
  ManifestRejectedError,
  assertEnvelopeIntegrity,
  isEnvelopeIntact,
  a01ActionDigest,
  type A01AuthorizationEnvelope,
  type A01PrincipalBinding,
} from '../src/index.js';
import { T0, baseRequest, manifest, makeApproval, makeGate, spySideEffect } from './helpers.js';

describe('A-01 sealed authorization envelope', () => {
  it('seals a decision into a deep-frozen, digest-protected envelope', () => {
    const t = makeGate();
    t.registerTestManifest();
    const envelope = t.gate.decide(baseRequest());
    assert.equal(envelope.decision.decision, 'ALLOW');
    assert.equal(Object.isFrozen(envelope), true);
    assert.equal(Object.isFrozen(envelope.principal), true);
    assert.equal(Object.isFrozen(envelope.decision), true);
    assert.equal(envelope.integrity.algorithm, 'sha256');
    assert.match(envelope.integrity.digest, /^[0-9a-f]{64}$/);
    assertEnvelopeIntegrity(envelope);
    assert.equal(isEnvelopeIntact(envelope), true);
  });

  it('detects in-process tampering of every authoritative field', () => {
    const t = makeGate();
    t.registerTestManifest();
    const envelope = t.gate.decide(baseRequest());
    const fields: Array<[string, (env: Record<string, unknown>) => void]> = [
      ['principal.id', (e) => { (e.principal as Record<string, unknown>).id = 'user:mallory'; }],
      ['principal.tenantId', (e) => { (e.principal as Record<string, unknown>).tenantId = 'other'; }],
      ['principal.authenticationMethod', (e) => { (e.principal as Record<string, unknown>).authenticationMethod = 'OIDC'; }],
      ['principal.authenticationEventId', (e) => { (e.principal as Record<string, unknown>).authenticationEventId = 'forged'; }],
      ['tenantId', (e) => { e.tenantId = 'other'; }],
      ['agent.agentId', (e) => { (e.agent as Record<string, unknown>).agentId = 'agent-rogue'; }],
      ['run.runId', (e) => { (e.run as Record<string, unknown>).runId = 'run-forged'; }],
      ['capability.capabilityId', (e) => { (e.capability as Record<string, unknown>).capabilityId = 'cap.other'; }],
      ['tool', (e) => { e.tool = 'other-tool'; }],
      ['operation', (e) => { e.operation = 'other-operation'; }],
      ['target.system', (e) => { (e.target as Record<string, unknown>).system = 'other-system'; }],
      ['target.resource', (e) => { (e.target as Record<string, unknown>).resource = 'res-other'; }],
      ['dataClassification', (e) => { e.dataClassification = 'RESTRICTED'; }],
      ['impact', (e) => { e.impact = 'READ'; }],
      ['approval.approvalId', (e) => { e.approval = { ...(e.approval as object), approvalId: 'other' }; }],
      ['credential.credentialId', (e) => { e.credential = { ...(e.credential as object), credentialId: 'other' }; }],
      ['provenance.correlationId', (e) => { (e.provenance as Record<string, unknown>).correlationId = 'corr-other'; }],
      ['decision.decision', (e) => { e.decision = { ...(e.decision as object), decision: 'DENY' }; }],
    ];
    for (const [name, mutate] of fields) {
      const copy: Record<string, unknown> = JSON.parse(JSON.stringify(envelope));
      mutate(copy);
      assert.equal(isEnvelopeIntact(copy), false, `tampering "${name}" must be detected`);
      assert.throws(() => assertEnvelopeIntegrity(copy), EnvelopeIntegrityError, `tamper detection for ${name}`);
    }
  });

  it('rejects structurally malformed envelopes', () => {
    assert.throws(() => assertEnvelopeIntegrity(null), EnvelopeIntegrityError);
    assert.throws(() => assertEnvelopeIntegrity({}), EnvelopeIntegrityError);
    assert.throws(() => assertEnvelopeIntegrity('garbage'), EnvelopeIntegrityError);
    const t = makeGate();
    t.registerTestManifest();
    const envelope = t.gate.decide(baseRequest());
    const broken: Record<string, unknown> = JSON.parse(JSON.stringify(envelope));
    delete (broken as Record<string, unknown>).integrity;
    assert.equal(isEnvelopeIntact(broken), false);
  });

  it('denies execution of a tampered envelope BEFORE the side effect', async () => {
    const t = makeGate();
    t.registerTestManifest();
    const envelope = t.gate.decide(baseRequest());
    const copy: Record<string, unknown> = JSON.parse(JSON.stringify(envelope));
    (copy.principal as Record<string, unknown>).id = 'user:mallory';
    const spy = spySideEffect();
    await assert.rejects(
      () => t.gate.executeAuthorized(copy, spy.fn, { tool: 'test-tool', operation: 'do' }),
      (err: unknown) => err instanceof AuthorizationDeniedError,
    );
    assert.equal(spy.state.calls, 0, 'side effect must not run for a tampered envelope');
  });

  it('denies a DENY decision envelope at execution (no fail-open on the decision)', async () => {
    const t = makeGate();
    // Unknown capability -> DENY envelope.
    const envelope = t.gate.decide(baseRequest({ capability: { capabilityId: 'cap.unknown', capabilityVersion: '1' } }));
    assert.equal(envelope.decision.decision, 'DENY');
    const spy = spySideEffect();
    await assert.rejects(
      () => t.gate.executeAuthorized(envelope, spy.fn, { tool: 'test-tool', operation: 'do' }),
      AuthorizationDeniedError,
    );
    assert.equal(spy.state.calls, 0);
  });
});

describe('A-01 capability manifest registry', () => {
  it('rejects malformed and over-privileged manifests at registration', () => {
    const t = makeGate();
    const reject = (overrides: Record<string, unknown>, match: RegExp) =>
      assert.throws(() => t.manifests.register(manifest(overrides)), (err: unknown) =>
        err instanceof ManifestRejectedError && match.test(err.message),
      );
    reject({ allowedOperations: [] }, /empty operation allow-list/);
    reject({ allowedTargets: [] }, /empty target allow-list/);
    reject({ allowedOperations: [{ tool: '*', operation: 'do' }] }, /wildcard/);
    reject({ allowedOperations: [{ tool: 't', operation: 'do*' }] }, /wildcard/);
    reject({ tenantScopes: [], allowTenantWildcard: false }, /ambiguous/);
    reject({ maxDataClassification: 'TOP_SECRET' }, /classification/);
    reject({ maxImpact: 'NUCLEAR' }, /impact/);
    reject({ rateLimit: { windowMs: 0, max: 1 } }, /rateLimit/);
    reject({ budgetPerRunCostUnits: 0 }, /budget/);
    reject({ maxLifetimeMs: -1 }, /maxLifetimeMs/);
    reject({ registeredBy: { principalId: '', tenantId: 'acme' } }, /registeredBy/);
  });

  it('keeps a version immutable: re-registration is rejected', () => {
    const t = makeGate();
    t.manifests.register(manifest());
    assert.throws(() => t.manifests.register(manifest()), /already registered/);
  });

  it('allows narrowing in a new version and rejects every widening', () => {
    const t = makeGate();
    t.manifests.register(manifest({ allowedOperations: [{ tool: 'test-tool', operation: 'do' }, { tool: 'test-tool', operation: 'other' }] }));
    // Narrowing: drop an operation, tighten rate, tighten budget, shorten lifetime.
    t.manifests.register(manifest({
      version: '2',
      allowedOperations: [{ tool: 'test-tool', operation: 'do' }],
      rateLimit: { windowMs: 30_000, max: 50 },
      budgetPerRunCostUnits: 50,
      maxLifetimeMs: 30_000,
      maxImpact: 'REVERSIBLE_WRITE',
    }));
    assert.ok(t.manifests.get('cap.test', '2'));

    const widening = (overrides: Record<string, unknown>, match: RegExp) =>
      assert.throws(
        () =>
          t.manifests.register(
            manifest({
              version: '3',
              allowedOperations: [{ tool: 'test-tool', operation: 'do' }],
              rateLimit: { windowMs: 30_000, max: 50 },
              budgetPerRunCostUnits: 50,
              maxLifetimeMs: 30_000,
              maxImpact: 'REVERSIBLE_WRITE',
              ...overrides,
            }),
          ),
        (err: unknown) => err instanceof ManifestRejectedError && match.test(err.message),
      );
    widening({ allowedOperations: [{ tool: 'test-tool', operation: 'new-op' }] }, /adds operation/);
    widening({ allowedTargets: [{ system: 'other-system' }] }, /widens target/);
    widening({ tenantScopes: ['acme', 'other'] }, /widens tenant/);
    widening({ maxDataClassification: 'RESTRICTED' }, /classification/);
    widening({ maxImpact: 'EXTERNAL_SIDE_EFFECT' }, /impact/);
    widening({ rateLimit: { windowMs: 30_000, max: 51 } }, /rate limit/);
    widening({ budgetPerRunCostUnits: 51 }, /budget/);
    widening({ maxLifetimeMs: 31_000 }, /lifetime/);
  });

  it('rejects dropping the approval requirement or a credential scope in a new version', () => {
    const t = makeGate();
    t.manifests.register(manifest({ requiresApproval: true, requiredCredentialScopes: ['read:res'] }));
    assert.throws(() => t.manifests.register(manifest({ version: '2', requiresApproval: false })), /drops the approval requirement/);
    assert.throws(() => t.manifests.register(manifest({ version: '2', requiresApproval: true, requiredCredentialScopes: [] })), /drops required credential scope/);
  });
});

describe('A-01 credential broker', () => {
  function issueFixture() {
    const broker = new InMemoryCredentialBroker({ now: () => T0 });
    const issued = broker.issue({
      credentialId: 'cred-1',
      principalId: 'user:alice',
      tenantId: 'acme',
      capabilityId: 'cap.test',
      tool: 'test-tool',
      operation: 'do',
      audience: 'test-system',
      scopes: ['read:res'],
      lifetimeMs: 60_000,
      issuedBy: 'a01-test',
      secretMaterial: 'test-material-0001',
    });
    return { broker, issued };
  }

  function viewOf(envelope: A01AuthorizationEnvelope) {
    return {
      envelopeId: envelope.envelopeId,
      principal: { id: envelope.principal.id },
      tenantId: envelope.tenantId,
      capability: { capabilityId: envelope.capability.capabilityId },
      tool: envelope.tool,
      operation: envelope.operation,
      target: { audience: envelope.target.audience },
      credential: envelope.credential,
    };
  }

  it('delivers material once at issue and validates binding at acquire', async () => {
    const { broker, issued } = issueFixture();
    assert.equal(issued.material, 'test-material-0001');
    const t = makeGate({ broker });
    t.registerTestManifest({ requiredCredentialScopes: ['read:res'], credentialAudience: 'test-system' });
    const envelope = t.gate.decide(baseRequest({
      credential: { credentialId: 'cred-1', audience: 'test-system', scopes: ['read:res'] },
      target: { system: 'test-system', resource: 'res-1', audience: 'test-system' },
    }));
    assert.equal(envelope.decision.decision, 'ALLOW');
    const spy = spySideEffect();
    await t.gate.executeAuthorized(envelope, spy.fn, { tool: 'test-tool', operation: 'do' });
    assert.equal(spy.state.calls, 1);
    assert.equal(spy.state.sawCredential?.credential?.material, 'test-material-0001', 'scoped credential delivered at the enforcement point');
    assert.equal(spy.state.sawCredential?.credential?.audience, 'test-system');
  });

  it('rejects expired, revoked, mismatched, under-scoped, and replayed credentials', () => {
    const { broker, issued } = issueFixture();
    void issued;
    // Expired (mutable clock: issue at T0, check at T0+120s)
    let expiredClock = T0;
    const expired = new InMemoryCredentialBroker({ now: () => expiredClock });
    expired.issue({
      credentialId: 'cred-x', principalId: 'user:alice', tenantId: 'acme', capabilityId: 'cap.test',
      tool: 'test-tool', operation: 'do', audience: 'test-system', scopes: ['read:res'], lifetimeMs: 60_000, issuedBy: 't',
    });
    expiredClock += 120_000;
    const view = {
      envelopeId: 'env-1',
      principal: { id: 'user:alice' },
      tenantId: 'acme',
      capability: { capabilityId: 'cap.test' },
      tool: 'test-tool',
      operation: 'do',
      target: { audience: 'test-system' },
      credential: { credentialId: 'cred-x', audience: 'test-system', scopes: ['read:res'] },
    };
    assert.deepEqual(expired.checkFor(view, ['read:res']), ['CREDENTIAL_EXPIRED']);

    // Audience mismatch
    assert.ok(broker.checkFor({ ...view, credential: { credentialId: 'cred-1', audience: 'evil-system', scopes: ['read:res'] } }, []).includes('CREDENTIAL_AUDIENCE_MISMATCH'));

    // Principal mismatch
    assert.ok(broker.checkFor({ ...view, principal: { id: 'user:mallory' }, credential: { credentialId: 'cred-1', audience: 'test-system', scopes: ['read:res'] } }, []).includes('CREDENTIAL_BINDING_MISMATCH'));

    // Under-scoped
    assert.ok(broker.checkFor({ ...view, credential: { credentialId: 'cred-1', audience: 'test-system', scopes: ['read:res'] } }, ['write:res']).includes('CREDENTIAL_SCOPE_INSUFFICIENT'));

    // Missing credential
    assert.deepEqual(broker.checkFor({ ...view, credential: undefined }, []), ['CREDENTIAL_MISSING']);

    // Revoked (checked last: revocation short-circuits other checks)
    broker.revoke('cred-1');
    assert.deepEqual(broker.checkFor({ ...view, credential: { credentialId: 'cred-1', audience: 'test-system', scopes: ['read:res'] } }, ['read:res']), ['CREDENTIAL_REVOKED']);

    // Replay: second use for the same envelope id. Acquire once via a sealed
    // envelope, then the same envelope must be refused.
    broker.issue({
      credentialId: 'cred-replay',
      principalId: 'user:alice',
      tenantId: 'acme',
      capabilityId: 'cap.test',
      tool: 'test-tool',
      operation: 'do',
      audience: 'test-system',
      scopes: ['read:res'],
      lifetimeMs: 60_000,
      issuedBy: 't',
      secretMaterial: 'test-material-replay',
    });
    const t = makeGate({ broker });
    t.registerTestManifest();
    const env = t.gate.decide(baseRequest({
      credential: { credentialId: 'cred-replay', audience: 'test-system', scopes: ['read:res'] },
      target: { system: 'test-system', resource: 'res-1', audience: 'test-system' },
    }));
    const first = broker.acquireFor(env, ['read:res']);
    assert.equal(first.material, 'test-material-replay');
    assert.ok(broker.checkFor(viewOf(env), ['read:res']).includes('CREDENTIAL_REPLAY'));
  });

  it('never places secret material in audit records', async () => {
    const { broker } = issueFixture();
    const t = makeGate({ broker });
    t.registerTestManifest({ requiredCredentialScopes: ['read:res'], credentialAudience: 'test-system' });
    const envelope = t.gate.decide(baseRequest({
      credential: { credentialId: 'cred-1', audience: 'test-system', scopes: ['read:res'] },
      target: { system: 'test-system', resource: 'res-1', audience: 'test-system' },
    }));
    await t.gate.executeAuthorized(envelope, spySideEffect().fn, { tool: 'test-tool', operation: 'do' });
    for (const record of t.audit.records) {
      assert.equal(JSON.stringify(record).includes('test-material-0001'), false, 'audit records must not contain secret material');
      assert.equal(record.credentialReference?.credentialId, 'cred-1');
    }
  });

  it('an unavailable broker fails the decision closed when a credential is required', () => {
    const broker = new InMemoryCredentialBroker({ now: () => T0 });
    broker.setAvailable(false);
    const t = makeGate({ broker });
    t.registerTestManifest({ requiredCredentialScopes: ['read:res'], credentialAudience: 'test-system' });
    const envelope = t.gate.decide(baseRequest({
      credential: { credentialId: 'cred-1', audience: 'test-system', scopes: ['read:res'] },
      target: { system: 'test-system', resource: 'res-1', audience: 'test-system' },
    }));
    assert.equal(envelope.decision.decision, 'DENY');
    assert.ok(envelope.decision.reasonCodes.includes('CREDENTIAL_BROKER_UNAVAILABLE'));
  });
});

describe('A-01 approval binding', () => {
  it('binds an approval to the EXACT action: any substitution is a mismatch', () => {
    const t = makeGate();
    t.registerTestManifest({ requiresApproval: true });
    const fields = {
      tenantId: 'acme',
      principalId: 'user:alice',
      agentId: 'agent-research',
      runId: 'run-1',
      capabilityId: 'cap.test',
      tool: 'test-tool',
      operation: 'do',
      targetSystem: 'test-system',
      targetResource: 'res-1',
      dataClassification: 'INTERNAL',
      impact: 'EXTERNAL_SIDE_EFFECT',
    };
    const request = (approval: unknown) => baseRequest({ approval });
    // Exact approval: ALLOW.
    assert.equal(t.gate.decide(request(makeApproval(fields))).decision.decision, 'ALLOW');
    // Approval rendered for a different target: DENY (replay against another action).
    assert.ok(t.gate.decide(request(makeApproval(fields, { digestOverride: a01ActionDigest({ ...fields, targetResource: 'res-2' }) }))).decision.reasonCodes.includes('APPROVAL_MISMATCH'));
    // Approval rendered for a different operation: DENY.
    assert.ok(t.gate.decide(request(makeApproval(fields, { digestOverride: a01ActionDigest({ ...fields, operation: 'other' }) }))).decision.reasonCodes.includes('APPROVAL_MISMATCH'));
    // Approval rendered for a different tenant: DENY.
    assert.ok(t.gate.decide(request(makeApproval(fields, { digestOverride: a01ActionDigest({ ...fields, tenantId: 'other' }) }))).decision.reasonCodes.includes('APPROVAL_MISMATCH'));
    // Approval rendered for a different principal: DENY.
    assert.ok(t.gate.decide(request(makeApproval(fields, { digestOverride: a01ActionDigest({ ...fields, principalId: 'user:bob' }) }))).decision.reasonCodes.includes('APPROVAL_MISMATCH'));
    // Approval rendered for a different impact: DENY.
    assert.ok(t.gate.decide(request(makeApproval(fields, { digestOverride: a01ActionDigest({ ...fields, impact: 'READ' }) }))).decision.reasonCodes.includes('APPROVAL_MISMATCH'));
    // Expired: DENY.
    assert.ok(t.gate.decide(request(makeApproval(fields, { expiresAt: T0 }))).decision.reasonCodes.includes('APPROVAL_EXPIRED'));
    // Missing when required: DENY.
    assert.ok(t.gate.decide(baseRequest()).decision.reasonCodes.includes('APPROVAL_MISSING'));
  });
});

describe('A-01 durable privacy-safe audit', () => {
  it('records every decision (ALLOW and DENY) with the full provenance fields', () => {
    const t = makeGate();
    t.registerTestManifest();
    const allowed = t.gate.decide(baseRequest());
    const denied = t.gate.decide(baseRequest({ capability: { capabilityId: 'cap.unknown', capabilityVersion: '1' } }));
    void allowed;
    void denied;
    assert.equal(t.audit.decisions().length, 2);
    const record = t.audit.decisions()[0];
    assert.ok(record, 'decision record present');
    assert.equal(record.principalId, 'user:alice');
    assert.equal(record.tenantId, 'acme');
    assert.equal(record.agentId, 'agent-research');
    assert.equal(record.runId, 'run-1');
    assert.equal(record.correlationId, 'corr-1');
    assert.equal(record.capabilityId, 'cap.test');
    assert.equal(record.tool, 'test-tool');
    assert.equal(record.operation, 'do');
    assert.equal(record.targetSystem, 'test-system');
    assert.equal(record.targetResource, 'res-1');
    assert.equal(record.impact, 'EXTERNAL_SIDE_EFFECT');
    assert.equal(record.policyVersion, 'test-policy');
    assert.equal(record.decidedAt, T0);
    assert.equal(record.envelopeId, allowed.envelopeId);
    assert.equal(t.audit.decisions()[1]?.decision, 'DENY');
  });

  it('records a CONSUMED event with side-effect outcome on execution', async () => {
    const t = makeGate();
    t.registerTestManifest();
    const envelope = t.gate.decide(baseRequest());
    const spy = spySideEffect('ok');
    const result = await t.gate.executeAuthorized(envelope, spy.fn, { tool: 'test-tool', operation: 'do' });
    assert.equal(result, 'ok');
    const consumed = t.audit.consumed();
    assert.equal(consumed.length, 1);
    assert.equal(consumed[0]?.sideEffectInvoked, true);
  });
});

describe('A-01 principal substrate (T-01/T-02 reuse)', () => {
  it('accepts T-01-shaped verified principals and rejects unrecognized methods', () => {
    const t = makeGate();
    t.registerTestManifest();
    const good: A01PrincipalBinding = {
      id: 'user:alice',
      tenantId: 'acme',
      roles: ['operator'],
      authenticationMethod: 'DETERMINISTIC_TEST',
      authenticationEventId: 'evt-42',
    };
    assert.equal(t.gate.decide(baseRequest({ principal: good })).decision.decision, 'ALLOW');
    const forged = { ...good, authenticationMethod: 'SOMETHING_ELSE' };
    assert.ok(t.gate.decide(baseRequest({ principal: forged })).decision.reasonCodes.includes('FORGED_PRINCIPAL'));
    const noEvent = { ...good, authenticationEventId: '' };
    assert.ok(t.gate.decide(baseRequest({ principal: noEvent })).decision.reasonCodes.includes('FORGED_PRINCIPAL'));
  });

  it('projects from a T-02 durable snapshot without widening', () => {
    const snapshot = {
      id: 'user:carol',
      tenantId: 'acme',
      roles: ['operator'],
      authenticationMethod: 'STATIC_TOKEN',
      authenticationEventId: 'evt-77',
      verifiedAt: T0,
    };
    const binding: A01PrincipalBinding = {
      id: snapshot.id,
      tenantId: snapshot.tenantId,
      roles: snapshot.roles,
      authenticationMethod: snapshot.authenticationMethod,
      authenticationEventId: snapshot.authenticationEventId,
    };
    const t = makeGate();
    t.registerTestManifest();
    assert.equal(t.gate.decide(baseRequest({ principal: binding })).decision.decision, 'ALLOW');
    // A snapshot cannot be widened: a different tenant is substitution.
    assert.ok(t.gate.decide(baseRequest({ principal: { ...binding, tenantId: 'other' } })).decision.reasonCodes.includes('TENANT_SUBSTITUTION'));
  });
});
