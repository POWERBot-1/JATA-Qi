// Lifecycle state-machine tests — phase computation + grace periods.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GracePeriods, addYears, recomputePhase, refreshPhase, renew, restore, softDelete, LifecycleError,
} from '../src/index.js';
import type { DomainObject } from '../src/index.js';

function mk(expiresAt: number): DomainObject {
  return {
    name: 'example.jq.', tld: '.jq', registrarId: 'reg1', creatingRegistrarId: 'reg1',
    registrant: 'c1', contacts: [], nameservers: ['ns1.example.jq.'], authInfoHash: 'x',
    statuses: new Set(['ok']), phase: 'active', createdAt: 0, expiresAt, updatedAt: 0,
    dsRecords: [], transfers: [],
  };
}

describe('lifecycle — phase computation', () => {
  it('active before expiry', () => {
    assert.equal(recomputePhase(mk(Date.now() + 86400_000)), 'active');
  });

  it('auto-renew-grace immediately after expiry', () => {
    const d = mk(Date.now() - 1000);
    assert.equal(recomputePhase(d), 'auto-renew-grace');
  });

  it('redemption-grace after ARGP', () => {
    const d = mk(Date.now() - GracePeriods.autoRenew - 1000);
    assert.equal(recomputePhase(d), 'redemption-grace');
  });

  it('pending-delete after RGP', () => {
    const d = mk(Date.now() - GracePeriods.autoRenew - GracePeriods.redemption - 1000);
    assert.equal(recomputePhase(d), 'pending-delete');
  });

  it('released after pending-delete window', () => {
    const d = mk(Date.now() - GracePeriods.autoRenew - GracePeriods.redemption - GracePeriods.pendingDelete - 1000);
    assert.equal(recomputePhase(d), 'released');
  });
});

describe('lifecycle — transitions', () => {
  it('renew extends expiry from the later of now/current expiry', () => {
    const now = Date.now();
    const d = renew(mk(now - 1000), 2, now);
    assert.ok(d.expiresAt >= addYears(now, 2) - 1000);
  });

  it('renew respects renew-prohibited', () => {
    const d = mk(Date.now() + 86400_000);
    d.statuses.add('serverRenewProhibited');
    assert.throws(() => renew(d, 1), LifecycleError);
  });

  it('restore pulls a grace domain back to active', () => {
    const now = Date.now();
    const d = mk(now - GracePeriods.autoRenew - 1000); // redemption-grace
    refreshPhase(d, now);
    restore(d, now);
    assert.equal(d.phase, 'active');
  });

  it('softDelete moves a domain into redemption grace', () => {
    const now = Date.now();
    const d = mk(now + 86400_000);
    softDelete(d, now);
    assert.equal(d.phase, 'redemption-grace');
  });

  it('softDelete respects delete-prohibited', () => {
    const d = mk(Date.now() + 86400_000);
    d.statuses.add('serverDeleteProhibited');
    assert.throws(() => softDelete(d), LifecycleError);
  });
});
