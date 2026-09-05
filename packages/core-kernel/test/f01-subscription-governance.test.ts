import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditSubscriptionCoverage,
  F01_NOMINATED_SUBSCRIPTIONS,
  isNominatedSubscription,
  type NominatedSubscription,
} from '../src/index.js';

// F-01e (C-4 carried forward): the in-repo subscription inventory. Every
// bus.on subscription in the workspace must appear here through nomination;
// new consumers require a reviewed nomination, enforced by this test.
// T-05: billing / revenue-ledger / commercial-memory consume their topics as
// durable unified-outbox handlers (no bus subscription); the delivery worker
// holds the single post-commit wake-up subscription on commercial.event.recorded.
const IN_REPO_INVENTORY: readonly NominatedSubscription[] = [
  { package: '@jataqi/billing', topic: 'payment.verified' },
  { package: '@jataqi/billing', topic: 'payment.refund.verified' },
  { package: '@jataqi/revenue-ledger', topic: 'billing.invoice.paid' },
  { package: '@jataqi/revenue-ledger', topic: 'billing.invoice.refunded' },
  { package: '@jataqi/commercial-memory', topic: 'commercial.*' },
  { package: '@jataqi/commercial-memory', topic: 'payment.verified' },
  { package: '@jataqi/commercial-memory', topic: 'payment.refund.verified' },
  { package: '@jataqi/commercial-memory', topic: 'billing.invoice.paid' },
  { package: '@jataqi/commercial-memory', topic: 'billing.invoice.refunded' },
  { package: '@jataqi/commercial-observability', topic: 'commercial.event.recorded' },
  { package: '@jataqi/commercial-event-stream', topic: 'commercial.event.recorded' },
  { package: '@jataqi/knowledge-graph', topic: 'knowledge.document.ingested' },
  { package: '@jataqi/core-kernel', topic: 'kernel.*' },
];

describe('F-01e subscription nomination governance', () => {
  it('nominates every in-repo subscription and flags unknown consumers', () => {
    const { nominated, unnominated } = auditSubscriptionCoverage(IN_REPO_INVENTORY);
    assert.equal(nominated.length, IN_REPO_INVENTORY.length);
    assert.deepEqual(unnominated, []);
    assert.ok(F01_NOMINATED_SUBSCRIPTIONS.length > 0);
  });

  it('matches namespaces but rejects unrelated topics and packages', () => {
    assert.equal(isNominatedSubscription('@jataqi/commercial-memory', 'commercial.decision.proposed'), true);
    assert.equal(isNominatedSubscription('@jataqi/billing', 'payment.verified'), true);
    assert.equal(isNominatedSubscription('@jataqi/billing', 'payment.something.else'), false);
    assert.equal(isNominatedSubscription('@jataqi/billing', 'commercial.event.recorded'), false);
    assert.equal(isNominatedSubscription('@jataqi/unknown-package', 'payment.verified'), false);
  });

  it('reports a would-be new wildcard consumer as unnominated', () => {
    const { unnominated } = auditSubscriptionCoverage([
      ...IN_REPO_INVENTORY,
      { package: '@jataqi/some-package', topic: 'commercial.*' },
    ]);
    assert.equal(unnominated.length, 1);
    assert.equal(unnominated[0]?.package, '@jataqi/some-package');
  });
});
