// Digital Memory Engine tests — normalization, tenant isolation, search,
// versioning, governance (policy/consent/retention), and privacy operations.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DigitalMemoryEngine, tokenize } from '../src/index.js';

describe('DigitalMemoryEngine — record & normalize', () => {
  it('records an event with normalized fields and a content hash', () => {
    const e = new DigitalMemoryEngine();
    const r = e.record({ category: 'prompt', summary: 'How do I reset my password?', orgId: 'org-1', userId: 'u1', tags: ['support'] });
    assert.equal(r.recorded, true);
    assert.ok(r.event!.id);
    assert.equal(r.event!.category, 'prompt');
    assert.equal(r.event!.orgId, 'org-1');
    assert.equal(r.event!.sensitivity, 'internal');
    assert.equal(r.event!.version, 1);
    assert.equal(r.event!.hash.length, 64);
    assert.ok(r.event!.tokens.includes('password'));
    assert.ok(r.event!.tokens.includes('reset'));
  });

  it('get retrieves by id', () => {
    const e = new DigitalMemoryEngine();
    const { event } = e.record({ category: 'command', summary: 'deploy app' });
    assert.ok(e.get(event!.id));
  });
});

describe('DigitalMemoryEngine — tenant isolation', () => {
  it('queries are org-scoped; cross-tenant events are invisible', () => {
    const e = new DigitalMemoryEngine();
    e.record({ category: 'prompt', summary: 'tenant A secret', orgId: 'A' });
    e.record({ category: 'prompt', summary: 'tenant B secret', orgId: 'B' });
    e.record({ category: 'operational', summary: 'global system event' });
    assert.equal(e.query({ orgId: 'A' }).length, 1);
    assert.equal(e.query({ orgId: 'A' })[0]!.summary, 'tenant A secret');
    assert.equal(e.query({ orgId: 'B' }).length, 1);
    // A no-orgId query sees only global (undefined org) events.
    assert.equal(e.query().length, 1);
    assert.equal(e.query()[0]!.summary, 'global system event');
  });
});

describe('DigitalMemoryEngine — search', () => {
  it('ranks by keyword overlap', () => {
    const e = new DigitalMemoryEngine();
    e.record({ category: 'search', summary: 'how to pay invoice', orgId: 'O' });
    e.record({ category: 'search', summary: 'invoice template download', orgId: 'O' });
    e.record({ category: 'search', summary: 'user profile settings', orgId: 'O' });
    const results = e.query({ orgId: 'O', text: 'invoice' });
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.summary.includes('invoice')));
  });

  it('filters by category, user, session, correlation, tags, time', () => {
    const e = new DigitalMemoryEngine();
    e.record({ category: 'navigation', summary: 'opened dashboard', orgId: 'O', userId: 'u1', sessionId: 's1', tags: ['ui'] });
    e.record({ category: 'navigation', summary: 'opened settings', orgId: 'O', userId: 'u2', tags: ['ui'] });
    assert.equal(e.query({ orgId: 'O', userId: 'u1' }).length, 1);
    assert.equal(e.query({ orgId: 'O', category: 'navigation' }).length, 2);
    assert.equal(e.query({ orgId: 'O', tags: ['ui'] }).length, 2);
    assert.equal(e.query({ orgId: 'O', sessionId: 's1' }).length, 1);
  });
});

describe('DigitalMemoryEngine — versioning & dedup', () => {
  it('re-recording the same logical event bumps the version, not the count', () => {
    const e = new DigitalMemoryEngine();
    const r1 = e.record({ category: 'config_change', summary: 'theme set to dark', orgId: 'O', data: { key: 'theme', value: 'dark' } });
    const r2 = e.record({ category: 'config_change', summary: 'theme set to dark', orgId: 'O', data: { key: 'theme', value: 'dark' } });
    assert.equal(r1.event!.version, 1);
    assert.equal(r2.event!.version, 2);
    assert.equal(e.size, 1); // no duplicate
  });
});

describe('DigitalMemoryEngine — governance (policy + consent)', () => {
  it('blocks categories and respects allow-lists', () => {
    const e = new DigitalMemoryEngine();
    e.setPolicy({ orgId: 'O', blockedCategories: ['billing'] });
    assert.equal(e.record({ category: 'billing', summary: 'x', orgId: 'O' }).recorded, false);
    e.setPolicy({ orgId: 'O2', allowedCategories: ['prompt'] });
    assert.equal(e.record({ category: 'navigation', summary: 'x', orgId: 'O2' }).recorded, false);
    assert.equal(e.record({ category: 'prompt', summary: 'x', orgId: 'O2' }).recorded, true);
  });

  it('disables memory for an org', () => {
    const e = new DigitalMemoryEngine();
    e.setPolicy({ orgId: 'O', disabled: true });
    assert.equal(e.record({ category: 'prompt', summary: 'x', orgId: 'O' }).reason, 'org-disabled');
  });

  it('requires consent for flagged categories', () => {
    const e = new DigitalMemoryEngine();
    e.setPolicy({ orgId: 'O', consentRequiredCategories: ['security'] });
    assert.equal(e.record({ category: 'security', summary: 'login', orgId: 'O', userId: 'u1' }).reason, 'consent-required');
    e.grantConsent('u1', ['security']);
    assert.equal(e.hasConsent('u1', 'security'), true);
    assert.equal(e.record({ category: 'security', summary: 'login', orgId: 'O', userId: 'u1' }).recorded, true);
    e.revokeConsent('u1', 'security');
    assert.equal(e.record({ category: 'security', summary: 'login2', orgId: 'O', userId: 'u1' }).reason, 'consent-required');
  });
});

describe('DigitalMemoryEngine — retention & privacy', () => {
  it('sweep removes expired events', () => {
    const e = new DigitalMemoryEngine();
    const past = Date.now() - 10 * 86_400_000;
    e.record({ category: 'performance', summary: 'old metric', orgId: 'O', retentionDays: 1, ts: past });
    e.record({ category: 'performance', summary: 'fresh metric', orgId: 'O', retentionDays: 90 });
    assert.equal(e.size, 2);
    const removed = e.sweep();
    assert.equal(removed, 1);
    assert.equal(e.size, 1);
  });

  it('exports and right-to-deletes a subject', () => {
    const e = new DigitalMemoryEngine();
    e.record({ category: 'prompt', summary: 'a', orgId: 'O', userId: 'u1' });
    e.record({ category: 'prompt', summary: 'b', orgId: 'O', userId: 'u1' });
    e.record({ category: 'prompt', summary: 'c', orgId: 'O', userId: 'u2' });
    assert.equal(e.exportFor({ userId: 'u1', orgId: 'O' }).length, 2);
    const removed = e.deleteForSubject({ userId: 'u1', orgId: 'O' });
    assert.equal(removed, 2);
    assert.equal(e.query({ orgId: 'O' }).length, 1);
  });

  it('reports stats by category and org', () => {
    const e = new DigitalMemoryEngine();
    e.record({ category: 'prompt', summary: 'x', orgId: 'O' });
    e.record({ category: 'error', summary: 'y', orgId: 'O' });
    const s = e.stats('O');
    assert.equal(s.total, 2);
    assert.equal(s.byCategory.prompt, 1);
    assert.equal(s.byCategory.error, 1);
  });
});

describe('tokenize', () => {
  it('lowercases, strips punctuation, drops short tokens', () => {
    assert.ok(tokenize('Hello, WORLD! AI is #1').includes('hello'));
    assert.ok(tokenize('Hello, WORLD! AI is #1').includes('world'));
    assert.ok(!tokenize('a b c d').includes('a')); // too short
  });
});
