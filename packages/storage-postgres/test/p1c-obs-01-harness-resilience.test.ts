// P1C-OBS-01 — embedded-PostgreSQL harness resilience regression test.
//
// Locks in the classification decision that the remediation depends on. The
// direction of this classification is safety-critical in BOTH directions:
//
//   * transient misclassified as unavailable  => a boot race silently degrades a
//     real PostgreSQL integration suite into a trivially-passing "SKIPPED"
//     placeholder  => FALSE-NEGATIVE GREEN (the P1C-OBS-01 defect);
//   * genuine absence misclassified as transient => a machine without the
//     binaries fails instead of honestly skipping => FALSE-POSITIVE RED, and the
//     documented honest-skip contract in the harness header is broken.
//
// These assertions are deterministic and boot no PostgreSQL, so they run
// anywhere and cannot themselves flake.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientPgError, pgDiagnostics } from './pg-test-harness.js';

describe('P1C-OBS-01 embedded-PostgreSQL harness resilience', () => {
  it('classifies the readiness-race signatures as TRANSIENT (must be retried, never skipped)', () => {
    // The exact signature recorded in the historical incident: ECONNREFUSED at
    // driver init while the postmaster log line had already reported readiness.
    const transient: readonly string[] = [
      'connect ECONNREFUSED 127.0.0.1:55231',
      'Connection refused',
      'the server is not accepting connections',
      'could not connect to server',
      'the database system is starting up',
      'the database system is shutting down',
      'terminating connection due to administrator command',
      'server terminated unexpectedly',
    ];
    for (const message of transient) {
      assert.equal(
        isTransientPgError(new Error(message)),
        true,
        `expected TRANSIENT classification for: ${message}`,
      );
    }
  });

  it('reads the Node error `code` field, not only the message', () => {
    // `pg` surfaces ECONNREFUSED as a code on some paths where the message is
    // generic. Classification must not depend on the message alone.
    const error = new Error('connection attempt failed') as Error & { code?: string };
    error.code = 'ECONNREFUSED';
    assert.equal(isTransientPgError(error), true, 'code-based ECONNREFUSED must classify as transient');
  });

  it('classifies a GENUINE capability absence as NON-transient (preserves the honest skip)', () => {
    // A machine without the embedded-postgres binaries, or an unsupported
    // platform, must still be allowed to report unavailable and skip honestly —
    // the behaviour the harness header promises. Retrying these would be
    // pointless and, worse, would convert an honest skip into a hard failure.
    const nonTransient: readonly string[] = [
      'spawn initdb ENOENT',
      'Could not find PostgreSQL binaries for this platform',
      'unsupported platform: solaris',
      'permission denied while trying to create the data directory',
      'initdb: invalid locale settings',
    ];
    for (const message of nonTransient) {
      assert.equal(
        isTransientPgError(new Error(message)),
        false,
        `expected NON-transient classification for: ${message}`,
      );
    }
  });

  it('does not classify an empty or unknown error as transient', () => {
    // Fail toward the honest path on unrecognised input rather than inventing a
    // retry loop over an unknown fault.
    assert.equal(isTransientPgError(new Error('')), false);
    assert.equal(isTransientPgError(undefined), false);
    assert.equal(isTransientPgError('some unrelated failure'), false);
  });

  it('exposes a diagnostics record so a future failure is attributable from the job log', () => {
    // The CI detector and the readiness-diagnostics step read this shape. If the
    // fields disappear the CI step silently stops being able to attribute a
    // failure — which is exactly how G10 became unattributable.
    assert.equal(typeof pgDiagnostics.attempts, 'object');
    assert.equal(typeof pgDiagnostics.retries, 'object');
    assert.ok(
      ['STARTED', 'UNAVAILABLE', 'TRANSIENT_FAILURE', 'NOT_ATTEMPTED'].includes(pgDiagnostics.outcome),
      `unexpected diagnostics outcome: ${pgDiagnostics.outcome}`,
    );
  });

  it('distinguishes the two failure directions the defect could take', () => {
    // The whole remediation rests on these two cases NOT being treated alike.
    const race = new Error('connect ECONNREFUSED 127.0.0.1:55231');
    const absent = new Error('spawn initdb ENOENT');
    assert.notEqual(
      isTransientPgError(race),
      isTransientPgError(absent),
      'a readiness race and a missing-binary failure MUST classify differently',
    );
  });
});
