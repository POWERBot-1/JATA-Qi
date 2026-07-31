// PR6 — Performance benchmarks. Measures gateway latency (p50/p95/p99),
// throughput (req/s), and memory growth over a sustained workload (leak check).
// Generous thresholds keep this stable on shared/sandbox runners; set
// JATAQI_SKIP_PERF=1 to skip. Asserts there is no catastrophic regression.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createJataQi } from '../src/bootstrap.js';
import type { ApiGatewayModule } from '@jataqi/api-gateway';
import type { GatewayHandle } from '@jataqi/api-gateway';

const SKIP = process.env.JATAQI_SKIP_PERF === '1';
const maybeIt = SKIP ? it.skip : it;

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}
async function timedFetch(url: string, opts?: RequestInit): Promise<{ ms: number; status: number }> {
  const t0 = process.hrtime.bigint();
  const res = await fetch(url, opts);
  await res.text();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, status: res.status };
}

describe('performance — gateway latency, throughput, memory', () => {
  let handle: GatewayHandle;
  let base: string;
  let shutdown: () => Promise<void>;
  let token: string;

  before(async () => {
    // Benchmarks measure raw gateway performance with rate limiting DISABLED
    // (otherwise the default 1000/min cap throttles the sustained workload).
    const qi = await createJataQi({ gateway: { rateLimit: null }, security: { bootstrapAdmin: { username: 'admin', password: 'admin' } } });
    shutdown = qi.shutdown;
    handle = await (qi.gateway as ApiGatewayModule).listen({ port: 0 });
    base = `http://127.0.0.1:${handle.port}`;
    // Register + log in a developer for authenticated routes.
    await (await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'perf', password: 'pw', roles: ['developer'] }) })).text();
    const login = await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'perf', password: 'pw' }) })).json() as { token: string };
    token = login.token;
    // Warmup (JIT, connection pool).
    for (let i = 0; i < 50; i++) await timedFetch(`${base}/health`);
  });
  after(async () => { await handle.close(); await shutdown(); });

  maybeIt('/health latency stays low under serial load (N=500)', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 500; i++) {
      const { ms, status } = await timedFetch(`${base}/health`);
      assert.equal(status, 200);
      samples.push(ms);
    }
    samples.sort((a, b) => a - b);
    const p50 = pct(samples, 0.5), p95 = pct(samples, 0.95), p99 = pct(samples, 0.99);
    // Generous thresholds for shared runners.
    assert.ok(p50 < 30, `p50 too high: ${p50.toFixed(2)}ms`);
    assert.ok(p95 < 100, `p95 too high: ${p95.toFixed(2)}ms`);
    assert.ok(p99 < 250, `p99 too high: ${p99.toFixed(2)}ms`);
  });

  maybeIt('authenticated /whoami latency stays low (N=500, includes session store read)', async () => {
    const samples: number[] = [];
    const auth = { headers: { authorization: `Bearer ${token}` } };
    for (let i = 0; i < 500; i++) {
      const { ms, status } = await timedFetch(`${base}/whoami`, auth);
      assert.equal(status, 200);
      samples.push(ms);
    }
    samples.sort((a, b) => a - b);
    assert.ok(pct(samples, 0.99) < 300, `whoami p99 too high: ${pct(samples, 0.99).toFixed(2)}ms`);
  });

  it('throughput sustains >= 100 req/s for /health (concurrent batches)', async () => {
    const CONCURRENCY = 50;
    const BATCHES = 10;
    let done = 0;
    const t0 = process.hrtime.bigint();
    for (let b = 0; b < BATCHES; b++) {
      const batch = Array.from({ length: CONCURRENCY }, () => timedFetch(`${base}/health`));
      const results = await Promise.all(batch);
      for (const r of results) { assert.equal(r.status, 200); done++; }
    }
    const secs = Number(process.hrtime.bigint() - t0) / 1e9;
    const rps = done / secs;
    assert.ok(rps >= 100, `throughput too low: ${rps.toFixed(0)} req/s`);
  });

  maybeIt('no gross memory leak over a sustained workload (N=2000)', async () => {
    const baseline = process.memoryUsage().heapUsed;
    for (let i = 0; i < 2000; i++) {
      await timedFetch(`${base}/whoami`, { headers: { authorization: `Bearer ${token}` } });
    }
    // Try to force GC if exposed (CI may run with --expose-gc); otherwise this
    // measures retained+uncollected heap, so the bound is generous.
    if (typeof (globalThis as { gc?: () => void }).gc === 'function') {
      (globalThis as { gc: () => void }).gc();
    }
    const after = process.memoryUsage().heapUsed;
    const growthMB = (after - baseline) / 1024 / 1024;
    // < 64MB growth over 2000 requests = no catastrophic retention.
    assert.ok(growthMB < 64, `possible memory leak: +${growthMB.toFixed(1)}MB over 2000 requests`);
  });
});
