// R2 two-process contention worker: a SEPARATE OS process that reopens the
// same PostgreSQL security state and either decides or executes. No
// process-local security state is shared with the parent — every verdict
// below comes from the durable store. Prints one JSON line on stdout.
//
// Usage:
//   node r2-two-process-worker.mjs decide <connectionString> <base64Request>
//   node r2-two-process-worker.mjs execute <connectionString> <base64Envelope>

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
import {
  AuthorizationGate,
  DurableCredentialBroker,
  InMemoryAuditSink,
  InMemoryCredentialMaterialProvider,
  SecurityStateStore,
} from '@jataqi/authorization-boundary';

const [mode, connectionString, payloadB64] = process.argv.slice(2);

function fail(message) {
  process.stdout.write(`${JSON.stringify({ ok: false, workerError: String(message) })}\n`);
  process.exit(0);
}

if ((mode !== 'decide' && mode !== 'execute') || !connectionString || !payloadB64) {
  fail('usage: decide|execute <connectionString> <base64Payload>');
} else {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    fail('payload is not base64url JSON');
  }
  if (payload !== undefined) {
    try {
      const driver = new PostgresDriver({ connectionString, requireExplicitConfig: true, max: 2 });
      const kernel = createTestKernel();
      const storage = new StorageModule({ driverInstance: driver });
      kernel.register(storage);
      await kernel.boot();
      const store = await SecurityStateStore.open(storage);
      const broker = new DurableCredentialBroker(store, new InMemoryCredentialMaterialProvider());
      const gate = new AuthorizationGate({ store, durableBroker: broker, audit: new InMemoryAuditSink() });
      if (mode === 'decide') {
        const envelope = await gate.decideAsync(payload);
        process.stdout.write(
          `${JSON.stringify({ ok: true, decision: envelope.decision.decision, reasonCodes: [...envelope.decision.reasonCodes] })}\n`,
        );
      } else {
        const result = await gate.executeAuthorized(payload, async () => 'worker-ok', {
          tool: payload.tool,
          operation: payload.operation,
        });
        process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
      }
      process.exit(0);
    } catch (error) {
      const reasons = Array.isArray(error?.reasons) ? error.reasons : undefined;
      process.stdout.write(
        `${JSON.stringify({ ok: false, ...(reasons ? { reasonCodes: reasons } : {}), workerError: error instanceof Error ? error.message : String(error) })}\n`,
      );
      process.exit(0);
    }
  }
}
