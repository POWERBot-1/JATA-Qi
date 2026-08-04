// Registry data escrow — ICANN/RFC-8909-style data-escrow deposits. Produces a
// signed, point-in-time snapshot of the registry (the authoritative source a
// escrow agent or successor operator needs to reconstruct the TLD). Each
// deposit is Ed25519-signed by the registry governance key.

import { fingerprint, signData, verifyData, canonicalJSON } from '@jataqi/provenance';
import type { Registry } from './registry.js';
import type { EscrowDeposit } from './types.js';

export interface EscrowSigner {
  privateKeyDerB64: string;
  publicKeyDerB64: string;
}

/**
 * Build a signed escrow deposit from a registry snapshot. Deposit contents are
 * the canonical JSON of the snapshot; the signature covers the SHA-256
 * contentsHash so the deposit is tamper-evident and independently verifiable.
 */
export function buildDeposit(registry: Registry, seq: number, signer: EscrowSigner, now = Date.now()): EscrowDeposit {
  const snap = registry.snapshot();
  const contents = canonicalJSON(snap);
  const contentsHash = fingerprint(contents);
  const signature = signData(contentsHash, signer.privateKeyDerB64);
  return {
    id: seq,
    watermark: new Date(now).toISOString(),
    tld: registry.tld,
    registrarCount: snap.registrars.length,
    domainCount: snap.domains.length,
    hostCount: snap.hosts.length,
    contactCount: snap.contacts.length,
    contents,
    contentsHash,
    signature,
    signedBy: signer.publicKeyDerB64,
    createdAt: now,
  };
}

/** Verify a deposit's signature + contents hash. */
export function verifyDeposit(deposit: EscrowDeposit): boolean {
  const recomputed = fingerprint(deposit.contents);
  if (recomputed !== deposit.contentsHash) return false;
  return verifyData(deposit.contentsHash, deposit.signature, deposit.signedBy);
}

export { canonicalJSON };
