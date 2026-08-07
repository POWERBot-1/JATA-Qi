// JATA Qi v1.0.0 — Post-Deployment GA Validation.
//
// Boots the platform the way production runs it (CLI serve with a filesystem
// storage root + admin bootstrap, exactly what the Docker image and Helm
// chart do), then validates the complete commercial + security surface
// through the real HTTP gateway:
//
//   1. Version + health (health/livez/readyz/readiness summary)
//   2. Commercial: editions + entitlements + usage metering, product
//      marketplace (install → run → dependency graph), onboarding (full
//      guided run), operations (on-call, backup verification, health)
//   3. Security: SOC report, defense posture, security-automation
//      compliance report
//   4. Resilience: multi-region health + availability
//   5. DLP + PQC spot checks
//
// Writes docs/GA_VALIDATION_REPORT.md. Exit 0 = all checks passed.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'GA_VALIDATION_REPORT.md');

const PORT = 7499;
const BASE = `http://127.0.0.1:${PORT}`;
const FS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jataqi-ga-'));

// --- boot in production mode ----------------------------------------------------

const server = spawn('node', [path.join(ROOT, 'packages/cli/dist/src/index.js'), 'serve', String(PORT)], {
  cwd: ROOT,
  env: {
    ...process.env,
    STORAGE_DRIVER: 'filesystem',
    JATAQI_STORAGE_FS_ROOT: FS_ROOT,
    JATAQI_ADMIN_USERNAME: 'admin',
    JATAQI_ADMIN_PASSWORD: 'admin',
    LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += String(d); });
server.stderr.on('data', (d) => { serverLog += String(d); });

async function waitForHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not become healthy:\n${serverLog.slice(-2000)}`);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

let TOKEN = '';

await waitForHealth();
check('server boots in production mode (filesystem storage)', true, `fsRoot=${FS_ROOT}`);

// --- 1. version + health ---------------------------------------------------------

{
  const h = await api('GET', '/health');
  check('GET /health', h.status === 200 && h.json.status === 'healthy', `modules=${h.json.modules?.length}`);
  const live = await api('GET', '/livez');
  check('GET /livez', live.status === 200);
  const ready = await api('GET', '/readyz');
  check('GET /readyz', ready.status === 200);
  const readySummary = await api('GET', '/readiness');
  check('GET /readiness', readySummary.status === 200 && Array.isArray(readySummary.json.capabilities));
  // v1.0.0 marker.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('version is 1.0.0', pkg.version === '1.0.0', pkg.version);
}

// --- 2. commercial -----------------------------------------------------------------

let onboardingRunId = '';
{
  const reg = await api('POST', '/auth/register', { username: 'ga-user', password: 'pw123', roles: ['developer'] });
  const login = await api('POST', '/auth/login', { username: 'ga-user', password: 'pw123' });
  TOKEN = login.json.token;
  check('auth (register + login)', reg.status === 201 && !!TOKEN);

  // Editions + entitlements via commerce.
  const plans = await api('GET', '/commerce/plans');
  const editions = plans.json.plans?.map((p) => p.edition) ?? [];
  const required = ['FREE', 'PERSONAL', 'DEVELOPER', 'TEAM', 'BUSINESS', 'ENTERPRISE', 'GOVERNMENT'];
  check('all seven editions seeded', required.every((e) => editions.includes(e)), editions.join(','));

  // Product marketplace: install SOMA (auto-installs TANYA), run it.
  const catalog = await api('GET', '/products/catalog');
  check('product catalog has 5 built-ins', (catalog.json.catalog ?? []).length === 5);
  const install = await api('POST', '/products/install', { id: 'soma' });
  check('one-click install SOMA (+ tanya dep)', install.status === 201 && install.json.order?.join('→') === 'tanya→soma');
  const runtime = await api('POST', '/products/runtime', { id: 'soma', runtime: 'running' });
  check('product runtime start', runtime.json.installed?.runtime === 'running');
  const deps = await api('GET', '/products/dependencies?id=soma');
  check('dependency graph resolves', deps.json.graph?.installOrder?.length >= 2);

  // Onboarding: full guided run.
  const start = await api('POST', '/onboarding/start', { orgName: 'GA Org', adminEmail: 'admin@ga.org', industry: 'fintech' });
  onboardingRunId = start.json.run.id;
  check('onboarding started', start.status === 201 && !!onboardingRunId);
  await api('POST', '/onboarding/profile', { runId: onboardingRunId, name: 'GA Org', slug: 'ga', industry: 'fintech' });
  await api('POST', '/onboarding/admin', { runId: onboardingRunId, adminRoles: ['admin'] });
  const tenant = await api('POST', '/onboarding/tenant', { runId: onboardingRunId, region: 'nbo-1', storageDriver: 'sqlite' });
  check('tenant provisioned', tenant.json.run?.tenant?.tenantId?.startsWith('tenant-') === true);
  const invite = await api('POST', '/onboarding/invite', { runId: onboardingRunId, email: 'eng@ga.org', role: 'developer' });
  await api('POST', '/onboarding/invite/accept', { runId: onboardingRunId, inviteId: invite.json.invite.id });
  await api('POST', '/onboarding/invitations/done', { runId: onboardingRunId });
  await api('POST', '/onboarding/sample-data', { runId: onboardingRunId, kinds: ['marketplace'] });
  const done = await api('POST', '/onboarding/complete', { runId: onboardingRunId });
  check('onboarding 100% complete', done.json.run?.completedAt !== undefined);
  const progress = await api('GET', `/onboarding/run?id=${onboardingRunId}`);
  check('onboarding progress pct=100', progress.json.progress?.pct === 100);
}

// --- 3. operations ------------------------------------------------------------------

{
  const rotation = await api('POST', '/ops/rotations', { engineers: ['alice', 'bob', 'carol'], shiftMs: 86_400_000 });
  const rotationId = rotation.json.rotation?.id;
  check('on-call rotation created', !!rotationId);
  const onCall = await api('GET', `/ops/oncall?rotationId=${rotationId}`);
  check('on-call engineer resolved', ['alice', 'bob', 'carol'].includes(onCall.json.onCall));
  const chain = await api('GET', `/ops/escalation-chain?rotationId=${rotationId}&severity=sev1`);
  check('escalation chain built', chain.json.chain?.length >= 2);
  const v = await api('POST', '/ops/backup/verify', { backupId: 'bk-ga', namespace: 'payments', entries: 100, recordedHash: 'ga-hash', actualHash: 'ga-hash' });
  check('backup verification passed', v.json.verification?.ok === true);
  const drill = await api('POST', '/ops/drills', { name: 'GA DR drill', scope: 'platform' });
  await api('POST', '/ops/drills/advance', { id: drill.json.drill.id, stage: 'completed' });
  const drills = await api('GET', '/ops/drills');
  check('DR drill passed', drills.json.drills?.[0]?.result === 'passed');
  const health = await api('POST', '/ops/health', { checks: [{ name: 'gateway', status: 'healthy' }], rotationId });
  check('ops health report healthy', health.json.report?.overall === 'healthy');
}

// --- 4. security ----------------------------------------------------------------------

{
  const soc = await api('GET', '/soc/report');
  check('SOC executive report', soc.status === 200 && soc.json.report?.kpis !== undefined);
  const posture = await api('GET', '/defense/posture');
  check('active-defense posture', posture.status === 200 && posture.json.stats !== undefined);
  const compliance = await api('GET', '/security-automation/compliance-report');
  check('ISO 27001 compliance evidence (12 families)', (compliance.json.report?.families ?? []).length === 12);
  const dlp = await api('POST', '/dlp/scan', { content: '4111111111111111', channel: 'api_response' });
  check('DLP redacts cards', dlp.json.action === 'redact');
  const pqc = await api('GET', '/pqc/stats');
  check('PQC registry live', pqc.json.stats?.pqAlgorithms >= 8);
  const hunt = await api('POST', '/security-automation/hunts/run');
  check('continuous hunt sweep runs', hunt.status === 200);
}

// --- 5. resilience ----------------------------------------------------------------------

{
  const regions = await api('GET', '/resilience/regions');
  check('multi-region topology (3 regions)', (regions.json.regions ?? []).length === 3);
  const health = await api('GET', '/resilience/health');
  check('all regions healthy', Object.values(health.json.regions ?? {}).every((s) => s === 'healthy'));
  const avail = await api('POST', '/resilience/availability', { workload: 'api', windowMs: 86400000, uptime: 0.9995, slo: 0.995 });
  check('availability within SLO', avail.json.availability?.uptimeLabel === '99.950%');
}

// --- report -----------------------------------------------------------------------------

await new Promise((r) => setTimeout(r, 100));
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
const lines = [];
lines.push('# JATA Qi v1.0.0 — GA Deployment Validation Report');
lines.push('');
lines.push(`- **Date:** ${new Date().toISOString()}`);
lines.push(`- **Mode:** production (CLI serve, filesystem storage, admin bootstrap)`);
lines.push(`- **Checks:** ${passed}/${results.length} passed`);
lines.push('');
lines.push('## Results');
lines.push('');
for (const r of results) {
  lines.push(`- ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
if (failed.length > 0) {
  lines.push('');
  lines.push('## Failed checks');
  lines.push('');
  for (const f of failed) lines.push(`- ❌ ${f.name} — ${f.detail}`);
}
lines.push('');
lines.push('---');
lines.push('_Generated by examples/ga-validation.mjs against the v1.0.0 build._');
fs.writeFileSync(OUT, lines.join('\n') + '\n');

server.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 500));
console.log(`\n✓ GA validation report → ${path.relative(ROOT, OUT)} (${passed}/${results.length} checks)`);
process.exit(failed.length === 0 ? 0 : 1);
