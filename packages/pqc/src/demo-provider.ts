// Demo PQ provider — honest reference implementation for the agility layer.
//
// This is NOT a real lattice implementation. It provides deterministic,
// algorithm-tagged key/signature primitives so the envelope, migration, and
// governance layers are fully testable end-to-end. Standardized PQ
// implementations (e.g. liboqs bindings, WebCrypto ML-KEM when available)
// plug in behind the same PqProvider interface.

import { createHash, randomBytes } from 'node:crypto';
import type { PqAlgorithmId } from './types.js';
import type { PqKeyPair, PqProvider } from './engine.js';

const ALG_TAG: Record<PqAlgorithmId, string> = {
  'classic': 'cls', 'kyber-512': 'k512', 'kyber-768': 'k768', 'kyber-1024': 'k1024',
  'dilithium2': 'd2', 'dilithium3': 'd3', 'dilithium5': 'd5',
  'sphincs+-128s': 's128', 'sphincs+-192s': 's192', 'sphincs+-256s': 's256',
  'custom': 'cst',
};

function tagOf(algorithm: PqAlgorithmId): string {
  return ALG_TAG[algorithm] ?? 'cst';
}

/**
 * Deterministic keypair per (algorithm, seed): same seed → same keys, so
 * tests and migrations are reproducible. Signatures are HMAC-style digests
 * keyed by the private key — sufficient to exercise the envelope/verification
 * logic end-to-end.
 */
export class DemoPqProvider implements PqProvider {
  readonly algorithm: PqAlgorithmId;

  constructor(algorithm: PqAlgorithmId) {
    this.algorithm = algorithm;
  }

  generateKeyPair(): PqKeyPair {
    const seed = randomBytes(32).toString('base64');
    return this.deriveKeyPair(this.algorithm, seed);
  }

  /**
   * Deterministic derivation (used by the reference demo and tests).
   * DEMO BINDING: the verification key equals the derived signing key — this
   * is intentionally NOT a real public-key scheme; it only exercises the
   * agility/envelope layer. Standardized providers replace this interface.
   */
  deriveKeyPair(algorithm: PqAlgorithmId, seed: string): PqKeyPair {
    const tag = tagOf(algorithm);
    const key = createHash('sha256').update(`${tag}:key:${seed}`).digest('base64');
    return { publicKey: key, privateKey: key };
  }

  sign(payload: string, privateKey: string): string {
    return createHash('sha256').update(`${tagOf(this.algorithm)}:sig:${privateKey}:${payload}`).digest('base64');
  }

  verify(payload: string, signature: string, publicKey: string): boolean {
    const expected = createHash('sha256').update(`${tagOf(this.algorithm)}:sig:${publicKey}:${payload}`).digest('base64');
    return signature === expected;
  }
}
