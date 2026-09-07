// T-07 multi-process finalization worker (real PostgreSQL).
//
// Modes (env WORKER_MODE):
//   verify  — boot the full commercial stack, then call the production
//             `verifyPayment` path for PAYMENT_ID. Two such workers racing on
//             one SUCCEEDED_UNVERIFIED payment prove AC-1: exactly one
//             VERIFIED finalization + one event (CAS + stable anchor), both
//             callers observe the same final state.
//   refund  — boot the full commercial stack, then call the production
//             `requestRefund` path for PAYMENT_ID with DECISION_ID. Two such
//             workers racing on one VERIFIED payment prove AC-2: the CAS
//             reservation admits exactly one winner (REFUND_UNVERIFIED) and
//             the loser fails closed before planning or provider execution.
//
// The parent test boots embedded PostgreSQL and a setup kernel; workers join
// the same database over TCP. Results (JSON) are written to OUT; exit 0 on
// completion (including expected fail-closed outcomes, reported in-band).
//
// PostgreSQL is a hard requirement; the parent test boots it.

import { writeFileSync } from 'node:fs';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
// R1 (§6): forked worker processes install the REAL A-01 boundary too.
import { AuthorizationBoundaryModule } from '@jataqi/authorization-boundary';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import { PaymentsModule } from '@jataqi/payments';

const cs = process.env.JATAQI_TEST_PG_CS;
if (!cs) {
  console.error('JATAQI_TEST_PG_CS is required');
  process.exit(2);
}
const mode = process.env.WORKER_MODE ?? 'verify';
const workerId = process.env.WORKER_ID ?? 'w0';
const paymentId = process.env.PAYMENT_ID ?? '';
const decisionId = process.env.DECISION_ID ?? '';
const outFile = process.env.OUT;

const providerId = 't07-sandbox-provider';
let providerCalls = 0;

async function main() {
  const driver = new PostgresDriver({ connectionString: cs, requireExplicitConfig: true, max: 8 });
  const kernel = createTestKernel();
  kernel.register(new StorageModule({ driverInstance: driver }));
  kernel.register(new CommercialControlPlaneModule());
  kernel.register(new AuthorizationBoundaryModule());
  kernel.register(new AutonomousActionRuntimeModule());
  kernel.register(new PaymentsModule());
  await kernel.boot();
  try {
    const payments = kernel.getModule('payments').getService();
    const control = kernel.getModule('commercial-control-plane').getService();
    const actor = { id: workerId, tenantId: 'acme', roles: ['operator'] };
    payments.registerProvider({ id: 'admin', tenantId: 'acme', roles: ['admin'] }, {
      id: providerId,
      currencies: ['KES'],
      supportsRefunds: true,
      environment: 'sandbox',
      async createPayment() { providerCalls += 1; return { reportedSuccess: true, providerStatus: 'SUCCEEDED', providerReference: `t07-pay-${workerId}` }; },
      async verifyPayment(context) {
        providerCalls += 1;
        return { verified: true, providerStatus: 'SUCCEEDED', providerReference: `t07-pay-${workerId}`, observedAmount: context.payment.amount, evidence: [{ id: `t07-verify-${workerId}`, status: 'MEASURED', source: 't07-worker', observedAt: Date.now(), confidence: 95, summary: 'T-07 worker provider verification.', provenance: { source: 't07-worker', collectedAt: Date.now(), correlationId: `t07-${workerId}` } }] };
      },
      async refundPayment() { providerCalls += 1; return { reportedSuccess: true, providerStatus: 'REFUNDED', providerReference: `t07-refund-${workerId}` }; },
    });
    let outcome;
    if (mode === 'verify') {
      outcome = await payments.verifyPayment(actor, paymentId);
      writeOut({ mode, workerId, ok: true, status: outcome.status });
    } else if (mode === 'refund') {
      try {
        outcome = await payments.requestRefund(actor, paymentId, { decisionId, idempotencyKey: `t07-refund-action-${workerId}`, dryRun: false, reason: `Concurrent T-07 refund (${workerId}).` });
        writeOut({ mode, workerId, ok: true, status: outcome.status, providerCalls });
      } catch (error) {
        // Expected for the losing racer: fail-closed before any provider call.
        writeOut({ mode, workerId, ok: false, error: String((error instanceof Error ? error.message : error)), providerCalls });
      }
    } else {
      throw new Error(`unknown WORKER_MODE ${mode}`);
    }
    // Quiesce the publish path before shutdown (best effort; parent drains anyway).
    void control;
  } finally {
    await kernel.shutdown().catch(() => undefined);
    await driver.close().catch(() => undefined);
  }
}

function writeOut(payload) {
  if (outFile) writeFileSync(outFile, JSON.stringify(payload));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
