// T-03 authenticated work ingress (in-memory, deterministic).
//
// Proves that the T-01 principal boundary and the T-02 durable authority
// carry-through are reachable through ONE production-shaped path:
//
//   credential -> PrincipalBoundary -> AuthenticatedPrincipal
//     -> projectToActor (narrowing only) -> LoopHostService.enqueue
//     -> persisted T-02 snapshot -> dispatch -> unified 34-stage loop
//
// and that every rejection along that path fails closed with NO work created
// and NO receipt returned. The test authenticator is the principal source
// here; production admission of DETERMINISTIC_TEST is refused by policy and is
// covered by the CLI composition tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthenticationPolicyError,
  DeterministicTestAuthenticator,
  PrincipalBoundary,
  PrincipalValidationError,
  UnauthenticatedRequestError,
  testCredential as testCred,
  type AuthenticatedPrincipal,
  type TestPrincipalRecord,
} from '@jataqi/authentication';
import { StorageModule } from '@jataqi/storage';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import {
  DEFAULT_MAX_PRINCIPAL_AGE_MS,
  WORK_COLLECTION,
  WorkIngressModule,
  WorkIngressService,
  type AuthenticatedPrincipalSnapshot,
  type HostedWorkItem,
  type LoopRunner,
} from '../src/index.js';
import type { LoopRunResult } from '@jataqi/unified-loop';
import {
  DEFAULT_INGRESS_RECORD,
  buildHarness,
  ingressCredential,
  reasoningTask,
  type Harness,
} from './helpers.js';

const INGRESS_RECORD: TestPrincipalRecord = {
  id: 'ingress-caller',
  tenantId: 'acme',
  roles: ['agent', 'operator'],
};

/** A boundary that mints real DETERMINISTIC_TEST principals on the harness clock. */
function testBoundary(h: Harness): PrincipalBoundary {
  return new PrincipalBoundary({
    policy: { mode: 'test-only', allowTestMethod: true },
    authenticators: [new DeterministicTestAuthenticator([INGRESS_RECORD])],
    now: h.now,
  });
}

/** An ingress wired to the real host service on the harness clock. */
function testIngress(h: Harness, boundary = testBoundary(h)): WorkIngressService {
  return new WorkIngressService({ boundary, host: h.host(), now: h.now });
}

function credential(material?: string) {
  return testCred(INGRESS_RECORD).material === material
    ? testCred(INGRESS_RECORD)
    : { method: 'DETERMINISTIC_TEST' as const, material: material ?? testCred(INGRESS_RECORD).material };
}

function loopResult(outcome: LoopRunResult['outcome']): LoopRunResult {
  return {
    loopId: 'loop-t03',
    correlationId: 'corr-t03',
    tenantId: 'acme',
    outcome,
    trace: [],
    stageOutputs: {},
    records: [],
    finalStage: 'OUTCOME',
    startedAt: 1,
    endedAt: 2,
    continuation: 'TERMINATE',
  } as unknown as LoopRunResult;
}

/** Read the raw persisted row straight from storage (bypasses the service). */
async function readRaw(h: Harness, id: string): Promise<HostedWorkItem | undefined> {
  const storage = h.kernel.getModule<StorageModule>('storage');
  const items = await storage.collection<HostedWorkItem>(WORK_COLLECTION);
  return items.get(id);
}

async function tamperItem(h: Harness, id: string, mutate: (raw: HostedWorkItem) => HostedWorkItem): Promise<void> {
  const storage = h.kernel.getModule<StorageModule>('storage');
  const items = await storage.collection<HostedWorkItem>(WORK_COLLECTION);
  const raw = await items.get(id);
  assert.ok(raw, 'expected the work item to exist before tampering');
  await items.put(mutate({ ...raw }));
}

/** Minimal call recorder (no external spy library). */
function record(target: object, key: string) {
  const holder = target as Record<string, unknown>;
  const original = holder[key] as (...args: unknown[]) => unknown;
  const calls: unknown[][] = [];
  holder[key] = async (...args: unknown[]): Promise<unknown> => {
    calls.push(args);
    return original.apply(target, args);
  };
  return {
    count: (): number => calls.length,
    calls,
    restore: (): void => {
      holder[key] = original;
    },
  };
}

describe('T-03 ingress — tenant and authority continuity', () => {
  it('T03-09: the AUTHENTICATED tenant becomes the work-item tenant', async () => {
    const h = await buildHarness();
    const receipt = await testIngress(h).submit(credential(), { objective: 'Reason about churn signals.' });
    assert.equal(receipt.tenantId, INGRESS_RECORD.tenantId);
    const raw = await readRaw(h, receipt.workId);
    assert.equal(raw?.tenantId, INGRESS_RECORD.tenantId);
    assert.equal(raw?.principal?.tenantId, INGRESS_RECORD.tenantId);
  });

  it('T03-10: a caller-declared tenant that conflicts with the authenticated tenant is rejected', async () => {
    const h = await buildHarness();
    const ingress = testIngress(h);
    await assert.rejects(
      () => ingress.submit(credential(), { objective: 'Work.', tenantId: 'other' }),
      (error: unknown) => error instanceof PrincipalValidationError && /authoritative/.test(error.message),
    );
    // Nothing was created.
    const items = await h.host().list(h.actor, { limit: 100 });
    assert.equal(items.length, 0);
  });

  it('T03-10b: a matching caller-declared tenant is accepted as a consistency check', async () => {
    const h = await buildHarness();
    const receipt = await testIngress(h).submit(credential(), {
      objective: 'Work.',
      tenantId: INGRESS_RECORD.tenantId,
    });
    assert.equal(receipt.tenantId, INGRESS_RECORD.tenantId);
  });

  it('T03-11: cross-tenant work creation is impossible — another tenant needs its own credential', async () => {
    const h = await buildHarness();
    // The boundary only knows the acme principal; there is no way to ask it
    // for an 'other'-tenant principal, and passing tenantId:'other' is refused.
    const ingress = testIngress(h);
    await assert.rejects(
      () => ingress.submit(credential(), { objective: 'Cross-tenant attempt.', tenantId: 'other' }),
      PrincipalValidationError,
    );
    const otherItems = await h.host().list(h.other, { limit: 100 });
    assert.equal(otherItems.length, 0, 'no work may exist in a tenant the caller did not authenticate as');
  });

  it('T03-18: role narrowing is honoured and widening is refused', async () => {
    const h = await buildHarness();
    const ingress = testIngress(h);
    const narrowed = await ingress.submit(credential(), {
      objective: 'Narrowed submission.',
      requestedRoles: ['agent'],
    });
    const raw = await readRaw(h, narrowed.workId);
    assert.deepEqual(raw?.actor.roles, ['agent'], 'the persisted actor carries only the narrowed roles');
    assert.deepEqual([...(raw?.principal?.roles ?? [])], ['agent', 'operator'], 'the verified set is unchanged');

    await assert.rejects(
      () => ingress.submit(credential(), { objective: 'Widening attempt.', requestedRoles: ['admin'] }),
      /widening is not permitted/,
    );
  });
});

describe('T-03 ingress — queue integration (no bypass, no duplication)', () => {
  it('T03-12: the ingress calls the existing authenticated enqueue path', async () => {
    const h = await buildHarness();
    const host = h.host();
    const spy = record(host, 'enqueue');
    try {
      const receipt = await testIngress(h, testBoundary(h)).submit(credential(), { objective: 'Spy check.' });
      assert.equal(spy.count(), 1, 'exactly one enqueue, through the host service');
      const [actor, input, principal] = spy.calls[0] as [CommercialActor, { task: { objective: string } }, AuthenticatedPrincipal];
      assert.equal(actor.tenantId, INGRESS_RECORD.tenantId);
      assert.equal(actor.id, INGRESS_RECORD.id);
      assert.equal(input.task.objective, 'Spy check.');
      assert.equal(principal.authenticationEventId, receipt.authentication.authenticationEventId);
    } finally {
      spy.restore();
    }
  });

  it('T03-13: the ingress surface exposes no storage, lease, dispatch, or settlement path', () => {
    const methods = Object.getOwnPropertyNames(WorkIngressService.prototype).filter((name) => name !== 'constructor');
    assert.deepEqual(methods.sort(), ['getPolicy', 'submit'].sort());
    // It cannot write work items directly: it has no collection and no queue.
    for (const forbidden of ['put', 'cas', 'query', 'acquireLease', 'settle', 'tick', 'dispatch', 'recover', 'resume']) {
      assert.ok(!methods.includes(forbidden), `ingress must not expose "${forbidden}"`);
    }
    // Its composition dependencies are exactly the boundary and the host.
    const mod = new WorkIngressModule();
    assert.deepEqual([...(mod.dependsOn ?? [])], ['authentication', 'loop-host']);
  });

  it('T03-14: the T-02 principal snapshot is actually persisted by enqueue', async () => {
    const h = await buildHarness();
    const receipt = await testIngress(h).submit(credential(), { objective: 'Persist the snapshot.' });
    const raw = await readRaw(h, receipt.workId);
    const snapshot = raw?.principal as AuthenticatedPrincipalSnapshot | undefined;
    assert.ok(snapshot, 'a snapshot must exist on the persisted row');
    assert.equal(snapshot?.version, 1);
    assert.equal(snapshot?.principalId, INGRESS_RECORD.id);
    assert.equal(snapshot?.tenantId, INGRESS_RECORD.tenantId);
    assert.deepEqual(snapshot?.roles, ['agent', 'operator']);
    assert.equal(snapshot?.authenticationMethod, 'DETERMINISTIC_TEST');
    assert.equal(snapshot?.verifiedAt, h.now());
  });

  it('T03-15: the authentication event id survives enqueue end to end', async () => {
    const h = await buildHarness();
    const receipt = await testIngress(h).submit(credential(), { objective: 'Provenance survives.' });
    assert.ok(receipt.authentication.authenticationEventId.length > 0);
    const raw = await readRaw(h, receipt.workId);
    assert.equal(raw?.principal?.authenticationEventId, receipt.authentication.authenticationEventId);
  });

  it('T03-15b: no credential material is persisted anywhere on the work item', async () => {
    const h = await buildHarness();
    const receipt = await testIngress(h).submit(credential(), { objective: 'Confirm nothing sensitive is stored.' });
    const raw = await readRaw(h, receipt.workId);
    const serialized = JSON.stringify(raw);
    assert.ok(!serialized.includes(testCred(INGRESS_RECORD).material), 'the credential material must never be stored');
    for (const forbidden of ['token', 'password', 'secret', 'material', 'credential']) {
      assert.ok(
        !serialized.toLowerCase().includes(forbidden),
        `persisted work item must not contain a "${forbidden}" field`,
      );
    }
  });
});

describe('T-03 ingress — authority continuity through T-02 dispatch', () => {
  it('T03-16: ingress-created work passes T-02 dispatch authorization and runs', async () => {
    const h = await buildHarness();
    const svc = h.host();
    let calls = 0;
    let dispatchedActor: CommercialActor | undefined;
    svc.setRunner((async (actor: CommercialActor) => {
      calls += 1;
      dispatchedActor = actor;
      return loopResult('COMPLETED_DRY_RUN');
    }) as unknown as LoopRunner);
    svc.start();
    const receipt = await testIngress(h).submit(credential(), { objective: 'Dispatch me.' });
    await svc.tick();
    assert.equal(calls, 1, 'the item dispatched exactly once');
    assert.equal(dispatchedActor?.id, INGRESS_RECORD.id);
    assert.equal(dispatchedActor?.tenantId, INGRESS_RECORD.tenantId);
    const settled = await svc.get(h.actor, receipt.workId);
    assert.equal(settled?.status, 'COMPLETED');
    assert.equal(settled?.heldReason, undefined, 'no authority hold on a properly authenticated item');
  });

  it('T03-17: T-01 actor/principal matching remains enforced after ingress', async () => {
    const h = await buildHarness();
    const svc = h.host();
    let calls = 0;
    svc.setRunner((async () => {
      calls += 1;
      return loopResult('COMPLETED_DRY_RUN');
    }) as unknown as LoopRunner);
    svc.start();
    const receipt = await testIngress(h).submit(credential(), { objective: 'Tamper with my actor.' });
    await tamperItem(h, receipt.workId, (raw) => ({
      ...raw,
      actor: { ...raw.actor, id: 'someone-else' },
    }));
    await svc.tick();
    assert.equal(calls, 0, 'a tampered actor must never execute');
    const held = await svc.get(h.actor, receipt.workId);
    assert.equal(held?.status, 'HELD');
    assert.equal(held?.heldReason, 'PRINCIPAL_MISMATCH');
  });

  it('T03-18b: a persisted role escalation still holds at dispatch', async () => {
    const h = await buildHarness();
    const svc = h.host();
    let calls = 0;
    svc.setRunner((async () => {
      calls += 1;
      return loopResult('COMPLETED_DRY_RUN');
    }) as unknown as LoopRunner);
    svc.start();
    const receipt = await testIngress(h).submit(credential(), {
      objective: 'Escalate me.',
      requestedRoles: ['agent'],
    });
    await tamperItem(h, receipt.workId, (raw) => ({
      ...raw,
      actor: { ...raw.actor, roles: ['agent', 'admin'] },
    }));
    await svc.tick();
    assert.equal(calls, 0);
    const held = await svc.get(h.actor, receipt.workId);
    assert.equal(held?.heldReason, 'PRINCIPAL_ROLE_ESCALATION');
  });

  it('T03-19: staleness remains T-02 behaviour — aged authority holds, it does not execute', async () => {
    const h = await buildHarness();
    const svc = h.host();
    let calls = 0;
    svc.setRunner((async () => {
      calls += 1;
      return loopResult('COMPLETED_DRY_RUN');
    }) as unknown as LoopRunner);
    svc.start();
    const receipt = await testIngress(h).submit(credential(), { objective: 'Age me out.' });
    h.advance(DEFAULT_MAX_PRINCIPAL_AGE_MS + 1);
    await svc.tick();
    assert.equal(calls, 0, 'stale authority must never execute');
    const held = await svc.get(h.actor, receipt.workId);
    assert.equal(held?.status, 'HELD');
    assert.equal(held?.heldReason, 'PRINCIPAL_STALE');
  });

  it('T03-20: a legacy unsigned row still holds with PRINCIPAL_ABSENT', async () => {
    const h = await buildHarness();
    const svc = h.host();
    let calls = 0;
    svc.setRunner((async () => {
      calls += 1;
      return loopResult('COMPLETED_DRY_RUN');
    }) as unknown as LoopRunner);
    svc.start();
    const receipt = await testIngress(h).submit(credential(), { objective: 'Strip my snapshot.' });
    await tamperItem(h, receipt.workId, (raw) => {
      const { principal: _dropped, ...legacy } = raw;
      void _dropped;
      return legacy as HostedWorkItem;
    });
    await svc.tick();
    assert.equal(calls, 0);
    const held = await svc.get(h.actor, receipt.workId);
    assert.equal(held?.heldReason, 'PRINCIPAL_ABSENT');
  });
});

describe('T-03 ingress — fail-closed behaviour', () => {
  it('T03-21: an authentication failure creates no work and returns no receipt', async () => {
    const h = await buildHarness();
    const ingress = testIngress(h);
    await assert.rejects(
      () => ingress.submit({ method: 'DETERMINISTIC_TEST', material: 'forged-material' }, { objective: 'Nope.' }),
      (error: unknown) => error instanceof PrincipalValidationError,
    );
    const items = await h.host().list(h.actor, { limit: 100 });
    assert.equal(items.length, 0);
  });

  it('T03-21b: a missing credential creates no work', async () => {
    const h = await buildHarness();
    const ingress = testIngress(h);
    for (const missing of [undefined, null]) {
      await assert.rejects(
        () => ingress.submit(missing, { objective: 'Anonymous attempt.' }),
        (error: unknown) => error instanceof UnauthenticatedRequestError,
      );
    }
    assert.equal((await h.host().list(h.actor, { limit: 100 })).length, 0);
  });

  it('T03-21c: a blank objective is refused before any authentication work is persisted', async () => {
    const h = await buildHarness();
    await assert.rejects(
      () => testIngress(h).submit(credential(), { objective: '   ' }),
      /non-blank objective/,
    );
    assert.equal((await h.host().list(h.actor, { limit: 100 })).length, 0);
  });

  it('T03-22: a persistence failure yields no false success', async () => {
    const h = await buildHarness();
    const host = h.host();
    const original = host.enqueue.bind(host);
    host.enqueue = (async () => {
      throw new Error('simulated durable storage failure');
    }) as typeof host.enqueue;
    try {
      let receipt: unknown;
      await assert.rejects(
        async () => {
          receipt = await testIngress(h, testBoundary(h)).submit(credential(), { objective: 'Persist fail.' });
        },
        /simulated durable storage failure/,
      );
      assert.equal(receipt, undefined, 'no receipt may be produced when persistence fails');
    } finally {
      host.enqueue = original;
    }
  });

  it('T03-23: an authority-policy refusal queues nothing', async () => {
    const h = await buildHarness();
    // A production-posture boundary refuses DETERMINISTIC_TEST outright.
    const productionBoundary = new PrincipalBoundary({
      policy: { mode: 'production' },
      now: h.now,
    });
    const ingress = new WorkIngressService({ boundary: productionBoundary, host: h.host(), now: h.now });
    await assert.rejects(
      () => ingress.submit(credential(), { objective: 'Test authority in production.' }),
      (error: unknown) => error instanceof AuthenticationPolicyError || error instanceof PrincipalValidationError,
    );
    assert.equal((await h.host().list(h.actor, { limit: 100 })).length, 0);
  });

  it('T03-24: no fallback principal is ever generated', async () => {
    const h = await buildHarness();
    const boundary = testBoundary(h);
    const attempts = [
      boundary.authenticate(undefined),
      boundary.authenticate({ method: 'DETERMINISTIC_TEST', material: '' }),
      boundary.authenticate({ method: 'DETERMINISTIC_TEST', material: 'unknown' }),
      boundary.authenticate({ method: 'STATIC_TOKEN', material: 'anything' }),
    ];
    const results = await Promise.allSettled(attempts);
    for (const result of results) assert.equal(result.status, 'rejected');
    assert.equal((await h.host().list(h.actor, { limit: 100 })).length, 0);
  });

  it('T03-24b: the ingress constructs nothing authoritative and holds no credential', () => {
    const h = { now: () => 1 } as unknown as Harness;
    const boundary = new PrincipalBoundary({
      policy: { mode: 'test-only', allowTestMethod: true },
      authenticators: [new DeterministicTestAuthenticator([INGRESS_RECORD])],
    });
    const sink = { enqueue: async () => { throw new Error('unused'); } };
    const ingress = new WorkIngressService({ boundary, host: sink, now: h.now });
    // The only readable state is the policy; there is no principal store.
    assert.equal(ingress.getPolicy().mode, 'test-only');
    assert.deepEqual(Object.getOwnPropertyNames(WorkIngressService.prototype).filter((n) => n !== 'constructor'), [
      'getPolicy',
      'submit',
    ]);
  });

  it('T03-24c: the ingress refuses to be built without a boundary or a sink', () => {
    assert.throws(() => new WorkIngressService({} as never), /principal boundary/);
    const boundary = new PrincipalBoundary();
    assert.throws(
      () => new WorkIngressService({ boundary } as never),
      /enqueue sink/,
    );
  });
});

describe('T-03 ingress — end-to-end through the real governed loop', () => {
  it('T03-25: authenticated ingress -> durable queue -> host dispatch -> unified 34-stage loop', async () => {
    const h = await buildHarness();
    const svc = h.host();
    svc.start();

    const receipt = await testIngress(h).submit(credential(), {
      objective: reasoningTask().objective,
      observations: reasoningTask().observations,
      knowledgeQuery: reasoningTask().knowledgeQuery,
      correlationId: 't03-e2e',
      idempotencyKey: 't03-e2e-key',
    });
    assert.equal(receipt.status, 'QUEUED');
    assert.equal(receipt.correlationId, 't03-e2e');
    assert.equal(receipt.hostLifecycle, 'RUNNING');

    // Dispatch with the DEFAULT runner: the real 34-stage unified loop.
    const summary = await svc.tick();
    assert.equal(summary.dispatched, 1, 'exactly one dispatch');
    assert.equal(summary.completed, 1, 'the single run settled in the same pass');
    assert.equal(summary.deadLettered, 0);

    const settled = await svc.get(h.actor, receipt.workId);
    assert.ok(settled, 'the work item must exist after dispatch');
    assert.ok(settled?.loopId, 'a real loop run id must be recorded');
    assert.ok(['COMPLETED', 'HELD'].includes(settled!.status), `unexpected status ${settled?.status}`);
    // The loop's own T-01 match check ran on the forwarded principal: the item
    // completed as a governed dry run, not as an unauthorized execution.
    assert.equal(settled?.loopOutcome, 'COMPLETED_DRY_RUN');
  });

  it('T03-25b: idempotent re-submission returns the same durable work item', async () => {
    const h = await buildHarness();
    const ingress = testIngress(h);
    const first = await ingress.submit(credential(), { objective: 'Once only.', idempotencyKey: 't03-idem' });
    const second = await ingress.submit(credential(), { objective: 'Once only.', idempotencyKey: 't03-idem' });
    assert.equal(first.workId, second.workId);
    const items = await h.host().list(h.actor, { limit: 100 });
    assert.equal(items.length, 1);
  });
});

describe('T-03 ingress — kernel module composition', () => {
  it('boots authentication + loop-host + work-ingress and exposes one ingress service', async () => {
    // The full fabric, composed exactly as the production root does: the
    // boundary and the ingress are real kernel modules, not hand-wired objects.
    const h = await buildHarness({ withIngress: true });
    const ingress = h.ingress();
    assert.ok(ingress instanceof WorkIngressService);
    assert.equal(ingress.getPolicy().mode, 'test-only');

    const receipt = await ingress.submit(ingressCredential(), { objective: 'Module-composed ingress.' });
    assert.ok(receipt.workId);
    assert.equal(receipt.tenantId, DEFAULT_INGRESS_RECORD.tenantId);
    assert.equal(receipt.hostLifecycle, 'IDLE', 'composition must not auto-start the host');
    // Exactly one ingress service is published under both container tokens.
    const viaService = await h.kernel.container.resolve<WorkIngressService>('work-ingress.service');
    const viaToken = await h.kernel.container.resolve<WorkIngressService>('work-ingress');
    assert.equal(viaService, viaToken);
    assert.equal(viaService, ingress);
  });

  it('exposes no work-ingress module unless the host is composed (no orphan ingress)', async () => {
    const h = await buildHarness();
    assert.throws(
      () => h.kernel.getModule('work-ingress'),
      'the ingress must not exist without the host it submits to',
    );
  });
});
