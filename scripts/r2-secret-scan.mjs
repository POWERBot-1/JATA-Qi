// R2 upgraded secret scan: static persistence-span analysis of the R2
// durable sources PLUS a live PostgreSQL dump scan. Fails (exit 1) on any
// finding. Writes docs/verification/r2-secret-scan.json.
//
// Usage: node scripts/r2-secret-scan.mjs

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
import {
  AUTHENTICATION_EVENTS_COLLECTION,
  AuthenticationEventStore,
  DeterministicTestAuthenticator,
  PrincipalBoundary,
  testCredential,
} from '@jataqi/authentication';
import {
  AUTHORIZATION_DECISIONS_COLLECTION,
  AuthorizationGate,
  DurableCredentialBroker,
  InMemoryAuditSink,
  InMemoryCredentialMaterialProvider,
  SECURITY_CONSUMED_ENVELOPES_COLLECTION,
  SECURITY_CREDENTIAL_USES_COLLECTION,
  SECURITY_CREDENTIALS_COLLECTION,
  SECURITY_IDEMPOTENCY_COLLECTION,
  SECURITY_MANIFESTS_COLLECTION,
  SECURITY_RATE_WINDOWS_COLLECTION,
  SECURITY_RUN_BUDGETS_COLLECTION,
  SecurityStateStore,
} from '@jataqi/authorization-boundary';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { principal, baseRequest, manifest } = await import(
  '../packages/authorization-boundary/dist/test/helpers.js'
);

const findings = [];

// -- Part A: static durable-write span scan -------------------------------
// Every `.put(`/`.cas(` call in the R2 durable sources is span-scanned
// (paren-balanced from the call site): a standalone `material` /
// `secretMaterial` / `privateKey` / `password` identifier inside a
// persistence call span is a finding. (Property access like
// `x.fetchMaterial(` does not match: no word boundary.)
const DURABLE_SOURCES = [
  'packages/authorization-boundary/src/security-state-store.ts',
  'packages/authorization-boundary/src/credential-store.ts',
  'packages/authorization-boundary/src/consumption-stores.ts',
  'packages/authorization-boundary/src/durable-decider.ts',
  'packages/authorization-boundary/src/audit.ts',
  'packages/authorization-boundary/src/envelope.ts',
  'packages/authentication/src/authentication-event-store.ts',
  'packages/authentication/src/token-registry.ts',
];

function stripCommentsAndStrings(s) {
  return s
    .replace(/'([^'\\]|\\.)*'/g, "''")
    .replace(/"([^"\\]|\\.)*"/g, '""')
    .replace(/`([^`\\]|\\.)*`/g, '``')
    .replace(/\/\/.*/g, '');
}

for (const rel of DURABLE_SOURCES) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const re = /\.(put|cas)\s*\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let i = m.index + m[0].length - 1;
    let depth = 0;
    let j = i;
    while (j < text.length && j - i < 6000) {
      if (text[j] === '(') depth += 1;
      else if (text[j] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      j += 1;
    }
    const span = stripCommentsAndStrings(text.slice(i, j + 1)).replace(/''|""|``/g, '');
    const hits = span.match(/\b(material|secretMaterial|privateKey|passwd|password)\b/gi);
    if (hits) {
      findings.push({
        part: 'static',
        file: rel,
        line: text.slice(0, m.index).split('\n').length,
        call: m[1],
        identifiers: [...new Set(hits.map((x) => x.toLowerCase()))],
      });
    }
  }
}

// -- Part B: live PostgreSQL dump scan --------------------------------------
const port = 60800 + Math.floor(Math.random() * 300);
const server = new EmbeddedPostgres({
  databaseDir: join(tmpdir(), `jataqi-r2scan-${process.pid}`),
  port,
  user: 'postgres',
  password: 'postgres',
  authMethod: 'password',
  persistent: true,
  createPostgresUser: false,
  initdbFlags: ['--no-locale', '--encoding=UTF8'],
  postgresFlags: [],
  onLog: () => {},
  onError: () => {},
});
await server.initialise();
await server.start();
const database = `r2scan_${process.pid}_${randomUUID().slice(0, 8)}`;
await server.createDatabase(database);
const connectionString = `postgres://postgres:postgres@127.0.0.1:${port}/${database}`;

const driver = new PostgresDriver({ connectionString, requireExplicitConfig: true, max: 10 });
const kernel = createTestKernel();
const storage = new StorageModule({ driverInstance: driver });
kernel.register(storage);
await kernel.boot();
const store = await SecurityStateStore.open(storage);
const sessions = await AuthenticationEventStore.open(storage);
const broker = new DurableCredentialBroker(store, new InMemoryCredentialMaterialProvider());
const gate = new AuthorizationGate({ store, durableBroker: broker, audit: new InMemoryAuditSink() });

const now = Date.now();
await store.registerManifestVersion(
  manifest({
    capabilityId: 'scan.cap',
    maxLifetimeMs: 3_600_000,
    requiredCredentialScopes: ['read'],
    rateLimit: { windowMs: 3_600_000, max: 1000 },
    budgetPerRunCostUnits: 1000,
  }),
  { principalId: 'user:registrar', tenantId: 'acme', authenticationEventId: 'evt-scan-registrar' },
);

const markers = [];
const record = { id: 'user:alice', tenantId: 'acme', roles: ['operator'] };
const presented = testCredential(record);
markers.push(presented.material);
const boundary = new PrincipalBoundary({
  policy: { mode: 'test-only', allowTestMethod: true },
  authenticators: [new DeterministicTestAuthenticator([record])],
  eventStore: sessions,
  sessionLifetimeMs: 3_600_000,
  now: () => now,
});
const authed = await boundary.authenticate(presented);
const issued = await broker.issue(
  {
    credentialId: `cred-scan-${process.pid}`,
    principalId: authed.id,
    tenantId: authed.tenantId,
    capabilityId: 'scan.cap',
    tool: 'test-tool',
    operation: 'do',
    audience: 'aud-1',
    scopes: ['read'],
    lifetimeMs: 3_600_000,
    issuedBy: 'user:registrar',
  },
  { principalId: 'user:registrar', authenticationEventId: 'evt-scan-registrar' },
);
markers.push(issued.material);
markers.push('r2-material-');

const sessionRow = await sessions.recordEvent(
  {
    eventId: `evt-scan-${process.pid}`,
    tenantId: 'acme',
    principalId: 'user:alice',
    method: 'STATIC_TOKEN',
    verifiedAt: now,
    expiresAt: now + 3_600_000,
  },
  now,
);
const request = baseRequest({
  principal: principal({ authenticationEventId: sessionRow.id }),
  capability: { capabilityId: 'scan.cap', capabilityVersion: '1' },
  credential: { credentialId: issued.credentialId, audience: 'aud-1', scopes: ['read'] },
  run: { runId: `scan-run-${process.pid}`, correlationId: `scan-corr-${process.pid}` },
});
const envelope = await gate.decideAsync(request);
if (envelope.decision.decision !== 'ALLOW') throw new Error('scan exercise denied');
await gate.executeAuthorized(envelope, async () => 'scan', { tool: 'test-tool', operation: 'do' });
await broker.revoke(issued.credentialId, 'acme', 'scan');
await sessions.revokeEvent(sessionRow.id, 'acme', 'scan', now);
await store.runGarbageCollection(now + 1);

const dump = await store.transact({ system: true }, async (collections) => {
  const out = [];
  for (const name of [
    SECURITY_MANIFESTS_COLLECTION,
    SECURITY_CREDENTIALS_COLLECTION,
    SECURITY_CREDENTIAL_USES_COLLECTION,
    SECURITY_CONSUMED_ENVELOPES_COLLECTION,
    SECURITY_IDEMPOTENCY_COLLECTION,
    SECURITY_RATE_WINDOWS_COLLECTION,
    SECURITY_RUN_BUDGETS_COLLECTION,
    AUTHORIZATION_DECISIONS_COLLECTION,
    AUTHENTICATION_EVENTS_COLLECTION,
  ]) {
    const handle = await collections.scope.collection(name);
    for (const row of await handle.query({})) out.push({ collection: name, row });
  }
  return out;
});

const serialized = JSON.stringify(dump);
for (const marker of markers) {
  if (serialized.includes(marker)) {
    findings.push({ part: 'dump-values', marker: marker.slice(0, 24), detail: 'secret marker present in durable dump' });
  }
}
const FIELD_PATTERN = /(material|secret|password|privatekey|bearer|sessionkey)/i;
function fieldNames(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const names = [];
  for (const key of Object.keys(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    names.push(full);
    names.push(...fieldNames(value[key], full));
  }
  return names;
}
for (const entry of dump) {
  for (const name of fieldNames(entry.row)) {
    if (FIELD_PATTERN.test(name)) {
      findings.push({ part: 'dump-fields', collection: entry.collection, field: name });
    }
  }
}

await driver.close().catch(() => undefined);
await server.dropDatabase(database).catch(() => undefined);
await server.stop().catch(() => undefined);

const report = {
  generatedAt: new Date().toISOString(),
  staticFilesScanned: DURABLE_SOURCES.length,
  dumpRows: dump.length,
  markersChecked: markers.length,
  findings,
  passed: findings.length === 0,
};
mkdirSync(join(ROOT, 'docs/verification'), { recursive: true });
writeFileSync(join(ROOT, 'docs/verification/r2-secret-scan.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`static files: ${report.staticFilesScanned}, dump rows: ${dump.length}, findings: ${findings.length}`);
if (findings.length > 0) {
  console.log(JSON.stringify(findings, null, 2));
  process.exit(1);
}
console.log('R2 secret scan: PASS');
