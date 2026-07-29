// ProvenanceModule — JQ-CIP runtime. Loads and verifies the signed Creator Root
// manifest, maintains an append-only hash-chained provenance ledger, supports
// key rotation/revocation, fingerprinting, tamper detection, and answers
// identity questions from provenance records (never from an LLM).
//
// The creator identity fields are IMMUTABLE constants — there is no API to
// mutate them, so no agent can silently alter the Creator Root.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { INamespace } from '@jataqi/storage';
import {
  CANONICAL_IDENTITY, CREATOR_NAME, CREATOR_ROLE, CREATOR_ROOT_LABEL,
  CREATOR_ROOT_REFERENCE, IDENTITY_ANCHOR_SHA256, PROJECT, ROOT_CREATED,
  ROOT_IDENTITY_TYPE, ROOT_PROVENANCE,
} from './constants.js';
import { canonicalJSON, fingerprint, publicKeyFromPrivate, signData, verifyData } from './crypto.js';
import { provisionRoot, verifyRootManifest } from './manifest.js';
import type { RootManifest } from './manifest.js';

export interface ProvenanceConfig {
  manifestPath?: string;
  privateKeyPath?: string;
  /** Direct manifest injection (tests). */
  manifest?: RootManifest;
  /** Direct private key injection (tests). */
  privateKey?: string;
}

export interface ProvenanceEvent {
  id: string;
  seq: number;
  type: string;
  prevHash: string;
  hash: string;
  ts: number;
  detail: Record<string, unknown>;
  signature?: string;
  signerPublicKey?: string;
}

const NS_LEDGER = 'provenance.ledger';
const FIRST_HASH = '';

export class ProvenanceModule implements IModule {
  readonly id = 'provenance';
  readonly tags = ['core', 'governance', 'identity'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private ledger!: INamespace;
  private manifest!: RootManifest;
  private activePrivateKey?: string;
  private activePublicKey!: string;
  private keyStatus: 'ACTIVE' | 'REVOKED' | 'EPHEMERAL' = 'ACTIVE';
  private ephemeral = false;

  constructor(private readonly cfg: ProvenanceConfig = {}) {}

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as { namespace: (n: string) => Promise<INamespace> };
    this.ledger = await storage.namespace(NS_LEDGER);

    // Resolve the root manifest: injected -> disk -> ephemeral provision.
    if (this.cfg.manifest) {
      this.manifest = this.cfg.manifest;
      this.activePublicKey = this.manifest.public_key;
    } else {
      const path = this.cfg.manifestPath ?? 'provenance/root-manifest.json';
      if (existsSync(path)) {
        this.manifest = JSON.parse(readFileSync(path, 'utf8')) as RootManifest;
        this.activePublicKey = this.manifest.public_key;
      } else {
        // No committed manifest: provision an ephemeral root for this process.
        const prov = provisionRoot();
        this.manifest = prov.manifest;
        this.activePublicKey = prov.publicKeyDerB64;
        this.activePrivateKey = prov.privateKeyDerB64;
        this.keyStatus = 'EPHEMERAL';
        this.ephemeral = true;
      }
    }

    // Resolve the signing key (never required for verification).
    if (this.cfg.privateKey) {
      this.activePrivateKey = this.cfg.privateKey;
      this.keyStatus = 'ACTIVE';
    } else if (!this.ephemeral) {
      const keyPath = this.cfg.privateKeyPath ?? 'provenance/keys/creator.key';
      if (existsSync(keyPath)) {
        this.activePrivateKey = readFileSync(keyPath, 'utf8').trim();
        this.keyStatus = 'ACTIVE';
      } else {
        this.keyStatus = 'REVOKED'; // verify-only: no signing key present
      }
    }

    kernel.container.registerValue('provenance', this);
    kernel.logger.info(`provenance initialized (creator: ${CREATOR_NAME}, key: ${this.canSign() ? 'signing' : 'verify-only'}, manifest: ${this.ephemeral ? 'ephemeral' : 'committed'})`);

    if ((await this.ledger.size()) === 0) {
      await this.append('CREATOR_ROOT_CREATED', {
        creator: CREATOR_NAME,
        canonical_identity: CANONICAL_IDENTITY,
        identity_anchor_sha256: IDENTITY_ANCHOR_SHA256,
      });
    }
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  canSign(): boolean {
    return this.keyStatus !== 'REVOKED' && this.activePrivateKey !== undefined;
  }

  // --- public identity queries (never expose private material) ------------

  creator(): { display_name: string; role: string; identity_type: string } {
    return { display_name: CREATOR_NAME, role: CREATOR_ROLE, identity_type: ROOT_IDENTITY_TYPE };
  }

  root(): RootManifest {
    return this.manifest;
  }

  identity(): Record<string, unknown> {
    return {
      project: PROJECT,
      creator: this.creator(),
      canonical_identity: CANONICAL_IDENTITY,
      identity_anchor_sha256: IDENTITY_ANCHOR_SHA256,
      created: ROOT_CREATED,
      provenance: ROOT_PROVENANCE,
      signature_algorithm: this.manifest.signature_algorithm,
      public_key: this.activePublicKey,
      creator_root_reference: CREATOR_ROOT_REFERENCE,
      creator_root_label: CREATOR_ROOT_LABEL,
      key_status: this.keyStatus,
      manifest_fingerprint: this.manifest.manifest_fingerprint,
    };
  }

  fingerprint(value: unknown | string): string {
    return fingerprint(value);
  }

  /** Combined integrity verification: manifest signature + ledger chain. */
  async verify(): Promise<{ valid: boolean; manifest: { valid: boolean; reason: string }; ledger: { valid: boolean; checked: number }; reason: string }> {
    const mv = verifyRootManifest(this.manifest);
    const lv = await this.verifyLedger();
    const valid = mv.valid && lv.valid;
    return { valid, manifest: mv, ledger: lv, reason: valid ? 'verified' : (mv.valid ? 'ledger integrity failure' : mv.reason) };
  }

  // --- self-identity answers come from provenance, NOT an LLM --------------

  whoCreatedYou(): string {
    return CREATOR_NAME;
  }
  whatAreYou(): string {
    return PROJECT;
  }
  howDoYouKnow(): string {
    return 'Creator Root + Signed Provenance + Verified Fingerprint';
  }

  // --- provenance ledger (append-only, hash-chained, signed) --------------

  async append(type: string, detail: Record<string, unknown> = {}): Promise<ProvenanceEvent> {
    const events = await this.events();
    const seq = events.length + 1;
    const prevHash = events.length ? events[events.length - 1]!.hash : FIRST_HASH;
    const ts = Date.now();
    const hash = fingerprint({ seq, type, prevHash, ts, detail });
    const event: ProvenanceEvent = { id: randomUUID(), seq, type, prevHash, hash, ts, detail };
    if (this.canSign() && this.activePrivateKey) {
      event.signature = signData(hash, this.activePrivateKey);
      event.signerPublicKey = this.activePublicKey;
    }
    await this.ledger.set(event.id, event);
    return event;
  }

  /** Convenience provenance recorders for releases / modules / tools. */
  recordRelease(version: string, content?: unknown): Promise<ProvenanceEvent> {
    const fp = content !== undefined ? fingerprint(content) : undefined;
    return this.append('RELEASE_CREATED', { version, ...(fp ? { fingerprint: fp } : {}), creator_root_reference: CREATOR_ROOT_REFERENCE });
  }
  recordModule(name: string, parentFingerprint?: string): Promise<ProvenanceEvent> {
    return this.append('MODULE_REGISTERED', { name, ...(parentFingerprint ? { parent_fingerprint: parentFingerprint } : {}), creator_root_reference: CREATOR_ROOT_REFERENCE });
  }
  recordToolIntegration(tool: { id: string; provider: string; model?: string; version?: string }): Promise<ProvenanceEvent> {
    // Tools are INTEGRATED, not created by the creator — provenance distinguishes this.
    return this.append('TOOL_REGISTERED', { ...tool, integrated_by: PROJECT, original_creator: CREATOR_NAME, third_party_provider: tool.provider });
  }

  async events(limit = 1000): Promise<ProvenanceEvent[]> {
    const res = await this.ledger.list<ProvenanceEvent>({ limit: 10_000 });
    const items = res.items.map((e) => e.value).sort((a, b) => a.seq - b.seq);
    return items.slice(0, limit);
  }

  /** Recompute every hash, check the chain links, and verify signatures. */
  async verifyLedger(): Promise<{ valid: boolean; checked: number; brokenAt?: number }> {
    const events = await this.events();
    let prev = FIRST_HASH;
    for (const e of events) {
      if (e.prevHash !== prev) return { valid: false, checked: e.seq, brokenAt: e.seq };
      const recomputed = fingerprint({ seq: e.seq, type: e.type, prevHash: e.prevHash, ts: e.ts, detail: e.detail });
      if (recomputed !== e.hash) return { valid: false, checked: e.seq, brokenAt: e.seq };
      if (e.signature && e.signerPublicKey) {
        if (!verifyData(e.hash, e.signature, e.signerPublicKey)) return { valid: false, checked: e.seq, brokenAt: e.seq };
      }
      prev = e.hash;
    }
    return { valid: true, checked: events.length };
  }

  // --- key lifecycle (governed) -------------------------------------------

  /** Rotate the active signing key. Requires the current key to sign the rotation. */
  async rotateKey(newPrivateKeyDerB64: string): Promise<ProvenanceEvent> {
    if (!this.canSign() || !this.activePrivateKey) throw new Error('provenance: key rotation requires the active signing key');
    const oldPublicKey = this.activePublicKey;
    const newPublicKey = publicKeyFromPrivate(newPrivateKeyDerB64);
    const event = await this.append('KEY_ROTATED', { old_public_key: oldPublicKey, new_public_key: newPublicKey });
    this.activePrivateKey = newPrivateKeyDerB64;
    this.activePublicKey = newPublicKey;
    this.keyStatus = 'ACTIVE';
    return event;
  }

  /** Revoke the active key (verify-only afterwards; historical signatures remain verifiable). */
  async revokeKey(): Promise<ProvenanceEvent> {
    const event = await this.append('KEY_REVOKED', { public_key: this.activePublicKey });
    this.activePrivateKey = undefined;
    this.keyStatus = 'REVOKED';
    return event;
  }
}
