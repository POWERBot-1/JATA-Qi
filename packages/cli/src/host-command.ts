// R-01 `jataqi host` — the supervised, unattended host process entry point.
//
// This is the mechanism that makes O-01 (operation-over-time host) and P-01
// (durable persistence substrate) actually reachable outside test code. It
// composes the existing kernel, asserts durable storage, runs boot-time crash
// recovery, then supervises WAKE -> ... -> SLEEP -> WAKE cycles until a signal.
//
// It introduces NO new stage, engine, policy, authority or side effect. Every
// dispatch re-enters the whole 34-stage governed unified loop unchanged.
//
// Durability honesty: this command requires a durable database but does not
// provision, back up, replicate or restore one. RPO and RTO are UNDEFINED.
// Backup/restore/PITR/replication/failover remain out of scope (see docs).

import type { KernelApi } from '@jataqi/core-kernel';
import { LoopHostModule, HostRuntime, type HostRuntimeConfig } from '@jataqi/loop-host';
import type { LoopHostService } from '@jataqi/loop-host';
import { CommercialEventStreamModule } from '@jataqi/commercial-event-stream';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import { StorageModule } from '@jataqi/storage';
import { createJataQiFromEnv } from './bootstrap.js';
import { redactConnectionString } from './storage-driver.js';

export interface HostCommandOptions {
  /** Bounded run for operators and acceptance tests. Undefined = until signal. */
  maxCycles?: number;
  /** Override the idle bounds between cycles. */
  minIdleMs?: number;
  maxIdleMs?: number;
  /** Local development escape hatch: permit a non-durable driver. */
  allowNonDurableStorage?: boolean;
  installSignalHandlers?: boolean;
  log?: (line: string) => void;
}

/** Parse `jataqi host` flags. Unknown flags are rejected (fail closed). */
export function parseHostArgs(args: readonly string[]): HostCommandOptions {
  const opts: HostCommandOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--max-cycles': {
        const value = Number(args[++i]);
        if (!Number.isInteger(value) || value < 1) throw new Error('--max-cycles requires a positive integer.');
        opts.maxCycles = value;
        break;
      }
      case '--min-idle-ms': {
        const value = Number(args[++i]);
        if (!Number.isFinite(value) || value < 0) throw new Error('--min-idle-ms requires a non-negative number.');
        opts.minIdleMs = value;
        break;
      }
      case '--max-idle-ms': {
        const value = Number(args[++i]);
        if (!Number.isFinite(value) || value < 0) throw new Error('--max-idle-ms requires a non-negative number.');
        opts.maxIdleMs = value;
        break;
      }
      case '--allow-non-durable-storage':
        opts.allowNonDurableStorage = true;
        break;
      default:
        throw new Error(`Unknown option for "jataqi host": ${arg}`);
    }
  }
  return opts;
}

/**
 * Build the startup banner. Credentials are ALWAYS redacted: this line is
 * written to operator logs.
 */
export function hostBanner(info: {
  hostId: string;
  driverId: string;
  connectionString?: string;
  minIdleMs: number;
  maxIdleMs: number;
}): string {
  return [
    'JATA Qi host runtime (R-01)',
    `  host id        : ${info.hostId}`,
    `  storage driver : ${info.driverId}`,
    `  database       : ${redactConnectionString(info.connectionString)}`,
    `  idle bounds    : ${info.minIdleMs}-${info.maxIdleMs} ms`,
    '  governance     : every dispatch re-enters the full 34-stage governed loop',
    '  delivery       : durable unified-outbox worker (T-05) runs one bounded pass per cycle; at-least-once + idempotent handlers',
    '  durability     : durable persistence only — no backup/restore/PITR/replication (RPO/RTO UNDEFINED)',
    '  side effects   : none activated by this process',
  ].join('\n');
}

/**
 * T-05: the supervised host process is also the cross-process delivery
 * worker. One bounded pass per cycle over EVERY tenant's durable outbox under
 * a server-derived system actor (`allTenants` requires the system role; the
 * worker never acts under an operator's tenant). Returns undefined when the
 * event-stream module is not composed (the host then only dispatches).
 */
export function buildDeliveryPump(kernel: Pick<KernelApi, 'getModule'>, hostId: string): HostRuntimeConfig['deliveryPump'] {
  let stream: CommercialEventStreamModule;
  try {
    stream = kernel.getModule<CommercialEventStreamModule>('commercial-event-stream');
  } catch {
    return undefined;
  }
  const service = stream.getService();
  const actor: CommercialActor = { id: `${hostId}:delivery-worker`, tenantId: 'system', roles: ['system'] };
  return async (now) => service.pump(actor, { now, allTenants: true, owner: hostId });
}

/**
 * Boot and supervise the host until a shutdown signal (or maxCycles).
 * Returns the process exit code: 0 on a clean drain, 1 on a startup failure.
 */
export async function runHostCommand(options: HostCommandOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));

  // Explicitly enable the host for this process only. This does NOT change the
  // library default (`loopHost.enabled` stays false for createJataQi()).
  // Printed before boot so a fail-closed startup still shows the operator what
  // was attempted (with credentials redacted).
  log(
    hostBanner({
      hostId: '(pending kernel boot)',
      driverId: process.env.STORAGE_DRIVER ?? 'memory',
      connectionString: process.env.JATAQI_PG_CONNECTION_STRING,
      minIdleMs: options.minIdleMs ?? 250,
      maxIdleMs: options.maxIdleMs ?? 30_000,
    }),
  );

  let instance: Awaited<ReturnType<typeof createJataQiFromEnv>>;
  try {
    instance = await createJataQiFromEnv({ loopHost: { enabled: true } });
  } catch (error) {
    console.error(`jataqi host: failed to boot (failing closed): ${(error as Error).message}`);
    return 1;
  }

  const { kernel } = instance;
  const driverId = kernel.getModule<StorageModule>('storage').getDriver().id;
  const hostModule = kernel.getModule<LoopHostModule>('loop-host');
  const host: LoopHostService = hostModule.getService();

  const runtimeConfig: HostRuntimeConfig = {
    requireDurableStorage: options.allowNonDurableStorage !== true,
    minIdleMs: options.minIdleMs,
    maxIdleMs: options.maxIdleMs,
    maxCycles: options.maxCycles,
    installSignalHandlers: options.installSignalHandlers ?? true,
    recoverOnBoot: true,
    deliveryPump: buildDeliveryPump(kernel, host.getHostId()),
  };
  const runtime = new HostRuntime(host, runtimeConfig);
  log(`jataqi host: kernel booted (hostId=${host.getHostId()}, storageDriver=${driverId}).`);

  try {
    await runtime.run(kernel);
  } catch (error) {
    // Includes NonDurableStorageError: refuse to run unattended on state we
    // would lose. Exit non-zero so a supervisor does not treat it as success.
    console.error(`jataqi host: ${(error as Error).message}`);
    await instance.shutdown().catch(() => undefined);
    return 1;
  }

  const cycles = runtime.getCycles();
  const recovery = runtime.getBootRecovery();
  const delivered = cycles.reduce((sum, cycle) => sum + (cycle.delivery?.delivered ?? 0), 0);
  const deadLettered = cycles.reduce((sum, cycle) => sum + (cycle.delivery?.deadLettered ?? 0), 0);
  log(
    `jataqi host: stopped cleanly after ${cycles.length} cycle(s)` +
      (recovery ? ` (boot recovery: reclaimed=${recovery.reclaimed} quarantined=${recovery.quarantined})` : '') +
      ` (delivery: delivered=${delivered} deadLettered=${deadLettered})`,
  );
  await instance.shutdown();
  return 0;
}
