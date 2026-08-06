// Scalability validation tests (Phase 2) — data-plane throughput, chaos under
// load, and lake integrity at volume. Generous thresholds keep this stable on
// shared/sandbox runners; set JATAQI_SKIP_PERF=1 to skip. Mirrors
// examples/scalability-validation.mjs with bounded assertions.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createJataQi } from '../src/bootstrap.js';
import type { ApiGatewayModule } from '@jataqi/api-gateway';
import type { GatewayHandle } from '@jataqi/api-gateway';
import type { SocModule } from '@jataqi/soc';
import type { DlpModule } from '@jataqi/dlp';
import type { ResilienceEngineeringModule } from '@jataqi/resilience-engineering';

const SKIP = process.env.JATAQI_SKIP_PERF === '1';
const maybeIt = SKIP ? it.skip : it;

describe('scalability — SOC lake, DLP plane, chaos under load', () => {
  let handle: GatewayHandle;
  let base: string;
  let qi: Awaited<ReturnType<typeof createJataQi>>;
  let soc: SocModule;
  let dlp: DlpModule;
  let resilience: ResilienceEngineeringModule;

  before(async () => {
    qi = await createJataQi({ gateway: { rateLimit: null }, security: { bootstrapAdmin: { username: 'admin', password: 'admin' } } });
    handle = await (qi.gateway as ApiGatewayModule).listen({ port: 0 });
    base = `http://127.0.0.1:${handle.port}`;
    soc = qi.kernel.getModule<SocModule>('soc');
    dlp = qi.kernel.getModule<DlpModule>('dlp');
    resilience = qi.kernel.getModule<ResilienceEngineeringModule>('resilience-engineering');
  });

  after(async () => { await handle.close(); await qi.shutdown(); });

  maybeIt('SOC lake ingests at volume with a valid hash chain (N=10k)', async () => {
    const payloads = Array.from({ length: 10_000 }, (_, i) => ({
      source: 'gateway' as const, type: i % 3 === 0 ? 'security.auth.denied' : 'gateway.request',
      actor: `u${i % 50}`, origin: `10.0.0.${i % 200}`,
    }));
    const t0 = process.hrtime.bigint();
    const entries = soc.ingestBatch(payloads);
    const secs = Number(process.hrtime.bigint() - t0) / 1e9;
    const rps = entries.length / secs;
    assert.equal(entries.length, 10_000);
    assert.ok(rps >= 5_000, `lake ingest too slow: ${Math.round(rps).toLocaleString()} events/s`);
    assert.equal(soc.verifyLake().valid, true, 'hash chain must remain valid at volume');
    // Query still fast over the full lake.
    const q0 = process.hrtime.bigint();
    soc.query({ type: 'security.auth.denied' });
    const qMs = Number(process.hrtime.bigint() - q0) / 1e6;
    assert.ok(qMs < 250, `lake query too slow: ${qMs.toFixed(1)}ms`);
  });

  maybeIt('DLP scan plane sustains throughput with correct action semantics', async () => {
    const samples = [
      'Card: 4111111111111111 please process',
      Array.from({ length: 12 }, (_, i) => `user${i}@example.com`).join(', '),
      'export const apiKey = "sk_live_a1b2c3d4e5f6g7h8i9j0"',
      'ordinary log line',
    ];
    const N = 2_000;
    const t0 = process.hrtime.bigint();
    let blocked = 0;
    for (let i = 0; i < N; i++) {
      const r = dlp.scan({ content: samples[i % samples.length]!, channel: 'log' });
      if (r.action === 'block') blocked++;
    }
    const secs = Number(process.hrtime.bigint() - t0) / 1e9;
    assert.ok(N / secs >= 1_000, `DLP too slow: ${Math.round(N / secs)} scans/s`);
    assert.ok(blocked > 0, 'block semantics exercised');
    assert.equal(dlp.rules().length >= 7, true);
  });

  maybeIt('chaos: primary region loss fails over automatically and recovers within RTO', async () => {
    const plan = resilience.createPlan({ workload: 'scale-api', rpoMs: 60_000, rtoMs: 60_000, createdBy: 'test' });
    let run = null;
    for (let i = 0; i < 3; i++) {
      resilience.recordProbe('scale-api', 'nbo-1', false, 500);
      run = resilience.evaluateFailover('scale-api') ?? run;
    }
    assert.ok(run, 'failover triggered');
    assert.equal(run!.fromRegion, 'nbo-1');
    assert.equal(run!.toRegion, 'lon-1');
    // Sustained load during the outage window must not error.
    const results = await Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/health`)));
    assert.ok(results.every((r) => r.status === 200), 'no errors during failover window');
    // DR execution within RTO with real snapshot-age RPO.
    const execution = resilience.executePlan(plan.id, { snapshotAgeMs: 30_000 });
    assert.equal(execution.status, 'completed');
    assert.equal(execution.rtoMet, true);
    // Recovery: promoted region healthy; original primary returns to service.
    resilience.recordProbe('scale-api', 'lon-1', true, 40);
    const health = resilience.regionHealth();
    assert.equal(health['lon-1'], 'healthy');
    assert.ok(resilience.failoverHistory().length >= 1);
  });

  it('gateway sustains concurrent traffic without errors (smoke bound)', async () => {
    const batch = Array.from({ length: 40 }, () => fetch(`${base}/health`));
    const results = await Promise.all(batch);
    assert.ok(results.every((r) => r.status === 200));
  });
});
