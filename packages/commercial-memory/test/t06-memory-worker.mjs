// T-06 multi-process commercial-memory worker (real PostgreSQL).
//
// Modes (env WORKER_MODE):
//   append — boot the commercial stack and append `COUNT` memory records for
//            `TENANT` via the production `record` path (each record is its
//            own tenant-bound composed write with a CAS sequence allocation).
//            Results (id/sequence/hash/previousHash) are written to OUT.
//   crash  — boot storage only, open the memory service's composed-write path
//            (tenant-bound atomically + CAS counter on
//            commercial-memory.records / commercial-memory.records-seq), put
//            ONE record, then write SENTINEL and sleep — the parent SIGKILLs
//            the process mid-transaction.
//
// PostgreSQL is a hard requirement; the parent test boots it.

import { writeFileSync } from 'node:fs';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import { CommercialEventStreamModule } from '@jataqi/commercial-event-stream';
import { CommercialMemoryModule } from '@jataqi/commercial-memory';

const cs = process.env.JATAQI_TEST_PG_CS;
if (!cs) {
  console.error('JATAQI_TEST_PG_CS is required');
  process.exit(2);
}
const mode = process.env.WORKER_MODE ?? 'append';
const tenant = process.env.TENANT ?? 'acme';
const workerId = process.env.WORKER_ID ?? 'w0';
const outFile = process.env.OUT;

async function bootFull() {
  const driver = new PostgresDriver({ connectionString: cs, requireExplicitConfig: true, max: 8 });
  const kernel = createTestKernel();
  kernel.register(new StorageModule({ driverInstance: driver }));
  kernel.register(new CommercialControlPlaneModule());
  kernel.register(new CommercialEventStreamModule());
  kernel.register(new CommercialMemoryModule());
  await kernel.boot();
  return { kernel, driver };
}

async function bootStorageOnly() {
  const driver = new PostgresDriver({ connectionString: cs, requireExplicitConfig: true, max: 8 });
  const kernel = createTestKernel();
  kernel.register(new StorageModule({ driverInstance: driver }));
  await kernel.boot();
  return { kernel, driver };
}

function evidence(i) {
  const now = Date.now();
  return [{
    id: `ev-${workerId}-${i}`,
    status: 'MEASURED',
    source: 't06-memory-worker',
    observedAt: now,
    confidence: 100,
    summary: `Concurrent memory evidence ${i} from ${workerId}.`,
    provenance: { source: 't06-memory-worker', collectedAt: now },
  }];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  if (mode === 'append') {
    const count = Number(process.env.COUNT ?? '10');
    const { kernel, driver } = await bootFull();
    const module = kernel.getModule('commercial-memory');
    const memory = module.getService();
    const actor = { id: `worker-${workerId}`, tenantId: tenant, roles: ['operator'] };
    const results = [];
    for (let i = 0; i < count; i += 1) {
      const rec = await memory.record(actor, {
        kind: 'PROHIBITED_STRATEGY',
        productId: `product-${workerId}`,
        title: `Worker ${workerId} record ${i}`,
        summary: `Concurrent memory record ${i} from worker ${workerId}.`,
        tags: ['t06-concurrency', workerId],
        evidence: evidence(i),
        confidence: 100,
        provenance: { source: 't06-memory-worker', collectedAt: Date.now() },
        reusable: true,
      });
      results.push({ id: rec.id, tenantId: rec.tenantId, sequence: rec.sequence, hash: rec.hash, previousHash: rec.previousHash });
    }
    if (outFile) writeFileSync(outFile, JSON.stringify(results));
    await kernel.shutdown().catch(() => undefined);
    await driver.close().catch(() => undefined);
    process.exit(0);
  }

  if (mode === 'crash') {
    const { kernel, driver } = await bootStorageOnly();
    const sentinel = process.env.SENTINEL;
    const storage = kernel.getModule('storage');
    await storage.atomically(async (scope) => {
      const records = await scope.collection('commercial-memory.records');
      const seq = await scope.collection('commercial-memory.records-seq');
      // The memory service's exact CAS-counter allocation shape, inside ONE tx.
      const counterId = `seq:${tenant}`;
      for (let attempt = 0; attempt < 64; attempt += 1) {
        const cur = await seq.get(counterId);
        const observed = cur ?? { id: counterId, tenantId: tenant, sequence: 0 };
        const next = { id: counterId, tenantId: tenant, sequence: observed.sequence + 1 };
        const res = await seq.cas(counterId, (c) => (c?.sequence ?? 0) === observed.sequence, () => next);
        if (res.ok) {
          const draft = {
            id: `crash-${workerId}-${next.sequence}`,
            tenantId: tenant,
            kind: 'RAW_EVENT',
            title: 'crash record',
            summary: 'uncommitted',
            tags: ['crash'],
            evidence: evidence(0),
            confidence: 100,
            provenance: { source: 't06-memory-worker', collectedAt: Date.now() },
            reusable: false,
            sequence: next.sequence,
            previousHash: 'GENESIS',
            createdAt: Date.now(),
          };
          await records.put(draft);
          if (sentinel) writeFileSync(sentinel, JSON.stringify({ sequence: next.sequence, inTx: true }));
          await sleep(120_000); // hold the transaction open until SIGKILL
          return;
        }
      }
      throw new Error('crash worker: counter CAS did not converge');
    });
    await kernel.shutdown().catch(() => undefined);
    await driver.close().catch(() => undefined);
    process.exit(0);
  }

  console.error(`unknown WORKER_MODE ${mode}`);
  process.exit(2);
} catch (error) {
  console.error('worker failed:', error);
  process.exit(1);
}
