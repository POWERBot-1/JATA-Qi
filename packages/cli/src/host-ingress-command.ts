// T-03 `jataqi host:enqueue` — the authenticated work-ingress command.
//
// This is the operator-facing half of the production ingress path. It is NOT a
// fake command that self-attests a principal: it presents a credential to the
// configured T-03 principal boundary and can only create work if that boundary
// verifies it.
//
// Two deliberate properties:
//
//   1. The AUTHENTICATION METHOD is never taken from the command line. It is
//      derived from the process's configured posture, so a caller cannot claim
//      a method the deployment did not configure. Only the credential MATERIAL
//      is supplied, and it is read from the environment (JATAQI_AUTH_TOKEN),
//      never from argv, so it does not land in process listings or shell
//      history.
//
//   2. When no authentication method is configured the command FAILS CLOSED and
//      prints the limitation. It never falls back to a test principal, a
//      SYSTEM actor, or a caller-supplied tenant.
//
// The command creates durable work and nothing else. It never starts the host,
// ticks, dispatches, resumes, approves, or settles — the unified 34-stage loop
// remains the sole execution orchestrator.

import type { PresentedCredential } from '@jataqi/authentication';
import { LoopHostModule, WorkIngressModule, type WorkIngressReceipt } from '@jataqi/loop-host';
import type { CommercialActorRole } from '@jataqi/commercial-control-plane';
import { createJataQiFromEnv } from './bootstrap.js';
import { resolveCliAuthentication } from './auth-config.js';

export interface HostEnqueueOptions {
  objective?: string;
  correlationId?: string;
  idempotencyKey?: string;
  tenantId?: string;
  requestedRoles?: CommercialActorRole[];
  knowledgeQuery?: string;
}

/** Parse `host:enqueue` flags. Unknown flags are rejected (fail closed). */
export function parseHostEnqueueArgs(args: readonly string[]): HostEnqueueOptions {
  const opts: HostEnqueueOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = (): string => {
      const next = args[++i];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${arg} requires a value.`);
      }
      return next;
    };
    switch (arg) {
      case '--objective':
        opts.objective = value();
        break;
      case '--correlation-id':
        opts.correlationId = value();
        break;
      case '--idempotency-key':
        opts.idempotencyKey = value();
        break;
      case '--tenant':
        opts.tenantId = value();
        break;
      case '--knowledge-query':
        opts.knowledgeQuery = value();
        break;
      case '--roles': {
        const raw = value();
        opts.requestedRoles = raw
          .split(',')
          .map((role) => role.trim())
          .filter((role) => role.length > 0) as CommercialActorRole[];
        if (opts.requestedRoles.length === 0) throw new Error('--roles requires at least one role.');
        break;
      }
      default:
        throw new Error(`Unknown option for "host:enqueue": ${arg}`);
    }
  }
  return opts;
}

/**
 * Map the configured posture to the credential method to present. The method
 * is a property of the DEPLOYMENT, not of the request.
 */
export function credentialForMode(
  mode: 'none' | 'static-token' | 'test-only',
  token: string | undefined,
): PresentedCredential {
  if (mode === 'none') {
    throw new Error(
      'No authentication method is configured (JATAQI_AUTH_MODE is unset or "none"), so no credential can be ' +
        'presented and no work can be created. Configure JATAQI_AUTH_MODE=static-token with an explicit ' +
        'JATAQI_AUTH_PRINCIPALS file, or embed JATA Qi and register your own ServerAuthenticator. Failing closed.',
    );
  }
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new Error(
      'JATAQI_AUTH_TOKEN is required: the credential material is read from the environment, never from the ' +
        'command line. Failing closed.',
    );
  }
  return {
    method: mode === 'test-only' ? 'DETERMINISTIC_TEST' : 'STATIC_TOKEN',
    material: token,
  };
}

/**
 * Run `host:enqueue`. Returns a process exit code. Prints a secret-free JSON
 * receipt on success; prints the rejection reason and exits non-zero otherwise,
 * with no work created.
 */
export async function runHostEnqueueCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  let opts: HostEnqueueOptions;
  try {
    opts = parseHostEnqueueArgs(args);
  } catch (error) {
    console.error(`host:enqueue: ${(error as Error).message}`);
    return 1;
  }

  // Resolve the credential BEFORE booting anything, so an unconfigured process
  // does no work at all.
  let credential: PresentedCredential;
  let modeDescription: string;
  let limitation: string | undefined;
  try {
    const resolved = resolveCliAuthentication(env);
    modeDescription = resolved.description;
    limitation = resolved.limitation;
    credential = credentialForMode(resolved.mode, env.JATAQI_AUTH_TOKEN);
  } catch (error) {
    console.error(`host:enqueue: ${(error as Error).message}`);
    return 1;
  }

  if (!opts.objective || opts.objective.trim().length === 0) {
    console.error('host:enqueue: --objective is required.');
    return 1;
  }

  let instance: Awaited<ReturnType<typeof createJataQiFromEnv>>;
  try {
    instance = await createJataQiFromEnv({ loopHost: { enabled: true } });
  } catch (error) {
    console.error(`host:enqueue: failed to boot (failing closed): ${(error as Error).message}`);
    return 1;
  }

  try {
    const ingress = instance.kernel.getModule<WorkIngressModule>('work-ingress').getService();
    const host = instance.kernel.getModule<LoopHostModule>('loop-host').getService();

    const receipt: WorkIngressReceipt = await ingress.submit(credential, {
      objective: opts.objective,
      ...(opts.knowledgeQuery ? { knowledgeQuery: opts.knowledgeQuery } : {}),
      ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      ...(opts.requestedRoles ? { requestedRoles: opts.requestedRoles } : {}),
    });

    log(
      JSON.stringify(
        {
          ok: true,
          note: 'Authenticated durable work created. Nothing was dispatched: the host dispatches it through the full 34-stage governed loop.',
          authenticationMode: modeDescription,
          hostLifecycle: receipt.hostLifecycle,
          hostId: host.getHostId(),
          receipt,
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    // Every rejection lands here with NO work created: authentication failure,
    // policy refusal, tenant mismatch, role widening, or persistence error.
    const err = error as Error;
    console.error(`host:enqueue: refused (no work created): ${err.name}: ${err.message}`);
    if (limitation) console.error(`host:enqueue: ${limitation}`);
    return 1;
  } finally {
    await instance.shutdown().catch(() => undefined);
  }
}
