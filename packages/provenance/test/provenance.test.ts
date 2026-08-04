import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule, MemoryDriver } from '@jataqi/storage';
import {
  ProvenanceModule, provisionRoot, generateKeyPair, CANONICAL_IDENTITY, CREATOR_NAME,
} from '../src/index.js';
import type { INamespace } from '@jataqi/storage';
import type { Kernel } from '@jataqi/core-kernel';

function boot(kernel: Kernel, mod: ProvenanceModule) {
  kernel.register(new StorageModule());
  kernel.register(mod);
  return kernel.boot();
}

describe('ProvenanceModule (real Ed25519 cryptography)', () => {
  let kernel: Kernel;
  let prov: ProvenanceModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    const { manifest, privateKeyDerB64 } = provisionRoot();
    prov = new ProvenanceModule({ manifest, privateKey: privateKeyDerB64 });
    await boot(kernel, prov);
  });

  it('records the creator as GITANYA K and exposes a signed root manifest', () => {
    assert.equal(prov.whoCreatedYou(), CREATOR_NAME);
    assert.equal(prov.whatAreYou(), 'JATA QI');
    assert.match(prov.howDoYouKnow(), /Signed Provenance/);
    assert.equal(prov.identity().canonical_identity, CANONICAL_IDENTITY);
    assert.equal(prov.creator().display_name, 'GITANYA K');
    // No private key material leaks through identity().
    const id = JSON.stringify(prov.identity());
    assert.doesNotMatch(id, /private/i);
  });

  it('verifies the root manifest self-signature', async () => {
    const v = await prov.verify();
    assert.equal(v.valid, true);
    assert.equal(v.manifest.valid, true);
  });

  it('appends signed, hash-chained events and verifies the ledger', async () => {
    await prov.recordRelease('0.1.0', { note: 'alpha' });
    await prov.recordModule('qil');
    await prov.recordToolIntegration({ id: 't1', provider: 'openai', model: 'gpt-4o' });
    const events = await prov.events();
    assert.equal(events.length, 4); // CREATOR_ROOT_CREATED + 3
    const v = await prov.verifyLedger();
    assert.equal(v.valid, true);
    assert.equal(v.checked, 4);
    // events are signed (signing key present).
    assert.ok(events[1]!.signature);
  });

  it('distinguishes integrated third-party tools from creator-originated work', async () => {
    const e = await prov.recordToolIntegration({ id: 'whisper', provider: 'openai' });
    assert.equal(e.detail.integrated_by, 'JATA QI');
    assert.equal(e.detail.original_creator, 'GITANYA K');
    assert.equal(e.detail.third_party_provider, 'openai');
  });

  it('rotates the signing key while preserving lineage and verifiability', async () => {
    const before = (await prov.events()).slice(-1)[0]!.signerPublicKey;
    const newKp = generateKeyPair();
    const newPriv = newKp.privateKeyDer.toString('base64');
    const rot = await prov.rotateKey(newPriv);
    assert.equal(rot.type, 'KEY_ROTATED');
    await prov.recordRelease('0.2.0');
    const events = await prov.events();
    // Old and new events use different signer public keys; ledger still verifies.
    assert.notEqual(events[1]!.signerPublicKey, events[events.length - 1]!.signerPublicKey);
    assert.ok(before);
    const v = await prov.verifyLedger();
    assert.equal(v.valid, true);
  });

  it('revokes the active key (verify-only afterwards; signatures remain verifiable)', async () => {
    assert.equal(prov.canSign(), true);
    await prov.revokeKey();
    assert.equal(prov.canSign(), false);
    const v = await prov.verifyLedger();
    assert.equal(v.valid, true); // historical signatures still verify
  });

  it('detects tampering in the ledger (hash-chain integrity failure)', async () => {
    await prov.recordRelease('0.1.0');
    // Mutate a stored event directly through storage to simulate tampering.
    const storage = kernel.getModule('storage') as unknown as { namespace: (n: string) => Promise<INamespace> };
    const ns = await storage.namespace('provenance.ledger');
    const list = await ns.list({ limit: 100 });
    const target = list.items[list.items.length - 1]!.value as { detail: Record<string, unknown>; id: string };
    target.detail.tampered = true;
    await ns.set(target.id, target);
    const v = await prov.verifyLedger();
    assert.equal(v.valid, false);
    assert.ok(v.brokenAt! >= 1);
  });

  it('operates in verify-only mode when only a manifest (no private key) is provided', async () => {
    const k = createTestKernel();
    const { manifest } = provisionRoot();
    const m = new ProvenanceModule({ manifest }); // no private key
    k.register(new StorageModule());
    k.register(m);
    await k.boot();
    assert.equal(m.canSign(), false);
    const v = await m.verify();
    assert.equal(v.valid, true); // public verification still works
    await k.shutdown();
  });

  it('rejects a manifest with a tampered canonical identity', async () => {
    const { manifest } = provisionRoot();
    const tampered = { ...manifest, canonical_identity: 'JATA-QI|CREATOR|IMPOSTOR|ROOT|2026-07-29' };
    const v = (await import('../src/index.js')).verifyRootManifest(tampered);
    assert.equal(v.valid, false);
  });
});

// Reference the driver import to avoid an unused-warning in some toolchains.
void MemoryDriver;
