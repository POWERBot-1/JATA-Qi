// The JATA Qi Root Manifest — a canonical, machine-readable, SIGNED record of
// the creator root identity. The committed manifest contains the public key and
// a real Ed25519 signature; the private key is never committed.

import {
  CANONICAL_IDENTITY, CREATOR_NAME, CREATOR_ROLE, IDENTITY_ANCHOR_SHA256,
  PROJECT, ROOT_CREATED, ROOT_IDENTITY_TYPE, ROOT_PROVENANCE,
} from './constants.js';
import { SIGNATURE_ALG, canonicalJSON, fingerprint, generateKeyPair, publicKeyFromPrivate, signData, toBase64, verifyData } from './crypto.js';

export interface RootManifest {
  project: string;
  creator: { display_name: string; role: string; identity_type: string };
  canonical_identity: string;
  identity_anchor_sha256: string;
  provenance: string;
  status: 'ROOT';
  created: string;
  signature_algorithm: string;
  public_key: string; // base64 SPKI DER
  /** Canonical JSON string of the identity fields that were signed. */
  signed_payload: string;
  root_signature: string; // base64
  manifest_fingerprint: string;
}

/** The identity fields that constitute the signed payload (no key/sig fields). */
function identityFields(publicKey: string) {
  return {
    project: PROJECT,
    creator: { display_name: CREATOR_NAME, role: CREATOR_ROLE, identity_type: ROOT_IDENTITY_TYPE },
    canonical_identity: CANONICAL_IDENTITY,
    identity_anchor_sha256: IDENTITY_ANCHOR_SHA256,
    provenance: ROOT_PROVENANCE,
    status: 'ROOT' as const,
    created: ROOT_CREATED,
    signature_algorithm: SIGNATURE_ALG,
    public_key: publicKey,
  };
}

export interface ProvisionedRoot {
  manifest: RootManifest;
  publicKeyDerB64: string;
  privateKeyDerB64: string; // MUST be stored securely; never committed
}

/** Generate a fresh key pair and build a signed root manifest. */
export function provisionRoot(): ProvisionedRoot {
  const kp = generateKeyPair();
  const publicKey = toBase64(kp.publicKeyDer);
  const privateKey = toBase64(kp.privateKeyDer);
  const signedPayload = canonicalJSON(identityFields(publicKey));
  const rootSignature = signData(signedPayload, privateKey);
  const manifest: RootManifest = {
    ...identityFields(publicKey),
    signed_payload: signedPayload,
    root_signature: rootSignature,
    manifest_fingerprint: fingerprint(signedPayload),
  };
  return { manifest, publicKeyDerB64: publicKey, privateKeyDerB64: privateKey };
}

/** Verify a manifest's self-signature and anchor integrity. */
export function verifyRootManifest(manifest: RootManifest): { valid: boolean; reason: string } {
  if (manifest.canonical_identity !== CANONICAL_IDENTITY) {
    return { valid: false, reason: 'canonical_identity mismatch' };
  }
  const expectedAnchor = fingerprint(CANONICAL_IDENTITY);
  if (manifest.identity_anchor_sha256 !== expectedAnchor) {
    return { valid: false, reason: 'identity_anchor mismatch' };
  }
  const recomputed = canonicalJSON(identityFields(manifest.public_key));
  if (recomputed !== manifest.signed_payload) {
    return { valid: false, reason: 'signed_payload does not match manifest fields' };
  }
  const ok = verifyData(manifest.signed_payload, manifest.root_signature, manifest.public_key);
  return ok ? { valid: true, reason: 'signature valid' } : { valid: false, reason: 'signature invalid' };
}
