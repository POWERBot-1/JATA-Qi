import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ManifestDivergenceError,
  ManifestRejectedError,
  manifestDigest,
  manifestVersionId,
  type A01CapabilityManifest,
} from '../src/index.js';
import { bootR2Postgres, type R2Postgres } from './r2-pg.js';
import {
  buildR2World,
  durableManifest,
  registrar,
  uniqueCapability,
  type R2World,
} from './r2-fixtures.js';

// R2 S-1 durable manifest authority over real PostgreSQL. Fail-hard: if
// PostgreSQL cannot start, before() rejects and the suite FAILS (no skip).

let pg: R2Postgres;
let world: R2World;
const T0 = Date.now();

before(async () => {
  pg = await bootR2Postgres('r2manifest', 57300);
  world = await buildR2World(pg.connectionString, T0);
});

after(async () => {
  await pg.stop();
});

describe('R2 S-1 durable manifest authority over real PostgreSQL', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'R2 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('registers a first version as ACTIVE with a stable digest', async () => {
    const capabilityId = uniqueCapability('manifest.first');
    const m = durableManifest(capabilityId);
    const registered = await world.store.registerManifestVersion(m, registrar());
    assert.equal(registered.version, '1');
    assert.equal(registered.supersedes, null);
    assert.equal(registered.digest, manifestDigest(m));
    const active = await world.store.getActiveManifest(capabilityId);
    assert.ok(active);
    assert.equal(active?.version, '1');
    assert.equal(active?.digest, registered.digest);
  });

  it('rotates only by narrowing; the prior version is preserved SUPERSEDED', async () => {
    const capabilityId = uniqueCapability('manifest.narrow');
    const v1 = durableManifest(capabilityId, {
      allowedOperations: [
        { tool: 'test-tool', operation: 'do' },
        { tool: 'test-tool', operation: 'undo' },
      ],
      maxDataClassification: 'CONFIDENTIAL',
    });
    const r1 = await world.store.registerManifestVersion(v1, registrar());
    const v2: A01CapabilityManifest = {
      ...v1,
      version: '2',
      allowedOperations: [{ tool: 'test-tool', operation: 'do' }],
      maxDataClassification: 'INTERNAL',
    };
    const r2 = await world.store.registerManifestVersion(v2, registrar());
    assert.equal(r2.version, '2');
    assert.equal(r2.supersedes, r1.manifestId);
    const active = await world.store.getActiveManifest(capabilityId);
    assert.equal(active?.version, '2');
    const prior = await world.store.transact({ system: true }, async (collections) =>
      collections.manifests.get(manifestVersionId(capabilityId, '1')),
    );
    assert.equal(prior?.kind, 'manifest-version');
    if (prior?.kind === 'manifest-version') {
      assert.equal(prior.status, 'SUPERSEDED');
      assert.deepEqual(prior.manifest.allowedOperations.length, 2);
    }
  });

  it('rejects widening rotations (operation addition / ceiling raise)', async () => {
    const capabilityId = uniqueCapability('manifest.widen');
    await world.store.registerManifestVersion(durableManifest(capabilityId), registrar());
    const wider: A01CapabilityManifest = {
      ...durableManifest(capabilityId),
      version: '2',
      allowedOperations: [
        { tool: 'test-tool', operation: 'do' },
        { tool: 'test-tool', operation: 'escalate' },
      ],
    };
    await assert.rejects(
      () => world.store.registerManifestVersion(wider, registrar()),
      ManifestRejectedError,
    );
    const ceiling: A01CapabilityManifest = {
      ...durableManifest(capabilityId),
      version: '2',
      maxDataClassification: 'CONFIDENTIAL',
    };
    await assert.rejects(
      () => world.store.registerManifestVersion(ceiling, registrar()),
      ManifestRejectedError,
    );
    // The rejected rotations changed nothing.
    assert.equal((await world.store.getActiveManifest(capabilityId))?.version, '1');
  });

  it('rejects content changes under an existing version but tolerates byte-identical re-registration', async () => {
    const capabilityId = uniqueCapability('manifest.immutable');
    const m = durableManifest(capabilityId);
    const first = await world.store.registerManifestVersion(m, registrar());
    const again = await world.store.registerManifestVersion(
      durableManifest(capabilityId),
      registrar(),
    );
    assert.equal(again.manifestId, first.manifestId);
    const mutated: A01CapabilityManifest = { ...m, description: 'mutated after registration' };
    await assert.rejects(
      () => world.store.registerManifestVersion(mutated, registrar()),
      ManifestRejectedError,
    );
  });

  it('serializes concurrent rotations: exactly one winner, losers fail closed', async () => {
    const capabilityId = uniqueCapability('manifest.race');
    await world.store.registerManifestVersion(durableManifest(capabilityId), registrar());
    const base = durableManifest(capabilityId);
    const contenders: A01CapabilityManifest[] = [2, 3, 4, 5].map((n) => ({
      ...base,
      version: '2',
      description: `contender ${n}`,
      budgetPerRunCostUnits: base.budgetPerRunCostUnits - n,
    }));
    const results = await Promise.allSettled(
      contenders.map((m) => world.store.registerManifestVersion(m, registrar())),
    );
    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');
    assert.equal(winners.length, 1);
    assert.equal(losers.length, contenders.length - 1);
    for (const loser of losers) {
      assert.ok(loser.status === 'rejected' && loser.reason instanceof ManifestRejectedError);
    }
    assert.equal((await world.store.getActiveManifest(capabilityId))?.version, '2');
  });

  it('seeds unknown capabilities and no-ops on identical versions', async () => {
    const capabilityId = uniqueCapability('manifest.seed');
    const m = durableManifest(capabilityId);
    const [first] = await world.store.seedManifests([m], registrar());
    assert.equal(first?.version, '1');
    const [second] = await world.store.seedManifests([durableManifest(capabilityId)], registrar());
    assert.equal(second?.manifestId, first?.manifestId);
  });

  it('aborts boot on divergence: same version with different content', async () => {
    const capabilityId = uniqueCapability('manifest.diverge');
    await world.store.registerManifestVersion(durableManifest(capabilityId), registrar());
    const drifted: A01CapabilityManifest = {
      ...durableManifest(capabilityId),
      description: 'drifted composition',
    };
    await assert.rejects(
      () => world.store.seedManifests([drifted], registrar()),
      ManifestDivergenceError,
    );
  });

  it('aborts boot on unapproved version skew; an approved rotation seeds cleanly', async () => {
    const capabilityId = uniqueCapability('manifest.approval');
    const v1 = durableManifest(capabilityId);
    await world.store.registerManifestVersion(v1, registrar());
    const v2: A01CapabilityManifest = {
      ...v1,
      version: '2',
      budgetPerRunCostUnits: v1.budgetPerRunCostUnits - 1,
    };
    await assert.rejects(
      () => world.store.seedManifests([v2], registrar()),
      ManifestDivergenceError,
    );
    await world.store.approveRotation({
      capabilityId,
      version: '2',
      manifestDigest: manifestDigest(v2),
      approvedBy: { principalId: 'user:approver', authenticationEventId: 'evt-approve-1' },
      reason: 'r2-test rotation',
    });
    const [seeded] = await world.store.seedManifests([v2], registrar());
    assert.equal(seeded?.version, '2');
    // Conflicting approval for the same version is rejected; identical re-approval is idempotent.
    await assert.rejects(
      () =>
        world.store.approveRotation({
          capabilityId,
          version: '2',
          manifestDigest: '0'.repeat(64),
          approvedBy: { principalId: 'user:approver', authenticationEventId: 'evt-approve-2' },
          reason: 'conflict',
        }),
      ManifestRejectedError,
    );
    await world.store.approveRotation({
      capabilityId,
      version: '2',
      manifestDigest: manifestDigest(v2),
      approvedBy: { principalId: 'user:approver', authenticationEventId: 'evt-approve-1' },
      reason: 'r2-test rotation',
    });
  });
});
