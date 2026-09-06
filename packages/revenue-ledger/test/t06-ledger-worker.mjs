// T-06 multi-process revenue-ledger worker (real PostgreSQL).
//
// Modes (env WORKER_MODE):
//   append  — boot the full commercial stack and append `COUNT` cost entries
//             for `TENANT` via the production `recordCost` path (each append
//             is its own tenant-bound composed write with a CAS sequence
//             allocation). Results (id/sequence/hash/previousHash) are
//             written to OUT as JSON.
//   crash   — boot storage only, open the LEDGER's own composed-write path
//             (tenant-bound atomically + CAS counter on revenue-ledger.entries
//             / revenue-ledger.entries-seq), put ONE entry, then write the
//             sentinel file and sleep — the parent SIGKILLs the process while
//             the transaction is still open, simulating a crash mid-write.
//   idem    — re-run the durable-handler dedupe guard (sourceEventId lookup)
//             for SOURCE_EVENT against an already-seeded entry and append only
//             when absent (must yield NO second entry).
//
// PostgreSQL is a hard requirement; the parent test boots it.

import { writeFileSync } from 'node:fs';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import { CommercialEventStreamModule } from '@jataqi/commercial-event-stream';
import { BillingModule } from '@jataqi/billing';
import { PaymentsModule } from '@jataqi/payments';
import { RevenueLedgerModule } from '@jataqi/revenue-ledger';

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
  kernel.register(new AutonomousActionRuntimeModule());
  kernel.register(new PaymentsModule());
  kernel.register(new CommercialEventStreamModule());
  kernel.register(new BillingModule());
  kernel.register(new RevenueLedgerModule());
  await kernel.boot();
  return { kernel, driver };
}

async function bootStorageOnly() {
  const driver = new PostgresDriver({ connectionString: cs, requireExplicitConfig: true, max: 8 });
  const kernel = createTestKernel();
  kernel.register(new StorageModule({ driverInstance: driver }));
  await kernel.boot();
  const storage = kernel.getModule('storage');
  return { kernel, driver, storage };
}

function evidence(i) {
  const now = Date.now();
  return [{
    id: `ev-${workerId}-${i}`,
    status: 'MEASURED',
    source: 't06-multiprocess-worker',
    observedAt: now,
    confidence: 95,
    summary: `Concurrent ledger evidence ${i} from ${workerId}.`,
    provenance: { source: 't06-multiprocess-worker', collectedAt: now, correlationId: `c-${workerId}-${i}` },
  }];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  if (mode === 'append') {
    const count = Number(process.env.COUNT ?? '10');
    const { kernel, driver } = await bootFull();
    const module = kernel.getModule('revenue-ledger');
    const ledger = module.getService();
    const actor = { id: `worker-${workerId}`, tenantId: tenant, roles: ['operator'] };
    const results = [];
    for (let i = 0; i < count; i += 1) {
      const entry = await ledger.recordCost(actor, {
        productId: `product-${workerId}`,
        amount: { amount: i + 1, currency: 'KES' },
        category: 'AI',
        evidence: evidence(i),
        notes: `worker ${workerId} entry ${i}`,
      });
      results.push({ id: entry.id, tenantId: entry.tenantId, sequence: entry.sequence, hash: entry.hash, previousHash: entry.previousHash });
    }
    if (outFile) writeFileSync(outFile, JSON.stringify(results));
    await kernel.shutdown().catch(() => undefined);
    await driver.close().catch(() => undefined);
    process.exit(0);
  }

  if (mode === 'crash') {
    const { kernel, driver, storage } = await bootStorageOnly();
    const sentinel = process.env.SENTINEL;
    await storage.atomically(async (scope) => {
      const entries = await scope.collection('revenue-ledger.entries');
      const seq = await scope.collection('revenue-ledger.entries-seq');
      // The ledger's exact CAS-counter allocation shape, inside ONE tx.
      const counterId = `seq:${tenant}`;
      for (let attempt = 0; attempt < 64; attempt += 1) {
        const cur = await seq.get(counterId);
        const observed = cur ?? { id: counterId, tenantId: tenant, sequence: 0 };
        const next = { id: counterId, tenantId: tenant, sequence: observed.sequence + 1 };
        const res = await seq.cas(counterId, (c) => (c?.sequence ?? 0) === observed.sequence, () => next);
        if (res.ok) {
          const now = Date.now();
          const draft = {
            id: `crash-${workerId}-${next.sequence}`,
            tenantId: tenant,
            entryType: 'COST',
            recognitionStatus: 'RECOGNIZED',
            amount: { amount: 1, currency: 'KES' },
            costCategory: 'AI',
            sequence: next.sequence,
            previousHash: 'GENESIS',
            createdAt: now,
            sourceEventId: `crash-${workerId}`,
            evidence: evidence(0),
            notes: 'crash worker uncommitted entry',
          };
          await entries.put(draft);
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
