// A-01 adversarial suite (gate level). Each named case proves the boundary
// denies BEFORE any side effect. Cases here are decision/enforcement attacks;
// the invocation-boundary wiring cases (model-generated actions, direct
// adapter/connector bypass, queue replay through the runtime, worker bypass
// at the call site) live in the wired packages' a01-*.test.ts suites.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AuthorizationDeniedError,
  AuthorizationGate,
  CapabilityManifestRegistry,
  EnvelopeIntegrityError,
  InMemoryAuditSink,
  InMemoryCredentialBroker,
  runUnderEnvelope,
  WorkerTask,
  type A01AuthorizationRequest,
  type A01PolicyEngine,
} from '../src/index.js';
import { T0, assertAllowed, assertDenied, baseRequest, makeApproval, makeGate, manifest, principal, spySideEffect } from './helpers.js';

// ---------------------------------------------------------------------------
// 1-6. Identity & tenant integrity
// ---------------------------------------------------------------------------
describe('A-01 adversarial: principal & tenant integrity', () => {
  it('01 missing principal: DENY MISSING_PRINCIPAL, no side effect', async () => {
    const t = makeGate();
    t.registerTestManifest();
    const env = t.gate.decide(baseRequest({ principal: {} }));
    assertDenied(env, 'MISSING_PRINCIPAL');
    const spy = spySideEffect();
    await assert.rejects(() => t.gate.executeAuthorized(env, spy.fn, { tool: 'test-tool', operation: 'do' }));
    assert.equal(spy.state.calls, 0);
  });

  it('02 forged principal (unrecognized auth method / no auth event): DENY FORGED_PRINCIPAL', () => {
    const t = makeGate();
    t.registerTestManifest();
    const spoofedMethod = principal({ authenticationMethod: 'BYPASSED_AUTH' });
    assertDenied(t.gate.decide(baseRequest({ principal: spoofedMethod })), 'FORGED_PRINCIPAL');
    const noEvent = principal({ authenticationEventId: '' });
    assertDenied(t.gate.decide(baseRequest({ principal: noEvent })), 'FORGED_PRINCIPAL');
  });

  it('03 principal substitution after sealing: envelope tampered, execution DENY before side effect', async () => {
    const t = makeGate();
    t.registerTestManifest();
    const env = t.gate.decide(baseRequest());
    const forged: Record<string, unknown> = JSON.parse(JSON.stringify(env));
    (forged.principal as Record<string, unknown>).id = 'user:mallory';
    (forged.principal as Record<string, unknown>).tenantId = 'mallory';
    const spy = spySideEffect();
    await assert.rejects(
      () => t.gate.executeAuthorized(forged, spy.fn, { tool: 'test-tool', operation: 'do' }),
      (err: unknown) => err instanceof AuthorizationDeniedError || err instanceof EnvelopeIntegrityError,
    );
    assert.equal(spy.state.calls, 0, 'tampered principal must never reach the side effect');
  });

  it('04 missing tenant: absent tenant is DENY MISSING_TENANT', () => {
    const t = makeGate();
    t.registerTestManifest();
    const missing = { ...baseRequest() } as Record<string, unknown>;
    delete missing.tenantId;
    assertDenied(t.gate.decide(missing as never), 'MISSING_TENANT');
  });

  it('05 blank tenant: DENY BLANK_TENANT (and non-string: NON_STRING_TENANT)', () => {
    const t = makeGate();
    t.registerTestManifest();
    assertDenied(t.gate.decide(baseRequest({ tenantId: '   ' })), 'BLANK_TENANT');
    assertDenied(t.gate.decide(baseRequest({ tenantId: 42 })), 'NON_STRING_TENANT');
  });

  it('06 tenant substitution (request tenant != verified principal tenant): DENY TENANT_SUBSTITUTION', () => {
    const t = makeGate();
    t.registerTestManifest();
    assertDenied(t.gate.decide(baseRequest({ tenantId: 'other-tenant' })), 'TENANT_SUBSTITUTION');
  });
});

// ---------------------------------------------------------------------------
// 7-14. Capability, target, classification, impact
// ---------------------------------------------------------------------------
describe('A-01 adversarial: capability & scope escalation', () => {
  it('07 cross-tenant resource (tenant outside manifest scope): DENY TENANT_OUT_OF_SCOPE', () => {
    const t = makeGate();
    t.registerTestManifest(); // tenantScopes: ['acme']
    const other = principal({ id: 'user:carol', tenantId: 'globex' });
    assertDenied(t.gate.decide(baseRequest({ principal: other, tenantId: 'globex' })), 'TENANT_OUT_OF_SCOPE');
  });

  it('08 capability version mismatch: DENY CAPABILITY_VERSION_MISMATCH', () => {
    const t = makeGate();
    t.registerTestManifest();
    assertDenied(t.gate.decide(baseRequest({ capability: { capabilityId: 'cap.test', capabilityVersion: '9' } })), 'CAPABILITY_VERSION_MISMATCH');
    assertDenied(t.gate.decide(baseRequest({ capability: { capabilityId: 'cap.unknown', capabilityVersion: '1' } })), 'UNKNOWN_CAPABILITY');
  });

  it('09 operation not in manifest allow-list: DENY OPERATION_NOT_ALLOWED / UNKNOWN_TOOL', () => {
    const t = makeGate();
    t.registerTestManifest();
    assertDenied(t.gate.decide(baseRequest({ operation: 'dangerous-op' })), 'OPERATION_NOT_ALLOWED');
    assertDenied(t.gate.decide(baseRequest({ tool: 'other-tool', operation: 'do' })), 'UNKNOWN_TOOL');
  });

  it('10 wildcard abuse: manifest demands specific resources, caller omits the resource: DENY WILDCARD_ESCALATION', () => {
    const t = makeGate();
    t.registerTestManifest();
    assertDenied(
      t.gate.decide(baseRequest({ target: { system: 'test-system' } })),
      'WILDCARD_ESCALATION',
    );
    // A resource outside the pattern is plain target denial.
    assertDenied(t.gate.decide(baseRequest({ target: { system: 'test-system', resource: 'secret-vault' } })), 'TARGET_NOT_ALLOWED');
  });

  it('11 operation substitution at enforcement: envelope for A used where B was requested: DENY', async () => {
    const t = makeGate();
    t.registerTestManifest({ allowedOperations: [{ tool: 'test-tool', operation: 'do' }, { tool: 'test-tool', operation: 'other' }] });
    const env = t.gate.decide(baseRequest());
    const spy = spySideEffect();
    await assert.rejects(
      () => t.gate.executeAuthorized(env, spy.fn, { tool: 'test-tool', operation: 'other' }),
      (err: unknown) => err instanceof AuthorizationDeniedError,
    );
    assert.equal(spy.state.calls, 0);
  });

  it('12 target substitution at enforcement: envelope resource differs from the derived input target: DENY', async () => {
    const t = makeGate();
    t.registerTestManifest();
    const env = t.gate.decide(baseRequest()); // bound to res-1
    const spy = spySideEffect();
    await assert.rejects(
      () => t.gate.executeAuthorized(env, spy.fn, { tool: 'test-tool', operation: 'do', targetResource: 'res-2' }),
      (err: unknown) => err instanceof AuthorizationDeniedError,
    );
    assert.equal(spy.state.calls, 0);
  });

  it('13 data classification escalation: DENY CLASSIFICATION_EXCEEDED', () => {
    const t = makeGate();
    t.registerTestManifest(); // maxDataClassification: INTERNAL
    assertDenied(t.gate.decide(baseRequest({ dataClassification: 'RESTRICTED' })), 'CLASSIFICATION_EXCEEDED');
  });

  it('14 impact escalation: DENY IMPACT_EXCEEDED', () => {
    const t = makeGate();
    t.registerTestManifest({ maxImpact: 'REVERSIBLE_WRITE' });
    assertDenied(t.gate.decide(baseRequest({ impact: 'EXTERNAL_SIDE_EFFECT' })), 'IMPACT_EXCEEDED');
  });
});

// ---------------------------------------------------------------------------
// 15-16. Malicious / over-privileged capability manifests
// ---------------------------------------------------------------------------
describe('A-01 adversarial: malicious capability manifests', () => {
  it('15 malicious manifest: wildcard tools/operations, no targets, unknown ceilings rejected at registration', () => {
    const t = makeGate();
    const malicious = [
      { allowedOperations: [{ tool: '*', operation: 'do' }] },
      { allowedOperations: [{ tool: 'test-tool', operation: '*' }] },
      { allowedTargets: [] },
      { allowedOperations: [] },
      { tenantScopes: [], allowTenantWildcard: false },
      { maxDataClassification: 'UNCLASSIFIED_TOP_SECRET' },
      { maxImpact: 'WORLD_END' },
      { rateLimit: { windowMs: -1, max: 10 } },
      { budgetPerRunCostUnits: 0 },
      { maxLifetimeMs: 0 },
      { registeredBy: { principalId: '', tenantId: '' } },
    ];
    for (const m of malicious) {
      assert.throws(
        () => t.manifests.register(manifest({ capabilityId: `cap.malicious-${Math.random()}`, ...m })),
        /rejected/i,
        `manifest should be rejected: ${JSON.stringify(m)}`,
      );
    }
  });

  it('16 plugin permission escalation: a new manifest version widening any axis is rejected', () => {
    const t = makeGate();
    t.manifests.register(manifest({ capabilityId: 'cap.plugin', allowedOperations: [{ tool: 'p1', operation: 'read' }], maxImpact: 'READ', tenantScopes: ['acme'] }));
    const escalate = (overrides: Record<string, unknown>, match: RegExp) =>
      assert.throws(
        () => t.manifests.register(manifest({ capabilityId: 'cap.plugin', version: '2', allowedOperations: [{ tool: 'p1', operation: 'read' }], maxImpact: 'READ', tenantScopes: ['acme'], ...overrides })),
        (err: unknown) => /rejected/.test(String(err)) && match.test(String(err)),
      );
    escalate({ allowedOperations: [{ tool: 'p1', operation: 'read' }, { tool: 'p2', operation: 'write' }] }, /operation|tool|widens/);
    escalate({ tenantScopes: ['acme', 'globex'] }, /tenant/);
    escalate({ maxImpact: 'EXTERNAL_SIDE_EFFECT' }, /impact/);
  });
});

// ---------------------------------------------------------------------------
// 20-22. Approval binding
// ---------------------------------------------------------------------------
describe('A-01 adversarial: approval misuse', () => {
  const approvalFields = {
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

  it('20 approval replay: an approval rendered for another action cannot be reused', () => {
    const t = makeGate();
    t.registerTestManifest({ requiresApproval: true });
    // The approval is for a DIFFERENT target than the one being requested.
    const replayed = makeApproval(approvalFields, { digestOverride: makeApproval({ ...approvalFields, targetResource: 'res-OTHER' }).approvedActionDigest });
    assertDenied(t.gate.decide(baseRequest({ approval: replayed })), 'APPROVAL_MISMATCH');
  });

  it('21 expired approval: DENY APPROVAL_EXPIRED', () => {
    const t = makeGate();
    t.registerTestManifest({ requiresApproval: true });
    const expired = makeApproval(approvalFields, { expiresAt: T0 });
    assertDenied(t.gate.decide(baseRequest({ approval: expired })), 'APPROVAL_EXPIRED');
  });

  it('22 approval/action mismatch (tenant, principal, impact, capability each): DENY APPROVAL_MISMATCH', () => {
    const t = makeGate();
    t.registerTestManifest({ requiresApproval: true });
    const forFields = (f: typeof approvalFields) => makeApproval(approvalFields, { digestOverride: makeApproval(f).approvedActionDigest });
    assertDenied(t.gate.decide(baseRequest({ approval: forFields({ ...approvalFields, tenantId: 'globex' }) })), 'APPROVAL_MISMATCH');
    assertDenied(t.gate.decide(baseRequest({ approval: forFields({ ...approvalFields, principalId: 'user:bob' }) })), 'APPROVAL_MISMATCH');
    assertDenied(t.gate.decide(baseRequest({ approval: forFields({ ...approvalFields, impact: 'READ' }) })), 'APPROVAL_MISMATCH');
    assertDenied(t.gate.decide(baseRequest({ approval: forFields({ ...approvalFields, capabilityId: 'cap.other' }) })), 'APPROVAL_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// 23-26. Credential misuse
// ---------------------------------------------------------------------------
describe('A-01 adversarial: credential misuse', () => {
  function credentialGate() {
    let clock = T0;
    const broker = new InMemoryCredentialBroker({ now: () => clock });
    broker.issue({
      credentialId: 'cred-a',
      principalId: 'user:alice',
      tenantId: 'acme',
      capabilityId: 'cap.test',
      tool: 'test-tool',
      operation: 'do',
      audience: 'test-system',
      scopes: ['read:res'],
      lifetimeMs: 60_000,
      issuedBy: 'a01-test',
      secretMaterial: 'material-23-26',
    });
    const t = makeGate({ broker, now: () => clock });
    t.registerTestManifest({ requiredCredentialScopes: ['read:res'], credentialAudience: 'test-system' });
    const withCredential = (overrides: Record<string, unknown> = {}) =>
      t.gate.decide(
        baseRequest({
          credential: { credentialId: 'cred-a', audience: 'test-system', scopes: ['read:res'] },
          target: { system: 'test-system', resource: 'res-1', audience: 'test-system' },
          ...overrides,
        }),
      );
    return { t, broker, withCredential, advance: (ms: number) => { clock += ms; } };
  }

  it('23 credential audience mismatch: DENY CREDENTIAL_AUDIENCE_MISMATCH', () => {
    const { withCredential } = credentialGate();
    assertDenied(
      withCredential({ credential: { credentialId: 'cred-a', audience: 'evil-system', scopes: ['read:res'] }, target: { system: 'test-system', resource: 'res-1', audience: 'evil-system' } }),
      'CREDENTIAL_AUDIENCE_MISMATCH',
    );
  });

  it('24 expired credential: DENY CREDENTIAL_EXPIRED', () => {
    const { withCredential, advance } = credentialGate();
    advance(120_000); // lifetime was 60s
    assertDenied(withCredential(), 'CREDENTIAL_EXPIRED');
  });

  it('25 over-scoped / under-scoped credential: insufficient scope is DENY', () => {
    const { broker, t } = credentialGate();
    void t;
    // A credential lacking the required scope cannot satisfy the manifest.
    broker.issue({
      credentialId: 'cred-narrow',
      principalId: 'user:alice',
      tenantId: 'acme',
      capabilityId: 'cap.test',
      tool: 'test-tool',
      operation: 'do',
      audience: 'test-system',
      scopes: ['read:only-narrow'],
      lifetimeMs: 60_000,
      issuedBy: 'a01-test',
    });
    const env = t.gate.decide(
      baseRequest({
        credential: { credentialId: 'cred-narrow', audience: 'test-system', scopes: ['read:res'] },
        target: { system: 'test-system', resource: 'res-1', audience: 'test-system' },
      }),
    );
    assertDenied(env, 'CREDENTIAL_SCOPE_INSUFFICIENT');
  });

  it('26 credential replay: second acquire for the same envelope is DENY (envelope single-use)', async () => {
    const { t } = credentialGate();
    const env = t.gate.decide(
      baseRequest({
        credential: { credentialId: 'cred-a', audience: 'test-system', scopes: ['read:res'] },
        target: { system: 'test-system', resource: 'res-1', audience: 'test-system' },
      }),
    );
    assertAllowed(env);
    const spy = spySideEffect();
    await t.gate.executeAuthorized(env, spy.fn, { tool: 'test-tool', operation: 'do' });
    assert.equal(spy.state.calls, 1);
    await assert.rejects(
      () => t.gate.executeAuthorized(env, spy.fn, { tool: 'test-tool', operation: 'do' }),
      AuthorizationDeniedError,
    );
    assert.equal(spy.state.calls, 1, 'a replayed credential envelope must not re-execute');
  });
});

// ---------------------------------------------------------------------------
// 29. Worker boundary (workers today have NO external I/O; this is the
// wrapper they MUST use before any future externally consequential task)
// ---------------------------------------------------------------------------
describe('A-01 adversarial: worker boundary', () => {
  // Workers today perform no external I/O; this wrapper is the boundary they
  // MUST use before any future externally consequential task is introduced.
  function makeRepairTask() {
    let ran = 0;
    const body = async (): Promise<string> => {
      ran += 1;
      return 'repaired';
    };
    const task = new WorkerTask(
      { id: 'repair-task-1', tool: 'repair-worker', operation: 'check', targetResource: 'task-1' },
      body,
    );
    return { task, body, ran: (): number => ran };
  }

  async function checkEnvelope(t: ReturnType<typeof makeGate>) {
    t.registerTestManifest({
      allowedOperations: [{ tool: 'repair-worker', operation: 'check' }],
      allowedTargets: [{ system: 'repo', resourcePattern: 'task-*' }],
    });
    return t.gate.decide(
      baseRequest({
        tool: 'repair-worker',
        operation: 'check',
        target: { system: 'repo', resource: 'task-1' },
        impact: 'EXTERNAL_SIDE_EFFECT',
      }),
    );
  }

  it('29 worker bypass: a fabricated (never-sealed) envelope grants nothing', async () => {
    const t = makeGate();
    const { body, ran } = makeRepairTask();
    // A worker that invents its own envelope has no valid digest: the gate
    // rejects it before the task body runs.
    const forgedEnvelope = {
      schemaVersion: 1,
      envelopeId: 'forged',
      sealedAt: T0,
      decision: { decision: 'ALLOW', reasonCodes: [] },
      integrity: { algorithm: 'sha256', digest: '0'.repeat(64) },
    };
    await assert.rejects(
      () => runUnderEnvelope(t.gate, forgedEnvelope as never, body, { tool: 'repair-worker', operation: 'check' }),
      (err: unknown) => err instanceof AuthorizationDeniedError || err instanceof EnvelopeIntegrityError,
    );
    assert.equal(ran(), 0, 'a worker with no valid envelope must not run its task body');
  });

  it('29b worker envelope mismatch: wrong operation is rejected before the task body', async () => {
    const t = makeGate();
    const env = await checkEnvelope(t);
    assertAllowed(env);
    const { body, ran } = makeRepairTask();
    await assert.rejects(
      () => runUnderEnvelope(t.gate, env, body, { tool: 'repair-worker', operation: 'deploy' }),
      AuthorizationDeniedError,
    );
    assert.equal(ran(), 0);
  });

  it('29c worker happy path: a correctly bound envelope lets the deterministic task run exactly once', async () => {
    const t = makeGate();
    const env = await checkEnvelope(t);
    const { task, ran } = makeRepairTask();
    const result = await task.run(t.gate, env);
    assert.equal(result, 'repaired');
    assert.equal(ran(), 1);
    // And the envelope is consumed: the worker cannot run the same task twice.
    await assert.rejects(
      () => task.run(t.gate, env),
      (err: unknown) => err instanceof AuthorizationDeniedError && err.reasons.includes('REPLAYED_AUTHORIZATION'),
    );
    assert.equal(ran(), 1);
  });
});

// ---------------------------------------------------------------------------
// 30-32. Replay, idempotency, concurrency
// ---------------------------------------------------------------------------
describe('A-01 adversarial: replay & concurrency', () => {
  it('30 queue replay: the same sealed envelope delivered twice executes the side effect ONCE', async () => {
    const t = makeGate();
    t.registerTestManifest();
    const env = t.gate.decide(baseRequest());
    const spy = spySideEffect('done');
    const first = await t.gate.executeAuthorized(env, spy.fn, { tool: 'test-tool', operation: 'do' });
    let captured: unknown;
    await assert.rejects(
      () => t.gate.executeAuthorized(env, spy.fn, { tool: 'test-tool', operation: 'do' }),
      (err: unknown) => {
        captured = err;
        return err instanceof AuthorizationDeniedError;
      },
    );
    assert.equal(first, 'done');
    assert.ok((captured as AuthorizationDeniedError).reasons.includes('REPLAYED_AUTHORIZATION'));
    assert.equal(spy.state.calls, 1, 'queue redelivery must not re-run the side effect');
  });

  it('31 retry replay: an idempotency key returns the cached result without re-execution', async () => {
    const t = makeGate();
    t.registerTestManifest();
    let n = 0;
    const effect = async (): Promise<string> => {
      n += 1;
      return `attempt-${n}`;
    };
    const request: A01AuthorizationRequest = { ...baseRequest(), idempotencyKey: 'idem-1' };
    const env1 = t.gate.decide(request);
    const env2 = t.gate.decide(request); // same idempotency key, fresh envelope (retry)
    const r1 = await t.gate.executeAuthorized(env1, effect, { tool: 'test-tool', operation: 'do' });
    const r2 = await t.gate.executeAuthorized(env2, effect, { tool: 'test-tool', operation: 'do' });
    assert.equal(r1, 'attempt-1');
    assert.equal(r2, 'attempt-1', 'the retry must observe the cached result, not re-execute');
    assert.equal(n, 1);
  });

  it('32 concurrent invocation: N parallel executes of one envelope run the side effect EXACTLY once', async () => {
    const t = makeGate();
    t.registerTestManifest();
    const env = t.gate.decide(baseRequest());
    let n = 0;
    const effect = async (): Promise<string> => {
      n += 1;
      await new Promise((r) => setTimeout(r, 5));
      return 'ok';
    };
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, () => t.gate.executeAuthorized(env, effect, { tool: 'test-tool', operation: 'do' })),
    );
    const wins = settled.filter((s) => s.status === 'fulfilled');
    const losses = settled.filter((s) => s.status === 'rejected');
    assert.equal(wins.length, 1, 'exactly one concurrent caller wins');
    assert.equal(losses.length, 9);
    assert.equal(n, 1, 'exactly one side-effect execution under concurrency');
  });
});

// ---------------------------------------------------------------------------
// 33-36. Resource limits & component failures
// ---------------------------------------------------------------------------
describe('A-01 adversarial: limits & component failure', () => {
  it('33 budget exhaustion: per-run budget caps the invocation, DENY BUDGET_EXHAUSTED before side effect', async () => {
    const t = makeGate();
    t.registerTestManifest({ budgetPerRunCostUnits: 2 });
    const spy = spySideEffect();
    for (let i = 0; i < 2; i += 1) {
      const env = t.gate.decide(baseRequest());
      assertAllowed(env);
      await t.gate.executeAuthorized(env, spy.fn, { tool: 'test-tool', operation: 'do' });
    }
    const third = t.gate.decide(baseRequest());
    // The per-run cumulative ceiling is enforced at the enforcement point:
    // the third execution is refused before its side effect runs.
    await assert.rejects(() => t.gate.executeAuthorized(third, spy.fn, { tool: 'test-tool', operation: 'do' }));
    assert.equal(spy.state.calls, 2, 'the third call must be refused before its side effect');
  });

  it('34 rate limit exhaustion: DENY RATE_LIMIT_EXCEEDED before side effect', () => {
    const t = makeGate();
    t.registerTestManifest({ rateLimit: { windowMs: 60_000, max: 2 } });
    assertAllowed(t.gate.decide(baseRequest()));
    assertAllowed(t.gate.decide(baseRequest()));
    assertDenied(t.gate.decide(baseRequest()), 'RATE_LIMIT_EXCEEDED');
  });

  it('35 policy engine failure: an engine that throws yields DENY POLICY_ENGINE_UNAVAILABLE (fail-closed)', async () => {
    const brokenEngine: A01PolicyEngine = {
      id: 'broken',
      evaluate: () => {
        throw new Error('engine exploded');
      },
    };
    const registry = new CapabilityManifestRegistry();
    registry.register(manifest());
    const failGate = new AuthorizationGate({
      now: () => T0,
      manifests: registry,
      audit: new InMemoryAuditSink(),
      engine: brokenEngine,
      policyVersion: 'test',
    });
    const env = failGate.decide(baseRequest());
    assertDenied(env, 'POLICY_ENGINE_UNAVAILABLE');
    const spy = spySideEffect();
    await assert.rejects(() => failGate.executeAuthorized(env, spy.fn, { tool: 'test-tool', operation: 'do' }));
    assert.equal(spy.state.calls, 0);
  });

  it('36 credential broker failure: an unavailable broker is DENY, never "no credential required"', async () => {
    const broker = new InMemoryCredentialBroker({ now: () => T0 });
    broker.setAvailable(false);
    const t = makeGate({ broker });
    t.registerTestManifest({ requiredCredentialScopes: ['read:res'], credentialAudience: 'test-system' });
    const env = t.gate.decide(
      baseRequest({
        credential: { credentialId: 'cred-x', audience: 'test-system', scopes: ['read:res'] },
        target: { system: 'test-system', resource: 'res-1', audience: 'test-system' },
      }),
    );
    assertDenied(env, 'CREDENTIAL_BROKER_UNAVAILABLE');
    const spy = spySideEffect();
    await assert.rejects(() => t.gate.executeAuthorized(env, spy.fn, { tool: 'test-tool', operation: 'do' }));
    assert.equal(spy.state.calls, 0);
  });
});

// ---------------------------------------------------------------------------
// 37-38, 42. Malformed envelopes, conflicting metadata, unknown capability
// ---------------------------------------------------------------------------
describe('A-01 adversarial: malformed & unknown', () => {
  it('37 malformed envelope: structurally broken requests are DENY ENVELOPE_MALFORMED; broken sealed envelopes are rejected at assertion', async () => {
    const t = makeGate();
    t.registerTestManifest();
    assertDenied(t.gate.decide(null), 'ENVELOPE_MALFORMED');
    assertDenied(t.gate.decide('garbage' as never), 'ENVELOPE_MALFORMED');
    assertDenied(t.gate.decide({ principal: 42, tenantId: 'acme' } as never), 'ENVELOPE_MALFORMED');
    const env = t.gate.decide(baseRequest());
    const broken: Record<string, unknown> = JSON.parse(JSON.stringify(env));
    delete broken.decision;
    await assert.rejects(() => t.gate.executeAuthorized(broken, spySideEffect().fn, { tool: 'test-tool', operation: 'do' }));
  });

  it('38 conflicting authorization metadata: request tenant conflicts with verified principal: DENY TENANT_SUBSTITUTION', () => {
    const t = makeGate();
    t.registerTestManifest();
    // The request claims a different tenant than the verified principal carries.
    assertDenied(t.gate.decide(baseRequest({ tenantId: 'attacker-tenant' })), 'TENANT_SUBSTITUTION');
    // A capability that requires approval without one presented: DENY.
    t.registerTestManifest({ capabilityId: 'cap.approved', requiresApproval: true });
    const env = t.gate.decide(baseRequest({
      capability: { capabilityId: 'cap.approved', capabilityVersion: '1' },
      approval: undefined,
    }));
    assertDenied(env, 'APPROVAL_MISSING');
  });

  it('42 unauthorized external side effect: no manifest = every external call is DENY before I/O', async () => {
    const t = makeGate(); // no manifests registered
    const env = t.gate.decide(baseRequest());
    assertDenied(env, 'UNKNOWN_CAPABILITY');
    const spy = spySideEffect();
    await assert.rejects(() => t.gate.executeAuthorized(env, spy.fn, { tool: 'test-tool', operation: 'do' }));
    assert.equal(spy.state.calls, 0, 'with no capability grant, nothing external may happen');
  });
});

// ---------------------------------------------------------------------------
// Positive controls: the boundary must not block what it has granted
// ---------------------------------------------------------------------------
describe('A-01 positive controls', () => {
  it('granted invocation: decision ALLOW, side effect runs exactly once, audit has DECISION+CONSUMED, no material in audit', async () => {
    const broker = new InMemoryCredentialBroker({ now: () => T0 });
    broker.issue({
      credentialId: 'cred-p',
      principalId: 'user:alice',
      tenantId: 'acme',
      capabilityId: 'cap.test',
      tool: 'test-tool',
      operation: 'do',
      audience: 'test-system',
      scopes: ['read:res'],
      lifetimeMs: 60_000,
      issuedBy: 'a01-test',
      secretMaterial: 'positive-control-material',
    });
    const t = makeGate({ broker });
    t.registerTestManifest({ requiredCredentialScopes: ['read:res'], credentialAudience: 'test-system' });
    const env = t.gate.decide(
      baseRequest({
        credential: { credentialId: 'cred-p', audience: 'test-system', scopes: ['read:res'] },
        target: { system: 'test-system', resource: 'res-1', audience: 'test-system' },
      }),
    );
    assertAllowed(env);
    const spy = spySideEffect('granted-result');
    const result = await t.gate.executeAuthorized(env, spy.fn, { tool: 'test-tool', operation: 'do' });
    assert.equal(result, 'granted-result');
    assert.equal(spy.state.calls, 1);
    assert.equal(spy.state.sawCredential?.credential?.material, 'positive-control-material');
    assert.equal(t.audit.decisions().length, 1);
    assert.equal(t.audit.consumed().length, 1);
    for (const record of t.audit.records) {
      assert.equal(JSON.stringify(record).includes('positive-control-material'), false);
    }
  });

  it('READ impact envelopes are idempotent: repeated execution is allowed without replay denial', async () => {
    const t = makeGate();
    t.registerTestManifest({ maxImpact: 'READ' });
    const env = t.gate.decide(baseRequest({ impact: 'READ' }));
    assertAllowed(env);
    let n = 0;
    const effect = async (): Promise<string> => {
      n += 1;
      return 'read';
    };
    await t.gate.executeAuthorized(env, effect, { tool: 'test-tool', operation: 'do' });
    await t.gate.executeAuthorized(env, effect, { tool: 'test-tool', operation: 'do' });
    assert.equal(n, 2, 'idempotent reads may be repeated');
  });

  it('an expired envelope (lifetime passed) is DENY AUTHORIZATION_EXPIRED at enforcement', async () => {
    const t = makeGate();
    t.registerTestManifest({ maxLifetimeMs: 1_000 });
    const env = t.gate.decide(baseRequest());
    assertAllowed(env);
    t.advance(2_000);
    const spy = spySideEffect();
    await assert.rejects(
      () => t.gate.executeAuthorized(env, spy.fn, { tool: 'test-tool', operation: 'do' }),
      (err: unknown) => err instanceof AuthorizationDeniedError && err.reasons.includes('AUTHORIZATION_EXPIRED'),
    );
    assert.equal(spy.state.calls, 0);
  });
});
