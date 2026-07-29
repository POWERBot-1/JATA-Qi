// Public API for @jataqi/provenance (JQ-CIP).
export { ProvenanceModule } from './provenance-module.js';
export type { ProvenanceConfig, ProvenanceEvent } from './provenance-module.js';
export { provisionRoot, verifyRootManifest } from './manifest.js';
export type { RootManifest } from './manifest.js';
export {
  SIGNATURE_ALG, HASH_ALG, canonicalJSON, fingerprint,
  generateKeyPair, signData, verifyData, publicKeyFromPrivate, toBase64, fromBase64,
} from './crypto.js';
export {
  CREATOR_NAME, CREATOR_ROLE, PROJECT, CANONICAL_IDENTITY, IDENTITY_ANCHOR_SHA256,
  CREATOR_ROOT_REFERENCE, CREATOR_ROOT_LABEL, MASTER_IDENTITY_STATEMENT,
} from './constants.js';
