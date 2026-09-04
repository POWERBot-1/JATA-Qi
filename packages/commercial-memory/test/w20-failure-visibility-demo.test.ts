/**
 * TEMPORARY W20 FAILURE-VISIBILITY DEMONSTRATION (audit finding F-02).
 *
 * This file intentionally fails. Its sole purpose is to prove that the
 * hardened workspace runner (1) continues executing downstream suites after
 * this suite fails, (2) records the failure in the aggregated summary, and
 * (3) exits non-zero at the end. It is committed as a demonstration artifact
 * and reverted immediately after evidence capture; the final W20 tree must
 * not contain it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

test('W20 demo: intentional failure to prove downstream suites are not masked', () => {
  assert.equal(
    'FAIL',
    'PASS',
    'Intentional W20 failure-visibility demonstration; this fixture is reverted after evidence capture.',
  );
});
