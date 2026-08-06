// Post-quantum algorithm catalog — NIST standardization track metadata.
//
// Honest statuses: Kyber and Dilithium were standardized by NIST in 2024
// (FIPS 203 / FIPS 204); SPHINCS+ (FIPS 205) likewise. Providers pluggable.

import type { PqAlgorithm } from './types.js';

export const DEFAULT_PQ_ALGORITHMS: PqAlgorithm[] = [
  { id: 'classic', name: 'Classic (RSA/ECDSA/Ed25519)', family: 'classic', purpose: 'signature', status: 'classic', nistCategory: 0, keySizeBytes: 32, notes: 'pre-quantum baseline; migration target is hybrid → pq_only' },
  { id: 'kyber-512', name: 'ML-KEM-512', family: 'lattice', purpose: 'kem', status: 'nist_standardized', nistCategory: 1, keySizeBytes: 800, notes: 'FIPS 203 (2024)' },
  { id: 'kyber-768', name: 'ML-KEM-768', family: 'lattice', purpose: 'kem', status: 'nist_standardized', nistCategory: 3, keySizeBytes: 1184, notes: 'FIPS 203 (2024) — recommended default KEM' },
  { id: 'kyber-1024', name: 'ML-KEM-1024', family: 'lattice', purpose: 'kem', status: 'nist_standardized', nistCategory: 5, keySizeBytes: 1568, notes: 'FIPS 203 (2024)' },
  { id: 'dilithium2', name: 'ML-DSA-44', family: 'lattice', purpose: 'signature', status: 'nist_standardized', nistCategory: 2, keySizeBytes: 1312, notes: 'FIPS 204 (2024)' },
  { id: 'dilithium3', name: 'ML-DSA-65', family: 'lattice', purpose: 'signature', status: 'nist_standardized', nistCategory: 3, keySizeBytes: 1952, notes: 'FIPS 204 (2024) — recommended default signature scheme' },
  { id: 'dilithium5', name: 'ML-DSA-87', family: 'lattice', purpose: 'signature', status: 'nist_standardized', nistCategory: 5, keySizeBytes: 2592, notes: 'FIPS 204 (2024)' },
  { id: 'sphincs+-128s', name: 'SLH-DSA-SHA2-128s', family: 'hash-based', purpose: 'signature', status: 'nist_standardized', nistCategory: 1, keySizeBytes: 32, notes: 'FIPS 205 (2024) — conservative fallback' },
  { id: 'sphincs+-192s', name: 'SLH-DSA-SHA2-192s', family: 'hash-based', purpose: 'signature', status: 'nist_standardized', nistCategory: 3, keySizeBytes: 48, notes: 'FIPS 205 (2024)' },
  { id: 'sphincs+-256s', name: 'SLH-DSA-SHA2-256s', family: 'hash-based', purpose: 'signature', status: 'nist_standardized', nistCategory: 5, keySizeBytes: 64, notes: 'FIPS 205 (2024)' },
];
