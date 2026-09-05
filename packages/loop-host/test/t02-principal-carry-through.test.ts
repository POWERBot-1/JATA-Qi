// T-02 authenticated durable authority carry-through (in-memory, deterministic).
//
// Durable work must never execute on a caller-self-asserted actor: enqueue
// embeds a persisted authenticated-principal snapshot (principalId,
// tenantId, roles, authenticationMethod, verifiedAt, authenticationEventId —
// never secrets/tokens), and every dispatch re-verifies that snapshot
// against freshness policy and the persisted actor before the loop runs.
// Failures HOLD the item with a deterministic AuthorityHoldReason; they
// never execute, never retry blindly, and operator resume/retry of an
// authority hold is refused. The test authenticator is the tests-only
// principal source; production admission is governed by principal policy.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import type { AuthenticatedPrincipal } from '@jataqi/authentication';
import type { LoopRunResult } from '@jataqi/unified-loop';
import type { StorageModule } from '@jataqi/storage';
import {
  DEFAULT_MAX_PRINCIPAL_AGE_MS,
  LoopHostEvents,
  LoopHostService,
  MAX_PRINCIPAL_AGE_MS,
  MAX_PRINCIPAL_CLOCK_SKEW_MS,
  PRINCIPAL_SNAPSHOT_VERSION,
  PrincipalAuthorityError,
  WORK_COLLECTION,
  WorkQueue,
  assessPersistedSnapshot,
  assertActorDerivedFromPrincipal,
  authorizeDispatch,
  freezePrincipalSnapshot,
  principalFromSnapshot,
  provenanceOf,
  serializePrincipalSnapshot,
  type AuthenticatedPrincipalSnapshot,
  type AuthorityHoldReason,
  type HostedWorkItem,
  type LoopRunner,
} from '../src/index.js';
import { buildHarness, mintTestPrincipal, reasoningTask, testPrincipalFor, type Harness } from './helpers.js';

function loopResult(outcome: LoopRunResult['outcome']): LoopRunResult {
  return {
    loopId: 'loop-t02',
    correlationId: 'corr-t02',
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

/** Capture host audit events off the kernel bus (payloads are the audit trail). */
function collectHostEvents(h: Harness): Array<{ event: string; payload: Record<string, unknown> }> {
  const seen: Array<{ event: string; payload: Record<string, unknown> }> = [];
  for (const name of Object.values(LoopHostEvents)) {
    h.kernel.bus.on(name, (payload: unknown) => {
      seen.push({ event: name, payload: payload as Record<string, unknown> });
    });
  }
  return seen;
}

/** Rewrite one stored work item (simulates storage-layer tampering / legacy rows). */
async function tamperItem(h: Harness, id: string, mutate: (raw: HostedWorkItem) => HostedWorkItem): Promise<HostedWorkItem> {
  const storage = h.kernel.getModule<StorageModule>('storage');
  const items = await storage.collection<HostedWorkItem>(WORK_COLLECTION);
  const raw = await items.get(id);
  assert.ok(raw, 'expected the work item to exist before tampering');
  const next = mutate({ ...raw });
  await items.put(next);
  return next;
}

/** Recursively collect every key in a JSON value (secret-smuggling scan). */
function allKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) allKeys(entry, into);
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      into.add(key);
      allKeys(entry, into);
    }
  }
  return into;
}

function assertNoSecretKeys(value: unknown, where: string): void {
  for (const key of allKeys(value)) {
    assert.ok(
      !/material|token|secret|password|credential|privatekey|private_key/i.test(key),
      `${where} must never carry secret material (found key "${key}")`,
    );
  }
}

describe('T-02 authenticated enqueue boundary', () => {
  it('T02-01: enqueue embeds a versioned snapshot with exactly the six provenance fields', async () => {
    const h = await buildHarness();
    const svc = h.host();
    const principal = await testPrincipalFor(h.actor, h.now());
    const item = await svc.enqueue(h.actor, { task: reasoningTask() }, principal);
    assert.ok(item.principal, 'enqueued item must carry a principal snapshot');
    assert.equal(item.principal.version, PRINCIPAL_SNAPSHOT_VERSION);
    assert.equal(item.principal.version, 1);
    assert.deepEqual(
      { ...item.principal },
      {
        version: 1,
        principalId: principal.id,
        tenantId: principal.tenantId,
        roles: [...principal.roles],
        authenticationMethod: principal.authenticationMethod,
        verifiedAt: principal.verifiedAt,
        authenticationEventId: principal.authenticationEventId,
      },
    );
    assertNoSecretKeys(item, 'enqueued work item');
    // The persisted narrowed actor is recorded alongside the snapshot.
    assert.deepEqual(item.actor, { id: h.actor.id, tenantId: h.actor.tenantId, roles: [...h.actor.roles] });
  });

  it('T02-02: unsigned enqueue is rejected fail-closed before any write', async () => {
    const h = await buildHarness();
    const svc = h.host();
    for (const bad of [undefined, null, {}, { id: 'x' }]) {
      await assert.rejects(
        () => svc.enqueue(h.actor, { task: reasoningTask() }, bad as never),
        PrincipalAuthorityError,
      );
    }
    assert.equal((await svc.list(h.actor, {})).length, 0, 'rejected enqueues must persist nothing');
  });

  it('T02-03: actor/principal identity mismatch is rejected (id, tenant)', async () => {
    const h = await buildHarness();
    const svc = h.host();
    const wrongId = await mintTestPrincipal({ id: 'someone-else', tenantId: 'acme', roles: ['agent', 'operator'] }, h.now());
    await assert.rejects(() => svc.enqueue(h.actor, { task: reasoningTask() }, wrongId), /id does not match/);
    const wrongTenant = await mintTestPrincipal({ id: h.actor.id, tenantId: 'other', roles: ['agent', 'operator'] }, h.now());
    await assert.rejects(() => svc.enqueue(h.actor, { task: reasoningTask() }, wrongTenant), /tenant does not match/);
    assert.equal((await svc.list(h.actor, {})).length, 0);
  });

  it('T02-04: actor role expansion beyond the verified set is rejected; narrowing is admitted', async () => {
    const h = await buildHarness();
    const svc = h.host();
    const narrow = await mintTestPrincipal({ id: h.actor.id, tenantId: 'acme', roles: ['agent'] }, h.now());
    const widenedActor: CommercialActor = { id: h.actor.id, tenantId: 'acme', roles: ['agent', 'operator'] };
    await assert.rejects(() => svc.enqueue(widenedActor, { task: reasoningTask() }, narrow), /not in the authenticated/);
    // Narrowing (fewer roles than verified) is legitimate least privilege.
    const slimActor: CommercialActor = { id: h.actor.id, tenantId: 'acme', roles: ['agent'] };
    const wide = await testPrincipalFor(h.actor, h.now());
    const item = await svc.enqueue(slimActor, { task: reasoningTask() }, wide);
    assert.deepEqual(item.actor.roles, ['agent']);
    assert.deepEqual([...(item.principal?.roles ?? [])], ['agent', 'operator']);
  });

  it('T02-05: a principal stale at enqueue is rejected before any write', async () => {
    const h = await buildHarness();
    const svc = h.host();
    const stale = await testPrincipalFor(h.actor, h.now() - DEFAULT_MAX_PRINCIPAL_AGE_MS - 1);
    await assert.rejects(() => svc.enqueue(h.actor, { task: reasoningTask() }, stale), /stale|maximum age/i);
    assert.equal((await svc.list(h.actor, {})).length, 0, 'stale enqueue must persist nothing');
  });
});

describe('T-02 dispatch carry-through', () => {
  it('T02-06: dispatch executes with the persisted verified actor and carries the principal to the runner', async () => {
    const h = await buildHarness();
    const svc = h.host();
    let seenActor: CommercialActor | undefined;
    let seenPrincipal: AuthenticatedPrincipal | undefined;
    const runner: LoopRunner = async (actor, _task, opts) => {
      seenActor = actor;
      seenPrincipal = opts.principal;
      return loopResult('COMPLETED_DRY_RUN');
    };
    svc.setRunner(runner);
    svc.start();
    const principal = await testPrincipalFor(h.actor, h.now());
    const item = await svc.enqueue(h.actor, { task: reasoningTask() }, principal);
    const summary = await svc.tick();
    assert.equal(summary.dispatched, 1);
    assert.equal(summary.completed, 1);
    assert.ok(seenActor && seenPrincipal, 'runner must observe the carried authority');
    // The execution actor is the persisted narrowed actor (never a
    // caller-supplied replacement), and it matches the snapshot identity.
    assert.deepEqual(seenActor, { id: item.actor.id, tenantId: item.actor.tenantId, roles: [...item.actor.roles] });
    assert.equal(seenActor.id, seenPrincipal.id);
    assert.equal(seenActor.tenantId, seenPrincipal.tenantId);
    assert.deepEqual(seenPrincipal, principalFromSnapshot(item.principal!));
    assert.equal(seenPrincipal.authenticationEventId, principal.authenticationEventId);
    assert.equal(seenPrincipal.authenticationMethod, 'DETERMINISTIC_TEST');
    const settled = await svc.get(h.actor, item.id);
    assert.equal(settled?.status, 'COMPLETED');
  });

  it('T02-07: narrowing persists end to end — execution never exceeds the persisted actor', async () => {
    const h = await buildHarness();
    const svc = h.host();
    let seenActor: CommercialActor | undefined;
    let seenPrincipal: AuthenticatedPrincipal | undefined;
    svc.setRunner((async (actor, _task, opts) => {
      seenActor = actor;
      seenPrincipal = opts.principal;
      return loopResult('COMPLETED_DRY_RUN');
    }) as LoopRunner);
    svc.start();
    const slimActor: CommercialActor = { id: h.actor.id, tenantId: 'acme', roles: ['agent'] };
    const principal = await testPrincipalFor(h.actor, h.now());
    await svc.enqueue(slimActor, { task: reasoningTask() }, principal);
    await svc.tick();
    assert.deepEqual(seenActor?.roles, ['agent'], 'execution actor must be the persisted narrowed actor');
    assert.deepEqual(seenPrincipal?.roles, ['agent', 'operator'], 'principal still carries the verified set');
    assert.ok((seenActor?.roles ?? []).every((role) => (seenPrincipal?.roles ?? []).includes(role)));
  });

  it('T02-08: widened persisted actor roles in storage HOLD with PRINCIPAL_ROLE_ESCALATION', async () => {
    const h = await buildHarness();
    const svc = h.host();
    let calls = 0;
    svc.setRunner((async () => {
      calls += 1;
      return loopResult('COMPLETED_DRY_RUN');
    }) as LoopRunner);
    svc.start();
    const item = await svc.enqueue(h.actor, { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    await tamperItem(h, item.id, (raw) => ({
      ...raw,
      actor: { ...raw.actor, roles: [...raw.actor.roles, 'admin'] },
    }));
    const summary = await svc.tick();
    assert.equal(calls, 0, 'escalated authority must never reach the runner');
    assert.equal(summary.dispatched, 0);
    assert.equal(summary.held, 1);
    const held = await svc.get(h.actor, item.id);
    assert.equal(held?.status, 'HELD');
    assert.equal(held?.heldReason, 'PRINCIPAL_ROLE_ESCALATION');
  });

  it('T02-09: narrowing the snapshot below the persisted actor also escalates (fail-closed)', async () => {
    const h = await buildHarness();
    const svc = h.host();
    let calls = 0;
    svc.setRunner((async () => {
      calls += 1;
      return loopResult('COMPLETED_DRY_RUN');
    }) as LoopRunner);
    svc.start();
    const item = await svc.enqueue(h.actor, { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    await tamperItem(h, item.id, (raw) => ({
      ...raw,
      principal: { ...raw.principal!, roles: ['agent'] },
    }));
    await svc.tick();
    assert.equal(calls, 0);
    const held = await svc.get(h.actor, item.id);
    assert.equal(held?.status, 'HELD');
    assert.equal(held?.heldReason, 'PRINCIPAL_ROLE_ESCALATION');
  });

  it('T02-10: tenant tampering on either side of the triple match HOLDS with PRINCIPAL_MISMATCH', async () => {
    const h = await buildHarness();
    const svc = h.host();
    let calls = 0;
    svc.setRunner((async () => {
      calls += 1;
      return loopResult('COMPLETED_DRY_RUN');
    }) as LoopRunner);
    svc.start();
    const viaItem = await svc.enqueue(h.actor, { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    await tamperItem(h, viaItem.id, (raw) => ({ ...raw, tenantId: 'other' }));
    const viaSnapshot = await svc.enqueue(h.actor, { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    await tamperItem(h, viaSnapshot.id, (raw) => ({
      ...raw,
      principal: { ...raw.principal!, tenantId: 'other' },
    }));
    // A consistent double-tamper still trips the actor leg of the match.
    const viaActor = await svc.enqueue(h.actor, { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    await tamperItem(h, viaActor.id, (raw) => ({
      ...raw,
      actor: { ...raw.actor, tenantId: 'other' },
    }));
    // A deleted actor must HOLD (fail closed), never throw into the
    // substrate-failure path (which would reclaim/redispatch forever).
    const actorDeleted = await svc.enqueue(h.actor, { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    await tamperItem(h, actorDeleted.id, (raw) => {
      const { actor: _dropped, ...rest } = raw;
      void _dropped;
      return rest as HostedWorkItem;
    });
    const summary = await svc.tick();
    assert.equal(calls, 0, 'no tenant-mismatched item may execute');
    assert.equal(summary.held, 4);
    for (const id of [viaSnapshot.id, viaActor.id, actorDeleted.id]) {
      const held = await svc.get(h.actor, id);
      assert.equal(held?.status, 'HELD');
      assert.equal(held?.heldReason, 'PRINCIPAL_MISMATCH');
    }
    // The item-tenant-tampered row now reads back under the 'other' tenant.
    const heldOther = await svc.get(h.other, viaItem.id);
    assert.equal(heldOther?.status, 'HELD');
    assert.equal(heldOther?.heldReason, 'PRINCIPAL_MISMATCH');
  });

  it('T02-11: pre-T-02 legacy rows (no snapshot) HOLD with PRINCIPAL_ABSENT', async () => {
    const h = await buildHarness();
    const svc = h.host();
    let calls = 0;
    svc.setRunner((async () => {
      calls += 1;
      return loopResult('COMPLETED_DRY_RUN');
    }) as LoopRunner);
    svc.start();
    const item = await svc.enqueue(h.actor, { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    await tamperItem(h, item.id, (raw) => {
      const { principal: _dropped, ...legacy } = raw;
      void _dropped;
      return legacy as HostedWorkItem;
    });
    await svc.tick();
    assert.equal(calls, 0);
    const held = await svc.get(h.actor, item.id);
    assert.equal(held?.status, 'HELD');
    assert.equal(held?.heldReason, 'PRINCIPAL_ABSENT');
  });

  it('T02-12: unknown snapshot versions and malformed shapes HOLD deterministically', async () => {
    const h = await buildHarness();
    const svc = h.host();
    svc.setRunner((async () => loopResult('COMPLETED_DRY_RUN')) as LoopRunner);
    svc.start();
    const versioned = await svc.enqueue(h.actor, { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    await tamperItem(h, versioned.id, (raw) => ({
      ...raw,
      principal: { ...raw.principal!, version: 99 } as unknown as AuthenticatedPrincipalSnapshot,
    }));
    const malformed = await svc.enqueue(h.actor, { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    await tamperItem(h, malformed.id, (raw) => ({
      ...raw,
      principal: { ...raw.principal!, roles: [] } as unknown as AuthenticatedPrincipalSnapshot,
    }));
    const badMethod = await svc.enqueue(h.actor, { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    await tamperItem(h, badMethod.id, (raw) => ({
      ...raw,
      principal: { ...raw.principal!, authenticationMethod: 'FORGED' } as unknown as AuthenticatedPrincipalSnapshot,
    }));
    const summary = await svc.tick();
    assert.equal(summary.held, 3);
    assert.equal((await svc.get(h.actor, versioned.id))?.heldReason, 'PRINCIPAL_VERSION');
    assert.equal((await svc.get(h.actor, malformed.id))?.heldReason, 'PRINCIPAL_MALFORMED');
    assert.equal((await svc.get(h.actor, badMethod.id))?.heldReason, 'PRINCIPAL_MALFORMED');
  });
});

describe('T-02 freshness policy', () => {
  /** Standalone service on the harness kernel with explicit principal policy. */
  async function strictService(h: Harness, opts: { maxPrincipalAgeMs?: number; allowTestMethod?: boolean } = {}) {
    const svc = new LoopHostService({
      hostId: `t02-${Math.random().toString(36).slice(2)}`,
      now: h.now,
      maxPrincipalAgeMs: opts.maxPrincipalAgeMs,
      principalPolicy: opts.allowTestMethod === undefined ? undefined : { allowTestMethod: opts.allowTestMethod },
    });
    await svc.init(h.kernel);
    return svc;
  }

  it('T02-13: the exact max-age boundary is fresh; one millisecond later is stale', async () => {
    const h = await buildHarness();
    const svc = await strictService(h, { maxPrincipalAgeMs: 10_000 });
    let calls = 0;
    svc.setRunner((async () => {
      calls += 1;
      return loopResult('COMPLETED_DRY_RUN');
    }) as LoopRunner);
    svc.start();
    const principal = await testPrincipalFor(h.actor, h.now());
    const item = await svc.enqueue(h.actor, { task: reasoningTask() }, principal);
    h.advance(10_000);
    await svc.tick();
    assert.equal(calls, 1, 'age == maxAge must still dispatch');
    assert.equal((await svc.get(h.actor, item.id))?.status, 'COMPLETED');

    const h2 = await buildHarness();
    const svc2 = await strictService(h2, { maxPrincipalAgeMs: 10_000 });
    svc2.setRunner((async () => loopResult('COMPLETED_DRY_RUN')) as LoopRunner);
    svc2.start();
    const item2 = await svc2.enqueue(h2.actor, { task: reasoningTask() }, await testPrincipalFor(h2.actor, h2.now()));
    h2.advance(10_001);
    const summary = await svc2.tick();
    assert.equal(summary.held, 1);
    const held = await svc2.get(h2.actor, item2.id);
    assert.equal(held?.status, 'HELD');
    assert.equal(held?.heldReason, 'PRINCIPAL_STALE');
  });

  it('T02-14: the default policy is a 24-hour horizon', async () => {
    assert.equal(DEFAULT_MAX_PRINCIPAL_AGE_MS, 24 * 60 * 60 * 1000);
    const h = await buildHarness();
    const svc = h.host();
    let calls = 0;
    svc.setRunner((async () => {
      calls += 1;
      return loopResult('COMPLETED_DRY_RUN');
    }) as LoopRunner);
    svc.start();
    const fresh = await svc.enqueue(h.actor, { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    h.advance(DEFAULT_MAX_PRINCIPAL_AGE_MS - 1);
    await svc.tick();
    assert.equal(calls, 1, '23:59:59.999-old principal must dispatch under the default policy');
    assert.equal((await svc.get(h.actor, fresh.id))?.status, 'COMPLETED');

    const h2 = await buildHarness();
    const svc2 = h2.host();
    svc2.setRunner((async () => loopResult('COMPLETED_DRY_RUN')) as LoopRunner);
    svc2.start();
    const old = await svc2.enqueue(h2.actor, { task: reasoningTask() }, await testPrincipalFor(h2.actor, h2.now()));
    h2.advance(DEFAULT_MAX_PRINCIPAL_AGE_MS + 1);
    await svc2.tick();
    assert.equal((await svc2.get(h2.actor, old.id))?.heldReason, 'PRINCIPAL_STALE');
  });

  it('T02-15: freshness is re-checked at dispatch, not just at enqueue', async () => {
    const h = await buildHarness();
    const svc = await strictService(h, { maxPrincipalAgeMs: 60_000 });
    let calls = 0;
    svc.setRunner((async () => {
      calls += 1;
      return loopResult('COMPLETED_DRY_RUN');
    }) as LoopRunner);
    svc.start();
    const item = await svc.enqueue(h.actor, { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    h.advance(120_000);
    const summary = await svc.tick();
    assert.equal(calls, 0, 'a principal that aged out while queued must not execute');
    assert.equal(summary.held, 1);
    assert.equal((await svc.get(h.actor, item.id))?.heldReason, 'PRINCIPAL_STALE');
  });

  it('T02-16: future verifiedAt within skew is tolerated; beyond skew HOLDS', async () => {
    assert.equal(MAX_PRINCIPAL_CLOCK_SKEW_MS, 5 * 60 * 1000);
    const h = await buildHarness();
    const svc = h.host();
    let calls = 0;
    svc.setRunner((async () => {
      calls += 1;
      return loopResult('COMPLETED_DRY_RUN');
    }) as LoopRunner);
    svc.start();
    const within = await svc.enqueue(h.actor, { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    await tamperItem(h, within.id, (raw) => ({
      ...raw,
      principal: { ...raw.principal!, verifiedAt: raw.principal!.verifiedAt + MAX_PRINCIPAL_CLOCK_SKEW_MS },
    }));
    const beyond = await svc.enqueue(h.actor, { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    await tamperItem(h, beyond.id, (raw) => ({
      ...raw,
      principal: { ...raw.principal!, verifiedAt: raw.principal!.verifiedAt + MAX_PRINCIPAL_CLOCK_SKEW_MS + 1 },
    }));
    const summary = await svc.tick();
    assert.equal(calls, 1, 'within-tolerance future drift must still dispatch');
    assert.equal(summary.completed, 1);
    assert.equal(summary.held, 1);
    assert.equal((await svc.get(h.actor, within.id))?.status, 'COMPLETED');
    const held = await svc.get(h.actor, beyond.id);
    assert.equal(held?.status, 'HELD');
    assert.equal(held?.heldReason, 'PRINCIPAL_SKEW');
  });

  it('T02-17: max-age configuration is validated fail-closed at construction', async () => {
    const h = await buildHarness();
    for (const bad of [-1, 1.5, Number.NaN, MAX_PRINCIPAL_AGE_MS + 1]) {
      assert.throws(() => new LoopHostService({ maxPrincipalAgeMs: bad }), PrincipalAuthorityError);
    }
    assert.equal(MAX_PRINCIPAL_AGE_MS, 30 * 24 * 60 * 60 * 1000);
    // Boundary values construct: zero (immediate expiry) and the 30-day cap.
    const zero = new LoopHostService({ maxPrincipalAgeMs: 0, now: h.now });
    await zero.init(h.kernel);
    const capped = new LoopHostService({ maxPrincipalAgeMs: MAX_PRINCIPAL_AGE_MS, now: h.now });
    await capped.init(h.kernel);
  });
});

describe('T-02 authority holds are operator-terminal (never auto-retried, never resumed)', () => {
  it('T02-18: operator resume of an authority hold is refused; loop holds still resume', async () => {
    const h = await buildHarness();
    const svc = h.host();
    svc.setRunner((async () => loopResult('HELD_AT_GATE')) as LoopRunner);
    svc.start();
    const staleItem = await svc.enqueue(h.actor, { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    // Age the snapshot in storage past the default horizon.
    await tamperItem(h, staleItem.id, (raw) => ({
      ...raw,
      principal: { ...raw.principal!, verifiedAt: raw.principal!.verifiedAt - DEFAULT_MAX_PRINCIPAL_AGE_MS - 1 },
    }));
    await svc.tick();
    assert.equal((await svc.get(h.actor, staleItem.id))?.heldReason, 'PRINCIPAL_STALE');
    await assert.rejects(() => svc.resume(h.actor, staleItem.id), PrincipalAuthorityError);
    // Refusal is independent of the operator: even a same-tenant admin
    // cannot resume an authority hold (only fresh authenticated work can).
    await assert.rejects(() => svc.resume(h.admin, staleItem.id), PrincipalAuthorityError);
    // A second tick does not re-dispatch or clear the hold.
    await svc.tick();
    const still = await svc.get(h.actor, staleItem.id);
    assert.equal(still?.status, 'HELD');
    assert.equal(still?.heldReason, 'PRINCIPAL_STALE');

    // Loop-requested holds (no authority reason) remain operator-resumable.
    const loopHeld = await svc.enqueue(h.actor, { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    await svc.tick();
    const parked = await svc.get(h.actor, loopHeld.id);
    assert.equal(parked?.status, 'HELD');
    assert.equal(parked?.heldReason, undefined);
    const resumed = await svc.resume(h.actor, loopHeld.id);
    assert.equal(resumed.status, 'QUEUED');
  });
});

describe('T-02 production/test authentication boundary', () => {
  it('T02-19: DETERMINISTIC_TEST is admitted by default', async () => {
    const h = await buildHarness();
    const svc = h.host();
    let method: string | undefined;
    svc.setRunner((async (_actor, _task, opts) => {
      method = opts.principal.authenticationMethod;
      return loopResult('COMPLETED_DRY_RUN');
    }) as LoopRunner);
    svc.start();
    const item = await svc.enqueue(h.actor, { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    await svc.tick();
    assert.equal(method, 'DETERMINISTIC_TEST');
    assert.equal((await svc.get(h.actor, item.id))?.status, 'COMPLETED');
  });

  it('T02-20: allowTestMethod=false rejects at enqueue and HOLDS at dispatch', async () => {
    const h = await buildHarness();
    const svc = new LoopHostService({ now: h.now, principalPolicy: { allowTestMethod: false } });
    await svc.init(h.kernel);
    svc.setRunner((async () => loopResult('COMPLETED_DRY_RUN')) as LoopRunner);
    svc.start();
    const principal = await testPrincipalFor(h.actor, h.now());
    await assert.rejects(() => svc.enqueue(h.actor, { task: reasoningTask() }, principal), /TEST_METHOD|test/i);
    assert.equal((await svc.list(h.actor, {})).length, 0);

    // The queue itself carries no policy: an item that reaches dispatch on a
    // strict host (e.g. enqueued before the policy tightened) is HELD, never run.
    const h2 = await buildHarness();
    const strict = new LoopHostService({ now: h2.now, principalPolicy: { allowTestMethod: false } });
    await strict.init(h2.kernel);
    let calls = 0;
    strict.setRunner((async () => {
      calls += 1;
      return loopResult('COMPLETED_DRY_RUN');
    }) as LoopRunner);
    strict.start();
    const plainQueue = new WorkQueue();
    await plainQueue.init(h2.kernel);
    const bypassed = await plainQueue.enqueue(h2.actor, { task: reasoningTask() }, await testPrincipalFor(h2.actor, h2.now()), h2.now());
    await strict.tick();
    assert.equal(calls, 0);
    const held = await strict.get(h2.actor, bypassed.id);
    assert.equal(held?.status, 'HELD');
    assert.equal(held?.heldReason, 'PRINCIPAL_TEST_METHOD');
  });
});

describe('T-02 audit-trail provenance and crash recovery', () => {
  it('T02-21: lifecycle events carry principal provenance; Held carries best-effort provenance', async () => {
    const h = await buildHarness();
    const svc = h.host();
    svc.setRunner((async () => loopResult('COMPLETED_DRY_RUN')) as LoopRunner);
    const seen = collectHostEvents(h);
    svc.start();
    const principal = await testPrincipalFor(h.actor, h.now());
    const item = await svc.enqueue(h.actor, { task: reasoningTask(), correlationId: 'corr-prov' }, principal);
    const stale = await svc.enqueue(h.actor, { task: reasoningTask(), correlationId: 'corr-stale' }, await testPrincipalFor(h.actor, h.now()));
    await tamperItem(h, stale.id, (raw) => ({
      ...raw,
      principal: { ...raw.principal!, verifiedAt: raw.principal!.verifiedAt - DEFAULT_MAX_PRINCIPAL_AGE_MS - 1 },
    }));
    await svc.tick();

    const byEvent = (name: string) => seen.filter((entry) => entry.event === name).map((entry) => entry.payload);
    for (const name of [LoopHostEvents.Dispatched, LoopHostEvents.Completed, LoopHostEvents.CheckpointWritten]) {
      const payloads = byEvent(name).filter((payload) => payload.correlationId === 'corr-prov');
      assert.ok(payloads.length > 0, `expected ${name} for the completed item`);
      for (const payload of payloads) {
        assert.equal(payload.principalMethod, 'DETERMINISTIC_TEST');
        assert.equal(payload.principalEventId, principal.authenticationEventId);
        assert.equal(payload.principalVerifiedAt, principal.verifiedAt);
        assert.equal(payload.principalId, principal.id);
      }
      for (const payload of payloads) assertNoSecretKeys(payload, `${name} payload`);
    }
    const heldPayloads = byEvent(LoopHostEvents.Held).filter((payload) => payload.correlationId === 'corr-stale');
    assert.equal(heldPayloads.length, 1);
    assert.equal(heldPayloads[0].heldReason, 'PRINCIPAL_STALE');
    assert.equal(heldPayloads[0].status, 'HELD');
    assert.equal(heldPayloads[0].principalId, h.actor.id);
    assert.equal(heldPayloads[0].principalMethod, 'DETERMINISTIC_TEST');
    assert.ok(typeof heldPayloads[0].principalEventId === 'string');
    void item;
  });

  it('T02-22: the carried principal survives crash between dispatch and settle (same event id after recovery)', async () => {
    const h = await buildHarness();
    const svc = h.host();
    const observedEventIds: string[] = [];
    let calls = 0;
    svc.setRunner((async (_actor, _task, opts) => {
      calls += 1;
      observedEventIds.push(opts.principal.authenticationEventId);
      if (calls === 1) throw new Error('simulated host death during first dispatch');
      return loopResult('COMPLETED_DRY_RUN');
    }) as LoopRunner);
    svc.start();
    const principal = await testPrincipalFor(h.actor, h.now());
    const item = await svc.enqueue(h.actor, { task: reasoningTask(), baseDelayMs: 0, maxDelayMs: 0 }, principal);
    await svc.tick();
    assert.equal(calls, 1);
    // Simulate host death between markDispatched and settle: force the
    // record back to DISPATCHED with an expired lease (spread preserves
    // actor + snapshot exactly as durable storage would).
    await tamperItem(h, item.id, (raw) => ({
      ...raw,
      status: 'DISPATCHED',
      leaseOwner: 'dead-host',
      leaseToken: 'dead-token',
      leaseExpiry: h.now() - 1,
    }));
    await svc.recover();
    await svc.tick();
    assert.equal(calls, 2);
    assert.equal(observedEventIds[0], principal.authenticationEventId);
    assert.equal(observedEventIds[1], principal.authenticationEventId, 're-dispatch must carry the identical snapshot');
    const settled = await svc.get(h.actor, item.id);
    assert.equal(settled?.status, 'COMPLETED');
    assert.equal(settled?.principal?.authenticationEventId, principal.authenticationEventId);
  });
});

describe('T-02 pure core: freeze / serialize / assess / authorize', () => {
  const NOW = 1_700_000_000_000;

  async function testPrincipal(): Promise<AuthenticatedPrincipal> {
    return mintTestPrincipal({ id: 'pure-agent', tenantId: 'acme', roles: ['agent', 'operator'] }, NOW);
  }

  it('T02-23: freeze strips everything but the fixed fields and returns a frozen snapshot', async () => {
    const principal = await testPrincipal();
    const hostile = { ...principal, material: 'tok-123', token: 'tok-123', secret: 's3cr3t' };
    const frozen = freezePrincipalSnapshot(hostile as AuthenticatedPrincipal);
    assert.deepEqual(Object.keys(frozen), [
      'version',
      'principalId',
      'tenantId',
      'roles',
      'authenticationMethod',
      'verifiedAt',
      'authenticationEventId',
    ]);
    assertNoSecretKeys(frozen, 'frozen snapshot');
    assert.ok(Object.isFrozen(frozen));
    assert.ok(Object.isFrozen(frozen.roles));
    // Defensive copy: later mutation of the source cannot move the snapshot.
    (principal.roles as string[]).push('admin');
    assert.deepEqual([...frozen.roles], ['agent', 'operator']);
  });

  it('T02-24: serialization is deterministic with fixed key order', async () => {
    const frozen = freezePrincipalSnapshot(await testPrincipal());
    const first = serializePrincipalSnapshot(frozen);
    const second = serializePrincipalSnapshot(frozen);
    assert.equal(first, second, 'the same snapshot must serialize byte-identically every time');
    const roundTripped = serializePrincipalSnapshot(freezePrincipalSnapshot(principalFromSnapshot(frozen)));
    assert.equal(roundTripped, first, 'snapshot -> principal -> snapshot must be stable');
    assert.deepEqual(Object.keys(JSON.parse(first)), [
      'version',
      'principalId',
      'tenantId',
      'roles',
      'authenticationMethod',
      'verifiedAt',
      'authenticationEventId',
    ]);
    assert.deepEqual(JSON.parse(first), { ...frozen, roles: [...frozen.roles] });
  });

  it('T02-25: assessment maps every evidence problem to its deterministic hold reason', async () => {
    const frozen = freezePrincipalSnapshot(await testPrincipal());
    const assess = (value: unknown, now: number, maxAge = 60_000) => assessPersistedSnapshot(value, now, maxAge);
    assert.equal(assess(undefined, NOW).ok, false);
    assert.equal((assess(undefined, NOW) as { reason: AuthorityHoldReason }).reason, 'PRINCIPAL_ABSENT');
    assert.equal((assess(null, NOW) as { reason: AuthorityHoldReason }).reason, 'PRINCIPAL_ABSENT');
    assert.equal((assess('nope', NOW) as { reason: AuthorityHoldReason }).reason, 'PRINCIPAL_MALFORMED');
    assert.equal((assess({ ...frozen, version: 2 }, NOW) as { reason: AuthorityHoldReason }).reason, 'PRINCIPAL_VERSION');
    assert.equal((assess({ ...frozen, roles: [] }, NOW) as { reason: AuthorityHoldReason }).reason, 'PRINCIPAL_MALFORMED');
    assert.equal(
      (assess({ ...frozen, authenticationMethod: 'UNKNOWN' }, NOW) as { reason: AuthorityHoldReason }).reason,
      'PRINCIPAL_MALFORMED',
    );
    assert.equal(
      (assess({ ...frozen, verifiedAt: NOW + MAX_PRINCIPAL_CLOCK_SKEW_MS + 1 }, NOW) as { reason: AuthorityHoldReason }).reason,
      'PRINCIPAL_SKEW',
    );
    assert.equal(
      (assess({ ...frozen, verifiedAt: NOW + MAX_PRINCIPAL_CLOCK_SKEW_MS }, NOW) as { ok: boolean }).ok,
      true,
      'exact skew tolerance boundary is tolerated',
    );
    assert.equal((assess(frozen, NOW + 60_000) as { ok: boolean }).ok, true, 'exact boundary is fresh');
    assert.equal((assess(frozen, NOW + 60_001) as { reason: AuthorityHoldReason }).reason, 'PRINCIPAL_STALE');
    assert.throws(() => assess(frozen, NOW, -1), PrincipalAuthorityError, 'corrupt policy fails closed');
    assert.throws(() => assess(frozen, Number.NaN), PrincipalAuthorityError, 'unusable clock fails closed');
  });

  it('T02-26: authorizeDispatch enforces freshness, policy, triple match, identity, and non-expansion', async () => {
    const frozen = freezePrincipalSnapshot(await testPrincipal());
    const base: HostedWorkItem = {
      id: 'w-1',
      tenantId: 'acme',
      correlationId: 'c-1',
      idempotencyKey: 'k-1',
      actor: { id: 'pure-agent', tenantId: 'acme', roles: ['agent'] },
      task: { objective: 'x' },
      status: 'LEASED',
      attemptCount: 0,
      maxAttempts: 3,
      checkpointSequence: 0,
      createdAt: NOW,
      updatedAt: NOW,
      principal: frozen,
    } as unknown as HostedWorkItem;
    const policy = { maxAgeMs: 60_000, allowTestMethod: true };
    const ok = authorizeDispatch(base, NOW, policy);
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.principal.authenticationEventId, frozen.authenticationEventId);
      assert.deepEqual(ok.actor.roles, ['agent'], 'authorized actor is the persisted narrowed actor');
      assert.deepEqual({ ...ok.snapshot, roles: [...ok.snapshot.roles] }, { ...frozen, roles: [...frozen.roles] });
    }
    const stale = authorizeDispatch(base, NOW + 60_001, policy);
    assert.equal((stale as { reason: AuthorityHoldReason }).reason, 'PRINCIPAL_STALE');
    const denied = authorizeDispatch(base, NOW, { maxAgeMs: 60_000, allowTestMethod: false });
    assert.equal((denied as { reason: AuthorityHoldReason }).reason, 'PRINCIPAL_TEST_METHOD');
    const tenantItem = authorizeDispatch({ ...base, tenantId: 'other' }, NOW, policy);
    assert.equal((tenantItem as { reason: AuthorityHoldReason }).reason, 'PRINCIPAL_MISMATCH');
    const tenantActor = authorizeDispatch({ ...base, actor: { ...base.actor, tenantId: 'other' } }, NOW, policy);
    assert.equal((tenantActor as { reason: AuthorityHoldReason }).reason, 'PRINCIPAL_MISMATCH');
    const idMismatch = authorizeDispatch({ ...base, actor: { ...base.actor, id: 'intruder' } }, NOW, policy);
    assert.equal((idMismatch as { reason: AuthorityHoldReason }).reason, 'PRINCIPAL_MISMATCH');
    const escalated = authorizeDispatch({ ...base, actor: { ...base.actor, roles: ['agent', 'admin'] } }, NOW, policy);
    assert.equal((escalated as { reason: AuthorityHoldReason }).reason, 'PRINCIPAL_ROLE_ESCALATION');
    for (const badActor of [undefined, null, 'x', [], { id: 'pure-agent', tenantId: 'acme' }, { ...base.actor, roles: 'agent' }]) {
      const malformed = authorizeDispatch({ ...base, actor: badActor } as unknown as HostedWorkItem, NOW, policy);
      assert.equal(
        (malformed as { reason: AuthorityHoldReason }).reason,
        'PRINCIPAL_MISMATCH',
        `malformed actor must HOLD, got ${JSON.stringify(malformed)}`,
      );
    }
  });

  it('T02-27: actor derivation rejects substitution, cross-tenancy, and expansion', async () => {
    const principal = await testPrincipal();
    assert.doesNotThrow(() =>
      assertActorDerivedFromPrincipal({ id: 'pure-agent', tenantId: 'acme', roles: ['agent'] }, principal),
    );
    assert.throws(() =>
      assertActorDerivedFromPrincipal({ id: 'intruder', tenantId: 'acme', roles: ['agent'] }, principal),
    );
    assert.throws(() =>
      assertActorDerivedFromPrincipal({ id: 'pure-agent', tenantId: 'other', roles: ['agent'] }, principal),
    );
    assert.throws(() =>
      assertActorDerivedFromPrincipal({ id: 'pure-agent', tenantId: 'acme', roles: ['agent', 'admin'] }, principal),
    );
  });

  it('T02-28: provenance projection carries identity evidence and never secrets', async () => {
    const frozen = freezePrincipalSnapshot(await testPrincipal());
    const provenance = provenanceOf(frozen);
    assert.deepEqual(provenance, {
      principalMethod: 'DETERMINISTIC_TEST',
      principalEventId: frozen.authenticationEventId,
      principalVerifiedAt: NOW,
      principalId: 'pure-agent',
    });
    assertNoSecretKeys(provenance, 'provenance projection');
    assert.deepEqual(principalFromSnapshot(frozen), {
      id: 'pure-agent',
      tenantId: 'acme',
      roles: ['agent', 'operator'],
      authenticationMethod: 'DETERMINISTIC_TEST',
      verifiedAt: NOW,
      authenticationEventId: frozen.authenticationEventId,
    });
  });
});
