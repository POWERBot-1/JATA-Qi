// Worker/queue boundary wrapper.
//
// Test/repair workers, copilot task graphs, and the venture factory are
// deterministic and perform NO external I/O today (see the invocation-boundary
// inventory in docs/A01_AUTHORIZATION_BOUNDARY.md). Before any future external
// I/O is introduced on those paths, the work must be executed through this
// wrapper with a sealed envelope: the gate re-verifies the envelope and
// consumes it (replay protection) before the task runs.
//
// The wrapper itself grants nothing. A worker that calls its own task
// function directly (bypassing the wrapper) obtains no envelope and no
// credential, and any credential-bound external call fails closed.

import type { AuthorizationGate, ScopedExecutionContext } from './gate.js';
import type { A01AuthorizationEnvelope } from './types.js';

/**
 * Execute one worker task under a sealed authorization envelope.
 * Throws `AuthorizationDeniedError` (before the task runs) when the envelope
 * is invalid, stale, replayed, or otherwise unauthorized.
 */
export async function runUnderEnvelope<T>(
  gate: AuthorizationGate,
  envelope: A01AuthorizationEnvelope,
  task: (scoped: ScopedExecutionContext) => Promise<T>,
  expected: { readonly tool: string; readonly operation: string; readonly targetResource?: string },
): Promise<T> {
  return gate.executeAuthorized(envelope, task, expected);
}

/**
 * A named worker task. The `tool`/`operation` pair must match the envelope
 * exactly, so a worker cannot be pointed at an envelope rendered for a
 * different task (operation substitution is denied at the gate).
 */
export class WorkerTask {
  readonly id: string;
  readonly tool: string;
  readonly operation: string;
  readonly targetResource?: string;
  constructor(
    config: {
      readonly id: string;
      readonly tool: string;
      readonly operation: string;
      readonly targetResource?: string;
    },
    private readonly task: (scoped: ScopedExecutionContext) => Promise<unknown>,
  ) {
    this.id = config.id;
    this.tool = config.tool;
    this.operation = config.operation;
    this.targetResource = config.targetResource;
  }

  async run<T>(gate: AuthorizationGate, envelope: A01AuthorizationEnvelope): Promise<T> {
    return runUnderEnvelope<T>(
      gate,
      envelope,
      (scoped) => this.task(scoped) as Promise<T>,
      { tool: this.tool, operation: this.operation, ...(this.targetResource !== undefined ? { targetResource: this.targetResource } : {}) },
    );
  }
}
