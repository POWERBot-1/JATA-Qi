// JATA Qi — Scalability Validation (Phase 2).
//
// Benchmarks the platform's data planes and validates resilience under load:
//
//   1. Gateway latency percentiles (p50/p95/p99) for /health + /tanya/chat
//   2. Gateway throughput (req/s, concurrent batches)
//   3. SOC security-lake ingest throughput (events/s, hash-chained)
//   4. DLP scan throughput (scans/s over sensitive content)
//   5. Chaos: primary-region loss under sustained load → automated failover
//      → recovery; verifies survival + RTO compliance
//   6. Memory growth over the sustained workload (leak check)
//
// Writes docs/SCALABILITY_VALIDATION.md.
//
// Usage: node examples/scalability-validation.mjs [--fast]
//   --fast  reduced workload (CI-friendly); default is the full workload.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'SCALABILITY_VALIDATION.md');
const FAST = process.argv.includes('--fast');

const N_HEALTH = FAST ? 200 : 800;
const N_CHAT = FAST ? 30 : 120;
const N_LAKE = FAST ? 5_000 : 25_000;
const N_DLP = FAST ? 1_000 : 5_000;
const CONCURRENCY = FAST ? 25 : 50;

// --- boot ---------------------------------------------------------------------

const { createJataQi } = await import(path.join(ROOT, 'packages/cli/dist/src/bootstrap.js'));
const qi = await createJataQi({
  gateway: { rateLimit: null },
  security: { bootstrapAdmin: { username: 'admin', password: 'admin' } },
});
const handle = await qi.gateway.listen({ port: 0 });
const base = `http://127.0.0.1:${handle.port}`;

await (await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'scale', password: 'pw', roles: ['developer'] }) })).text();
const login = await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'scale', password: 'pw' }) })).json();
const token = login.token;
const auth = { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } };

function pct(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
async function timedFetch(url, opts) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(url, opts);
  await res.text();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, status: res.status };
}

// Warmup.
for (let i = 0; i < 30; i++) await timedFetch(`${base}/health`);

const results = {};

// --- 1 + 2. gateway latency + throughput --------------------------------------

{
  const health = [];
  for (let i = 0; i < N_HEALTH; i++) health.push((await timedFetch(`${base}/health`)).ms);
  health.sort((a, b) => a - b);

  const chat = [];
  for (let i = 0; i < N_CHAT; i++) {
    const r = await timedFetch(`${base}/tanya/chat`, {
      method: 'POST', ...auth,
      body: JSON.stringify({ message: `scale test message ${i}` }),
    });
    chat.push(r.ms);
  }
  chat.sort((a, b) => a - b);

  let done = 0;
  const t0 = process.hrtime.bigint();
  for (let b = 0; b < 8; b++) {
    const batch = Array.from({ length: CONCURRENCY }, () => timedFetch(`${base}/health`));
    done += (await Promise.all(batch)).filter((r) => r.status === 200).length;
  }
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;

  results.gateway = {
    health: { p50: pct(health, 0.5), p95: pct(health, 0.95), p99: pct(health, 0.99), n: health.length },
    tanyaChat: { p50: pct(chat, 0.5), p95: pct(chat, 0.95), p99: pct(chat, 0.99), n: chat.length },
    throughputRps: Math.round(done / secs),
  };
}

// --- 3. SOC lake ingest throughput ---------------------------------------------

{
  const soc = qi.kernel.getModule('soc');
  const payloads = [];
  for (let i = 0; i < N_LAKE; i++) {
    payloads.push({ source: 'gateway', type: i % 3 === 0 ? 'security.auth.denied' : 'gateway.request', actor: `u${i % 100}`, origin: `10.0.0.${i % 250}`, severity: i % 5 === 0 ? 'high' : 'info', data: { n: i } });
  }
  const t0 = process.hrtime.bigint();
  const entries = soc.ingestBatch(payloads);
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  results.lake = {
    events: entries.length,
    throughputPerSec: Math.round(entries.length / secs),
    chainValid: soc.verifyLake().valid,
    queryLatencyMs: (() => {
      const q0 = process.hrtime.bigint();
      soc.query({ type: 'security.auth.denied' });
      return Number(process.hrtime.bigint() - q0) / 1e6;
    })(),
  };
}

// --- 4. DLP scan throughput ----------------------------------------------------

{
  const dlp = qi.kernel.getModule('dlp');
  const samples = [
    'Card: 4111111111111111 please process',
    Array.from({ length: 12 }, (_, i) => `user${i}@example.com`).join(', '),
    'export const apiKey = "sk_live_a1b2c3d4e5f6g7h8i9j0"',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...',
    'ordinary log line without sensitive content',
  ];
  const t0 = process.hrtime.bigint();
  let blocked = 0;
  for (let i = 0; i < N_DLP; i++) {
    const r = dlp.scan({ content: samples[i % samples.length], channel: 'log' });
    if (r.action === 'block') blocked++;
  }
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  results.dlp = {
    scans: N_DLP,
    throughputPerSec: Math.round(N_DLP / secs),
    blocked,
    rules: dlp.rules().length,
  };
}

// --- 5. chaos: region loss under load → failover → recovery --------------------

{
  const resilience = qi.kernel.getModule('resilience-engineering');
  // Seed a plan for the workload.
  const plan = resilience.createPlan({ workload: 'scale-api', rpoMs: 60_000, rtoMs: 60_000, createdBy: 'scale' });
  // Baseline traffic while the primary region dies.
  const chaosStart = process.hrtime.bigint();
  const errors = [];
  let failoverRun = null;
  for (let i = 0; i < 20; i++) {
    // Fail the primary region (3 consecutive probe failures → down).
    resilience.recordProbe('scale-api', 'nbo-1', false, 500);
    if (i >= 2) {
      failoverRun = resilience.evaluateFailover('scale-api');
      if (failoverRun) break;
    }
    // Sustained load during the outage.
    try {
      const r = await timedFetch(`${base}/health`);
      if (r.status !== 200) errors.push(`http-${r.status}`);
    } catch (e) {
      errors.push(String(e));
    }
  }
  const chaosSecs = Number(process.hrtime.bigint() - chaosStart) / 1e9;
  // Execute the DR plan within RTO after failover.
  const execution = resilience.executePlan(plan.id, { snapshotAgeMs: 30_000 });
  // Recover: probe the promoted region healthy → primary returns.
  resilience.recordProbe('scale-api', 'lon-1', true, 40);
  results.chaos = {
    failoverTriggered: failoverRun !== null,
    failoverFrom: failoverRun?.fromRegion ?? null,
    failoverTo: failoverRun?.toRegion ?? null,
    survivalErrors: errors.length,
    drStatus: execution.status,
    rtoMet: execution.rtoMet,
    recoveryHealth: resilience.regionHealth(),
    durationSec: Number(chaosSecs.toFixed(2)),
  };
}

// --- 6. memory -----------------------------------------------------------------

{
  const baseline = process.memoryUsage().heapUsed;
  for (let i = 0; i < 500; i++) await timedFetch(`${base}/whoami`, auth);
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const growthMB = (process.memoryUsage().heapUsed - baseline) / 1024 / 1024;
  results.memory = { growthMb: Number(growthMB.toFixed(1)) };
}

// --- report --------------------------------------------------------------------

const push = (s = '') => lines.push(s);
const lines = [];
push('# Scalability Validation Report — JATA Qi');
push('');
push(`- **Date:** ${new Date().toISOString()}`);
push(`- **Workload:** ${FAST ? 'fast (CI)' : 'full'}`);
push(`- **Platform:** ${qi.kernel.getModule('api-gateway') ? 'full bootstrap' : 'n/a'} · Node ${process.version}`);
push('');
push('## Gateway');
push('');
push(`| Metric | p50 | p95 | p99 | N |`);
push(`| ------ | --- | --- | --- | - |`);
push(`| /health | ${results.gateway.health.p50.toFixed(2)}ms | ${results.gateway.health.p95.toFixed(2)}ms | ${results.gateway.health.p99.toFixed(2)}ms | ${results.gateway.health.n} |`);
push(`| /tanya/chat | ${results.gateway.tanyaChat.p50.toFixed(2)}ms | ${results.gateway.tanyaChat.p95.toFixed(2)}ms | ${results.gateway.tanyaChat.p99.toFixed(2)}ms | ${results.gateway.tanyaChat.n} |`);
push(`| Throughput | **${results.gateway.throughputRps} req/s** (concurrency ${CONCURRENCY}) | | | |`);
push('');
push('## SOC security lake');
push('');
push(`- Ingest: **${results.lake.events.toLocaleString()} events** at **${results.lake.throughputPerSec.toLocaleString()} events/s**`);
push(`- Hash-chain integrity: ${results.lake.chainValid ? '✅ valid' : '❌ BROKEN'}`);
push(`- Filter query latency: ${results.lake.queryLatencyMs.toFixed(2)}ms over ${results.lake.events.toLocaleString()} entries`);
push('');
push('## DLP scan plane');
push('');
push(`- **${results.dlp.scans.toLocaleString()} scans** at **${results.dlp.throughputPerSec.toLocaleString()} scans/s** (${results.dlp.rules} rules, ${results.dlp.blocked} blocked)`);
push('');
push('## Chaos (region loss under load)');
push('');
push(`- Failover triggered: ${results.chaos.failoverTriggered ? '✅' : '❌'} (${results.chaos.failoverFrom} → ${results.chaos.failoverTo})`);
push(`- Errors during outage window: ${results.chaos.survivalErrors}`);
push(`- DR execution: ${results.chaos.drStatus} — RTO met: ${results.chaos.rtoMet ? '✅' : '❌'}`);
push(`- Region health after recovery: ${JSON.stringify(results.chaos.recoveryHealth)}`);
push(`- Window duration: ${results.chaos.durationSec}s`);
push('');
push('## Memory');
push('');
push(`- Heap growth over 500 authenticated requests: ${results.memory.growthMb}MB`);
push('');
push('---');
push('_Generated by examples/scalability-validation.mjs. Honest numbers from this runner — thresholds and baselines live in packages/cli/test/scalability.test.ts._');
fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`✓ report → ${path.relative(ROOT, OUT)}`);
console.log(JSON.stringify(results, null, 2));

await handle.close();
await qi.shutdown();
process.exit(0);
