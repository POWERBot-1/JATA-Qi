// R-01 read-only operator inspection commands.
//
// These commands OBSERVE host state and nothing else. They never dispatch,
// tick, resume, retry, approve, settle, quarantine, or mutate any work item,
// lease, or checkpoint. Reading a row confers no authority: an operator who
// can see a HELD item still cannot release it from here.
//
// They read through the same tenant-scoped queue API the host uses, with an
// explicit operator actor, so tenant isolation is enforced exactly as it is on
// the dispatch path.

import { LoopHostModule, type HostedWorkStatus, type LoopHostService } from '@jataqi/loop-host';
import { StorageModule } from '@jataqi/storage';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import type { CommercialActor, CommercialActorRole } from '@jataqi/commercial-control-plane';
import { CommercialEventStreamModule } from '@jataqi/commercial-event-stream';
import { createJataQiFromEnv } from './bootstrap.js';
import { redactConnectionString } from './storage-driver.js';

const INSPECT_STATUSES: readonly HostedWorkStatus[] = [
  'QUEUED',
  'SLEEPING',
  'LEASED',
  'DISPATCHED',
  'COMPLETED',
  'HELD',
  'DENIED',
  'DLQ',
];

/**
 * Build the read-only inspection actor. Tenant comes from the operator's
 * environment; `global_admin` is only granted when explicitly requested, so the
 * default is a single-tenant read.
 */
function inspectActor(env: NodeJS.ProcessEnv): CommercialActor {
  const tenantId = env.JATAQI_OPERATOR_TENANT ?? 'default';
  const roles: CommercialActorRole[] =
    env.JATAQI_OPERATOR_GLOBAL_ADMIN === 'true' ? ['operator', 'global_admin'] : ['operator'];
  return { id: env.JATAQI_OPERATOR_ID ?? 'cli-operator', tenantId, roles };
}

/** Run one read-only host inspection command. Returns a process exit code. */
export type HostInspectCommand = 'host:work' | 'host:dlq' | 'host:health' | 'host:outbox' | 'host:inbox';

export async function runHostInspectCommand(
  cmd: HostInspectCommand,
  args: readonly string[],
  log: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  let instance: Awaited<ReturnType<typeof createJataQiFromEnv>>;
  try {
    instance = await createJataQiFromEnv({ loopHost: { enabled: true } });
  } catch (error) {
    console.error(`${cmd}: failed to boot (failing closed): ${(error as Error).message}`);
    return 1;
  }

  const { kernel } = instance;
  try {
    const driverId = kernel.getModule<StorageModule>('storage').getDriver().id;
    const host: LoopHostService = kernel.getModule<LoopHostModule>('loop-host').getService();
    const actor = inspectActor(process.env);

    const controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
    const stream = kernel.getModule<CommercialEventStreamModule>('commercial-event-stream').getService();

    if (cmd === 'host:health') {
      const nextWake = await host.nextWakeIn();
      // T-05 delivery health: read-only counts over the operator's own tenant.
      const outbox = await controlPlane.replayUnifiedOutbox(actor, {});
      const byState: Record<string, number> = {};
      for (const record of outbox) byState[record.state] = (byState[record.state] ?? 0) + 1;
      const deadLetters = await stream.listDeadLetters(actor);
      log(
        JSON.stringify(
          {
            hostId: host.getHostId(),
            lifecycle: host.getLifecycle(),
            storageDriver: driverId,
            durable: driverId !== 'memory' && driverId !== 'filesystem',
            database: redactConnectionString(process.env.JATAQI_PG_CONNECTION_STRING),
            nextWakeInMs: nextWake ?? null,
            delivery: {
              tenantId: actor.tenantId,
              handlers: stream.listHandlerIds(),
              outboxByState: byState,
              inboxDeadLetters: deadLetters.length,
              semantics: 'at-least-once + idempotent handlers (exactly-once is not claimed)',
            },
            note: 'read-only; durable persistence only — no backup/restore/DR (RPO/RTO undefined)',
          },
          null,
          2,
        ),
      );
      return 0;
    }

    if (cmd === 'host:outbox') {
      const requested = args[0];
      const states = requested ? [requested as never] : undefined;
      const records = await controlPlane.replayUnifiedOutbox(actor, { states, limit: 200 });
      for (const record of records) {
        log(
          `[${record.state}] seq=${record.sequence}\t${record.eventType}\tevent=${record.eventId}\tattempts=${record.attemptCount}` +
            `\tgeneration=${record.leaseGeneration ?? 0}\towner=${record.leaseOwner ?? '-'}\tnextAttemptAt=${record.nextAttemptAt ?? '-'}\terror=${record.lastError ?? '-'}`,
        );
      }
      log(`\n${records.length} outbox record(s) shown for tenant ${actor.tenantId}. Read-only: nothing was claimed, acked, or released.`);
      return 0;
    }

    if (cmd === 'host:inbox') {
      const requested = args[0];
      const rows = (await stream.listDeliveries(actor)).filter((row) => requested === undefined || row.state === requested);
      for (const row of rows.slice(0, 200)) {
        log(
          `[${row.state}] ${row.handlerId}\tevent=${row.eventId}\tseq=${row.eventSequence}\tattempts=${row.attemptCount}/${row.maxAttempts}` +
            `\tgeneration=${row.leaseGeneration ?? 0}\towner=${row.leaseOwner ?? '-'}\tnextAttemptAt=${row.nextAttemptAt ?? '-'}\terror=${row.lastError ?? '-'}`,
        );
      }
      log(`\n${Math.min(rows.length, 200)} inbox record(s) shown for tenant ${actor.tenantId}. Read-only: nothing was retried or acknowledged.`);
      return 0;
    }

    if (cmd === 'host:dlq') {
      const items = await host.list(actor, { status: 'DLQ', limit: 200 });
      for (const item of items) {
        log(`[DLQ] ${item.id}\ttenant=${item.tenantId}\tattempts=${item.attemptCount}/${item.maxAttempts}\treason=${item.dlqReason ?? item.lastError ?? 'n/a'}`);
      }
      log(`\n${items.length} dead-lettered item(s). Read-only: nothing was retried or released.`);
      return 0;
    }

    const requested = args[0];
    if (requested !== undefined && !INSPECT_STATUSES.includes(requested as HostedWorkStatus)) {
      console.error(`host:work: unknown status "${requested}". Known: ${INSPECT_STATUSES.join(', ')}`);
      return 1;
    }
    const items = await host.list(actor, {
      status: requested as HostedWorkStatus | undefined,
      limit: 200,
    });
    for (const item of items) {
      log(
        `[${item.status}] ${item.id}\ttenant=${item.tenantId}\tcorrelation=${item.correlationId}` +
          `\tattempts=${item.attemptCount}/${item.maxAttempts}\tavailableAt=${item.availableAt}`,
      );
    }
    log(`\n${items.length} item(s) shown. Read-only: nothing was dispatched or modified.`);
    return 0;
  } catch (error) {
    console.error(`${cmd}: ${(error as Error).message}`);
    return 1;
  } finally {
    await instance.shutdown().catch(() => undefined);
  }
}
