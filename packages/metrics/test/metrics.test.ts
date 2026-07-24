import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Counter, Gauge, Histogram, MetricsRegistry, labelKey } from '../src/index.js';
import { MetricsModule } from '../src/index.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';

describe('instruments', () => {
  it('counter increments and aggregates by label', () => {
    const c = new Counter({ name: 'reqs' });
    c.inc(1, { method: 'GET' });
    c.inc(2, { method: 'GET' });
    c.inc(1, { method: 'POST' });
    assert.equal(c.get({ method: 'GET' }), 3);
    assert.equal(c.get({ method: 'POST' }), 1);
    assert.throws(() => c.inc(-1), /non-negative/);
  });

  it('gauge moves up and down', () => {
    const g = new Gauge({ name: 'depth' });
    g.set(10);
    g.inc(5);
    g.dec(3);
    assert.equal(g.get(), 12);
  });

  it('histogram observes, counts buckets, and approximates quantiles', () => {
    const h = new Histogram({ name: 'lat', buckets: [1, 2, 5] });
    for (const v of [0.5, 1.5, 2.5, 4, 10]) h.observe(v);
    const snap = h.snapshot();
    assert.equal(snap?.count, 5);
    assert.equal(snap?.sum, 0.5 + 1.5 + 2.5 + 4 + 10);
    // median ~ 2.5
    const median = h.quantile(0.5);
    assert.ok(median !== undefined && median >= 1 && median <= 4);
  });

  it('labelKey is stable regardless of key order', () => {
    assert.equal(labelKey({ b: '1', a: '2' }), labelKey({ a: '2', b: '1' }));
  });
});

describe('MetricsRegistry', () => {
  it('dedupes instruments by name and renders Prometheus text', () => {
    const reg = new MetricsRegistry();
    reg.counter('reqs', 'requests').inc(5, { route: '/health' });
    reg.gauge('depth').set(3);
    reg.histogram('lat', 'latency', [1, 2]).observe(1.5);

    const text = reg.format();
    assert.match(text, /# TYPE reqs counter/);
    assert.match(text, /reqs\{route="\/health"\} 5/);
    assert.match(text, /# TYPE depth gauge/);
    assert.match(text, /depth 3/);
    assert.match(text, /lat_bucket\{le="\+Inf"\} 1/);
    assert.match(text, /lat_count 1/);

    // Same name returns the same instance.
    assert.equal(reg.counter('reqs'), reg.counter('reqs'));
  });
});

describe('MetricsModule (kernel integration)', () => {
  it('registers and exposes platform instruments', async () => {
    const k = createTestKernel();
    k.register(new MetricsModule());
    await k.boot();
    const m = k.getModule<MetricsModule>('metrics');
    m.requests.inc(2);
    m.workflowRuns.inc(1, { status: 'completed' });
    const names = m.snapshot().map((s) => s.name);
    assert.ok(names.includes('jataqi_requests_total'));
    assert.ok(names.includes('jataqi_workflow_runs_total'));
    assert.match(m.format(), /jataqi_requests_total 2/);
    await k.shutdown();
  });
});
