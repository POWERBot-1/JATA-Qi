// P2-S3 two-process first-elevation bootstrap race worker: a SEPARATE OS
// process that reopens the same PostgreSQL privileged access plane and
// attempts the one-time bootstrap elevation. No process-local state is
// shared with the parent — exactly one process may win the CAS insert-once.
// Prints one JSON line on stdout.
//
// Usage:
//   node p2-s3-bootstrap-worker.mjs <connectionString> <principalId> <tenantId> [scope]

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
import { PrivilegeStore } from '@jataqi/authentication';

const [connectionString, principalId, tenantId, scope] = process.argv.slice(2);

if (!connectionString || !principalId || !tenantId) {
  process.stdout.write(`${JSON.stringify({ ok: false, workerError: 'usage: <connectionString> <principalId> <tenantId> [scope]' })}\n`);
  process.exit(0);
} else {
  try {
    const driver = new PostgresDriver({ connectionString, requireExplicitConfig: true, max: 2 });
    const kernel = createTestKernel();
    const storage = new StorageModule({ driverInstance: driver });
    kernel.register(storage);
    await kernel.boot();
    const store = await PrivilegeStore.open(storage);
    await store.bootstrapFirstElevation(
      {
        principalId,
        tenantId,
        ...(scope === 'platform' ? { scope: 'platform' } : {}),
        reason: 'p2-s3 two-process bootstrap race (adversarial exactly-one-winner)',
        correlationId: 'p2-s3-bootstrap-race',
      },
      Date.now(),
    );
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
    process.exit(0);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        code: error?.code ?? error?.name ?? undefined,
        workerError: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exit(0);
  }
}
