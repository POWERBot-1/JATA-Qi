// T-05 multi-process delivery worker (child OS process).
//
// A REAL separate Node process — not a second pool in the parent — running the
// production CommercialEventStreamService against one authoritative
// PostgreSQL. It is the evidence for cross-process lease ownership, hard
// fencing of stale owners, crash-mid-delivery recovery, and durable inbox
// idempotency across processes.
//
// Usage: node t05-delivery-worker.mjs <connectionString> <mode> <workerId> [arg]
//   mode=compete <eventType>
//       Register a durable handler for <eventType> that records every
//       invocation in the `t05.effects` collection (durable, idempotent by
//       `${eventId}:${workerId}`), pump once with allTenants, print the result.
//   mode=crash <eventType>
//       Claim (lease) outbox records for <eventType> then die HARD before any
//       handler effect or ack. Leaves LEASED rows with this worker as owner.
//   mode=crash-after-effect <eventType>
//       Register a handler whose effect is durably written, then the process
//       dies HARD after the effect but BEFORE the inbox settle / outbox ack.
//       Models "crash after side effect, before acknowledgement".
//   mode=stale-ack <leaseJson>
//       Attempt to ack / dead-letter / quarantine an outbox record using a
//       lease that was already re-claimed by another owner. Every attempt
//       must be refused by the durable fence.
//
// Output: one JSON line per event on stdout. No reasoning, no side effects
// beyond the test collections.

import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import { CommercialEventStreamModule } from '@jataqi/commercial-event-stream';

const [, , connectionString, mode, workerId, extra] = process.argv;

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

const SYSTEM = { id: `${workerId}:system`, tenantId: 'system', roles: ['system'] };

async function main() {
  const driver = new PostgresDriver({ connectionString, requireExplicitConfig: true, max: 4 });
  const kernel = createTestKernel();
  kernel.register(new StorageModule({ driverInstance: driver }));
  kernel.register(new CommercialControlPlaneModule({}));
  kernel.register(new CommercialEventStreamModule({ workerId, wakeOnPublish: false, leaseTtlMs: 1_500 }));
  await kernel.boot();
  const storage = kernel.getModule('storage');
  const control = kernel.getModule('commercial-control-plane').getService();
  const stream = kernel.getModule('commercial-event-stream').getService();
  const effects = await storage.collection('t05.effects');

  if (mode === 'compete' || mode === 'crash-after-effect') {
    const eventType = extra;
    let crashArmed = mode === 'crash-after-effect';
    stream.registerHandler(SYSTEM, {
      id: 't05.process-effect',
      eventTypes: [eventType],
      maxAttempts: 5,
      async handle(event) {
        // Durable, idempotent effect keyed by (event, worker): a redelivery
        // to the SAME worker after a crash overwrites the same row.
        const id = `${event.id}:${workerId}`;
        const current = await effects.get(id);
        await effects.put({ id, tenantId: event.tenantId, eventId: event.id, workerId, sequence: event.sequence, actor: event.actor, times: (current?.times ?? 0) + 1 });
        emit({ workerId, event: 'effect', eventId: event.id, tenantId: event.tenantId });
        if (crashArmed) {
          crashArmed = false;
          emit({ workerId, event: 'crashing-after-effect', eventId: event.id });
          // Hard kill: effect committed, inbox still CLAIMED, outbox still LEASED.
          process.exit(9);
        }
      },
    });
    const result = await stream.pump(SYSTEM, { allTenants: true, owner: workerId });
    emit({ workerId, event: 'pumped', result });
    await kernel.shutdown();
    await driver.close();
    process.exit(0);
  }

  if (mode === 'crash') {
    const eventType = extra;
    const outbox = control.getUnifiedOutbox();
    const claimed = await outbox.claim({ owner: workerId, now: Date.now(), leaseTtlMs: 1_500, limit: 10, eventTypes: [eventType] });
    emit({ workerId, event: 'leased-then-crashing', leases: claimed.map((c) => ({ recordId: c.lease.recordId, generation: c.lease.leaseGeneration })) });
    // Hard kill while holding the leases: no release, no ack, no cleanup.
    process.exit(9);
  }

  if (mode === 'stale-ack') {
    const lease = JSON.parse(extra);
    const outbox = control.getUnifiedOutbox();
    const now = Date.now();
    const acked = await outbox.ackLeased(lease, now);
    const deadLettered = await outbox.deadLetterLeased(lease, 'stale owner', now);
    const quarantined = await outbox.quarantineLeased(lease, 'stale owner', now);
    const retried = await outbox.scheduleRetry(lease, 'stale owner', now + 1_000, now);
    const released = await outbox.release(lease, now);
    emit({ workerId, event: 'stale-attempts', acked, deadLettered, quarantined, retried, released });
    await kernel.shutdown();
    await driver.close();
    process.exit(0);
  }

  emit({ workerId, event: 'unknown-mode', mode });
  process.exit(2);
}

main().catch((error) => {
  emit({ workerId, event: 'error', error: String(error?.stack ?? error) });
  process.exit(1);
});
