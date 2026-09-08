// P1 (S6) — MANIFEST LIFETIME INVARIANT (R2-OBS-01 follow-up).
//
// The durable enforcement path deny-earlies freshness by the R2 skew bound
// (300 000 ms), so a manifest with maxLifetimeMs <= R2_SKEW_MS can NEVER
// execute durably — its envelope is expired the moment it is sealed. This is
// an availability/configuration risk, NOT a historical security bypass (the
// behavior always denied; it never allowed).
//
// The invariant: DURABLE registration (S-1) rejects such manifests
// fail-closed. The R1 in-memory registry is deliberately UNCHANGED (it has
// no skew-strict freshness; existing callers keep their exact semantics).
//
// Fail-hard: if PostgreSQL cannot start, before() rejects and the suite
// FAILS (no skip).

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CapabilityManifestRegistry,
  MIN_DURABLE_MANIFEST_LIFETIME_MS,
  R2_SKEW_MS,
  SecurityStateStore,
  type A01CapabilityManifest,
} from '../src/index.js';
import { bootR2Postgres, type R2Postgres } from './r2-pg.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { durableManifest, registrar, uniqueCapability } from './r2-fixtures.js';

let pg: R2Postgres;
let store: SecurityStateStore;

before(async () => {
  pg = await bootR2Postgres('p1-lifetime', 56400);
  const kernel = createTestKernel();
  const storage = new StorageModule({
    driverInstance: new (await import('@jataqi/storage-postgres')).PostgresDriver({
      connectionString: pg.connectionString,
      requireExplicitConfig: true,
      max: 4,
    }),
  });
  kernel.register(storage);
  await kernel.boot();
  store = await SecurityStateStore.open(storage);
});

after(async () => {
  if (pg) await pg.stop();
});

describe('P1 durable manifest lifetime floor (S6 — INV-13)', () => {
  it('exports the floor as exactly the R2 skew bound', () => {
    assert.equal(MIN_DURABLE_MANIFEST_LIFETIME_MS, R2_SKEW_MS);
    assert.equal(MIN_DURABLE_MANIFEST_LIFETIME_MS, 300_000);
  });

  it('REJECTS registration below the floor (below threshold)', async () => {
    const capabilityId = uniqueCapability('p1-below');
    await assert.rejects(
      () => store.registerManifestVersion(durableManifest(capabilityId, { maxLifetimeMs: 60_000 }), registrar()),
      /maxLifetimeMs \(60000\) must exceed the durable skew bound/,
    );
  });

  it('REJECTS registration exactly AT the floor (equal threshold)', async () => {
    const capabilityId = uniqueCapability('p1-equal');
    await assert.rejects(
      () => store.registerManifestVersion(durableManifest(capabilityId, { maxLifetimeMs: 300_000 }), registrar()),
      /must exceed the durable skew bound/,
    );
  });

  it('ACCEPTS registration one millisecond above the floor (boundary arithmetic)', async () => {
    const capabilityId = uniqueCapability('p1-above');
    const registered = await store.registerManifestVersion(
      durableManifest(capabilityId, { maxLifetimeMs: 300_001 }),
      registrar(),
    );
    assert.equal(registered.capabilityId, capabilityId);
    // and it is readable as ACTIVE afterwards (read path does not throw).
    const active = await store.getActiveManifest(capabilityId);
    assert.ok(active);
    assert.equal(active?.manifest.maxLifetimeMs, 300_001);
  });

  it('REJECTS malformed lifetimes with the existing shape errors', async () => {
    const capabilityId = uniqueCapability('p1-malformed');
    await assert.rejects(
      () => store.registerManifestVersion(durableManifest(capabilityId, { maxLifetimeMs: 0 }), registrar()),
      /maxLifetimeMs must be a positive number/,
    );
    await assert.rejects(
      () => store.registerManifestVersion(durableManifest(capabilityId, { maxLifetimeMs: -1 }), registrar()),
      /maxLifetimeMs must be a positive number/,
    );
    await assert.rejects(
      () => store.registerManifestVersion(durableManifest(capabilityId, { maxLifetimeMs: Number.NaN }), registrar()),
      /maxLifetimeMs must be a positive number/,
    );
  });

  it('REJECTS floor-violating seeds at boot (seedManifests path)', async () => {
    const capabilityId = uniqueCapability('p1-seed');
    await assert.rejects(
      () => store.seedManifests([durableManifest(capabilityId, { maxLifetimeMs: 30_000 })], registrar()),
      /must exceed the durable skew bound/,
    );
  });

  it('CONCURRENT floor-violating registrations are all rejected (no winner)', async () => {
    const capabilityId = uniqueCapability('p1-concurrent');
    const manifest = durableManifest(capabilityId, { maxLifetimeMs: 45_000 });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, () => store.registerManifestVersion(manifest, registrar())),
    );
    assert.ok(outcomes.every((o) => o.status === 'rejected'), 'every contender must be rejected');
    const active = await store.getActiveManifest(capabilityId);
    assert.equal(active, undefined, 'nothing may become ACTIVE');
  });

  it('RESTART semantics: a valid (above-floor) manifest reloads as ACTIVE after a fresh open', async () => {
    const capabilityId = uniqueCapability('p1-restart');
    await store.registerManifestVersion(durableManifest(capabilityId, { maxLifetimeMs: 3_600_000 }), registrar());
    // A fresh open over the same database is the restart equivalent (R2
    // multiprocess/restart suites prove the real thing; here we prove the
    // floor never breaks legitimate reloads).
    const kernel2 = createTestKernel();
    const storage2 = new StorageModule({
      driverInstance: new (await import('@jataqi/storage-postgres')).PostgresDriver({
        connectionString: pg.connectionString,
        requireExplicitConfig: true,
        max: 2,
      }),
    });
    kernel2.register(storage2);
    await kernel2.boot();
    const store2 = await SecurityStateStore.open(storage2);
    const active = await store2.listActiveManifests();
    const found = active.find((m) => m.capabilityId === capabilityId);
    assert.ok(found, 'above-floor manifest survives reopen');
    // And a floor-violating row written by other means would fail the read
    // path fail-closed (defensive: simulate by checking the exported guard).
    const badManifest = durableManifest(uniqueCapability('p1-never'), { maxLifetimeMs: 1_000 }) as A01CapabilityManifest;
    const { assertDurableManifestLifetime } = await import('../src/index.js');
    assert.throws(() => assertDurableManifestLifetime(badManifest), /must exceed the durable skew bound/);
  });

  it('R1 REGRESSION: the in-memory registry still accepts short lifetimes (unchanged semantics)', () => {
    const registry = new CapabilityManifestRegistry();
    const manifest = durableManifest(uniqueCapability('p1-r1'), { maxLifetimeMs: 60_000 }) as A01CapabilityManifest;
    // The R1 registry has no skew-strict freshness; kernel-worker manifests
    // (60s default) and existing tests keep their exact behavior.
    registry.register(manifest);
    assert.ok(registry.get(manifest.capabilityId, manifest.version));
  });
});
