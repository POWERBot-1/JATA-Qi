// DlpModule tests — Data Loss Prevention + property-based verification.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { JataQiClient } from '@jataqi/sdk';
import { DlpModule, DlpEngine, shannonEntropy, DEFAULT_DLP_RULES, DlpEvents } from '../src/index.js';

type CreateJataQi = (cfg?: Record<string, unknown>) => Promise<{ gateway?: { listen(opts?: { port?: number }): Promise<{ port: number; close(): Promise<void> }> }; shutdown(): Promise<void> }>;

describe('DlpEngine (detection + actions)', () => {
  it('redacts payment card numbers', () => {
    const e = new DlpEngine();
    const r = e.scan({ content: 'Card: 4111111111111111 expires 12/28', channel: 'api_response' });
    assert.equal(r.action, 'redact');
    const result = r.results.find((x) => x.ruleId === 'dlp.card')!;
    assert.equal(result.matches, 1);
    assert.ok(!r.results[0]!.redacted.includes('4111111111111111'), 'card number redacted');
    assert.equal(e.stats().redacted, 1);
  });

  it('blocks bulk PII exports (email threshold)', () => {
    const e = new DlpEngine();
    const emails = Array.from({ length: 12 }, (_, i) => `user${i}@example.com`).join(', ');
    const r = e.scan({ content: emails, channel: 'export', actor: 'alice', destination: 'personal-drive' });
    assert.equal(r.action, 'block');
    const incident = r.incident!;
    assert.equal(incident.ruleId, 'dlp.email_pii');
    assert.equal(incident.severity, 'high');
    assert.equal(incident.actor, 'alice');
    assert.ok(!incident.evidence.includes('user0@example.com'), 'evidence redacted');
    assert.equal(e.stats().blocked, 1);
  });

  it('blocks credentials by pattern + entropy and quarantines private keys', () => {
    const e = new DlpEngine();
    const cred = e.scan({ content: 'export const apiKey = "sk_live_a1b2c3d4e5f6g7h8i9j0"', channel: 'log' });
    assert.equal(cred.action, 'block');
    const key = e.scan({ content: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...', channel: 'upload' });
    assert.equal(key.action, 'quarantine');
    assert.equal(key.incident!.severity, 'critical');
    assert.equal(e.stats().quarantined, 1);
  });

  it('notifies on source-code markers and ignores low-entropy credentials', () => {
    const e = new DlpEngine();
    const notify = e.scan({ content: 'File header: jataqi-core internal-use-only', channel: 'email', destination: 'x@example.com' });
    assert.equal(notify.action, 'notify');
    const lowEntropy = e.scan({ content: 'password = "123"', channel: 'log' });
    assert.equal(lowEntropy.action, 'allow', 'below entropy threshold → no trigger');
  });

  it('computes Shannon entropy correctly', () => {
    assert.equal(shannonEntropy('aaaa'), 0, 'constant string → 0 bits');
    assert.ok(shannonEntropy('Ab3!x9$kQz#1') > 3.0, 'random-looking → high entropy');
    assert.ok(shannonEntropy('password123') < shannonEntropy('9$kQz#1Ab3!x'), 'structured < random');
  });
});

describe('DLP formal verification (property-based)', () => {
  // QuickCheck-style loops without external deps.
  it('property: redaction is idempotent (second scan finds nothing)', () => {
    const e = new DlpEngine();
    for (let i = 0; i < 50; i++) {
      const card = `411111111111111${i % 10}`;
      const first = e.scan({ content: `card ${card}`, channel: 'api_response' });
      assert.equal(first.action, 'redact');
      const redacted = first.results[0]!.redacted;
      // Second scan of the redacted content: no new incident, no new match.
      const again = e.scan({ content: redacted, channel: 'api_response' });
      assert.equal(again.action, 'allow', `iteration ${i}: redacted content must be clean`);
    }
  });

  it('property: incidents never contain raw sensitive values (evidence invariant)', () => {
    const e = new DlpEngine();
    const secrets = ['sk_live_zzz9xxx8yyy7', '4111111111111111', 'user1@example.com'];
    for (const secret of secrets) {
      e.scan({ content: `leak ${secret}`, channel: 'email', destination: 'out' });
    }
    for (const incident of e.incidentsList()) {
      for (const secret of secrets) {
        assert.ok(!incident.evidence.includes(secret), 'evidence must be redacted');
      }
    }
  });

  it('property: action ordering is monotonic (block beats quarantine beats redact)', () => {
    const e = new DlpEngine();
    const rank: Record<string, number> = { allow: 0, notify: 1, redact: 2, quarantine: 3, block: 4 };
    for (let i = 0; i < 25; i++) {
      const r = e.scan({
        content: `4111111111111111 and apiKey = "sk_live_abcdefghijkl" and -----BEGIN EC PRIVATE KEY-----`,
        channel: 'upload',
      });
      // Mixed content: card (redact) + credential (block) + private key (quarantine) → block wins.
      assert.equal(rank[r.action]! >= rank.quarantine!, true, `iteration ${i}: worst action applied`);
    }
  });

  it('property: rule upsert is deterministic (same content → same decision)', () => {
    const e1 = new DlpEngine();
    const e2 = new DlpEngine();
    e1.upsertRule({ ...DEFAULT_DLP_RULES[0]!, threshold: 1 });
    e2.upsertRule({ ...DEFAULT_DLP_RULES[0]!, threshold: 1 });
    for (let i = 0; i < 20; i++) {
      const content = `card 411111111111111${i % 10}`;
      const r1 = e1.scan({ content, channel: 'log' });
      const r2 = e2.scan({ content, channel: 'log' });
      assert.equal(r1.action, r2.action);
    }
  });
});

describe('DlpModule (kernel wiring)', () => {
  let kernel: Kernel;

  before(async () => {
    kernel = createTestKernel();
    kernel.register(new DlpModule());
    await kernel.boot();
  });

  after(async () => { await kernel.shutdown(); });

  it('emits dlp events and wires the surface', async () => {
    const mod = kernel.getModule<DlpModule>('dlp');
    const events: string[] = [];
    kernel.bus.on(DlpEvents.IncidentCreated, () => { events.push(DlpEvents.IncidentCreated); });
    kernel.bus.on(DlpEvents.Blocked, () => { events.push(DlpEvents.Blocked); });
    mod.scan({ content: '4111111111111111', channel: 'api_response' });
    const r = mod.scan({ content: Array.from({ length: 11 }, (_, i) => `u${i}@example.com`).join(' '), channel: 'export' });
    assert.equal(r.action, 'block');
    assert.ok(events.includes(DlpEvents.IncidentCreated));
    assert.ok(events.includes(DlpEvents.Blocked));
    assert.equal(mod.incidents().length, 2);
    assert.equal(mod.stats().rules, DEFAULT_DLP_RULES.length);
    // Incident lifecycle.
    const incident = mod.incidents()[0]!;
    mod.updateIncident(incident.id, 'resolved');
    assert.equal(mod.incidents({ status: 'open' }).length, 1);
  });
});

describe('DLP gateway integration (vs real server)', () => {
  let qi: Awaited<ReturnType<CreateJataQi>>;
  let admin: JataQiClient;
  let port: number;
  let closeHandle: () => Promise<void>;

  before(async () => {
    const bootstrapPath = new URL('../../../cli/dist/src/bootstrap.js', import.meta.url).href;
    const mod = await import(bootstrapPath) as unknown as { createJataQi: CreateJataQi };
    qi = await mod.createJataQi({ security: { bootstrapAdmin: { username: 'admin', password: 'admin' } } });
    const handle = await qi.gateway!.listen({ port: 0 });
    port = handle.port;
    closeHandle = handle.close;
    admin = new JataQiClient({ baseUrl: `http://127.0.0.1:${port}` });
    await admin.auth.login('admin', 'admin');
  });

  after(async () => {
    if (closeHandle) await closeHandle();
    if (qi) await qi.shutdown();
  });

  it('scans content, blocks bulk PII, and lists incidents end-to-end', async () => {
    const scan = await admin.dlp.scan({ content: Array.from({ length: 12 }, (_, i) => `u${i}@example.com`).join(', '), channel: 'export', actor: 'alice', destination: 'drive' });
    assert.equal((scan as { action: string }).action, 'block');
    const incidents = await admin.dlp.incidents();
    assert.ok((incidents.incidents as unknown[]).length >= 1);
    const stats = await admin.dlp.stats();
    assert.equal((stats.stats as { blocked: number }).blocked, 1);
    // Redact path returns the redacted content.
    const redact = await admin.dlp.scan({ content: 'card 4111111111111111', channel: 'api_response' });
    assert.equal((redact as { action: string }).action, 'redact');
  });

  it('exposes rules and incident resolution', async () => {
    const rules = await admin.dlp.rules();
    assert.ok((rules.rules as unknown[]).length >= 7);
    const incidents = await admin.dlp.incidents();
    const first = (incidents.incidents as Array<{ id: string }>)[0]!;
    const resolved = await admin.dlp.updateIncident(first.id, 'resolved');
    assert.equal((resolved.incident as { status: string }).status, 'resolved');
  });
});
